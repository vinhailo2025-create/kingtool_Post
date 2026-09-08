const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Cấu hình YouTube gộp chống BOT và thời gian chờ trong một popup', () => {
  const ui = read('public/js/post-config.js');
  const html = read('public/index.html');
  const ids = [
    'youtube-navigation-timeout',
    'youtube-editor-timeout',
    'youtube-upload-timeout',
    'youtube-publish-timeout',
  ];

  assert.match(ui, /Chống BOT & tốc độ máy\/mạng/);
  assert.match(ui, /showAntiBotModal/);
  assert.doesNotMatch(ui, /youtube-timeout-config-section/);
  assert.doesNotMatch(ui, /showYouTubeTimeoutModal/);
  assert.match(ui, /0<\/b> để chờ không giới hạn/);
  for (const id of ids) {
    const input = ui.match(new RegExp(`<input[^>]+id="\\$\\{id\\}"[^>]*>`))?.[0] || '';
    assert.ok(input, `Thiếu input dùng chung cho ${id}`);
    assert.match(ui, new RegExp(`'${id}'`));
  }
  const inputTemplate = ui.match(/<input type="number" class="form-input" id="\$\{id\}"[\s\S]*?step="1">/)?.[0] || '';
  assert.match(inputTemplate, /min="0"/);
  assert.doesNotMatch(inputTemplate, /\smax="/);
  assert.match(html, /post-config\.js\?v=20260905robot1/);
});

test('thời gian chờ được lưu theo nền tảng và truyền vào adapter YouTube', () => {
  const route = read('src/routes/settings.routes.js');
  const runner = read('src/services/runner.service.js');
  for (const key of [
    'navigation_timeout_ms',
    'editor_timeout_ms',
    'upload_timeout_ms',
    'publish_timeout_ms',
  ]) {
    assert.match(route, new RegExp(`'${key}'`));
  }
  assert.match(runner, /\.\.\.getPlatformTimeoutSettings\(this\.platform\)/);
});

test('adapter YouTube giữ nguyên 0 và giá trị thời gian chờ tùy ý', () => {
  const adapter = require('../src/platforms/youtube.adapter');
  const unlimited = adapter._private.getConfig({
    navigationTimeout: 0,
    editorTimeout: 0,
    uploadTimeout: 0,
    publishTimeout: 0,
  });
  assert.equal(unlimited.navigationTimeout, 0);
  assert.equal(unlimited.editorTimeout, 0);
  assert.equal(unlimited.uploadTimeout, 0);
  assert.equal(unlimited.publishTimeout, 0);

  const custom = adapter._private.getConfig({ publishTimeout: 987654321 });
  assert.equal(custom.publishTimeout, 987654321);
});
