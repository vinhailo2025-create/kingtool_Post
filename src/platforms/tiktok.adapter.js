const fs = require('fs');
const path = require('path');

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video';
const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content?from=webapp';
const VIDEO_PATTERN = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i;
const RESTRICTED_MESSAGES = [
  'Nội dung có thể sẽ bị hạn chế',
  'Content may be restricted',
];

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getConfig(options = {}) {
  return {
    navigationTimeout: Number(options.navigationTimeout) || 90000,
    editorTimeout: Number(options.editorTimeout) || 120000,
    uploadTimeout: Number(options.uploadTimeout) || 600000,
    productTimeout: Number(options.productTimeout) || 45000,
    publishTimeout: Number(options.publishTimeout) || 90000,
    linkTimeout: Number(options.linkTimeout) || 120000,
    settleMs: Number.isFinite(Number(options.settleMs)) ? Number(options.settleMs) : 1200,
  };
}

async function delay(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

async function assertNotRestricted(page) {
  const text = normalizeText(await bodyText(page));
  const restricted = RESTRICTED_MESSAGES.some(message => text.includes(normalizeText(message)));
  if (restricted) {
    throw codedError(
      'TIKTOK_CONTENT_RESTRICTED',
      'Đăng TikTok thất bại: kiểm tra nội dung nhanh báo “Nội dung có thể sẽ bị hạn chế”.'
    );
  }
}

async function contentCheckState(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const all = Array.from(document.querySelectorAll('body *')).filter(visible);
    const headings = all.filter(element => {
      const text = norm(element.innerText || element.textContent || '');
      return text.includes('kiem tra noi dung nhanh') || text.includes('quick content check');
    }).sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const heading = headings[0];
    if (!heading) return 'missing';

    const headingRect = heading.getBoundingClientRect();
    const statuses = all.map(element => ({
      element,
      text: norm(element.innerText || element.textContent || ''),
      rect: element.getBoundingClientRect(),
    })).filter(item => {
      if (item.text.includes('kiem tra noi dung nhanh') || item.text.includes('quick content check')) return false;
      const isSafe = item.text.includes('khong phat hien van de nao') || item.text.includes('no issues detected');
      const isRestricted = item.text.includes('noi dung co the se bi han che') || item.text.includes('content may be restricted');
      if (!isSafe && !isRestricted) return false;
      const verticalDistance = item.rect.top - headingRect.bottom;
      return verticalDistance >= -20 && verticalDistance <= 180;
    }).sort((a, b) => {
      const distanceA = Math.abs(a.rect.top - headingRect.bottom);
      const distanceB = Math.abs(b.rect.top - headingRect.bottom);
      return distanceA - distanceB || a.text.length - b.text.length;
    });

    if (!statuses.length) return 'pending';
    const status = statuses[0].text;
    if (status.includes('noi dung co the se bi han che') || status.includes('content may be restricted')) {
      return 'restricted';
    }
    return 'safe';
  }).catch(() => 'missing');
}

async function clickVisibleText(page, labels, { exact = false, scopeDialog = false } = {}) {
  const wanted = labels.map(normalizeText);
  return page.evaluate(({ wanted, exact, scopeDialog }) => {
    const norm = value => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const visible = element => {
      if (!element || !(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = scopeDialog && dialogs.length ? dialogs[dialogs.length - 1] : document;
    const selector = 'button, [role="button"], a, label, [tabindex]:not([tabindex="-1"])';
    const candidates = Array.from(root.querySelectorAll(selector)).filter(visible);
    const match = candidates
      .map(element => ({
        element,
        text: norm(element.innerText || element.textContent || element.getAttribute('aria-label') || ''),
      }))
      .filter(item => wanted.some(value => exact ? item.text === value : item.text.includes(value)))
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (!match) return false;
    match.element.scrollIntoView({ block: 'center', inline: 'center' });
    match.element.click();
    return true;
  }, { wanted, exact, scopeDialog }).catch(() => false);
}

async function findCaptionEditor(page) {
  const handle = await page.evaluateHandle(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 30 && rect.height > 15 && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const selectors = [
      '[data-e2e="video-caption"] [contenteditable="true"]',
      '[data-e2e="caption-editor"] [contenteditable="true"]',
      '[data-lexical-editor="true"][contenteditable="true"]',
      '.public-DraftEditor-content[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="description" i]',
      'textarea[placeholder*="caption" i]',
      'textarea',
      '[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (candidates.length) return candidates[0];
    }
    return null;
  });
  return handle && handle.asElement ? handle.asElement() : null;
}

async function replaceEditorText(page, editor, content) {
  await editor.click({ clickCount: 3 }).catch(() => editor.click());
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  if (content) await page.keyboard.sendCharacter(content);

  const correct = await page.evaluate((element, expected) => {
    const value = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value
      : element.innerText;
    return String(value || '').replace(/\r\n/g, '\n') === String(expected || '').replace(/\r\n/g, '\n');
  }, editor, content).catch(() => false);
  if (correct) return;

  await page.evaluate((element, value) => {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) element.textContent = value;
      selection.removeAllRanges();
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, editor, content);
}

async function findProductSearchInput(page) {
  const handle = await page.evaluateHandle(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 30 && rect.height > 15 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const inputs = Array.from(root.querySelectorAll('input:not([type="file"]):not([type="hidden"])')).filter(visible);
    return inputs.find(input => /search|product|san pham|tim kiem/i.test(
      `${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    )) || inputs[0] || null;
  });
  return handle && handle.asElement ? handle.asElement() : null;
}

async function attachProduct(page, productId, config) {
  let clicked = await clickVisibleText(page, ['Thêm liên kết', 'Add link'], { exact: false });
  if (!clicked) {
    throw codedError('TIKTOK_ADD_LINK_NOT_FOUND', 'Không tìm thấy mục “Thêm liên kết” trên trang đăng TikTok.');
  }
  await delay(config.settleMs);

  let input = await findProductSearchInput(page);
  if (!input) {
    clicked = await clickVisibleText(page, ['Sản phẩm', 'Product'], { exact: false, scopeDialog: true });
    if (!clicked) clicked = await clickVisibleText(page, ['Sản phẩm', 'Product'], { exact: false });
    if (!clicked) {
      throw codedError('TIKTOK_PRODUCT_OPTION_NOT_FOUND', 'Không tìm thấy lựa chọn “Sản phẩm” trong mục Thêm liên kết.');
    }
    await delay(config.settleMs);
  }

  const started = Date.now();
  while (!input && Date.now() - started < config.productTimeout) {
    await delay(250);
    input = await findProductSearchInput(page);
  }
  if (!input) {
    throw codedError('TIKTOK_PRODUCT_SEARCH_NOT_FOUND', 'Không mở được hộp tìm kiếm sản phẩm TikTok.');
  }

  await input.click({ clickCount: 3 });
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.sendCharacter(productId);
  await delay(Math.max(config.settleMs, 600));

  const selected = await page.evaluate(productIdValue => {
    const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const needle = norm(productIdValue);
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const candidates = Array.from(root.querySelectorAll('tr, li, [role="row"], [role="option"], [data-e2e*="product"], div'))
      .filter(element => visible(element) && norm(element.innerText || '').includes(needle))
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const row = candidates[0];
    if (!row) return false;
    const buttons = Array.from(row.querySelectorAll('button, [role="button"]')).filter(visible);
    const action = buttons.find(button => /^(add|them|select|chon)$/i.test(
      norm(button.innerText || button.getAttribute('aria-label') || '')
    ));
    (action || row).click();
    return true;
  }, productId).catch(() => false);

  if (!selected) {
    throw codedError('TIKTOK_PRODUCT_NOT_FOUND', `Không tìm thấy sản phẩm có ID “${productId}”.`);
  }
  await delay(config.settleMs);

  // Some Studio versions add immediately; others require a final button.
  await page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    if (!dialogs.length) return false;
    const labels = new Set(['add product', 'them san pham', 'confirm', 'xac nhan', 'add', 'them']);
    const button = Array.from(dialogs[dialogs.length - 1].querySelectorAll('button, [role="button"]'))
      .find(element => visible(element) && labels.has(norm(element.innerText || element.getAttribute('aria-label') || '')));
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  await delay(config.settleMs);
}

async function publishButtonState(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const button = buttons.find(element => {
      const text = norm(element.innerText || element.getAttribute('aria-label') || '');
      return ['dang', 'post', 'publish'].includes(text);
    });
    if (!button) return { found: false, enabled: false };
    const enabled = !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      && !button.matches('[disabled]');
    return { found: true, enabled };
  }).catch(() => ({ found: false, enabled: false }));
}

async function waitUntilReadyToPublish(page, config) {
  const started = Date.now();
  while (Date.now() - started < config.uploadTimeout) {
    await assertNotRestricted(page);
    const checkState = await contentCheckState(page);
    if (checkState === 'restricted') {
      throw codedError(
        'TIKTOK_CONTENT_RESTRICTED',
        'Đăng TikTok thất bại: kiểm tra nội dung nhanh báo “Nội dung có thể sẽ bị hạn chế”.'
      );
    }
    const state = await publishButtonState(page);
    // TikTok may enable the Post button before the asynchronous quick check
    // finishes. Never click it until the green safe result is present.
    if (checkState === 'safe' && state.found && state.enabled) return;
    await delay(500);
  }
  throw codedError(
    'TIKTOK_CONTENT_CHECK_TIMEOUT',
    'Chưa xuất hiện kết quả xanh “Không phát hiện vấn đề nào” ở mục Kiểm tra nội dung nhanh; không bấm Đăng.'
  );
}

async function clickPublish(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const button = Array.from(document.querySelectorAll('button, [role="button"]')).find(element => {
      if (!visible(element)) return false;
      const text = norm(element.innerText || element.getAttribute('aria-label') || '');
      return ['dang', 'post', 'publish'].includes(text);
    });
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    button.click();
    return true;
  }).catch(() => false);
}

async function waitForPublishSuccess(page, previousUrl, config) {
  const successMessages = [
    'Video đã được tải lên', 'Video đã được đăng', 'Đã đăng video',
    'Your video has been uploaded', 'Video uploaded', 'Video published',
    'Upload another video', 'Tải video khác', 'Manage your posts', 'Quản lý bài đăng',
  ].map(normalizeText);
  const started = Date.now();
  while (Date.now() - started < config.publishTimeout) {
    await assertNotRestricted(page);
    const state = await page.evaluate(() => ({
      url: location.href,
      text: document.body?.innerText || '',
      explicit: !!document.querySelector('[data-e2e="upload-success"], [data-e2e="post-success"]'),
    })).catch(() => ({ url: '', text: '', explicit: false }));
    const currentText = normalizeText(state.text);
    const leftUploadPage = state.url && state.url !== previousUrl && !/\/tiktokstudio\/upload/i.test(state.url);
    if (state.explicit || leftUploadPage || successMessages.some(message => currentText.includes(message))) return true;
    await delay(500);
  }
  throw codedError(
    'TIKTOK_PUBLISH_NOT_CONFIRMED',
    'Đã bấm Đăng nhưng TikTok chưa xác nhận đăng video thành công.'
  );
}

async function readStudioVideoLinks(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/video/"]')).map(anchor => {
    const match = String(anchor.href || '').match(/https?:\/\/(?:www\.)?tiktok\.com\/@[^/?#]+\/video\/\d+/i);
    if (!match) return null;
    return {
      url: match[0],
      caption: (anchor.innerText || anchor.textContent || anchor.parentElement?.innerText || '')
        .replace(/\s+/g, ' ').trim(),
    };
  }).filter(Boolean).filter((item, index, all) =>
    all.findIndex(other => other.url === item.url) === index
  )).catch(() => []);
}

async function snapshotStudioVideoLinks(page, config) {
  await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
  const started = Date.now();
  let links = [];
  while (Date.now() - started < Math.min(config.linkTimeout, 30000)) {
    links = await readStudioVideoLinks(page);
    const loaded = await page.evaluate(() => {
      const text = String(document.body?.innerText || '').toLowerCase();
      return /tiktokstudio\/content/i.test(location.href)
        && (document.querySelector('a[href*="/video/"]') || /bai dang|posts|noi dung|content/.test(
          text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        ));
    }).catch(() => false);
    if (loaded) return { loaded: true, links };
    await delay(500);
  }
  return { loaded: false, links };
}

async function captureJustPublishedLink(page, beforeSnapshot, content, config) {
  const before = new Set((beforeSnapshot?.links || []).map(item => item.url));
  const needle = normalizeText(content).slice(0, 100);
  const started = Date.now();
  let lastNewLinks = [];

  while (Date.now() - started < config.linkTimeout) {
    if (!/\/tiktokstudio\/content/i.test(page.url())) {
      await page.goto(CONTENT_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    }
    await delay(1200);
    const links = await readStudioVideoLinks(page);
    const newLinks = links.filter(item => !before.has(item.url));
    lastNewLinks = newLinks;
    if (newLinks.length === 1) return newLinks[0].url;
    if (newLinks.length > 1) {
      const matching = needle
        ? newLinks.filter(item => normalizeText(item.caption).includes(needle)
          || needle.includes(normalizeText(item.caption).slice(0, 100)))
        : newLinks;
      if (matching.length === 1) return matching[0].url;
      // Studio is sorted newest first. This profile's action queue guarantees
      // only one Covergem post at a time, so the first matching new item is it.
      if (matching.length > 1) return matching[0].url;
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeout }).catch(() => {});
  }

  const error = codedError(
    'TIKTOK_POST_LINK_NOT_FOUND',
    `TikTok đã đăng video nhưng chưa xác định được permalink mới (phát hiện ${lastNewLinks.length} link mới).`
  );
  error.submitted = true;
  throw error;
}

const TikTokAdapter = {
  async publish(page, post, options = {}) {
    if (!page) throw codedError('TIKTOK_PAGE_MISSING', 'Không có tab trình duyệt TikTok.');

    const config = getConfig(options);
    const map = options.buildVarMap ? options.buildVarMap(post) : {
      ...post,
      media: post?.media ?? post?.image_path ?? '',
    };
    const render = options.renderTemplate || ((template, values) => String(template || '').replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, key) => values[key] == null ? '' : String(values[key])
    ));
    const content = render('{{content}}', map);
    const mediaRaw = render('{{media}}', map).trim();
    const productId = String(map.product_id || '').trim();

    if (!mediaRaw) throw codedError('TIKTOK_MEDIA_REQUIRED', 'Cột media chưa có video để đăng TikTok.');
    const mediaPaths = mediaRaw.split(',').map(value => path.resolve(value.trim())).filter(Boolean);
    if (mediaPaths.length !== 1) {
      throw codedError('TIKTOK_SINGLE_VIDEO_REQUIRED', 'TikTok chỉ hỗ trợ 1 video trong mỗi dòng dữ liệu.');
    }
    const mediaPath = mediaPaths[0];
    if (!VIDEO_PATTERN.test(mediaPath)) {
      throw codedError('TIKTOK_INVALID_VIDEO', `Media không phải định dạng video được hỗ trợ: ${mediaPath}`);
    }
    if (!fs.existsSync(mediaPath)) {
      throw codedError('TIKTOK_MEDIA_NOT_FOUND', `Không tìm thấy video: ${mediaPath}`);
    }

    if (!await this.validateSession(page)) {
      throw codedError('TIKTOK_SESSION_INVALID', 'Profile TikTok chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.');
    }

    // Record every existing video ID before uploading. Captions are not unique,
    // so the exact permalink is identified by the new ID after publication.
    const beforeLinks = await snapshotStudioVideoLinks(page, config);
    if (!beforeLinks.loaded) {
      throw codedError('TIKTOK_CONTENT_LIST_NOT_READY', 'Không đọc được danh sách video TikTok trước khi đăng.');
    }

    await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    const currentUrl = page.url();
    if (/\/login(?:\?|\/|$)/i.test(currentUrl)) {
      throw codedError('TIKTOK_SESSION_INVALID', 'TikTok chuyển về trang đăng nhập; hãy đăng nhập lại profile.');
    }

    const input = await page.waitForSelector('input[type="file"]', { timeout: config.editorTimeout });
    if (!input) throw codedError('TIKTOK_UPLOAD_INPUT_NOT_FOUND', 'Không tìm thấy nút Chọn video của TikTok Studio.');
    await input.uploadFile(mediaPath);

    let editor = null;
    const editorStarted = Date.now();
    while (!editor && Date.now() - editorStarted < config.editorTimeout) {
      await assertNotRestricted(page);
      editor = await findCaptionEditor(page);
      if (!editor) await delay(300);
    }
    if (!editor) throw codedError('TIKTOK_CAPTION_NOT_FOUND', 'Video đã chọn nhưng không tìm thấy ô mô tả.');
    await replaceEditorText(page, editor, content);
    await delay(config.settleMs);

    if (productId) await attachProduct(page, productId, config);
    await waitUntilReadyToPublish(page, config);
    await assertNotRestricted(page);

    const beforePublishUrl = page.url();
    if (!await clickPublish(page)) {
      throw codedError('TIKTOK_PUBLISH_BUTTON_NOT_FOUND', 'Không tìm thấy hoặc chưa thể bấm nút Đăng TikTok.');
    }
    await waitForPublishSuccess(page, beforePublishUrl, config);

    const publishedAtMs = Date.now();
    const postLink = await captureJustPublishedLink(page, beforeLinks, content, config);
    return {
      success: true,
      postedAt: new Date(publishedAtMs).toLocaleString('vi-VN'),
      publishedAtMs,
      postLink,
    };
  },

  async comment() {
    throw codedError('TIKTOK_COMMENT_NOT_CONFIGURED', 'Script TikTok bình luận chưa được cấu hình.');
  },

  async hasExistingComment() {
    return false;
  },

  async validateSession(page) {
    const cookies = await page.cookies('https://www.tiktok.com').catch(() => []);
    return cookies.some(cookie =>
      ['sessionid', 'sessionid_ss', 'sid_tt'].includes(cookie.name) && cookie.value
    );
  },

  _private: {
    assertNotRestricted,
    contentCheckState,
    readStudioVideoLinks,
    captureJustPublishedLink,
    normalizeText,
    publishButtonState,
  },
};

module.exports = TikTokAdapter;
