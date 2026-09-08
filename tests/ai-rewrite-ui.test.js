const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const config = require('../config');
const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));

async function waitForServer(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Server UI không khởi động tại ${url}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('Cài đặt AI dùng chung, kiểm tra kết nối và viết lại nhiều hàng từ popup', {
  skip: !chromePath && 'Chrome is not installed',
  timeout: 90000,
}, async () => {
  let generationCount = 0;
  const mockAi = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'router/test-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        generationCount++;
        const payload = JSON.parse(raw);
        const prompt = payload.messages?.[1]?.content || '';
        const suffix = prompt.includes('Gốc A') ? 'A' : 'B';
        res.end(JSON.stringify({
          choices: [{ message: { content: `Nội dung AI ${suffix}` } }],
        }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  });

  const mockPort = await listen(mockAi);
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-ai-ui-'));
  const appPort = 34000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(appPort),
      AUTO_OPEN_BROWSER: '0',
      COVERGEMAUTO_DATA_DIR: dataRoot,
    },
    stdio: 'ignore',
    windowsHide: true,
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
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => typeof Settings !== 'undefined' && typeof DataManager !== 'undefined');

    assert.equal(await page.$$eval('.global-guide-fab', elements => elements.length), 1);
    await page.$eval('.global-guide-fab', element => element.click());
    await page.waitForFunction(() =>
      document.querySelector('.robot-guide-center')?.getAttribute('aria-hidden') === 'false'
    );
    await page.evaluate(() => RobotGuide.close());

    await page.evaluate(() => App.navigateTo('settings'));
    await page.waitForSelector('.settings-accordion');
    assert.equal(
      await page.$$eval('.settings-accordion-trigger', elements =>
        elements.every(element => element.getAttribute('aria-expanded') === 'false')
      ),
      true
    );
    assert.equal(
      await page.$$eval('.settings-accordion-panel', elements =>
        elements.every(element => element.hidden)
      ),
      true
    );
    await page.$eval('#settings-trigger-ai', element => element.click());
    await page.waitForFunction(() =>
      document.querySelector('#settings-trigger-ai')?.getAttribute('aria-expanded') === 'true'
    );
    await page.waitForSelector('.ai-settings-section');
    assert.match(
      await page.$eval('.ai-settings-section', element => element.textContent),
      /Dùng chung mọi nền tảng/
    );
    assert.equal(await page.$$eval('[data-ai-provider]', elements => elements.length), 5);
    await page.$eval('[data-ai-provider="kira"]', element => element.click());
    await page.waitForSelector('#ai-image-model-kira');
    assert.equal(await page.$eval('#ai-model-kira', element => element.value), 'kira-3.5-flash');
    assert.equal(await page.$eval('#ai-image-model-kira', element => element.value), 'kira-3.0-image');
    assert.match(
      await page.$eval('[data-ai-provider="chatgpt"]', element => element.textContent),
      /ChatGPT/
    );
    await page.$eval('[data-ai-provider="chatgpt"]', element => element.click());
    await page.waitForSelector('#ai-codex-path-chatgpt');
    assert.equal(await page.$$eval('.ai-cli-path-row button', elements => elements.length), 2);
    assert.match(await page.$eval('.ai-codex-reference', element => element.textContent), /auth\.json/);

    await page.$eval('[data-ai-provider="9router"]', element => element.click());
    await page.waitForFunction(() =>
      document.querySelector('[data-ai-panel="9router"]')?.classList.contains('active')
    );
    await page.$eval('#ai-api-key-9router', element => {
      element.value = 'router-ui-secret';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.$eval('#ai-model-9router', element => { element.value = 'router/test-model'; });
    await page.$eval('#ai-base-url-9router', (element, value) => { element.value = value; }, `http://127.0.0.1:${mockPort}/v1`);
    await page.$eval('#ai-test-btn-9router', element => element.click());
    await page.waitForFunction(() =>
      ['success', 'error'].some(value =>
        document.querySelector('#ai-test-status-9router')?.classList.contains(value)
      )
    );
    assert.equal(
      await page.$eval('#ai-test-status-9router', element => element.classList.contains('success')),
      true,
      await page.$eval('#ai-test-status-9router', element => element.textContent)
    );
    assert.match(
      await page.$eval('#ai-test-status-9router', element => element.textContent),
      /Kết nối thành công/
    );
    await page.evaluate(() => Settings.saveAiSettings());
    await page.waitForFunction(() =>
      document.querySelector('#ai-api-key-9router')?.placeholder.includes('Đã lưu API key')
    );

    const publicSettings = await page.evaluate(async () => {
      const response = await fetch('/api/ai/settings?platform=tiktok');
      return response.json();
    });
    assert.equal(publicSettings.data.providers['9router'].hasApiKey, true);
    assert.equal(publicSettings.data.providers['9router'].apiKeyHint, 'cret');
    assert.equal(JSON.stringify(publicSettings).includes('router-ui-secret'), false);

    const createdIds = await page.evaluate(async () => {
      const response = await fetch('/api/data?platform=facebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { content: 'Gốc A', status: 'pending' },
          { content: 'Gốc B', status: 'pending' },
        ]),
      });
      const payload = await response.json();
      return payload.data.ids;
    });
    assert.equal(createdIds.length, 2);

    await page.evaluate(() => App.navigateTo('data', 'facebook'));
    await page.waitForFunction(() =>
      document.querySelectorAll('.ag-center-cols-container .ag-row').length === 2
    );
    await page.evaluate(() => DataManager.gridApi.selectAll());
    await page.waitForFunction(() =>
      document.querySelector('#data-selected-count')?.textContent.includes('2')
    );

    assert.equal(await page.$$eval('.content-ai-header-button', elements => elements.length), 2);
    assert.equal(
      await page.$$eval('.content-ai-header-button', elements =>
        elements.some(element => element.textContent.includes('Ảnh AI'))
      ),
      true
    );
    await page.$eval('.content-ai-header-button', element => element.click());
    await page.waitForSelector('#ai-rewrite-prompt');
    assert.equal(await page.$$eval('#modal-body input[type="password"]', elements => elements.length), 0);
    assert.match(
      await page.$eval('#modal-body', element => element.textContent),
      /2\s*hàng đã chọn/
    );
    await page.$eval('#ai-rewrite-prompt', element => {
      element.value = 'Viết hấp dẫn cho {{platform}}: {{content}}';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.$eval('#ai-rewrite-run-btn', element => element.click());
    await page.waitForFunction(() =>
      ['success', 'partial', 'error'].some(value =>
        document.querySelector('#ai-rewrite-status')?.classList.contains(value)
      )
    );
    assert.equal(
      await page.$eval('#ai-rewrite-status', element => element.classList.contains('success')),
      true,
      await page.$eval('#ai-rewrite-status', element => element.textContent)
    );

    const rewritten = await page.evaluate(async () => {
      const response = await fetch('/api/data?platform=facebook');
      const payload = await response.json();
      return payload.data.map(row => ({ id: row.id, content: row.content }));
    });
    assert.equal(generationCount, 2);
    assert.deepEqual(
      rewritten.map(row => row.content).sort(),
      ['Nội dung AI A', 'Nội dung AI B']
    );

    const savedPrompt = await page.evaluate(async () => {
      const response = await fetch('/api/ai/settings?platform=facebook');
      return (await response.json()).data.prompt;
    });
    assert.equal(savedPrompt, 'Viết hấp dẫn cho {{platform}}: {{content}}');

    await page.evaluate(() => {
      closeModal();
      return DataManager.undo();
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    const restored = await page.evaluate(async () => {
      const response = await fetch('/api/data?platform=facebook');
      const payload = await response.json();
      return {
        contents: payload.data.map(row => row.content),
        toasts: [...document.querySelectorAll('.toast')].map(element => element.textContent),
      };
    });
    assert.deepEqual(restored.contents.sort(), ['Gốc A', 'Gốc B'], restored.toasts.join(' | '));

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.content-ai-header-button')]
        .find(element => element.textContent.includes('Ảnh AI'));
      button?.click();
    });
    await page.waitForSelector('#ai-image-prompt');
    assert.match(await page.$eval('#modal-body', element => element.textContent), /ChatGPT/);
    assert.match(await page.$eval('#modal-body', element => element.textContent), /cột Media/);
    assert.equal(await page.$eval('#ai-image-reference', element => element.type), 'checkbox');
    assert.match(
      await page.$eval('#modal-body', element => element.textContent),
      /Dùng Media hiện tại làm ảnh tham chiếu/
    );
    assert.equal(await page.$$eval('[data-ai-image-provider]', elements => elements.length), 2);
    await page.$eval('[data-ai-image-provider="kira"]', element => element.click());
    assert.match(await page.$eval('#modal-body', element => element.textContent), /Base64/);
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise(resolve => mockAi.close(resolve));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
