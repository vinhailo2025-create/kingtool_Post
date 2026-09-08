const fs = require('fs');
const { resolveMediaPath } = require('../services/media-path.utils');
const path = require('path');

const CHANNEL_SWITCHER_URL = 'https://www.youtube.com/channel_switcher';
const STUDIO_URL = 'https://studio.youtube.com/';
const VIDEO_PATTERN = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i;
const IMAGE_PATTERN = /\.(?:jpg|jpeg|png|webp)$/i;

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
  const timeout = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    navigationTimeout: timeout(options.navigationTimeout, 90000),
    editorTimeout: timeout(options.editorTimeout, 180000),
    uploadTimeout: timeout(options.uploadTimeout, 900000),
    publishTimeout: timeout(options.publishTimeout, 180000),
    settleMs: Number.isFinite(Number(options.settleMs)) ? Number(options.settleMs) : 1200,
  };
}

async function delay(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDialogHandler(page) {
  if (!page || typeof page.on !== 'function') return;
  if (page.__covergemYouTubeDialogHandler) return;
  const handler = dialog => dialog.accept().catch(() => {});
  page.__covergemYouTubeDialogHandler = handler;
  page.on('dialog', handler);
}

async function navigate(page, url, config) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeout });
  } catch (error) {
    if (!/youtube\.com/i.test(page.url())) throw error;
  }
}

async function bodyText(page) {
  return page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

function mapValue(map, key, render) {
  const value = map && map[key];
  return render ? render(`{{${key}}}`, map) : String(value == null ? '' : value);
}

function visibleElement(element) {
  if (!element || !(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 1 && rect.height > 1
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0';
}

async function clickVisibleText(page, labels, { exact = false } = {}) {
  const wanted = labels.map(normalizeText);
  return page.evaluate(({ wanted, exact }) => {
    const norm = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      if (!element || !(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none'
        && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const selector = 'button, [role="button"], [role="radio"], [role="option"], label, a, tp-yt-paper-item, div';
    const candidates = Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .map(element => ({
        element,
        text: norm(element.innerText || element.textContent || element.getAttribute('aria-label') || ''),
      }))
      .filter(item => wanted.some(value => exact ? item.text === value : item.text.includes(value)))
      .sort((a, b) => a.text.length - b.text.length);
    const match = candidates[0];
    if (!match) return false;
    match.element.scrollIntoView({ block: 'center', inline: 'center' });
    match.element.click();
    return true;
  }, { wanted, exact }).catch(() => false);
}

async function waitFor(page, predicate, timeout, message) {
  const started = Date.now();
  while (timeout === 0 || Date.now() - started < timeout) {
    if (await predicate()) return true;
    await delay(300);
  }
  throw codedError('YOUTUBE_TIMEOUT', message);
}

async function switchChannel(page, channelName, config) {
  const target = String(channelName || '').trim();
  if (!target) throw codedError('YOUTUBE_CHANNEL_REQUIRED', 'Cột Tên kênh chưa có dữ liệu.');

  await navigate(page, CHANNEL_SWITCHER_URL, config);

  const matched = await waitFor(page, async () => page.evaluate(targetValue => {
    const normalize = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const targetNormalized = normalize(targetValue);
    const cards = Array.from(document.querySelectorAll('ytd-account-item-renderer'));
    const card = cards.map(element => {
      const title = normalize(element.querySelector('#channel-title')?.textContent || '');
      const handle = normalize(element.querySelector('#channel-handle')?.textContent || '');
      const text = normalize(element.innerText || '');
      const exact = title === targetNormalized || handle === targetNormalized;
      const partial = title.includes(targetNormalized) || handle.includes(targetNormalized) || text.includes(targetNormalized);
      return { element, exact, partial };
    }).sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.partial) - Number(a.partial));
    const match = card.find(item => item.exact) || card.find(item => item.partial);
    if (!match) return false;
    const clickable = match.element.querySelector('[role="option"]') || match.element;
    clickable.click();
    return true;
  }, target), config.editorTimeout, `Không tìm thấy kênh YouTube "${target}" trong channel switcher.`);

  if (!matched) throw codedError('YOUTUBE_CHANNEL_NOT_FOUND', `Không tìm thấy kênh YouTube "${target}".`);
  await waitFor(page, async () => !/\/account(?:\?|$)/i.test(page.url()) && !/channel_switcher/i.test(page.url()), config.editorTimeout,
    `Không chuyển được sang kênh YouTube "${target}".`);
}

async function replaceContentEditable(page, selector, value, timeout, fieldName) {
  let editor = null;
  await waitFor(page, async () => {
    editor = await page.$(selector);
    if (!editor) return false;
    return page.evaluate(element => element.contentEditable === 'true' && element.getAttribute('aria-disabled') !== 'true', editor)
      .catch(() => false);
  }, timeout, `Ô ${fieldName} YouTube chưa sẵn sàng.`);

  await editor.click({ clickCount: 3 }).catch(() => editor.click());
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  if (value) await page.keyboard.sendCharacter(value);

  const correct = await page.evaluate((element, expected) =>
    String(element.innerText || '').replace(/\r\n/g, '\n') === String(expected || '').replace(/\r\n/g, '\n'), editor, value)
    .catch(() => false);
  if (!correct) {
    await page.evaluate((element, text) => {
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, text);
      selection.removeAllRanges();
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, editor, value).catch(() => {});
  }
}

async function uploadThumbnail(page, thumbnailPath, config) {
  const input = await page.$('ytcp-thumbnail-uploader input#file-loader');
  if (!input) throw codedError('YOUTUBE_THUMBNAIL_INPUT_NOT_FOUND', 'Không tìm thấy ô tải hình Thumbnail YouTube.');
  await input.uploadFile(thumbnailPath);
  await waitFor(page, () => page.evaluate(() => {
    const norm = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
      .toLowerCase();
    return Array.from(document.querySelectorAll('ytcp-thumbnail-uploader [aria-label]'))
      .some(element => {
        const label = norm(element.getAttribute('aria-label'));
        return label.includes('hinh thu nho da tai len')
          || /(?:uploaded.*thumbnail|thumbnail.*uploaded)/.test(label);
      });
  }),
    config.editorTimeout, 'YouTube chưa xác nhận tải hình Thumbnail.');
}

async function selectPlaylist(page, playlistName, config) {
  const target = normalizeText(playlistName);
  const trigger = await page.evaluateHandle(() => {
    const norm = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
      .toLowerCase();
    return Array.from(document.querySelectorAll(
      'ytcp-video-metadata-playlists ytcp-dropdown-trigger'
    )).find(element => {
      const text = norm(
        `${element.getAttribute('aria-label') || ''} ${element.innerText || ''}`
      );
      return text.includes('danh sach phat') || text.includes('playlist');
    }) || null;
  }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
  if (!trigger) throw codedError('YOUTUBE_PLAYLIST_TRIGGER_NOT_FOUND', 'Không tìm thấy mục Danh sách phát YouTube.');
  await trigger.click();
  await delay(config.settleMs);

  const selected = await page.evaluate(targetValue => {
    const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = normalize(targetValue);
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const options = Array.from(document.querySelectorAll('[role="option"], tp-yt-paper-item, ytcp-checkbox-lit, ytcp-menu-service-item-renderer, li, div'))
      .filter(visible)
      .map(element => ({ element, text: normalize(element.innerText || element.textContent || '') }))
      .filter(item => item.text === target || item.text.includes(target))
      .sort((a, b) => a.text.length - b.text.length);
    if (!options.length) return false;
    options[0].element.click();
    return true;
  }, target);
  if (!selected) throw codedError('YOUTUBE_PLAYLIST_NOT_FOUND', `Không tìm thấy danh sách phát "${playlistName}".`);
  await delay(config.settleMs);
  await clickVisibleText(page, ['Xong', 'Lưu', 'Done', 'Save'], { exact: true }).catch(() => false);
}

async function fillTags(page, tags, config) {
  const value = String(tags || '').trim();
  if (!value) return;
  const input = await page.$(
    'ytcp-video-metadata-editor input#text-input[aria-label*="Thẻ" i], '
    + 'ytcp-video-metadata-editor input#text-input[aria-label*="Tags" i]'
  );
  if (!input) throw codedError('YOUTUBE_TAG_INPUT_NOT_FOUND', 'Không tìm thấy ô Thẻ (từ khóa) YouTube.');
  await input.click();
  await page.keyboard.sendCharacter(value);
  await page.keyboard.press('Enter');
  await delay(config.settleMs);
}

async function waitNextEnabled(page, config) {
  await waitFor(page, () => page.evaluate(() => {
    const button = document.querySelector('#next-button');
    return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
  }), config.editorTimeout, 'Nút Tiếp của YouTube chưa sẵn sàng.');
  await page.click('#next-button');
  await delay(config.settleMs);
}

async function chooseVisibility(page, visibility, config) {
  const normalized = normalizeText(visibility || 'Không công khai');
  const aliases = normalized.includes('cong khai') && !normalized.includes('khong')
    ? ['Công khai', 'Public']
    : normalized.includes('rieng tu')
      ? ['Riêng tư', 'Private']
      : ['Không công khai', 'Unlisted'];
  const clicked = await clickVisibleText(page, aliases, { exact: false });
  if (!clicked) throw codedError('YOUTUBE_VISIBILITY_NOT_FOUND', `Không chọn được chế độ hiển thị "${visibility}".`);
  await delay(config.settleMs);
}

async function readPublishedLink(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('ytcp-uploads-dialog');
    const root = dialog || document;
    const anchors = Array.from(root.querySelectorAll('a[href]'));
    const found = anchors.map(anchor => anchor.href || '').find(
      href => /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[\w-]+/i.test(href)
    );
    if (found) return found;
    const info = root.querySelector('ytcp-video-info');
    const text = info?.innerText || root.innerText || '';
    return text.match(
      /https?:\/\/(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)[\w-]+|https?:\/\/youtu\.be\/[\w-]+/i
    )?.[0] || '';
  }).catch(() => '');
}

async function hasPublishedConfirmation(page) {
  return page.evaluate(() => {
    const normalize = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 100 && rect.height > 60
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll(
      'ytcp-dialog, tp-yt-paper-dialog, [role="dialog"]'
    )).filter(visible).some(element => {
      const text = normalize(element.innerText);
      return text.includes('da dang video')
        || text.includes('video published')
        || text.includes('video has been published');
    });
  }).catch(() => false);
}

async function clickFinalPublish(page) {
  return page.evaluate(() => {
    const normalize = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const root = document.querySelector('ytcp-uploads-dialog') || document;
    const labels = new Set(['xuat ban', 'publish', 'luu', 'save']);
    const button = Array.from(root.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map(element => ({ element, text: normalize(element.innerText || element.textContent || element.getAttribute('aria-label') || '') }))
      .filter(item => labels.has(item.text))
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (!button || button.element.disabled || button.element.getAttribute('aria-disabled') === 'true') return false;
    button.element.click();
    return true;
  }).catch(() => false);
}

async function clickPendingChecksPromptOnce(page) {
  return page.evaluate(() => {
      const normalize = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 100 && rect.height > 60
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll(
        'ytcp-dialog, tp-yt-paper-dialog, [role="dialog"]'
      )).filter(visible);
      const dialog = dialogs.find(element => {
        const text = normalize(element.innerText);
        return text.includes('van dang kiem tra noi dung')
          || text.includes('kiem tra noi dung cua ban')
          || text.includes('checks are still running')
          || text.includes('still checking your video')
          || text.includes('still checking your content');
      });
      if (!dialog) return { found: false, clicked: false };
      const button = Array.from(dialog.querySelectorAll(
        'button, [role="button"], ytcp-button, tp-yt-paper-button'
      )).find(element => {
        const text = normalize(
          element.innerText || element.textContent || element.getAttribute('aria-label')
        );
        return text === 'van xuat ban'
          || text === 'publish anyway'
          || text === 'publish still'
          || text === 'still publish';
      });
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
        return { found: true, clicked: false };
      }
      button.click();
      return { found: true, clicked: true };
  }).catch(() => ({ found: false, clicked: false }));
}

async function confirmPublishWhileChecksPending(page, timeout = 15000) {
  const started = Date.now();
  do {
    const state = await clickPendingChecksPromptOnce(page);
    if (state.clicked) return true;
    await delay(state.found ? 250 : 400);
  } while (Date.now() - started < timeout);
  return false;
}

async function waitPublishedResult(page, config, alreadyConfirmed = false) {
  const started = Date.now();
  let confirmedAt = alreadyConfirmed ? Date.now() : 0;
  while (config.publishTimeout === 0 || Date.now() - started < config.publishTimeout) {
    const link = await readPublishedLink(page);
    if (link) return { postLink: link, publishedWhileChecking: Boolean(confirmedAt) };

    if (await hasPublishedConfirmation(page) === true) {
      return { postLink: '', publishedWhileChecking: true };
    }
    if (!confirmedAt) {
      const state = await clickPendingChecksPromptOnce(page);
      if (state.clicked) confirmedAt = Date.now();
    }
    if (confirmedAt && Date.now() - confirmedAt >= 45000) {
      return { postLink: '', publishedWhileChecking: true };
    }
    await delay(300);
  }
  if (confirmedAt) return { postLink: '', publishedWhileChecking: true };
  throw codedError('YOUTUBE_TIMEOUT', 'YouTube đã xuất bản nhưng chưa lấy được link video.');
}

const YouTubeAdapter = {
  async publish(page, post, options = {}) {
    if (!page) return Promise.reject(codedError('YOUTUBE_PAGE_MISSING', 'No YouTube browser tab.'));
    ensureDialogHandler(page);
    if (!page) throw codedError('YOUTUBE_PAGE_MISSING', 'Không có tab trình duyệt YouTube.');
    const config = getConfig(options);
    const map = options.buildVarMap ? options.buildVarMap(post) : { ...post, media: post?.media ?? post?.image_path ?? '' };
    const render = options.renderTemplate || ((template, values) => String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => values[key] == null ? '' : String(values[key])));
    const title = mapValue(map, 'content', render).trim();
    const description = mapValue(map, 'description', render);
    const channelName = mapValue(map, 'channel_name', render).trim();
    const playlist = mapValue(map, 'playlist', render).trim();
    const visibility = mapValue(map, 'privacy_status', render).trim() || 'Không công khai';
    const tags = mapValue(map, 'keywords', render).trim();
    const mediaRaw = mapValue(map, 'media', render).trim();
    const thumbnailRaw = mapValue(map, 'thumbnail', render).trim();

    if (!title) throw codedError('YOUTUBE_TITLE_REQUIRED', 'Cột Nội dung chưa có tiêu đề video YouTube.');
    if (!mediaRaw || !VIDEO_PATTERN.test(mediaRaw)) throw codedError('YOUTUBE_MEDIA_REQUIRED', 'Cột Media chưa có video YouTube hợp lệ.');
    // Đường dẫn tiếng Việt có dấu phải quy về đúng tên file trên ổ đĩa trước khi dùng
    const media = resolveMediaPath(mediaRaw);
    if (!media) throw codedError('YOUTUBE_MEDIA_NOT_FOUND', `Không tìm thấy video YouTube: ${mediaRaw}`);
    const thumbnail = thumbnailRaw ? resolveMediaPath(thumbnailRaw) : '';
    if (thumbnailRaw && (!IMAGE_PATTERN.test(thumbnailRaw) || !thumbnail)) {
      throw codedError('YOUTUBE_THUMBNAIL_NOT_FOUND', `Không tìm thấy hình Thumbnail: ${thumbnailRaw}`);
    }
    if (!await this.validateSession(page)) throw codedError('YOUTUBE_SESSION_INVALID', 'Profile YouTube chưa đăng nhập hoặc phiên đã hết hạn.');

    if (channelName) await switchChannel(page, channelName, config);
    await navigate(page, STUDIO_URL, config);
    if (channelName) {
      await waitFor(page, () => page.evaluate(target => {
        const normalize = value => String(value || '')
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
          .replace(/\s+/g, ' ').trim().toLowerCase();
        return normalize(document.body?.innerText || '').includes(normalize(target));
      }, channelName), config.editorTimeout,
        `YouTube Studio chưa chuyển đúng sang kênh "${channelName}".`);
    }

    const uploadStarted = Date.now();
    let uploadClicked = false;
    while (!uploadClicked && (config.editorTimeout === 0 || Date.now() - uploadStarted < config.editorTimeout)) {
      uploadClicked = await clickVisibleText(
        page,
        ['Tải video lên', 'Upload videos', 'Upload video'],
        { exact: true }
      );
      if (!uploadClicked) await delay(300);
    }
    if (!uploadClicked) {
      throw codedError('YOUTUBE_UPLOAD_BUTTON_NOT_FOUND', 'Không tìm thấy nút tải video lên YouTube.');
    }
    const fileInput = await page.waitForSelector('input[type="file"][name="Filedata"]', { timeout: config.editorTimeout });
    await fileInput.uploadFile(media);
    await options.interactionPacer?.afterMedia();

    await waitFor(page, () => page.evaluate(() => {
      const title = document.querySelector('ytcp-video-title [contenteditable="true"]');
      const description = document.querySelector('ytcp-video-description [contenteditable="true"]');
      return Boolean(title && description);
    }), config.uploadTimeout, 'YouTube chưa mở được phần cài đặt video sau khi tải file.');

    await replaceContentEditable(page, 'ytcp-video-title [contenteditable="true"]', title, config.editorTimeout, 'Tiêu đề');
    if (description) {
      await replaceContentEditable(page, 'ytcp-video-description [contenteditable="true"]', description, config.editorTimeout, 'Mô tả video');
    }
    if (thumbnail) await uploadThumbnail(page, path.resolve(thumbnail), config);
    if (playlist) await selectPlaylist(page, playlist, config);

    const audience = await clickVisibleText(page, [
      'Không, nội dung này không dành cho trẻ em',
      "No, it's not made for kids",
      'No, this video is not made for kids',
    ], { exact: false });
    if (!audience) throw codedError('YOUTUBE_AUDIENCE_NOT_FOUND', 'Không chọn được mục không dành cho trẻ em.');
    await clickVisibleText(page, [
      'Hiện chế độ cài đặt nâng cao', 'Hiện thêm',
      'Show advanced settings', 'Show more',
    ], { exact: false });
    await fillTags(page, tags, config);

    await waitNextEnabled(page, config);
    await waitNextEnabled(page, config);
    await waitNextEnabled(page, config);
    await chooseVisibility(page, visibility, config);

    await options.interactionPacer?.beforePublish();
    const publishClicked = await clickFinalPublish(page);
    if (!publishClicked) throw codedError('YOUTUBE_PUBLISH_BUTTON_NOT_FOUND', 'Không tìm thấy nút Xuất bản YouTube.');
    const confirmedImmediately = await confirmPublishWhileChecksPending(page);
    const publishResult = await waitPublishedResult(page, config, confirmedImmediately);
    const postLink = publishResult.postLink;
    return {
      success: true,
      postedAt: new Date().toLocaleString('vi-VN'),
      publishedAtMs: Date.now(),
      postLink,
      linkPending: publishResult.publishedWhileChecking && !postLink,
    };
  },

  async comment() {
    throw codedError('YOUTUBE_COMMENT_NOT_CONFIGURED', 'Script YouTube bình luận chưa được cấu hình.');
  },

  async hasExistingComment() {
    return false;
  },

  async validateSession(page) {
    const cookies = await page.cookies(
      'https://www.youtube.com',
      'https://studio.youtube.com',
      'https://accounts.google.com'
    ).catch(() => []);
    const loginCookies = new Set([
      'SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID',
      'SID', '__Secure-1PSID', '__Secure-3PSID',
    ]);
    return cookies.some(cookie => loginCookies.has(cookie.name) && cookie.value);
  },

  _private: {
    normalizeText,
    switchChannel,
    replaceContentEditable,
    chooseVisibility,
    selectPlaylist,
    confirmPublishWhileChecksPending,
    waitPublishedResult,
    readPublishedLink,
    hasPublishedConfirmation,
    clickVisibleText,
    getConfig,
  },
};

module.exports = YouTubeAdapter;
