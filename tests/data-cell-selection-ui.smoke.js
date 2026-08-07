const assert = require('node:assert/strict');
const fs = require('node:fs');
const puppeteer = require('puppeteer-core');

(async () => {
  const baseUrl = process.env.UI_BASE_URL || 'http://127.0.0.1:3102';
  const executablePath = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find(file => fs.existsSync(file));
  if (!executablePath) throw new Error('Chrome is required for the cell-selection smoke test');

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    timeout: 15000,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 1 });
  await browser.defaultBrowserContext().overridePermissions(baseUrl, [
    'clipboard-read',
    'clipboard-write',
  ]);

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('#nav-facebook', { timeout: 15000 });
    await page.click('#nav-facebook');
    await page.waitForSelector('#data-grid');

    await page.evaluate(async () => {
      await fetch('/api/data?platform=facebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Cell copy source', status: 'pending' }),
      });
      await DataManager.load();
    });

    const cellSelector = '#data-grid .ag-center-cols-container .ag-row[row-index="0"] .ag-cell[col-id="content"]';
    const checkboxSelector = '#data-grid .ag-pinned-left-cols-container .ag-row[row-index="0"] .ag-cell[col-id="checkbox"] .ag-checkbox-input-wrapper';
    await page.waitForSelector(cellSelector, { visible: true });
    await page.click(cellSelector);

    assert.equal(await page.$eval(cellSelector, cell => cell.closest('.ag-row').classList.contains('ag-row-selected')), false);
    assert.equal(await page.$eval('#range-overlay', overlay => getComputedStyle(overlay).display), 'block');
    assert.match(await page.$eval('#data-selected-count', node => node.textContent), /1/);

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Control');
    await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'Cell copy source');

    await page.evaluate(() => navigator.clipboard.writeText('Pasted into one cell'));
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyV');
    await page.keyboard.up('Control');
    await page.waitForFunction(selector => {
      const cell = document.querySelector(selector);
      return cell && cell.textContent.includes('Pasted into one cell');
    }, {}, cellSelector);

    const saved = await page.evaluate(async () => {
      const response = await fetch('/api/data?platform=facebook');
      return response.json();
    });
    assert.equal(saved.data[0].content, 'Pasted into one cell');

    await page.click(checkboxSelector);
    await page.waitForFunction(selector => {
      const checkbox = document.querySelector(selector);
      return checkbox && checkbox.classList.contains('ag-checked');
    }, {}, checkboxSelector);
    assert.equal(await page.$eval(cellSelector, cell => cell.closest('.ag-row').classList.contains('ag-row-selected')), true);

    console.log('UI smoke passed: cells select independently, copy/paste one cell, and checkboxes select rows.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
