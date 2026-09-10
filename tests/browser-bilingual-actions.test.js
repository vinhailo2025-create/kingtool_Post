const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const config = require('../config');
const BrowserService = require('../src/services/browser.service');
const FacebookAdapter = require('../src/platforms/facebook.adapter');
const InstagramAdapter = require('../src/platforms/instagram.adapter');
const ThreadsAdapter = require('../src/platforms/threads.adapter');
const TikTokAdapter = require('../src/platforms/tiktok.adapter');
const XAdapter = require('../src/platforms/x.adapter');
const YouTubeAdapter = require('../src/platforms/youtube.adapter');

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));

test('all browser click helpers recognize Vietnamese and English labels', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();

    await page.setContent('<button id="upload" aria-label="Upload videos">Upload videos</button>');
    assert.equal(
      await YouTubeAdapter._private.clickVisibleText(
        page,
        ['Tải video lên', 'Upload videos'],
        { exact: true }
      ),
      true
    );

    await page.setContent(`
      <section data-e2e="anchor_container">
        <strong>Add link</strong>
        <button id="add-link">Add</button>
      </section>
      <script>
        addLinkClicks = 0;
        document.querySelector('#add-link').onclick = () => addLinkClicks++;
      </script>
    `);
    assert.equal(await TikTokAdapter._private.clickAddLinkAction(page), true);
    assert.equal(await page.evaluate(() => addLinkClicks), 1);

    await page.setContent(`
      <div role="dialog" style="width:500px;height:260px">
        <h1>Content may be restricted</h1>
        <p>You can still post this video.</p>
        <button id="post-anyway">Post anyway</button>
      </div>
      <script>confirmed = false; document.querySelector('#post-anyway').onclick = () => confirmed = true;</script>
    `);
    assert.equal(
      await TikTokAdapter._private.confirmRestrictedPublishPrompt(page),
      'confirmed'
    );
    assert.equal(await page.evaluate(() => confirmed), true);

    for (const label of ['Next', 'Tiếp']) {
      await page.setContent(`<div role="dialog"><button id="action">${label}</button></div>`);
      assert.equal(
        await InstagramAdapter._private.clickAction(page, ['Next', 'Tiếp'], 1000),
        true
      );
    }

    await page.setContent(`
      <button id="instagram-new-post" style="width:120px;height:40px">
        <span> </span><svg aria-label="New post"></svg>
      </button>
      <script>
        instagramCreateClicked = false;
        document.querySelector('#instagram-new-post').onclick = () => instagramCreateClicked = true;
      </script>
    `);
    assert.equal(await InstagramAdapter._private.clickCreate(page, 1000), true);
    assert.equal(await page.evaluate(() => instagramCreateClicked), true);

    await page.setContent(`
      <button id="instagram-create" style="width:120px;height:40px">Create</button>
      <div id="instagram-shell"></div>
      <script>
        instagramPostOptionClicked = false;
        document.querySelector('#instagram-create').onclick = () => {
          document.querySelector('#instagram-shell').innerHTML =
            '<div role="menu" style="width:220px;height:120px"><button id="instagram-post-option">Post</button></div>';
          document.querySelector('#instagram-post-option').onclick = () => {
            instagramPostOptionClicked = true;
            document.querySelector('#instagram-shell').innerHTML =
              '<section aria-modal="true" style="width:500px;height:420px"><h1>Create new post</h1><div id="instagram-media-action"></div></section>';
            setTimeout(() => {
              document.querySelector('#instagram-media-action').innerHTML =
                '<button>Select from computer</button>';
            }, 350);
          };
        };
      </script>
    `);
    assert.equal(await InstagramAdapter._private.clickCreate(page, 1000), true);
    assert.equal(await InstagramAdapter._private.waitForCreateSurface(page, 2000), true);
    assert.equal(await page.evaluate(() => instagramPostOptionClicked), true);

    await page.setContent(`
      <main><button id="unrelated-post" style="width:120px;height:40px">Post</button></main>
      <script>
        unrelatedPostClicked = false;
        document.querySelector('#unrelated-post').onclick = () => unrelatedPostClicked = true;
      </script>
    `);
    assert.equal(await InstagramAdapter._private.clickCreationKind(page), false);
    assert.equal(await page.evaluate(() => unrelatedPostClicked), false);

    for (const label of ["What's new", 'Có gì mới']) {
      await page.setContent(`<button id="composer">${label}</button>`);
      assert.equal(await ThreadsAdapter._private.clickComposer(page), true);
    }

    for (const label of ['Post', 'Đăng']) {
      await page.setContent(`<button aria-label="${label}">${label}</button>`);
      const button = await XAdapter._private.findPostButton(page);
      assert.ok(button, `X must find the ${label} button`);
      await button.dispose();
    }

    const automation = new FacebookAdapter._private.FacebookAutomation();
    for (const label of ['Timeline', 'Dòng thời gian']) {
      await page.setContent(
        `<a role="link" aria-label="${label}" href="https://www.facebook.com/profile.php?id=123">Profile</a>`
      );
      assert.match(await automation.getFacebookTimelineHref(page), /facebook\.com\/profile\.php/);
    }
  } finally {
    await browser.close();
  }
});

test('TikTok browser locale override exposes English to future pages', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    assert.equal(await BrowserService._applyPlatformLocale(page, 'tiktok'), true);
    await page.goto('data:text/html,<title>locale</title>', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => navigator.language), 'en-US');
    assert.deepEqual(
      await page.evaluate(() => navigator.languages.slice(0, 2)),
      ['en-US', 'en']
    );
  } finally {
    await browser.close();
  }
});

test('browser adapters keep explicit English aliases for language-sensitive controls', () => {
  const youtube = fs.readFileSync(require.resolve('../src/platforms/youtube.adapter'), 'utf8');
  const facebook = fs.readFileSync(require.resolve('../src/platforms/facebook.adapter'), 'utf8');
  const tiktok = fs.readFileSync(require.resolve('../src/platforms/tiktok.adapter'), 'utf8');
  const threads = fs.readFileSync(require.resolve('../src/platforms/threads.adapter'), 'utf8');

  assert.match(youtube, /Upload videos/);
  assert.match(youtube, /No, it's not made for kids/);
  assert.match(youtube, /Show advanced settings/);
  assert.match(facebook, /share your thoughts/);
  assert.match(facebook, /photo\/video/);
  assert.match(tiktok, /post anyway/i);
  assert.match(tiktok, /add product/i);
  assert.doesNotMatch(threads, /\?hl=vi/);
});
