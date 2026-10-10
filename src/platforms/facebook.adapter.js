/**
 * Facebook-only browser automation.
 *
 * Queueing, profile lifecycle, persistence and logging remain in the shared
 * runner. This file owns every Facebook selector and page interaction.
 */
const fs = require('fs');
const { resolveMediaPath } = require('../services/media-path.utils');
const path = require('path');

const GROUP_APPROVAL_PLACEHOLDER = 'Bài đăng chờ duyệt';
const FACEBOOK_VIDEO_LIMIT = 10;
const FACEBOOK_TIMELINE_LIMIT = 5;
const FACEBOOK_VIDEO_RE = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i;
const FACEBOOK_IMAGE_RE = /\.(?:jpe?g|png|webp|gif|bmp|heic|heif)$/i;
let lastGroupPublishAt = 0;

function normalizeFacebookCaption(value, limit = 0) {
  const normalized = String(value || '')
    .normalize('NFC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limit > 0 ? normalized.slice(0, limit).trim() : normalized;
}

function publishedTimeMatches(
  timestamps,
  expectedMs,
  toleranceMs = 2 * 60 * 60 * 1000,
  allowAfter = false
) {
  const expected = Number(expectedMs) || 0;
  if (!expected) return true;
  return timestamps.some(value => {
    const timestamp = Number(value) || 0;
    if (!timestamp) return false;
    if (allowAfter) {
      // Moderated Group posts can become visible hours after they were submitted.
      return timestamp >= expected - toleranceMs && timestamp <= Date.now() + 60 * 60 * 1000;
    }
    return Math.abs(timestamp - expected) <= toleranceMs;
  });
}

function extractFacebookEntityId(html, pageHref) {
  let expectedVanity = '';
  try {
    const url = new URL(pageHref);
    const segments = url.pathname.split('/').filter(Boolean);
    if (/^profile\.php$/i.test(segments[0] || '')) {
      return /^\d+$/.test(url.searchParams.get('id') || '') ? url.searchParams.get('id') : '';
    }
    if (/^(people|pages)$/i.test(segments[0] || '') && /^\d+$/.test(segments.at(-1) || '')) {
      return segments.at(-1);
    }
    if (/^\d+$/.test(segments[0] || '')) return segments[0];
    expectedVanity = decodeURIComponent(segments[0] || '').toLowerCase();
  } catch (_) {}
  if (!expectedVanity) return '';

  const source = String(html || '').replace(/&quot;/gi, '"').replace(/\\\//g, '/');
  const patterns = [
    /"userID":"(\d+)"[\s\S]{0,500}?"userVanity":"([^"]+)"/gi,
    /"userVanity":"([^"]+)"[\s\S]{0,500}?"userID":"(\d+)"/gi,
  ];
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
    let match;
    while ((match = patterns[patternIndex].exec(source))) {
      const id = patternIndex === 0 ? match[1] : match[2];
      const vanity = patternIndex === 0 ? match[2] : match[1];
      if (String(vanity).toLowerCase() === expectedVanity) return id;
    }
  }
  return '';
}

function facebookVideoKey(value, options = {}) {
  try {
    const url = new URL(String(value || ''), 'https://www.facebook.com');
    const host = url.hostname.toLowerCase().replace(/^(?:www|m|mbasic|touch|web)\./, '');
    if (host !== 'facebook.com') return '';
    const segments = url.pathname.split('/').filter(Boolean).map(segment =>
      decodeURIComponent(segment)
    );
    const lower = segments.map(segment => segment.toLowerCase());
    const queryId = url.searchParams.get('v') || url.searchParams.get('video_id');
    if (queryId) return `video:${queryId}`;

    for (const marker of ['reel', 'videos']) {
      const index = lower.indexOf(marker);
      if (index >= 0 && segments[index + 1]) return `video:${segments[index + 1]}`;
    }
    const shareIndex = lower.indexOf('share');
    if (shareIndex >= 0 && lower[shareIndex + 1] === 'r' && segments[shareIndex + 2]) {
      return `share:${segments[shareIndex + 2]}`;
    }
    if (options.allowGroupPosts === true) {
      const groupIndex = lower.indexOf('groups');
      const postIndex = lower.indexOf('posts');
      if (
        groupIndex >= 0 && segments[groupIndex + 1]
        && postIndex > groupIndex && segments[postIndex + 1]
      ) {
        return `group-post:${segments[groupIndex + 1]}:${segments[postIndex + 1]}`;
      }
    }
    return '';
  } catch (_) {
    return '';
  }
}

function sameVideoKeys(left, right) {
  const a = [...new Set((left || []).filter(Boolean))].sort();
  const b = [...new Set((right || []).filter(Boolean))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeEditorText(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function normalizeEditorTextForComparison(value) {
  return normalizeEditorText(value)
    .replace(/[\u00ad\u2060\ufe00-\ufe0f]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function editorCaptionMatches(expected, actual) {
  return normalizeEditorTextForComparison(actual)
    === normalizeEditorTextForComparison(expected);
}

function describeCaptionMismatch(expected, actual) {
  const expectedText = normalizeEditorText(expected);
  const actualText = normalizeEditorText(actual);
  const comparableExpected = normalizeEditorTextForComparison(expectedText);
  const comparableActual = normalizeEditorTextForComparison(actualText);
  const maxLength = Math.max(comparableExpected.length, comparableActual.length);
  let firstDifference = -1;
  for (let index = 0; index < maxLength; index++) {
    if (comparableExpected[index] !== comparableActual[index]) {
      firstDifference = index;
      break;
    }
  }
  return [
    `expected=${expectedText.length} chars/${expectedText ? expectedText.split('\n').length : 0} lines`,
    `actual=${actualText.length} chars/${actualText ? actualText.split('\n').length : 0} lines`,
    `first_diff=${firstDifference}`,
  ].join(', ');
}

async function readEditorText(editor) {
  return editor.evaluate(element =>
    String(element.innerText || element.textContent || '')
  ).catch(() => '');
}

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForEditorPrefix(editor, prefix, timeoutMs = 600) {
  const startedAt = Date.now();
  do {
    const actual = normalizeEditorText(await readEditorText(editor));
    if (actual.startsWith(prefix)) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await sleepMs(100);
  } while (true);
}

// Puppeteer khong co keyboard.insertText; sendCharacter (CDP Input.insertText) la
// duong chinh. Lexical hay nuot ky tu dau tien ngay sau khi focus/xoa noi dung
// (editor dang dung lai placeholder), nen gui ky tu dau rieng, xac nhan da vao
// roi moi gui phan con lai.
async function insertEditorText(page, editor, text) {
  const value = String(text || '');
  if (!value) return;
  const insert = typeof page.keyboard.insertText === 'function'
    ? chunk => page.keyboard.insertText(chunk)
    : chunk => page.keyboard.sendCharacter(chunk);
  const chars = [...value];
  const first = chars[0];
  const rest = chars.slice(1).join('');
  const expectedFirst = normalizeEditorText(first);
  if (!expectedFirst) {
    await insert(value);
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    await insert(first);
    if (await waitForEditorPrefix(editor, expectedFirst)) break;
    await editor.evaluate(element => element.focus()).catch(() => {});
    await sleepMs(250);
  }
  if (rest) await insert(rest);
}

async function waitForEditorCaption(editor, content, timeoutMs = 2500) {
  const startedAt = Date.now();
  let actual = '';
  do {
    actual = normalizeEditorText(await readEditorText(editor));
    if (editorCaptionMatches(content, actual)) {
      return { matched: true, actual };
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  return { matched: false, actual };
}

async function clearEditorText(page, editor) {
  await editor.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  let remaining = normalizeEditorText(await readEditorText(editor));
  if (!remaining) return;

  await editor.evaluate(element => {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);
    if (String(element.innerText || element.textContent || '').trim()) {
      element.textContent = '';
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'deleteContentBackward',
      }));
    }
  });
  remaining = normalizeEditorText(await readEditorText(editor));
  if (remaining) throw new Error('Facebook không xóa được nội dung cũ trong ô soạn bài.');
}

async function replaceFacebookEditorText(page, initialEditor, content, options = {}) {
  const expected = normalizeEditorText(content);
  if (!expected) return '';

  // Facebook bien tu cuoi cung thanh the tag/mention neu con dang o trang thai goi y.
  // Them 1 khoang trang cuoi bai de "chot" tu cuoi -> khong bi tao the tag.
  // Buoc verify dung normalizeEditorText/.trim() nen space nay khong lam sai lech.
  if (content != null && !/\s$/.test(String(content))) {
    content = `${content} `;
  }

  const resolveEditor = typeof options.resolveEditor === 'function'
    ? options.resolveEditor
    : async () => initialEditor;
  const verificationTimeoutMs = Math.max(
    500,
    Number(options.verificationTimeoutMs) || 2500
  );
  let editor = initialEditor;
  let lastActual = '';
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    editor = await resolveEditor().catch(() => null) || editor;
    if (!editor) break;
    try {
      await clearEditorText(page, editor);
      // Sau khi xoa, Lexical dung lai editor; doi mot nhip va focus lai truoc khi go.
      await editor.evaluate(element => element.focus()).catch(() => {});
      await sleepMs(300);
      const insertChunk = typeof page.keyboard.insertText === 'function'
        ? chunk => page.keyboard.insertText(chunk)
        : chunk => page.keyboard.sendCharacter(chunk);
      if (attempt === 0) {
        await insertEditorText(page, editor, content);
      } else if (
        attempt === 1
        && expected.includes('\n')
        && typeof page.keyboard.press === 'function'
      ) {
        // Composer Group (Lexical) nuot het ky tu xuong dong khi chen nguyen khoi
        // (33 dong -> 1 dong, cac tu dinh vao nhau). Chen tung dong va bam Enter.
        const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (lines[index]) {
            if (index === 0) await insertEditorText(page, editor, lines[index]);
            else await insertChunk(lines[index]);
          }
          if (index < lines.length - 1) await page.keyboard.press('Enter');
        }
      } else if (attempt === 1 && typeof page.keyboard.sendCharacter === 'function') {
        await insertEditorText(page, editor, content);
      } else {
        await editor.evaluate((element, value) => {
          element.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
          const inserted = document.execCommand('insertText', false, value);
          if (!inserted) {
            element.textContent = value;
            element.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              data: value,
              inputType: 'insertText',
            }));
          }
        }, content);
      }
      const verification = await waitForEditorCaption(
        editor,
        content,
        verificationTimeoutMs
      );
      lastActual = verification.actual;
      if (verification.matched) return verification.actual;
    } catch (error) {
      lastError = error;
    }
  }

  const detail = describeCaptionMismatch(expected, lastActual);
  const error = new Error(
    `Facebook nhận caption không chính xác; tool đã dừng trước khi đăng. [${detail}]`
  );
  error.code = 'FACEBOOK_CONTENT_MISMATCH';
  error.details = {
    expectedLength: expected.length,
    actualLength: lastActual.length,
    diagnostic: detail,
    cause: lastError ? lastError.message : '',
  };
  throw error;
}

class FacebookAutomation {
  constructor(options = {}) {
    this.buildVarMap = options.buildVarMap || (post => ({
      ...post,
      media: post?.media ?? post?.image_path ?? '',
    }));
    this.renderTemplate = options.renderTemplate || ((template, values) => String(template || '').replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_, key) => values[key] == null ? '' : String(values[key])
    ));
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : ms => new Promise(resolve => setTimeout(resolve, ms));
    this._commentVerificationTimeoutMs = options.commentVerificationTimeoutMs;
    this._commentUploadTimeoutMs = options.commentUploadTimeoutMs;
    this._commentLinkPreviewTimeoutMs = options.commentLinkPreviewTimeoutMs;
    this._profileComposerTimeoutMs = Math.max(
      1000,
      Number(options.profileComposerTimeoutMs) || 120000
    );
    this._videoActionTimeoutMs = Math.max(
      1000,
      Number(options.videoActionTimeoutMs) || 180000
    );
    this.addAiLabel = options.addAiLabel === true || options.addAiLabel === '1';
    // Phông nền màu cho bài chỉ chữ: { mode: 'none'|'random'|'fixed', index: 1..8 }
    const bg = options.textBackground || {};
    this.textBackground = {
      mode: ['random', 'fixed'].includes(String(bg.mode)) ? String(bg.mode) : 'none',
      index: Math.min(8, Math.max(1, parseInt(bg.index, 10) || 1)),
    };
    this.interactionPacer = options.interactionPacer || null;
  }

  _log(profileName, message, type = 'info') {
    this.log(message, type, profileName);
  }

  resolvePublishTarget(post) {
    const vmap = this.buildVarMap(post);
    const content = this.renderTemplate('{{content}}', vmap);
    const mediaRaw = this.renderTemplate('{{media}}', vmap);
    const fanpageRaw = this.renderTemplate('{{link_fanpage}}', vmap).trim();
    const groupRaw = this.renderTemplate('{{post_group}}', vmap).trim();
    const fanpageHref = fanpageRaw ? this.normalizeFacebookTargetUrl(fanpageRaw) : '';
    const groupHref = groupRaw ? this.normalizeFacebookGroupUrl(groupRaw) : '';
    if (fanpageRaw && !fanpageHref) {
      const error = new Error('Link Fanpage khong hop le. Hay dung link facebook.com cua Fanpage');
      error.code = 'FACEBOOK_FANPAGE_URL_INVALID';
      throw error;
    }
    if (groupRaw && !groupHref) {
      const error = new Error('Post_group khong hop le. Hay dung URL facebook.com/groups/...');
      error.code = 'FACEBOOK_GROUP_URL_INVALID';
      throw error;
    }
    return {
      targetType: groupHref ? 'group' : (fanpageHref ? 'fanpage' : 'profile'),
      content,
      mediaRaw,
      fanpageHref,
      groupHref,
    };
  }

  _resolveMediaPaths(mediaRaw, options = {}) {
    const separator = options.splitNewlines === false ? ',' : /[\n,]+/;
    return String(mediaRaw || '').split(separator)
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => resolveMediaPath(value))
      .filter(Boolean);
  }

  _hasVideo(mediaPaths) {
    return (mediaPaths || []).some(file => FACEBOOK_VIDEO_RE.test(String(file || '')));
  }

  facebookVideoLibraryUrl(targetType, targetUrl, owner = null) {
    if (String(targetType || '').toLowerCase() === 'group') {
      const group = this.normalizeFacebookGroupUrl(targetUrl);
      return group ? `${group}/media/videos` : '';
    }

    const own = owner || {};
    const normalized = this.normalizeFacebookTargetUrl(targetUrl);
    if (!normalized) return '';
    try {
      const url = new URL(normalized);
      const segments = url.pathname.split('/').filter(Boolean);
      if (/^profile\.php$/i.test(segments[0] || '')) {
        const id = url.searchParams.get('id') || own.id;
        return id
          ? `https://www.facebook.com/profile.php?id=${encodeURIComponent(String(id))}&sk=reels_tab`
          : '';
      }
      if (own.vanity) {
        return `https://www.facebook.com/${encodeURIComponent(String(own.vanity))}/reels/`;
      }
      return `${normalized.replace(/\/$/, '')}/reels/`;
    } catch (_) {
      return '';
    }
  }

  async scanFacebookVideoSnapshot(page, libraryUrl, limit = FACEBOOK_VIDEO_LIMIT) {
    const normalizedLimit = Math.max(1, Math.min(FACEBOOK_VIDEO_LIMIT, Number(limit) || FACEBOOK_VIDEO_LIMIT));
    const allowGroupPosts = /\/groups\/[^/]+\/media\/videos/i.test(String(libraryUrl || ''));
    if (!libraryUrl) return { ready: false, libraryUrl: '', items: [] };

    try {
      await this._gotoFacebookPage(page, libraryUrl, 60000);
      await this._sleep(3000);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this._sleep(700);
    } catch (_) {
      return { ready: false, libraryUrl, items: [] };
    }

    const collected = new Map();
    for (let round = 0; round < 5 && collected.size < normalizedLimit; round++) {
      const raw = await page.evaluate(() => {
        const root = document.querySelector('[role="main"]') || document;
        return Array.from(root.querySelectorAll('a[href]')).map((anchor, index) => {
          const rect = anchor.getBoundingClientRect();
          const style = getComputedStyle(anchor);
          return {
            href: anchor.href,
            index,
            top: Math.round(rect.top + window.scrollY),
            left: Math.round(rect.left),
            visible: rect.width > 0 && rect.height > 0
              && style.display !== 'none' && style.visibility !== 'hidden',
          };
        }).filter(item => item.visible)
      }).catch(() => []);

      for (const candidate of raw) {
        const key = facebookVideoKey(candidate.href, { allowGroupPosts });
        if (!key) continue;
        const url = this.normalizeFacebookPostUrl(candidate.href);
        if (!url) continue;
        const previous = collected.get(key);
        if (
          !previous
          || candidate.top < previous.top
          || (candidate.top === previous.top && candidate.left < previous.left)
        ) {
          collected.set(key, {
            key,
            url,
            top: candidate.top,
            left: candidate.left,
            index: candidate.index,
          });
        }
      }
      if (collected.size >= normalizedLimit) break;
      await page.evaluate(() => window.scrollBy(0, Math.max(900, window.innerHeight)))
        .catch(() => {});
      await this._sleep(1000);
    }

    const ready = await page.evaluate((expectedUrl) => {
      const host = location.hostname.replace(/^(?:www|m|mbasic|touch|web)\./, '');
      const body = String(document.body?.innerText || '').trim();
      if (host !== 'facebook.com' || !document.body || !body) return false;
      try {
        const expected = new URL(expectedUrl);
        const current = new URL(location.href);
        const expectedSegments = expected.pathname.split('/').filter(Boolean)
          .map(segment => decodeURIComponent(segment).toLowerCase());
        const currentSegments = current.pathname.split('/').filter(Boolean)
          .map(segment => decodeURIComponent(segment).toLowerCase());
        if (expectedSegments[0] === 'groups') {
          return currentSegments[0] === 'groups'
            && currentSegments[1] === expectedSegments[1]
            && currentSegments.includes('media')
            && currentSegments.includes('videos');
        }
        if (expectedSegments[0] === 'profile.php') {
          return currentSegments[0] === 'profile.php'
            && current.searchParams.get('id') === expected.searchParams.get('id')
            && current.searchParams.get('sk') === 'reels_tab';
        }
        return currentSegments[0] === expectedSegments[0]
          && currentSegments.includes('reels');
      } catch (_) {
        return false;
      }
    }, libraryUrl).catch(() => false);
    const items = [...collected.values()]
      .sort((left, right) =>
        (left.top - right.top) || (left.left - right.left) || (left.index - right.index)
      )
      .slice(0, normalizedLimit)
      .map(({ key, url }) => ({ key, url }));
    return { ready, libraryUrl, items };
  }

  async captureStableFacebookVideoSnapshot(page, libraryUrl, limit = FACEBOOK_VIDEO_LIMIT) {
    const first = await this.scanFacebookVideoSnapshot(page, libraryUrl, limit);
    if (!first.ready) return first;
    const second = await this.scanFacebookVideoSnapshot(page, libraryUrl, limit);
    return {
      ...second,
      ready: second.ready && sameVideoKeys(
        first.items.map(item => item.key),
        second.items.map(item => item.key)
      ),
    };
  }

  async captureNewFacebookVideoLink(
    page,
    libraryUrl,
    beforeSnapshot,
    { limit = FACEBOOK_VIDEO_LIMIT, attempts = 8 } = {}
  ) {
    const before = beforeSnapshot || {};
    if (before.ready !== true || !Array.isArray(before.items)) return '';
    const beforeKeys = new Set(before.items.map(item => item && item.key).filter(Boolean));
    let repeatedKey = '';
    let repeatCount = 0;

    for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 1); attempt++) {
      if (this.shouldStop) break;
      const after = await this.scanFacebookVideoSnapshot(page, libraryUrl, limit);
      const added = after.ready
        ? after.items.filter(item => item && item.key && !beforeKeys.has(item.key))
        : [];
      if (added.length === 1) {
        const candidate = added[0];
        if (candidate.key === repeatedKey) {
          repeatCount += 1;
        } else {
          repeatedKey = candidate.key;
          repeatCount = 1;
        }
        if (repeatCount >= 2) return candidate.url;
      } else {
        repeatedKey = '';
        repeatCount = 0;
      }
      if (attempt + 1 < attempts) await this._sleep(4000 + attempt * 1000);
    }
    return '';
  }

  async _withRestoredProfileIdentity(page, action) {
    await this._leavePageIdentity(page);
    try {
      return await action();
    } finally {
      await this._leavePageIdentity(page);
    }
  }

  async publish(page, post) {
    if (!page) throw new Error('Khong co tab trinh duyet');
    const target = this.resolvePublishTarget(post);
    return this._withRestoredProfileIdentity(page, async () => {
      if (target.targetType === 'group') {
        return this._publishGroup(page, target);
      }
      return this._publishTimeline(page, post);
    });
  }

  async _getTimelineComposer(page) {
    return page.evaluateHandle(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 200 && rect.height > 150
          && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const withEditor = dialogs.find(dialog =>
        dialog.querySelector('div[contenteditable="true"], [role="textbox"]')
      );
      if (withEditor) return withEditor;
      return dialogs.find(dialog => {
        const text = norm(
          `${dialog.getAttribute('aria-label') || ''} ${(dialog.innerText || '').slice(0, 120)}`
        );
        return text.includes('tao bai viet') || text.includes('create post');
      }) || null;
    }).then(handle =>
      (handle && handle.asElement ? handle.asElement() : null)
    ).catch(() => null);
  }

  async _findTimelineComposerButton(page) {
    return page.evaluateHandle(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 70 && rect.height > 20
          && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labels = [
        ['ban viet gi di', 5],
        ['ban dang nghi gi', 5],
        ["what's on your mind", 5],
        ['what do you want to talk about', 5],
        ['tao bai viet cong khai', 4],
        ['create a public post', 4],
        ['tao bai viet', 3],
        ['create post', 3],
        ['chia se suy nghi', 2],
        ['share your thoughts', 2],
        ['viet gi do', 1],
        ['write something', 1],
      ];
      let best = null;
      let bestScore = -1;
      for (const element of document.querySelectorAll(
        '[role="button"], button, div[tabindex], [contenteditable="true"]'
      )) {
        if (!visible(element)) continue;
        const text = norm(
          `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`
        );
        const match = labels.find(([label]) => text.includes(label));
        if (!match) continue;
        const rect = element.getBoundingClientRect();
        const score = match[1] * 1e7 + rect.width * rect.height;
        if (score > bestScore) {
          best = element;
          bestScore = score;
        }
      }
      return best;
    }).then(handle =>
      (handle && handle.asElement ? handle.asElement() : null)
    ).catch(() => null);
  }

  async _openTimelineComposer(page) {
    const startedAt = Date.now();
    const deadline = startedAt + this._profileComposerTimeoutMs;
    let nextClickAt = 0;
    let nextLogAt = startedAt;

    while (Date.now() < deadline) {
      if (typeof page.isClosed === 'function' && page.isClosed()) {
        throw new Error('Tab Facebook da bi dong khi dang cho o soan bai');
      }

      const modal = await this._getTimelineComposer(page);
      if (modal) return modal;

      const now = Date.now();
      if (now >= nextClickAt) {
        const button = await this._findTimelineComposerButton(page);
        if (button) {
          await page.keyboard.press('Escape').catch(() => {});
          await this._sleep(400);
          await button.evaluate(element =>
            element.scrollIntoView({ block: 'center' })
          ).catch(() => {});
          await this._sleep(400);
          await button.click().catch(() => {});
          await button.dispose().catch(() => {});
          nextClickAt = Date.now() + 8000;
        }
      }

      if (now >= nextLogAt) {
        const elapsed = Math.max(1, Math.round((now - startedAt) / 1000));
        this._log(null, `Dang cho Facebook tai o Tao bai viet (${elapsed}s)...`, 'info');
        nextLogAt = now + 10000;
      }
      await this._sleep(1000);
    }

    try {
      const debug = await page.evaluate(() => {
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 30 && rect.height > 30
            && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return {
          url: location.href,
          title: document.title,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          dialogCount: document.querySelectorAll('[role="dialog"]').length,
          visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]'))
            .filter(visible)
            .map(dialog => (dialog.innerText || '').replace(/\s+/g, ' ').slice(0, 120)),
          body: (document.body.innerText || '').slice(0, 1600),
        };
      });
      fs.writeFileSync(
        path.join(__dirname, '..', '..', 'composer-debug.json'),
        JSON.stringify(debug, null, 2)
      );
    } catch (_) {}

    const error = new Error(
      `B5: Facebook khong hien o Tao bai viet sau ${Math.round(this._profileComposerTimeoutMs / 1000)} giay`
    );
    error.code = 'FACEBOOK_COMPOSER_TIMEOUT';
    throw error;
  }

  async _waitForTimelineEditor(page, initialModal = null) {
    const startedAt = Date.now();
    const deadline = startedAt + this._profileComposerTimeoutMs;
    let modal = initialModal;
    let nextLogAt = startedAt + 10000;

    while (Date.now() < deadline) {
      modal = await this._getTimelineComposer(page) || modal;
      if (modal) {
        const editable = await modal.evaluateHandle(root => {
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 80 && rect.height > 20
              && style.visibility !== 'hidden' && style.display !== 'none';
          };
          return Array.from(root.querySelectorAll(
            'div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'
          )).find(visible) || null;
        }).then(handle =>
          (handle && handle.asElement ? handle.asElement() : null)
        ).catch(() => null);
        if (editable) return { modal, editable };
      }

      const now = Date.now();
      if (now >= nextLogAt) {
        const elapsed = Math.max(1, Math.round((now - startedAt) / 1000));
        this._log(null, `Dang cho Facebook tai o nhap noi dung (${elapsed}s)...`, 'info');
        nextLogAt = now + 10000;
      }
      await this._sleep(1000);
    }

    const error = new Error(
      `B5: Facebook khong hien o nhap noi dung sau ${Math.round(this._profileComposerTimeoutMs / 1000)} giay`
    );
    error.code = 'FACEBOOK_EDITOR_TIMEOUT';
    throw error;
  }

  async _publishTimeline(page, post) {
    if (!page) throw new Error('Khong co tab trinh duyet');

    const XP_TIMEOUT = 30000;
    const vmap = this.buildVarMap(post);
    const content = this.renderTemplate('{{content}}', vmap);
    const mediaRaw = this.renderTemplate('{{media}}', vmap);
    const mediaPaths = this._resolveMediaPaths(mediaRaw, { splitNewlines: false });
    const hasVideo = this._hasVideo(mediaPaths);
    const thumbRaw = this.renderTemplate('{{thumbnail}}', vmap).trim();
    const thumbnailPath = thumbRaw ? resolveMediaPath(thumbRaw) : '';
    const fanpageRaw = this.renderTemplate('{{link_fanpage}}', vmap).trim();
    const fanpageHref = fanpageRaw ? this.normalizeFacebookTargetUrl(fanpageRaw) : '';
    if (fanpageRaw && !fanpageHref) {
      const error = new Error('Link Fanpage khong hop le. Hay dung link facebook.com cua Fanpage');
      error.code = 'FACEBOOK_FANPAGE_URL_INVALID';
      throw error;
    }
    const humanDelay = (min = 900, max = 2600) => this._sleep(Math.floor(Math.random() * (max - min + 1)) + min);

    await this._gotoFacebookPage(page, 'https://www.facebook.com/', 60000);
    await humanDelay(2500, 4500);

    // Kiem tra dang nhap bang cookie c_user - tin hieu dang tin cay nhat. Tranh false-positive cua cach
    // do chu "login/dang nhap" trong body (trang da dang nhap van co the chua cac tu nay o menu/footer).
    const getCUser = async () => ((await page.cookies('https://www.facebook.com').catch(() => [])).find(x => x.name === 'c_user') || {}).value;
    let cUser = await getCUser();
    if (!cUser) {
      // Man hinh "Chao mung tro lai / chon tai khoan": FB nho tai khoan nhung chua kich hoat phien
      // (chua co c_user) cho toi khi bam "Tiep tuc/Continue". Mo tay thi nguoi dung bam -> vao binh thuong;
      // tool phai tu bam nut nay thi moi co session. Thu toi 3 lan.
      for (let attempt = 0; attempt < 3 && !cUser; attempt++) {
        const contBtn = await page.evaluateHandle(() => {
          const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
          const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 30 && r.height > 15 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const nodes = Array.from(document.querySelectorAll('[role="button"], button, a, div[tabindex]')).filter(vis);
          return nodes.find(e => { const t = norm(e.innerText || ''); return t === 'continue' || t === 'tiep tuc'; })
            || nodes.find(e => { const t = norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')); return t.includes('continue') || t.includes('tiep tuc'); })
            || null;
        }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
        if (!contBtn) break;
        await humanDelay();
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          contBtn.click().catch(() => {}),
        ]);
        await humanDelay(2500, 4500);
        cUser = await getCUser();
      }
    }
    if (!cUser) {
      // Van chua co c_user -> that su chua dang nhap (man hinh nhap mat khau/tao tai khoan).
      const error = new Error('Facebook chua vao session dang nhap (can dang nhap lai profile)');
      error.code = 'FACEBOOK_NOT_LOGGED_IN';
      throw error;
    }

    if (!fanpageHref) {
      await this._leavePageIdentity(page);
    }

    let profileHref = fanpageHref
      || (cUser ? `https://www.facebook.com/profile.php?id=${cUser}` : await this.getFacebookTimelineHref(page));
    if (!profileHref) throw new Error('B2: Khong lay duoc link timeline profile');

    let owner = await this.getProfileOwner(page, profileHref, { includeSessionId: !fanpageHref });
    if (fanpageHref) {
      this._log(null, `Dang chuyen den Fanpage: ${profileHref}`, 'info');
      await this._activateNumericPageIdentity(page, profileHref);
    }

    // Bat buoc vao dung trang profile cua cookie c_user truoc khi crawl va dang bai; khong lay link tu feed/home.
    await this._gotoFacebookPage(page, profileHref, 60000);
    await humanDelay(3500, 6000);
    let pageIdentityId = '';
    if (fanpageHref) {
      const identity = await this._verifyOrRecoverPageIdentity(page, profileHref);
      pageIdentityId = String((identity && identity.iUser) || '');
      profileHref = this.normalizeFacebookTargetUrl(page.url()) || profileHref;
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this.prepareTimelineForScan(page);
    owner = this._mergeOwner(owner, await this._readOwnerFromPage(page));
    // Voi Fanpage, id doc tu HTML ("userID") co the la id user ca nhan chu khong
    // phai id Page -> _isOwnPostUrl se loai oan link permalink.php?...&id=<pageId>.
    // Cookie i_user da xac minh moi la id Page dung.
    if (pageIdentityId) owner.id = pageIdentityId;
    if (owner.vanity) profileHref = `https://www.facebook.com/${owner.vanity}`;
    // Chup 5 bai dau timeline (hover timestamp de lay permalink) truoc khi dang;
    // sau khi dang chup lai va bai nao chua co trong anh chup nay la bai vua dang.
    const timelineBefore = hasVideo
      ? []
      : await this.scanTimelineTopPosts(page, profileHref, FACEBOOK_TIMELINE_LIMIT);
    if (!hasVideo) {
      this._log(null, `Đã chụp ${timelineBefore.length} bài đầu timeline trước khi đăng.`, 'info');
    }
    const beforeLinks = new Set(timelineBefore.flatMap(item => item.keys));
    const videoLibraryUrl = hasVideo
      ? this.facebookVideoLibraryUrl(fanpageHref ? 'fanpage' : 'profile', profileHref, owner)
      : '';
    const videoBeforeSnapshot = hasVideo
      ? await this.captureStableFacebookVideoSnapshot(
        page,
        videoLibraryUrl,
        FACEBOOK_VIDEO_LIMIT
      )
      : null;
    if (hasVideo && videoBeforeSnapshot?.ready !== true) {
      this._log(null, 'Chưa chụp ổn định được 10 video trước khi đăng; link sẽ được tìm lại an toàn sau.', 'warning');
    }

    // Vao lai dung trang profile desktop de dang bai.
    await this._gotoFacebookPage(page, profileHref, 60000);
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(800, 1500);

    const getModal = () => this._getTimelineComposer(page);
    let modal = await this._openTimelineComposer(page);
    await humanDelay(1500, 2500);

    let editable;
    ({ modal, editable } = await this._waitForTimelineEditor(page, modal));
    await editable.click();
    if (content && content.trim()) {
      await replaceFacebookEditorText(page, editable, content);
      await humanDelay(1200, 2200);
      const readComposerState = async (modalHandle, editorHandle) => {
        const entered = await editorHandle.evaluate(
          element => (element.textContent || element.innerText || '').trim()
        ).catch(() => '');
        const nextEnabled = await modalHandle.evaluate(root => {
          const norm = value => String(value || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
            .toLowerCase().trim();
          return Array.from(root.querySelectorAll('[role="button"], button')).some(element => {
            const values = [element.innerText, element.getAttribute('aria-label')].map(norm);
            return element.getAttribute('aria-disabled') !== 'true'
              && values.some(value => value === 'tiep' || value === 'next');
          });
        }).catch(() => false);
        return { entered, nextEnabled };
      };

      let composerState = await readComposerState(modal, editable);
      if (!composerState.entered && !composerState.nextEnabled) {
        modal = await getModal();
        if (modal) {
          editable = await modal.evaluateHandle(root => {
            const visible = element => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 80 && rect.height > 20
                && style.visibility !== 'hidden' && style.display !== 'none';
            };
            return Array.from(root.querySelectorAll(
              'div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'
            )).find(visible) || null;
          }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
        }
        if (editable && modal) {
          await editable.evaluate(element => element.focus()).catch(() => {});
          await page.keyboard.sendCharacter(content);
          await this._sleep(800);
          composerState = await readComposerState(modal, editable);
        }
      }
      if (!composerState.entered && !composerState.nextEnabled) {
        throw new Error('B5: Facebook chua nhan noi dung bai viet');
      }
    }

    // Dinh media (neu co). Uu tien input[type=file] co san trong modal (giong Group);
    // neu chua co thi bam nut Anh/video va nhan bo chon file, hoac dung input
    // Facebook tao ra sau khi bam (co luc Facebook khong mo bo chon file -> truoc day
    // treo 30s roi loi "Waiting for FileChooser").
    if (mediaPaths.length > 0) {
      let input = await this._findGroupMediaInput(page, modal);
      if (input && typeof input.uploadFile === 'function') {
        await input.uploadFile(...mediaPaths);
      } else {
        const chooserPromise = page.waitForFileChooser({ timeout: 10000 }).catch(() => null);
        const mediaBtn = await modal.evaluateHandle(root => {
          const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
          return Array.from(root.querySelectorAll('[role="button"], [aria-label]')).find(e => {
            const text = norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || ''));
            return text.includes('anh/video') || text.includes('photo/video');
          }) || null;
        }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
        if (!mediaBtn) throw new Error('B6: Khong thay nut Anh/video');
        await humanDelay();
        await mediaBtn.click();
        const fileChooser = await chooserPromise;
        if (fileChooser) {
          await fileChooser.accept(mediaPaths);
        } else {
          input = await this._findGroupMediaInput(page, await getModal() || modal);
          if (!input || typeof input.uploadFile !== 'function') {
            const error = new Error('B6: Facebook khong mo bo chon file va khong tao input tai media');
            error.code = 'FACEBOOK_MEDIA_INPUT_NOT_FOUND';
            throw error;
          }
          await input.uploadFile(...mediaPaths);
        }
      }
      modal = await getModal() || modal;
      await this.interactionPacer?.afterMedia();
      await this._sleep(4000 + mediaPaths.length * 2500);
      await humanDelay(1200, 2500);
    }

    // Bai chi chu: chon phong nen mau neu cau hinh bat. Luong co media giu nguyen.
    if (mediaPaths.length === 0 && content && content.trim()) {
      modal = await this._applyTextBackgroundIfNeeded(page, modal) || modal;
    }

    await this._configureAiLabelIfNeeded(page, modal, mediaPaths.length > 0);

    // Chi di vao man thumbnail khi Facebook hien nut Tiep. Neu composer da hien
    // nut Dang thi phai dang truc tiep vi giao dien nay khong ho tro thumbnail.
    if (hasVideo && thumbRaw) {
      const thumbnailResult = await this._prepareTimelineVideoThumbnail(
        page,
        modal,
        thumbnailPath,
        thumbRaw
      );
      modal = thumbnailResult.modal || await getModal() || modal;
    }

    // Bam nut Dang (khop chinh xac de tranh nham "Dang tai..."). Xu ly buoc "Tiep" neu co.
    // Xac nhan thanh cong bang cach modal "Tao bai viet" bien mat.
    let posted = false;
    let publishStartedAtMs = 0;
    let waitForComposerAfterAuxiliary = 0;
    let auxiliarySeen = false;
    for (let step = 0; step < 20 && !posted; step++) {
      const dismissLater = await page.evaluateHandle(() => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 20 && rect.height > 10
            && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
        return dialogs.flatMap(dialog => Array.from(dialog.querySelectorAll('[role="button"], button')))
          .filter(visible)
          .find(button => ['luc khac', 'not now', 'maybe later'].includes(
            norm(button.innerText || button.getAttribute('aria-label'))
          )) || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (dismissLater) {
        await dismissLater.click().catch(() => {});
        await this._sleep(2000);
        continue;
      }

      const auxiliaryPrompt = await page.evaluate(() => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 200 && rect.height > 100
            && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).some(dialog => {
          const text = norm(dialog.innerText);
          return text.includes('nhap so dien thoai') || text.includes('enter phone number');
        });
      }).catch(() => false);
      if (auxiliaryPrompt) {
        await page.keyboard.press('Escape').catch(() => {});
        waitForComposerAfterAuxiliary = 5;
        auxiliarySeen = true;
        await this._sleep(1500);
        continue;
      }

      const cur = await getModal();
      if (!cur) {
        if (waitForComposerAfterAuxiliary > 0) {
          waitForComposerAfterAuxiliary--;
          await this._sleep(1000);
          continue;
        }
        if (auxiliarySeen) throw new Error('B7: Fanpage yeu cau bo sung so dien thoai truoc khi dang');
        posted = true;
        break;
      }
      waitForComposerAfterAuxiliary = 0;
      auxiliarySeen = false;
      const clickButton = await cur.evaluateHandle(root => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
        const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 20 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const enabled = e => e.getAttribute('aria-disabled') !== 'true' && !e.matches('[disabled]');
        const parts = e => [norm(e.getAttribute('aria-label') || ''), norm(e.innerText || '')].filter(Boolean);
        const isSubmit = e => parts(e).some(p => p === 'dang' || p === 'post' || p === 'dang bai' || p === 'dang bai viet');
        const isNext = e => parts(e).some(p => p === 'tiep' || p === 'tiep tuc' || p === 'next');
        const nodes = Array.from(root.querySelectorAll('[role="button"], button')).filter(visible);
        let pick = nodes.find(e => enabled(e) && isSubmit(e));
        let kind = 'dang';
        if (!pick) { pick = nodes.find(e => enabled(e) && isNext(e)); kind = 'tiep'; }
        if (!pick) return null;
        pick.dataset.covergemSubmitKind = kind;
        return pick;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (clickButton) {
        const clickKind = await clickButton.evaluate(element => element.dataset.covergemSubmitKind || 'dang')
          .catch(() => 'dang');
        await humanDelay();
        // Can nut Dang/Tiep trong khung modal nhung GIU nguyen vi tri cuon cua trang nen.
        // scrollIntoView mac dinh cuon ca document goc -> feed bi day xuong cuoi va tai them
        // ("Qua trinh nay mat nhieu thoi gian hon du kien"). Modal la overlay co dinh nen
        // khoi phuc window.scrollTo khong lam nut bi an.
        await clickButton.evaluate(element => {
          const x = window.scrollX;
          const y = window.scrollY;
          element.scrollIntoView({ block: 'center' });
          window.scrollTo(x, y);
        }).catch(() => {});
        if (clickKind === 'dang') {
          await this.interactionPacer?.beforePublish();
          if (!publishStartedAtMs) publishStartedAtMs = Date.now();
        }
        await clickButton.click().catch(() => {});
        await humanDelay(2000, 3500);
        if (clickKind === 'dang') {
          // cho modal dong (toi 8s)
          for (let w = 0; w < 8; w++) { const m = await getModal(); if (!m) { posted = true; break; } await this._sleep(1000); }
        }
      } else {
        await this._sleep(1500);
      }
    }
    if (!posted) {
      try {
        const debug = await page.evaluate(() => {
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 20 && rect.height > 10
              && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
          return {
            url: location.href,
            dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).map(dialog => ({
              text: clean(dialog.innerText).slice(0, 1000),
              buttons: Array.from(dialog.querySelectorAll('[role="button"], button')).filter(visible).map(button => ({
                text: clean(button.innerText),
                aria: clean(button.getAttribute('aria-label')),
                disabled: button.getAttribute('aria-disabled'),
              })).filter(button => button.text || button.aria),
            })),
          };
        });
        fs.writeFileSync(path.join(__dirname, '..', '..', 'submit-debug.json'), JSON.stringify(debug, null, 2));
      } catch (_) {}
      throw new Error('B7: Khong tim thay/khong bam duoc nut Dang');
    }

    const publishedAtMs = hasVideo ? (publishStartedAtMs || Date.now()) : Date.now();
    const postedAt = new Date(publishedAtMs).toLocaleString('vi-VN');
    let postLink = '';
    if (hasVideo) {
      this._log(null, 'Đang so sánh 10 video trước/sau khi đăng...', 'info');
      postLink = await this.captureNewFacebookVideoLink(
        page,
        videoLibraryUrl,
        videoBeforeSnapshot,
        { limit: FACEBOOK_VIDEO_LIMIT, attempts: 8 }
      );
      if (postLink) this._log(null, `Đã lấy được link video mới: ${postLink}`, 'success');
    } else {
      postLink = await this.capturePostLinkFromConfirmation(page, beforeLinks, owner);
      if (!postLink) await this._sleep(8000);
      // Cách chính cho text/ảnh: so sánh 5 bài đầu timeline trước/sau khi đăng.
      if (!postLink) {
        this._log(null, `Đang so sánh ${FACEBOOK_TIMELINE_LIMIT} bài đầu timeline trước/sau khi đăng...`, 'info');
        postLink = await this.captureNewTimelineTopPostLink(
          page,
          profileHref,
          timelineBefore,
          content,
          { limit: FACEBOOK_TIMELINE_LIMIT, attempts: 6, owner }
        );
        if (postLink) this._log(null, `Đã lấy được link bài mới: ${postLink}`, 'success');
      }
      if (!postLink) postLink = await this.capturePostLinkByHover(page, profileHref, content, owner, beforeLinks);
      if (!postLink) postLink = await this.captureNewTopOwnPostLink(page, profileHref, beforeLinks, owner, 3);
      if (!postLink) postLink = await this.captureNewTimelinePostLink(page, profileHref, beforeLinks, content, owner);
      if (!postLink && fanpageHref) {
        postLink = await this.capturePublicFanpagePostLink(page, profileHref, content, owner);
      }
    }

    return {
      success: true,
      publishedAccepted: true,
      postedAt,
      publishedAtMs,
      postLink,
      profileHref,
      targetType: fanpageHref ? 'fanpage' : 'profile',
      linkPending: hasVideo && !postLink,
      postContent: content,
      hasVideo,
      videoLibraryUrl,
      videoBeforeSnapshot,
    };
  }

  _groupDelayBounds(prefix, fallbackMin, fallbackMax) {
    const min = Math.max(0, Number(process.env[`${prefix}_MIN_MS`]) || fallbackMin);
    const max = Math.max(min, Number(process.env[`${prefix}_MAX_MS`]) || fallbackMax);
    return { min, max };
  }

  async _groupPause() {
    const { min, max } = this._groupDelayBounds('FB_GROUP_ACTION_DELAY', 2500, 5500);
    await this._sleep(Math.floor(Math.random() * (max - min + 1)) + min);
  }

  async _waitForGroupCooldown() {
    if (!lastGroupPublishAt) return;
    const { min, max } = this._groupDelayBounds('FB_GROUP_COOLDOWN', 60000, 120000);
    const target = Math.floor(Math.random() * (max - min + 1)) + min;
    const remaining = Math.max(0, target - (Date.now() - lastGroupPublishAt));
    if (remaining) {
      this._log(null, `Cho ${Math.ceil(remaining / 1000)}s truoc thao tac Group tiep theo...`, 'info');
      await this._sleep(remaining);
    }
  }

  async _assertFacebookSession(page, { navigate = true } = {}) {
    if (navigate) await this._gotoFacebookPage(page, 'https://www.facebook.com/', 60000);
    const cookies = await page.cookies('https://www.facebook.com').catch(() => []);
    const cUser = String((cookies.find(cookie => cookie.name === 'c_user') || {}).value || '');
    if (!cUser) {
      const error = new Error('Facebook chua vao session dang nhap (thieu cookie c_user)');
      error.code = 'FACEBOOK_NOT_LOGGED_IN';
      throw error;
    }
    const blocked = await page.evaluate(() => {
      const text = String(document.body?.innerText || '').toLowerCase();
      return /checkpoint|security check|xac minh danh tinh|kiểm tra bảo mật/.test(
        `${location.href} ${text.slice(0, 5000)}`
      );
    }).catch(() => false);
    if (blocked) {
      const error = new Error('Facebook dang o checkpoint/kiem tra bao mat');
      error.code = 'FACEBOOK_CHECKPOINT';
      throw error;
    }
    return cUser;
  }

  async _prepareGroupIdentity(page, fanpageHref) {
    await this._leavePageIdentity(page);
    const cUser = await this._assertFacebookSession(page);
    if (!fanpageHref) return { type: 'profile', cUser, pageId: '' };

    await this._activateNumericPageIdentity(page, fanpageHref);
    await this._gotoFacebookPage(page, fanpageHref, 60000);
    const verified = await this._verifyOrRecoverPageIdentity(page, fanpageHref);
    return { type: 'fanpage', cUser, pageId: verified.iUser };
  }

  _startGroupGraphqlCapture(page, groupHref, content) {
    const records = [];
    const pending = new Set();
    const groupKey = decodeURIComponent(new URL(groupHref).pathname.split('/').filter(Boolean)[1]);
    const normalize = value => String(value || '').replace(/\\u[\da-f]{4}/gi, match => {
      try { return String.fromCharCode(parseInt(match.slice(2), 16)); } catch (_) { return match; }
    }).replace(/\\\//g, '/').replace(/\s+/g, ' ').trim();
    const captionNeedle = normalize(content).slice(0, 120);
    const handler = response => {
      const work = (async () => {
        const request = response.request();
        const requestUrl = String(request.url ? request.url() : '');
        if (!/graphql/i.test(requestUrl)) return;
        const rawRequest = String(request.postData ? request.postData() || '' : '');
        let requestText = rawRequest;
        try { requestText = decodeURIComponent(rawRequest.replace(/\+/g, ' ')); } catch (_) {}
        requestText = normalize(requestText);
        if (captionNeedle && !requestText.includes(captionNeedle)) return;
        if (!requestText.includes(groupKey)) return;
        const responseText = normalize(await response.text().catch(() => ''));
        const regex = /\/groups\/([^/"?\\]+)\/posts\/([^/"?\\]+)/gi;
        let match;
        while ((match = regex.exec(responseText))) {
          const postUrl = this.normalizeFacebookGroupPostUrl(match[0], groupHref);
          if (postUrl) {
            records.push({
              postUrl,
              requestCaptionVerified: true,
              source: 'graphql-create-request+group+caption-verified',
            });
          }
        }
      })();
      pending.add(work);
      work.finally(() => pending.delete(work));
    };
    if (typeof page.on === 'function') page.on('response', handler);
    return {
      records,
      flush: async () => Promise.allSettled([...pending]),
      stop: () => {
        if (typeof page.off === 'function') page.off('response', handler);
        else if (typeof page.removeListener === 'function') page.removeListener('response', handler);
      },
    };
  }

  async _getGroupComposer(page) {
    return page.evaluateHandle(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 200 && rect.height > 120
          && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const isComposer = dialog => {
        const label = norm(dialog.getAttribute('aria-label'));
        const text = norm(dialog.innerText || '').slice(0, 300);
        return label === 'tao bai viet' || label === 'create post'
          || text.startsWith('tao bai viet') || text.startsWith('create post');
      };
      return dialogs.find(dialog =>
        isComposer(dialog)
        && Boolean(dialog.querySelector('[contenteditable="true"], [role="textbox"]'))
      ) || dialogs.find(isComposer) || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
  }

  async _openGroupComposer(page) {
    let modal = await this._getGroupComposer(page);
    if (modal) return modal;
    const hasUnrelatedDialog = () => page.evaluate(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 100 && rect.height > 80
          && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).some(dialog => {
        const label = norm(dialog.getAttribute('aria-label'));
        const text = norm(dialog.innerText || '').slice(0, 200);
        return !['tao bai viet', 'create post'].includes(label)
          && !text.startsWith('tao bai viet')
          && !text.startsWith('create post');
      });
    }).catch(() => false);
    const findButton = () => page.evaluateHandle(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 70 && rect.height > 20
          && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const labels = [
        'ban viet gi di', 'ban dang nghi gi', 'what do you want to talk about',
        "what's on your mind", 'tao bai viet cong khai', 'create a public post',
        'viet gi do', 'write something',
      ];
      return Array.from(document.querySelectorAll(
        '[role="button"], button, div[tabindex], [contenteditable="true"]'
      )).filter(visible).find(element => {
        const text = norm(`${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`);
        return labels.some(label => text.includes(label));
      }) || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);

    for (let openAttempt = 0; openAttempt < 3; openAttempt++) {
      for (let overlayAttempt = 0; overlayAttempt < 4 && await hasUnrelatedDialog(); overlayAttempt++) {
        await page.keyboard.press('Escape').catch(() => {});
        await this._sleep(500);
      }
      const button = await findButton();
      if (!button) {
        await this._sleep(1000);
        continue;
      }
      await button.evaluate(element => element.scrollIntoView({ block: 'center' })).catch(() => {});
      await button.click().catch(() => {});
      for (let attempt = 0; attempt < 15; attempt++) {
        await this._sleep(500);
        modal = await this._getGroupComposer(page);
        if (modal) return modal;
      }
    }
    const error = new Error('Khong mo duoc composer cua Group');
    error.code = 'FACEBOOK_GROUP_COMPOSER_NOT_FOUND';
    throw error;
  }

  async _fillGroupComposer(page, modal, content) {
    let currentModal = modal;
    const resolveEditor = async () => {
      currentModal = await this._getGroupComposer(page) || currentModal;
      if (!currentModal) return null;
      return currentModal.evaluateHandle(root => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 80 && rect.height > 20
            && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const excluded = element => {
          const label = norm([
            element.getAttribute('aria-label'),
            element.getAttribute('data-placeholder-text'),
          ].filter(Boolean).join(' '));
          return /tim kiem|search|emoji|binh luan|comment/.test(label);
        };
        const candidates = Array.from(root.querySelectorAll(
          'div[contenteditable="true"][role="textbox"], [contenteditable="true"], [role="textbox"]'
        )).filter(element =>
          visible(element)
          && !excluded(element)
          && (element.isContentEditable || element.getAttribute('contenteditable') === 'true')
        );
        return candidates.sort((left, right) => {
          const score = element => {
            const rect = element.getBoundingClientRect();
            const label = norm([
              element.getAttribute('aria-label'),
              element.getAttribute('data-placeholder-text'),
            ].filter(Boolean).join(' '));
            let value = Math.min(rect.width * rect.height, 1000000);
            if (element.getAttribute('role') === 'textbox') value += 2000000;
            if (/ban viet gi|ban dang nghi gi|write something|what.s on your mind/.test(label)) {
              value += 4000000;
            }
            return value;
          };
          return score(right) - score(left);
        })[0] || null;
      }).then(handle =>
        handle && handle.asElement ? handle.asElement() : null
      ).catch(() => null);
    };
    let editor = await resolveEditor();
    for (let attempt = 0; attempt < 12 && !editor; attempt++) {
      editor = await resolveEditor();
      if (!editor) {
        currentModal = await this._getGroupComposer(page);
        await this._sleep(500);
      }
    }
    if (!editor) {
      const error = new Error('Khong tim thay o nhap noi dung Group');
      error.code = 'FACEBOOK_GROUP_COMPOSER_NOT_FOUND';
      throw error;
    }
    if (String(content || '').trim()) {
      await editor.click();
      await replaceFacebookEditorText(page, editor, content, {
        resolveEditor,
        verificationTimeoutMs: 3000,
      });
    }
  }

  async _attachGroupMedia(page, modal, mediaRaw) {
    const mediaPaths = this._resolveMediaPaths(mediaRaw);
    if (!mediaPaths.length) return { mediaPaths, hasVideo: false };
    let input = await this._findGroupMediaInput(page, modal);
    if (input && typeof input.uploadFile === 'function') {
      await input.uploadFile(...mediaPaths);
    } else {
      const chooserPromise = page.waitForFileChooser({ timeout: 10000 }).catch(() => null);
      const button = await modal.evaluateHandle(root => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase();
        return Array.from(root.querySelectorAll('[role="button"], [aria-label]')).find(element => {
          const text = norm(`${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`);
          return text.includes('anh/video') || text.includes('photo/video');
        }) || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (!button) {
        const error = new Error('Khong thay nut Anh/video trong composer Group');
        error.code = 'FACEBOOK_GROUP_MEDIA_BUTTON_NOT_FOUND';
        throw error;
      }
      await button.click();
      const fileChooser = await chooserPromise;
      if (fileChooser) {
        await fileChooser.accept(mediaPaths);
      } else {
        input = await this._findGroupMediaInput(page, await this._getGroupComposer(page) || modal);
        if (!input || typeof input.uploadFile !== 'function') {
          const error = new Error('Facebook khong mo bo chon file va khong tao input tai media Group');
          error.code = 'FACEBOOK_GROUP_MEDIA_INPUT_NOT_FOUND';
          throw error;
        }
        await input.uploadFile(...mediaPaths);
      }
    }

    for (let attempt = 0; attempt < 180; attempt++) {
      await this._sleep(1000);
      const state = await modal.evaluate(root => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().trim();
        const enabled = element => element.getAttribute('aria-disabled') !== 'true'
          && !element.matches('[disabled]');
        const buttons = Array.from(root.querySelectorAll('[role="button"], button'));
        const readyButton = buttons.some(element => enabled(element) && [
          'tiep', 'next', 'dang', 'post', 'dang bai', 'dang bai viet',
        ].includes(norm(element.innerText || element.getAttribute('aria-label'))));
        const processing = Boolean(root.querySelector('[role="progressbar"]'))
          || /dang xu ly|processing|dang tai len|uploading/.test(norm(root.innerText));
        return { readyButton, processing };
      }).catch(() => ({ readyButton: false, processing: true }));
      if (state.readyButton && !state.processing) {
        return {
          mediaPaths,
          hasVideo: this._hasVideo(mediaPaths),
        };
      }
    }
    const error = new Error('Facebook chua xu ly xong media Group sau 3 phut');
    error.code = 'FACEBOOK_GROUP_MEDIA_TIMEOUT';
    throw error;
  }

  async _findGroupMediaInput(page, modal) {
    const findInRoot = root => root.evaluateHandle(element => {
      const inputs = Array.from(element.querySelectorAll('input[type="file"]'));
      return inputs.find(input => /image|video/i.test(input.getAttribute('accept') || ''))
        || inputs[0]
        || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);

    let currentModal = modal;
    for (let attempt = 0; attempt < 24; attempt++) {
      let input = currentModal ? await findInRoot(currentModal) : null;
      if (input) return input;
      input = await page.evaluateHandle(() => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(dialog => {
          const label = norm(dialog.getAttribute('aria-label'));
          const text = norm(dialog.innerText || '').slice(0, 300);
          return label === 'tao bai viet' || label === 'create post'
            || text.startsWith('tao bai viet') || text.startsWith('create post');
        });
        const inputs = dialogs.flatMap(dialog => Array.from(dialog.querySelectorAll('input[type="file"]')));
        return inputs.find(candidate => /image|video/i.test(candidate.getAttribute('accept') || ''))
          || inputs.at(-1)
          || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (input) return input;
      await this._sleep(250);
      currentModal = await this._getGroupComposer(page) || currentModal;
    }
    return null;
  }

  async _submitGroupComposer(page) {
    let clickedPost = false;
    for (let step = 0; step < 24; step++) {
      const modal = await this._getGroupComposer(page);
      if (!modal) {
        if (clickedPost) return true;
        await this._sleep(500);
        continue;
      }
      const button = await modal.evaluateHandle(root => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 20 && rect.height > 10
            && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const enabled = element => element.getAttribute('aria-disabled') !== 'true'
          && !element.matches('[disabled]');
        const nodes = Array.from(root.querySelectorAll('[role="button"], button'))
          .filter(element => visible(element) && enabled(element));
        let picked = nodes.find(element => ['dang', 'post', 'dang bai', 'dang bai viet'].includes(
          norm(element.innerText || element.getAttribute('aria-label'))
        ));
        let kind = 'post';
        if (!picked) {
          picked = nodes.find(element => ['tiep', 'tiep tuc', 'next'].includes(
            norm(element.innerText || element.getAttribute('aria-label'))
          ));
          kind = 'next';
        }
        if (picked) picked.dataset.covergemGroupSubmit = kind;
        return picked || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (!button) {
        await this._sleep(1000);
        continue;
      }
      const kind = await button.evaluate(element => element.dataset.covergemGroupSubmit || 'post');
      if (kind === 'post') await this._groupPause();
      await button.click();
      clickedPost = clickedPost || kind === 'post';
      await this._sleep(kind === 'post' ? 1500 : 900);
    }
    const error = new Error('Facebook chua nhan thao tac Dang bai Group');
    error.code = 'FACEBOOK_GROUP_PUBLISH_NOT_ACCEPTED';
    throw error;
  }

  async _extractGroupPostLinks(page, groupHref) {
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map(anchor => anchor.href)).catch(() => []);
    return [...new Set(hrefs.map(href => this.normalizeFacebookGroupPostUrl(href, groupHref)).filter(Boolean))];
  }

  async _verifyGroupPostCandidate(page, candidate, groupHref, content) {
    const normalized = this.normalizeFacebookGroupPostUrl(candidate, groupHref);
    if (!normalized) return '';
    await this._gotoFacebookPage(page, normalized, 60000);
    await this._sleep(1200);
    const needle = normalizeFacebookCaption(content, 80);
    if (!needle) return normalized;
    const matches = await page.evaluate(expected => {
      const clean = value => String(value || '')
        .normalize('NFC')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return clean(document.body?.innerText || '').includes(expected);
    }, needle).catch(() => false);
    return matches ? normalized : '';
  }

  async _captureGroupConfirmationLink(page, groupHref, content) {
    // Gom ung vien truoc, xac minh sau. Moi lan _verifyGroupPostCandidate deu dieu huong
    // khoi trang; xac minh ngay trong vong lap se lam mat toast xac nhan va cac vong sau
    // se quet nham trang permalink vua mo.
    const collected = new Set();
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidates = await page.evaluate(() => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().trim();
        const roots = Array.from(document.querySelectorAll(
          '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]'
        ));
        const hrefs = roots.flatMap(root => Array.from(root.querySelectorAll('a[href]'))
          .map(anchor => anchor.href));
        const button = roots.flatMap(root => Array.from(root.querySelectorAll(
          '[role="button"], button, a'
        ))).find(element => ['xem bai viet', 'view post'].includes(
          norm(element.innerText || element.getAttribute('aria-label'))
        ));
        return { hrefs, hasViewButton: Boolean(button) };
      }).catch(() => ({ hrefs: [], hasViewButton: false }));
      for (const href of candidates.hrefs) {
        const normalized = this.normalizeFacebookGroupPostUrl(href, groupHref);
        if (normalized) collected.add(normalized);
      }
      if (candidates.hasViewButton) {
        const button = await page.evaluateHandle(() => {
          const norm = value => String(value || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
            .toLowerCase().trim();
          return Array.from(document.querySelectorAll(
            '[role="alert"] [role="button"], [role="status"] [role="button"], [aria-live] a'
          )).find(element => ['xem bai viet', 'view post'].includes(
            norm(element.innerText || element.getAttribute('aria-label'))
          )) || null;
        }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
        if (button) {
          // Bam "Xem bai viet" se dieu huong ngay -> lam mot lan roi thoat vong lap,
          // toast khong con de doc them nua.
          await button.click().catch(() => {});
          await this._sleep(1500);
          const opened = this.normalizeFacebookGroupPostUrl(page.url(), groupHref);
          if (opened) collected.add(opened);
          break;
        }
      }
      if (collected.size) break;
      await this._sleep(750);
    }
    for (const candidate of collected) {
      const verified = await this._verifyGroupPostCandidate(page, candidate, groupHref, content);
      if (verified) return verified;
    }
    return '';
  }

  async _findGroupPostInFeed(
    page,
    groupHref,
    content,
    beforeLinks = new Set(),
    { navigate = true } = {}
  ) {
    if (navigate) await this._gotoFacebookPage(page, groupHref, 60000);
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    const needle = normalizeFacebookCaption(content, 80);
    // _verifyGroupPostCandidate dieu huong sang permalink de doi chieu caption.
    // Phai quay lai dung trang danh sach (feed hoac ket qua tim kiem) truoc khi quet tiep,
    // neu khong cac vong sau se quet chinh trang permalink vua mo.
    const listUrl = page.url();
    let scrollY = 0;
    let movedAway = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (movedAway) {
        await this._gotoFacebookPage(page, listUrl, 60000);
        await this._sleep(1500);
        movedAway = false;
      }
      if (scrollY) {
        await page.evaluate(y => window.scrollTo(0, y), scrollY).catch(() => {});
        await this._sleep(1200);
      }
      const hrefs = await page.evaluate(expected => {
        const clean = value => String(value || '')
          .normalize('NFC')
          .replace(/[\u200b-\u200d\ufeff]/g, '')
          .toLowerCase()
          .replace(/[\p{P}\p{S}]+/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return Array.from(document.querySelectorAll('[role="article"]')).flatMap(article => {
          if (expected && !clean(article.innerText).includes(expected)) return [];
          return Array.from(article.querySelectorAll('a[href]')).map(anchor => anchor.href);
        });
      }, needle).catch(() => []);
      for (const href of hrefs) {
        const normalized = this.normalizeFacebookGroupPostUrl(href, groupHref);
        if (!normalized || before.has(normalized)) continue;
        movedAway = true;
        const verified = await this._verifyGroupPostCandidate(page, normalized, groupHref, content);
        if (verified) return verified;
      }
      if (movedAway) {
        scrollY += 700;
      } else {
        scrollY = await page.evaluate(() => {
          window.scrollBy(0, Math.max(700, window.innerHeight));
          return window.scrollY;
        }).catch(() => scrollY + 700);
        await this._sleep(1200);
      }
    }
    return '';
  }

  async findGroupPost(page, groupHref, content, options = {}) {
    const normalizedGroup = this.normalizeFacebookGroupUrl(groupHref);
    if (!normalizedGroup) return { postLink: '', permalinkVerified: false };
    if (options.hasVideo === true && options.videoBeforeSnapshot?.ready === true) {
      const libraryUrl = options.videoLibraryUrl
        || this.facebookVideoLibraryUrl('group', normalizedGroup);
      const videoLink = await this.captureNewFacebookVideoLink(
        page,
        libraryUrl,
        options.videoBeforeSnapshot,
        { limit: FACEBOOK_VIDEO_LIMIT, attempts: 3 }
      );
      return {
        postLink: videoLink,
        permalinkVerified: Boolean(videoLink),
        source: videoLink ? 'group-media-videos+before-after-10+stable' : '',
      };
    }
    let postLink = await this._findGroupPostInFeed(page, normalizedGroup, content);
    if (!postLink) {
      const query = encodeURIComponent(String(content || '').replace(/\s+/g, ' ').trim().slice(0, 80));
      await this._gotoFacebookPage(page, `${normalizedGroup}/search/?q=${query}`, 60000);
      postLink = await this._findGroupPostInFeed(
        page,
        normalizedGroup,
        content,
        new Set(),
        { navigate: false }
      );
    }
    if (postLink && options.publishedAtMs) {
      const verified = await this.verifyPublishedPostCandidate(
        page,
        postLink,
        content,
        options.publishedAtMs,
        { allowPublishedAfter: true }
      );
      if (!verified.matched) postLink = '';
    }
    return {
      postLink,
      permalinkVerified: Boolean(postLink),
      source: postLink ? 'group-feed-or-search+group+caption-verified' : '',
    };
  }

  async findTimelinePost(page, profileHref, content, options = {}) {
    let targetUrl = String(profileHref || '').trim() || 'https://www.facebook.com/me';
    await this._gotoFacebookPage(page, targetUrl, 60000);
    await this._sleep(2000);

    const resolved = await page.evaluate(() => {
      const canonical = document.querySelector('link[rel="canonical"]');
      const og = document.querySelector('meta[property="og:url"]');
      return (canonical && canonical.href) || (og && og.content) || location.href;
    }).catch(() => page.url());
    targetUrl = this.normalizeFacebookTargetUrl(resolved)
      || this.normalizeFacebookTargetUrl(targetUrl)
      || targetUrl;

    const targetType = String(options.targetType || 'profile').toLowerCase();
    let owner = await this.getProfileOwner(page, targetUrl, {
      includeSessionId: targetType === 'profile',
    });
    owner = this._mergeOwner(owner, await this._readOwnerFromPage(page));

    let postLink = '';
    let source = '';
    if (options.hasVideo === true && options.videoBeforeSnapshot?.ready === true) {
      const libraryUrl = options.videoLibraryUrl
        || this.facebookVideoLibraryUrl(targetType, targetUrl, owner);
      postLink = await this.captureNewFacebookVideoLink(
        page,
        libraryUrl,
        options.videoBeforeSnapshot,
        { limit: FACEBOOK_VIDEO_LIMIT, attempts: 3 }
      );
      return {
        postLink,
        permalinkVerified: Boolean(postLink),
        source: postLink ? 'reels-tab+before-after-10+stable' : '',
      };
    }
    const acceptCandidate = async candidate => {
      if (!candidate) return '';
      if (!options.publishedAtMs) return candidate;
      const verified = await this.verifyPublishedPostCandidate(
        page,
        candidate,
        content,
        options.publishedAtMs
      );
      return verified.matched ? (verified.postLink || candidate) : '';
    };
    if (options.hasVideo !== false) {
      postLink = await this.captureReelByCaption(
        page,
        targetUrl,
        content,
        owner,
        16,
        options.publishedAtMs
      );
      if (postLink) source = 'reels-or-videos-tab+caption-verified';
    }
    if (!postLink && targetType === 'fanpage') {
      postLink = await acceptCandidate(
        await this.capturePublicFanpagePostLink(page, targetUrl, content, owner)
      );
      if (postLink) source = 'public-fanpage+caption-verified';
    }
    if (!postLink && targetType !== 'group') {
      // Timeline ao hoa: cuon tung bai vao viewport, doc permalink, khop caption.
      postLink = await acceptCandidate(
        await this.captureNewTimelineTopPostLink(page, targetUrl, [], content, {
          limit: FACEBOOK_TIMELINE_LIMIT, attempts: 2, owner,
        })
      );
      if (postLink) source = 'timeline-top5+caption-verified';
    }
    if (!postLink) {
      postLink = await acceptCandidate(
        await this.capturePostLinkByHover(page, targetUrl, content, owner, new Set())
      );
      if (postLink) source = 'timeline-hover+caption-verified';
    }
    if (!postLink) {
      postLink = await acceptCandidate(
        await this.captureNewTimelinePostLink(
          page,
          targetUrl,
          new Set(),
          content,
          owner
        )
      );
      if (postLink) source = 'timeline-scan+caption-verified';
    }
    return {
      postLink,
      permalinkVerified: Boolean(postLink),
      source,
    };
  }

  async _publishGroup(page, target) {
    await this._waitForGroupCooldown();
    const expectedMediaPaths = this._resolveMediaPaths(target.mediaRaw);
    const expectedHasVideo = this._hasVideo(expectedMediaPaths);
    const videoLibraryUrl = expectedHasVideo
      ? this.facebookVideoLibraryUrl('group', target.groupHref)
      : '';
    const identity = await this._prepareGroupIdentity(page, target.fanpageHref);
    const tracker = this._startGroupGraphqlCapture(page, target.groupHref, target.content);
    try {
      await this._gotoFacebookPage(page, target.groupHref, 60000);
      await this._assertFacebookSession(page, { navigate: false });
      await this._groupPause();
      const beforeLinks = new Set(await this._extractGroupPostLinks(page, target.groupHref));
      const videoBeforeSnapshot = expectedHasVideo
        ? await this.captureStableFacebookVideoSnapshot(
          page,
          videoLibraryUrl,
          FACEBOOK_VIDEO_LIMIT
        )
        : null;
      if (expectedHasVideo) {
        await this._gotoFacebookPage(page, target.groupHref, 60000);
        await this._assertFacebookSession(page, { navigate: false });
        await this._groupPause();
      }
      let modal = await this._openGroupComposer(page);
      await this._groupPause();
      modal = await this._getGroupComposer(page) || modal;
      await this._fillGroupComposer(page, modal, target.content);
      modal = await this._getGroupComposer(page) || modal;
      const media = await this._attachGroupMedia(page, modal, target.mediaRaw);
      if (media.mediaPaths.length > 0) await this.interactionPacer?.afterMedia();
      modal = await this._getGroupComposer(page) || modal;
      await this._configureAiLabelIfNeeded(page, modal, media.mediaPaths.length > 0);
      await this.interactionPacer?.beforePublish();
      const publishStartedAtMs = Date.now();
      await this._submitGroupComposer(page);
      lastGroupPublishAt = Date.now();

      const publishedAtMs = media.hasVideo ? publishStartedAtMs : Date.now();
      const postedAt = new Date(publishedAtMs).toLocaleString('vi-VN');
      let postLink = '';
      let permalinkSource = '';

      if (media.hasVideo) {
        this._log(null, 'Đang so sánh 10 video Group trước/sau khi đăng...', 'info');
        postLink = await this.captureNewFacebookVideoLink(
          page,
          videoLibraryUrl,
          videoBeforeSnapshot,
          { limit: FACEBOOK_VIDEO_LIMIT, attempts: 8 }
        );
        if (postLink) {
          permalinkSource = 'group-media-videos+before-after-10+stable';
        }
      } else {
        postLink = await this._captureGroupConfirmationLink(
          page, target.groupHref, target.content
        );
        permalinkSource = postLink ? 'view-post+group+caption-verified' : '';

        await tracker.flush();
        if (!postLink) {
          const graphql = tracker.records.find(record => record.requestCaptionVerified);
          if (graphql) {
            postLink = graphql.postUrl;
            permalinkSource = graphql.source;
          }
        }
        if (!postLink) {
          postLink = await this._findGroupPostInFeed(
            page, target.groupHref, target.content, beforeLinks
          );
          if (postLink) permalinkSource = 'new-group-feed-card+group+caption-verified';
        }
        if (!postLink) {
          const recovered = await this.findGroupPost(page, target.groupHref, target.content);
          postLink = recovered.postLink;
          if (postLink) permalinkSource = recovered.source;
        }
      }

      const waitingApproval = !postLink;
      return {
        success: true,
        publishedAccepted: true,
        postedAt,
        publishedAtMs,
        postLink: postLink || GROUP_APPROVAL_PLACEHOLDER,
        realPostLink: postLink || '',
        waitingApproval,
        permalinkVerified: Boolean(postLink),
        permalinkSource,
        groupUrl: target.groupHref,
        postContent: target.content,
        identityType: identity.type,
        identityPageUrl: target.fanpageHref || '',
        targetType: 'group',
        hasVideo: media.hasVideo,
        linkPending: media.hasVideo && !postLink,
        videoLibraryUrl,
        videoBeforeSnapshot,
      };
    } finally {
      tracker.stop();
    }
  }

  // Facebook chi hien nut "Aa" (tuy chon phong nen) khi bai ngan va khong co media.
  // Bam "Aa" -> hang o mau, moi o co aria-label "<ten mau>, phong nen, phong nen N".
  async _applyTextBackgroundIfNeeded(page, modal) {
    const mode = this.textBackground?.mode || 'none';
    if (mode === 'none') return null;
    const humanDelay = (min = 700, max = 1500) => this._sleep(Math.floor(Math.random() * (max - min + 1)) + min);
    const getModal = () => this._getTimelineComposer(page);
    const findAaButton = async root => root.evaluateHandle(node => {
      const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u0111\u0110]/g, 'd').toLowerCase();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 10 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return Array.from(node.querySelectorAll('[role="button"]')).filter(visible).find(element => {
        const label = norm(element.getAttribute('aria-label'));
        if (/tuy chon phong nen|background options|phong nen/.test(label)) return true;
        const img = element.querySelector('img[src*="SATP_Aa"]');
        return !!img;
      }) || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);

    let root = modal || await getModal();
    if (!root) return null;
    let aaButton = null;
    for (let attempt = 0; attempt < 6 && !aaButton; attempt++) {
      aaButton = await findAaButton(root);
      if (!aaButton) {
        await this._sleep(700);
        root = await getModal() || root;
      }
    }
    if (!aaButton) {
      this._log(null, 'Facebook không hiện nút phông nền (bài quá dài hoặc giao diện khác); đăng bài chỉ chữ bình thường.', 'warning');
      return null;
    }
    await humanDelay();
    await aaButton.evaluate(element => element.scrollIntoView({ block: 'center' })).catch(() => {});
    await aaButton.click().catch(() => {});
    await humanDelay(1200, 2000);

    const readSwatches = async () => {
      const current = await getModal() || root;
      return current.evaluate(node => {
        const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[\u0111\u0110]/g, 'd').toLowerCase();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 10 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const items = Array.from(node.querySelectorAll('[role="button"][aria-current]')).filter(visible);
        return items.map((element, order) => {
          const label = norm(element.getAttribute('aria-label'));
          const match = label.match(/(?:phong nen|background)\s*(\d+)\s*$/);
          const painted = !!element.querySelector('[style*="background"]');
          element.dataset.covergemSwatchOrder = String(order);
          return { order, label, index: match ? Number(match[1]) : 0, painted };
        }).filter(item => item.painted && item.index > 0);
      }).catch(() => []);
    };

    let swatches = [];
    for (let attempt = 0; attempt < 6 && !swatches.length; attempt++) {
      swatches = await readSwatches();
      if (!swatches.length) await this._sleep(600);
    }
    if (!swatches.length) {
      this._log(null, 'Đã bấm nút phông nền nhưng không thấy hàng màu; bỏ qua phông nền.', 'warning');
      return await getModal();
    }

    // Che do ngau nhien: mo luoi "Chon phong nen" (nut luoi cuoi hang, aria-label
    // "Tuy chon phong nen") de co ~20 nen thay vi 8 o inline. Khong mo duoc thi dung hang inline.
    if (mode === 'random') {
      const gridButton = await (await getModal() || root).evaluateHandle(node => {
        const norm = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[đĐ]/g, 'd').toLowerCase();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 10 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return Array.from(node.querySelectorAll('[role="button"]')).filter(visible).find(element => {
          const label = norm(element.getAttribute('aria-label'));
          return !element.hasAttribute('aria-current')
            && /^(tuy chon phong nen|background options|more backgrounds|xem them)/.test(label);
        }) || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (gridButton) {
        await humanDelay();
        await gridButton.click().catch(() => {});
        await humanDelay(1500, 2500);
        let gridSwatches = [];
        for (let attempt = 0; attempt < 6 && gridSwatches.length <= swatches.length; attempt++) {
          gridSwatches = await readSwatches();
          if (gridSwatches.length <= swatches.length) await this._sleep(600);
        }
        if (gridSwatches.length > swatches.length) {
          swatches = gridSwatches;
          this._log(null, `Đã mở lưới phông nền: ${swatches.length} lựa chọn.`, 'info');
        }
      }
    }

    // Trong luoi, moi nhom (Trang tri / Mau chuyen sac / Mot mau tron) danh so lai tu 1,
    // nen che do ngau nhien chon theo thu tu o; che do co dinh chon theo so tren hang inline.
    let target;
    if (mode === 'fixed') {
      const wantedIndex = this.textBackground.index;
      target = swatches.find(item => item.index === wantedIndex);
      if (!target) {
        target = swatches[Math.min(swatches.length - 1, Math.max(0, wantedIndex - 1))];
        this._log(null, `Không có phông nền số ${wantedIndex}; dùng ô màu "${target.label}" thay thế.`, 'warning');
      }
    } else {
      target = swatches[Math.floor(Math.random() * swatches.length)];
    }

    const gridOpen = () => page.evaluate(() => {
      const norm = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[đĐ]/g, 'd').toLowerCase();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 200 && rect.height > 150 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible)
        .some(dialog => /^(chon phong nen|choose background|select background)/.test(norm((dialog.innerText || '').trim().slice(0, 40))));
    }).catch(() => false);

    const current = await getModal() || root;
    const swatchHandle = await current.evaluateHandle((node, order) => (
      node.querySelector(`[role="button"][data-covergem-swatch-order="${order}"]`)
    ), target.order).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
    if (!swatchHandle) {
      this._log(null, 'Không bấm được ô màu phông nền; đăng bài chỉ chữ bình thường.', 'warning');
      return await getModal();
    }
    await humanDelay();
    await swatchHandle.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
    await this._sleep(500);
    // Click bang chuot that vao tam o mau (phan tu con co background), vi React cua
    // Facebook chi nhan pointer events thuc; element.click() khong doi duoc nen.
    const clickSwatchByMouse = async () => {
      const box = await swatchHandle.evaluate(element => {
        const inner = element.querySelector('[style*="background"]') || element;
        const rect = inner.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
      }).catch(() => null);
      if (!box || box.w < 4 || box.h < 4) return false;
      await page.mouse.move(box.x - 3, box.y - 3, { steps: 6 });
      await this._sleep(120);
      await page.mouse.move(box.x, box.y, { steps: 4 });
      await this._sleep(80);
      await page.mouse.down();
      await this._sleep(90);
      await page.mouse.up();
      return true;
    };
    await clickSwatchByMouse();
    await humanDelay(1200, 2000);

    // Neu luoi "Chon phong nen" van con mo: thu lai bang chuot, roi click DOM, cuoi cung bam "Quay lai".
    if (await gridOpen()) {
      const state = await page.evaluate(() => {
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 200 && rect.height > 150 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible)
          .map(dialog => (dialog.innerText || '').trim().slice(0, 40).replace(/\s+/g, ' '));
      }).catch(() => []);
      this._log(null, `Lưới phông nền vẫn mở sau khi click (${state.join(' | ')}); thử lại.`, 'warning');
      await swatchHandle.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
      await this._sleep(500);
      await clickSwatchByMouse();
      await humanDelay(1200, 1800);
    }
    if (await gridOpen()) {
      await swatchHandle.evaluate(element => {
        const inner = element.querySelector('[style*="background"]') || element;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          inner.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
        }
      }).catch(() => {});
      await humanDelay(1000, 1600);
    }
    if (await gridOpen()) {
      const backButton = await page.evaluateHandle(() => {
        const norm = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[đĐ]/g, 'd').toLowerCase().trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 10 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return Array.from(document.querySelectorAll('[role="dialog"] [role="button"]')).filter(visible)
          .find(element => ['quay lai', 'back'].includes(norm(element.getAttribute('aria-label') || element.innerText))) || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (backButton) {
        await backButton.click().catch(() => {});
        await humanDelay(1000, 1600);
      }
    }

    const applied = await swatchHandle.evaluate(element => element.getAttribute('aria-current') === 'true').catch(() => false);
    this._log(
      null,
      `Đã chọn phông nền ${mode === 'random' ? 'ngẫu nhiên' : 'cố định'} số ${target.index} (${target.label})${applied ? '' : ' - chưa xác nhận được aria-current'}.`,
      'info'
    );
    return await getModal();
  }

  async _configureAiLabelIfNeeded(page, modal, hasMedia) {
    if (!this.addAiLabel || !hasMedia) return false;
    await this._enableAiLabel(page, modal);
    return true;
  }

  async _prepareTimelineVideoThumbnail(page, modal, thumbnailPath, thumbnailRaw = thumbnailPath) {
    const deadline = Date.now() + this._videoActionTimeoutMs;
    let currentModal = modal;
    while (Date.now() < deadline) {
      currentModal = await this._getTimelineComposer(page) || currentModal;
      const action = currentModal ? await currentModal.evaluate(root => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 20 && rect.height > 10
            && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const enabled = element => element.getAttribute('aria-disabled') !== 'true'
          && !element.matches('[disabled]');
        const labels = element => [
          norm(element.innerText || ''),
          norm(element.getAttribute('aria-label') || ''),
        ];
        const buttons = Array.from(root.querySelectorAll('[role="button"], button'))
          .filter(element => visible(element) && enabled(element));
        const isPost = element => labels(element).some(label =>
          ['dang', 'post', 'dang bai', 'dang bai viet'].includes(label)
        );
        const isNext = element => labels(element).some(label =>
          ['tiep', 'tiep tuc', 'next'].includes(label)
        );
        if (buttons.some(isPost)) return 'post';
        if (buttons.some(isNext)) return 'next';
        return '';
      }).catch(() => '') : '';

      if (action === 'post') {
        this._log(
          null,
          'Facebook hiển thị nút Đăng trực tiếp; bỏ qua thumbnail và tiếp tục đăng video.',
          'info'
        );
        return { modal: currentModal, action, applied: false };
      }
      if (action === 'next') {
        if (!FACEBOOK_IMAGE_RE.test(thumbnailRaw) || !thumbnailPath) {
          const error = new Error(
            `Khong tim thay hinh Thumbnail hoac khong phai anh: ${thumbnailRaw}`
          );
          error.code = 'FACEBOOK_THUMBNAIL_NOT_FOUND';
          throw error;
        }
        await this._setVideoThumbnail(page, currentModal, thumbnailPath, {
          advanceFirst: true,
        });
        return {
          modal: await this._getTimelineComposer(page) || currentModal,
          action,
          applied: true,
        };
      }
      await this._sleep(1000);
    }

    const error = new Error('Facebook chua hien nut Tiep hoac Dang sau khi tai video');
    error.code = 'FACEBOOK_VIDEO_ACTION_TIMEOUT';
    throw error;
  }

  // Dat hinh thu nho tuy chinh cho video: Chinh sua -> Tai len -> nap file -> Luu.
  async _setVideoThumbnail(page, modal, thumbnailPath, options = {}) {
    // Chi ghi chi tiet ra file khi that bai (de debug), khong nhoi vao thong bao loi.
    const dumpThumbDebug = (label, data) => {
      try {
        fs.writeFileSync(
          path.join(__dirname, '..', '..', 'thumbnail-debug.json'),
          JSON.stringify({ label, at: new Date().toISOString(), data }, null, 2)
        );
      } catch (_) {}
    };
    const findByText = async (texts, exact = false) => page.evaluateHandle((wanted, exactMatch) => {
      const norm = s => String(s || '').normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = e => {
        const r = e.getBoundingClientRect();
        const st = getComputedStyle(e);
        return r.width > 10 && r.height > 8 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const nodes = Array.from(document.querySelectorAll('[role="button"], button, div[tabindex], a')).filter(visible);
      const match = e => {
        const it = norm(e.innerText || '');
        const al = norm(e.getAttribute('aria-label') || '');
        return wanted.some(w => (exactMatch ? (it === w || al === w) : (it + ' ' + al).includes(w)));
      };
      // Lay node khop cuoi cung: lop overlay chinh sua thuong nam sau trong DOM.
      const found = nodes.filter(match);
      return found.length ? found[found.length - 1] : null;
    }, texts, exact).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
    // Tim nut trong pham vi modal composer (tranh bam nham nut cua trang ca nhan).
    const findInModal = async (texts, exact = false) => modal.evaluateHandle((root, wanted, exactMatch) => {
      const norm = s => String(s || '').normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = e => {
        const r = e.getBoundingClientRect();
        const st = getComputedStyle(e);
        return r.width > 10 && r.height > 8 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const nodes = Array.from(root.querySelectorAll('[role="button"], button, div[tabindex], a')).filter(visible);
      const match = e => {
        const it = norm(e.innerText || '');
        const al = norm(e.getAttribute('aria-label') || '');
        return wanted.some(w => (exactMatch ? (it === w || al === w) : (it + ' ' + al).includes(w)));
      };
      const found = nodes.filter(match);
      return found.length ? found[found.length - 1] : null;
    }, texts, exact).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
    // Cho nut xuat hien roi bam: panel chinh sua/tai len co the render cham vai giay.
    const waitClick = async (texts, { exact = false, timeout = 8000, interval = 600, inModal = false } = {}) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const handle = inModal ? await findInModal(texts, exact) : await findByText(texts, exact);
        if (handle) {
          await handle.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
          await handle.click().catch(() => {});
          return true;
        }
        if (Date.now() >= deadline) return false;
        await this._sleep(interval);
      }
    };

    // 0) Composer video buoc 1 co nut "Tiep" -> phai bam de sang man "Cai dat thuoc phim"
    //    moi co nhan Chinh sua thumbnail. Neu khong co "Tiep" thi da o dung man.
    const clickNext = async () => {
      const h = await modal.evaluateHandle(root => {
        const norm = s => String(s || '').normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();
        const visible = e => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 20 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const nodes = Array.from(root.querySelectorAll('[role="button"], button')).filter(visible);
        return nodes.find(e => {
          const p = [norm(e.getAttribute('aria-label') || ''), norm(e.innerText || '')];
          return p.some(x => x === 'tiep' || x === 'tiep tuc' || x === 'next');
        }) || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (!h) return false;
      await h.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
      await h.click().catch(() => {});
      return true;
    };

    if (options.advanceFirst === true) {
      if (!await clickNext()) {
        const error = new Error('Facebook khong con hien nut Tiep de mo buoc thumbnail');
        error.code = 'FACEBOOK_THUMBNAIL_NEXT_NOT_FOUND';
        throw error;
      }
      await this._sleep(2500);
      modal = await this._getTimelineComposer(page) || modal;
    }

    // 1) Mo trinh chinh sua thumbnail: nhan "Chinh sua" nho chong len anh thu nho
    //    (goc tren trai modal). Phai loai tru hang "Doi tuong cua bai viet" de tranh bam nham.
    const findThumbEdit = async () => modal.evaluateHandle(root => {
      const norm = s => String(s || '').normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
        .toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
      const visible = e => {
        const r = e.getBoundingClientRect();
        const st = getComputedStyle(e);
        return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const nodes = Array.from(root.querySelectorAll('[role="button"], button, div[tabindex], a, span, div')).filter(visible);
      const cands = nodes.filter(e => {
        const t = norm(e.innerText || '');
        const al = norm(e.getAttribute('aria-label') || '');
        if (t.includes('doi tuong') || t.includes('bai viet') || al.includes('doi tuong') || al.includes('bai viet')) return false;
        return t === 'chinh sua' || al === 'chinh sua';
      });
      if (!cands.length) return null;
      // Chon phan tu nho nhat (chinh la nhan, khong phai wrapper lon vi tam click se roi trung hang khac).
      cands.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.width * ra.height) - (rb.width * rb.height);
      });
      return cands[0];
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);

    // Composer video co the co nhieu buoc "Tiep" (Chinh sua thuoc phim -> Cai dat thuoc phim).
    // Bam "Tiep" qua tung buoc cho den khi thay nhan "Chinh sua" thumbnail o man cuoi.
    let editHandle = null;
    for (let step = 0; step < 6 && !editHandle; step++) {
      editHandle = await findThumbEdit();
      if (editHandle) break;
      if (!await clickNext()) break;
      await this._sleep(2500);
      modal = await this._getTimelineComposer(page) || modal;
    }
    if (!editHandle) {
      const dl = Date.now() + 4000;
      while (!editHandle && Date.now() < dl) {
        editHandle = await findThumbEdit();
        if (!editHandle) await this._sleep(600);
      }
    }
    if (!editHandle) {
      const diag = await modal.evaluate(root => {
        const norm = s => String(s || '').normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        return Array.from(root.querySelectorAll('[role="button"], button, div[tabindex], a, span'))
          .map(e => norm((e.innerText || '') + '|' + (e.getAttribute('aria-label') || '')))
          .filter(t => t && t !== '|').slice(0, 60);
      }).catch(() => []);
      dumpThumbDebug('edit', diag);
      const error = new Error('Facebook khong hien thi nut Chinh sua thumbnail video');
      error.code = 'FACEBOOK_THUMBNAIL_EDIT_NOT_FOUND';
      throw error;
    }
    await editHandle.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await editHandle.click().catch(() => {});

    // 2) Bam "Tai len" (Tai hinh thu nho tuy chinh) va nap file.
    const chooserPromise = page.waitForFileChooser({ timeout: 15000 }).catch(() => null);
    if (!await waitClick(['tai hinh thu nho', 'tai len'], { timeout: 10000 })) {
      const diag = await page.evaluate(() => {
        const norm = s => String(s || '').normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const visible = e => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 8 && r.height > 6 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        const btns = Array.from(document.querySelectorAll('[role="button"], button, div[tabindex], a'))
          .filter(visible)
          .map(e => norm((e.innerText || '') + '|' + (e.getAttribute('aria-label') || '')))
          .filter(t => t && t !== '|')
          .slice(0, 60);
        const iframes = document.querySelectorAll('iframe').length;
        const inputs = document.querySelectorAll('input[type="file"]').length;
        return { iframes, inputs, btns };
      }).catch(() => '(dump failed)');
      dumpThumbDebug('upload', diag);
      const error = new Error('Facebook khong hien thi nut Tai len thumbnail');
      error.code = 'FACEBOOK_THUMBNAIL_UPLOAD_NOT_FOUND';
      throw error;
    }
    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.accept([thumbnailPath]);
    } else {
      const input = await this._findGroupMediaInput(page, modal);
      if (!input || typeof input.uploadFile !== 'function') {
        const error = new Error('Facebook khong mo duoc o chon file thumbnail');
        error.code = 'FACEBOOK_THUMBNAIL_INPUT_NOT_FOUND';
        throw error;
      }
      await input.uploadFile(thumbnailPath);
    }
    await this._sleep(3500);

    // 3) Luu thumbnail (nut Luu cua trinh chinh sua, khop chinh xac).
    if (!await waitClick(['luu'], { exact: true, timeout: 6000 })) {
      const diag = await page.evaluate(() => {
        const norm = s => String(s || '').normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const visible = e => {
          const r = e.getBoundingClientRect();
          const st = getComputedStyle(e);
          return r.width > 8 && r.height > 6 && st.visibility !== 'hidden' && st.display !== 'none';
        };
        return Array.from(document.querySelectorAll('[role="button"], button, div[tabindex], a'))
          .filter(visible)
          .map(e => norm((e.innerText || '') + '|' + (e.getAttribute('aria-label') || '')))
          .filter(t => t && t !== '|').slice(0, 60);
      }).catch(() => []);
      dumpThumbDebug('save', diag);
      const error = new Error('Facebook khong hien thi nut Luu thumbnail');
      error.code = 'FACEBOOK_THUMBNAIL_SAVE_NOT_FOUND';
      throw error;
    }
    await this._sleep(2000);
    this._log(null, 'Đã đặt thumbnail tùy chỉnh cho video.', 'success');
  }

  async _enableAiLabel(page, modal) {
    const findAiControl = async () => page.evaluateHandle(rootElement => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 5 && rect.height > 5
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const aiText = text => /nhan ai|ai label|label ai|made with ai|thong tin ai/.test(norm(text));
      const roots = [rootElement, ...Array.from(document.querySelectorAll('[role="dialog"]'))]
        .filter(Boolean);
      for (const root of roots) {
        const controls = Array.from(root.querySelectorAll(
          '[role="switch"], input[type="checkbox"], button[aria-checked], [role="checkbox"]'
        )).filter(visible);
        for (const control of controls) {
          let context = control;
          for (let depth = 0; context && depth < 6; depth++, context = context.parentElement) {
            const text = [
              context.innerText,
              context.getAttribute('aria-label'),
              control.getAttribute('aria-label'),
            ].filter(Boolean).join(' ');
            if (aiText(text)) return control;
          }
        }
      }
      return null;
    }, modal).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);

    const isEnabled = control => control.evaluate(element => {
      if (element.matches('input[type="checkbox"]')) return element.checked;
      return element.getAttribute('aria-checked') === 'true'
        || element.getAttribute('data-state') === 'checked';
    }).catch(() => false);

    let control = await findAiControl();
    if (!control) {
      const row = await modal.evaluateHandle(root => {
        const norm = value => String(value || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 20 && rect.height > 10
            && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const candidates = Array.from(root.querySelectorAll(
          '[role="button"], button, [tabindex="0"], li'
        )).filter(visible);
        return candidates.find(element => {
          const text = norm(
            `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`
          );
          return /nhan ai|ai label|label ai|made with ai|thong tin ai/.test(text);
        }) || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (!row) {
        const error = new Error('Facebook không hiển thị mục Nhãn AI sau khi tải media');
        error.code = 'FACEBOOK_AI_LABEL_OPTION_NOT_FOUND';
        throw error;
      }
      await row.click();
      await this._sleep(800);
      control = await findAiControl();
      if (!control) {
        const rowActsAsSwitch = await row.evaluate(element =>
          element.getAttribute('role') === 'switch'
          || element.hasAttribute('aria-checked')
          || element.matches('input[type="checkbox"]')
        ).catch(() => false);
        if (rowActsAsSwitch) control = row;
        else {
          const error = new Error('Đã mở mục Nhãn AI nhưng không tìm thấy công tắc bật');
          error.code = 'FACEBOOK_AI_LABEL_SWITCH_NOT_FOUND';
          throw error;
        }
      }
    }

    if (!await isEnabled(control)) {
      await control.click();
      await this._sleep(800);
    }

    const enabled = await isEnabled(control) || await page.evaluate(() => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('[role="dialog"], form, main')).some(root => {
        const text = norm(root.innerText);
        return /(nhan ai|ai label).{0,30}(da bat|bat|on)/.test(text)
          && !/(nhan ai|ai label).{0,30}(da tat|tat|off)/.test(text);
      });
    }).catch(() => false);

    if (!enabled) {
      const error = new Error('Facebook chưa chuyển Nhãn AI sang trạng thái bật');
      error.code = 'FACEBOOK_AI_LABEL_NOT_ENABLED';
      throw error;
    }
    await this._returnFromAiLabelSettings(page);
    return true;
  }

  async _returnFromAiLabelSettings(page) {
    const getButton = mode => page.evaluateHandle(action => {
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .toLowerCase().replace(/\s+/g, ' ').trim();
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 10
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      if (action === 'notice') {
        const notice = dialogs.find(dialog => {
          const text = norm(dialog.innerText);
          const aiTopic = /gan nhan noi dung|content label|nhan ai|ai label/.test(text);
          const explanation = /chung toi yeu cau|we require|tao bang ai|created with ai|cam giac nhu that|photorealistic/.test(text);
          return aiTopic && explanation;
        });
        if (!notice) return null;
        return Array.from(notice.querySelectorAll('[role="button"], button'))
          .filter(visible)
          .find(button => ['ok', 'got it', 'da hieu', 'toi hieu'].includes(
            norm(button.innerText || button.getAttribute('aria-label'))
          )) || null;
      }

      const settingsDialog = dialogs.find(dialog => {
        if (dialog.querySelector('[contenteditable="true"]')) return false;
        const text = norm(dialog.innerText || dialog.getAttribute('aria-label'));
        return /gan nhan noi dung|content labels?/.test(text);
      });
      if (!settingsDialog) return null;
      return Array.from(settingsDialog.querySelectorAll('[role="button"], button'))
        .filter(visible)
        .find(button => ['quay lai', 'back'].includes(
          norm(button.getAttribute('aria-label') || button.innerText)
        )) || null;
    }, mode).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);

    const noticeButton = await getButton('notice');
    if (noticeButton) {
      await noticeButton.click();
      await this._sleep(700);
    }

    const backButton = await getButton('back');
    if (backButton) {
      await backButton.click();
      await this._sleep(900);
    }
  }

  normalizeFacebookGroupUrl(value) {
    let raw = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^(?:m|mbasic|web)\./, 'www.');
      if (!['facebook.com', 'www.facebook.com'].includes(host)) return '';
      if (!/^https?:$/.test(url.protocol)) return '';
      const segments = url.pathname.split('/').filter(Boolean);
      if (String(segments[0] || '').toLowerCase() !== 'groups' || !segments[1]) return '';
      if (segments.length !== 2 || /^(posts|permalink|search|media)$/i.test(segments[1])) return '';
      return `https://www.facebook.com/groups/${encodeURIComponent(
        decodeURIComponent(segments[1])
      )}`;
    } catch (_) {
      return '';
    }
  }

  normalizeFacebookGroupPostUrl(value, groupHref = '') {
    let raw = String(value || '').trim().replace(/\\\//g, '/');
    if (!raw) return '';
    if (raw.startsWith('/')) raw = `https://www.facebook.com${raw}`;
    if (!/^https?:\/\//i.test(raw)) return '';
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^(?:m|mbasic|web)\./, 'www.');
      if (!['facebook.com', 'www.facebook.com'].includes(host)) return '';
      const segments = url.pathname.split('/').filter(Boolean);
      if (
        String(segments[0] || '').toLowerCase() !== 'groups'
        || !segments[1]
        || String(segments[2] || '').toLowerCase() !== 'posts'
        || !segments[3]
      ) return '';
      if (groupHref) {
        const target = new URL(groupHref).pathname.split('/').filter(Boolean)[1];
        if (decodeURIComponent(segments[1]).toLowerCase() !== decodeURIComponent(target).toLowerCase()) {
          return '';
        }
      }
      return `https://www.facebook.com/groups/${encodeURIComponent(
        decodeURIComponent(segments[1])
      )}/posts/${encodeURIComponent(decodeURIComponent(segments[3]))}`;
    } catch (_) {
      return '';
    }
  }

  normalizeFacebookTargetUrl(value) {
    let raw = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase().replace(/^(?:m|mbasic|web)\./, 'www.');
      if (host !== 'facebook.com' && host !== 'www.facebook.com') return '';
      if (!/^https?:$/.test(url.protocol)) return '';

      const segments = url.pathname.split('/').filter(Boolean);
      const first = String(segments[0] || '').toLowerCase();
      if (!first || /^(groups|events|marketplace|watch|reel|share|story\.php|permalink\.php|photo\.php)$/.test(first)) {
        return '';
      }
      if (segments.some(segment => /^(posts|videos|reels?)$/i.test(segment))) return '';
      if (first === 'profile.php' && !url.searchParams.get('id')) return '';

      url.protocol = 'https:';
      url.hostname = 'www.facebook.com';
      url.port = '';
      url.hash = '';
      const id = first === 'profile.php' ? url.searchParams.get('id') : '';
      url.search = id ? `?id=${encodeURIComponent(id)}` : '';
      url.pathname = '/' + segments.join('/');
      return url.toString().replace(/\/$/, '');
    } catch (_) {
      return '';
    }
  }

  async _leavePageIdentity(page) {
    if (!page || typeof page.cookies !== 'function') return false;
    const cookies = await page.cookies('https://www.facebook.com').catch(() => []);
    const identityCookie = cookies.find(cookie => cookie.name === 'i_user');
    if (!identityCookie) return false;
    await page.deleteCookie({
      name: 'i_user',
      domain: identityCookie.domain || '.facebook.com',
      path: identityCookie.path || '/',
    }).catch(() => {});
    await this._gotoFacebookPage(page, 'https://www.facebook.com/', 60000);
    await this._sleep(2000);
    const verified = await page.cookies('https://www.facebook.com').catch(() => []);
    if (verified.some(cookie => cookie.name === 'i_user' && cookie.value)) {
      const error = new Error('Khong the tro ve danh tinh Profile; cookie i_user van con');
      error.code = 'FACEBOOK_PROFILE_IDENTITY_RESET_FAILED';
      throw error;
    }
    const cUser = verified.find(cookie => cookie.name === 'c_user' && cookie.value);
    if (!cUser) {
      const error = new Error('Mat cookie dang nhap c_user khi tro ve Profile');
      error.code = 'FACEBOOK_NOT_LOGGED_IN';
      throw error;
    }
    return true;
  }

  async _verifyPageIdentity(page, pageHref) {
    const cookies = await page.cookies('https://www.facebook.com').catch(() => []);
    const cUser = String((cookies.find(cookie => cookie.name === 'c_user') || {}).value || '');
    const iUser = String((cookies.find(cookie => cookie.name === 'i_user') || {}).value || '');
    let expected = '';
    try {
      const url = new URL(pageHref);
      const segments = url.pathname.split('/').filter(Boolean);
      const first = segments[0] || '';
      const last = segments[segments.length - 1] || '';
      expected = /^profile\.php$/i.test(first)
        ? url.searchParams.get('id') || ''
        : (/^\d+$/.test(first) ? first : (/^(people|pages)$/i.test(first) && /^\d+$/.test(last) ? last : ''));
    } catch (_) {}
    if (!cUser || !iUser || iUser === cUser || (expected && iUser !== expected)) {
      const error = new Error('Khong xac minh duoc dung danh tinh Fanpage qua cookie i_user');
      error.code = 'FACEBOOK_PAGE_IDENTITY_MISMATCH';
      throw error;
    }
    return { cUser, iUser };
  }

  async _readPageIdentityId(page, pageHref) {
    const fromHref = extractFacebookEntityId('', pageHref);
    if (fromHref) return fromHref;
    const html = await page.content().catch(() => '');
    return extractFacebookEntityId(html, pageHref);
  }

  async _verifyOrRecoverPageIdentity(page, pageHref) {
    await this._switchToPageIfPrompted(page);
    try {
      return await this._verifyPageIdentity(page, pageHref);
    } catch (error) {
      if (error?.code !== 'FACEBOOK_PAGE_IDENTITY_MISMATCH') throw error;
      const pageId = await this._readPageIdentityId(page, pageHref);
      if (!pageId) throw error;

      const numericHref = `https://www.facebook.com/profile.php?id=${pageId}`;
      await this._activateNumericPageIdentity(page, numericHref);
      await this._gotoFacebookPage(page, pageHref, 60000);
      await this._sleep(2500);
      await this._switchToPageIfPrompted(page);
      return this._verifyPageIdentity(page, numericHref);
    }
  }

  async _activateNumericPageIdentity(page, pageHref) {
    let pageId = '';
    try {
      const url = new URL(pageHref);
      const segments = url.pathname.split('/').filter(Boolean);
      const first = segments[0] || '';
      const last = segments[segments.length - 1] || '';
      pageId = /^profile\.php$/i.test(first)
        ? url.searchParams.get('id') || ''
        : (/^\d+$/.test(first) ? first : (/^(people|pages)$/i.test(first) && /^\d+$/.test(last) ? last : ''));
    } catch (_) {}
    if (!pageId) return false;
    await page.setCookie({
      name: 'i_user',
      value: pageId,
      domain: '.facebook.com',
      path: '/',
      secure: true,
      sameSite: 'None',
    });
    return true;
  }

  async _switchToPageIfPrompted(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const button = await page.evaluateHandle(() => {
        const norm = value => String(value || '')
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 40 && rect.height > 18 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const isSwitchButton = element => {
          const parts = [
            norm(element.innerText || ''),
            norm(element.getAttribute('aria-label') || ''),
          ].filter(Boolean);
          return parts.some(text => /^(switch|switch now|chuyen|chuyen ngay)$/.test(text)
            || text.includes('switch into')
            || text.includes('chuyen sang trang'));
        };
        // Uu tien nut nam trong dung hop thoai chuyen doi de tranh bam nham
        // cac nut "Chuyen"/"Chuyen ngay" o sidebar hay panel nen (chi mo lai dialog).
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
          .filter(visible)
          .filter(dialog => {
            const title = norm(dialog.innerText || '');
            return title.includes('chuyen trang ca nhan')
              || title.includes('chuyen sang')
              || title.includes('switch');
          });
        const scopes = dialogs.length ? dialogs : [document];
        for (const scope of scopes) {
          const found = Array.from(scope.querySelectorAll('[role="button"], button, a[role="button"]'))
            .filter(visible)
            .find(isSwitchButton);
          if (found) return found;
        }
        return null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (!button) return false;
      await button.click().catch(() => {});
      // Chuyen danh tinh la soft navigation (SPA), thuong khong ban domcontentloaded,
      // nen cho hop thoai chuyen doi bien mat thay vi waitForNavigation.
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const stillOpen = await page.evaluate(() => {
          const norm = value => String(value || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
          return Array.from(document.querySelectorAll('[role="dialog"]')).some(dialog => {
            const title = norm(dialog.innerText || '');
            return title.includes('chuyen trang ca nhan') || title.includes('chuyen sang');
          });
        }).catch(() => false);
        if (!stillOpen) break;
        await this._sleep(500);
      }
      await this._sleep(2000);
    }
    return true;
  }

  async capturePostLinkFromConfirmation(page, beforeLinks, owner) {
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    // Keep the current page stable while Facebook finishes the publish request.
    // Navigating away too soon can cancel a slow submission on some connections.
    // Toast "Da dang bai viet" hiem khi chua the <a> permalink, nen chi cho ngan
    // roi nhuong cho cac cach tim theo noi dung (truoc day cho du 20s moi bai).
    for (let attempt = 0; attempt < 8; attempt++) {
      const hrefs = await page.evaluate(() => {
        const roots = Array.from(document.querySelectorAll(
          '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]'
        ));
        return roots.flatMap(root => Array.from(root.querySelectorAll('a[href]')).map(anchor => anchor.href));
      }).catch(() => []);
      for (const href of hrefs) {
        const normalized = this.normalizeFacebookPostUrl(href);
        if (normalized && !before.has(normalized) && this._isOwnPostUrl(normalized, owner)) {
          return normalized;
        }
      }
      await this._sleep(1000);
    }
    return '';
  }

  async capturePublicFanpagePostLink(page, fanpageHref, content, owner) {
    const needle = normalizeFacebookCaption(content, 60);
    if (!needle) return '';
    const browser = page.browser();
    if (!browser || typeof browser.createBrowserContext !== 'function') return '';

    let context = null;
    try {
      context = await browser.createBrowserContext();
      const publicPage = await context.newPage();
      await publicPage.setViewport({ width: 1280, height: 900 });
      for (let attempt = 0; attempt < 8; attempt++) {
        await publicPage.goto(fanpageHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await this._sleep(3500 + attempt * 750);
        const hrefs = await publicPage.evaluate(needleText => {
          const clean = value => String(value || '').normalize('NFC')
            .replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase()
            .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
          const article = Array.from(document.querySelectorAll('[role="article"]'))
            .find(element => clean(element.innerText).includes(needleText));
          return article
            ? Array.from(article.querySelectorAll('a[href]')).map(anchor => anchor.href)
            : [];
        }, needle).catch(() => []);
        for (const href of hrefs) {
          const normalized = this.normalizeFacebookPostUrl(href);
          if (normalized && this._isOwnPostUrl(normalized, owner)) return normalized;
        }
      }
    } catch (_) {
      return '';
    } finally {
      if (context) await context.close().catch(() => {});
    }
    return '';
  }

  /**
   * Mo lai bai vua dang, gui text/media va chi thanh cong khi DOM xac nhan.
   * @param {Object} page - Puppeteer page
   * @param {string} postLink - Permalink bai da dang
   * @param {string} commentText - Noi dung binh luan (da render bien)
   * @param {string} mediaPath - Mot anh hoac video tuy chon
   */
  async commentOnPost(page, postLink, commentText = '', mediaPath = '') {
    const humanDelay = (min = 900, max = 2200) => this._sleep(Math.floor(Math.random() * (max - min + 1)) + min);
    await this._gotoCommentPermalink(page, postLink);
    await humanDelay(3000, 5000);

    const box = await this._findCommentBox(page);
    if (!box) throw new Error('Không tìm thấy ô bình luận');
    const before = await this._commentDomSnapshot(page, commentText);

    await box.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
    await humanDelay(600, 1200);
    await box.click().catch(() => {});
    await humanDelay(500, 1000);

    if (process.env.SPK_DEBUG_COMMENT_IDENTITY === '1') {
      await this._debugDumpCommentIdentity(page, box).catch(() => {});
    }

    if (mediaPath) {
      // Đường dẫn tiếng Việt có dấu phải quy về đúng tên file trên ổ đĩa trước khi tải lên
      const resolvedMedia = resolveMediaPath(mediaPath);
      if (!resolvedMedia) throw new Error(`Không tìm thấy media bình luận: ${mediaPath}`);
      await this._attachCommentMedia(page, box, resolvedMedia);
    }

    const linkPattern = /https?:\/\/[^\s<>"']+/gi;
    const hasLinks = linkPattern.test(String(commentText));
    const lines = String(commentText).split(/\r?\n/);
    const pasted = hasLinks && await this._pasteCommentText(page, box, String(commentText));
    if (pasted) {
      // A real paste event matches manual Facebook usage. Facebook may only
      // create the actual anchor after the comment has been submitted.
      if (!/\s$/.test(String(commentText))) await page.keyboard.type(' ', { delay: 30 });
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) await page.keyboard.type(lines[i], { delay: 20 });
        const urlsOnLine = lines[i].match(linkPattern) || [];
        if (urlsOnLine.length) {
          const lastUrl = urlsOnLine[urlsOnLine.length - 1];
          const textAfterUrl = lines[i].slice(lines[i].lastIndexOf(lastUrl) + lastUrl.length);
          // A newline is not a reliable URL delimiter in Facebook's Lexical editor.
          if (!textAfterUrl) await page.keyboard.type(' ', { delay: 30 });
        }
        if (i < lines.length - 1) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Enter');
          await page.keyboard.up('Shift');
        }
      }
    }
    await humanDelay(800, 1500);
    await this._submitComment(page, box);
    const submitError = new Error('Facebook chưa xác minh bình luận mới');
    submitError.submitted = true;

    const isVideo = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i.test(mediaPath);
    const timeoutMs = this._commentVerificationTimeoutMs || (isVideo ? 120000 : 45000);
    const started = Date.now();
    let lastAfter = null;
    let accepted = false;
    while (Date.now() - started < timeoutMs) {
      await this._sleep(1800);
      const clean = await box.evaluate(el => !(el.innerText || '').trim()).catch(() => true);
      const after = await this._commentDomSnapshot(page, commentText);
      lastAfter = after;
      const newId = after.ids.some(id => !before.ids.includes(id));
      const textAdded = commentText ? after.textMatches > before.textMatches : true;
      const linkAdded = !hasLinks
        || after.linkMatches > before.linkMatches
        || after.previewMatches > before.previewMatches;
      const mediaAdded = mediaPath ? after.mediaCount > before.mediaCount : true;
      const attachmentCleared = mediaPath ? !after.composerHasAttachment : true;
      if (clean && ((commentText && textAdded) || (!commentText && newId)) && linkAdded && mediaAdded) {
        accepted = true;
        break;
      }
      if (clean && newId && (!commentText || textAdded) && linkAdded) {
        accepted = true;
        break;
      }
      // Facebook does not always expose comment_id immediately. For media
      // comments, a cleared editor and attachment preview after clicking the
      // explicit submit button is a reliable acknowledgement from the UI.
      if (mediaPath && clean && attachmentCleared && Date.now() - started >= 4500
        && (!commentText || textAdded) && linkAdded) {
        accepted = true;
        break;
      }
    }
    if (accepted) {
      // DOM lạc quan của Facebook có thể hiển thị bình luận ngay cả khi server
      // từ chối (ví dụ comment bằng danh tính Page/i_user không hợp lệ). Tải lại
      // permalink và chỉ coi là thành công nếu bình luận còn tồn tại thật.
      const persisted = await this._confirmCommentPersisted(page, postLink, commentText, before);
      if (persisted) return { success: true, postedAt: new Date().toLocaleString('vi-VN') };
      const gone = new Error('Bình luận không còn sau khi tải lại trang (Facebook từ chối hoặc sai danh tính đăng bình luận)');
      gone.commentRejected = true;
      throw gone;
    }
    submitError.message += ` | before=${JSON.stringify(before)} after=${JSON.stringify(lastAfter)}`;
    throw submitError;
  }

  // Tải lại permalink sau khi gửi để xác nhận bình luận THỰC SỰ tồn tại trên
  // server, tránh dương tính giả do DOM render lạc quan.
  async _confirmCommentPersisted(page, postLink, commentText = '', before = { ids: [] }) {
    const beforeIds = Array.isArray(before && before.ids) ? before.ids : [];
    const deadline = Date.now() + 12000;
    let first = true;
    while (Date.now() < deadline) {
      if (commentText) {
        // hasExistingComment tải lại permalink và chỉ khớp khi có anchor
        // comment_id với đúng nội dung -> xác nhận bình luận thật, không phải
        // text lạc quan còn trong DOM.
        const ok = await this.hasExistingComment(page, postLink, commentText, '').catch(() => false);
        if (ok) return true;
      } else {
        if (!first) await this._sleep(2500);
        try { await this._gotoCommentPermalink(page, postLink); } catch (_) {}
        await this._sleep(2500);
        const snap = await this._commentDomSnapshot(page, '').catch(() => null);
        if (snap && snap.ids.some(id => !beforeIds.includes(id))) return true;
      }
      first = false;
    }
    return false;
  }

  // TAM THOI (guard SPK_DEBUG_COMMENT_IDENTITY=1): in ra DOM cac control chon
  // danh tinh quanh o binh luan de thiet ke buoc chon Page cho trang NPE.
  async _debugDumpCommentIdentity(page, box) {
    const info = await box.evaluate(el => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
      let root = el.closest('form');
      if (!root) { root = el; for (let i = 0; i < 10 && root.parentElement; i++) root = root.parentElement; }
      const re = /tư cách|tu cach|dưới tên|duoi ten|comment as|bình luận với|binh luan voi|commenting as/i;
      const hits = [];
      const scan = node => {
        for (const e of node.querySelectorAll('[aria-label],[role="button"],button,a,span,image,svg,div')) {
          const label = (e.getAttribute && e.getAttribute('aria-label')) || '';
          const txt = norm(e.innerText || e.textContent || '');
          if (re.test(label) || re.test(txt)) {
            const r = e.getBoundingClientRect();
            hits.push({
              tag: e.tagName,
              role: e.getAttribute && e.getAttribute('role'),
              ariaLabel: norm(label).slice(0, 120),
              text: txt.slice(0, 120),
              w: Math.round(r.width), h: Math.round(r.height),
            });
          }
          if (hits.length > 40) break;
        }
      };
      scan(root);
      // avatar/image buttons o dau o binh luan (thuong la nut doi danh tinh)
      const imgs = Array.from(root.querySelectorAll('image, img, svg[role="img"]')).slice(0, 6).map(e => {
        const btn = e.closest('[role="button"],button,a');
        return { hasButton: !!btn, ariaLabel: norm((btn && btn.getAttribute('aria-label')) || ''), alt: norm(e.getAttribute && (e.getAttribute('alt') || e.getAttribute('aria-label'))) };
      });
      return { hits, imgs, rootTag: root.tagName };
    }).catch(() => null);
    try {
      require('fs').appendFileSync(
        require('path').join(require('os').tmpdir(), 'spk-comment-identity.log'),
        `${new Date().toISOString()} ${JSON.stringify(info)}\n`
      );
    } catch (_) {}
  }

  async _pasteCommentText(page, box, text) {
    const value = String(text || '');
    if (!value || !/^https?:/m.test(value)) return false;
    try {
      const origin = new URL(page.url()).origin;
      if (!/^https?:\/\//i.test(origin)) return false;
      const context = page.browserContext();
      if (context && typeof context.overridePermissions === 'function') {
        await context.overridePermissions(origin, ['clipboard-read', 'clipboard-write']);
      }
      const copied = await page.evaluate(async clipboardText => {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return false;
        await navigator.clipboard.writeText(clipboardText);
        return true;
      }, value);
      if (!copied) return false;

      await page.keyboard.down('Control');
      await page.keyboard.press('V');
      await page.keyboard.up('Control');
      await this._sleep(500);

      const pasted = await box.evaluate((element, expected) => {
        const clean = input => String(input || '').replace(/\s+/g, ' ').trim();
        return clean(element.innerText || element.textContent).includes(clean(expected));
      }, value).catch(() => false);
      if (pasted) return true;

      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
    } catch (_) {
      return false;
    }
    return false;
  }

  async _findCommentBox(page) {
    let box = null;
    for (let attempt = 0; attempt < 8 && !box; attempt++) {
      const handle = await page.evaluateHandle(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
        const vis = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const boxes = Array.from(document.querySelectorAll(
          'div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'
        )).filter(vis);
        return boxes.find(b => /binh luan|comment|tra loi|reply/.test(norm(
          (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('aria-placeholder') || '')
        ))) || boxes[boxes.length - 1] || null;
      }).catch(() => null);
      box = handle && handle.asElement ? handle.asElement() : null;
      if (!box && handle && typeof handle.dispose === 'function') await handle.dispose().catch(() => {});
      if (!box) {
        // Reel/video pages often hide the composer until the Comment action
        // opens the side panel. Prefer an exact visible action button.
        const opened = await page.evaluate(() => {
          const norm = s => String(s || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
            .replace(/\s+/g, ' ').trim().toLowerCase();
          const visible = node => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return rect.width > 5 && rect.height > 5
              && rect.bottom > 0 && rect.top < innerHeight
              && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const candidates = Array.from(document.querySelectorAll(
            'button, [role="button"], [aria-label]'
          )).filter(node => {
            if (!visible(node) || node.matches('[contenteditable="true"], [role="textbox"]')) return false;
            const label = norm(
              `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.innerText || ''}`
            );
            return /^(binh luan|comment)(?:\s|$)/.test(label)
              || /^(xem|view|mo|open).{0,24}(binh luan|comments?)(?:\s|$)/.test(label);
          });
          if (!candidates.length) return false;
          candidates.sort((left, right) => {
            const score = node => {
              const label = norm(
                `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.innerText || ''}`
              );
              let value = /^(binh luan|comment)$/.test(label) ? 100 : 50;
              if (node.closest('[role="dialog"]')) value += 20;
              if (node.hasAttribute('aria-label')) value += 10;
              return value;
            };
            return score(right) - score(left);
          });
          candidates[0].click();
          return true;
        }).catch(() => false);
        if (!opened) {
          await page.evaluate(() => window.scrollBy(0, 650)).catch(() => {});
        }
        await this._sleep(1200);
      }
    }
    return box;
  }

  async _attachCommentMedia(page, box, mediaPath) {
    const isVideo = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i.test(mediaPath);
    const beforePreviewCount = await box.evaluate(el => {
      const visible = node => {
        const r = node.getBoundingClientRect();
        return r.width >= 50 && r.height >= 40 && r.bottom > 0 && r.top < innerHeight;
      };
      let root = el.closest('form');
      if (!root) {
        root = el;
        for (let i = 0; i < 9 && root.parentElement; i++) root = root.parentElement;
      }
      return Array.from(document.querySelectorAll('img,video')).filter(visible).length;
    }).catch(() => 0);

    let input = await box.evaluateHandle((el, wantsVideo) => {
      let cur = el;
      const inputs = [];
      for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
        inputs.push(...cur.querySelectorAll('input[type="file"]'));
      }
      inputs.push(...document.querySelectorAll('input[type="file"]'));
      const unique = [...new Set(inputs)];
      const accepts = node => String(node.getAttribute('accept') || '').toLowerCase();
      return unique.find(node => {
        const accept = accepts(node);
        return wantsVideo
          ? (!accept || accept.includes('video') || accept.includes('*/*'))
          : (!accept || accept.includes('image') || accept.includes('*/*'));
      }) || null;
    }, isVideo).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);

    if (input && typeof input.uploadFile === 'function') {
      await input.uploadFile(mediaPath);
    } else {
      const chooserPromise = page.waitForFileChooser({ timeout: 15000 });
      const clicked = await page.evaluate(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 5 && r.height > 5; };
        const nodes = Array.from(document.querySelectorAll('[role="button"], button, [aria-label]')).filter(vis);
        const button = nodes.find(e => /dinh kem.*(anh|video)|attach.*(photo|video)|anh.*video|photo.*video/.test(
          norm((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || ''))
        ));
        if (!button) return false;
        button.click();
        return true;
      }).catch(() => false);
      if (!clicked) throw new Error('Không tìm thấy nút đính kèm media bình luận');
      const chooser = await chooserPromise;
      await chooser.accept([mediaPath]);
    }

    const uploadTimeout = this._commentUploadTimeoutMs || (isVideo ? 120000 : 45000);
    const started = Date.now();
    while (Date.now() - started < uploadTimeout) {
      await this._sleep(1500);
      const state = await page.evaluate(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
        const busy = Array.from(document.querySelectorAll('[role="progressbar"], [aria-label]')).some(e =>
          /dang tai|uploading|processing/.test(norm((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')))
        );
        const previews = Array.from(document.querySelectorAll('img, video')).filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 80 && r.height > 50 && r.bottom > 0 && r.top < innerHeight;
        }).length;
        const removeButton = Array.from(document.querySelectorAll('[aria-label]')).some(e => {
          const r = e.getBoundingClientRect();
          const label = String(e.getAttribute('aria-label') || '').normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').toLowerCase();
          return r.width > 5 && r.height > 5
            && /(go|remove) (anh|video|photo|image)/.test(label);
        });
        const pageText = String(document.body.innerText || '').normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const attachmentSuccess = /a dinh kem (anh|video).*thanh cong|attached (photo|video|image).*success/.test(pageText);
        return { busy, previews, removeButton, attachmentSuccess };
      }).catch(() => ({
        busy: false, previews: 0, removeButton: false, attachmentSuccess: false
      }));
      // Facebook keeps unrelated page-level "loading" aria labels mounted,
      // so global busy state is not meaningful. A new visible media preview
      // compared with the pre-upload snapshot is the reliable signal.
      if (state.attachmentSuccess
        || state.previews > beforePreviewCount
        || (state.removeButton && Date.now() - started >= 3000)) return;
    }
    throw new Error('Media bình luận upload quá thời gian');
  }

  /**
   * Chờ Facebook biến link trong ô soạn bình luận thành link thật và tải xong
   * thẻ xem trước. Facebook chỉ nhận diện link sau khi có ký tự kết thúc URL,
   * rồi mới gọi máy chủ lấy tiêu đề/ảnh — mất vài giây. Gửi trước lúc đó thì
   * bình luận đăng lên chỉ là chữ thường, không bấm được và mất thẻ xem trước.
   */
  async _waitCommentLinkReady(page, box, commentText) {
    const urls = String(commentText || '').match(/https?:\/\/[^\s<>"']+/gi);
    if (!urls || !urls.length) return false;

    let host = '';
    try {
      host = new URL(urls[urls.length - 1]).hostname.replace(/^www\./i, '');
    } catch {
      return false;
    }

    const timeoutMs = this._commentLinkPreviewTimeoutMs || 30000;
    const started = Date.now();
    let lastState = null;
    while (Date.now() - started < timeoutMs) {
      const state = await box.evaluate((el, hostName) => {
        let root = el.closest('form, [role="dialog"], [role="article"]');
        if (!root) {
          root = el;
          for (let i = 0; i < 18 && root.parentElement; i += 1) root = root.parentElement;
        }
        const editorRect = el.getBoundingClientRect();
        const nearby = node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0
            && rect.bottom >= editorRect.top - 650
            && rect.top <= editorRect.bottom + 650
            && rect.right >= editorRect.left - 250
            && rect.left <= editorRect.right + 650;
        };

        // Dấu hiệu 1: đã có thẻ xem trước, kèm nút gỡ bản xem trước
        const removeLabels = /(remove|gỡ|go).{0,20}(preview|xem tr)/i;
        const hasRemoveButton = Array.from(document.querySelectorAll('[aria-label],[title]'))
          .some(node => nearby(node) && removeLabels.test(
            `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`,
          ));

        // Dấu hiệu 2: tên miền hiện riêng thành một dòng (S.SHOPEE.VN), không kèm http
        const wanted = String(hostName).toUpperCase();
        const hasDomainLine = Array.from(document.querySelectorAll('span,a,[dir="auto"]'))
          .some(node => {
            const text = (node.textContent || '').trim();
            return nearby(node) && text && text.length <= wanted.length + 4
              && !/https?:/i.test(text)
              && text.toUpperCase() === wanted;
          });

        // Some Facebook layouts create the clickable entity before rendering
        // a rich preview. That is sufficient to keep the posted URL clickable.
        const hasEditorLink = Array.from(el.querySelectorAll('a[href]')).some(anchor => {
          try {
            return new URL(anchor.href, location.href).hostname
              .replace(/^www\./i, '').toLowerCase() === hostName.toLowerCase();
          } catch (_) {
            return false;
          }
        });

        // Dấu hiệu 4: Facebook đã tô URL màu xanh trong editor dù preview
        // card chưa render. Đây là khác biệt trực quan giữa hai ảnh người dùng cung cấp.
        const hasBlueUrlText = Array.from(el.querySelectorAll('span,a,[data-lexical-text="true"]'))
          .some(node => {
            const text = node.textContent || '';
            if (!text.toLowerCase().includes(hostName.toLowerCase())) return false;
            const rgb = (getComputedStyle(node).color.match(/\d+/g) || []).map(Number);
            return rgb.length >= 3 && rgb[2] >= rgb[0] + 35 && rgb[2] >= rgb[1] + 10;
          });

        return {
          ready: hasRemoveButton || hasDomainLine || hasEditorLink || hasBlueUrlText,
          hasRemoveButton,
          hasDomainLine,
          hasEditorLink,
          hasBlueUrlText,
          editorText: (el.innerText || el.textContent || '').slice(0, 300),
        };
      }, host).catch(() => null);
      lastState = state;

      if (state && state.ready) {
        // Thẻ xem trước vừa hiện, chờ thêm chút cho ảnh/tiêu đề tải xong
        await this._sleep(1200);
        this._lastCommentLinkDebug = state;
        return true;
      }
      await this._sleep(600);
    }

    // The caller must not submit until Facebook has created a link entity or preview.
    this._lastCommentLinkDebug = lastState;
    return false;
  }

  async _submitComment(page, box) {
    const button = await box.evaluateHandle(el => {
      const norm = s => String(s || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
      const visible = node => {
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return r.width > 5 && r.height > 5
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      let root = el.closest('form');
      if (!root) {
        root = el;
        for (let i = 0; i < 9 && root.parentElement; i++) root = root.parentElement;
      }
      return Array.from(root.querySelectorAll('[role="button"], button, [aria-label]')).find(node =>
        visible(node) && /ang binh luan|post comment/.test(norm(
          (node.getAttribute('aria-label') || '') + ' ' + (node.innerText || '')
        ))
      ) || null;
    }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);

    if (button) {
      await button.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
      const rect = await button.boundingBox().catch(() => null);
      if (rect && rect.width > 0 && rect.height > 0) {
        await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
      } else {
        await button.click();
      }
      return;
    }
    await box.click().catch(() => {});
    await page.keyboard.press('Enter');
  }

  async _commentDomSnapshot(page, commentText = '') {
    const needle = String(commentText || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
    const urls = String(commentText || '').match(/https?:\/\/[^\s<>"']+/gi) || [];
    const hosts = urls.map(value => {
      try { return new URL(value).hostname.replace(/^www\./i, '').toLowerCase(); } catch (_) { return ''; }
    }).filter(Boolean);
    return page.evaluate((needle, hosts) => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const ids = [];
      for (const a of document.querySelectorAll('a[href*="comment_id="], a[href*="reply_comment_id="]')) {
        try {
          const u = new URL(a.href, location.href);
          const id = u.searchParams.get('comment_id') || u.searchParams.get('reply_comment_id');
          if (id && !ids.includes(id)) ids.push(id);
        } catch (_) {}
      }
      const candidates = Array.from(document.querySelectorAll('[role="article"], li, div'))
        .filter(e => e.children.length < 80 && e.getBoundingClientRect().height > 10);
      const matching = needle ? candidates.filter(e => norm(e.innerText).includes(needle)) : [];
      const textMatches = matching.length;
      const linkMatches = hosts.length ? matching.filter(container =>
        Array.from(container.querySelectorAll('a[href]')).some(anchor => {
          const text = norm(anchor.innerText || anchor.textContent);
          if (hosts.some(host => text.includes(host))) return true;
          try {
            const host = new URL(anchor.href, location.href).hostname
              .replace(/^www\./i, '').toLowerCase();
            return hosts.includes(host);
          } catch (_) {
            return false;
          }
        })
      ).length : 0;
      const previewMatches = hosts.length ? matching.filter(container =>
        Array.from(container.querySelectorAll('span,a,[dir="auto"]')).some(node => {
          const text = norm(node.textContent);
          return hosts.some(host => text === host);
        })
      ).length : 0;
      const mediaCount = candidates.reduce((count, e) => {
        const commentLink = e.querySelector('a[href*="comment_id="], a[href*="reply_comment_id="]');
        return count + (commentLink ? e.querySelectorAll('img,video').length : 0);
      }, 0);
      const normLabel = s => String(s || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
      const composerHasAttachment = Array.from(
        document.querySelectorAll('[aria-label], [role="button"]')
      ).some(e => {
        const r = e.getBoundingClientRect();
        if (r.width <= 5 || r.height <= 5) return false;
        return /go (anh|video)|remove (photo|video)/.test(normLabel(
          (e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')
        ));
      });
      return { ids, textMatches, linkMatches, previewMatches, mediaCount, composerHasAttachment };
    }, needle, hosts).catch(() => ({
      ids: [], textMatches: 0, linkMatches: 0, previewMatches: 0,
      mediaCount: 0, composerHasAttachment: false
    }));
  }

  async hasExistingComment(page, postLink, commentText = '', mediaPath = '') {
    await this._gotoCommentPermalink(page, postLink);
    await this._sleep(3500);
    const needle = String(commentText || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80);
    const hosts = (String(commentText || '').match(/https?:\/\/[^\s<>"']+/gi) || []).map(value => {
      try { return new URL(value).hostname.replace(/^www\./i, '').toLowerCase(); } catch (_) { return ''; }
    }).filter(Boolean);
    return page.evaluate((needle, wantsMedia, hosts) => {
      const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const anchors = Array.from(document.querySelectorAll('a[href*="comment_id="], a[href*="reply_comment_id="]'));
      return anchors.some(anchor => {
        let cur = anchor;
        for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
          const textOk = !needle || norm(cur.innerText).includes(needle);
          const mediaOk = !wantsMedia || !!cur.querySelector('img,video');
          const linkOk = !hosts.length || Array.from(cur.querySelectorAll('a[href]')).some(link => {
            const text = norm(link.innerText || link.textContent);
            if (hosts.some(host => text.includes(host))) return true;
            try {
              return hosts.includes(new URL(link.href, location.href).hostname
                .replace(/^www\./i, '').toLowerCase());
            } catch (_) {
              return false;
            }
          });
          if (textOk && mediaOk && linkOk) return true;
        }
        return false;
      });
    }, needle, !!mediaPath, hosts).catch(() => false);
  }

  async _gotoCommentPermalink(page, postLink) {
    return this._gotoFacebookPage(page, postLink, 30000);
  }

  async _gotoFacebookPage(page, url, timeout = 60000) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (error) {
      // Facebook may keep navigation pending while the permalink DOM is
      // already usable. Continue only when the target page and a real body
      // are present; otherwise preserve the original navigation failure.
      const usable = await page.evaluate((expected) => {
        try {
          const current = new URL(location.href);
          const target = new URL(expected);
          return current.hostname.endsWith('facebook.com')
            && target.hostname.endsWith('facebook.com')
            && !!document.body
            && (document.body.innerText || '').trim().length > 0;
        } catch (_) {
          return false;
        }
      }, url).catch(() => false);
      if (!usable) throw error;
      await page.evaluate(() => window.stop()).catch(() => {});
    }
  }

  // Lay permalink bai vua dang: cuon tim bai theo noi dung (needle), hover len link timestamp
  // ngay tren noi dung -> Facebook inject permalink that vao href (timestamp bi xao tron ky tu + href rong
  // cho toi khi hover). Doc href qua elementFromPoint. Day la cach on dinh nhat vi timeline ao hoa + href lazy.
  async capturePostLinkByHover(page, profileHref, content, owner, beforeLinks) {
    // Phai dung cung bo chuan hoa voi luc xac minh: bo emoji/dau cau, ha chu thuong.
    // Facebook render emoji thanh <img alt="..."> nen innerText KHONG chua emoji;
    // so khop chuoi tho se luon truot khi noi dung co emoji.
    const needle = normalizeFacebookCaption(content, 45);
    if (!needle) return '';
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    let own = { vanity: (owner && owner.vanity) || null, id: (owner && owner.id) || null };
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      // Resolve vanity tu canonical de _isOwnPostUrl khop dung (owner truyen vao co the thieu vanity).
      if (!own.vanity) {
        const v = await page.evaluate(() => {
          const c = document.querySelector('link[rel="canonical"]');
          try { const u = new URL((c && c.href) || location.href); const s = u.pathname.split('/').filter(Boolean); if (s[0] && s[0] !== 'profile.php') return s[0]; } catch (e) {}
          return null;
        }).catch(() => null);
        if (v) own.vanity = v;
      }
      // cuon cho toi khi co it nhat 1 bai chua needle xuat hien
      let found = false;
      for (let s = 0; s < 12 && !found; s++) {
        found = await page.evaluate((needle) => {
          const norm = x => String(x || '').normalize('NFC')
            .replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase()
            .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
          return Array.from(document.querySelectorAll('div,span,p')).some(e => e.children.length < 40 && norm(e.innerText).includes(needle));
        }, needle).catch(() => false);
        if (!found) { await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {}); await this._sleep(1200); }
      }
      if (!found) continue;
      await this._sleep(1500);

      // Duyet MOI node khop needle: scroll node vao giua, lay link timestamp NGAY TREN noi dung
      // va PHAI nam trong viewport (tranh loi node trung lap nam ngoai man hinh -> hover truot).
      const cands = await page.evaluate((needle) => {
        const norm = s => String(s || '').normalize('NFC')
          .replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase()
          .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
        const nodes = Array.from(document.querySelectorAll('div,span,p')).filter(e => e.children.length < 40 && norm(e.innerText).includes(needle));
        for (const node of nodes) {
          node.scrollIntoView({ block: 'center' });
          const nr = node.getBoundingClientRect();
          const ts = Array.from(document.querySelectorAll('a[role="link"], a[href]')).map(a => {
            const r = a.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: r.top, left: r.left, w: r.width, h: r.height };
          }).filter(a => a.w > 0 && a.h > 0 && a.h < 40 && a.top < nr.top - 8 && a.top > nr.top - 95
            && a.left >= nr.left - 30 && a.left < nr.left + 280
            && a.top > 40 && (a.top + a.h) < window.innerHeight - 20) // trong viewport
            .sort((p, q) => q.top - p.top)
            .slice(0, 4)
            .map(a => ({ x: a.x, y: a.y }));
          if (ts.length) return ts;
        }
        return [];
      }, needle).catch(() => []);

      for (const c of cands) {
        await page.mouse.move(c.x, c.y).catch(() => {});
        await this._sleep(1400);
        const href = await page.evaluate((xy) => {
          const el = document.elementFromPoint(xy.x, xy.y);
          const a = el && el.closest ? el.closest('a[href]') : null;
          return a ? a.href : '';
        }, c).catch(() => '');
        const clean = this.normalizeFacebookPostUrl(href);
        // reel/watch/videos khong mang vanity trong path nen _isOwnPostUrl khong xac thuc duoc,
        // nhung chung den tu timestamp cua dung bai (needle) nen chap nhan.
        const ownOrMedia = this._isOwnPostUrl(clean, own) || /\/(reel|watch|videos)\//.test(clean);
        if (clean && this.looksLikeFacebookPostUrl(clean) && ownOrMedia && !before.has(clean)) {
          return clean;
        }
      }
    }
    return '';
  }

  /**
   * Thu thap permalink video o dang Facebook dang phat hanh thuc te.
   * Khong chi dua vao ID so vi Reel moi co the dung token hoac URL share/watch.
   */
  async _mediaPermalinksFromTabs(page, profileHref, owner = null, content = '') {
    const tabUrls = [];
    const addTab = url => {
      if (url && !tabUrls.includes(url)) tabUrls.push(url);
    };
    const own = owner || {};
    const query = encodeURIComponent(
      String(content || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    );

    if (own.vanity) {
      const base = `https://www.facebook.com/${encodeURIComponent(String(own.vanity))}`;
      addTab(`${base}/reels/`);
      addTab(`${base}/videos`);
      if (query) addTab(`${base}/search/?q=${query}`);
    }
    if (own.id) {
      const base = `https://www.facebook.com/profile.php?id=${encodeURIComponent(String(own.id))}`;
      addTab(`${base}&sk=reels_tab`);
      addTab(`${base}&sk=videos`);
      if (query) addTab(`${base}&sk=search&q=${query}`);
    }

    if (tabUrls.length === 0) {
      try {
        await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(1500);
        const resolved = await page.evaluate(() => {
          const canonical = document.querySelector('link[rel="canonical"]');
          const og = document.querySelector('meta[property="og:url"]');
          return (canonical && canonical.href) || (og && og.content) || location.href;
        }).catch(() => (typeof page.url === 'function' ? page.url() : profileHref));
        const u = new URL(resolved || profileHref, 'https://www.facebook.com');
        const segs = u.pathname.split('/').filter(Boolean);
        if (/^profile\.php$/i.test(segs[0] || '') && u.searchParams.get('id')) {
          const base = `https://www.facebook.com/profile.php?id=${encodeURIComponent(u.searchParams.get('id'))}`;
          addTab(`${base}&sk=reels_tab`);
          addTab(`${base}&sk=videos`);
          if (query) addTab(`${base}&sk=search&q=${query}`);
        } else if (segs[0]) {
          const base = `https://www.facebook.com/${encodeURIComponent(decodeURIComponent(segs[0]))}`;
          addTab(`${base}/reels/`);
          addTab(`${base}/videos`);
          if (query) addTab(`${base}/search/?q=${query}`);
        }
      } catch (_) {}
    }

    const captionNeedle = normalizeFacebookCaption(content, 80);
    const links = new Map();
    const addLink = (href, score = 0) => {
      const clean = this.normalizeFacebookPostUrl(
        String(href || '')
          .replace(/\\u0025/gi, '%')
          .replace(/\\\//g, '/')
      );
      if (clean) {
        links.set(clean, Math.max(Number(score) || 0, links.get(clean) || 0));
      }
    };

    for (const url of tabUrls) {
      if (this.shouldStop) break;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(Math.floor(Math.random() * 1501) + 3000);
        for (let i = 0; i < 2; i++) {
          await page.mouse.wheel({ deltaY: 1400 }).catch(async () => {
            await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
          });
          await this._sleep(1200);
        }
        const found = await page.evaluate(needle => {
          const clean = value => String(value || '')
            .normalize('NFC')
            .replace(/[\u200b-\u200d\ufeff]/g, '')
            .toLowerCase()
            .replace(/[\p{P}\p{S}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const hrefs = Array.from(document.querySelectorAll('a[href]'))
            .map(anchor => {
              let context = anchor.closest('[role="article"]');
              for (let node = anchor, hops = 0; !context && node && hops < 6; hops += 1) {
                if (String(node.innerText || '').trim().length >= 40) context = node;
                node = node.parentElement;
              }
              return {
                href: anchor.href,
                score: needle && clean(context?.innerText || '').includes(needle) ? 100 : 0,
              };
            })
            .sort((a, b) => b.score - a.score);
          const html = String(document.documentElement?.innerHTML || '')
            .replace(/\\u0025/gi, '%')
            .replace(/\\\//g, '/');
          const patterns = [
            /(?:https?:\/\/(?:www\.)?facebook\.com)?\/(?:reel|videos|posts)\/[A-Za-z0-9._-]+\/?(?:\?[^"'<>\\\s]*)?/gi,
            /(?:https?:\/\/(?:www\.)?facebook\.com)?\/share\/r\/[A-Za-z0-9._-]+\/?(?:\?[^"'<>\\\s]*)?/gi,
            /(?:https?:\/\/(?:www\.)?facebook\.com)?\/watch\/?\?[^"'<>\\\s]*\bv=[A-Za-z0-9._-]+[^"'<>\\\s]*/gi,
            /(?:https?:\/\/(?:www\.)?facebook\.com)?\/video\.php\?[^"'<>\\\s]*\bv=[A-Za-z0-9._-]+[^"'<>\\\s]*/gi,
            /(?:https?:\/\/(?:www\.)?facebook\.com)?\/permalink\.php\?[^"'<>\\\s]*\bstory_fbid=[A-Za-z0-9._-]+[^"'<>\\\s]*/gi,
          ];
          for (const pattern of patterns) {
            const matches = html.match(pattern) || [];
            hrefs.push(...matches.slice(0, 80).map(href => ({ href, score: 0 })));
          }
          return hrefs.slice(0, 500);
        }, captionNeedle).catch(() => []);
        for (const item of found) addLink(item.href, item.score);
      } catch (_) {}
    }
    return [...links.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([href]) => href);
  }

  /**
   * Gom ID video moi nhat tu tab Reels va Video cua profile.
   * Facebook co the dung URL vanity (/user/reels/) hoac profile.php?id=...&sk=...
   * Giu method nay de tuong thich voi cac client/test cu.
   */
  async _reelIdsFromTabs(page, profileHref, owner = null) {
    const tabUrls = [];
    const add = (url) => {
      if (url && !tabUrls.includes(url)) tabUrls.push(url);
    };

    const own = owner || {};
    if (own.vanity) {
      const base = `https://www.facebook.com/${encodeURIComponent(String(own.vanity))}`;
      add(`${base}/reels/`);
      add(`${base}/videos`);
    }
    if (own.id) {
      const base = `https://www.facebook.com/profile.php?id=${encodeURIComponent(String(own.id))}`;
      add(`${base}&sk=reels_tab`);
      add(`${base}&sk=videos`);
    }

    // Neu owner thieu vanity/id, thu chuan hoa tu URL/canonical cua trang profile.
    if (tabUrls.length === 0) {
      try {
        await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(1500);
        const resolved = await page.evaluate(() => {
          const canonical = document.querySelector('link[rel="canonical"]');
          return (canonical && canonical.href) || location.href;
        }).catch(() => page.url());
        const u = new URL(resolved || profileHref, 'https://www.facebook.com');
        const segs = u.pathname.split('/').filter(Boolean);
        if (/^profile\.php$/i.test(segs[0] || '') && u.searchParams.get('id')) {
          const base = `https://www.facebook.com/profile.php?id=${encodeURIComponent(u.searchParams.get('id'))}`;
          add(`${base}&sk=reels_tab`);
          add(`${base}&sk=videos`);
        } else if (segs[0]) {
          const base = `https://www.facebook.com/${encodeURIComponent(decodeURIComponent(segs[0]))}`;
          add(`${base}/reels/`);
          add(`${base}/videos`);
        }
      } catch (_) {}
    }

    const ids = [];
    for (const url of tabUrls) {
      if (this.shouldStop) break;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(Math.floor(Math.random() * 1501) + 3000);
        for (let i = 0; i < 2; i++) {
          await page.mouse.wheel({ deltaY: 1400 }).catch(async () => {
            await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
          });
          await this._sleep(1200);
        }
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
        ).catch(() => []);
        for (const href of hrefs) {
          const match = String(href || '').match(/\/(?:reel|videos)\/(\d+)/i);
          if (match && !ids.includes(match[1])) ids.push(match[1]);
        }
      } catch (_) {}
    }
    return ids;
  }

  /**
   * Video tren profile thuong thanh Reel va khong xuat hien trong card timeline.
   * Mo cac Reel moi nhat, doi chieu caption that roi moi tra permalink.
   */
  async captureReelByCaption(
    page,
    profileHref,
    content,
    owner = null,
    maxCheck = 6,
    publishedAtMs = 0
  ) {
    const needle = normalizeFacebookCaption(content, 120);
    if (!needle) return '';
    // Trang Reel thuong cat caption dai kem "Xem them" nen 120 ky tu co the khong bao gio khop.
    // Giu them mot moc ngan de van nhan ra dung bai (van con doi chieu thoi diem dang).
    const shortNeedle = normalizeFacebookCaption(content, 60);

    const candidates = await this._mediaPermalinksFromTabs(
      page,
      profileHref,
      owner,
      content
    );
    if (candidates.length === 0) {
      const ids = await this._reelIdsFromTabs(page, profileHref, owner);
      for (const id of ids) {
        const legacy = `https://www.facebook.com/reel/${id}`;
        if (!candidates.includes(legacy)) candidates.push(legacy);
      }
    }

    for (const candidate of candidates.slice(0, Math.max(1, maxCheck))) {
      if (this.shouldStop) break;
      try {
        await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this._sleep(Math.floor(Math.random() * 1301) + 2500);
        const body = await page.evaluate(() =>
          String(document.body.innerText || '')
        ).catch(() => '');
        const cleanBody = normalizeFacebookCaption(body);
        const fullMatch = cleanBody.includes(needle);
        if (!fullMatch && !(shortNeedle && cleanBody.includes(shortNeedle))) continue;
        if (publishedAtMs) {
          const timing = await this._pagePublishedNear(
            page,
            publishedAtMs,
            2 * 60 * 60 * 1000,
            { content }
          );
          // Some Reel pages omit all timestamp metadata. An exact, long caption
          // match is still safer than permanently losing the successful post.
          if (timing.timestamps.length > 0 && !timing.matched) continue;
          // Chi khop doan caption ngan thi bang chung yeu hon -> bat buoc phai
          // khop them thoi diem dang, tranh nhan nham mot Reel cu cung mo dau.
          if (!fullMatch && !timing.matched) continue;
        }
        const canonical = await page.evaluate(() => {
          const link = document.querySelector('link[rel="canonical"]');
          const og = document.querySelector('meta[property="og:url"]');
          return (link && link.href) || (og && og.content) || location.href;
        }).catch(() => (typeof page.url === 'function' ? page.url() : candidate));
        return this.normalizeFacebookPostUrl(canonical)
          || this.normalizeFacebookPostUrl(candidate)
          || '';
      } catch (_) {}
    }
    return '';
  }

  async _pagePublishedNear(
    page,
    publishedAtMs,
    toleranceMs = 2 * 60 * 60 * 1000,
    options = {}
  ) {
    const expected = Number(publishedAtMs) || 0;
    if (!expected) return { matched: true, timestamps: [] };
    const expectedCaption = normalizeFacebookCaption(options.content, 80);
    const timestamps = await page.evaluate((captionNeedle) => {
      const values = [];
      const add = value => {
        let timestamp = Number(value);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return;
        if (timestamp < 100000000000) timestamp *= 1000;
        if (timestamp >= Date.UTC(2004, 0, 1) && timestamp <= Date.now() + 86400000) {
          values.push(timestamp);
        }
      };
      const clean = value => String(value || '')
        .normalize('NFC')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const articles = Array.from(document.querySelectorAll('[role="article"]'));
      const scope = captionNeedle
        ? articles.find(article => clean(article.innerText).includes(captionNeedle))
        : null;
      const root = scope || document;
      for (const element of root.querySelectorAll('[data-utime], time[datetime], [datetime]')) {
        if (scope && element.closest('[role="article"]') !== scope) continue;
        add(element.getAttribute('data-utime'));
        const parsed = Date.parse(element.getAttribute('datetime') || '');
        if (Number.isFinite(parsed)) add(parsed);
      }
      let html = scope ? scope.cloneNode(true) : document.documentElement.cloneNode(true);
      if (scope) {
        for (const nested of html.querySelectorAll('[role="article"]')) {
          nested.remove();
        }
      }
      html = html.innerHTML;
      const patterns = [
        /"creation_time"\s*:\s*(\d{9,13})/g,
        /"publish_time"\s*:\s*(\d{9,13})/g,
        /"created_time"\s*:\s*(\d{9,13})/g,
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(html)) && values.length < 200) add(match[1]);
      }
      return [...new Set(values)];
    }, expectedCaption).catch(() => []);
    return {
      matched: publishedTimeMatches(
        timestamps,
        expected,
        toleranceMs,
        options.allowAfter === true
      ),
      timestamps,
    };
  }

  async verifyPublishedPostCandidate(page, postLink, content, publishedAtMs, options = {}) {
    const normalized = this.normalizeFacebookPostUrl(postLink)
      || this.normalizeFacebookGroupPostUrl(postLink, postLink);
    if (!normalized) return { matched: false, reason: 'invalid_permalink', timestamps: [] };
    await this._gotoFacebookPage(page, normalized, 60000);
    await this._sleep(1800);
    const body = await page.evaluate(() => String(document.body?.innerText || ''))
      .catch(() => '');
    const needle = normalizeFacebookCaption(content, 80);
    if (needle && !normalizeFacebookCaption(body).includes(needle)) {
      return { matched: false, reason: 'caption_mismatch', timestamps: [] };
    }
    const timing = await this._pagePublishedNear(
      page,
      publishedAtMs,
      2 * 60 * 60 * 1000,
      {
        content,
        allowAfter: options.allowPublishedAfter === true,
      }
    );
    return {
      matched: timing.matched,
      reason: timing.matched ? '' : 'publish_time_mismatch',
      timestamps: timing.timestamps,
      postLink: normalized,
    };
  }

  async getFacebookTimelineHref(page) {
    const href = await page.evaluate(() => {
      const pick = (a) => a && a.href && /^https:\/\/www\.facebook\.com\//.test(a.href) ? a.href : '';
      const direct = Array.from(document.querySelectorAll('a[role="link"][aria-label*="Dòng thời gian"]'))[0];
      const norm = value => String(value || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      const directBilingual = Array.from(
        document.querySelectorAll('a[role="link"][aria-label]')
      ).find(anchor => {
        const label = norm(anchor.getAttribute('aria-label'));
        return label.includes('dong thoi gian') || label.includes('timeline');
      });
      const timelineLink = directBilingual || direct;
      if (pick(timelineLink)) return timelineLink.href;
      const imgLink = Array.from(document.querySelectorAll('a[role="link"][href*="facebook.com/"]')).find(a => a.querySelector('image, img, svg'));
      return pick(imgLink);
    }).catch(() => '');
    return this.normalizeFacebookPostUrl(href, true);
  }

  normalizeFacebookPostUrl(href, keepProfile = false) {
    if (!href) return '';
    try {
      const u = new URL(href, 'https://www.facebook.com');
      const host = u.hostname.replace(/^(www|m|mbasic|touch|web)\./, '');
      if (host !== 'facebook.com') return '';
      u.protocol = 'https:';
      u.hostname = 'www.facebook.com';
      const dropExact = new Set(['__tn__', 'comment_id', 'reply_comment_id', 'reply_comment_ids', 'refid', 'ref', '_rdr', 'eav', 'sfnsn', 'mibextid', 'paipv', 'rdid', 'notif_t', 'notif_id', 'idorvanity']);
      for (const key of Array.from(u.searchParams.keys())) {
        if (key.startsWith('__cft__') || dropExact.has(key)) u.searchParams.delete(key);
      }
      if (!keepProfile && !this.looksLikeFacebookPostUrl(u.toString())) return '';
      return u.toString();
    } catch { return ''; }
  }

  looksLikeFacebookPostUrl(href) {
    // Bao gom ca video/reel/watch (FB thuong dang video ngan thanh Reel -> permalink dang /reel/<id>).
    // /share/p/<token> la dinh dang link FB tra ra khi bam "Sao chep lien ket" hien nay.
    return /\/posts\/|\/permalink\/|\/permalink\.php|\/photo(?:\.php|s\/)|\/videos\/|\/video\.php|\/reel\/|\/share\/[pr]\/|\/watch\/|story_fbid=|fbid=|\bv=|multi_permalinks=/.test(String(href || ''));
  }

  async prepareTimelineForScan(page) {
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      await this._sleep(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this._sleep(1500);
  }

  async scanTimelinePostLinks(page, limit = 20) {
    await this.prepareTimelineForScan(page);
    const raw = await page.evaluate((limit) => {
      const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, limit);
      const fromArticles = articles.flatMap((article, articleIndex) => {
        const text = article.innerText || '';
        return Array.from(article.querySelectorAll('a[href]')).map(a => ({ articleIndex, text, href: a.href }));
      });
      const global = Array.from(document.querySelectorAll('a[href]'))
        .map((a, i) => ({ articleIndex: 1000 + i, text: a.innerText || a.getAttribute('aria-label') || '', href: a.href }));
      return fromArticles.concat(global).slice(0, 800);
    }, limit).catch(() => []);
    return [...new Set(raw.map(x => this.normalizeFacebookPostUrl(x.href)).filter(h => h && this.looksLikeFacebookPostUrl(h)))];
  }


  async scanTopOwnPostLinks(page, profileHref, owner = null, limit = 3) {
    await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await this._sleep(3500);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this._sleep(1000);
    return await this._extractTopOwnPostLinks(page, owner, limit);
  }

  // Chup `limit` bai dau timeline. Tren timeline moi, link timestamp cua bai
  // thuong chi co href that sau khi hover nen phai hover tung bai de lay permalink
  // thay vi chi doc a[href] tinh (truoc day anh chup "before" hay bi rong).
  async scanTimelineTopPosts(page, profileHref, limit = FACEBOOK_TIMELINE_LIMIT, options = {}) {
    if (options.navigate !== false) {
      await this._gotoFacebookPage(page, profileHref, 60000).catch(() => {});
      await this._sleep(3500);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this._sleep(800);

    // Timeline moi duoc "ao hoa" (data-virtualized + hidden): bai nam ngoai viewport
    // bi rong hoan toan (khong text, khong <a>). Phai cuon tung bai vao man hinh va
    // cho Facebook render xong roi moi doc duoc link/timestamp.
    const focusPost = index => page.evaluate((index) => {
      const root = document.querySelector('[role="main"]') || document;
      const topLevel = (list, selector) => list.filter(el =>
        !(el.parentElement && el.parentElement.closest(selector))
      );
      let posts = topLevel(Array.from(root.querySelectorAll('[aria-posinset]')), '[aria-posinset]');
      if (!posts.length) posts = topLevel(Array.from(root.querySelectorAll('[role="article"]')), '[role="article"]');
      posts = posts.filter(el => el.getBoundingClientRect().height > 120);
      const el = posts[index];
      if (!el) return null;
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -110);
      const rendered = !el.querySelector('[data-virtualized="true"]')
        && (el.innerText || '').trim().length > 0;
      return { rendered, count: posts.length };
    }, index).catch(() => null);

    const posts = [];
    for (let index = 0; index < limit; index++) {
      let located = await focusPost(index);
      if (!located) break;
      for (let wait = 0; wait < 12 && !located.rendered; wait++) {
        await this._sleep(500);
        located = await focusPost(index);
        if (!located) break;
      }
      if (!located) break;
      const info = await page.evaluate((index) => {
        const root = document.querySelector('[role="main"]') || document;
        const topLevel = (list, selector) => list.filter(el =>
          !(el.parentElement && el.parentElement.closest(selector))
        );
        let posts = topLevel(Array.from(root.querySelectorAll('[aria-posinset]')), '[aria-posinset]');
        if (!posts.length) posts = topLevel(Array.from(root.querySelectorAll('[role="article"]')), '[role="article"]');
        posts = posts.filter(el => el.getBoundingClientRect().height > 120);
        const article = posts[index];
        if (!article) return null;
        const rect = article.getBoundingClientRect();
        const hrefs = Array.from(article.querySelectorAll('a[href]')).map(a => a.href);
        // Ung vien timestamp: link ngan o phan dau bai, nam trong viewport.
        const hoverTargets = Array.from(article.querySelectorAll('a[role="link"], a[href]')).map(a => {
          const r = a.getBoundingClientRect();
          return {
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
            top: r.top, h: r.height, w: r.width,
            text: (a.innerText || a.getAttribute('aria-label') || '').trim(),
          };
        }).filter(a => a.w > 0 && a.h > 0 && a.h < 40 && a.w < 260
          && a.text.length > 0 && a.text.length < 40
          && a.top >= rect.top && a.top < rect.top + 200
          && a.top > 40 && a.top + a.h < window.innerHeight - 20)
          .slice(0, 4)
          .map(a => ({ x: a.x, y: a.y }));
        // innerText cua bai bat dau bang hang chuc span "Facebook" an ngoai man hinh
        // (x < -9000) nen caption bi day ra sau; doc rieng khoi noi dung thay vi innerText.
        // Ban day du cua caption nam trong node an (chi hien sau "Xem them") nen khong loc
        // theo kich thuoc; dung textContent de lay ca phan chua hien.
        const captionNodes = Array.from(article.querySelectorAll(
          '[data-ad-preview="message"], [data-ad-comet-preview="message"], div[dir="auto"], span[dir="auto"]'
        ));
        const captionText = [...new Set(captionNodes
          .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(value => value.length > 0 && !/^facebook$/i.test(value)))]
          .sort((a, b) => b.length - a.length)
          .slice(0, 3)
          .join(' ');
        const fallbackText = (article.innerText || '').replace(/(?:\bFacebook\b\s*){3,}/gi, ' ');
        return {
          text: (captionText || fallbackText).slice(0, 1500),
          hrefs,
          hoverTargets,
          count: posts.length,
        };
      }, index).catch(() => null);
      if (!info) break;

      const keys = new Set();
      const addKey = href => {
        const clean = this.normalizeFacebookPostUrl(href);
        if (clean && this.looksLikeFacebookPostUrl(clean)) keys.add(clean);
      };
      info.hrefs.forEach(addKey);
      const hasPermalink = () => [...keys].some(h => /\/posts\/|permalink|story_fbid=/.test(h));
      for (const target of info.hoverTargets) {
        if (hasPermalink()) break;
        await page.mouse.move(target.x, target.y).catch(() => {});
        await this._sleep(1200);
        const href = await page.evaluate((xy) => {
          const el = document.elementFromPoint(xy.x, xy.y);
          const a = el && el.closest ? el.closest('a[href]') : null;
          return a ? a.href : '';
        }, target).catch(() => '');
        addKey(href);
      }
      posts.push({ index, keys: [...keys], text: normalizeFacebookCaption(info.text, 600) });
    }
    await page.mouse.move(5, 5).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    return posts;
  }

  // So sanh 5 bai dau timeline truoc/sau khi dang: bai co permalink chua co trong
  // anh chup truoc la bai vua dang. Nhieu bai moi thi chon bai khop noi dung.
  async captureNewTimelineTopPostLink(page, profileHref, beforePosts, content = '', options = {}) {
    const limit = Number(options.limit) || FACEBOOK_TIMELINE_LIMIT;
    const attempts = Math.max(1, Number(options.attempts) || 4);
    const owner = options.owner || null;
    const before = Array.isArray(beforePosts) ? beforePosts : [];
    const beforeKeys = new Set(before.flatMap(post => post.keys || []));
    const needle = normalizeFacebookCaption(content, 60);
    // Bai anh tren timeline nhieu khi chi lo link /photo/?fbid=... (khong co /posts/),
    // van la permalink hop le cua bai do.
    const permalinkRank = href => (
      /\/posts\/|\/permalink\/|permalink\.php|story_fbid=/.test(href) ? 0
        : /\/photo\/?\?.*fbid=|\/photo\.php/.test(href) ? 1
          : -1
    );
    const isPermalink = href => permalinkRank(href) >= 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (this.shouldStop) break;
      const after = await this.scanTimelineTopPosts(page, profileHref, limit);
      const fresh = after
        .map(post => ({
          ...post,
          newKeys: (post.keys || []).filter(key => isPermalink(key) && !beforeKeys.has(key)),
        }))
        .filter(post => post.newKeys.length > 0);
      let picked = null;
      const matchesNeedle = post => Boolean(needle) && post.text.includes(needle);
      if (fresh.length === 1) {
        const only = fresh[0];
        // Khong co anh chup truoc thi chi tin khi noi dung khop, hoac timeline truoc do
        // hoan toan trong va gio dung mot bai (bai ghim luon nam tren cung nen khong tin
        // "bai dau tien" mot cach mu quang).
        if (beforeKeys.size > 0 || matchesNeedle(only) || (before.length === 0 && after.length === 1)) {
          picked = only;
        }
      } else if (fresh.length > 1) {
        picked = fresh.find(matchesNeedle) || null;
      }
      const ranked = picked
        ? [...picked.newKeys].sort((a, b) =>
          (permalinkRank(a) - permalinkRank(b))
          || (Number(this._isOwnPostUrl(b, owner)) - Number(this._isOwnPostUrl(a, owner))))
        : [];
      const link = ranked[0] || '';
      try {
        fs.writeFileSync(path.join(__dirname, '..', '..', 'capture-debug-top5.json'), JSON.stringify({
          attempt, profileHref, owner, needle,
          before: before.map(post => ({ index: post.index, keys: post.keys, text: post.text.slice(0, 80) })),
          after: after.map(post => ({ index: post.index, keys: post.keys, text: post.text.slice(0, 80) })),
          fresh: fresh.map(post => ({ index: post.index, newKeys: post.newKeys })),
          link,
        }, null, 2));
      } catch (_) {}
      if (link) return link;
      await this._sleep(4000 + attempt * 1500);
    }
    return '';
  }

  async captureNewTopOwnPostLink(page, profileHref, beforeLinks, owner = null, limit = 3) {
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    // Khong co anh chup truoc khi dang thi "link dau timeline" khong chung minh duoc
    // day la bai vua dang (bai ghim luon nam tren cung) -> de cho cac cach khac xu ly.
    if (before.size === 0) return '';
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this._sleep(1000);
      const after = await this._extractTopOwnPostLinks(page, owner, limit);
      const found = after.find(h => !before.has(h));
      try {
        fs.writeFileSync(path.join(__dirname, '..', '..', 'capture-debug-top3.json'), JSON.stringify({
          attempt, owner, profileHref, before: [...before], after, found
        }, null, 2));
      } catch (e) {}
      if (found) return found;
    }
    return '';
  }

  // options.wide = true: dung cho anh chup "truoc khi dang" (beforeLinks).
  // Khi do lay CA link anh/video/reel va bo qua kiem tra chu so huu,
  // vi muc dich la biet nhung link nao DA co san chu khong phai chon bai.
  async _extractTopOwnPostLinks(page, owner = null, limit = 3, options = {}) {
    const wide = options.wide === true;
    const raw = await page.evaluate((limit, owner, wide) => {
      const vanity = owner && owner.vanity ? String(owner.vanity).toLowerCase() : '';
      const id = owner && owner.id ? String(owner.id) : '';
      // Anh chup "truoc khi dang" phai bao gom CA bai anh/video/reel, khong chi /posts/.
      // Neu bo sot, tap `before` se rong va buoc tim link moi se nham sang bai ghim/bai cu.
      const WIDE_RE = /\/posts\/|\/permalink\/|\/permalink\.php|\/photo(?:\.php|s?\/)|\/videos\/|\/video\.php|\/reel\/|\/share\/[pr]\/|\/watch\/|story_fbid=|fbid=|multi_permalinks=/;
      const NARROW_RE = /\/posts\/|\/permalink\/|story_fbid=|multi_permalinks=/;
      const isPost = (href) => {
        const s = String(href || '');
        if (!(wide ? WIDE_RE : NARROW_RE).test(s)) return false;
        if (wide) return true;
        try {
          const u = new URL(s, location.href);
          const first = decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
          if (vanity && first === vanity && /\/posts\//.test(u.pathname)) return true;
          if (id && u.searchParams.get('id') === id) return true;
          if (id && first === id) return true;
          return !vanity && !id;
        } catch (_) { return false; }
      };
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a, i) => {
          const r = a.getBoundingClientRect();
          const article = a.closest('[role="article"]');
          return { i, top: Math.round(r.top), left: Math.round(r.left), href: a.href, text: ((article && article.innerText) || a.innerText || a.getAttribute('aria-label') || '').slice(0, 300) };
        })
        .filter(x => isPost(x.href))
        .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.i - b.i))
        .slice(0, wide ? 400 : Math.max(limit * 5, 30));
    }, limit, owner || {}, wide).catch(() => []);
    const seen = new Set();
    const links = [];
    const cap = wide ? 400 : limit;
    for (const x of raw) {
      const clean = this.normalizeFacebookPostUrl(x.href);
      if (!clean) continue;
      if (wide) {
        if (!this.looksLikeFacebookPostUrl(clean)) continue;
      } else {
        if (!/\/posts\/|permalink|story_fbid=/.test(clean)) continue;
        if (!this._isOwnPostUrl(clean, owner)) continue;
      }
      if (seen.has(clean)) continue;
      seen.add(clean);
      links.push(clean);
      if (links.length >= cap) break;
    }
    return links;
  }

  async captureNewTimelinePostLink(page, profileHref, beforeLinks, content = '', owner = null) {
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    const needle = normalizeFacebookCaption(content, 60);
    const isGoodPost = (h) => /\/posts\/|permalink|story_fbid=/.test(h);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this._sleep(800);
      // Bài mới thường không nằm trong [role=article] -> tìm permalink ngay quanh vùng text bài mới
      const nearLink = await this._captureNewPostNearText(page, needle, before, owner);
      if (nearLink) return nearLink;
      await this.prepareTimelineForScan(page);
      const scan = await page.evaluate((limit, needle) => {
        const norm = (s) => String(s || '').normalize('NFC')
          .replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase()
          .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
        const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, limit);
        const fromArticles = articles.flatMap((article, articleIndex) => {
          const text = article.innerText || '';
          return Array.from(article.querySelectorAll('a[href]')).map(a => ({ articleIndex, text: text.slice(0, 1200), href: a.href }));
        });
        const global = Array.from(document.querySelectorAll('a[href]'))
          .map((a, i) => ({ articleIndex: 1000 + i, text: (a.innerText || a.getAttribute('aria-label') || '').slice(0, 1200), href: a.href }));
        const needleArt = needle ? articles.find(a => norm(a.innerText).includes(needle)) : null;
        let needleHrefs = [];
        if (needle) {
          const els = Array.from(document.querySelectorAll('div,span,article,section,li'));
          let node = null;
          for (const e of els) { if (norm(e.innerText).includes(needle) && e.children.length < 30) node = e; }
          let cur = node, hops = 0;
          while (cur && hops < 12) {
            const hs = Array.from(cur.querySelectorAll('a[href]')).map(a => a.href);
            if (hs.some(h => /\/posts\/|permalink|story_fbid=|photo|fbid=/.test(h))) { needleHrefs = [...new Set(hs)].slice(0, 40); break; }
            cur = cur.parentElement; hops++;
          }
        }
        return {
          links: fromArticles.concat(global).slice(0, 800),
          needleFound: !!needleArt,
          bodyHasNeedle: needle ? norm(document.body.innerText).includes(needle) : false,
          articleCount: articles.length,
          needleHrefs
        };
      }, 20, needle).catch(() => ({ links: [], needleFound: false, bodyHasNeedle: false, articleCount: 0, needleHrefs: [] }));
      const raw = scan.links || [];
      const normed = raw.map(x => ({ ...x, href: this.normalizeFacebookPostUrl(x.href) }))
        .filter(x => x.href && this.looksLikeFacebookPostUrl(x.href));
      const picked = normed
        .filter(x => !before.has(x.href) && this._isOwnPostUrl(x.href, owner))
        .map(x => ({
          ...x,
          score: (needle && normalizeFacebookCaption(x.text).includes(needle) ? 100 : 0)
            + (20 - Math.min(x.articleIndex, 20))
            + (/\/posts\//.test(x.href) ? 5 : 0),
        }))
        .sort((a,b)=>b.score-a.score)[0];
      try {
        fs.writeFileSync(path.join(__dirname, '..', '..', 'capture-debug-desktop.json'), JSON.stringify({
          attempt, profileHref, pageUrl: page.url(), owner, needle, beforeSize: before.size,
          needleFound: scan.needleFound, bodyHasNeedle: scan.bodyHasNeedle, articleCount: scan.articleCount,
          needleHrefs: scan.needleHrefs,
          ownAll: [...new Set(normed.filter(x => this._isOwnPostUrl(x.href, owner)).map(x => x.href))].slice(0, 15),
          ownNew: [...new Set(normed.filter(x => !before.has(x.href) && this._isOwnPostUrl(x.href, owner)).map(x => x.href))].slice(0, 15),
          picked: picked ? { href: picked.href, score: picked.score } : null
        }, null, 2));
      } catch (e) {}
      // Chi nhan link khi CHAC CHAN la bai vua dang:
      //  - hoac card chua dung caption (score >= 100),
      //  - hoac co anh chup truoc khi dang (before) de biet day la link MOI.
      // Neu ca hai deu khong co thi link dau timeline rat de la bai ghim/bai cu.
      const trustworthy = picked && picked.score >= 100 ? true : before.size > 0;
      if (picked && picked.href && picked.score > 0 && trustworthy
        && /\/posts\/|permalink|story_fbid=/.test(picked.href)) return picked.href;
    }
    return '';
  }

  // Lấy danh tính chủ account đang đăng: vanity (username) + numeric id (từ cookie c_user)
  async getProfileOwner(page, profileHref, options = {}) {
    const includeSessionId = options.includeSessionId !== false;
    let vanity = null, id = null;
    try {
      const u = new URL(profileHref, 'https://www.facebook.com');
      const segs = u.pathname.split('/').filter(Boolean);
      if (/^profile\.php$/i.test(segs[0] || '')) {
        id = u.searchParams.get('id') || null;
      } else if (/^(people|pages)$/i.test(segs[0] || '') && /^\d+$/.test(segs[segs.length - 1] || '')) {
        id = segs[segs.length - 1];
      } else if (segs[0] && !/^(people|pages|groups|watch|story\.php|permalink\.php|photo\.php)$/i.test(segs[0])) {
        vanity = decodeURIComponent(segs[0]);
      }
    } catch (_) {}
    try {
      if (!includeSessionId) return { vanity, id };
      const cookies = await page.cookies('https://www.facebook.com');
      const c = cookies.find(x => x.name === 'c_user');
      if (c && c.value) id = c.value;
    } catch (_) {}
    return { vanity, id };
  }

  // Đọc danh tính chủ trang từ chính trang profile đang mở (canonical/og:url) để lấy được vanity khi profileHref là dạng số
  async _readOwnerFromPage(page) {
    return await page.evaluate(() => {
      const out = { vanity: null, id: null };
      const can = document.querySelector('link[rel="canonical"]');
      const og = document.querySelector('meta[property="og:url"]');
      const urls = [
        can && can.href,
        og && og.content,
        location.href,
      ].filter(Boolean);
      for (const value of urls) {
        try {
          const u = new URL(value);
          const segs = u.pathname.split('/').filter(Boolean);
          if (/^profile\.php$/i.test(segs[0] || '')) {
            if (!out.id) out.id = u.searchParams.get('id');
          } else if (
            !out.vanity
            && segs[0]
            && !/^(people|pages|groups|watch|story\.php|permalink\.php|photo\.php)$/i.test(segs[0])
          ) {
            out.vanity = decodeURIComponent(segs[0]);
          }
        } catch (e) {}
      }
      try {
        const html = document.documentElement.innerHTML;
        const m = html.match(/"userID":"(\d+)"/) || html.match(/"entity_id":"(\d+)"/) || html.match(/"owner_id":"(\d+)"/);
        if (m && !out.id) out.id = m[1];
      } catch (e) {}
      return out;
    }).catch(() => ({ vanity: null, id: null }));
  }

  _mergeOwner(a, b) {
    a = a || {}; b = b || {};
    return { vanity: a.vanity || b.vanity || null, id: a.id || b.id || null };
  }

  // Lấy nhanh vanity/id chủ account từ canonical của trang mobile (không quét bài) — mobile trả canonical ổn định hơn desktop

  // Link có thuộc đúng account đang đăng không (chống lấy nhầm bài người khác trên timeline)
  _isOwnPostUrl(href, owner) {
    if (!owner || (!owner.vanity && !owner.id)) return true;
    try {
      const u = new URL(href, 'https://www.facebook.com');
      const idParam = u.searchParams.get('id');
      if (owner.id && idParam && String(idParam) === String(owner.id)) return true;
      // áº¢nh: owner id náº±m trong set=pb.<id>.- hoáº·c set=a....<id>
      const setParam = u.searchParams.get('set') || '';
      if (owner.id && new RegExp('(?:^|[.:])' + owner.id + '(?:[.:]|$)').test(setParam)) return true;
      const segs = u.pathname.split('/').filter(Boolean);
      const first = segs[0] ? decodeURIComponent(segs[0]).toLowerCase() : '';
      if (owner.vanity && first === String(owner.vanity).toLowerCase()) return true;
      if (owner.id && first === String(owner.id)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  // Tìm permalink của bài vừa đăng bằng cách leo DOM từ chính đoạn text nội dung (không phụ thuộc [role=article])
  async _captureNewPostNearText(page, needle, before, owner) {
    if (!needle) return '';
    const pick = (href) => {
      const clean = this.normalizeFacebookPostUrl(href);
      if (clean && !before.has(clean) && this._isOwnPostUrl(clean, owner) && /\/posts\/|permalink|story_fbid=/.test(clean)) return clean;
      return '';
    };
    try {
      const containerHandle = await page.evaluateHandle((needle) => {
        const norm = (s) => String(s || '').normalize('NFC')
          .replace(/[\u200b-\u200d\ufeff]/g, '').toLowerCase()
          .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
        const els = Array.from(document.querySelectorAll('div,span,article,section,li'));
        let node = null;
        for (const e of els) { if (norm(e.innerText).includes(needle) && e.children.length < 30) node = e; }
        if (!node) return null;
        let cur = node, hops = 0;
        while (cur && hops < 12) {
          const has = Array.from(cur.querySelectorAll('a[href]')).some(a => /\/posts\/|permalink|story_fbid=|photo|fbid=/.test(a.href));
          if (has) return cur;
          cur = cur.parentElement; hops++;
        }
        return node;
      }, needle);
      const el = containerHandle && containerHandle.asElement ? containerHandle.asElement() : null;
      if (!el) return '';
      const anchors = await el.$$('a[href]');
      // Vòng 1: dùng href sẵn có
      for (const a of anchors) {
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
      // Vòng 2: hover để Facebook gắn permalink
      for (const a of anchors.slice(0, 20)) {
        try { await a.hover(); } catch (_) {}
        await this._sleep(400);
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
    } catch (_) {}
    return '';
  }

  // Hover các link trong bài khớp nội dung để Facebook lộ permalink timestamp, rồi lấy link bài của đúng chủ account
  async _hoverRevealPostLink(page, needle, before, owner) {
    try {
      const artHandle = await page.evaluateHandle((needle) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ');
        const arts = Array.from(document.querySelectorAll('[role="article"]'));
        if (needle) { const m = arts.find(a => norm(a.innerText).includes(needle)); if (m) return m; }
        return arts[0] || null;
      }, needle);
      const artEl = artHandle && artHandle.asElement ? artHandle.asElement() : null;
      if (!artEl) return '';
      const anchors = await artEl.$$('a[role="link"], a[href]');
      for (const a of anchors.slice(0, 14)) {
        try { await a.hover(); } catch (_) {}
        await this._sleep(500);
        const href = await page.evaluate(el => el.href, a).catch(() => '');
        const clean = this.normalizeFacebookPostUrl(href);
        if (clean && this.looksLikeFacebookPostUrl(clean) && !before.has(clean)
          && this._isOwnPostUrl(clean, owner) && /\/posts\/|permalink|story_fbid=/.test(clean)) {
          return clean;
        }
      }
    } catch (_) {}
    return '';
  }

  /**
   * Stop the runner gracefully
   */
  _sleep(ms) {
    return this.sleep(ms);
  }
}

const FacebookAdapter = {
  publish(page, post, options = {}) {
    return new FacebookAutomation(options).publish(page, post);
  },

  resolvePublishTarget(post, options = {}) {
    return new FacebookAutomation(options).resolvePublishTarget(post);
  },

  comment(page, postLink, commentText = '', mediaPath = '', options = {}) {
    const automation = new FacebookAutomation(options);
    if (options.manageIdentity !== true) {
      return automation.commentOnPost(page, postLink, commentText, mediaPath);
    }
    return automation._withRestoredProfileIdentity(page, async () => {
      await automation._prepareGroupIdentity(page, options.identityPageUrl || '');
      return automation.commentOnPost(page, postLink, commentText, mediaPath);
    });
  },

  hasExistingComment(page, postLink, commentText = '', mediaPath = '') {
    return new FacebookAutomation().hasExistingComment(page, postLink, commentText, mediaPath);
  },

  validateSession(page) {
    return page.cookies('https://www.facebook.com')
      .then(cookies => cookies.some(cookie => cookie.name === 'c_user' && cookie.value))
      .catch(() => false);
  },

  findGroupPost(page, groupUrl, content, options = {}) {
    const automation = new FacebookAutomation(options);
    return automation._withRestoredProfileIdentity(
      page,
      () => automation.findGroupPost(page, groupUrl, content, options)
    );
  },

  findTimelinePost(page, profileUrl, content, options = {}) {
    const automation = new FacebookAutomation(options);
    return automation._withRestoredProfileIdentity(
      page,
      () => automation.findTimelinePost(page, profileUrl, content, options)
    );
  },

  _private: {
    FacebookAutomation,
    extractFacebookEntityId,
    facebookVideoKey,
    sameVideoKeys,
    normalizeFacebookCaption,
    publishedTimeMatches,
    normalizeEditorText,
    normalizeEditorTextForComparison,
    editorCaptionMatches,
    describeCaptionMismatch,
    replaceFacebookEditorText,
  },
};

module.exports = FacebookAdapter;
