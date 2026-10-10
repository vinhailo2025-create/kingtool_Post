const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('Cài đặt Agent chỉ giữ thao tác kết nối, thống kê MCP nằm gọn ở Dashboard', () => {
  const settings = fs.readFileSync('public/js/settings.js', 'utf8');
  const dashboard = fs.readFileSync('public/js/dashboard.js', 'utf8');
  const css = fs.readFileSync('public/css/style.css', 'utf8');
  const app = fs.readFileSync('public/js/app.js', 'utf8');

  assert.match(settings, /'agent-mcp'/);
  assert.match(settings, /renderAgentMcpSettings\(\)/);
  assert.match(settings, /\/api\/settings\/agent-mcp\/install/);
  assert.match(settings, /Realtime/);
  assert.match(css, /\.agent-mcp-card/);
  assert.doesNotMatch(settings, /agent-live-stats|agent-client-list|agent-mcp-last-error/);
  assert.match(settings, /Thống kê hoạt động được theo dõi tại Dashboard/);
  assert.match(dashboard, /\/api\/settings\/agent-mcp\/status/);
  assert.match(dashboard, /_renderMcpOverview\(\)/);
  assert.match(css, /\.dash-mcp-panel/);
  assert.match(css, /\.dash-mcp-bar/);
  assert.match(app, /Dashboard\.onAgentEvent/);
  assert.match(app, /data\.type === 'agent_event'/);
  assert.match(fs.readFileSync('server.js', 'utf8'), /agent_event_type: event\.type/);
  assert.doesNotMatch(settings, /Agent.*Timeline|Timeline.*Agent/);
});
