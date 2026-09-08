const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('public/index.html');
const app = read('public/js/app.js');
const browserManager = read('public/js/browser-manager.js');
const automation = read('public/js/automation.js');
const scheduler = read('public/js/scheduler.js');
const runner = read('public/js/runner.js');
const runnerRoutes = read('src/routes/runner.routes.js');
const schedulerService = read('src/services/scheduler.service.js');
const browserService = read('src/services/browser.service.js');

test('Trình duyệt, Hẹn giờ và Log chạy là menu toàn cục đúng thứ tự', () => {
  const dashboard = html.indexOf('id="nav-dashboard"');
  const browsers = html.indexOf('id="nav-browsers"');
  const facebook = html.indexOf('id="nav-facebook"');
  const x = html.indexOf('id="nav-x"');
  const schedulerNav = html.indexOf('id="nav-scheduler"');
  const runnerNav = html.indexOf('id="nav-runner"');
  const settings = html.indexOf('id="nav-settings"');
  assert.ok(dashboard < browsers && browsers < facebook);
  assert.ok(x < schedulerNav && schedulerNav < runnerNav && runnerNav < settings);
  assert.match(app, /workspacePages:\s*\['data', 'postcfg'\]/);
  assert.doesNotMatch(html, /workspace-tab" data-page="browsers"/);
  assert.doesNotMatch(html, /workspace-tab" data-page="scheduler"/);
  assert.doesNotMatch(html, /workspace-tab" data-page="runner"/);
});

test('Trình duyệt là kho profile dùng chung và không còn đồng bộ hay chạy tác vụ', () => {
  assert.match(browserService, /const \{ PLATFORMS, normalizePlatform \}/);
  assert.match(browserService, /if \(String\(platform\)\.toLowerCase\(\) === 'all'\)/);
  assert.match(browserService, /for \(const targetPlatform of PLATFORMS\)/);
  assert.match(browserManager, /class="browser-bulk-bar/);
  assert.doesNotMatch(browserManager, /showSyncPlatformsModal/);
  assert.doesNotMatch(browserManager, /runAutomation/);
  assert.doesNotMatch(browserManager, /browser-auto-mode/);
});

test('Tự động hóa chọn nhiều profile, lưu cấu hình và chạy theo nền tảng hiện tại', () => {
  assert.match(automation, /selectedProfileIds:\s*new Set\(\)/);
  assert.match(automation, /localStorage\.setItem\(this\.storageKey\(config\.platform\)/);
  assert.match(automation, /\/api\/browsers\?platform=all/);
  assert.match(automation, /\/api\/runner\/start\?platform=/);
  assert.match(automation, /\/api\/schedules\?platform=/);
  assert.match(automation, /schedule_time:\s*config\.scheduleTime/);
});

test('Hẹn giờ và Log chạy tổng hợp mọi dự án và lọc riêng từng nền tảng', () => {
  assert.match(scheduler, /projectFilter:\s*'all'/);
  assert.match(scheduler, /\/api\/schedules\?platform=all/);
  assert.match(scheduler, /Tất cả dự án/);
  assert.match(schedulerService, /getAllGlobal/);
  assert.match(runner, /projectFilter:\s*'all'/);
  assert.match(runner, /\/api\/runner\/status\?platform=all/);
  assert.match(runner, /\/api\/runner\/logs\?platform=all/);
  assert.match(runnerRoutes, /RunnerManager\.getStatus\(\)/);
  assert.match(runnerRoutes, /router\.get\('\/logs'/);
});
