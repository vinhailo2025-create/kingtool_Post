const path = require('path');

const APP_ROOT = __dirname;
// The desktop launcher points this to the current user's LocalAppData folder. This keeps
// database/profile/uploads writable and persistent across application upgrades.
const DATA_ROOT = process.env.COVERGEMAUTO_DATA_DIR || APP_ROOT;

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,
  APP_VERSION: require('./package.json').version,

  // Web bán hàng + API license (đã gộp vào web chính)
  LICENSE_API_URL: process.env.LICENSE_API_URL || 'https://www.kingautomationai.com',
  // Slug sản phẩm trên web — mỗi tool đặt slug riêng để key không dùng chéo được
  LICENSE_PRODUCT: process.env.LICENSE_PRODUCT || 'super-post-king',
  UPDATE_GITHUB_REPOSITORY: process.env.UPDATE_GITHUB_REPOSITORY || 'vinhailo2025-create/super-post-king-releases',
  UPDATE_DRIVE_URL: process.env.UPDATE_DRIVE_URL || 'https://drive.google.com/drive/folders/1YuD_fM9JpmnlGWKdhi9sspztVZWervNk?usp=sharing',

  // Paths
  ROOT_DIR: APP_ROOT,
  DATA_ROOT,
  DB_PATH: path.join(DATA_ROOT, 'src', 'database', 'covergem.db'),
  CHROME_PROFILES_DIR: path.join(DATA_ROOT, 'src', 'chrome-profiles'),
  BACKUPS_DIR: path.join(DATA_ROOT, 'src', 'backups'),
  UPLOADS_DIR: path.join(DATA_ROOT, 'uploads'),
  AI_GENERATED_IMAGES_DIR: path.join(DATA_ROOT, 'uploads', 'ai-generated'),
  AI_SECRETS_PATH: path.join(DATA_ROOT, 'src', 'database', 'ai-secrets.enc'),
  AI_SECRETS_KEY_PATH: path.join(DATA_ROOT, 'src', 'database', 'ai-secrets.key'),
  GOOGLE_SHEETS_SECRETS_PATH: path.join(DATA_ROOT, 'src', 'database', 'google-sheets-secrets.enc'),
  GOOGLE_SHEETS_SECRETS_KEY_PATH: path.join(DATA_ROOT, 'src', 'database', 'google-sheets-secrets.key'),
  TELEGRAM_SECRETS_PATH: path.join(DATA_ROOT, 'src', 'database', 'telegram-secrets.enc'),
  TELEGRAM_SECRETS_KEY_PATH: path.join(DATA_ROOT, 'src', 'database', 'telegram-secrets.key'),
  AGENT_API_KEY_PATH: path.join(DATA_ROOT, 'src', 'database', 'agent-api-key.txt'),
  AGENT_API_ENDPOINT_PATH: path.join(DATA_ROOT, 'agent-api-endpoint.json'),
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
