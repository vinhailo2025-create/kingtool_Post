const fs = require('fs');
const path = require('path');

const HOME_URL = 'https://www.instagram.com/';
const MEDIA_PATTERN = /\.(?:jpe?g|png|webp|gif|bmp|heic|mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function delay(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
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

function normalizeInstagramPostUrl(value) {
  try {
    const url = new URL(value, HOME_URL);
    if (!/(?:^|\.)instagram\.com$/i.test(url.hostname)) return '';
    const match = decodeURIComponent(url.pathname).match(/^\/(?:([^/?#]+)\/)?(p|reel|tv)\/([^/?#]+)/i);
    if (!match) return '';
    const owner = match[1] ? `${match[1]}/` : '';
    return `https://www.instagram.com/${owner}${match[2].toLowerCase()}/${match[3]}/`;
  } catch (_) {
    return '';
  }
}

function getConfig(options = {}) {
  return {
    navigationTimeout: Number(options.navigationTimeout) || 90000,
    actionTimeout: Number(options.actionTimeout) || 60000,
    uploadTimeout: Number(options.uploadTimeout) || 300000,
    publishTimeout: Number(options.publishTimeout) || 300000,
    linkTimeout: Number(options.linkTimeout) || 120000,
    settleMs: Number.isFinite(Number(options.settleMs)) ? Number(options.settleMs) : 1000,
  };
}

async function visibleHandle(page, selectors, matcher) {
  for (const selector of selectors) {
    const handles = await page.$$(selector).catch(() => []);
    for (const handle of handles) {
      const state = await handle.evaluate((element, source) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const text = (
          element.innerText
          || element.textContent
          || element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.querySelector('svg')?.getAttribute('aria-label')
          || ''
        ).replace(/\s+/g, ' ').trim();
        return {
          visible: rect.width > 1 && rect.height > 1 && style.display !== 'none'
            && style.visibility !== 'hidden' && style.opacity !== '0',
          disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
          text,
          source,
        };
      }, selector).catch(() => null);
      if (state?.visible && !state.disabled && (!matcher || matcher(normalizeText(state.text), state))) {
        return handle;
      }
      await handle.dispose().catch(() => {});
    }
  }
  return null;
}

async function findProfileHref(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const norm = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const reserved = new Set([
      'accounts', 'about', 'explore', 'direct', 'reels', 'stories', 'p', 'reel',
      'tv', 'developer', 'privacy', 'legal', 'web', 'challenge', 'oauth',
    ]);
    const candidates = Array.from(document.querySelectorAll('a[href]')).map((anchor, index) => {
      let url;
      try { url = new URL(anchor.href, location.href); } catch (_) { return null; }
      if (!/(?:^|\.)instagram\.com$/i.test(url.hostname)) return null;
      const match = decodeURIComponent(url.pathname).match(/^\/([^/?#]+)\/?$/);
      if (!match || reserved.has(match[1].toLowerCase())) return null;
      const label = norm([
        anchor.innerText, anchor.textContent, anchor.getAttribute('aria-label'),
        anchor.title, anchor.querySelector('img')?.alt,
      ].filter(Boolean).join(' '));
      let score = visible(anchor) ? 5 : 0;
      if (/^profile$|trang ca nhan/.test(label)) score += 200;
      if (/profile|trang ca nhan/.test(label)) score += 80;
      if (anchor.closest('nav')) score += 40;
      if (anchor.querySelector('img')) score += 10;
      score -= index / 10000;
      return { href: `https://www.instagram.com/${match[1]}/`, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return candidates[0]?.href || '';
  }).catch(() => '');
}

async function waitForProfileHref(page, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const href = await findProfileHref(page);
    if (href) return href;
    await delay(300);
  }
  return '';
}

async function readPostLinks(page) {
  const rows = await page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('a[href]')).filter(anchor => {
      return visible(anchor) && /^\/(?:[^/?#]+\/)?(?:p|reel|tv)\//i.test(new URL(anchor.href, location.href).pathname);
    }).map(anchor => ({
      href: anchor.href,
      text: (anchor.querySelector('img')?.alt
        || anchor.closest('[role="dialog"], article, main')?.innerText
        || anchor.parentElement?.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim(),
    }));
  }).catch(() => []);
  const unique = new Map();
  for (const row of rows) {
    const url = normalizeInstagramPostUrl(row.href);
    if (url && !unique.has(url)) unique.set(url, { url, text: row.text || '' });
  }
  return [...unique.values()];
}

async function snapshotProfile(page, profileUrl, config) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
  if (/\/accounts\/login|\/challenge\//i.test(page.url())) {
    throw codedError('INSTAGRAM_SESSION_INVALID', 'Instagram chuyển về trang đăng nhập hoặc xác minh tài khoản.');
  }
  await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
  const started = Date.now();
  let links = [];
  let fingerprint = '';
  let stable = 0;
  while (Date.now() - started < Math.min(config.actionTimeout, 30000)) {
    links = await readPostLinks(page);
    const next = links.map(row => row.url).join('|');
    if (next === fingerprint) stable += 1;
    else { fingerprint = next; stable = 0; }
    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd').toLowerCase();
      const countMatch = text.match(/(\d+)\s+(?:posts?|bai viet)/);
      return {
        ready: !!document.querySelector('main, nav'),
        declaredCount: countMatch ? Number(countMatch[1]) : null,
        explicitlyEmpty: /no posts yet|chua co bai viet/.test(text),
      };
    }).catch(() => ({ ready: false, declaredCount: null, explicitlyEmpty: false }));
    const complete = links.length > 0 || state.explicitlyEmpty || state.declaredCount === 0;
    if (state.ready && complete && stable >= 2) break;
    await delay(500);
  }
  return links;
}

async function waitForPostLinks(page, timeout) {
  const started = Date.now();
  let rows = [];
  while (Date.now() - started < timeout) {
    rows = await readPostLinks(page);
    if (rows.length) return rows;
    await delay(500);
  }
  return rows;
}

async function clickCreate(page, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const handle = await visibleHandle(
      page,
      ['a', 'button', '[role="button"]'],
      text => /^(new post )?create$|^create new$|^tao$|^tao bai viet moi$/.test(text)
        || (text.includes('new post') && text.includes('create'))
    );
    if (handle) {
      await handle.hover().catch(() => {});
      await handle.click();
      await handle.dispose().catch(() => {});
      return true;
    }
    await delay(300);
  }
  return false;
}

async function waitForDialog(page, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const dialog = await page.$('[role="dialog"]');
    if (dialog) return dialog;
    await delay(250);
  }
  return null;
}

async function uploadMedia(page, mediaPaths, config) {
  const select = await visibleHandle(page, ['button', '[role="button"]'], text => (
    /select from computer|chon tu may tinh|chon tep|select files?/.test(text)
  ));
  if (select) {
    let chooser;
    try {
      [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: config.actionTimeout }),
        select.click(),
      ]);
      await chooser.accept(mediaPaths);
    } finally {
      await select.dispose().catch(() => {});
    }
  } else {
    const inputs = await page.$$('[role="dialog"] input[type="file"], input[type="file"]');
    const input = inputs[inputs.length - 1] || null;
    if (!input) throw codedError('INSTAGRAM_FILE_INPUT_NOT_FOUND', 'Không tìm thấy nút chọn media trong popup Instagram.');
    await input.uploadFile(...mediaPaths);
    for (const handle of inputs) await handle.dispose().catch(() => {});
  }

  const uploadStarted = Date.now();
  while (Date.now() - uploadStarted < config.uploadTimeout) {
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const text = (dialog?.innerText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd').toLowerCase();
      const buttons = Array.from((dialog || document).querySelectorAll('button,[role="button"]'));
      const nextReady = buttons.some(button => {
        const label = (button.innerText || button.textContent || '').trim().toLowerCase();
        return /^(next|tiep)$/.test(label) && button.getAttribute('aria-disabled') !== 'true' && !button.disabled;
      });
      const failed = /couldn.t upload|upload failed|khong the tai|tai len that bai|video.*too long|files? must be 1kb or more|too small/.test(text);
      return { nextReady, failed, text: text.slice(0, 400) };
    }).catch(() => ({ nextReady: false, failed: false, text: '' }));
    if (state.failed) throw codedError('INSTAGRAM_UPLOAD_FAILED', `Instagram báo tải media thất bại: ${state.text}`);
    if (state.nextReady) return;
    await delay(500);
  }
  throw codedError('INSTAGRAM_UPLOAD_TIMEOUT', 'Instagram tải media quá thời gian chờ.');
}

async function clickAction(page, labels, timeout) {
  const expected = labels.map(normalizeText);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const handle = await visibleHandle(page, ['[role="dialog"] button', '[role="dialog"] [role="button"]', 'button'], text => (
      expected.includes(text)
    ));
    if (handle) {
      await handle.click();
      await handle.dispose().catch(() => {});
      return true;
    }
    await delay(250);
  }
  return false;
}

async function dismissTransientDialog(page, config) {
  const handle = await visibleHandle(
    page,
    ['[role="dialog"] button', '[role="dialog"] [role="button"]'],
    text => /^(ok|got it|da hieu|tiep tuc)$/.test(text)
  );
  if (!handle) return false;
  await handle.click();
  await handle.dispose().catch(() => {});
  await delay(config.settleMs);
  return true;
}

async function clickNext(page, config) {
  await dismissTransientDialog(page, config);
  const before = await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText || '').catch(() => '');
  if (!await clickAction(page, ['Next', 'Tiếp'], config.actionTimeout)) return false;
  const started = Date.now();
  while (Date.now() - started < config.actionTimeout) {
    const state = await page.evaluate(previous => {
      const dialog = document.querySelector('[role="dialog"]');
      return { exists: !!dialog, text: dialog?.innerText || '', changed: (dialog?.innerText || '') !== previous };
    }, before).catch(() => ({ exists: false, changed: true }));
    if (!state.exists || state.changed) break;
    await delay(250);
  }
  await delay(config.settleMs);
  return true;
}

async function fillCaption(page, content, config) {
  if (!content) return;
  const started = Date.now();
  let editor = null;
  while (!editor && Date.now() - started < config.actionTimeout) {
    editor = await visibleHandle(
      page,
      ['[role="dialog"] textarea', '[role="dialog"] [contenteditable="true"]', 'textarea[aria-label]'],
      text => !/search|tim kiem/.test(text)
    );
    if (!editor) await delay(250);
  }
  if (!editor) throw codedError('INSTAGRAM_CAPTION_NOT_FOUND', 'Không tìm thấy ô viết nội dung Instagram.');
  await editor.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await editor.type(content, { delay: 5 });
  const actual = await editor.evaluate(element => element.value ?? element.innerText ?? element.textContent ?? '').catch(() => '');
  await editor.dispose().catch(() => {});
  if (!normalizeText(actual).includes(normalizeText(content))) {
    throw codedError('INSTAGRAM_CAPTION_NOT_SET', 'Instagram chưa nhận đủ nội dung trong ô caption.');
  }
}

async function waitForShare(page, config) {
  const started = Date.now();
  let sawBusy = false;
  while (Date.now() - started < config.publishTimeout) {
    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').toLowerCase();
      const dialog = document.querySelector('[role="dialog"]');
      return {
        success: /your post has been shared|bai viet cua ban da duoc chia se|post shared/.test(text),
        busy: /sharing|dang chia se|processing|dang xu ly/.test(dialog?.innerText?.toLowerCase() || ''),
        failed: /couldn.t share|sharing failed|khong the chia se|da xay ra loi/.test(text),
        dialog: !!dialog,
      };
    }).catch(() => ({ success: false, busy: false, failed: false, dialog: true }));
    if (state.failed) throw codedError('INSTAGRAM_SHARE_FAILED', 'Instagram báo không thể chia sẻ bài viết.');
    if (state.busy) sawBusy = true;
    if (state.success || (sawBusy && !state.dialog)) return;
    await delay(500);
  }
  const error = codedError('INSTAGRAM_SHARE_TIMEOUT', 'Instagram chưa xác nhận chia sẻ bài viết trong thời gian chờ.');
  error.submitted = true;
  throw error;
}

async function pageContainsContent(page, content) {
  if (!content) return true;
  const expected = normalizeText(content).slice(0, 120);
  return page.evaluate(value => {
    const norm = input => String(input || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').trim().toLowerCase();
    const sources = [
      document.body?.innerText,
      document.querySelector('meta[property="og:description"]')?.content,
      document.querySelector('meta[name="description"]')?.content,
    ];
    return sources.some(source => norm(source).includes(value));
  }, expected).catch(() => false);
}

async function captureJustPublishedLink(page, profileUrl, beforeRows, content, config) {
  const before = new Set((beforeRows || []).map(row => normalizeInstagramPostUrl(row.url || row.href || row)).filter(Boolean));
  const started = Date.now();
  let lastNew = [];

  while (Date.now() - started < config.linkTimeout) {
    const visibleRows = await readPostLinks(page);
    const dialogFresh = visibleRows.filter(row => !before.has(row.url));
    if (dialogFresh.length === 1 && /\/p\//.test(dialogFresh[0].url)) return dialogFresh[0].url;

    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout }).catch(() => {});
    await delay(config.settleMs);
    const rows = await waitForPostLinks(page, Math.min(config.actionTimeout, 15000));
    lastNew = rows.filter(row => !before.has(row.url));
    for (const row of lastNew) {
      if (!content || normalizeText(row.text).includes(normalizeText(content).slice(0, 120))) return row.url;
      await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout }).catch(() => {});
      await delay(500);
      if (await pageContainsContent(page, content)) return row.url;
    }
    await delay(1000);
  }

  const error = codedError(
    'INSTAGRAM_POST_LINK_NOT_FOUND',
    `Instagram đã nhận lệnh Share nhưng chưa xác định được permalink mới (phát hiện ${lastNew.length} link mới).`
  );
  error.submitted = true;
  throw error;
}

const InstagramAdapter = {
  async publish(page, post, options = {}) {
    if (!page) throw codedError('INSTAGRAM_PAGE_MISSING', 'Không có tab trình duyệt Instagram.');
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
    if (!mediaRaw) throw codedError('INSTAGRAM_MEDIA_REQUIRED', 'Dòng Instagram bắt buộc phải có Media.');

    const mediaPaths = mediaRaw.split(',').map(value => path.resolve(value.trim())).filter(Boolean);
    for (const mediaPath of mediaPaths) {
      if (!MEDIA_PATTERN.test(mediaPath)) {
        throw codedError('INSTAGRAM_INVALID_MEDIA', `Instagram không hỗ trợ định dạng media: ${mediaPath}`);
      }
      if (!fs.existsSync(mediaPath)) {
        throw codedError('INSTAGRAM_MEDIA_NOT_FOUND', `Không tìm thấy media: ${mediaPath}`);
      }
      if (fs.statSync(mediaPath).size < 1024) {
        throw codedError('INSTAGRAM_MEDIA_TOO_SMALL', `Media Instagram phải có dung lượng từ 1 KB: ${mediaPath}`);
      }
    }

    if (page.__covergemInstagramDialogHandler && typeof page.off === 'function') {
      page.off('dialog', page.__covergemInstagramDialogHandler);
    }
    page.__covergemInstagramDialogHandler = async dialog => {
      try {
        if (dialog.type() === 'beforeunload') await dialog.accept();
        else await dialog.dismiss();
      } catch (_) {}
    };
    if (typeof page.on === 'function') page.on('dialog', page.__covergemInstagramDialogHandler);

    if (!await this.validateSession(page)) {
      throw codedError('INSTAGRAM_SESSION_INVALID', 'Profile Instagram chưa đăng nhập hoặc phiên đã hết hạn.');
    }
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    if (/\/accounts\/login|\/challenge\//i.test(page.url())) {
      throw codedError('INSTAGRAM_SESSION_INVALID', 'Instagram chuyển về trang đăng nhập hoặc xác minh tài khoản.');
    }
    const profileUrl = await waitForProfileHref(page, config.actionTimeout);
    if (!profileUrl) throw codedError('INSTAGRAM_PROFILE_LINK_NOT_FOUND', 'Không tìm thấy href profile Instagram đang đăng nhập.');
    const beforeLinks = await snapshotProfile(page, profileUrl, config);

    if (!await clickCreate(page, config.actionTimeout)) throw codedError('INSTAGRAM_CREATE_NOT_FOUND', 'Không tìm thấy mục Create ở thanh bên Instagram.');
    const dialog = await waitForDialog(page, config.actionTimeout);
    if (!dialog) throw codedError('INSTAGRAM_CREATE_DIALOG_NOT_FOUND', 'Đã bấm Create nhưng popup đăng bài không xuất hiện.');
    await dialog.dispose().catch(() => {});

    await uploadMedia(page, mediaPaths, config);
    if (!await clickNext(page, config)) throw codedError('INSTAGRAM_FIRST_NEXT_NOT_FOUND', 'Không tìm thấy nút Next thứ nhất.');
    if (!await clickNext(page, config)) throw codedError('INSTAGRAM_SECOND_NEXT_NOT_FOUND', 'Không tìm thấy nút Next thứ hai.');
    await fillCaption(page, content, config);
    if (!await clickAction(page, ['Share', 'Chia sẻ'], config.actionTimeout)) {
      throw codedError('INSTAGRAM_SHARE_NOT_FOUND', 'Không tìm thấy nút Share của Instagram.');
    }
    const publishedAtMs = Date.now();
    await waitForShare(page, config);
    const postLink = await captureJustPublishedLink(page, profileUrl, beforeLinks, content, config);
    return {
      success: true,
      postedAt: new Date(publishedAtMs).toLocaleString('vi-VN'),
      publishedAtMs,
      postLink,
    };
  },

  async comment() {
    throw codedError('INSTAGRAM_COMMENT_NOT_CONFIGURED', 'Script Instagram bình luận chưa được cấu hình.');
  },

  async hasExistingComment() {
    return false;
  },

  async validateSession(page) {
    const cookies = await page.cookies('https://www.instagram.com').catch(() => []);
    return cookies.some(cookie => ['sessionid', 'ds_user_id'].includes(cookie.name) && cookie.value);
  },

  _private: {
    normalizeText,
    normalizeInstagramPostUrl,
    findProfileHref,
    readPostLinks,
    captureJustPublishedLink,
  },
};

module.exports = InstagramAdapter;
