const FacebookAdapter = require('./facebook.adapter');
const TikTokAdapter = require('./tiktok.adapter');
const YouTubeAdapter = require('./youtube.adapter');
const ThreadsAdapter = require('./threads.adapter');
const InstagramAdapter = require('./instagram.adapter');
const XAdapter = require('./x.adapter');
const ZaloVideoAdapter = require('./zalovideo.adapter');
const { normalizePlatform } = require('./platform.utils');

const adapters = {
  facebook: FacebookAdapter,
  tiktok: TikTokAdapter,
  youtube: YouTubeAdapter,
  threads: ThreadsAdapter,
  instagram: InstagramAdapter,
  x: XAdapter,
  zalovideo: ZaloVideoAdapter,
};

function getPlatformAdapter(platform) {
  return adapters[normalizePlatform(platform)];
}

module.exports = {
  getPlatformAdapter,
  normalizePlatform,
};
