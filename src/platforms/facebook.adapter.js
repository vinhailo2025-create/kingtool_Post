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
const FACEBOOK_VIDEO_RE = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i;
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
      if (attempt === 0) {
        if (typeof page.keyboard.insertText === 'function') {
          await page.keyboard.insertText(content);
        } else {
          await page.keyboard.sendCharacter(content);
        }
      } else if (attempt === 1 && typeof page.keyboard.sendCharacter === 'function') {
        await page.keyboard.sendCharacter(content);
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
    this.addAiLabel = options.addAiLabel === true || options.addAiLabel === '1';
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

  async _publishTimeline(page, post) {
    if (!page) throw new Error('Khong co tab trinh duyet');

    const XP_TIMEOUT = 30000;
    const vmap = this.buildVarMap(post);
    const content = this.renderTemplate('{{content}}', vmap);
    const mediaRaw = this.renderTemplate('{{media}}', vmap);
    const mediaPaths = this._resolveMediaPaths(mediaRaw, { splitNewlines: false });
    const hasVideo = this._hasVideo(mediaPaths);
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
    const beforeLinks = new Set(
      await this._extractTopOwnPostLinks(page, owner, 3, { wide: true })
    );
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

    // Lay handle modal "Tao bai viet" hien tai (dialog HIEN THI co o soan / tieu de tao bai viet),
    // KHONG lay dialog dau tien (co the la dialog Thong bao an).
    const getModal = () => page.evaluateHandle(() => {
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
      const vis = e => { const r = e.getBoundingClientRect(); const s2 = getComputedStyle(e); return r.width > 200 && r.height > 150 && s2.visibility !== 'hidden' && s2.display !== 'none'; };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis);
      const withEditor = dialogs.find(d => d.querySelector('div[contenteditable="true"]'));
      if (withEditor) return withEditor;
      return dialogs.find(d => {
        const t = norm((d.getAttribute('aria-label') || '') + ' ' + (d.innerText || '').slice(0, 80));
        return t.includes('tao bai viet') || t.includes('create post');
      }) || null;
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);

    // Mo composer: lay HANDLE nut composer uu tien "Ban dang nghi gi?", scrollIntoView roi click
    // (dung handle.click de tu cuon toi - tranh loi nut nam ngoai viewport khi dung toa do tinh).
    let modal = await getModal();
    if (!modal) {
      const composerBtn = await page.evaluateHandle(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
        const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 20 && st.visibility !== 'hidden' && st.display !== 'none'; };
        let best = null, bestScore = -1;
        Array.from(document.querySelectorAll('[role="button"], div[tabindex]')).forEach(e => {
          if (!visible(e)) return;
          const t = norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || ''));
          let pr = 0;
          if (t.includes('ban dang nghi gi') || t.includes("what's on your mind")) pr = 3;
          else if (t.includes('tao bai viet') || t.includes('create post')) pr = 2;
          else if (t.includes('chia se suy nghi') || t.includes('share your thoughts')) pr = 1;
          if (!pr) return;
          const r = e.getBoundingClientRect();
          const score = pr * 1e7 + r.width * r.height;
          if (score > bestScore) { bestScore = score; best = e; }
        });
        return best;
      }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
      if (composerBtn) {
        for (let attempt = 0; attempt < 3 && !modal; attempt++) {
          await page.keyboard.press('Escape').catch(() => {});
          await humanDelay(400, 800);
          await composerBtn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
          await humanDelay(500, 900);
          await composerBtn.click().catch(() => {});
          for (let t = 0; t < 8 && !modal; t++) { await this._sleep(1000); modal = await getModal(); }
        }
      }
    }
    if (!modal) {
      try {
        const dbg = await page.evaluate(() => {
          const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 30 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none'; };
          return {
            url: location.href, title: document.title,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            dialogCount: document.querySelectorAll('[role="dialog"]').length,
            visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).map(d => (d.innerText || '').replace(/\s+/g, ' ').slice(0, 80)),
            body: (document.body.innerText || '').slice(0, 1200),
          };
        });
        fs.writeFileSync(path.join(__dirname, '..', '..', 'composer-debug.json'), JSON.stringify(dbg, null, 2));
      } catch (_) {}
      throw new Error('B5: Khong mo duoc o soan bai (Tao bai viet)');
    }
    await humanDelay(1500, 2500);

    // O soan noi dung trong modal
    let editable = null;
    for (let attempt = 0; attempt < 8 && !editable; attempt++) {
      modal = await getModal() || modal;
      editable = await modal.evaluateHandle(root => {
        const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 20 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const boxes = Array.from(root.querySelectorAll('div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'));
        return boxes.find(visible) || null;
      }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
      if (!editable) await this._sleep(1000);
    }
    if (!editable) throw new Error('B5: Khong tim thay o nhap noi dung');
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

    // Dinh media (neu co) - tim nut Anh/video TRONG modal
    if (mediaPaths.length > 0) {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: XP_TIMEOUT }),
        (async () => {
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
        })(),
      ]);
      await fileChooser.accept(mediaPaths);
      await this.interactionPacer?.afterMedia();
      await this._sleep(4000 + mediaPaths.length * 2500);
      await humanDelay(1200, 2500);
    }

    await this._configureAiLabelIfNeeded(page, modal, mediaPaths.length > 0);

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
        await clickButton.evaluate(element => element.scrollIntoView({ block: 'center' })).catch(() => {});
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
      // Cách chính cho text/ảnh: tìm đúng card theo nội dung rồi đọc permalink.
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

  async _configureAiLabelIfNeeded(page, modal, hasMedia) {
    if (!this.addAiLabel || !hasMedia) return false;
    await this._enableAiLabel(page, modal);
    return true;
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
        return Array.from(document.querySelectorAll('[role="button"], button, a[role="button"]'))
          .filter(visible)
          .find(element => {
            const parts = [
              norm(element.innerText || ''),
              norm(element.getAttribute('aria-label') || ''),
            ].filter(Boolean);
            return parts.some(text => /^(switch|switch now|chuyen|chuyen ngay)$/.test(text)
              || text.includes('switch into')
              || text.includes('chuyen sang trang'));
          }) || null;
      }).then(handle => (handle && handle.asElement ? handle.asElement() : null)).catch(() => null);
      if (!button) return false;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        button.click(),
      ]);
      await this._sleep(3000);
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
        return { success: true, postedAt: new Date().toLocaleString('vi-VN') };
      }
      if (clean && newId && (!commentText || textAdded) && linkAdded) {
        return { success: true, postedAt: new Date().toLocaleString('vi-VN') };
      }
      // Facebook does not always expose comment_id immediately. For media
      // comments, a cleared editor and attachment preview after clicking the
      // explicit submit button is a reliable acknowledgement from the UI.
      if (mediaPath && clean && attachmentCleared && Date.now() - started >= 4500
        && (!commentText || textAdded) && linkAdded) {
        return { success: true, postedAt: new Date().toLocaleString('vi-VN') };
      }
    }
    submitError.message += ` | before=${JSON.stringify(before)} after=${JSON.stringify(lastAfter)}`;
    throw submitError;
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
      box = await page.evaluateHandle(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
        const vis = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const boxes = Array.from(document.querySelectorAll(
          'div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'
        )).filter(vis);
        return boxes.find(b => /binh luan|comment|tra loi|reply/.test(norm(
          (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('aria-placeholder') || '')
        ))) || boxes[boxes.length - 1] || null;
      }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
      if (!box) {
        await page.evaluate(() => window.scrollBy(0, 650)).catch(() => {});
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

    let input = await box.evaluateHandle(el => {
      let cur = el;
      for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
        const found = cur.querySelector('input[type="file"]');
        if (found) return found;
      }
      return document.querySelector('input[type="file"][accept*="image"], input[type="file"][accept*="video"]');
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);

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
        .replace(/[\u0300-\u036f]/g, '').replace(/[Ä‘Ä]/g, 'd').toLowerCase();
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
        .replace(/[\u0300-\u036f]/g, '').replace(/[Ä‘Ä]/g, 'd').toLowerCase();
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
      const direct = Array.from(document.querySelectorAll('a[role="link"][aria-label*="DÃƒÂ²ng thÃ¡Â»Âi gian"]'))[0];
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
      // BÃƒÂ i mÃ¡Â»â€ºi thÃ†Â°Ã¡Â»Âng khÃƒÂ´ng nÃ¡ÂºÂ±m trong [role=article] -> tÃƒÂ¬m permalink ngay quanh vÃƒÂ¹ng text bÃƒÂ i mÃ¡Â»â€ºi
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

  // LÃ¡ÂºÂ¥y danh tÃƒÂ­nh chÃ¡Â»Â§ account Ã„â€˜ang Ã„â€˜Ã„Æ’ng: vanity (username) + numeric id (tÃ¡Â»Â« cookie c_user)
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

  // Ã„ÂÃ¡Â»Âc danh tÃƒÂ­nh chÃ¡Â»Â§ trang tÃ¡Â»Â« chÃƒÂ­nh trang profile Ã„â€˜ang mÃ¡Â»Å¸ (canonical/og:url) Ã„â€˜Ã¡Â»Æ’ lÃ¡ÂºÂ¥y Ã„â€˜Ã†Â°Ã¡Â»Â£c vanity khi profileHref lÃƒÂ  dÃ¡ÂºÂ¡ng sÃ¡Â»â€˜
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

  // LÃ¡ÂºÂ¥y nhanh vanity/id chÃ¡Â»Â§ account tÃ¡Â»Â« canonical cÃ¡Â»Â§a trang mobile (khÃƒÂ´ng quÃƒÂ©t bÃƒÂ i) Ã¢â‚¬â€ mobile trÃ¡ÂºÂ£ canonical Ã¡Â»â€¢n Ã„â€˜Ã¡Â»â€¹nh hÃ†Â¡n desktop

  // Link cÃƒÂ³ thuÃ¡Â»â„¢c Ã„â€˜ÃƒÂºng account Ã„â€˜ang Ã„â€˜Ã„Æ’ng khÃƒÂ´ng (chÃ¡Â»â€˜ng lÃ¡ÂºÂ¥y nhÃ¡ÂºÂ§m bÃƒÂ i ngÃ†Â°Ã¡Â»Âi khÃƒÂ¡c trÃƒÂªn timeline)
  _isOwnPostUrl(href, owner) {
    if (!owner || (!owner.vanity && !owner.id)) return true;
    try {
      const u = new URL(href, 'https://www.facebook.com');
      const idParam = u.searchParams.get('id');
      if (owner.id && idParam && String(idParam) === String(owner.id)) return true;
      // Ã¡ÂºÂ¢nh: owner id nÃ¡ÂºÂ±m trong set=pb.<id>.- hoÃ¡ÂºÂ·c set=a....<id>
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

  // TÃƒÂ¬m permalink cÃ¡Â»Â§a bÃƒÂ i vÃ¡Â»Â«a Ã„â€˜Ã„Æ’ng bÃ¡ÂºÂ±ng cÃƒÂ¡ch leo DOM tÃ¡Â»Â« chÃƒÂ­nh Ã„â€˜oÃ¡ÂºÂ¡n text nÃ¡Â»â„¢i dung (khÃƒÂ´ng phÃ¡Â»Â¥ thuÃ¡Â»â„¢c [role=article])
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
      // VÃƒÂ²ng 1: dÃƒÂ¹ng href sÃ¡ÂºÂµn cÃƒÂ³
      for (const a of anchors) {
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
      // VÃƒÂ²ng 2: hover Ã„â€˜Ã¡Â»Æ’ Facebook gÃ¡ÂºÂ¯n permalink
      for (const a of anchors.slice(0, 20)) {
        try { await a.hover(); } catch (_) {}
        await this._sleep(400);
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
    } catch (_) {}
    return '';
  }

  // Hover cÃƒÂ¡c link trong bÃƒÂ i khÃ¡Â»â€ºp nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Æ’ Facebook lÃ¡Â»â„¢ permalink timestamp, rÃ¡Â»â€œi lÃ¡ÂºÂ¥y link bÃƒÂ i cÃ¡Â»Â§a Ã„â€˜ÃƒÂºng chÃ¡Â»Â§ account
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
