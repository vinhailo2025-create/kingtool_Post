const path = require('path');
const { resolveMediaPath } = require('../services/media-path.utils');
const {
  inputCaptionText,
  normalizeCaptionInputMode,
} = require('./caption-input.utils');

const MANAGER_URL = 'https://video.zalo.me/creator/video?tab=tong-quat&type=public';
const VIDEO_PATTERN = /\.(?:mp4|mov)$/i;

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

function mapValue(map, key, render) {
  const value = map && map[key];
  return render
    ? render(`{{${key}}}`, map)
    : String(value == null ? '' : value);
}

function getConfig(options = {}) {
  const timeout = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    navigationTimeout: timeout(options.navigationTimeout, 90000),
    editorTimeout: timeout(options.editorTimeout, 180000),
    uploadTimeout: timeout(options.uploadTimeout, 600000),
    publishTimeout: timeout(options.publishTimeout, 300000),
    captionInputMode: normalizeCaptionInputMode(options.captionInputMode),
    captionTypingDelayMs: Number.isFinite(Number(options.captionTypingDelayMs))
      ? Math.max(0, Number(options.captionTypingDelayMs))
      : 30,
  };
}

async function delay(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout, message, code = 'ZALO_VIDEO_TIMEOUT') {
  const started = Date.now();
  while (timeout === 0 || Date.now() - started < timeout) {
    if (await predicate()) return true;
    await delay(350);
  }
  throw codedError(code, message);
}

async function navigate(page, url, timeout) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    if (!/video\.zalo\.me/i.test(page.url())) throw error;
  }
}

async function readVideoList(page) {
  return page.evaluate(async () => {
    try {
      const response = await fetch('/v2/public-api/video/list', { credentials: 'include' });
      const payload = await response.json();
      return {
        ok: response.ok && payload?.error === 0,
        error: payload?.error,
        message: payload?.msg || '',
        videos: Array.isArray(payload?.data?.videos) ? payload.data.videos : [],
      };
    } catch (error) {
      return { ok: false, error: -1, message: error.message, videos: [] };
    }
  }).catch(() => ({ ok: false, error: -1, message: '', videos: [] }));
}

async function clickUploadEntry(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(rect && rect.width > 1 && rect.height > 1
        && style.display !== 'none' && style.visibility !== 'hidden');
    };
    const candidates = [...document.querySelectorAll('button')]
      .filter(element => visible(element) && element.innerText.trim() === 'Đăng video')
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .sort((left, right) => left.rect.left - right.rect.left);
    const target = candidates.find(item => item.rect.left < 260) || candidates[0];
    if (!target) return false;
    target.element.click();
    return true;
  });
}

async function replaceCaption(page, caption, timeout, options = {}) {
  const selector = '[contenteditable="true"][maxlength="4000"].input-conteneditable';
  const editor = await page.waitForSelector(selector, { timeout });
  await editor.evaluate(element => {
    element.focus();
    element.textContent = '';
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'deleteContentBackward',
    }));
  });
  if (caption) await inputCaptionText(page, editor, caption, options);
  let inserted = await editor.evaluate((element, expected) =>
    element.innerText === expected, caption).catch(() => false);
  if (!inserted) {
    inserted = await editor.evaluate((element, expected) => {
      element.focus();
      element.textContent = expected;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: expected,
      }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return element.innerText === expected;
    }, caption).catch(() => false);
  }
  await editor.evaluate(element => {
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.blur();
  }).catch(() => {});
  if (!inserted) {
    throw codedError('ZALO_VIDEO_CAPTION_FAILED', 'Không nhập được nội dung Zalo Video.');
  }
}

async function selectPlaylist(page, playlist, timeout) {
  if (!playlist) return false;
  const opened = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')]
      .find(element => element.innerText.trim() === 'Thêm'
        && element.parentElement?.innerText?.includes('Thêm vào danh sách phát'));
    if (!button) return false;
    button.click();
    return true;
  });
  if (!opened) {
    throw codedError('ZALO_VIDEO_PLAYLIST_BUTTON_MISSING', 'Không tìm thấy mục thêm vào danh sách phát Zalo Video.');
  }

  const target = normalizeText(playlist);
  let selected = false;
  await waitFor(async () => {
    selected = await page.evaluate(targetText => {
      const norm = value => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      const popover = [...document.querySelectorAll('.ant-popover')]
        .find(element => element.offsetWidth || element.offsetHeight);
      const item = [...(popover?.querySelectorAll('*') || [])]
        .filter(element => element.children.length === 0)
        .find(element => norm(element.textContent) === targetText);
      if (!item) return false;
      item.click();
      return true;
    }, target);
    return selected;
  }, timeout, `Không tìm thấy danh sách phát Zalo Video "${playlist}".`,
  'ZALO_VIDEO_PLAYLIST_NOT_FOUND');
  return selected;
}

async function setAiLabel(page, enabled) {
  const state = await page.evaluate(wanted => {
    const toggle = [...document.querySelectorAll('button[role="switch"]')]
      .find(element => element.parentElement?.innerText?.includes('Nội dung do AI tạo'));
    if (!toggle) return { found: false, checked: false };
    const checked = toggle.getAttribute('aria-checked') === 'true';
    if (checked !== wanted) toggle.click();
    return { found: true, checked: wanted };
  }, Boolean(enabled));
  if (enabled && !state.found) {
    throw codedError('ZALO_VIDEO_AI_LABEL_MISSING', 'Không tìm thấy công tắc Nội dung do AI tạo.');
  }
  return state.checked;
}

async function clickFinalPublish(page) {
  return page.evaluate(() => {
    const visible = element => {
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return Boolean(rect && rect.width > 1 && rect.height > 1
        && style.display !== 'none' && style.visibility !== 'hidden');
    };
    const candidates = [...document.querySelectorAll('button')]
      .filter(element => visible(element) && element.innerText.trim() === 'Đăng video')
      .map(element => ({ element, rect: element.getBoundingClientRect() }))
      .sort((left, right) => right.rect.left - left.rect.left);
    const target = candidates.find(item => item.rect.left >= 260);
    if (!target || target.element.disabled) return false;
    target.element.click();
    return true;
  });
}

async function waitForPublishedVideo(page, baselineIds, caption, startedAt, timeout) {
  let lastVideo = null;
  await waitFor(async () => {
    const result = await readVideoList(page);
    if (!result.ok) return false;
    const candidates = result.videos
      .filter(video => !baselineIds.has(String(video.id)))
      .filter(video => Number(video.createdTime || 0) >= startedAt - 30000)
      .sort((left, right) => Number(right.createdTime || 0) - Number(left.createdTime || 0));
    lastVideo = candidates.find(video =>
      !caption || String(video.description || '').trim() === caption
    ) || candidates[0] || null;
    return Boolean(lastVideo && Number(lastVideo.status) === 2);
  }, timeout, 'Zalo Video chưa báo đăng thành công trong thời gian chờ.',
  'ZALO_VIDEO_PUBLISH_TIMEOUT');
  return lastVideo;
}

function videoIdFromLink(value) {
  const match = String(value || '').match(/video\.zalo\.me\/video\/(\d+)/i);
  return match ? match[1] : '';
}

function shortIdFromLink(value) {
  const match = String(value || '').match(/zalo\.video\/s\/([a-z0-9_-]+)/i);
  return match ? match[1] : '';
}

async function resolveVideoId(page, postLink) {
  const direct = videoIdFromLink(postLink);
  if (direct) return direct;
  const shortId = shortIdFromLink(postLink);
  if (!shortId) return '';
  const list = await readVideoList(page);
  return String(list.videos.find(video => video.shortId === shortId)?.id || '');
}

async function openVideoCommentModal(page, videoId, timeout) {
  const open = async () => page.evaluate(id => {
    const row = document.querySelector(`tr[data-row-key="${CSS.escape(id)}"]`);
    const thumbnail = row?.querySelector('td:first-child .cursor-pointer');
    if (!thumbnail) return false;
    thumbnail.click();
    return true;
  }, videoId);

  if (!await open()) {
    await navigate(page, MANAGER_URL, timeout);
    await page.waitForSelector('tr[data-row-key]', { timeout });
    if (!await open()) {
      throw codedError('ZALO_VIDEO_ROW_NOT_FOUND', `Không tìm thấy Zalo Video ID ${videoId} trong bảng quản lý.`);
    }
  }

  await waitFor(() => page.evaluate(() => {
    const modal = [...document.querySelectorAll('.ant-modal,[role="dialog"]')]
      .find(element => element.offsetWidth || element.offsetHeight);
    return Boolean(modal?.querySelector('input.ant-input[type="text"]'));
  }), timeout, 'Không mở được ô bình luận Zalo Video.',
  'ZALO_VIDEO_COMMENT_MODAL_TIMEOUT');
}

async function fillCommentInput(page, commentText) {
  return page.evaluate(value => {
    const modal = [...document.querySelectorAll('.ant-modal,[role="dialog"]')]
      .find(element => element.offsetWidth || element.offsetHeight);
    const input = modal?.querySelector('input.ant-input[type="text"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(input, value);
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value,
    }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return input.value === value;
  }, commentText);
}

const ZaloVideoAdapter = {
  async publish(page, post, options = {}) {
    if (!page) throw codedError('ZALO_VIDEO_PAGE_MISSING', 'Không có tab trình duyệt Zalo Video.');
    const config = getConfig(options);
    const map = options.buildVarMap
      ? options.buildVarMap(post)
      : { ...post, media: post?.media ?? post?.image_path ?? '' };
    const render = options.renderTemplate || ((template, values) =>
      String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
        (_, key) => values[key] == null ? '' : String(values[key])));
    const caption = mapValue(map, 'content', render).trim();
    const playlist = mapValue(map, 'playlist', render).trim();
    const mediaRaw = mapValue(map, 'media', render).trim();

    if (caption.length > 4000) {
      throw codedError('ZALO_VIDEO_CAPTION_TOO_LONG', 'Nội dung Zalo Video vượt quá 4000 ký tự.');
    }
    if (!mediaRaw || !VIDEO_PATTERN.test(mediaRaw)) {
      throw codedError('ZALO_VIDEO_MEDIA_REQUIRED', 'Cột Media cần video .mp4 hoặc .mov.');
    }
    const media = resolveMediaPath(mediaRaw);
    if (!media) {
      throw codedError('ZALO_VIDEO_MEDIA_NOT_FOUND', `Không tìm thấy video Zalo: ${mediaRaw}`);
    }

    await navigate(page, MANAGER_URL, config.navigationTimeout);
    if (!await this.validateSession(page)) {
      throw codedError('ZALO_VIDEO_SESSION_INVALID', 'Profile Zalo Video chưa đăng nhập hoặc phiên đã hết hạn.');
    }
    const baseline = await readVideoList(page);
    const baselineIds = new Set(baseline.videos.map(video => String(video.id)));
    const startedAt = Date.now();

    let uploadClicked = false;
    await waitFor(async () => {
      uploadClicked = await clickUploadEntry(page);
      return uploadClicked;
    }, config.editorTimeout, 'Không tìm thấy nút Đăng video Zalo.',
    'ZALO_VIDEO_UPLOAD_BUTTON_MISSING');
    const input = await page.waitForSelector(
      'input[name="file"][type="file"][accept*="video/mp4"]',
      { timeout: config.editorTimeout }
    );
    await input.uploadFile(path.resolve(media));
    await options.interactionPacer?.afterMedia();

    await replaceCaption(page, caption, config.uploadTimeout, config);
    if (playlist) await selectPlaylist(page, playlist, config.editorTimeout);
    await setAiLabel(page, Boolean(options.addAiLabel));
    await options.interactionPacer?.beforePublish();

    if (!await clickFinalPublish(page)) {
      throw codedError('ZALO_VIDEO_PUBLISH_BUTTON_MISSING', 'Không tìm thấy nút Đăng video cuối cùng.');
    }
    const video = await waitForPublishedVideo(
      page,
      baselineIds,
      caption,
      startedAt,
      config.publishTimeout
    );
    const postLink = `https://video.zalo.me/video/${video.id}`;
    return {
      success: true,
      postedAt: new Date(Number(video.publishedTime || video.createdTime) || Date.now())
        .toLocaleString('vi-VN'),
      publishedAtMs: Number(video.publishedTime || video.createdTime) || Date.now(),
      postLink,
      videoId: String(video.id),
      shortId: String(video.shortId || ''),
    };
  },

  async comment(page, postLink, commentText = '', mediaPath = '', options = {}) {
    const text = String(commentText || '').trim();
    if (!text && !mediaPath) {
      throw codedError('ZALO_VIDEO_COMMENT_EMPTY', 'Bình luận Zalo Video đang trống.');
    }
    if (mediaPath) {
      throw codedError(
        'ZALO_VIDEO_COMMENT_MEDIA_UNSUPPORTED',
        'Zalo Video hiện chỉ hỗ trợ bình luận bằng nội dung chữ.'
      );
    }
    const config = getConfig(options);
    await navigate(page, MANAGER_URL, config.navigationTimeout);
    const videoId = await resolveVideoId(page, postLink);
    if (!videoId) {
      throw codedError('ZALO_VIDEO_LINK_INVALID', 'Link Zalo Video không chứa video ID hợp lệ.');
    }
    await openVideoCommentModal(page, videoId, config.editorTimeout);
    if (!await fillCommentInput(page, text)) {
      throw codedError('ZALO_VIDEO_COMMENT_INPUT_FAILED', 'Không nhập được bình luận Zalo Video.');
    }
    await delay(250);
    const clicked = await page.evaluate(() => {
      const modal = [...document.querySelectorAll('.ant-modal,[role="dialog"]')]
        .find(element => element.offsetWidth || element.offsetHeight);
      const send = [...(modal?.querySelectorAll('*') || [])]
        .find(element => element.children.length === 0 && element.textContent.trim() === 'Gửi');
      if (!send) return false;
      send.click();
      return true;
    });
    if (!clicked) {
      throw codedError('ZALO_VIDEO_COMMENT_SEND_MISSING', 'Không tìm thấy nút Gửi bình luận Zalo Video.');
    }
    await waitFor(() => page.evaluate(expected => {
      const modal = [...document.querySelectorAll('.ant-modal,[role="dialog"]')]
        .find(element => element.offsetWidth || element.offsetHeight);
      const input = modal?.querySelector('input.ant-input[type="text"]');
      return Boolean(modal?.innerText.includes(expected) && input?.value === '');
    }, text), config.editorTimeout, 'Zalo Video chưa xác nhận gửi bình luận.',
    'ZALO_VIDEO_COMMENT_VERIFY_TIMEOUT');
    return true;
  },

  async hasExistingComment(page, postLink, commentText = '', mediaPath = '') {
    const text = String(commentText || '').trim();
    if (!text || mediaPath) return false;
    const config = getConfig({});
    await navigate(page, MANAGER_URL, config.navigationTimeout);
    const videoId = await resolveVideoId(page, postLink);
    if (!videoId) return false;
    await openVideoCommentModal(page, videoId, config.editorTimeout);
    return page.evaluate(expected => {
      const modal = [...document.querySelectorAll('.ant-modal,[role="dialog"]')]
        .find(element => element.offsetWidth || element.offsetHeight);
      return Boolean(modal?.innerText.includes(expected));
    }, text);
  },

  async validateSession(page) {
    if (!/video\.zalo\.me/i.test(page.url())) {
      await navigate(page, MANAGER_URL, 90000);
    }
    const result = await readVideoList(page);
    if (result.ok) return true;
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    return /Quản lý nội dung|Đăng video/i.test(text) && !/Đăng nhập|Login/i.test(text);
  },

  _private: {
    normalizeText,
    getConfig,
    readVideoList,
    clickUploadEntry,
    replaceCaption,
    selectPlaylist,
    setAiLabel,
    clickFinalPublish,
    waitForPublishedVideo,
    videoIdFromLink,
    shortIdFromLink,
    resolveVideoId,
    openVideoCommentModal,
    fillCommentInput,
  },
};

module.exports = ZaloVideoAdapter;
