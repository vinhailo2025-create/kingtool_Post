const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const control = fs.readFileSync(path.join(root, 'src', 'services', 'telegram-control.service.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'telegram-notification.service.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
const route = fs.readFileSync(path.join(root, 'src', 'routes', 'telegram.routes.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const aiService = fs.readFileSync(path.join(root, 'src', 'services', 'ai-content.service.js'), 'utf8');

test('Telegram điều khiển dùng menu rẽ nhánh và chọn nền tảng/profile', () => {
  assert.match(control, /editMessageText/);
  assert.match(control, /activeMessageId/);
  assert.match(control, /ctl:post/);
  assert.match(control, /ctl:mode:now/);
  assert.match(control, /ctl:mode:schedule/);
  assert.match(control, /ctl:platforms:one/);
  assert.match(control, /ctl:platforms:many/);
  assert.match(control, /ctl:platforms:done/);
  assert.match(control, /ctl:profiles:all/);
  assert.match(control, /ctl:filter:groups/);
  assert.match(control, /ctl:filter:providers/);
  assert.match(control, /isResetCommand/);
  assert.match(control, /\/\(\?:start\|reset\)/);
  assert.match(control, /DataService\.create/);
  assert.match(control, /RunnerManager\.get/);
  assert.match(control, /SchedulerService\.create/);
});

test('Telegram has AI content, AI image and immediate running state', () => {
  assert.match(control, /ctl:content:ai/);
  assert.match(control, /ctl:content:table/);
  assert.match(control, /tableRowsForSession/);
  assert.match(control, /session\.dataSource === 'table'/);
  assert.match(control, /ManagedTargetsService\.matchTargets/);
  assert.match(control, /fanpageMappings/);
  assert.match(control, /channelMappings/);
  assert.match(control, /ctl:media:ai/);
  assert.match(control, /generateAiContent/);
  assert.match(control, /generateAiImage/);
  assert.match(control, /generateStandaloneImage/);
  assert.match(aiService, /async function generateStandaloneImage/);
  assert.match(control, /name_profile:\s*target\.profileName/);
  assert.match(control, /status:\s*'running'/);
  assert.match(control, /runner\.start\(/);
  assert.match(control, /preserveMessages/);
  assert.match(control, /session\.preserveMessages = true/);
});

test('Telegram có báo cáo theo ngày và AI chỉ hiểu lệnh khi cần', () => {
  assert.match(control, /ctl:report:7/);
  assert.match(control, /ctl:report:custom/);
  assert.match(control, /date\(created_at, 'localtime'\)/);
  assert.match(control, /AiContentService\._private\.generateText/);
  assert.match(service, /telegram_control_enabled/);
  assert.match(service, /telegram_control_ai_enabled/);
});

test('Cài đặt Telegram có bật điều khiển và gửi menu', () => {
  assert.match(settings, /telegram-control-enabled/);
  assert.match(settings, /telegram-control-ai-enabled/);
  assert.match(settings, /Settings\.sendTelegramMenu\(\)/);
  assert.match(route, /router\.post\('\/menu'/);
  assert.match(css, /\.telegram-control-box/);
});
