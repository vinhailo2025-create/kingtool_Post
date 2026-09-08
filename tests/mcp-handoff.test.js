const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('MCP handoff không phụ thuộc folder code hoặc user của máy build', () => {
  const mcp = read('scripts/super-post-mcp-server.js');
  const installer = read('packaging/super-post-agent-kit-marketplace/plugins/super-post-agent-kit/scripts/install-cross-agent.ps1');
  const launcher = read('packaging/super-post-agent-kit-marketplace/plugins/super-post-agent-kit/scripts/start-mcp.ps1');
  const runtime = `${mcp}\n${installer}\n${launcher}`;

  assert.doesNotMatch(runtime, /C:\\Users\\Admin|Foldercode_Vinh/i);
  assert.match(installer, /Super Post Agent Kit/);
  assert.match(installer, /LocalAppDataPath/);
  assert.match(installer, /runtimeRoot/);
  assert.match(installer, /stableNodePath/);
  assert.match(launcher, /agent-api-endpoint\.json/);
  assert.match(launcher, /node_path/);
  assert.match(launcher, /InstallDir/);
});

test('nguồn Agent Kit để đóng gói nằm trong thư mục được Git theo dõi', () => {
  const releaseScript = read('scripts/package-release.ps1');

  assert.match(releaseScript, /packaging\\super-post-agent-kit-marketplace/);
  assert.doesNotMatch(releaseScript, /release\\super-post-agent-kit-marketplace/);
  assert.equal(
    fs.existsSync(path.join(
      root,
      'packaging',
      'super-post-agent-kit-marketplace',
      'plugins',
      'super-post-agent-kit',
      '.codex-plugin',
      'plugin.json'
    )),
    true
  );
});

test('GitHub Release có đủ gói bàn giao như Drive và giữ installer cho auto-update', () => {
  const publishScript = read('scripts/publish-github-release.ps1');

  assert.match(publishScript, /package-release\.ps1/);
  assert.match(publishScript, /Super-Post-King-Ban-Giao\.zip/);
  assert.match(publishScript, /HUONG-DAN-CAN-DAT\.txt/);
  assert.match(publishScript, /Super-Post-Agent-Kit-\*\.zip/);
  assert.match(publishScript, /SHA256\.txt/);
  assert.match(publishScript, /Super-Post-King-Setup\.exe/);
  assert.match(publishScript, /Source code \(zip\)/);
  assert.match(publishScript, /gh release (?:upload|create) \$tag \$assets/);
});

test('installer đăng ký install dir, đóng gói MCP và chặn mọi Agent API key runtime', () => {
  const inno = read('packaging/SuperPostKing.iss');
  const build = read('build.bat');
  const server = read('server.js');
  const config = read('config.js');
  const launcher = read('desktop_launcher.py');

  assert.match(inno, /\[Registry\][\s\S]*InstallDir/);
  assert.match(build, /include-data-file=scripts\\super-post-mcp-server\.js/);
  assert.match(build, /include-data-dir=%APP_STAGE%\\agent-kit=agent-kit/);
  assert.match(build, /super-post-agent-kit-marketplace/);
  assert.match(build, /\/XF "agent-api-key\.txt"/);
  assert.match(build, /if exist "%DIST_DIR%\\desktop_launcher\.dist\\src\\database\\agent-api-key\.txt" exit \/b 1/);
  assert.match(config, /AGENT_API_ENDPOINT_PATH/);
  assert.match(server, /registerAgentEndpoint/);
  assert.match(server, /unregisterAgentEndpoint/);
  assert.match(server, /AgentKitService\.syncInstalled\(\)/);
  assert.match(server, /Agent Kit auto-sync error/);
  assert.match(server, /node_path: process\.execPath/);
  assert.match(server, /COVERGEMAUTO_PARENT_PID/);
  assert.match(server, /process\.kill\(desktopParentPid, 0\)/);
  assert.match(launcher, /CreateMutexW/);
  assert.match(launcher, /ERROR_ALREADY_EXISTS/);
  assert.match(launcher, /SetForegroundWindow/);
  assert.match(launcher, /COVERGEMAUTO_PARENT_PID/);
});
