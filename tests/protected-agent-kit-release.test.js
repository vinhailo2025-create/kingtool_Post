const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const protectedRoot = path.join(root, 'release', 'agent-kit');
const pluginRoot = path.join(protectedRoot, 'plugins', 'super-post-agent-kit');

function buildProtectedKit() {
  const result = spawnSync(process.execPath, ['scripts/build-protected-agent-kit.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('protected Agent Kit ships bytecode and minimal agent-readable instructions', () => {
  buildProtectedKit();

  const mcpRoot = path.join(pluginRoot, 'mcp');
  assert.equal(fs.existsSync(path.join(mcpRoot, 'super-post-mcp-server.js')), false);
  assert.equal(fs.existsSync(path.join(mcpRoot, 'super-post-mcp-server.jsc')), true);
  assert.equal(fs.existsSync(path.join(
    pluginRoot,
    'skills',
    'post-face-super-post',
    'references',
    'super-post-contract.md'
  )), false);
  assert.equal(fs.existsSync(path.join(
    pluginRoot,
    'skills',
    'super-post-profile-mapper',
    'references',
    'profile-target-contract.md'
  )), false);

  const skill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'post-face-super-post', 'SKILL.md'),
    'utf8'
  );
  assert.match(skill, /Chỉ dùng các MCP tool/);
  assert.doesNotMatch(skill, /\/api\/agent\/v1|agent-api-key|database/i);
});

test('protected MCP bytecode starts and advertises all tools to the agent', () => {
  buildProtectedKit();

  const loader = path.join(pluginRoot, 'runtime', 'bytenode', 'index.js');
  const bytecode = path.join(pluginRoot, 'mcp', 'super-post-mcp-server.jsc');
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const result = spawnSync(process.execPath, ['-r', loader, bytecode], {
    input: `${request}\n`,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  assert.equal(response.result.tools.length, 38);
  assert.equal(response.result.tools[0].name, 'super_post_get_capabilities');
});

test('protected Agent Kit installer configures bytecode from a stable folder', {
  skip: process.platform !== 'win32',
}, () => {
  buildProtectedKit();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-protected-kit-'));
  const userHome = path.join(tempRoot, 'user');
  const roaming = path.join(tempRoot, 'roaming');
  const local = path.join(tempRoot, 'local');
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  const staleMcp = path.join(
    local,
    'King Automation AI',
    'Super Post Agent Kit',
    'mcp',
    'super-post-mcp-server.js'
  );
  const staleReferences = path.join(
    local,
    'King Automation AI',
    'Super Post Agent Kit',
    'skills',
    'post-face-super-post',
    'references'
  );
  fs.mkdirSync(path.dirname(staleMcp), { recursive: true });
  fs.mkdirSync(staleReferences, { recursive: true });
  fs.writeFileSync(staleMcp, 'legacy source', 'utf8');
  fs.writeFileSync(path.join(staleReferences, 'super-post-contract.md'), 'legacy docs', 'utf8');

  try {
    const script = path.join(pluginRoot, 'scripts', 'install-cross-agent.ps1');
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
    const claude = JSON.parse(fs.readFileSync(
      path.join(roaming, 'Claude', 'claude_desktop_config.json'),
      'utf8'
    ).replace(/^\uFEFF/, ''));
    const server = claude.mcpServers['super-post-king-local'];
    assert.match(server.command, /runtime[\\/]node-[a-f0-9]{16}\.exe$/);
    assert.equal(fs.existsSync(server.command), true);
    assert.deepEqual(server.args.slice(0, 2), [
      '-r',
      path.join(stableRoot, 'runtime', 'bytenode', 'index.js'),
    ]);
    assert.equal(server.args.at(-1), path.join(
      stableRoot,
      'mcp',
      'super-post-mcp-server.jsc'
    ));
    assert.equal(fs.existsSync(path.join(
      stableRoot,
      'mcp',
      'super-post-mcp-server.js'
    )), false);
    assert.equal(fs.existsSync(path.join(
      stableRoot,
      'skills',
      'post-face-super-post',
      'references'
    )), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
