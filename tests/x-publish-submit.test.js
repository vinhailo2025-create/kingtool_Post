const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const config = require('../config');
const XAdapter = require('../src/platforms/x.adapter');

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));

async function withPage(run) {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await run(page);
  } finally {
    await browser.close();
  }
}

test('X submit confirmation stops retrying after the CreateTweet request starts', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => withPage(async page => {
  await page.setContent(`
    <div data-testid="tweetTextarea_0" style="width:200px;height:40px"></div>
    <button data-testid="tweetButton" style="width:100px;height:40px">Post</button>
    <script>
      postClicks = 0;
      document.querySelector('button').onclick = () => {
        postClicks++;
        fetch('https://x.com/i/api/graphql/test/CreateTweet').catch(() => {});
      };
    </script>
  `);
  const button = await XAdapter._private.findPostButton(page);
  try {
    const result = await XAdapter._private.clickPostButtonAndConfirm(
      page,
      button,
      { actionTimeout: 500 }
    );
    assert.equal(result.evidence, 'request');
    assert.equal(await page.evaluate(() => postClicks), 1);
  } finally {
    await button.dispose();
  }
}));

test('X submit confirmation continues when the next composer state appears', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => withPage(async page => {
  await page.setContent(`
    <div data-testid="tweetTextarea_0" style="width:200px;height:40px"></div>
    <button data-testid="tweetButton" style="width:100px;height:40px">Post</button>
    <script>
      postClicks = 0;
      document.querySelector('button').onclick = () => {
        postClicks++;
        document.querySelector('[data-testid="tweetTextarea_0"]').remove();
        document.querySelector('button').remove();
      };
    </script>
  `);
  const button = await XAdapter._private.findPostButton(page);
  try {
    const result = await XAdapter._private.clickPostButtonAndConfirm(
      page,
      button,
      { actionTimeout: 500 }
    );
    assert.equal(result.evidence, 'button-replaced');
    assert.equal(await page.evaluate(() => postClicks), 1);
  } finally {
    await button.dispose();
  }
}));

test('X submit confirmation reports an ineffective click at the safety timeout', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => withPage(async page => {
  await page.setContent(`
    <div data-testid="tweetTextarea_0" style="width:200px;height:40px"></div>
    <button data-testid="tweetButton" style="width:100px;height:40px">Post</button>
    <script>
      postClicks = 0;
      document.querySelector('button').onclick = () => postClicks++;
    </script>
  `);
  const button = await XAdapter._private.findPostButton(page);
  try {
    await assert.rejects(
      XAdapter._private.clickPostButtonAndConfirm(page, button, { actionTimeout: 100 }),
      error => error.code === 'X_POST_CLICK_NOT_EFFECTIVE'
    );
    assert.equal(await page.evaluate(() => postClicks), 1);
  } finally {
    await button.dispose();
  }
}));
