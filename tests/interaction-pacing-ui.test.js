const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const postConfig = fs.readFileSync(path.join(root, 'public', 'js', 'post-config.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'settings.routes.js'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'src', 'services', 'runner.service.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const adapters = ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo']
  .map(name => fs.readFileSync(path.join(root, 'src', 'platforms', `${name}.adapter.js`), 'utf8'))
  .join('\n');

test('Cấu hình nền tảng dùng hàng gọn và popup Thao tác chống BOT', () => {
  assert.match(postConfig, /Thao tác chống BOT trước khi đăng/);
  assert.match(postConfig, /showAntiBotModal\(\)/);
  assert.match(postConfig, /id="anti-bot-enabled"/);
  assert.match(postConfig, /id="anti-bot-extra-safe"/);
  assert.match(postConfig, /data-anti-bot-preset="light"/);
  assert.match(postConfig, /data-anti-bot-preset="balanced"/);
  assert.match(postConfig, /class="config-advanced"/);
  assert.match(postConfig, /class="anti-bot-copy-platform"/);
  assert.match(routes, /'anti_bot_enabled'/);
  assert.match(routes, /'anti_bot_before_post_max_ms'/);
});

test('Cài đặt chung có popup tốc độ thao tác đăng bài cho mọi nền tảng', () => {
  assert.match(settings, /Tốc độ thao tác đăng bài/);
  assert.match(settings, /showInteractionDelayModal\(\)/);
  assert.match(settings, /id="interaction-delay-enabled"/);
  assert.match(settings, /data-interaction-preset="balanced"/);
  assert.match(settings, /interactionRangeFields\([\s\S]*'interaction-action'/);
  assert.match(settings, /interactionRangeFields\([\s\S]*'interaction-typing'/);
  assert.match(settings, /interactionRangeFields\([\s\S]*'interaction-media'/);
  assert.match(settings, /interactionRangeFields\([\s\S]*'interaction-publish'/);
  assert.match(css, /\.compact-config-row/);
  assert.match(css, /\.config-range-grid/);
  assert.match(index, /style\.css\?v=20261005pficon1/);
  assert.match(index, /post-config\.js\?v=20261005textbg1/);
  assert.match(index, /settings\.js\?v=20261002hidden1/);
});

test('Runner áp dụng chuẩn bị trước adapter và mọi adapter chờ riêng trước nút Đăng', () => {
  assert.match(runner, /performAntiBotWarmup/);
  assert.match(runner, /new InteractionPacing\.InteractionPacer/);
  assert.match(runner, /interactionPacer\.restore\(\)/);
  assert.equal((adapters.match(/interactionPacer\?\.beforePublish\(\)/g) || []).length >= 6, true);
  assert.equal((adapters.match(/interactionPacer\?\.afterMedia\(\)/g) || []).length >= 6, true);
});
