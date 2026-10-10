const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const dataManager = fs.readFileSync(path.join(root, 'public', 'js', 'data-manager.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('bộ lọc bảng dữ liệu dùng toàn bộ nhãn tiếng Việt', () => {
  assert.match(dataManager, /const GRID_LOCALE_VI = \{/);
  assert.match(dataManager, /filterOoo:\s*'Nhập nội dung cần lọc\.\.\.'/);
  assert.match(dataManager, /contains:\s*'Có chứa'/);
  assert.match(dataManager, /notContains:\s*'Không chứa'/);
  assert.match(dataManager, /andCondition:\s*'Và'/);
  assert.match(dataManager, /orCondition:\s*'Hoặc'/);
  assert.match(dataManager, /resetFilter:\s*'Đặt lại'/);
  assert.match(dataManager, /localeText:\s*GRID_LOCALE_VI/);
});

test('popup lọc gọn và đồng bộ màu cam nâu kem', () => {
  assert.match(css, /\.ag-theme-alpine-dark-custom \.ag-menu\s*\{[\s\S]*min-width:\s*248px/);
  assert.match(css, /\.ag-theme-alpine-dark-custom \.ag-menu\s*\{[\s\S]*border-radius:\s*13px/);
  assert.match(css, /\.ag-theme-alpine-dark-custom \.ag-filter\s*\{[\s\S]*padding:\s*10px/);
  assert.match(css, /\.ag-theme-alpine-dark-custom \.ag-standard-button:hover\s*\{[\s\S]*background:\s*var\(--orange\)/);
  assert.match(html, /data-manager\.js\?v=20261004scan1/);
});
