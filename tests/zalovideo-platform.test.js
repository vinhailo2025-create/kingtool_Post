const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
process.env.COVERGEMAUTO_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), 'covergem-zalovideo-test-')
);
const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const ZaloVideoAdapter = require('../src/platforms/zalovideo.adapter');
const {
  PLATFORMS,
  normalizePlatform,
  platformLabel,
  scopedSettingKey,
} = require('../src/platforms/platform.utils');

test('Zalo Video is a first-class platform with an isolated playlist column', async () => {
  await db.waitReady();
  assert.ok(PLATFORMS.includes('zalovideo'));
  assert.equal(normalizePlatform('zalovideo'), 'zalovideo');
  assert.equal(platformLabel('zalovideo'), 'Zalo Video');
  assert.equal(scopedSettingKey('zalovideo', 'add_ai_label'), 'zalovideo_add_ai_label');

  DataService.ensurePlatformDefaultColumns('zalovideo');
  const columns = DataService.getCustomColumns('zalovideo');
  const playlist = columns.find(column => column.var_key === 'playlist');
  assert.ok(playlist);
  assert.equal(playlist.name, 'Danh sách phát');

  const schema = DataService.getExportColumnSchema('zalovideo');
  const headers = schema.map(column => column.header);
  assert.ok(headers.indexOf('Danh sách phát') > headers.indexOf('Media'));
  assert.ok(headers.indexOf('Danh sách phát') < headers.indexOf('Trạng thái'));
});

test('Zalo Video adapter validates input and parses stored/public links', async () => {
  await assert.rejects(
    () => ZaloVideoAdapter.publish({}, { content: 'Thiếu video', image_path: '' }),
    error => error.code === 'ZALO_VIDEO_MEDIA_REQUIRED'
  );
  assert.equal(
    ZaloVideoAdapter._private.videoIdFromLink('https://video.zalo.me/video/1119076419892047747'),
    '1119076419892047747'
  );
  assert.equal(
    ZaloVideoAdapter._private.shortIdFromLink('https://zalo.video/s/4IF7gKnrt'),
    '4IF7gKnrt'
  );
});

test('Zalo Video UI includes navigation, table playlist, AI label and shared automation', () => {
  const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const data = fs.readFileSync(path.join(root, 'public', 'js', 'data-manager.js'), 'utf8');
  const postConfig = fs.readFileSync(path.join(root, 'public', 'js', 'post-config.js'), 'utf8');

  assert.match(index, /id="nav-zalovideo"/);
  assert.match(index, /Đăng Zalo Video/);
  assert.match(app, /zalovideo: 'Zalo Video'/);
  assert.match(data, /App\.currentPlatform === 'zalovideo'/);
  assert.match(data, /label: 'Danh sách phát'/);
  const buildColumns = data.slice(
    data.indexOf('function buildColumnDefs()'),
    data.indexOf('// Custom Cell Renderers')
  );
  const updateFooter = data.slice(
    data.indexOf('function updateFooter()'),
    data.indexOf('// Keyboard Shortcuts')
  );
  assert.match(buildColumns, /App\.currentPlatform === 'zalovideo'[\s\S]*cols\.push/);
  assert.doesNotMatch(updateFooter, /\bcols\b/);
  assert.match(postConfig, /\['facebook', 'zalovideo'\]\.includes\(App\.currentPlatform\)/);
  assert.match(postConfig, /zalo-ai-label-enabled/);
});
