const fs = require('fs');
const { resolveMediaPath } = require('../services/media-path.utils');
const path = require('path');

const COMPOSE_URL = 'https://x.com/compose/post';
const MEDIA_PATTERN = /\.(?:jpe?g|png|webp|gif|bmp|mp4|mov|m4v|webm)$/i;

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

function normalizeXPostUrl(value) {
  try {
    const url = new URL(value, 'https://x.com');
    if (!/(?:^|\.)(?:x|twitter)\.com$/i.test(url.hostname)) return '';
    const match = decodeURIComponent(url.pathname).match(/^\/([^/?#]+)\/status\/(\d+)/i);
    if (!match) return '';
    return `https://x.com/${match[1]}/status/${match[2]}`;
  } catch (_) {
    return '';
  }
}

function getConfig(options = {}) {
  return {
    navigationTimeout: Number(options.navigationTimeout) || 90000,
    actionTimeout: Number(options.actionTimeout) || 60000,
    uploadTimeout: Number(options.uploadTimeout) || 300000,
    publishTimeout: Number(options.publishTimeout) || 180000,
    linkTimeout: Number(options.linkTimeout) || 120000,
    settleMs: Number.isFinite(Number(options.settleMs)) ? Number(options.settleMs) : 800,
  };
}

function assertAccountAvailable(page) {
  const restriction = page?.__covergemXAccountRestriction;
  if (!restriction) return;
  throw codedError(restriction.code || 'X_ACCOUNT_RESTRICTED', restriction.message);
}

function bindAccountRestrictionDetection(page) {
  if (page.__covergemXRestrictionHandler && typeof page.off === 'function') {
    page.off('response', page.__covergemXRestrictionHandler);
  }
  page.__covergemXAccountRestriction = null;
  page.__covergemXRestrictionHandler = async response => {
    try {
      if (!/(?:viewer_context|app_context|CreateTweet)/i.test(response.url())) return;
      const body = await response.text();
      if (/your account is suspended|Missing TwitterUserNotSuspended/i.test(body)) {
        page.__covergemXAccountRestriction = {
          code: 'X_ACCOUNT_SUSPENDED',
          message: 'Tài khoản X đang bị đình chỉ (suspended) nên không được phép đăng bài.',
        };
      }
    } catch (_) {}
  };
  if (typeof page.on === 'function') page.on('response', page.__covergemXRestrictionHandler);
}

async function probeAccountAvailability(page) {
  const body = await page.evaluate(async () => {
    try {
      const response = await fetch('/i/api/1.1/graphql/viewer_context.json', {
        credentials: 'include',
        cache: 'no-store',
      });
      return await response.text();
    } catch (_) {
      return '';
    }
  }).catch(() => '');
  if (/your account is suspended|Missing TwitterUserNotSuspended/i.test(body)) {
    page.__covergemXAccountRestriction = {
      code: 'X_ACCOUNT_SUSPENDED',
      message: 'Tài khoản X đang bị đình chỉ (suspended) nên không được phép đăng bài.',
    };
  }
  assertAccountAvailable(page);
}

async function findProfileHref(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const reserved = new Set([
      'home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose',
      'search', 'tos', 'privacy', 'login', 'signup', 'intent', 'hashtag',
    ]);
    const rows = Array.from(document.querySelectorAll('a[href]')).map((anchor, index) => {
      let url;
      try { url = new URL(anchor.href, location.href); } catch (_) { return null; }
      if (!/(?:^|\.)(?:x|twitter)\.com$/i.test(url.hostname)) return null;
      const match = decodeURIComponent(url.pathname).match(/^\/([^/?#]+)\/?$/);
      if (!match || reserved.has(match[1].toLowerCase())) return null;
      const label = [anchor.getAttribute('aria-label'), anchor.innerText, anchor.textContent]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
      let score = visible(anchor) ? 5 : 0;
      if (/^(profile|trang ca nhan)$/.test(label)) score += 200;
      if (/profile|trang ca nhan/.test(label)) score += 80;
      if (anchor.closest('nav')) score += 30;
      score -= index / 10000;
      return { href: `https://x.com/${match[1]}`, owner: match[1], score };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    return rows[0] || null;
  }).catch(() => null);
}

async function waitForProfileHref(page, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const profile = await findProfileHref(page);
    if (profile?.href) return profile;
    await delay(300);
  }
  return null;
}

async function readStatusLinks(page, owner = '') {
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/status/"]')).map(anchor => ({
    href: anchor.href,
    text: (anchor.closest('article')?.innerText || anchor.parentElement?.innerText || anchor.innerText || '')
      .replace(/\s+/g, ' ').trim(),
  }))).catch(() => []);
  const expectedOwner = String(owner || '').toLowerCase();
  const unique = new Map();
  for (const row of rows) {
    const url = normalizeXPostUrl(row.href);
    if (!url) continue;
    const actualOwner = new URL(url).pathname.split('/')[1].toLowerCase();
    if (expectedOwner && actualOwner !== expectedOwner) continue;
    if (!unique.has(url)) unique.set(url, { url, text: row.text || '' });
  }
  return [...unique.values()];
}

async function snapshotProfile(page, profile, config) {
  await page.goto(profile.href, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
  if (/\/i\/flow\/login|\/login(?:\?|$)/i.test(page.url())) {
    throw codedError('X_SESSION_INVALID', 'X chuyển về trang đăng nhập; hãy đăng nhập lại profile.');
  }
  const started = Date.now();
  let rows = [];
  let fingerprint = '';
  let stable = 0;
  while (Date.now() - started < Math.min(config.actionTimeout, 30000)) {
    rows = await readStatusLinks(page, profile.owner);
    const next = rows.map(row => row.url).join('|');
    if (next === fingerprint) stable += 1;
    else { fingerprint = next; stable = 0; }
    const ready = await page.evaluate(() => !!document.querySelector('main,[data-testid="primaryColumn"]')).catch(() => false);
    const explicitlyEmpty = await page.evaluate(() => /hasn.t posted|chua dang bai|no posts/i.test(document.body?.innerText || '')).catch(() => false);
    if (ready && stable >= 2 && (rows.length > 0 || explicitlyEmpty)) break;
    await delay(500);
  }
  return rows;
}

async function waitForComposer(page, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const editor = await page.$('[data-testid="tweetTextarea_0"], [role="textbox"][aria-label="Post text"]');
    if (editor) {
      const visible = await editor.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
      }).catch(() => false);
      if (visible) return editor;
      await editor.dispose().catch(() => {});
    }
    await delay(250);
  }
  return null;
}

async function setPostText(page, editor, content) {
  if (!content) return;
  await editor.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await editor.type(content, { delay: 5 });
  const actual = await editor.evaluate(element => element.innerText || element.textContent || '').catch(() => '');
  if (!normalizeText(actual).includes(normalizeText(content))) {
    throw codedError('X_CONTENT_NOT_SET', 'X chưa nhận đủ nội dung trong composer.');
  }
}

async function clearExistingMedia(page) {
  while (true) {
    const button = await page.evaluateHandle(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return Array.from(document.querySelectorAll(
        '[data-testid^="removeMedia"], button[aria-label], [role="button"][aria-label]'
      )).find(element => {
        if (!visible(element)) return false;
        const label = norm(
          `${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`
        );
        return /remove media|go (anh|video|noi dung nghe nhin)|xoa (anh|video|media)/.test(label);
      }) || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
    if (!button) return;
    await button.click();
    await button.dispose().catch(() => {});
    await delay(300);
  }
}

async function uploadMedia(page, mediaPaths, config) {
  let input = await page.$('input[data-testid="fileInput"], input[type="file"][accept*="image"]');
  if (input) {
    await input.uploadFile(...mediaPaths);
    await input.dispose().catch(() => {});
  } else {
    const button = await page.evaluateHandle(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return Array.from(document.querySelectorAll(
        'button[aria-label], [role="button"][aria-label], [data-testid="attachments"]'
      )).find(element => {
        if (!visible(element)) return false;
        const label = norm(
          `${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`
        );
        return /add photos? or video|them anh hoac video|them anh\/video|add media/.test(label);
      }) || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
    if (!button) throw codedError('X_MEDIA_INPUT_NOT_FOUND', 'Không tìm thấy nút thêm media của X.');
    try {
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: config.actionTimeout }),
        button.click(),
      ]);
      await chooser.accept(mediaPaths);
    } finally {
      await button.dispose().catch(() => {});
    }
  }

  const started = Date.now();
  while (Date.now() - started < config.uploadTimeout) {
    const state = await page.evaluate(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      const media = !!document.querySelector(
        '[data-testid="attachments"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"], '
        + '[data-testid^="removeMedia"], [aria-label="Remove media"]'
      );
      const failed = /some of your media failed to upload|media failed to upload|video file is not compatible|couldn.t upload|tai media that bai|khong the tai/.test(body);
      return { media, failed };
    }).catch(() => ({ media: false, failed: false }));
    if (state.failed) throw codedError('X_MEDIA_UPLOAD_FAILED', 'X báo tải media thất bại hoặc định dạng không tương thích.');
    if (state.media) return;
    await delay(500);
  }
  throw codedError('X_MEDIA_UPLOAD_TIMEOUT', 'X tải media quá thời gian chờ.');
}

async function findPostButton(page) {
  const selectors = [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
    'button[aria-label="Post"]',
  ];
  for (const selector of selectors) {
    const handles = await page.$$(selector).catch(() => []);
    for (const handle of handles) {
      const state = await handle.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          visible: rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden',
          disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
        };
      }).catch(() => ({ visible: false, disabled: true }));
      if (state.visible && !state.disabled) return handle;
      await handle.dispose().catch(() => {});
    }
  }
  const handle = await page.evaluateHandle(() => {
    const norm = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('button, [role="button"]')).find(element => {
      if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') {
        return false;
      }
      const labels = [
        norm(element.innerText || ''),
        norm(element.getAttribute('aria-label') || ''),
      ].filter(Boolean);
      return labels.some(label => ['post', 'publish', 'dang', 'dang bai'].includes(label));
    }) || null;
  }).catch(() => null);
  return handle && handle.asElement ? handle.asElement() : null;
}

async function waitUntilPostReady(page, config) {
  const started = Date.now();
  while (Date.now() - started < config.actionTimeout) {
    const button = await findPostButton(page);
    if (button) return button;
    await delay(250);
  }
  const errorText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 600)).catch(() => '');
  throw codedError('X_POST_NOT_READY', `Nút Post chưa sẵn sàng. ${errorText}`.trim());
}

async function waitForPublish(page, owner, config) {
  const started = Date.now();
  let sawComposer = true;
  while (Date.now() - started < config.publishTimeout) {
    assertAccountAvailable(page);
    const state = await page.evaluate(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      const toast = document.querySelector('[data-testid="toast"]');
      const toastText = (toast?.innerText || '').replace(/\s+/g, ' ').trim();
      const links = Array.from((toast || document).querySelectorAll('a[href*="/status/"]')).map(anchor => anchor.href);
      const body = norm(document.body?.innerText || '');
      return {
        toastText,
        links,
        composer: !!document.querySelector('[data-testid="tweetTextarea_0"]'),
        transient: /something went wrong.*give it another shot|something went wrong.*try again|let.s give it another shot|da xay ra loi.*thu lai/.test(body),
        failed: /post failed|couldn.t send post|account is locked|you are over the daily limit|khong the gui bai dang|dang bai that bai|tai khoan bi khoa|vuot qua gioi han hang ngay/.test(body),
      };
    }).catch(() => ({ toastText: '', links: [], composer: true, transient: false, failed: false }));
    if (state.failed) throw codedError('X_POST_FAILED', 'X báo không thể đăng bài.');
    if (state.transient && Date.now() - started > 800) {
      throw codedError('X_POST_TRANSIENT', 'X báo lỗi tạm thời và yêu cầu thử Post lại.');
    }
    for (const link of state.links) {
      const normalized = normalizeXPostUrl(link);
      if (!normalized) continue;
      const actualOwner = new URL(normalized).pathname.split('/')[1].toLowerCase();
      if (!owner || actualOwner === owner.toLowerCase()) return normalized;
    }
    if (/your post was sent|bai dang cua ban da duoc gui|post sent/i.test(state.toastText)) {
      sawComposer = false;
    }
    if (sawComposer && !state.composer) return '';
    await delay(300);
  }
  const error = codedError('X_POST_TIMEOUT', 'X chưa xác nhận đăng bài trong thời gian chờ.');
  error.submitted = true;
  throw error;
}

async function waitForStatusLinks(page, owner, timeout) {
  const started = Date.now();
  let rows = [];
  while (Date.now() - started < timeout) {
    rows = await readStatusLinks(page, owner);
    if (rows.length) return rows;
    await delay(500);
  }
  return rows;
}

async function pageContainsContent(page, content) {
  if (!content) return true;
  const expected = normalizeText(content).slice(0, 140);
  return page.evaluate(value => {
    const norm = input => String(input || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').trim().toLowerCase();
    const sources = [document.body?.innerText, document.querySelector('meta[property="og:description"]')?.content];
    return sources.some(source => norm(source).includes(value));
  }, expected).catch(() => false);
}

async function captureJustPublishedLink(page, profile, beforeRows, content, directLink, config) {
  if (directLink) return normalizeXPostUrl(directLink);
  const before = new Set((beforeRows || []).map(row => normalizeXPostUrl(row.url || row.href || row)).filter(Boolean));
  const started = Date.now();
  let lastNew = [];
  while (Date.now() - started < config.linkTimeout) {
    await page.goto(profile.href, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout }).catch(() => {});
    await delay(config.settleMs);
    const rows = await waitForStatusLinks(page, profile.owner, Math.min(config.actionTimeout, 15000));
    lastNew = rows.filter(row => !before.has(row.url));
    if (lastNew.length === 1) return lastNew[0].url;
    for (const row of lastNew) {
      if (!content || normalizeText(row.text).includes(normalizeText(content).slice(0, 140))) return row.url;
      await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout }).catch(() => {});
      await delay(500);
      if (await pageContainsContent(page, content)) return row.url;
    }
    await delay(1000);
  }
  const error = codedError('X_POST_LINK_NOT_FOUND', `X đã nhận lệnh Post nhưng chưa xác định được permalink mới (${lastNew.length} link mới).`);
  error.submitted = true;
  throw error;
}

const XAdapter = {
  async publish(page, post, options = {}) {
    if (!page) throw codedError('X_PAGE_MISSING', 'Không có tab trình duyệt X.');
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
    if (!content && !mediaRaw) throw codedError('X_DATA_REQUIRED', 'Dòng X cần có Nội dung hoặc Media.');

    const mediaPaths = mediaRaw ? mediaRaw.split(',').map(value => resolveMediaPath(value) || value.trim()).filter(Boolean) : [];
    for (const mediaPath of mediaPaths) {
      if (!MEDIA_PATTERN.test(mediaPath)) throw codedError('X_INVALID_MEDIA', `X không hỗ trợ định dạng media: ${mediaPath}`);
      if (!resolveMediaPath(mediaPath)) throw codedError('X_MEDIA_NOT_FOUND', `Không tìm thấy media: ${mediaPath}`);
    }

    if (page.__covergemXDialogHandler && typeof page.off === 'function') {
      page.off('dialog', page.__covergemXDialogHandler);
    }
    page.__covergemXDialogHandler = async dialog => {
      try {
        if (dialog.type() === 'beforeunload') await dialog.accept();
        else await dialog.dismiss();
      } catch (_) {}
    };
    if (typeof page.on === 'function') page.on('dialog', page.__covergemXDialogHandler);
    bindAccountRestrictionDetection(page);

    if (!await this.validateSession(page)) throw codedError('X_SESSION_INVALID', 'Profile X chưa đăng nhập hoặc phiên đã hết hạn.');
    await page.goto(COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    await delay(500);
    await probeAccountAvailability(page);
    if (/\/i\/flow\/login|\/login(?:\?|$)/i.test(page.url())) throw codedError('X_SESSION_INVALID', 'X chuyển về trang đăng nhập.');
    const profile = await waitForProfileHref(page, config.actionTimeout);
    if (!profile) throw codedError('X_PROFILE_LINK_NOT_FOUND', 'Không tìm thấy href profile X đang đăng nhập.');
    const beforeLinks = await snapshotProfile(page, profile, config);
    assertAccountAvailable(page);

    await page.goto(COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
    await delay(500);
    assertAccountAvailable(page);
    const editor = await waitForComposer(page, config.actionTimeout);
    if (!editor) throw codedError('X_COMPOSER_NOT_FOUND', 'Không tìm thấy ô nhập nội dung trên X.');
    await clearExistingMedia(page);
    await setPostText(page, editor, content);
    await editor.dispose().catch(() => {});
    if (mediaPaths.length) {
      await uploadMedia(page, mediaPaths, config);
      await options.interactionPacer?.afterMedia();
    }

    let directLink = '';
    let publishedAtMs = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const postButton = await waitUntilPostReady(page, config);
      if (attempt === 1) await options.interactionPacer?.beforePublish();
      await postButton.click();
      await postButton.dispose().catch(() => {});
      if (!publishedAtMs) publishedAtMs = Date.now();
      try {
        directLink = await waitForPublish(page, profile.owner, config);
        break;
      } catch (error) {
        if (error.code !== 'X_POST_TRANSIENT' || attempt >= 3) throw error;
        await delay(1500);
      }
    }
    const postLink = await captureJustPublishedLink(page, profile, beforeLinks, content, directLink, config);
    return {
      success: true,
      postedAt: new Date(publishedAtMs).toLocaleString('vi-VN'),
      publishedAtMs,
      postLink,
    };
  },

  async comment() {
    throw codedError('X_COMMENT_NOT_CONFIGURED', 'Script X bình luận chưa được cấu hình.');
  },

  async hasExistingComment() {
    return false;
  },

  async validateSession(page) {
    const cookies = await page.cookies('https://x.com', 'https://twitter.com').catch(() => []);
    return cookies.some(cookie => cookie.name === 'auth_token' && cookie.value);
  },

  _private: {
    normalizeText,
    normalizeXPostUrl,
    findProfileHref,
    readStatusLinks,
    captureJustPublishedLink,
    assertAccountAvailable,
    probeAccountAvailability,
    findPostButton,
  },
};

module.exports = XAdapter;
