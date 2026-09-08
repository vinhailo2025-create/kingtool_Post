const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

function callMcp(child, id, name, args = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 5000);
    const onStderr = chunk => { stderr += chunk; };
    const onStdout = chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== id) continue;
        clearTimeout(timer);
        child.stderr.off('data', onStderr);
        child.stdout.off('data', onStdout);
        resolve(message);
      }
    };
    child.stderr.on('data', onStderr);
    child.stdout.on('data', onStdout);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`);
  });
}

function writeEndpoint(endpointFile, baseUrl) {
  fs.writeFileSync(endpointFile, JSON.stringify({
    service: 'super-post-king-agent-api',
    base_url: baseUrl,
    mode: 'desktop',
  }));
}

function mcpEnvironment(tempRoot, endpointFile) {
  const env = { ...process.env };
  delete env.SUPER_POST_AGENT_API_KEY;
  delete env.SUPER_POST_AGENT_KEY_FILE;
  delete env.COVERGEMAUTO_DATA_DIR;
  delete env.SUPER_POST_BASE_URL;
  env.LOCALAPPDATA = path.join(tempRoot, 'local-app-data');
  env.SUPER_POST_ENDPOINT_FILE = endpointFile;
  return env;
}

function spawnMcp(env) {
  return spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js'),
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
}

test('MCP dùng key_file của đúng Agent API thay vì key LocalAppData của instance khác', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-auth-'));
  const liveKeyFile = path.join(tempRoot, 'live', 'agent-api-key.txt');
  const staleKeyFile = path.join(
    tempRoot,
    'local-app-data',
    'King Automation AI',
    'Super Post King',
    'src',
    'database',
    'agent-api-key.txt'
  );
  fs.mkdirSync(path.dirname(liveKeyFile), { recursive: true });
  fs.mkdirSync(path.dirname(staleKeyFile), { recursive: true });
  fs.writeFileSync(liveKeyFile, `${'a'.repeat(64)}\n`);
  fs.writeFileSync(staleKeyFile, `${'b'.repeat(64)}\n`);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  let expectedKey = 'a'.repeat(64);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: {
          service: 'super-post-king-agent-api',
          version: 1,
          key_file: liveKeyFile,
          mode: 'desktop',
        },
      }));
    }
    if (req.url === '/api/agent/v1/capabilities') {
      if (req.headers.authorization !== `Bearer ${expectedKey}`) {
        res.statusCode = 401;
        return res.end(JSON.stringify({
          success: false,
          code: 'AGENT_API_UNAUTHORIZED',
          error: 'Agent API key không hợp lệ.',
        }));
      }
      return res.end(JSON.stringify({ success: true, data: { platforms: ['facebook'] } }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const env = { ...process.env };
  delete env.SUPER_POST_AGENT_API_KEY;
  delete env.SUPER_POST_AGENT_KEY_FILE;
  delete env.COVERGEMAUTO_DATA_DIR;
  env.LOCALAPPDATA = path.join(tempRoot, 'local-app-data');
  env.SUPER_POST_BASE_URL = `http://127.0.0.1:${server.address().port}`;

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js'),
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (!child.killed) child.kill(); });

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  })}\n`);

  const first = await callMcp(child, 2, 'super_post_get_capabilities');
  assert.equal(first.result.isError, false);
  assert.deepEqual(first.result.structuredContent.platforms, ['facebook']);

  expectedKey = 'c'.repeat(64);
  fs.writeFileSync(liveKeyFile, `${expectedKey}\n`);
  const second = await callMcp(child, 3, 'super_post_get_capabilities');
  assert.equal(second.result.isError, false);
});

test('MCP tự chuyển sang port mới khi desktop app khởi động lại trong cùng phiên agent', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-port-switch-'));
  const keyFile = path.join(tempRoot, 'agent-api-key.txt');
  const endpointFile = path.join(tempRoot, 'agent-api-endpoint.json');
  const key = 'd'.repeat(64);
  fs.writeFileSync(keyFile, `${key}\n`);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  async function startServer(marker) {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/agent/v1/health') {
        return res.end(JSON.stringify({
          success: true,
          data: {
            service: 'super-post-king-agent-api',
            version: 1,
            key_file: keyFile,
            mode: 'desktop',
          },
        }));
      }
      if (req.url === '/api/agent/v1/capabilities') {
        if (req.headers.authorization !== `Bearer ${key}`) {
          res.statusCode = 401;
          return res.end(JSON.stringify({
            success: false,
            code: 'AGENT_API_UNAUTHORIZED',
            error: 'Agent API key không hợp lệ.',
          }));
        }
        return res.end(JSON.stringify({ success: true, data: { marker } }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ success: false, error: 'not found' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  }

  const firstServer = await startServer('first');
  t.after(() => { if (firstServer.listening) firstServer.close(); });
  fs.writeFileSync(endpointFile, JSON.stringify({
    service: 'super-post-king-agent-api',
    base_url: `http://127.0.0.1:${firstServer.address().port}`,
    mode: 'desktop',
  }));

  const env = { ...process.env };
  delete env.SUPER_POST_AGENT_API_KEY;
  delete env.SUPER_POST_AGENT_KEY_FILE;
  delete env.COVERGEMAUTO_DATA_DIR;
  delete env.SUPER_POST_BASE_URL;
  env.SUPER_POST_ENDPOINT_FILE = endpointFile;

  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js'),
  ], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (!child.killed) child.kill(); });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  })}\n`);

  const first = await callMcp(child, 2, 'super_post_get_capabilities');
  assert.equal(first.result.isError, false);
  assert.equal(first.result.structuredContent.marker, 'first');

  const secondServer = await startServer('second');
  t.after(() => { if (secondServer.listening) secondServer.close(); });
  fs.writeFileSync(endpointFile, JSON.stringify({
    service: 'super-post-king-agent-api',
    base_url: `http://127.0.0.1:${secondServer.address().port}`,
    mode: 'desktop',
  }));
  await new Promise(resolve => firstServer.close(resolve));

  const second = await callMcp(child, 3, 'super_post_get_capabilities');
  assert.equal(second.result.isError, false);
  assert.equal(second.result.structuredContent.marker, 'second');
});

test('MCP giữ instance đang khỏe dù endpoint registry bị tiến trình khác ghi đè', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-sticky-port-'));
  const keyFile = path.join(tempRoot, 'agent-api-key.txt');
  const endpointFile = path.join(tempRoot, 'agent-api-endpoint.json');
  const key = 'e'.repeat(64);
  fs.writeFileSync(keyFile, `${key}\n`);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  async function startServer(marker) {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/agent/v1/health') {
        return res.end(JSON.stringify({
          success: true,
          data: { service: 'super-post-king-agent-api', key_file: keyFile, mode: 'desktop' },
        }));
      }
      if (req.url === '/api/agent/v1/capabilities') {
        return res.end(JSON.stringify({ success: true, data: { marker } }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ success: false, error: 'not found' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  }

  const firstServer = await startServer('first');
  const secondServer = await startServer('second');
  t.after(() => {
    if (firstServer.listening) firstServer.close();
    if (secondServer.listening) secondServer.close();
  });
  writeEndpoint(endpointFile, `http://127.0.0.1:${firstServer.address().port}`);

  const child = spawnMcp(mcpEnvironment(tempRoot, endpointFile));
  t.after(() => { if (!child.killed) child.kill(); });

  const first = await callMcp(child, 1, 'super_post_get_capabilities');
  assert.equal(first.result.structuredContent.marker, 'first');

  writeEndpoint(endpointFile, `http://127.0.0.1:${secondServer.address().port}`);
  const stillFirst = await callMcp(child, 2, 'super_post_get_capabilities');
  assert.equal(stillFirst.result.structuredContent.marker, 'first');

  await new Promise(resolve => firstServer.close(resolve));
  const switched = await callMcp(child, 3, 'super_post_get_capabilities');
  assert.equal(switched.result.structuredContent.marker, 'second');
});

test('MCP bọc mọi kết quả list trong structuredContent object hợp chuẩn', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-list-schema-'));
  const keyFile = path.join(tempRoot, 'agent-api-key.txt');
  const key = 'f'.repeat(64);
  fs.writeFileSync(keyFile, `${key}\n`);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/health') {
      return res.end(JSON.stringify({
        success: true,
        data: { service: 'super-post-king-agent-api', key_file: keyFile, mode: 'desktop' },
      }));
    }
    if (req.url === '/api/agent/v1/profiles?platform=facebook') {
      return res.end(JSON.stringify({
        success: true,
        data: [{ id: 7, name: 'Profile 7' }],
      }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const env = mcpEnvironment(tempRoot, path.join(tempRoot, 'unused-endpoint.json'));
  env.SUPER_POST_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const child = spawnMcp(env);
  t.after(() => { if (!child.killed) child.kill(); });

  const response = await callMcp(child, 1, 'super_post_list_profiles', { platform: 'facebook' });
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.structuredContent, {
    items: [{ id: 7, name: 'Profile 7' }],
    count: 1,
  });
  assert.deepEqual(JSON.parse(response.result.content[0].text), [{ id: 7, name: 'Profile 7' }]);
});

test('MCP retry POST publish an toàn bằng request_id khi app đổi cổng giữa lệnh', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-mcp-post-switch-'));
  const keyFile = path.join(tempRoot, 'agent-api-key.txt');
  const endpointFile = path.join(tempRoot, 'agent-api-endpoint.json');
  const key = '1'.repeat(64);
  const seenRequestIds = new Set();
  let createdJobs = 0;
  let secondPublishCalls = 0;
  fs.writeFileSync(keyFile, `${key}\n`);
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  function health(req, res) {
    if (req.url !== '/api/agent/v1/health') return false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: true,
      data: { service: 'super-post-king-agent-api', key_file: keyFile, mode: 'desktop' },
    }));
    return true;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  const secondServer = http.createServer(async (req, res) => {
    if (health(req, res)) return;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/publish' && req.method === 'POST') {
      secondPublishCalls += 1;
      const body = await readBody(req);
      if (!seenRequestIds.has(body.request_id)) {
        seenRequestIds.add(body.request_id);
        createdJobs += 1;
      }
      return res.end(JSON.stringify({
        success: true,
        data: { job_id: 'job-stable', request_id: body.request_id, status: 'queued' },
      }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => secondServer.listen(0, '127.0.0.1', resolve));

  const firstServer = http.createServer(async (req, res) => {
    if (health(req, res)) return;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agent/v1/capabilities') {
      return res.end(JSON.stringify({ success: true, data: { marker: 'first' } }));
    }
    if (req.url === '/api/agent/v1/publish' && req.method === 'POST') {
      const body = await readBody(req);
      if (!seenRequestIds.has(body.request_id)) {
        seenRequestIds.add(body.request_id);
        createdJobs += 1;
      }
      writeEndpoint(endpointFile, `http://127.0.0.1:${secondServer.address().port}`);
      req.socket.destroy();
      return;
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise(resolve => firstServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    if (firstServer.listening) firstServer.close();
    if (secondServer.listening) secondServer.close();
  });
  writeEndpoint(endpointFile, `http://127.0.0.1:${firstServer.address().port}`);

  const child = spawnMcp(mcpEnvironment(tempRoot, endpointFile));
  t.after(() => { if (!child.killed) child.kill(); });

  const warmup = await callMcp(child, 1, 'super_post_get_capabilities');
  assert.equal(warmup.result.isError, false);
  const published = await callMcp(child, 2, 'super_post_publish', {
    platform: 'facebook',
    profile_id: 1,
    content: 'Một bài duy nhất',
  });

  assert.equal(published.result.isError, false);
  assert.equal(published.result.structuredContent.job_id, 'job-stable');
  assert.match(published.result.structuredContent.request_id, /^spk:mcp:/);
  assert.equal(secondPublishCalls, 1);
  assert.equal(createdJobs, 1);
});
