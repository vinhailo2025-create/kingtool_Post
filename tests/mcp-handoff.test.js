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
  assert.match(installer, /super-post-king-local/);
  assert.match(installer, /Remove-MemberProperty \$desktopMcpServers 'super-post-king'/);
  assert.match(launcher, /agent-api-endpoint\.json/);
  assert.match(launcher, /node_path/);
  assert.match(launcher, /InstallDir/);
});

test('MCP bình luận theo link mô tả đúng luồng riêng và chạy ngay', () => {
  const sourceMcp = read('scripts/super-post-mcp-server.js');
  const packagedMcp = read(
    'packaging/super-post-agent-kit-marketplace/plugins/super-post-agent-kit/mcp/super-post-mcp-server.js'
  );
  for (const mcp of [sourceMcp, packagedMcp]) {
    assert.match(mcp, /name: 'super_post_comment_links'/);
    assert.match(mcp, /Bình luận ngay vào các link bài có sẵn \(Facebook, Threads, Instagram, X\)/);
    assert.match(mcp, /không yêu cầu trạng thái post/);
    assert.doesNotMatch(mcp, /xếp lịch bình luận theo delay trong Cài đặt/);
    assert.match(mcp, /api\('\/api\/agent\/v1\/comment-links'/);
  }
});

test('Agent Kit bàn giao được tạo từ source theo dõi bởi Git và chỉ đóng gói bản bảo vệ', () => {
  const releaseScript = read('scripts/package-release.ps1');
  const protectionScript = read('scripts/build-protected-agent-kit.js');

  assert.match(releaseScript, /release\\agent-kit/);
  assert.match(releaseScript, /super-post-mcp-server\.jsc/);
  assert.match(releaseScript, /forbidden/);
  assert.match(protectionScript, /packaging.*super-post-agent-kit-marketplace/s);
  assert.match(protectionScript, /bytenode\.compileFile/);
  assert.match(protectionScript, /removeIfPresent\(path\.join\(mcpDir, 'super-post-mcp-server\.js'\)\)/);
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
  assert.match(publishScript, /đã gồm bộ cài, hướng dẫn/);
  assert.match(publishScript, /\$checksum = "\$installer\.sha256"/);
  assert.match(publishScript, /\$assets = @\(\s*\$installer,\s*\$checksum,\s*\$handoff/);
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
  assert.match(
    build,
    /include-data-file=%APP_STAGE%\\scripts\\super-post-mcp-server\.js/
  );
  assert.match(build, /include-data-dir=%APP_STAGE%\\agent-kit=agent-kit/);
  assert.match(build, /release\\agent-kit/);
  assert.match(build, /super-post-mcp-server\.jsc/);
  assert.match(build, /if exist .*agent-kit.*super-post-mcp-server\.js/);
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
