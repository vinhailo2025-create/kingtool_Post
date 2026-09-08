const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function waitForMessages(child, ids) {
  const pending = new Set(ids);
  const found = new Map();
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 5000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (!pending.has(message.id)) continue;
        found.set(message.id, message);
        pending.delete(message.id);
        if (!pending.size) {
          clearTimeout(timer);
          resolve(found);
        }
      }
    });
    child.on('error', reject);
  });
}

test('MCP exposes schedule CRUD and forwards idempotent create without runner overrides', async t => {
  let received = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: { service: 'super-post-king-agent-api', version: 1 },
      }));
    }
    if (req.url === '/api/agent/v1/schedules' && req.method === 'POST') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        received = JSON.parse(raw);
        res.statusCode = 201;
        res.end(JSON.stringify({
          success: true,
          data: {
            schedule_id: 7,
            schedule_key: received.schedule_key,
            status: 'waiting',
            enabled: true,
          },
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-schedule-'));
  const keyFile = path.join(tempDir, 'agent-api-key.txt');
  fs.writeFileSync(keyFile, 'a'.repeat(64));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js'),
  ], {
    env: {
      ...process.env,
      SUPER_POST_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      SUPER_POST_AGENT_KEY_FILE: keyFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill(); });

  const responses = waitForMessages(child, [1, 2, 3]);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'super_post_create_schedule',
      arguments: {
        schedule_key: 'scheduled-post-001',
        name: 'Lịch MCP',
        platform: 'facebook',
        schedule_type: 'once',
        schedule_time: '2026-10-01T02:00:00+07:00',
        profile_ids: [2],
        data_ids: [42],
      },
    },
  })}\n`);

  const messages = await responses;
  const names = messages.get(2).result.tools.map(tool => tool.name);
  for (const name of [
    'super_post_list_schedules',
    'super_post_get_schedule',
    'super_post_create_schedule',
    'super_post_update_schedule',
    'super_post_set_schedule_enabled',
    'super_post_delete_schedule',
  ]) {
    assert.ok(names.includes(name), `missing MCP schedule tool: ${name}`);
  }
  assert.equal(messages.get(3).result.isError, false);
  assert.equal(messages.get(3).result.structuredContent.schedule_id, 7);
  assert.equal(received.schedule_key, 'scheduled-post-001');
  assert.equal('concurrency' in received, false);
  assert.equal('delay_min' in received, false);
  assert.equal('delay_max' in received, false);
});
