const fs = require('fs');
const path = require('path');

const HOME_URL = 'https://www.threads.com/?hl=vi';
const MEDIA_PATTERN = /\.(?:jpe?g|png|webp|gif|bmp|heic|mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i;

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

function normalizeThreadsUrl(value) {
  try {
    const url = new URL(value, 'https://www.threads.com');
    if (!/(?:^|\.)threads\.com$/i.test(url.hostname)) return '';
    const match = decodeURIComponent(url.pathname).match(/^\/(\@[^/?#]+)\/post\/([^/?#]+)/i);
    if (!match) return '';
    return `https://www.threads.com/${match[1]}/post/${match[2]}`;
  } catch (_) {
    return '';
  }
}

function getConfig(options = {}) {
  return {
    navigationTimeout: Number(options.navigationTimeout) || 90000,
    composerTimeout: Number(options.composerTimeout) || 60000,
    uploadTimeout: Number(options.uploadTimeout) || 300000,
    publishTimeout: Number(options.publishTimeout) || 300000,
    linkTimeout: Number(options.linkTimeout) || 120000,
    settleMs: Number.isFinite(Number(options.settleMs)) ? Number(options.settleMs) : 1000,
  };
}

async function delay(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

async function findProfileHref(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const candidates = Array.from(document.querySelectorAll('a[href]')).map((anchor, index) => {
      let url;
      try { url = new URL(anchor.href, location.href); } catch (_) { return null; }
      const match = decodeURIComponent(url.pathname).match(/^\/(\@[^/?#]+)\/?$/i);
      if (!match || !/(?:^|\.)threads\.com$/i.test(url.hostname)) return null;
      const label = norm([
        anchor.getAttribute('aria-label'), anchor.title, anchor.innerText,
        anchor.querySelector('img')?.alt,
      ].filter(Boolean).join(' '));
      let score = 0;
      if (visible(anchor)) score += 5;
      if (/trang ca nhan|profile/.test(label)) score += 100;
      if (anchor.closest('nav, header, [role="navigation"]')) score += 30;
      if (anchor.querySelector('img')) score += 10;
      score -= index / 10000;
      return { href: `https://www.threads.com/${match[1]}`, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return candidates[0]?.href || '';
  }).catch(() => '');
}

async function waitForProfileHref(page, timeout) {
  const started = Date.now();
  let href = '';
  while (!href && Date.now() - started < timeout) {
    href = await findProfileHref(page);
    if (!href) await delay(300);
  }
  return href;
}

async function readPostLinks(page) {
  const rows = await page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('a[href*="/post/"]')).filter(visible).map(anchor => ({
      href: anchor.href || '',
      text: (anchor.closest('[data-virtualized="false"], [role="article"], article')?.innerText
        || anchor.parentElement?.parentElement?.innerText
        || anchor.parentElement?.innerText
        || anchor.innerText || '').replace(/\s+/g, ' ').trim(),
    }));
  }).catch(() => []);

  const unique = new Map();
  for (const row of rows) {
    const url = normalizeThreadsUrl(row.href);
    if (url && !unique.has(url)) unique.set(url, { url, text: row.text || '' });
  }
  return [...unique.values()];
}

async function snapshotProfile(page, profileUrl, config) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
  if (/\/login(?:\/|\?|$)/i.test(page.url())) {
    throw codedError('THREADS_SESSION_INVALID', 'Threads chuyển về trang đăng nhập; hãy đăng nhập lại profile.');
  }
  const started = Date.now();
  let links = [];
  let previousFingerprint = '';
  let stableReads = 0;
  while (Date.now() - started < Math.min(config.composerTimeout, 30000)) {
    links = await readPostLinks(page);
    const state = await page.evaluate(() => {
      const text = String(document.body?.innerText || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
      return {
        onProfile: /^\/\@[^/]+\/?$/i.test(decodeURIComponent(location.pathname)),
        shellReady: /co gi moi|what.s new|threads|nguoi theo doi|followers/.test(text),
        explicitlyEmpty: /chua co thread|no threads yet|chua co bai viet|no posts yet/.test(text),
      };
    }).catch(() => ({ onProfile: false, shellReady: false, explicitlyEmpty: false }));
    const fingerprint = links.map(item => item.url).join('|');
    stableReads = fingerprint && fingerprint === previousFingerprint ? stableReads + 1 : 0;
    previousFingerprint = fingerprint;
    if (state.onProfile && state.shellReady && (state.explicitlyEmpty || (links.length > 0 && stableReads >= 1))) {
      return links;
    }
    await delay(350);
  }
  throw codedError('THREADS_PROFILE_NOT_READY', 'Đã mở profile Threads nhưng trang chưa tải xong.');
}

async function clickComposer(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const wanted = ['co gi moi', "what's new", 'what’s new', 'start a thread', 'new thread'];
    const selectors = 'button, [role="button"], [tabindex]:not([tabindex="-1"])';
    const match = Array.from(document.querySelectorAll(selectors)).filter(visible).map(element => ({
      element,
      text: norm(element.innerText || element.textContent || element.getAttribute('aria-label') || ''),
    })).filter(item => wanted.some(value => item.text === value || item.text.includes(value)))
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (!match) return false;
    match.element.scrollIntoView({ block: 'center', inline: 'center' });
    match.element.click();
    return true;
  }).catch(() => false);
}

async function findComposerEditor(page) {
  const handle = await page.evaluateHandle(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 30 && rect.height > 15 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const selectors = [
      '[contenteditable="true"][role="textbox"]',
      '[data-lexical-editor="true"][contenteditable="true"]',
      'textarea[placeholder]',
      'textarea',
      '[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const editors = Array.from(root.querySelectorAll(selector)).filter(visible);
      if (editors.length) return editors[0];
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
    const current = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
      ? element.value : element.innerText;
    const clean = value => String(value || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n/g, '\n')
      .trim();
    return clean(current) === clean(expected);
  }, editor, content).catch(() => false);
  if (correct) return;

  await page.evaluate(element => {
    element.focus();
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(element, '');
      else element.value = '';
    } else {
      element.textContent = '';
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, editor);
  await editor.click();
  if (content) await page.keyboard.sendCharacter(content);
}

async function composerRootHandle(page) {
  const handle = await page.evaluateHandle(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    return dialogs[dialogs.length - 1] || document.body;
  });
  return handle && handle.asElement ? handle.asElement() : null;
}

async function uploadMedia(page, mediaPaths, config) {
  let root = await composerRootHandle(page);
  let input = root ? await root.$('input[type="file"]') : null;
  if (!input) {
    await page.evaluate(() => {
      const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
      const scope = dialogs[dialogs.length - 1] || document;
      const button = Array.from(scope.querySelectorAll('button, [role="button"], label')).find(element => {
        if (!visible(element)) return false;
        const label = norm([element.innerText, element.getAttribute('aria-label'), element.title].filter(Boolean).join(' '));
        return /dinh kem|them anh|them video|anh\/video|attach|add media|photo|video/.test(label);
      });
      if (button) button.click();
    }).catch(() => {});
    await delay(config.settleMs);
    root = await composerRootHandle(page);
    input = root ? await root.$('input[type="file"]') : null;
  }
  if (!input) throw codedError('THREADS_UPLOAD_INPUT_NOT_FOUND', 'Không tìm thấy nút tải ảnh/video trong popup Threads.');
  await input.uploadFile(...mediaPaths);

  const started = Date.now();
  while (Date.now() - started < config.uploadTimeout) {
    const state = await page.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
      const root = dialogs[dialogs.length - 1] || document;
      const hasPreview = Array.from(root.querySelectorAll('img, video')).some(element => {
        const source = element.currentSrc || element.src || '';
        return visible(element) && source && !/avatar|profile/i.test(source);
      });
      const text = String(root.innerText || '').toLowerCase();
      const busy = /uploading|dang tai|dang xu ly|processing/.test(text);
      return { hasPreview, busy };
    }).catch(() => ({ hasPreview: false, busy: true }));
    if (state.hasPreview && !state.busy) return;
    await delay(500);
  }
  throw codedError('THREADS_UPLOAD_TIMEOUT', 'Threads chưa tải xong ảnh/video trong thời gian cho phép.');
}

async function publishButtonState(page) {
  return page.evaluate(() => {
    const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs[dialogs.length - 1] || document;
    const candidates = Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible).map(element => ({
      element,
      text: norm(element.innerText || element.textContent || element.getAttribute('aria-label') || ''),
    })).filter(item => ['dang', 'post', 'publish'].includes(item.text));
    const item = candidates[candidates.length - 1];
    if (!item) return { found: false, enabled: false };
    return {
      found: true,
      enabled: !item.element.disabled && item.element.getAttribute('aria-disabled') !== 'true'
        && !item.element.matches('[disabled]'),
    };
  }).catch(() => ({ found: false, enabled: false }));
}

async function waitUntilReady(page, config) {
  const started = Date.now();
  while (Date.now() - started < config.uploadTimeout) {
    const state = await publishButtonState(page);
    if (state.found && state.enabled) return;
    await delay(350);
  }
  throw codedError('THREADS_PUBLISH_NOT_READY', 'Nút Đăng Threads chưa sẵn sàng sau khi điền dữ liệu.');
}

async function clickPublish(page) {
  const handle = await page.evaluateHandle(() => {
    const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
    const root = dialogs[dialogs.length - 1] || document;
    const buttons = Array.from(root.querySelectorAll('button, [role="button"]')).filter(visible).filter(element => {
      const text = norm(element.innerText || element.textContent || element.getAttribute('aria-label') || '');
      return ['dang', 'post', 'publish'].includes(text);
    });
    const button = buttons[buttons.length - 1];
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
    return button;
  }).catch(() => null);
  const button = handle && handle.asElement ? handle.asElement() : null;
  if (!button) return false;
  await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
  await button.click().catch(() => null);
  return true;
}

async function waitForPublishConfirmation(page, config) {
  const started = Date.now();
  let sawDialog = true;
  while (Date.now() - started < config.publishTimeout) {
    const state = await page.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
      const text = String(document.body?.innerText || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
      return {
        hasDialog: dialogs.length > 0,
        explicit: /da dang|thread cua ban da duoc dang|your thread was posted|thread posted/.test(text),
        busy: /dang dang|posting\.\.\.|posting|dang xu ly|processing/.test(text),
        failed: /khong the dang|dang that bai|couldn.t post|failed to post|try again/.test(text),
        login: /\/login(?:\/|\?|$)/i.test(location.pathname),
      };
    }).catch(() => ({ hasDialog: true, explicit: false, busy: true, failed: false, login: false }));
    sawDialog = sawDialog || state.hasDialog;
    if (state.login) throw codedError('THREADS_SESSION_INVALID', 'Threads yêu cầu đăng nhập lại khi bấm Đăng.');
    if (state.failed) throw codedError('THREADS_PUBLISH_REJECTED', 'Threads báo không thể đăng bài; hãy kiểm tra lại nội dung/media.');
    // The composer may disappear while an image/video is still being sent.
    // Refreshing during “Posting...” triggers Chrome's beforeunload prompt and
    // can make permalink detection race the server-side publication.
    if (!state.busy && (state.explicit || (sawDialog && !state.hasDialog))) return;
    await delay(350);
  }
  throw codedError('THREADS_PUBLISH_NOT_CONFIRMED', 'Đã bấm Đăng nhưng Threads chưa xác nhận đăng bài thành công.');
}

async function captureJustPublishedLink(page, profileUrl, beforeLinks, content, config) {
  const before = new Set((beforeLinks || []).map(item => item.url));
  const needle = normalizeText(content).slice(0, 100);
  const started = Date.now();
  let lastNew = [];

  while (Date.now() - started < config.linkTimeout) {
    if (page.url().split('?')[0].replace(/\/$/, '') !== profileUrl.replace(/\/$/, '')) {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    }
    await delay(Math.max(config.settleMs, 800));
    const links = await readPostLinks(page);
    const fresh = links.filter(item => !before.has(item.url));
    lastNew = fresh;
    if (needle) {
      const matching = fresh.filter(item => {
        const text = normalizeText(item.text);
        return text.includes(needle) || needle.includes(text.slice(0, 100));
      });
      if (matching.length) return matching[0].url;
    } else if (fresh.length === 1) {
      return fresh[0].url;
    } else if (fresh.length > 1) {
      // With a media-only post there is no caption to disambiguate. The
      // profile action queue guarantees one Covergem post at a time and the
      // profile feed is newest first.
      return fresh[0].url;
    }
    await page.reload({ waitUntil: 'domcontentloaded', timeout: config.navigationTimeout }).catch(() => {});
  }

  const error = codedError(
    'THREADS_POST_LINK_NOT_FOUND',
    `Threads đã nhận lệnh đăng nhưng chưa xác định được permalink mới (phát hiện ${lastNew.length} link mới).`
  );
  error.submitted = true;
  throw error;
}

const ThreadsAdapter = {
  async publish(page, post, options = {}) {
    if (!page) throw codedError('THREADS_PAGE_MISSING', 'Không có tab trình duyệt Threads.');
    const config = getConfig(options);
    const map = options.buildVarMap ? options.buildVarMap(post) : {
      ...post,
      media: post?.media ?? post?.image_path ?? '',
    };
    const render = options.renderTemplate || ((template, values) => String(template || '').replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, key) => values[key] == null ? '' : String(values[key])
    ));
    const content = render('{{content}}', map).trim();
    const mediaRaw = render('{{media}}', map).trim();
    if (!content && !mediaRaw) {
      throw codedError('THREADS_DATA_REQUIRED', 'Dòng Threads cần có Nội dung hoặc Media.');
    }

    const mediaPaths = mediaRaw ? mediaRaw.split(',').map(value => path.resolve(value.trim())).filter(Boolean) : [];
    for (const mediaPath of mediaPaths) {
      if (!MEDIA_PATTERN.test(mediaPath)) {
        throw codedError('THREADS_INVALID_MEDIA', `Threads không hỗ trợ định dạng media: ${mediaPath}`);
      }
      if (!fs.existsSync(mediaPath)) {
        throw codedError('THREADS_MEDIA_NOT_FOUND', `Không tìm thấy media: ${mediaPath}`);
      }
    }

    // Threads keeps a beforeunload dirty flag briefly after closing/submitting
    // its composer. Link verification must be allowed to refresh the profile
    // without leaving a native “Reload site?” prompt on screen.
    if (page.__covergemThreadsDialogHandler && typeof page.off === 'function') {
      page.off('dialog', page.__covergemThreadsDialogHandler);
    }
    page.__covergemThreadsDialogHandler = async dialog => {
      try {
        if (dialog.type() === 'beforeunload') await dialog.accept();
        else await dialog.dismiss();
      } catch (_) {}
    };
    if (typeof page.on === 'function') page.on('dialog', page.__covergemThreadsDialogHandler);

    if (!await this.validateSession(page)) {
      throw codedError('THREADS_SESSION_INVALID', 'Profile Threads chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.');
    }

    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    if (/\/login(?:\/|\?|$)/i.test(page.url())) {
      throw codedError('THREADS_SESSION_INVALID', 'Threads chuyển về trang đăng nhập; hãy đăng nhập lại profile.');
    }
    const profileUrl = await waitForProfileHref(page, config.composerTimeout);
    if (!profileUrl) {
      throw codedError('THREADS_PROFILE_LINK_NOT_FOUND', 'Không tìm thấy href profile của tài khoản Threads đang đăng nhập.');
    }

    const beforeLinks = await snapshotProfile(page, profileUrl, config);
    if (!await clickComposer(page)) {
      throw codedError('THREADS_COMPOSER_NOT_FOUND', 'Không tìm thấy nơi “Có gì mới” trên profile Threads.');
    }

    let editor = null;
    const editorStarted = Date.now();
    while (!editor && Date.now() - editorStarted < config.composerTimeout) {
      editor = await findComposerEditor(page);
      if (!editor) await delay(250);
    }
    if (!editor) throw codedError('THREADS_EDITOR_NOT_FOUND', 'Popup Threads đã mở nhưng không tìm thấy ô nhập nội dung.');
    if (content) await replaceEditorText(page, editor, content);
    if (mediaPaths.length) await uploadMedia(page, mediaPaths, config);

    await waitUntilReady(page, config);
    if (!await clickPublish(page)) {
      throw codedError('THREADS_PUBLISH_BUTTON_NOT_FOUND', 'Không tìm thấy hoặc chưa thể bấm nút Đăng Threads.');
    }
    const publishedAtMs = Date.now();
    await waitForPublishConfirmation(page, config);
    const postLink = await captureJustPublishedLink(page, profileUrl, beforeLinks, content, config);

    return {
      success: true,
      postedAt: new Date(publishedAtMs).toLocaleString('vi-VN'),
      publishedAtMs,
      postLink,
    };
  },

  async comment() {
    throw codedError('THREADS_COMMENT_NOT_CONFIGURED', 'Script Threads bình luận chưa được cấu hình.');
  },

  async hasExistingComment() {
    return false;
  },

  async validateSession(page) {
    const cookies = await page.cookies(
      'https://www.threads.com',
      'https://www.instagram.com'
    ).catch(() => []);
    return cookies.some(cookie => ['sessionid', 'ds_user_id'].includes(cookie.name) && cookie.value);
  },

  _private: {
    normalizeText,
    normalizeThreadsUrl,
    findProfileHref,
    readPostLinks,
    clickComposer,
    publishButtonState,
    captureJustPublishedLink,
  },
};

module.exports = ThreadsAdapter;
