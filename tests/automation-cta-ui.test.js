const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const automation = fs.readFileSync(path.join(root, 'public', 'js', 'automation.js'), 'utf8');
const dataManager = fs.readFileSync(path.join(root, 'public', 'js', 'data-manager.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'public', 'js', 'dashboard.js'), 'utf8');
const browserManager = fs.readFileSync(path.join(root, 'public', 'js', 'browser-manager.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('nút Tự động hóa nằm trên từng bảng dữ liệu và mở popup riêng', () => {
  assert.match(app, /class="btn btn-automation btn-sm"[\s\S]*onclick="Automation\.show\(\)"/);
  assert.match(automation, /Tự động hóa · \$\{App\.platformLabel\(\)\}/);
  assert.match(automation, /name="automation-run-mode" value="now"/);
  assert.match(automation, /<span>Chạy ngay<\/span>/);
  assert.match(automation, /name="automation-run-mode" value="schedule"/);
  assert.match(automation, /<span>Hẹn giờ<\/span>/);
  assert.match(automation, />Lưu<\/button>/);
  assert.match(automation, /id="automation-run-button"[\s\S]*>Chạy<\/button>/);
  assert.match(automation, /getSelectedRows\(\)/);
  assert.match(automation, /dataIds:\s*selectedRows\.length \? selectedRows\.map/);
});

test('popup chọn profile trước chế độ chạy, đóng ngay khi bấm Chạy và cache phiên bản mới', () => {
  assert.ok(
    automation.indexOf('class="automation-profile-list"')
      < automation.indexOf('class="automation-run-options"')
  );
  assert.match(automation, /this\.persist\(config\);\s*closeModal\(\);\s*try \{/);
  assert.match(css, /\.btn-automation\s*\{/);
  assert.match(css, /\.automation-run-options\s*\{/);
  assert.match(css, /\.automation-profile-list\s*\{/);
  assert.match(css, /\.automation-profile-row\s*\{/);
  assert.match(html, /style\.css\?v=20260927fanpagelist/);
  assert.match(html, /automation\.js\?v=20260919schedule2/);
});

test('chọn trình duyệt lọc đồng thời nhiều Loại và Nhóm, không còn cảnh báo phiên đăng nhập', () => {
  assert.match(automation, /providerFilters:\s*new Set\(\)/);
  assert.match(automation, /groupFilters:\s*new Set\(\)/);
  assert.match(automation, /this\.providerFilters\.size === 0[\s\S]*this\.groupFilters\.size === 0/);
  assert.match(automation, /class="automation-filter-dropdown automation-provider-filter"/);
  assert.match(automation, /class="automation-filter-dropdown automation-group-filter"/);
  assert.match(css, /\.automation-filter-dropdown\s*\{/);
  assert.doesNotMatch(dataManager, /profile-picker-session/);
  assert.doesNotMatch(dataManager, /profilePickerState\.session/);
  assert.doesNotMatch(dataManager, /Đã đăng nhập<\/span>|Chưa đăng nhập<\/span>/);
  assert.doesNotMatch(browserManager, /Đã đăng nhập<\/span>|Chưa đăng nhập<\/span>/);
  assert.doesNotMatch(dashboard, /profile mất phiên đăng nhập/);
});
