const path = require('path');

const APP_ROOT = __dirname;
// Desktop exe lives in dist/desktop_launcher.dist, but user data must not live inside dist.
// Keep DB/profile/uploads in the project root so local run and exe use the same Facebook login.
const DATA_ROOT = process.env.COVERGEMAUTO_DATA_DIR || APP_ROOT;

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,

  // Web bán hàng + API license (đã gộp vào web chính)
  LICENSE_API_URL: process.env.LICENSE_API_URL || 'https://www.kingautomationai.com',
  // Slug sản phẩm trên web — mỗi tool đặt slug riêng để key không dùng chéo được
  LICENSE_PRODUCT: process.env.LICENSE_PRODUCT || 'super-post-king',

  // Paths
  ROOT_DIR: APP_ROOT,
  DATA_ROOT,
  DB_PATH: path.join(DATA_ROOT, 'src', 'database', 'covergem.db'),
  CHROME_PROFILES_DIR: path.join(DATA_ROOT, 'src', 'chrome-profiles'),
  BACKUPS_DIR: path.join(DATA_ROOT, 'src', 'backups'),
  UPLOADS_DIR: path.join(DATA_ROOT, 'uploads'),
  PUBLIC_DIR: path.join(APP_ROOT, 'public'),

  // Chrome - auto-detect common paths on Windows
  CHROME_PATHS: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ],

  // Runner defaults
  DEFAULT_CONCURRENCY: 2,
  DEFAULT_DELAY_MIN: 30,
  DEFAULT_DELAY_MAX: 90,
  DEFAULT_PROFILE_DELAY_MIN: 10,
  DEFAULT_PROFILE_DELAY_MAX: 30,
};
