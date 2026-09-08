const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const dataManager = fs.readFileSync(path.join(root, 'public', 'js', 'data-manager.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('Cài đặt chung có JSON quyền, link Sheet, kiểm tra kết nối và tự động', () => {
  assert.match(settings, /renderGoogleSheetsSettings\(\)/);
  assert.match(settings, /google-sheets-json-file/);
  assert.match(settings, /accept="\.json,application\/json"/);
  assert.match(settings, /google-sheets-url/);
  assert.match(settings, /testGoogleSheetsConnection\(\)/);
  assert.match(settings, /google-sheets-auto-enabled/);
  assert.match(settings, /google-sheets-auto-interval/);
  assert.match(settings, /google-sheets-auto-direction/);
  assert.match(settings, /google-sheets-compact-panel google-sheets-connection-panel/);
  assert.match(settings, /google-sheets-compact-panel google-sheets-sync-panel/);
  assert.match(settings, /Settings\.syncAllGoogleSheets\('two_way'\)/);
  assert.match(css, /\.google-sheets-compact-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /@media \(max-width: 1250px\)[\s\S]*\.google-sheets-compact-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(html, /style\.css\?v=20260906layout1/);
  assert.match(html, /app\.js\?v=20260906mcp1/);
  assert.match(html, /data-manager\.js\?v=20260905robot1/);
  assert.match(html, /settings\.js\?v=20260906update2/);
});

test('mỗi bảng có một nút Sheet và modal thêm, lấy về, xóa hàng đã chọn', () => {
  assert.equal((app.match(/DataManager\.showGoogleSheetsSyncModal\(\)/g) || []).length, 1);
  assert.match(app, /google-sheet-quick-button/);
  assert.match(dataManager, /showGoogleSheetsSyncModal\(\)/);
  assert.match(dataManager, /_runGoogleSheetsSync\('push'\)/);
  assert.match(dataManager, /_runGoogleSheetsSync\('pull'\)/);
  assert.match(dataManager, /_runGoogleSheetsSync\('delete'\)/);
  assert.match(dataManager, /không xóa trong tool/);
  assert.match(css, /\.google-sheet-sync-options/);
});
