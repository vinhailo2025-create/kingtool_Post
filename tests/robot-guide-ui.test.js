const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const browsers = fs.readFileSync(path.join(root, 'public', 'js', 'browser-manager.js'), 'utf8');
const data = fs.readFileSync(path.join(root, 'public', 'js', 'data-manager.js'), 'utf8');
const automation = fs.readFileSync(path.join(root, 'public', 'js', 'automation.js'), 'utf8');
const postConfig = fs.readFileSync(path.join(root, 'public', 'js', 'post-config.js'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'public', 'js', 'runner.js'), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'public', 'js', 'scheduler.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const guide = fs.readFileSync(path.join(root, 'public', 'js', 'robot-guide.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'robot-guide.css'), 'utf8');
const mainCss = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');

test('Robot hướng dẫn có trung tâm chọn chương và lưu tiến độ', () => {
  assert.match(html, /onclick="RobotGuide\.open\(\)"/);
  assert.match(html, /robot-guide\.css\?v=20260905guide2/);
  assert.match(html, /robot-guide\.js\?v=20260905guide3/);
  for (const chapter of ['welcome', 'browser', 'facebook', 'advanced']) {
    assert.match(guide, new RegExp(`id: '${chapter}'`));
  }
  assert.match(guide, /Học toàn bộ tool/);
  assert.match(guide, /Tiếp tục bước đang dở/);
  assert.match(guide, /localStorage\.setItem\(this\.storageKey/);
});

test('Nút hướng dẫn tách BOT và video tài liệu thành hai nhánh', () => {
  assert.match(guide, /class="robot-guide-help-choices"/);
  assert.match(guide, />BOT hướng dẫn</);
  assert.match(guide, />Video &amp; tài liệu</);
  assert.match(guide, /onclick="RobotGuide\.openBot\(\)"/);
  assert.match(guide, /onclick="RobotGuide\.openDocuments\(\)"/);
  assert.match(guide, /openDocuments\(\)\s*\{[\s\S]*Settings\.openGuideSection\(\)/);
  assert.match(css, /\.robot-guide-help-choices\s*\{[\s\S]*grid-template-columns:\s*repeat\(2/);
});

test('Robot follow nút thật, tự chuyển trang và không tự click thao tác', () => {
  assert.match(guide, /App\.navigateTo\(step\.page/);
  assert.match(guide, /scrollIntoView/);
  assert.match(guide, /getBoundingClientRect\(\)/);
  assert.match(guide, /waitForSelector\(step\.selector/);
  assert.doesNotMatch(guide, /this\.target\.click\(|target\?*\.click\(/);

  const allMarkup = [html, app, browsers, data, postConfig, runner, scheduler].join('\n');
  for (const id of [
    'app-brand', 'main-navigation', 'browser-create', 'browser-connect',
    'browser-groups', 'browser-table', 'data-grid',
    'data-profile-map', 'data-target-map', 'data-automation',
    'config-limit', 'config-antibot', 'config-comments', 'runner-log',
    'scheduler-table',
  ]) {
    assert.match(allMarkup, new RegExp(`data-tour-id="${id}"`));
  }
});

test('Robot mở popup Tự động hóa và hướng dẫn bên trong nhưng không bấm Chạy', () => {
  assert.match(guide, /openAutomation:\s*true/);
  assert.match(guide, /await Automation\.show\(\)/);
  assert.match(guide, /closeAppModal:\s*true/);
  for (const id of ['automation-profiles', 'automation-mode', 'automation-run']) {
    assert.match(automation, new RegExp(`data-tour-id="${id}"`));
  }
  assert.doesNotMatch(guide, /Automation\.run\(\)/);
  assert.doesNotMatch(guide, /Excel|Google Sheets/);
});

test('Robot có spotlight, tiến độ, responsive và giảm chuyển động', () => {
  assert.match(css, /\.robot-guide-spotlight\s*\{[\s\S]*0 0 0 9999px/);
  assert.match(css, /\.robot-guide-card\s*\{[\s\S]*position:\s*fixed/);
  assert.match(css, /\.robot-guide-progress\s*\{/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.robot-guide-card/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('Playlist giữ video và danh sách thành hai cột, danh sách cuộn riêng', () => {
  assert.match(mainCss, /\.account-guide-viewer\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.55fr\)\s*minmax\(320px,\s*\.85fr\)/);
  assert.match(settings, /class="account-video-panel"/);
  assert.match(settings, /id="settings-video-panel-title"/);
  assert.match(mainCss, /\.account-playlist-list\s*\{[\s\S]*overflow-y:\s*auto/);
  assert.doesNotMatch(settings, /syncGuideViewerLayout|ResizeObserver|playlist\.style\.height/);
  assert.match(mainCss, /\.account-playlist\s*\{[\s\S]*height:\s*clamp\(360px,\s*38vw,\s*620px\)/);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*\.account-guide-viewer\s*\{[\s\S]*grid-template-columns:\s*1fr/);
});
