const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const root = path.join(__dirname, '..');
const exePath = path.join(root, 'dist', 'desktop_launcher.dist', 'Super Post - King.exe');
const chromeCandidates = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);
const chromePath = chromeCandidates.find(candidate => fs.existsSync(candidate));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function portIsFree(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

async function expectedDesktopPort() {
  for (const port of [3004, 3000, 3001, 3002, 3003, 3005]) {
    if (await portIsFree(port)) return port;
  }
  throw new Error('No predictable desktop port is available for EXE verification.');
}

async function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Packaged EXE server did not start at ${url}`);
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function stopProcessTree(rootPid) {
  if (process.platform !== 'win32') return;
  const script = [
    `$rootPid = ${Number(rootPid)}`,
    '$all = Get-CimInstance Win32_Process',
    '$targets = New-Object System.Collections.Generic.HashSet[int]',
    '[void]$targets.Add($rootPid)',
    'do {',
    '  $added = $false',
    '  foreach ($p in $all) {',
    '    if ($targets.Contains([int]$p.ParentProcessId) -and -not $targets.Contains([int]$p.ProcessId)) {',
    '      [void]$targets.Add([int]$p.ProcessId)',
    '      $added = $true',
    '    }',
    '  }',
    '} while ($added)',
    '$targets | Sort-Object -Descending | ForEach-Object {',
    '  Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

async function main() {
  assert.ok(fs.existsSync(exePath), `Missing EXE: ${exePath}`);
  assert.ok(chromePath, 'Chrome is required for packaged UI verification.');

  let generationCount = 0;
  const mockAi = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'router/exe-smoke' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        generationCount++;
        const payload = JSON.parse(raw);
        const prompt = payload.messages?.[1]?.content || '';
        const suffix = prompt.includes('EXE source A') ? 'A' : 'B';
        res.end(JSON.stringify({
          choices: [{ message: { content: `EXE AI result ${suffix}` } }],
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });

  const mockPort = await listen(mockAi);
  const desktopPort = await expectedDesktopPort();
  const baseUrl = `http://127.0.0.1:${desktopPort}`;
  const tempLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-exe-ai-'));
  const qaDir = path.join(root, 'dist', 'qa');
  fs.mkdirSync(qaDir, { recursive: true });

  const exe = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    env: { ...process.env, LOCALAPPDATA: tempLocalAppData },
    stdio: 'ignore',
    windowsHide: false,
  });
  let browser;

  try {
    await waitForServer(baseUrl);
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-first-run', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() =>
      typeof Settings !== 'undefined' && typeof DataManager !== 'undefined'
    );

    await page.evaluate(() => App.navigateTo('settings'));
    await page.waitForSelector('.ai-settings-section');
    assert.equal(await page.$$eval('[data-ai-provider]', items => items.length), 5);

    await page.$eval('[data-ai-provider="9router"]', element => element.click());
    await page.waitForFunction(() =>
      document.querySelector('[data-ai-panel="9router"]')?.classList.contains('active')
    );
    await page.$eval('#ai-api-key-9router', element => {
      element.value = 'exe-smoke-secret';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.$eval('#ai-model-9router', element => {
      element.value = 'router/exe-smoke';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.$eval(
      '#ai-base-url-9router',
      (element, value) => {
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      },
      `http://127.0.0.1:${mockPort}/v1`
    );
    await page.$eval('#ai-test-btn-9router', element => element.click());
    await page.waitForFunction(() =>
      ['success', 'error'].some(state =>
        document.querySelector('#ai-test-status-9router')?.classList.contains(state)
      )
    );
    assert.equal(
      await page.$eval('#ai-test-status-9router', element => element.classList.contains('success')),
      true
    );
    await page.evaluate(() => Settings.saveAiSettings());
    await page.waitForFunction(() =>
      document.querySelector('#ai-api-key-9router')?.placeholder.includes('API key')
    );

    const publicSettings = await jsonRequest(`${baseUrl}/api/ai/settings?platform=threads`);
    assert.equal(publicSettings.data.providers['9router'].hasApiKey, true);
    assert.equal(publicSettings.data.providers['9router'].apiKeyHint, 'cret');
    assert.equal(JSON.stringify(publicSettings).includes('exe-smoke-secret'), false);

    const created = await jsonRequest(`${baseUrl}/api/data?platform=threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { content: 'EXE source A', status: 'pending' },
        { content: 'EXE source B', status: 'pending' },
      ]),
    });
    const createdIds = created.data.ids;
    assert.equal(createdIds.length, 2);

    await page.evaluate(() => App.navigateTo('data', 'threads'));
    await page.waitForFunction(ids => {
      let found = 0;
      DataManager.gridApi?.forEachNode(node => {
        if (ids.includes(Number(node.data?.id))) found++;
      });
      return found === ids.length;
    }, {}, createdIds);
    await page.evaluate(ids => {
      DataManager.gridApi.deselectAll();
      DataManager.gridApi.forEachNode(node => {
        if (ids.includes(Number(node.data?.id))) node.setSelected(true);
      });
    }, createdIds);

    assert.equal(await page.$$eval('.content-ai-header-button', items => items.length), 2);
    await page.$$eval('.content-ai-header-button', items => items[0]?.click());
    await page.waitForSelector('#ai-rewrite-prompt');
    assert.equal(await page.$$eval('#modal-body input[type="password"]', items => items.length), 0);
    assert.equal(
      await page.$eval('.ai-rewrite-count', element => Number(element.textContent.trim())),
      2
    );
    await page.$eval('#ai-rewrite-prompt', element => {
      element.value = 'Rewrite {{platform}}: {{content}}';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.$eval('#ai-rewrite-run-btn', element => element.click());
    await page.waitForFunction(() =>
      ['success', 'partial', 'error'].some(state =>
        document.querySelector('#ai-rewrite-status')?.classList.contains(state)
      )
    );
    assert.equal(
      await page.$eval('#ai-rewrite-status', element => element.classList.contains('success')),
      true
    );
    await page.screenshot({
      path: path.join(qaDir, 'ai-exe-success.png'),
      fullPage: false,
    });

    const rewrittenPayload = await jsonRequest(`${baseUrl}/api/data?platform=threads`);
    const rewritten = rewrittenPayload.data
      .filter(row => createdIds.includes(Number(row.id)))
      .map(row => row.content)
      .sort();
    assert.deepEqual(rewritten, ['EXE AI result A', 'EXE AI result B']);
    assert.equal(generationCount, 2);

    const savedPrompt = await jsonRequest(`${baseUrl}/api/ai/settings?platform=threads`);
    assert.equal(savedPrompt.data.prompt, 'Rewrite {{platform}}: {{content}}');

    await page.evaluate(() => {
      closeModal();
      return DataManager.undo();
    });
    await page.waitForFunction(async ids => {
      const response = await fetch('/api/data?platform=threads');
      const payload = await response.json();
      const rows = payload.data.filter(row => ids.includes(Number(row.id)));
      return rows.some(row => row.content === 'EXE source A')
        && rows.some(row => row.content === 'EXE source B');
    }, {}, createdIds);

    const restoredPayload = await jsonRequest(`${baseUrl}/api/data?platform=threads`);
    const restored = restoredPayload.data
      .filter(row => createdIds.includes(Number(row.id)))
      .map(row => row.content)
      .sort();
    assert.deepEqual(restored, ['EXE source A', 'EXE source B']);

    await page.$$eval('.content-ai-header-button', items => items[1]?.click());
    await page.waitForSelector('#ai-image-reference');
    assert.match(
      await page.$eval('#modal-body', element => element.textContent),
      /Dùng Media hiện tại làm ảnh tham chiếu/
    );

    console.log(JSON.stringify({
      exePath,
      desktopPort,
      providerCount: 5,
      selectedRows: 2,
      generationCount,
      rewritten,
      promptPersisted: true,
      batchUndo: true,
      screenshot: path.join(qaDir, 'ai-exe-success.png'),
    }, null, 2));
  } finally {
    if (browser) await browser.close();
    stopProcessTree(exe.pid);
    await new Promise(resolve => mockAi.close(resolve));
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(tempLocalAppData, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 9) {
          console.warn(`Temporary EXE data remains at ${tempLocalAppData}: ${error.message}`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
