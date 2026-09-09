'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'desktop_launcher.dist');
const port = 32000 + (process.pid % 1000);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-protected-smoke-'));
const output = [];

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 5000).unref();
  });
}

async function waitForHealth(child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Protected server exited early (${child.exitCode}): ${output.join('')}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/v1/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Protected server did not become healthy: ${output.join('')}`);
}

async function main() {
  const mcpRoot = path.join(DIST, 'agent-kit', 'plugins', 'super-post-agent-kit', 'mcp');
  assert.equal(fs.existsSync(path.join(mcpRoot, 'super-post-mcp-server.js')), false);
  assert.equal(fs.existsSync(path.join(mcpRoot, 'super-post-mcp-server.jsc')), true);
  assert.equal(fs.existsSync(path.join(DIST, 'src', 'chrome-profiles')), false);
  assert.equal(fs.existsSync(path.join(DIST, 'src', 'backups')), false);

  const sourceServer = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const protectedServer = fs.readFileSync(path.join(DIST, 'server.js'), 'utf8');
  assert.notEqual(protectedServer, sourceServer);
  assert.doesNotMatch(protectedServer, /Super Post - King Server/);

  const nodePath = path.join(DIST, 'bin', 'node.exe');
  const child = spawn(nodePath, ['server.js'], {
    cwd: DIST,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      AUTO_OPEN_BROWSER: '0',
      COVERGEMAUTO_DESKTOP: '1',
      COVERGEMAUTO_PARENT_PID: String(process.pid),
      COVERGEMAUTO_DATA_DIR: dataRoot,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));

  try {
    const response = await waitForHealth(child);
    assert.equal(response.success, true);
    assert.equal(response.data.service, 'super-post-king-agent-api');
    console.log(`Protected build healthy on temporary port ${port}.`);
  } finally {
    child.kill();
    await waitForExit(child);
  }
}

main()
  .finally(() => fs.rmSync(dataRoot, { recursive: true, force: true }))
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
