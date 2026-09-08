const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('one-click Agent Kit installer configures Claude, Codex and OpenClaw in isolated home', {
  skip: process.platform !== 'win32',
}, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-agent-kit-install-'));
  const userHome = path.join(tempRoot, 'user');
  const roaming = path.join(tempRoot, 'roaming');
  const local = path.join(tempRoot, 'local');
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(local, { recursive: true });

  try {
    const script = path.resolve(
      'packaging',
      'super-post-agent-kit-marketplace',
      'plugins',
      'super-post-agent-kit',
      'scripts',
      'install-cross-agent.ps1'
    );
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Agent',
      'All',
      '-ReplaceExisting',
      '-UserHome',
      userHome,
      '-RoamingAppData',
      roaming,
      '-LocalAppDataPath',
      local,
    ], {
      encoding: 'utf8',
      timeout: 120000,
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const stableRoot = path.join(local, 'King Automation AI', 'Super Post Agent Kit');
    const manifest = JSON.parse(fs.readFileSync(
      path.join(stableRoot, '.codex-plugin', 'plugin.json'),
      'utf8'
    ));
    assert.match(manifest.version, /^0\.4\.0\+/);

    const claudeDesktop = JSON.parse(fs.readFileSync(
      path.join(roaming, 'Claude', 'claude_desktop_config.json'),
      'utf8'
    ).replace(/^\uFEFF/, ''));
    const claudeCode = JSON.parse(fs.readFileSync(
      path.join(userHome, '.claude.json'),
      'utf8'
    ).replace(/^\uFEFF/, ''));
    const openClaw = JSON.parse(fs.readFileSync(
      path.join(userHome, '.openclaw', 'openclaw.json'),
      'utf8'
    ).replace(/^\uFEFF/, ''));
    const codex = fs.readFileSync(path.join(userHome, '.codex', 'config.toml'), 'utf8');

    assert.match(claudeDesktop.mcpServers['super-post-king'].args[0], /Super Post Agent Kit/i);
    assert.match(claudeCode.mcpServers['super-post-king'].args[0], /Super Post Agent Kit/i);
    assert.match(openClaw.mcp.servers['super-post-king'].args[0], /Super Post Agent Kit/i);
    assert.match(codex, /\[mcp_servers\.super-post-king\]/);
    assert.match(codex, /Super Post Agent Kit/i);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
