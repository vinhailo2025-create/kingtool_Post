const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const config = require('../config');
const TikTokAdapter = require('../src/platforms/tiktok.adapter');

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-tiktok-adapter-'));
const videoPath = path.join(tempRoot, 'fixture.mp4');
fs.writeFileSync(videoPath, Buffer.from('fake video payload'));

function fixtureHtml({ restricted = false, checkDelay = 0 } = {}) {
  return `<!doctype html>
  <html lang="vi">
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: sans-serif; padding: 20px; }
        button, input, [contenteditable] { display: block; margin: 8px; min-width: 120px; min-height: 28px; }
        [hidden] { display: none !important; }
        [role="dialog"] { border: 1px solid #333; padding: 10px; }
      </style>
    </head>
    <body>
      <label>Chọn video<input id="video" type="file" accept="video/*"></label>
      <main id="form" hidden>
        <div data-e2e="video-caption">
          <div id="caption" role="textbox" contenteditable="true">mô tả cũ phải bị xóa</div>
        </div>
        <section id="quick-check">
          <strong>Kiểm tra nội dung nhanh</strong>
          <span id="quick-check-result">${restricted ? 'Nội dung có thể sẽ bị hạn chế' : (checkDelay ? 'Đang kiểm tra...' : 'Không phát hiện vấn đề nào.')}</span>
        </section>
        <button id="add-link" type="button">Thêm liên kết</button>
        <button id="product-choice" type="button" hidden>Sản phẩm</button>
        <div id="product-modal" role="dialog" hidden>
          <input id="product-search" placeholder="Tìm kiếm sản phẩm">
          <div id="product-results"></div>
        </div>
        <div id="linked-product"></div>
        <button id="post" type="button">Đăng</button>
      </main>
      <script>
        ${!restricted && checkDelay ? `setTimeout(() => {
          document.querySelector('#quick-check-result').textContent = 'Không phát hiện vấn đề nào.';
          document.body.dataset.quickCheckReady = 'true';
        }, ${checkDelay});` : "document.body.dataset.quickCheckReady = 'true';"}
        document.querySelector('#video').addEventListener('change', () => {
          document.querySelector('#form').hidden = false;
        });
        document.querySelector('#add-link').addEventListener('click', () => {
          document.querySelector('#product-choice').hidden = false;
        });
        document.querySelector('#product-choice').addEventListener('click', () => {
          document.querySelector('#product-modal').hidden = false;
        });
        document.querySelector('#product-search').addEventListener('input', event => {
          const value = event.target.value;
          document.querySelector('#product-results').innerHTML = value
            ? '<div data-e2e="product-row"><span>' + value + '</span><button id="select-product" type="button">Thêm</button></div>'
            : '';
          const button = document.querySelector('#select-product');
          if (button) button.addEventListener('click', () => {
            document.querySelector('#linked-product').textContent = 'Đã liên kết ' + value;
            document.querySelector('#product-modal').hidden = true;
          });
        });
        document.querySelector('#post').addEventListener('click', () => {
          document.body.dataset.postedAfterQuickCheck = document.body.dataset.quickCheckReady || 'false';
          const state = new URLSearchParams({
            caption: document.querySelector('#caption').innerText,
            product: document.querySelector('#linked-product').innerText,
            quick: document.body.dataset.postedAfterQuickCheck,
          });
          fetch('/fixture-state?' + state.toString()).catch(() => {});
          const marker = document.createElement('div');
          marker.dataset.e2e = 'upload-success';
          marker.textContent = 'Video đã được đăng';
          document.body.appendChild(marker);
        });
      </script>
    </body>
  </html>`;
}

async function createFixturePage(browser, options) {
  const page = await browser.newPage();
  let contentLoads = 0;
  page.__fixtureState = {};
  await page.setCookie({
    name: 'sessionid', value: 'test-session', domain: '.tiktok.com', path: '/', secure: true,
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (/\/fixture-state\?/.test(request.url())) {
      const url = new URL(request.url());
      page.__fixtureState = Object.fromEntries(url.searchParams);
      request.respond({ status: 204 });
    } else if (request.isNavigationRequest()) {
      if (/\/tiktokstudio\/content/i.test(request.url())) {
        contentLoads++;
        const newVideo = contentLoads > 1
          ? '<a href="https://www.tiktok.com/@fixture/video/200">new video</a>'
          : '';
        request.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><body><h1>Nội dung</h1><div>Bài đăng</div>
            ${newVideo}<a href="https://www.tiktok.com/@fixture/video/100">old video</a></body></html>`,
        });
      } else {
        request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixtureHtml(options) });
      }
    } else {
      request.abort();
    }
  });
  return page;
}

const fastOptions = {
  navigationTimeout: 5000,
  editorTimeout: 5000,
  uploadTimeout: 5000,
  productTimeout: 5000,
  publishTimeout: 5000,
  linkTimeout: 5000,
  settleMs: 0,
};

test('TikTok adapter uploads video, replaces caption and publishes without a product', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser);
    const result = await TikTokAdapter.publish(page, {
      content: 'Mô tả mới tiếng Việt', image_path: videoPath, product_id: '',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.equal(result.postLink, 'https://www.tiktok.com/@fixture/video/200');
    assert.equal(page.__fixtureState.caption, 'Mô tả mới tiếng Việt');
    assert.equal(page.__fixtureState.product, '');
  } finally {
    await browser.close();
  }
});

test('TikTok adapter searches product_id and links the product before publishing', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser);
    const result = await TikTokAdapter.publish(page, {
      content: 'Video có sản phẩm', image_path: videoPath, product_id: 'SKU-001',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.equal(result.postLink, 'https://www.tiktok.com/@fixture/video/200');
    assert.equal(page.__fixtureState.product, 'Đã liên kết SKU-001');
  } finally {
    await browser.close();
  }
});

test('TikTok adapter fails and does not publish when quick check reports restricted content', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { restricted: true });
    await assert.rejects(
      TikTokAdapter.publish(page, {
        content: 'Nội dung bị hạn chế', image_path: videoPath, product_id: '',
      }, fastOptions),
      error => error.code === 'TIKTOK_CONTENT_RESTRICTED'
    );
    assert.equal(await page.$('[data-e2e="upload-success"]'), null);
  } finally {
    await browser.close();
  }
});

test('TikTok adapter does not click Post until the green quick-check result appears', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { checkDelay: 900 });
    const started = Date.now();
    const result = await TikTokAdapter.publish(page, {
      content: 'Chờ kiểm tra nhanh', image_path: videoPath, product_id: '',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.ok(Date.now() - started >= 800);
    assert.equal(page.__fixtureState.quick, 'true');
  } finally {
    await browser.close();
  }
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
