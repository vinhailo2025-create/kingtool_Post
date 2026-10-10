const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function callMcp(child, id, name, args) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('MCP realtime timeout')), 5000);
    const onData = chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.id !== id) continue;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(message.result.structuredContent);
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`);
  });
}

test('MCP exposes wait_job and resumable wait_events without publish calls', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-mcp-realtime-'));
  const keyFile = path.join(tempRoot, 'agent-api-key.txt');
  fs.writeFileSync(keyFile, `${'a'.repeat(64)}\n`);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: {
          service: 'super-post-king-agent-api',
          key_file: keyFile,
          mode: 'desktop',
        },
      }));
    }
    if (req.url.startsWith('/api/agent/v1/jobs/job-1/wait?')) {
      return res.end(JSON.stringify({
        success: true,
        data: { job_id: 'job-1', status: 'success', timed_out: false },
      }));
    }
    if (req.url.startsWith('/api/agent/v1/events/wait?')) {
      return res.end(JSON.stringify({
        success: true,
        data: {
          events: [{ event_id: 42, type: 'job.success', job_id: 'job-1' }],
          count: 1,
          last_event_id: 42,
          timed_out: false,
        },
      }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    SUPER_POST_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    SUPER_POST_AGENT_KEY_FILE: keyFile,
  };
  const child = spawn(process.execPath, ['scripts/super-post-mcp-server.js'], { env });
  t.after(() => child.kill());

  const job = await callMcp(child, 1, 'super_post_wait_job', {
    job_id: 'job-1',
    wait_seconds: 10,
  });
  const events = await callMcp(child, 2, 'super_post_wait_events', {
    after_event_id: 41,
    wait_seconds: 10,
  });

  assert.equal(job.status, 'success');
  assert.equal(events.events[0].event_id, 42);
  assert.ok(requests.some(url => url.includes('/jobs/job-1/wait?wait_seconds=10')));
  assert.ok(requests.some(url => url.includes('/events/wait?after_event_id=41')));
  assert.equal(requests.some(url => url.includes('/publish')), false);
});

test('MCP advertises realtime logging notifications and version 1.9.0', () => {
  const source = fs.readFileSync('scripts/super-post-mcp-server.js', 'utf8');
  assert.match(source, /capabilities: \{ tools: \{\}, logging: \{\} \}/);
  assert.match(source, /version: '1\.9\.0'/);
  assert.equal((source.match(/name: 'super_post_/g) || []).length, 43);
});

test('MCP forwards new durable events as logging notifications after initialize', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-mcp-notify-'));
  const keyFile = path.join(tempRoot, 'agent-api-key.txt');
  fs.writeFileSync(keyFile, `${'b'.repeat(64)}\n`);
  let delivered = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: {
          service: 'super-post-king-agent-api',
          key_file: keyFile,
          mode: 'desktop',
        },
      }));
    }
    if (req.url === '/api/agent/v1/events/status') {
      return res.end(JSON.stringify({
        success: true,
        data: { last_event_id: 10 },
      }));
    }
    if (req.url.startsWith('/api/agent/v1/events/wait?')) {
      const events = delivered ? [] : [{
        event_id: 11,
        type: 'job.running',
        job_id: 'job-notify-1',
        status: 'running',
      }];
      delivered = true;
      return setTimeout(() => res.end(JSON.stringify({
        success: true,
        data: {
          events,
          count: events.length,
          last_event_id: events.length ? 11 : 11,
          timed_out: events.length === 0,
        },
      })), events.length ? 10 : 100);
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, ['scripts/super-post-mcp-server.js'], {
    env: {
      ...process.env,
      SUPER_POST_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      SUPER_POST_AGENT_KEY_FILE: keyFile,
    },
  });
  t.after(() => child.kill());

  const notification = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('MCP notification timeout')), 5000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.method !== 'notifications/message') continue;
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })}\n`);

  const message = await notification;
  assert.equal(message.params.logger, 'super-post-king');
  assert.equal(message.params.data.event_id, 11);
  assert.equal(message.params.data.job_id, 'job-notify-1');
});
