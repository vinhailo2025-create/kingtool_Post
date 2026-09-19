const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const account = fs.readFileSync(path.join(root, 'public', 'js', 'account.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const updater = fs.readFileSync(path.join(root, 'public', 'js', 'updater.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('mục Cài đặt hướng dẫn cập nhật gọn và không lộ kênh phân phối nội bộ', () => {
  assert.doesNotMatch(account, /\$\{this\.renderUpdateGuide\(\)\}/);
  assert.match(settings, /renderGuideSettings\(\)/);
  assert.match(settings, /Cập nhật phiên bản mới/);
  assert.match(settings, /Tự kiểm tra/);
  assert.match(settings, /Bạn chủ động chọn/);
  assert.match(settings, /Tự tải &amp; cài/);
  assert.match(settings, /Updater\.openSettingsUpdate\(this\)/);
  assert.match(settings, /Bạn vẫn có thể tiếp tục sử dụng tool và cập nhật sau/);
  assert.doesNotMatch(settings, /GitHub|Drive|SHA-256/);
  assert.doesNotMatch(updater, />Mở Drive<|Chưa thể kiểm tra GitHub/);
});

test('khối cập nhật responsive và được cache-bust trong bản desktop', () => {
  assert.match(css, /\.account-update-card\s*\{/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.account-update-steps\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(html, /style\.css\?v=20260919datamode1/);
  assert.match(html, /settings\.js\?v=20260906update2/);
  assert.match(html, /updater\.js\?v=20260906update3/);
});

test('các nhóm Cài đặt đóng mặc định và không còn Backup & Restore', () => {
  assert.match(settings, /openSections:\s*new Set\(\)/);
  assert.match(settings, /renderAccordion\(\s*'ai'/);
  assert.match(settings, /data-settings-section="general"/);
  assert.match(settings, /renderAccordion\(\s*'google-sheets'/);
  assert.match(settings, /renderAccordion\(\s*'guide'/);
  assert.match(settings, /settings-accordion-panel[\s\S]*hidden/);
  assert.doesNotMatch(settings, /Backup &amp; Restore|Backup & Restore/);
  assert.doesNotMatch(settings, /id="setting-auto-backup"/);
});
