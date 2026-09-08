const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src', 'routes', 'telegram.routes.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'telegram-notification.service.js'), 'utf8');

test('Cài đặt có Telegram ngay trước Google Sheets với trạng thái dọc', () => {
  assert.match(settings, /renderAccordion\(\s*'telegram'/);
  assert.match(settings, /renderTelegramSettings\(\)/);
  assert.match(settings, /input type="checkbox" name="telegram-status"/);
  assert.match(settings, /Thông báo Telegram/);
  assert.match(css, /\.telegram-status-list\s*\{\s*display:\s*grid/);
});

test('Telegram chỉ nhận Bot Token và có tự dò chat, gửi thử, mẫu tùy chỉnh', () => {
  assert.match(settings, /id="telegram-token"/);
  assert.match(settings, /connectTelegram\(\)/);
  assert.match(settings, /showTelegramTemplateModal\(\)/);
  assert.match(settings, /insertTelegramVariable/);
  assert.match(route, /router\.post\('\/connect'/);
  assert.match(route, /router\.post\('\/test'/);
  assert.match(service, /getUpdates/);
  assert.match(service, /\/start/);
  assert.match(service, /setMyCommands/);
  assert.match(service, /BOT_COMMANDS/);
  assert.match(service, /notifyStatusChange/);
});

test('server mount Telegram route and initializes polling', () => {
  assert.match(server, /app\.use\('\/api\/telegram', require\('\.\/src\/routes\/telegram\.routes'\)\)/);
  assert.match(server, /telegram-notification\.service'\)\.init/);
});
