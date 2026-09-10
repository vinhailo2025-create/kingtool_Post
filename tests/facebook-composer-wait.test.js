const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const puppeteer = require('puppeteer-core');

const config = require('../config');
const FacebookAdapter = require('../src/platforms/facebook.adapter');

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));

test('Facebook waits for a delayed composer button and delayed dialog', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main id="timeline"></main>
      <script>
        window.composerClicks = 0;
        setTimeout(() => {
          const button = document.createElement('button');
          button.textContent = 'Bạn viết gì đi...';
          button.style.cssText = 'width:320px;height:50px';
          button.onclick = () => {
            window.composerClicks += 1;
            setTimeout(() => {
              const dialog = document.createElement('div');
              dialog.setAttribute('role', 'dialog');
              dialog.setAttribute('aria-label', 'Tạo bài viết');
              dialog.style.cssText = 'width:500px;height:300px';
              document.body.appendChild(dialog);
              setTimeout(() => {
                dialog.innerHTML =
                  '<div role="textbox" contenteditable="true" style="width:420px;height:100px"></div>';
              }, 150);
            }, 150);
          };
          document.querySelector('#timeline').appendChild(button);
        }, 120);
      </script>
    `);

    const automation = new FacebookAdapter._private.FacebookAutomation({
      profileComposerTimeoutMs: 3000,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 25))),
    });
    const modal = await automation._openTimelineComposer(page);
    const result = await automation._waitForTimelineEditor(page, modal);

    assert.ok(result.modal);
    assert.ok(result.editable);
    assert.equal(await page.evaluate(() => window.composerClicks), 1);
    await result.editable.dispose();
    await result.modal.dispose();
  } finally {
    await browser.close();
  }
});
