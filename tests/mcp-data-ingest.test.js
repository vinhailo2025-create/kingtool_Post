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

test('MCP exposes and forwards single/batch pending data without publish calls', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: { service: 'super-post-king-agent-api', version: 1 },
      }));
    }
    if (
      req.method === 'POST'
      && ['/api/agent/v1/platform-data', '/api/agent/v1/platform-data/batch'].includes(req.url)
    ) {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ url: req.url, body });
        const items = req.url.endsWith('/batch') ? body.items : [body];
        const resultItems = items.map((item, index) => ({
          post_id: index + 10,
          data_key: item.data_key,
          platform: body.platform,
          status: 'pending',
          job_created: false,
          runner_started: false,
        }));
        res.statusCode = 201;
        res.end(JSON.stringify({
          success: true,
          data: req.url.endsWith('/batch')
            ? {
              platform: body.platform,
              status: 'pending',
              total: resultItems.length,
              created_count: resultItems.length,
              replay_count: 0,
              job_count: 0,
              runner_started: false,
              items: resultItems,
            }
            : resultItems[0],
        }));
      });
      return;
    }
    if (
      req.method === 'POST'
      && ['/api/agent/v1/publish-data', '/api/agent/v1/publish-data-batch'].includes(req.url)
    ) {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ url: req.url, body });
        if (req.url.endsWith('/batch') || req.url.endsWith('-batch')) {
          const jobs = body.items.map((item, index) => ({
            job_id: `existing_batch_job_${index + 1}`,
            batch_id: 'existing_batch_1',
            post_id: item.post_id,
            status: 'queued',
          }));
          return res.end(JSON.stringify({
            success: true,
            data: {
              batch_id: 'existing_batch_1',
              platform: body.platform,
              status: 'queued',
              total: jobs.length,
              pending_count: jobs.length,
              success_count: 0,
              error_count: 0,
              jobs,
            },
          }));
        }
        return res.end(JSON.stringify({
          success: true,
          data: {
            job_id: 'existing_single_job',
            post_id: body.post_id,
            status: 'queued',
          },
        }));
      });
      return;
    }
    requests.push({ url: req.url, method: req.method });
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-data-'));
  const keyFile = path.join(tempDir, 'agent-api-key.txt');
  fs.writeFileSync(keyFile, 'd'.repeat(64));
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

  const responses = waitForMessages(child, [1, 2, 3, 4, 5, 6]);
  for (const message of [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'super_post_create_data',
        arguments: {
          data_key: 'mcp-draft-single',
          platform: 'facebook',
          content: 'Một hàng chờ',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'super_post_create_data_batch',
        arguments: {
          platform: 'facebook',
          items: [
            { data_key: 'mcp-draft-batch-1', content: 'Hàng chờ 1' },
            { data_key: 'mcp-draft-batch-2', content: 'Hàng chờ 2' },
          ],
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'super_post_publish_data',
        arguments: {
          platform: 'facebook',
          post_id: 10,
          request_id: 'publish-existing-mcp-single',
          wait_seconds: 0,
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'super_post_publish_data_batch',
        arguments: {
          platform: 'facebook',
          batch_key: 'publish-existing-mcp-batch',
          items: [
            { item_key: 'row-10', post_id: 10 },
            { item_key: 'row-11', post_id: 11 },
          ],
          wait_seconds: 0,
        },
      },
    },
  ]) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  const messages = await responses;
  const names = messages.get(2).result.tools.map(tool => tool.name);
  assert.ok(names.includes('super_post_create_data'));
  assert.ok(names.includes('super_post_create_data_batch'));
  assert.ok(names.includes('super_post_publish_data'));
  assert.ok(names.includes('super_post_publish_data_batch'));
  assert.equal(messages.get(3).result.isError, false);
  assert.equal(messages.get(3).result.structuredContent.status, 'pending');
  assert.equal(messages.get(4).result.isError, false);
  assert.equal(messages.get(4).result.structuredContent.total, 2);
  assert.equal(messages.get(5).result.structuredContent.post_id, 10);
  assert.equal(messages.get(6).result.structuredContent.total, 2);
  assert.deepEqual(requests.map(item => item.url), [
    '/api/agent/v1/platform-data',
    '/api/agent/v1/platform-data/batch',
    '/api/agent/v1/publish-data',
    '/api/agent/v1/publish-data-batch',
  ]);
  assert.ok(requests.slice(0, 2).every(item => !('wait_seconds' in item.body)));
  assert.ok(requests.slice(2).every(item => item.body.wait_seconds === 0));
  assert.equal(requests[2].body.request_id, 'publish-existing-mcp-single');
});
