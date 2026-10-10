// Facebook có thể chỉ tạo anchor sau khi người dùng click Gửi. Tool phải xác
// minh link trong bình luận đã đăng thay vì chặn nút Gửi ở ô soạn thảo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-link-preview-'));
process.env.COVERGEMAUTO_DATA_DIR = tempRoot;

const config = require('../config');
const RunnerService = require('../src/services/runner.service');
const FacebookAutomation = require('../src/platforms/facebook.adapter')._private.FacebookAutomation;
const db = require('../src/database/init');

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));

// Giả lập Facebook: sau khi thấy link trong ô soạn thảo thì 1,2 giây sau mới
// hiện thẻ xem trước, đúng như ngoài thực tế phải chờ máy chủ lấy tiêu đề.
function fixtureUrl(preveiwDelayMs = 1200) {
  const html = `
    <!doctype html>
    <html><body>
      <form id="comment-form">
        <div id="box" role="textbox" contenteditable="true" aria-label="Viết bình luận"></div>
        <div id="preview"></div>
      </form>
      <div id="comments"></div>
      <script>
        let nextId = 1;
        let timer = null;
        const box = document.getElementById('box');
        const preview = document.getElementById('preview');

        box.addEventListener('keydown', event => {
          const text = box.innerText || '';
          const match = text.match(/https?:\\/\\/[^\\s]+$/);
          if (event.key !== ' ' || !match || preview.dataset.ready === '1') return;
          if (timer) return;
          timer = setTimeout(() => {
            preview.innerHTML =
              '<div><span>S.SHOPEE.VN</span>' +
              '<span>KỆ SẮT ĐA NĂNG ĐỂ HÀNG | Shopee Việt Nam</span>' +
              '<div role="button" aria-label="Gỡ bản xem trước">x</div></div>';
            preview.dataset.ready = '1';
          }, ${preveiwDelayMs});
        });

        box.addEventListener('keydown', event => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          const article = document.createElement('div');
          article.setAttribute('role', 'article');
          // Facebook tạo anchor thật sau khi người dùng bấm Gửi.
          article.dataset.hadPreview = preview.dataset.ready === '1' ? '1' : '0';
          const escaped = box.innerText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          const linked = escaped.replace(
            /(https?:\\/\\/[^\\s]+)/g,
            '<a class="posted-url" href="$1">$1</a>'
          ).replace(/\\n/g, '<br>');
          article.innerHTML =
            '<a href="https://www.facebook.com/test?comment_id=' + nextId++ + '">Vừa xong</a>' +
            '<span>' + linked + '</span>' + preview.innerHTML;
          document.getElementById('comments').appendChild(article);
          box.innerHTML = '';
          preview.innerHTML = '';
          delete preview.dataset.ready;
        });
      </script>
    </body></html>
  `;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const NOI_DUNG_CO_LINK = [
  'Anh chị xem giá đặt mua sản phẩm ở đây:',
  'https://s.shopee.vn/7KmUQoM3Hc',
].join('\n');

function stubPersistenceConfirmation() {
  const original = FacebookAutomation.prototype._confirmCommentPersisted;
  FacebookAutomation.prototype._confirmCommentPersisted = async () => true;
  return () => { FacebookAutomation.prototype._confirmCommentPersisted = original; };
}

test('ưu tiên dán link bằng clipboard như thao tác tay trên Facebook', async () => {
  const actions = [];
  const automation = new (require('../src/platforms/facebook.adapter')._private.FacebookAutomation)({
    sleep: async () => {},
  });
  const page = {
    url: () => 'https://www.facebook.com/example/posts/1',
    browserContext: () => ({
      overridePermissions: async (origin, permissions) => actions.push(['permissions', origin, permissions]),
    }),
    evaluate: async (_fn, value) => {
      actions.push(['clipboard', value]);
      return true;
    },
    keyboard: {
      down: async key => actions.push(['down', key]),
      press: async key => actions.push(['press', key]),
      up: async key => actions.push(['up', key]),
    },
  };
  const box = {
    evaluate: async (_fn, value) => {
      actions.push(['verify', value]);
      return true;
    },
  };

  assert.equal(await automation._pasteCommentText(page, box, NOI_DUNG_CO_LINK), true);
  assert.ok(actions.some(action => action[0] === 'permissions'));
  assert.ok(actions.some(action => action[0] === 'clipboard'));
  assert.deepEqual(actions.filter(action => action[0] === 'press').map(action => action[1]), ['V']);
});

test('nhận diện URL màu xanh trong editor là link đã sẵn sàng', {
  skip: !chromePath,
  timeout: 30000,
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="article">
        <div id="box" role="textbox" contenteditable="true">
          <span style="color:rgb(8, 102, 255)">https://s.shopee.vn/7KmUQoM3Hc</span>
        </div>
      </div>
    `);
    const box = await page.$('#box');
    const automation = new (require('../src/platforms/facebook.adapter')._private.FacebookAutomation)({
      sleep: async () => {},
      commentLinkPreviewTimeoutMs: 1000,
    });
    assert.equal(
      await automation._waitCommentLinkReady(page, box, 'https://s.shopee.vn/7KmUQoM3Hc'),
      true
    );
    assert.equal(automation._lastCommentLinkDebug.hasBlueUrlText, true);
  } finally {
    await browser.close();
  }
});

test('click Gửi rồi xác minh Facebook đã chuyển URL thành link thật', {
  skip: !chromePath,
  timeout: 60000,
}, async () => {
  await db.waitReady();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  const originalSleep = RunnerService._sleep;
  const restorePersistence = stubPersistenceConfirmation();
  RunnerService._sleep = async () => new Promise(resolve => setTimeout(resolve, 10));
  RunnerService._commentVerificationTimeoutMs = 5000;
  try {
    const page = await browser.newPage();
    const result = await RunnerService.commentOnPost(page, fixtureUrl(1200), NOI_DUNG_CO_LINK, '');
    assert.equal(result.success, true);

    const noiDung = await page.$eval('#comments [role="article"]', el => el.textContent);
    assert.ok(noiDung.includes('s.shopee.vn/7KmUQoM3Hc'), 'link phải nằm trong bình luận đã đăng');
    assert.equal(
      await page.$eval('#comments a.posted-url', anchor => anchor.href),
      'https://s.shopee.vn/7KmUQoM3Hc'
    );
  } finally {
    RunnerService._sleep = originalSleep;
    restorePersistence();
    delete RunnerService._commentVerificationTimeoutMs;
    await browser.close();
  }
});

test('chốt link đầu tiên bằng dấu cách trước khi xuống dòng', {
  skip: !chromePath,
  timeout: 60000,
}, async () => {
  await db.waitReady();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  const originalSleep = RunnerService._sleep;
  const restorePersistence = stubPersistenceConfirmation();
  RunnerService._sleep = async () => new Promise(resolve => setTimeout(resolve, 10));
  RunnerService._commentVerificationTimeoutMs = 5000;
  try {
    const page = await browser.newPage();
    const repeatedLinks = [
      'https://s.shopee.vn/7KmUQoM3Hc',
      'https://s.shopee.vn/7KmUQoM3Hc',
      'https://s.shopee.vn/7KmUQoM3Hc',
    ].join('\n');
    const result = await RunnerService.commentOnPost(page, fixtureUrl(1200), repeatedLinks, '');
    assert.equal(result.success, true);

    const article = await page.$('#comments [role="article"]');
    assert.ok(article, 'bình luận phải được gửi sau khi link đã sẵn sàng');
    assert.equal(await article.$$eval('a.posted-url', anchors => anchors.length), 3);
  } finally {
    RunnerService._sleep = originalSleep;
    restorePersistence();
    delete RunnerService._commentVerificationTimeoutMs;
    await browser.close();
  }
});

test('bình luận không có link thì gửi ngay, không chờ vô ích', {
  skip: !chromePath,
  timeout: 60000,
}, async () => {
  await db.waitReady();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  const originalSleep = RunnerService._sleep;
  const restorePersistence = stubPersistenceConfirmation();
  RunnerService._sleep = async () => new Promise(resolve => setTimeout(resolve, 10));
  RunnerService._commentVerificationTimeoutMs = 5000;
  const batDau = Date.now();
  try {
    const page = await browser.newPage();
    const result = await RunnerService.commentOnPost(page, fixtureUrl(1200), 'Bình luận không có link', '');
    assert.equal(result.success, true);
    // Không có link thì không được ngồi chờ hết thời gian xem trước
    assert.ok(Date.now() - batDau < 20000, 'không có link thì phải gửi ngay');
  } finally {
    RunnerService._sleep = originalSleep;
    restorePersistence();
    delete RunnerService._commentVerificationTimeoutMs;
    await browser.close();
  }
});

test('không bắt buộc preview xuất hiện trước khi click Gửi', {
  skip: !chromePath,
  timeout: 60000,
}, async () => {
  await db.waitReady();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  const originalSleep = RunnerService._sleep;
  const restorePersistence = stubPersistenceConfirmation();
  RunnerService._sleep = async () => new Promise(resolve => setTimeout(resolve, 10));
  RunnerService._commentVerificationTimeoutMs = 5000;
  RunnerService._commentLinkPreviewTimeoutMs = 2000;
  try {
    const page = await browser.newPage();
    // 999999ms = preview không kịp hiện; Facebook vẫn linkify khi click Gửi.
    const result = await RunnerService.commentOnPost(page, fixtureUrl(999999), NOI_DUNG_CO_LINK, '');
    assert.equal(result.success, true);
    assert.equal(await page.$$eval('#comments a.posted-url', nodes => nodes.length), 1);
  } finally {
    RunnerService._sleep = originalSleep;
    restorePersistence();
    delete RunnerService._commentVerificationTimeoutMs;
    delete RunnerService._commentLinkPreviewTimeoutMs;
    await browser.close();
  }
});

test.after(async () => {
  try { await db.waitReady(); db.close(); } catch (_) { /* bỏ qua */ }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
