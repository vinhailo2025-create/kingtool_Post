const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-comment-dom-'));
process.env.COVERGEMAUTO_DATA_DIR = tempRoot;

const config = require('../config');
const RunnerService = require('../src/services/runner.service');
const db = require('../src/database/init');

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));
const pngPath = path.join(tempRoot, 'comment-test.png');
const videoPath = path.join(tempRoot, 'comment-test.mp4');
fs.writeFileSync(
  pngPath,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
);
fs.writeFileSync(videoPath, Buffer.from('video-fixture'));

function fixtureUrl() {
  const html = `
    <!doctype html>
    <html><body>
      <form id="comment-form">
        <div id="box" role="textbox" contenteditable="true" aria-label="Viết bình luận"></div>
        <input id="file" type="file" accept="image/*,video/*">
        <div id="preview"></div>
      </form>
      <div id="comments"></div>
      <script>
        let nextId = 1;
        const box = document.getElementById('box');
        const file = document.getElementById('file');
        const preview = document.getElementById('preview');
        file.addEventListener('change', () => {
          preview.innerHTML = '<img alt="preview" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=" style="width:120px;height:80px">';
        });
        box.addEventListener('keydown', event => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          const article = document.createElement('div');
          article.setAttribute('role', 'article');
          article.innerHTML = '<a href="https://www.facebook.com/test?comment_id=' + nextId++ + '">Vừa xong</a>'
            + '<span>' + box.innerText + '</span>' + preview.innerHTML;
          document.getElementById('comments').appendChild(article);
          box.innerHTML = '';
          preview.innerHTML = '';
        });
      </script>
    </body></html>
  `;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

test('comment composer sends and verifies text with image plus media-only', {
  skip: !chromePath,
  // Windows can occasionally spend >20s starting a fresh headless Chrome
  // while anti-detect profiles are also active. The assertions themselves
  // still use 3s upload/verification bounds below.
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
  RunnerService._commentVerificationTimeoutMs = 3000;
  RunnerService._commentUploadTimeoutMs = 3000;
  try {
    const page = await browser.newPage();
    const textResult = await RunnerService.commentOnPost(
      page,
      fixtureUrl(),
      'Bình luận kiểm thử duy nhất',
      pngPath
    );
    assert.equal(textResult.success, true);

    const mediaOnlyResult = await RunnerService.commentOnPost(
      page,
      fixtureUrl(),
      '',
      pngPath
    );
    assert.equal(mediaOnlyResult.success, true);
  } finally {
    RunnerService._sleep = originalSleep;
    delete RunnerService._commentVerificationTimeoutMs;
    delete RunnerService._commentUploadTimeoutMs;
    await browser.close();
  }
});

test('reel comment action opens the hidden composer', {
  skip: !chromePath,
  timeout: 30000,
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  const automation = new (require('../src/platforms/facebook.adapter')._private.FacebookAutomation)({
    sleep: async () => {},
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="open-comments" role="button" aria-label="Bình luận">Bình luận</button>
      <div id="panel"></div>
      <script>
        document.getElementById('open-comments').addEventListener('click', () => {
          document.getElementById('panel').innerHTML =
            '<div role="textbox" contenteditable="true" aria-label="Viết bình luận"></div>';
        });
      </script>
    `);
    const box = await automation._findCommentBox(page);
    assert.ok(box, 'phải mở bảng bình luận của Reel rồi tìm thấy ô nhập');
    assert.equal(await page.$$eval('[role="textbox"]', nodes => nodes.length), 1);
  } finally {
    await browser.close();
  }
});

test('video comment uses a video-compatible file input', {
  skip: !chromePath,
  timeout: 30000,
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  const automation = new (require('../src/platforms/facebook.adapter')._private.FacebookAutomation)({
    sleep: async () => new Promise(resolve => setTimeout(resolve, 10)),
    commentUploadTimeoutMs: 3000,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form>
        <div id="box" role="textbox" contenteditable="true" aria-label="Viết bình luận"></div>
        <input id="image-input" type="file" accept="image/*">
        <input id="video-input" type="file" accept="video/*">
        <div id="preview"></div>
      </form>
      <script>
        document.getElementById('video-input').addEventListener('change', () => {
          document.getElementById('preview').innerHTML =
            '<video style="width:160px;height:90px"></video>';
        });
      </script>
    `);
    const box = await page.$('#box');
    await automation._attachCommentMedia(page, box, videoPath);
    assert.equal(await page.$eval('#image-input', input => input.files.length), 0);
    assert.equal(await page.$eval('#video-input', input => input.files.length), 1);
  } finally {
    await browser.close();
  }
});

test.after(async () => {
  try { await db.waitReady(); db.close(); } catch (_) {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
