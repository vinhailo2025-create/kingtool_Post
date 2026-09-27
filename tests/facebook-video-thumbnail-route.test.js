const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const puppeteer = require('puppeteer-core');

const config = require('../config');
const FacebookAdapter = require('../src/platforms/facebook.adapter');

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));

async function createComposer(page, actionLabel) {
  await page.setContent(`
    <div role="dialog" aria-label="Tao bai viet" style="width:600px;height:500px">
      <button style="width:120px;height:45px">Chinh sua</button>
      <button id="primary" style="width:500px;height:50px">${actionLabel}</button>
    </div>
  `);
  return page.$('[role="dialog"]');
}

test('Facebook skips thumbnail when video composer already shows Post', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const modal = await createComposer(page, 'Dang');
    const logs = [];
    const automation = new FacebookAdapter._private.FacebookAutomation({
      log: message => logs.push(message),
      videoActionTimeoutMs: 1000,
      sleep: () => Promise.resolve(),
    });
    automation._setVideoThumbnail = async () => {
      assert.fail('thumbnail flow must not run for the direct Post composer');
    };

    const result = await automation._prepareTimelineVideoThumbnail(
      page,
      modal,
      '',
      'missing-thumbnail.jpg'
    );

    assert.equal(result.action, 'post');
    assert.equal(result.applied, false);
    assert.match(logs.join('\n'), /bỏ qua thumbnail/i);
  } finally {
    await browser.close();
  }
});

test('Facebook enters thumbnail flow only when video composer shows Next', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const modal = await createComposer(page, 'Tiep');
    const automation = new FacebookAdapter._private.FacebookAutomation({
      videoActionTimeoutMs: 1000,
      sleep: () => Promise.resolve(),
    });
    let receivedOptions = null;
    automation._setVideoThumbnail = async (_page, _modal, _path, options) => {
      receivedOptions = options;
    };

    const result = await automation._prepareTimelineVideoThumbnail(
      page,
      modal,
      'thumbnail.jpg'
    );

    assert.equal(result.action, 'next');
    assert.equal(result.applied, true);
    assert.equal(receivedOptions.advanceFirst, true);
  } finally {
    await browser.close();
  }
});
