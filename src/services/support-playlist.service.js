const PLAYLIST_ID = 'PLaySyj8jDkR0';
const PLAYLIST_URL = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
const CACHE_MS = 2 * 60 * 1000;

let cachedResult = null;
let cachedAt = 0;

const GUIDE_VIDEO_ORDER = [
  (title) => title === 'super post king',
  (title) => title.includes('ket noi trinh duyet'),
  (title) => title.includes('huong dan su dung') && !title.includes('cai dat'),
  (title) => title.includes('demo') && title.includes('dang bai'),
  (title) => title.includes('cau hinh bai dang'),
  (title) => title.includes('tu dong binh luan'),
  (title) => title.includes('super post ai') && title.includes('viet lai'),
  (title) => title.includes('cai dat super post') && title.includes('google sheets'),
  (title) => title.includes('super post agent'),
  (title) => title.includes('cai dat') && title.includes('kich hoat'),
  (title) => title.includes('cap nhat tool'),
];

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sortVideos(videos) {
  return videos
    .map((video, index) => {
      const title = normalizeTitle(video.title);
      const rank = GUIDE_VIDEO_ORDER.findIndex((matches) => matches(title));
      return { video, index, rank: rank < 0 ? GUIDE_VIDEO_ORDER.length : rank };
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ video }) => video);
}

function extractJsonObject(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = source.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parseInitialData(html) {
  const markers = ['var ytInitialData =', 'window["ytInitialData"] =', 'ytInitialData ='];
  for (const marker of markers) {
    const json = extractJsonObject(html, marker);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch (error) {}
  }
  throw new Error('Không đọc được dữ liệu playlist YouTube');
}

function textOf(value) {
  if (!value) return '';
  if (typeof value.simpleText === 'string') return value.simpleText.trim();
  if (Array.isArray(value.runs)) {
    return value.runs.map((run) => run.text || '').join('').trim();
  }
  return '';
}

function lockupDuration(lockup) {
  const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || [];
  for (const overlay of overlays) {
    const badges = overlay.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const text = badge.thumbnailBadgeViewModel?.text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return '';
}

function collectVideos(initialData) {
  const videos = [];
  const seen = new Set();
  const stack = [initialData];

  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;

    const lockup = value.lockupViewModel;
    if (lockup
        && lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO'
        && /^[A-Za-z0-9_-]{11}$/.test(lockup.contentId || '')
        && !seen.has(lockup.contentId)) {
      seen.add(lockup.contentId);
      videos.push({
        id: lockup.contentId,
        title: lockup.metadata?.lockupMetadataViewModel?.title?.content || 'Video hướng dẫn',
        duration: lockupDuration(lockup),
      });
    }

    const renderer = value.playlistVideoRenderer;
    if (renderer && /^[A-Za-z0-9_-]{11}$/.test(renderer.videoId || '') && !seen.has(renderer.videoId)) {
      seen.add(renderer.videoId);
      videos.push({
        id: renderer.videoId,
        title: textOf(renderer.title) || 'Video hướng dẫn',
        duration: textOf(renderer.lengthText),
      });
    }

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
    } else {
      for (const child of Object.values(value)) stack.push(child);
    }
  }

  return videos;
}

async function getPlaylist() {
  if (cachedResult && Date.now() - cachedAt < CACHE_MS) return cachedResult;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(PLAYLIST_URL, {
      signal: controller.signal,
      headers: {
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
      },
    });
    if (!response.ok) throw new Error(`YouTube phản hồi HTTP ${response.status}`);

    const initialData = parseInitialData(await response.text());
    const videos = sortVideos(collectVideos(initialData));
    if (!videos.length) throw new Error('Playlist chưa có video khả dụng');

    cachedResult = { playlist_id: PLAYLIST_ID, videos };
    cachedAt = Date.now();
    return cachedResult;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  PLAYLIST_ID,
  collectVideos,
  getPlaylist,
  normalizeTitle,
  parseInitialData,
  sortVideos,
};
