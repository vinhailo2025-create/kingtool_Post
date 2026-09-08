const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:3013';
  const executablePath = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find(file => fs.existsSync(file));
  if (!executablePath) throw new Error('Không tìm thấy Chrome để kiểm thử UI');

  console.log('launch');
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    timeout: 15000,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  try {
    console.log('goto');
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#nav-facebook', { timeout: 15000 });
    console.log('navigate');
    await page.click('#nav-browsers');
    await page.waitForSelector('.browser-hero');
    console.log('browser page');
    assert.equal(await page.$$eval('.provider-filter', nodes => nodes.length), 6);
    assert.match(await page.$eval('.browser-hero', node => node.innerText), /Một nơi cho mọi trình duyệt/);
    assert.doesNotMatch(await page.$eval('.browser-hero-actions', node => node.innerText), /Đồng bộ tên/);
    const bulkActions = await page.$eval('.browser-bulk-bar', node => node.innerText);
    assert.match(bulkActions, /Xóa/);
    assert.doesNotMatch(bulkActions, /Tự động hóa|Hẹn giờ|Đồng bộ/);
    await page.screenshot({ path: 'covergemauto-browser-bulk-ui.png', fullPage: true });

    await page.click('button[onclick="BrowserManager.showProviderImportModal()"]');
    await page.waitForSelector('.provider-choice-row');
    console.log('modal');
    assert.equal(await page.$$eval('.provider-choice', nodes => nodes.length), 4);
    await page.click('.provider-choice[onclick*="gpm"]');
    await page.waitForSelector('#provider-api-url');
    assert.equal(await page.$eval('#provider-api-url', input => input.value), 'http://127.0.0.1:9495/api/v1');
    await page.screenshot({ path: 'covergemauto-browser-providers-ui.png', fullPage: true });

    const relevantErrors = errors.filter(message => !/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/i.test(message));
    assert.deepEqual(relevantErrors, []);
    console.log('UI smoke passed: browser hub, provider filters and anti-detect import modal render correctly.');
  } finally {
    console.log('close');
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
