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

function fixtureHtml({
  restricted = false,
  checkDelay = 0,
  unavailableIds = [],
  missingIds = [],
  splitAddLinkUi = false,
  iconSearchUi = false,
  unsavedPrompt = false,
  unsavedPromptDelay = 0,
  restrictedDetailsModal = false,
  englishContentCheckLite = false,
  pendingCheckPrompt = false,
} = {}) {
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
      <div id="unsaved-prompt" ${unsavedPrompt ? '' : 'hidden'}>
        <span>Video bạn đang chỉnh sửa chưa được lưu. Tiếp tục chỉnh sửa?</span>
        <button id="continue-unsaved" type="button">Tiếp tục</button>
      </div>
      <main id="form" hidden>
        <div id="upload-state">Uploaded (2.64MB)</div>
        <div data-e2e="video-caption">
          <div id="caption" role="textbox" contenteditable="true">mô tả cũ phải bị xóa</div>
        </div>
        <section id="quick-check">
          <strong>${englishContentCheckLite ? 'Content check lite' : 'Kiểm tra nội dung nhanh'}</strong>
          <span id="quick-check-result">${restricted
            ? (englishContentCheckLite ? 'Content may be restricted' : 'Nội dung có thể sẽ bị hạn chế')
            : (checkDelay
              ? (englishContentCheckLite ? 'Checking...' : 'Đang kiểm tra...')
              : (englishContentCheckLite
                ? 'No issues found. However, your video could still be removed later if it violates our Community Guidelines.'
                : 'Không phát hiện vấn đề nào.'))}</span>
        </section>
        ${splitAddLinkUi
          ? '<section data-e2e="anchor_container"><strong>Thêm liên kết</strong><button id="add-link" type="button">Thêm</button></section>'
          : '<button id="add-link" type="button">Thêm liên kết</button>'}
        <button id="product-choice" type="button" hidden>Sản phẩm</button>
        <div id="product-modal" role="dialog" hidden>
          <input id="product-search" placeholder="Tìm kiếm sản phẩm">
          ${iconSearchUi
            ? '<div id="product-search-button" class="product-search-icon" style="width:32px;height:32px">Search</div>'
            : '<button id="product-search-button" type="button" aria-label="Tìm kiếm">Tìm kiếm</button>'}
          <table><tbody id="product-results"></tbody></table>
          <button id="product-next" type="button" hidden>Tiếp</button>
          <button id="product-cancel" type="button">Hủy</button>
        </div>
        <div id="product-confirm-modal" role="dialog" hidden>
          <div id="product-confirm-text"></div>
          <button id="product-final-add" type="button">Thêm</button>
          <button id="product-final-cancel" type="button">Hủy</button>
        </div>
        <div id="linked-product"></div>
        <button id="post" type="button">Đăng</button>
        <div id="pending-check-dialog" role="dialog" hidden>
          <h1>Continue to post?</h1>
          <p>We're still checking your video for potential issues. Do you want to continue posting before the check is complete?</p>
          <button type="button">Cancel</button>
          <button id="post-now" type="button">Post now</button>
        </div>
        <div id="restricted-details" role="dialog" hidden>
          <h1>Nội dung có thể sẽ bị hạn chế</h1>
          <p>Bạn vẫn có thể đăng bài, nhưng nên sửa đổi để tuân thủ.</p>
          <div class="common-modal-close"><span>Đóng</span></div>
          <button type="button">Thay thế video</button>
        </div>
      </main>
      <script>
        ${!restricted && checkDelay ? `setTimeout(() => {
          document.querySelector('#quick-check-result').textContent = ${JSON.stringify(
            englishContentCheckLite
              ? 'No issues found. However, your video could still be removed later if it violates our Community Guidelines.'
              : 'Không phát hiện vấn đề nào.'
          )};
          document.body.dataset.quickCheckReady = 'true';
        }, ${checkDelay});` : "document.body.dataset.quickCheckReady = 'true';"}
        let promptContinued = ${unsavedPrompt || unsavedPromptDelay ? 'false' : 'true'};
        ${unsavedPromptDelay ? `setTimeout(() => {
          document.querySelector('#unsaved-prompt').hidden = false;
        }, ${unsavedPromptDelay});` : ''}
        document.querySelector('#continue-unsaved').addEventListener('click', () => {
          promptContinued = true;
          document.querySelector('#unsaved-prompt').hidden = true;
        });
        document.querySelector('#video').addEventListener('change', () => {
          if (!promptContinued) return;
          document.querySelector('#form').hidden = false;
        });
        document.querySelector('#add-link').addEventListener('click', () => {
          document.querySelector('#product-choice').hidden = false;
        });
        const unavailableIds = new Set(${JSON.stringify(unavailableIds.map(String))});
        const missingIds = new Set(${JSON.stringify(missingIds.map(String))});
        const linkedProductIds = [];
        let pendingProductId = '';
        let productSearches = 0;
        let productCancelled = 0;
        document.querySelector('#product-choice').addEventListener('click', () => {
          document.querySelector('#product-modal').hidden = false;
          document.querySelector('#product-search').value = '';
          document.querySelector('#product-results').innerHTML = '';
          document.querySelector('#product-next').hidden = true;
        });
        document.querySelector('#product-search-button').addEventListener('click', () => {
          const value = document.querySelector('#product-search').value.trim();
          productSearches++;
          document.querySelector('#product-next').hidden = true;
          if (!value || missingIds.has(value)) {
            document.querySelector('#product-results').innerHTML = '';
            return;
          }
          if (unavailableIds.has(value)) {
            document.querySelector('#product-results').innerHTML =
              '<tr data-e2e="product-row"><td>' + value + '</td><td><span style="color:rgb(220, 38, 38)">Không khả dụng</span></td></tr>';
            return;
          }
          document.querySelector('#product-results').innerHTML =
            '<tr data-e2e="product-row"><td>' + value + '</td><td><label><input id="product-checkbox" type="checkbox"> Chọn</label></td></tr>';
          document.querySelector('#product-checkbox').addEventListener('change', event => {
            pendingProductId = event.target.checked ? value : '';
            document.querySelector('#product-next').hidden = !event.target.checked;
          });
        });
        document.querySelector('#product-next').addEventListener('click', () => {
          document.querySelector('#product-modal').hidden = true;
          document.querySelector('#product-confirm-text').textContent = pendingProductId;
          document.querySelector('#product-confirm-modal').hidden = false;
        });
        document.querySelector('#product-final-add').addEventListener('click', () => {
          if (pendingProductId) linkedProductIds.push(pendingProductId);
          document.querySelector('#linked-product').textContent =
            linkedProductIds.length ? 'Đã liên kết ' + linkedProductIds.join(',') : '';
          document.querySelector('#product-confirm-modal').hidden = true;
          pendingProductId = '';
        });
        document.querySelector('#product-cancel').addEventListener('click', () => {
          productCancelled++;
          document.querySelector('#product-modal').hidden = true;
        });
        document.querySelector('#product-final-cancel').addEventListener('click', () => {
          productCancelled++;
          document.querySelector('#product-confirm-modal').hidden = true;
        });
        let restrictionAcknowledged = ${restrictedDetailsModal ? 'false' : 'true'};
        document.querySelector('.common-modal-close').addEventListener('click', () => {
          restrictionAcknowledged = true;
          document.querySelector('#restricted-details').hidden = true;
        });
        document.querySelector('#post').addEventListener('click', () => {
          if (!restrictionAcknowledged) {
            document.querySelector('#restricted-details').hidden = false;
            return;
          }
          if (${pendingCheckPrompt ? 'true' : 'false'} && !document.body.dataset.pendingCheckConfirmed) {
            document.querySelector('#pending-check-dialog').hidden = false;
            return;
          }
          completePost();
        });
        document.querySelector('#post-now').addEventListener('click', () => {
          document.body.dataset.pendingCheckConfirmed = 'true';
          document.querySelector('#pending-check-dialog').hidden = true;
          completePost();
        });
        function completePost() {
          document.body.dataset.postedAfterQuickCheck = document.body.dataset.quickCheckReady || 'false';
          const state = new URLSearchParams({
            caption: document.querySelector('#caption').innerText,
            product: document.querySelector('#linked-product').innerText,
            searches: String(productSearches),
            cancelled: String(productCancelled),
            quick: document.body.dataset.postedAfterQuickCheck,
          });
          fetch('/fixture-state?' + state.toString()).catch(() => {});
          const marker = document.createElement('div');
          marker.dataset.e2e = 'upload-success';
          marker.textContent = 'Video đã được đăng';
          document.body.appendChild(marker);
        }
      </script>
    </body>
  </html>`;
}

async function createFixturePage(browser, options = {}) {
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
        const oldVideo = options.emptyInitialContent
          ? ''
          : '<a href="https://www.tiktok.com/@fixture/video/100">old video</a>';
        const contentShell = options.genericContentUi
          ? '<h1>Creator Center</h1><div>Manage your videos here</div>'
          : '<h1>Video dashboard</h1>';
        request.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><body>${contentShell}${newVideo}${oldVideo}</body></html>`,
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

test('TikTok product IDs stay as strings, split by commas and remove duplicates', () => {
  assert.deepEqual(
    TikTokAdapter._private.parseProductIds(
      '1731727967401379235, 1731727967401379236,1731727967401379235'
    ),
    ['1731727967401379235', '1731727967401379236']
  );
});

test('TikTok adapter uploads video, replaces caption and publishes without a product', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { unsavedPrompt: true });
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

test('TikTok adapter handles an unsaved-editor prompt that appears after file selection', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { unsavedPromptDelay: 250 });
    const result = await TikTokAdapter.publish(page, {
      content: 'Tiếp tục bản nháp rồi tải lại video', image_path: videoPath, product_id: '',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.match(result.postLink, /\/video\/200$/);
  } finally {
    await browser.close();
  }
});

test('TikTok adapter accepts a stable empty Studio list with the new generic UI', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, {
      emptyInitialContent: true,
      genericContentUi: true,
    });
    const result = await TikTokAdapter.publish(page, {
      content: 'First video', image_path: videoPath, product_id: '',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.equal(result.postLink, 'https://www.tiktok.com/@fixture/video/200');
  } finally {
    await browser.close();
  }
});

test('TikTok adapter searches product_id and links the product before publishing', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, {
      splitAddLinkUi: true,
      iconSearchUi: true,
    });
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

test('TikTok adapter splits comma-separated IDs and attaches every available product', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser);
    const result = await TikTokAdapter.publish(page, {
      content: 'Video có nhiều sản phẩm',
      image_path: videoPath,
      product_id: 'SKU-001, 1731727967401379235, SKU-001',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.deepEqual(result.linkedProductIds, ['SKU-001', '1731727967401379235']);
    assert.equal(page.__fixtureState.product, 'Đã liên kết SKU-001,1731727967401379235');
    assert.equal(page.__fixtureState.searches, '2');
  } finally {
    await browser.close();
  }
});

test('TikTok adapter skips a red unavailable product and continues with the next ID', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { unavailableIds: ['RED-001'] });
    const result = await TikTokAdapter.publish(page, {
      content: 'Bỏ sản phẩm đỏ và thêm sản phẩm sau',
      image_path: videoPath,
      product_id: 'RED-001,1731727967401379235',
    }, fastOptions);
    assert.deepEqual(result.linkedProductIds, ['1731727967401379235']);
    assert.equal(result.skippedProductIds[0].id, 'RED-001');
    assert.equal(page.__fixtureState.product, 'Đã liên kết 1731727967401379235');
    assert.equal(page.__fixtureState.searches, '2');
    assert.equal(page.__fixtureState.cancelled, '0');
  } finally {
    await browser.close();
  }
});

test('TikTok adapter cancels product picker when every ID is unavailable and still publishes', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, {
      unavailableIds: ['RED-001', 'RED-002'],
    });
    const result = await TikTokAdapter.publish(page, {
      content: 'Không có sản phẩm khả dụng',
      image_path: videoPath,
      product_id: 'RED-001, RED-002',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.deepEqual(result.linkedProductIds, []);
    assert.deepEqual(result.skippedProductIds.map(item => item.id), ['RED-001', 'RED-002']);
    assert.equal(page.__fixtureState.product, '');
    assert.equal(page.__fixtureState.cancelled, '1');
  } finally {
    await browser.close();
  }
});

test('TikTok adapter warns but still publishes when quick check reports restricted content', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { restricted: true });
    const logs = [];
    const result = await TikTokAdapter.publish(page, {
      content: 'Nội dung bị hạn chế', image_path: videoPath, product_id: '',
    }, {
      ...fastOptions,
      log: (message, type) => logs.push({ message, type }),
    });
    assert.equal(result.success, true);
    assert.match(result.postLink, /\/video\/200$/);
    assert.equal(page.__fixtureState.quick, 'true');
    assert.equal(logs.filter(item => item.type === 'warning').length, 1);
  } finally {
    await browser.close();
  }
});

test('TikTok adapter closes the restriction details dialog and clicks Post again', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, {
      restricted: true,
      restrictedDetailsModal: true,
    });
    const logs = [];
    const result = await TikTokAdapter.publish(page, {
      content: 'Nội dung bị hạn chế', image_path: videoPath, product_id: '',
    }, {
      ...fastOptions,
      log: (message, type) => logs.push({ message, type }),
    });
    assert.equal(result.success, true);
    assert.match(result.postLink, /\/video\/200$/);
    assert.equal(page.__fixtureState.quick, 'true');
    assert.ok(logs.some(item => item.message.includes('bấm Đăng TikTok lần hai')));
  } finally {
    await browser.close();
  }
});

test('TikTok adapter can still stop on a restriction warning when explicitly configured', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { restricted: true });
    await assert.rejects(
      TikTokAdapter.publish(page, {
        content: 'Nội dung bị hạn chế', image_path: videoPath, product_id: '',
      }, { ...fastOptions, continueOnRestricted: false }),
      error => error.code === 'TIKTOK_CONTENT_RESTRICTED'
    );
  } finally {
    await browser.close();
  }
});

test('TikTok adapter posts immediately when Post is enabled without waiting for the green check', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, { checkDelay: 3000 });
    const started = Date.now();
    const result = await TikTokAdapter.publish(page, {
      content: 'Đăng ngay khi nút Post bật', image_path: videoPath, product_id: '',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.ok(Date.now() - started < 3000);
    assert.equal(page.__fixtureState.quick, 'false');
  } finally {
    await browser.close();
  }
});

test('TikTok adapter clicks Post now when the content check is still running', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, {
      englishContentCheckLite: true,
      checkDelay: 3000,
      pendingCheckPrompt: true,
    });
    const logs = [];
    const result = await TikTokAdapter.publish(page, {
      content: 'Bấm Post now', image_path: videoPath, product_id: '',
    }, {
      ...fastOptions,
      log: (message, type) => logs.push({ message, type }),
    });
    assert.equal(result.success, true);
    assert.match(result.postLink, /\/video\/200$/);
    assert.equal(page.__fixtureState.quick, 'false');
    assert.ok(logs.some(item => item.message.includes('Đăng ngay')));
  } finally {
    await browser.close();
  }
});

test('TikTok adapter does not depend on the English Content check lite result', {
  skip: !chromePath && 'Chrome is not installed',
}, async () => {
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await createFixturePage(browser, {
      englishContentCheckLite: true,
      checkDelay: 300,
    });
    const result = await TikTokAdapter.publish(page, {
      content: 'English TikTok Studio', image_path: videoPath, product_id: '',
    }, fastOptions);
    assert.equal(result.success, true);
    assert.match(result.postLink, /\/video\/200$/);
    assert.equal(page.__fixtureState.quick, 'false');
  } finally {
    await browser.close();
  }
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
