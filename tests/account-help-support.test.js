const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const account = fs.readFileSync(path.join(root, 'public', 'js', 'account.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const license = fs.readFileSync(path.join(root, 'public', 'js', 'license.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('mục Cài đặt có trình phát 16:9 và danh sách video riêng', () => {
  assert.doesNotMatch(account, /\$\{this\.renderHelpSupport\(\)\}/);
  assert.match(settings, /youtube\.com\/embed\/\$\{videoId\}/);
  assert.match(settings, /widget_referrer/);
  assert.match(settings, /referrerpolicy="origin-when-cross-origin"/);
  assert.match(settings, /id="settings-guide-external"/);
  assert.match(settings, /youtube\.com\/playlist\?list=PLaySyj8jDkR0/);
  assert.match(settings, /guideVideos:\s*\[/);
  assert.equal((settings.match(/\{ id: '[A-Za-z0-9_-]{11}', title:/g) || []).length, 12);
  assert.match(settings, /class="account-playlist-item/);
  assert.match(settings, /selectGuideVideo\(videoId, index, button\)/);
  assert.match(settings, /title="Playlist hướng dẫn sử dụng Super Post"/);
  assert.match(css, /\.account-video-frame\s*\{[\s\S]*aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(css, /\.account-guide-viewer\s*\{[\s\S]*grid-template-areas:\s*"video playlist"/);
  assert.match(css, /\.account-video-panel\s*\{[\s\S]*grid-area:\s*video/);
  assert.match(css, /\.account-playlist\s*\{[\s\S]*grid-area:\s*playlist/);
});

test('Google Docs nằm dưới video và Telegram chỉ có một icon nổi', () => {
  assert.match(settings, /docs\.google\.com\/document\/d\/1kA0YEV95hENNFmtjDou4eLXimrnva1fqutZLumGXKWU\/edit\?usp=sharing/);
  assert.match(html, /href="https:\/\/t\.me\/kingtoolai"/);
  assert.match(html, /aria-label="Mở chat hỗ trợ Telegram King Tool AI"/);
  assert.equal((html.match(/account-telegram-fab/g) || []).length, 1);
  assert.doesNotMatch(account, /account-telegram-fab/);
  assert.doesNotMatch(account, /account-support-card account-support-telegram/);
  assert.match(settings, /account-support-row[\s\S]*account-support-docs/);
  assert.match(settings, /target="_blank" rel="noopener noreferrer"/);
  assert.match(css, /\.account-telegram-fab\s*\{[\s\S]*position:\s*fixed/);
  assert.match(css, /\.account-telegram-fab\s*\{[\s\S]*bottom:\s*94px[\s\S]*z-index:\s*100001/);
});

test('nút hướng dẫn toàn cục nằm dưới Telegram và mở Robot hướng dẫn', () => {
  assert.match(html, /class="global-guide-fab"[\s\S]*onclick="RobotGuide\.open\(\)"/);
  assert.match(html, />Hướng dẫn sử dụng</);
  assert.ok(html.indexOf('account-telegram-fab') < html.indexOf('global-guide-fab'));
  assert.match(html, /robot-guide\.js\?v=20260905guide3/);
  assert.match(settings, /openGuideSection\(\)[\s\S]*App\.navigateTo\('settings'\)/);
  assert.match(settings, /pendingSection:\s*null/);
  assert.match(css, /\.global-guide-fab\s*\{[\s\S]*bottom:\s*48px/);
  assert.match(css, /\.global-guide-fab\s*\{[\s\S]*background:\s*linear-gradient\(135deg,\s*#f25c05/);
  assert.match(css, /\.global-guide-fab\s*\{[\s\S]*animation:\s*accountTelegramHop/);
});

test('thông tin license nằm ở thanh trái và không còn badge nổi bên phải', () => {
  assert.match(html, /id="sidebar-license-status"/);
  assert.match(html, /Thông tin license/);
  assert.doesNotMatch(html, /Server đang chạy/);
  assert.match(license, /getElementById\('sidebar-license-status'\)/);
  assert.doesNotMatch(license, /position:fixed;bottom:10px;right:12px/);
  assert.match(css, /\.sidebar-license-status\s*\{/);
});

test('Thanh toán là task thứ hai bên trong Cài đặt', () => {
  assert.doesNotMatch(html, /data-page="account"/);
  assert.doesNotMatch(html, /id="page-account"/);
  assert.ok(settings.indexOf('<strong>Cài đặt</strong>') < settings.indexOf('<strong>Thanh toán</strong>'));
  assert.match(settings, /onclick="Settings\.selectTask\('settings'\)"/);
  assert.match(settings, /onclick="Settings\.selectTask\('account'\)"/);
  assert.match(settings, /Account\.load\('settings-task-account'\)/);
  assert.match(account, /containerId:\s*'settings-task-account'/);
  assert.match(css, /\.settings-task-switch\s*\{/);
});

test('Thanh toán không còn khối chia nền tảng', () => {
  assert.doesNotMatch(account, /settings-section-title">🧩 Nền tảng/);
  assert.doesNotMatch(account, /renderPlatform\(/);
});

test('icon Telegram nảy nhẹ, responsive và dừng khi giảm chuyển động', () => {
  assert.match(css, /\.account-telegram-fab\s*\{[\s\S]*animation:\s*accountTelegramHop/);
  assert.match(css, /@keyframes accountTelegramHop/);
  assert.match(css, /\.account-guide-viewer\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.55fr\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.account-guide-viewer\s*\{[\s\S]*grid-template-areas:\s*"video"\s*"playlist"/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.account-playlist-list\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.account-telegram-fab\s*\{\s*animation:\s*none/);
});
