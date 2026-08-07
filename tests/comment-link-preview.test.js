// Bình luận có link phải chờ Facebook tạo xong thẻ xem trước rồi mới gửi.
// Gửi sớm thì link đăng lên chỉ là chữ thường, không bấm được và mất thẻ xem trước.
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

        box.addEventListener('input', () => {
          const text = box.innerText || '';
          const match = text.match(/https?:\\/\\/[^\\s]+/);
          if (!match || preview.dataset.ready === '1') return;
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
          // Ghi lại lúc gửi đã có thẻ xem trước hay chưa
          article.dataset.hadPreview = preview.dataset.ready === '1' ? '1' : '0';
          article.innerHTML =
            '<a href="https://www.facebook.com/test?comment_id=' + nextId++ + '">Vừa xong</a>' +
            '<span>' + box.innerText + '</span>' + preview.innerHTML;
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

test('chờ thẻ xem trước xuất hiện rồi mới gửi bình luận có link', {
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
  RunnerService._sleep = async () => new Promise(resolve => setTimeout(resolve, 10));
  RunnerService._commentVerificationTimeoutMs = 5000;
  try {
    const page = await browser.newPage();
    const result = await RunnerService.commentOnPost(page, fixtureUrl(1200), NOI_DUNG_CO_LINK, '');
    assert.equal(result.success, true);

    const hadPreview = await page.$eval('#comments [role="article"]', el => el.dataset.hadPreview);
    assert.equal(hadPreview, '1', 'phải chờ thẻ xem trước hiện xong mới được gửi');

    const noiDung = await page.$eval('#comments [role="article"]', el => el.textContent);
    assert.ok(noiDung.includes('s.shopee.vn/7KmUQoM3Hc'), 'link phải nằm trong bình luận đã đăng');
    assert.ok(noiDung.includes('S.SHOPEE.VN'), 'thẻ xem trước phải đi kèm bình luận');
  } finally {
    RunnerService._sleep = originalSleep;
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
    delete RunnerService._commentVerificationTimeoutMs;
    await browser.close();
  }
});

test('thẻ xem trước không bao giờ hiện thì vẫn gửi, không treo mãi', {
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
  RunnerService._sleep = async () => new Promise(resolve => setTimeout(resolve, 10));
  RunnerService._commentVerificationTimeoutMs = 5000;
  RunnerService._commentLinkPreviewTimeoutMs = 2000;
  try {
    const page = await browser.newPage();
    // 999999ms = thẻ xem trước không bao giờ kịp hiện
    const result = await RunnerService.commentOnPost(page, fixtureUrl(999999), NOI_DUNG_CO_LINK, '');
    assert.equal(result.success, true, 'hết thời gian chờ thì vẫn phải gửi bình luận');
  } finally {
    RunnerService._sleep = originalSleep;
    delete RunnerService._commentVerificationTimeoutMs;
    delete RunnerService._commentLinkPreviewTimeoutMs;
    await browser.close();
  }
});

test.after(async () => {
  try { await db.waitReady(); db.close(); } catch (_) { /* bỏ qua */ }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
