const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('Claude Desktop, Claude Code và OpenClaw dùng Agent Kit ổn định sau khi folder giải nén đổi chỗ', t => {
  if (process.platform !== 'win32') return t.skip('Cross-agent installer chỉ dành cho Windows.');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-agent-kit-install-'));
  const extractedPlugin = path.join(tempRoot, 'Folder giải nén', 'super-post-agent-kit');
  const userHome = path.join(tempRoot, 'User Home');
  const roaming = path.join(tempRoot, 'Roaming');
  const local = path.join(tempRoot, 'Local');
  const sourcePlugin = path.join(
    __dirname,
    '..',
    'packaging',
    'super-post-agent-kit-marketplace',
    'plugins',
    'super-post-agent-kit'
  );
  fs.cpSync(sourcePlugin, extractedPlugin, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const installScript = path.join(extractedPlugin, 'scripts', 'install-cross-agent.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    installScript,
    '-Agent',
    'All',
    '-UserHome',
    userHome,
    '-RoamingAppData',
    roaming,
    '-LocalAppDataPath',
    local,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const stableRoot = path.join(local, 'King Automation AI', 'Super Post Agent Kit');
  const stableNode = fs.readdirSync(path.join(stableRoot, 'runtime'))
    .filter(name => /^node-[a-f0-9]{16}\.exe$/.test(name))
    .map(name => path.join(stableRoot, 'runtime', name))[0];
  const stableMcp = path.join(stableRoot, 'mcp', 'super-post-mcp-server.js');
  const claude = JSON.parse(fs.readFileSync(
    path.join(roaming, 'Claude', 'claude_desktop_config.json'),
    'utf8'
  ).replace(/^\uFEFF/, ''));
  const claudeCode = JSON.parse(fs.readFileSync(
    path.join(userHome, '.claude.json'),
    'utf8'
  ).replace(/^\uFEFF/, ''));
  const openclaw = JSON.parse(fs.readFileSync(
    path.join(userHome, '.openclaw', 'openclaw.json'),
    'utf8'
  ).replace(/^\uFEFF/, ''));

  assert.equal(fs.existsSync(stableNode), true);
  assert.equal(claude.mcpServers['super-post-king-local'].command, stableNode);
  assert.equal(claude.mcpServers['super-post-king-local'].args.at(-1), stableMcp);
  assert.equal(claudeCode.mcpServers['super-post-king-local'].command, stableNode);
  assert.equal(claudeCode.mcpServers['super-post-king-local'].args.at(-1), stableMcp);
  assert.equal(claudeCode.mcpServers['super-post-king-local'].type, 'stdio');
  assert.equal(openclaw.mcp.servers['super-post-king-local'].command, stableNode);
  assert.equal(openclaw.mcp.servers['super-post-king-local'].args.at(-1), stableMcp);
  assert.equal(claude.mcpServers['super-post-king-local'].args.at(-1).startsWith(extractedPlugin), false);
  assert.equal(claudeCode.mcpServers['super-post-king-local'].args.at(-1).startsWith(extractedPlugin), false);
  assert.equal(claude.mcpServers['super-post-king'], undefined);

  const claudeSkill = fs.realpathSync(path.join(userHome, '.claude', 'skills', 'post-face-super-post'));
  const openclawSkill = fs.realpathSync(path.join(userHome, '.openclaw', 'skills', 'post-face-super-post'));
  assert.equal(claudeSkill, path.join(stableRoot, 'skills', 'post-face-super-post'));
  assert.equal(openclawSkill, path.join(stableRoot, 'skills', 'post-face-super-post'));
});
