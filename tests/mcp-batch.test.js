const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('MCP batch mở rộng nhiều Fanpage và không truyền cài đặt runner từ agent', async t => {
  let receivedBatch = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: { service: 'super-post-king-agent-api', version: 1 },
      }));
    }
    if (req.url === '/api/agent/v1/profiles?platform=facebook') {
      return res.end(JSON.stringify({
        success: true,
        data: [{ id: 2, name: 'super-1', platform: 'facebook' }],
      }));
    }
    if (req.url === '/api/agent/v1/publish-batch' && req.method === 'POST') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        receivedBatch = JSON.parse(raw);
        const jobs = receivedBatch.items.map((item, index) => ({
          job_id: `job_${index + 1}`,
          batch_id: 'batch_test',
          request_id: item.request_id,
          platform: 'facebook',
          profile_id: item.profile_id,
          profile: 'super-1',
          post_id: index + 1,
          status: 'queued',
          result: null,
          error: null,
        }));
        res.end(JSON.stringify({
          success: true,
          data: {
            batch_id: 'batch_test',
            platform: 'facebook',
            status: 'queued',
            total: jobs.length,
            success_count: 0,
            error_count: 0,
            pending_count: jobs.length,
            jobs,
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
  const port = server.address().port;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-batch-'));
  const keyFile = path.join(tempDir, 'agent-api-key.txt');
  fs.writeFileSync(keyFile, 'a'.repeat(64));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js'),
  ], {
    env: {
      ...process.env,
      SUPER_POST_BASE_URL: `http://127.0.0.1:${port}`,
      SUPER_POST_AGENT_KEY_FILE: keyFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill(); });

  const response = new Promise((resolve, reject) => {
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
        if (message.id === 2) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    });
    child.on('error', reject);
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'super_post_publish_batch',
      arguments: {
        batch_key: 'batch-test-01',
        platform: 'facebook',
        profile_ids: [2],
        distribution: 'mapped',
        items: [{
          item_key: 'row-1',
          content: 'Nội dung test',
          fanpages: [
            'https://www.facebook.com/page-a',
            'https://www.facebook.com/page-b',
          ],
        }],
        wait_seconds: 0,
      },
    },
  })}\n`);

  const result = await response;
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.total, 2);
  assert.equal(receivedBatch.items.length, 2);
  assert.deepEqual(receivedBatch.items.map(item => item.profile_id), [2, 2]);
  assert.deepEqual(receivedBatch.items.map(item => item.fanpage), [
    'https://www.facebook.com/page-a',
    'https://www.facebook.com/page-b',
  ]);
  assert.equal('concurrency' in receivedBatch, false);
  assert.equal('delay_min' in receivedBatch, false);
  assert.notEqual(receivedBatch.items[0].request_id, receivedBatch.items[1].request_id);
});

test('MCP đăng Nhóm đăng gồm hai profile timeline và một Fanpage thành ba job', async t => {
  let receivedBatch = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: { service: 'super-post-king-agent-api', version: 1 },
      }));
    }
    if (req.url === '/api/agent/v1/publish-groups/sales-team-01?platform=facebook') {
      return res.end(JSON.stringify({
        success: true,
        data: {
          id: 7,
          group_key: 'sales-team-01',
          name: 'Nhóm bán hàng 01',
          platform: 'facebook',
          member_count: 3,
          members: [
            { id: 71, target_type: 'profile', profile_id: 2, profile: 'super-1', target_url: '' },
            { id: 72, target_type: 'profile', profile_id: 3, profile: 'super-2', target_url: '' },
            {
              id: 73,
              target_type: 'fanpage',
              profile_id: 2,
              profile: 'super-1',
              target_url: 'https://www.facebook.com/page-a',
            },
          ],
        },
      }));
    }
    if (req.url === '/api/agent/v1/profiles?platform=facebook') {
      return res.end(JSON.stringify({
        success: true,
        data: [
          { id: 2, name: 'super-1', platform: 'facebook' },
          { id: 3, name: 'super-2', platform: 'facebook' },
        ],
      }));
    }
    if (req.url === '/api/agent/v1/publish-batch' && req.method === 'POST') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        receivedBatch = JSON.parse(raw);
        const jobs = receivedBatch.items.map((item, index) => ({
          job_id: `group_job_${index + 1}`,
          batch_id: 'batch_publish_group',
          request_id: item.request_id,
          platform: 'facebook',
          profile_id: item.profile_id,
          profile: item.profile_id === 2 ? 'super-1' : 'super-2',
          post_id: index + 1,
          status: 'queued',
          result: null,
          error: null,
        }));
        res.end(JSON.stringify({
          success: true,
          data: {
            batch_id: 'batch_publish_group',
            platform: 'facebook',
            status: 'queued',
            total: jobs.length,
            success_count: 0,
            error_count: 0,
            pending_count: jobs.length,
            jobs,
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
  const port = server.address().port;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-publish-group-'));
  const keyFile = path.join(tempDir, 'agent-api-key.txt');
  fs.writeFileSync(keyFile, 'b'.repeat(64));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js'),
  ], {
    env: {
      ...process.env,
      SUPER_POST_BASE_URL: `http://127.0.0.1:${port}`,
      SUPER_POST_AGENT_KEY_FILE: keyFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill(); });

  const response = new Promise((resolve, reject) => {
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
        if (message.id === 2) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    });
    child.on('error', reject);
  });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'super_post_publish_group',
      arguments: {
        identifier: 'sales-team-01',
        platform: 'facebook',
        batch_key: 'publish-group-test-01',
        content: 'Một nội dung dùng chung',
        wait_seconds: 0,
      },
    },
  })}\n`);

  const result = await response;
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.total, 3);
  assert.equal(result.result.structuredContent.publish_group.group_key, 'sales-team-01');
  assert.equal(receivedBatch.items.length, 3);
  assert.deepEqual(receivedBatch.items.map(item => item.profile_id), [2, 3, 2]);
  assert.deepEqual(receivedBatch.items.map(item => item.fanpage), ['', '', 'https://www.facebook.com/page-a']);
  assert.ok(receivedBatch.items.every(item => item.content === 'Một nội dung dùng chung'));
  assert.ok(receivedBatch.items.every(item => item.request_id));
});

test('MCP đăng một Chiến dịch qua nhiều nền tảng và gom kết quả từng batch', async t => {
  const received = [];
  const groups = {
    facebook: {
      id: 11, group_key: 'campaign-fb', name: 'Facebook campaign', platform: 'facebook', member_count: 1,
      members: [{ id: 111, target_type: 'profile', profile_id: 2, profile: 'super-1', target_url: '' }],
    },
    tiktok: {
      id: 12, group_key: 'campaign-tt', name: 'TikTok campaign', platform: 'tiktok', member_count: 1,
      members: [{ id: 121, target_type: 'default', profile_id: 2, profile: 'super-1', target_url: '' }],
    },
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({ success: true, data: { service: 'super-post-king-agent-api', version: 1 } }));
    }
    if (req.url === '/api/agent/v1/publish-campaigns/all-channels-01') {
      return res.end(JSON.stringify({
        success: true,
        data: {
          id: 9,
          campaign_key: 'all-channels',
          name: 'Tất cả kênh',
          group_count: 2,
          platforms: ['facebook', 'tiktok'],
          publish_groups: [
            { id: 11, group_key: 'campaign-fb', name: 'Facebook campaign', platform: 'facebook' },
            { id: 12, group_key: 'campaign-tt', name: 'TikTok campaign', platform: 'tiktok' },
          ],
        },
      }));
    }
    if (req.url === '/api/agent/v1/publish-groups/campaign-fb?platform=facebook') {
      return res.end(JSON.stringify({ success: true, data: groups.facebook }));
    }
    if (req.url === '/api/agent/v1/publish-groups/campaign-tt?platform=tiktok') {
      return res.end(JSON.stringify({ success: true, data: groups.tiktok }));
    }
    if (req.url === '/api/agent/v1/profiles?platform=facebook' || req.url === '/api/agent/v1/profiles?platform=tiktok') {
      const platform = req.url.includes('facebook') ? 'facebook' : 'tiktok';
      return res.end(JSON.stringify({ success: true, data: [{ id: 2, name: 'super-1', platform }] }));
    }
    if (req.url === '/api/agent/v1/publish-batch' && req.method === 'POST') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        received.push(body);
        const batchId = `batch_${body.platform}`;
        const jobs = body.items.map((item, index) => ({
          job_id: `${body.platform}_job_${index + 1}`,
          batch_id: batchId,
          request_id: item.request_id,
          platform: body.platform,
          profile_id: item.profile_id,
          profile: 'super-1',
          post_id: index + 1,
          status: 'queued',
          result: null,
          error: null,
        }));
        res.end(JSON.stringify({
          success: true,
          data: {
            batch_id: batchId,
            platform: body.platform,
            status: 'queued',
            total: jobs.length,
            success_count: 0,
            error_count: 0,
            pending_count: jobs.length,
            jobs,
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-campaign-'));
  const keyFile = path.join(tempDir, 'agent-api-key.txt');
  fs.writeFileSync(keyFile, 'c'.repeat(64));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js')], {
    env: {
      ...process.env,
      SUPER_POST_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      SUPER_POST_AGENT_KEY_FILE: keyFile,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (!child.killed) child.kill(); });
  const response = new Promise((resolve, reject) => {
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
        if (message.id === 2) {
          clearTimeout(timer);
          resolve(message);
        }
      }
    });
    child.on('error', reject);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'super_post_publish_campaign',
      arguments: {
        identifier: 'all-channels-01',
        campaign_key: 'campaign-run-test-01',
        content: 'Nội dung chung',
        platform_overrides: { tiktok: { content: 'Nội dung riêng TikTok', product_ids: ['sku-1'] } },
        wait_seconds: 0,
      },
    },
  })}\n`);

  const result = await response;
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.total, 2);
  assert.equal(result.result.structuredContent.groups.length, 2);
  assert.deepEqual(result.result.structuredContent.campaign.platforms, ['facebook', 'tiktok']);
  assert.deepEqual(result.result.structuredContent.groups.map(group => group.batch_id).sort(), [
    'batch_facebook', 'batch_tiktok',
  ]);
  assert.equal(received.length, 2);
  const byPlatform = Object.fromEntries(received.map(body => [body.platform, body]));
  assert.equal(byPlatform.facebook.items[0].content, 'Nội dung chung');
  assert.equal(byPlatform.tiktok.items[0].content, 'Nội dung riêng TikTok');
  assert.deepEqual(byPlatform.tiktok.items[0].product_ids, ['sku-1']);
  assert.equal('concurrency' in byPlatform.facebook, false);
  assert.equal('delay_min' in byPlatform.tiktok, false);
});
