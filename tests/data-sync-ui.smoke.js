const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:3100';
  const executablePath = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find(file => fs.existsSync(file));
  if (!executablePath) throw new Error('Không tìm thấy Chrome để kiểm thử UI');

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    timeout: 15000,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#nav-facebook', { timeout: 15000 });
    await page.click('#nav-facebook');
    await page.waitForSelector('#data-grid .ag-header-cell[col-id="content"] .column-sync-button', { timeout: 15000 });

    assert.ok(await page.$$eval('#data-grid .column-sync-button', nodes => nodes.length) >= 2);
    await page.click('#data-grid .ag-header-cell[col-id="content"] .column-sync-button');
    await page.waitForSelector('.sync-platform-grid .sync-platform-card', { timeout: 10000 });

    assert.equal(await page.$$eval('.sync-tabs .sync-tab', nodes => nodes.length), 2);
    assert.equal(await page.$$eval('.sync-platform-card', nodes => nodes.length), 5);
    assert.match(await page.$eval('.sync-direction-card', node => node.innerText), /Nội dung/);
    assert.match(await page.$eval('.sync-section-title', node => node.innerText), /var_key/);

    await page.click('.sync-platform-card:not(.is-disabled) .sync-target-check');
    await page.click('button[onclick="DataManager._previewColumnSync()"]');
    await page.waitForSelector('.sync-preview-result', { timeout: 10000 });
    assert.match(await page.$eval('.sync-preview-summary', node => node.innerText), /ô/);
    await page.click('button[onclick="DataManager._switchSyncTab(\'manual\')"]');

    await page.click('.sync-tab:nth-child(2)');
    await page.waitForSelector('#sync-auto-enabled');
    assert.match(await page.$eval('.sync-auto-banner', node => node.innerText), /Đồng bộ sau khi lưu ô/);

    await page.screenshot({ path: 'data-column-sync-ui.png', fullPage: true });
    const relevantErrors = errors.filter(message => !/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/i.test(message));
    assert.deepEqual(relevantErrors, []);
    console.log('UI smoke passed: column sync header, manual/automatic tabs and platform mapping render correctly.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
