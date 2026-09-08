const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Server UI không khởi động tại ${url}`);
}

test('Cấu hình Facebook hiển thị, lưu và nạp lại tùy chọn Thêm nhãn AI', {
  skip: !chromePath && 'Chrome is not installed',
  timeout: 60000,
}, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-ai-config-ui-'));
  const port = 32000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
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
    await page.waitForFunction(() => typeof PostConfig !== 'undefined' && typeof App !== 'undefined');
    await page.evaluate(() => App.navigateTo('postcfg', 'facebook'));

    await page.waitForSelector('#fb-ai-label-enabled');
    assert.match(
      await page.$eval('#page-postcfg', element => element.textContent),
      /Thêm nhãn AI/
    );
    assert.equal(await page.$eval('#fb-ai-label-enabled', element => element.checked), false);

    await page.$eval('#fb-ai-label-enabled', element => element.click());
    await page.evaluate(() => PostConfig.save());
    await page.waitForFunction(async () => {
      const response = await fetch('/api/settings?platform=facebook');
      const payload = await response.json();
      return payload.data?.add_ai_label === '1';
    });

    await page.evaluate(() => PostConfig.load());
    assert.equal(await page.$eval('#fb-ai-label-enabled', element => element.checked), true);

    await page.evaluate(() => App.navigateTo('postcfg', 'tiktok'));
    assert.equal(await page.$('#fb-ai-label-enabled'), null);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
