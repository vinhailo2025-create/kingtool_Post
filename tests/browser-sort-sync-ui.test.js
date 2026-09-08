const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const browserManager = fs.readFileSync(path.join(root, 'public', 'js', 'browser-manager.js'), 'utf8');
const postConfig = fs.readFileSync(path.join(root, 'public', 'js', 'post-config.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const browserRoutes = fs.readFileSync(path.join(root, 'src', 'routes', 'browser.routes.js'), 'utf8');
const settingsRoutes = fs.readFileSync(path.join(root, 'src', 'routes', 'settings.routes.js'), 'utf8');
const schedulerService = fs.readFileSync(path.join(root, 'src', 'services', 'scheduler.service.js'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'src', 'services', 'runner.service.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

test('bảng Profile có sắp xếp tên, lọc Loại phía trên và lọc nhiều Nhóm tại cột', () => {
  assert.match(browserManager, /class="browser-profile-sort"/);
  assert.match(browserManager, /toggleProfileSort\(\)/);
  assert.match(browserManager, /this\.nameSort === 'desc' \? '↓' : '↑'/);
  assert.match(browserManager, /class="provider-filter-row"/);
  assert.match(browserManager, /class="provider-filter/);
  assert.doesNotMatch(browserManager, /id="browser-provider-filter"/);
  assert.match(browserManager, /class="browser-column-filter browser-group-filter"/);
  assert.match(browserManager, /class="browser-group-header"/);
  assert.match(browserManager, /<svg viewBox="0 0 24 24"/);
  assert.match(browserManager, /toggleGroupFilter\(/);
  assert.match(browserManager, /showGroupManagerModal\(\)/);
  assert.match(browserManager, /showBulkGroupModal\(\)/);
  assert.match(browserManager, /mode:\s*'replace'/);
  assert.match(browserRoutes, /router\.get\('\/groups'/);
  assert.match(browserRoutes, /router\.put\('\/groups\/members\/assign'/);
  assert.doesNotMatch(browserManager, /<th>Trạng thái<\/th>/);
  assert.doesNotMatch(browserManager, /<th>Phiên<\/th>/);
  assert.match(css, /\.browser-profile-sort/);
  assert.match(css, /\.browser-column-filter-menu/);
  assert.match(css, /\.browser-group-header/);
  assert.match(css, /\.browser-group-cell/);
});

test('giới hạn bài mỗi lượt chỉ nằm trong Cấu hình và áp dụng theo từng nền tảng', () => {
  assert.match(postConfig, /id="post-run-limit"/);
  assert.match(postConfig, /posts_per_profile_per_run:\s*String\(postLimit\)/);
  assert.match(settingsRoutes, /'posts_per_profile_per_run'/);
  assert.match(schedulerService, /scopedSettingKey\(platform, 'posts_per_profile_per_run'\)/);
  assert.match(schedulerService, /getPostsPerRunSetting\(schedule\.platform\)/);
  assert.doesNotMatch(browserManager, /automation-post-limit/);
  assert.doesNotMatch(settings, /setting-posts-per-profile/);
  assert.match(runner, /selectPendingPostsForProfile/);
  assert.match(runner, /if \(!isPendingStatus\(post\.status\)\) return false/);
  assert.match(runner, /ORDER BY CASE WHEN sort_order IS NULL OR sort_order <= 0 THEN id ELSE sort_order END ASC/);
});

test('Trình duyệt dùng chung chỉ còn các thao tác profile cần thiết', () => {
  assert.doesNotMatch(browserManager, /showSyncPlatformsModal\(\)/);
  assert.doesNotMatch(browserManager, /class="browser-sync-platform"/);
  assert.doesNotMatch(browserManager, /BrowserManager\.runAutomation/);
  assert.match(browserManager, /class="browser-bulk-bar/);
  assert.match(browserManager, />Mở<\/button>/);
  assert.match(browserManager, />Đóng<\/button>/);
  assert.match(browserManager, />\s*Xóa\s*<\/button>/);
  assert.doesNotMatch(browserManager, />Mở đã chọn<\/button>/);
  assert.doesNotMatch(browserManager, />Đóng đã chọn<\/button>/);
  assert.match(css, /\.browser-bulk-bar/);
});
