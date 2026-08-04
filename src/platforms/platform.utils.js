const PLATFORMS = Object.freeze(['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x']);
const PLATFORM_SET = new Set(PLATFORMS);

function normalizePlatform(value, fallback = 'facebook') {
  const platform = String(value || '').trim().toLowerCase();
  return PLATFORM_SET.has(platform) ? platform : fallback;
}

function scopedSettingKey(platform, key) {
  const normalized = normalizePlatform(platform);
  return normalized === 'facebook' ? key : `${normalized}_${key}`;
}

function platformLabel(platform) {
  return {
    facebook: 'Facebook',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    threads: 'Threads',
    instagram: 'Instagram',
    x: 'X',
  }[normalizePlatform(platform)];
}

module.exports = { PLATFORMS, normalizePlatform, scopedSettingKey, platformLabel };
