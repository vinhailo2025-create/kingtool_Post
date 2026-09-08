const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const browserManager = fs.readFileSync(
  path.join(root, 'public', 'js', 'browser-manager.js'),
  'utf8'
);
const routes = fs.readFileSync(
  path.join(root, 'src', 'routes', 'browser.routes.js'),
  'utf8'
);

test('thanh trình duyệt dùng một nút Xóa gọn và không còn nút chọn/bỏ chọn thủ công', () => {
  assert.match(browserManager, />\s*Xóa\s*<\/button>/);
  assert.match(browserManager, /bulkDelete\(\)/);
  assert.doesNotMatch(browserManager, /onclick="BrowserManager\.toggleAllProfiles\(true\)">Chọn tất cả/);
  assert.doesNotMatch(browserManager, /onclick="BrowserManager\.toggleAllProfiles\(false\)">Bỏ chọn/);
  assert.match(routes, /router\.delete\('\/bulk\/delete'/);
});

test('tên anti-detect được đồng bộ nền và không còn nút đồng bộ thủ công', () => {
  assert.match(browserManager, /_refreshProviderNamesAutomatically\(\)/);
  assert.doesNotMatch(browserManager, /onclick="BrowserManager\.refreshProviderNames\(\)"/);
  assert.match(browserManager, /providers\/refresh-names/);
});

test('Kết nối Anti-detect chỉ xuất hiện một nơi trong trang Trình duyệt', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const combined = `${browserManager}\n${app}`;
  assert.equal(
    (combined.match(/onclick="BrowserManager\.showProviderImportModal\(\)"/g) || []).length,
    1
  );
  assert.match(browserManager, /class="browser-hero-actions"[\s\S]*Kết nối Anti-detect/);
  assert.match(app, /case 'browsers':[\s\S]*container\.innerHTML = ''/);
});

test('Danh sách profile có popup Fanpage và kênh YouTube dùng chung', () => {
  assert.match(browserManager, /Danh sách/);
  assert.match(browserManager, /showManagedTargetsModal/);
  assert.match(browserManager, /targets\/scan/);
  assert.match(browserManager, /Fanpage/);
  assert.match(browserManager, /Kênh YouTube/);
  assert.match(routes, /targets\/scan/);
  assert.match(routes, /targets\/match/);
});
