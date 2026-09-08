const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const config = require('../config');
const { FacebookAutomation } = require('../src/platforms/facebook.adapter')._private;

const chromePath = config.CHROME_PATHS.find(candidate => candidate && fs.existsSync(candidate));

async function createPage(browser, withAiOption = true) {
  const page = await browser.newPage();
  await page.setContent(`
    <!doctype html>
    <html><body>
      <div id="composer" role="dialog" style="width:600px;min-height:300px;padding:20px">
        <div contenteditable="true" role="textbox">Caption có media</div>
        ${withAiOption ? `
          <button id="ai-row" type="button">Nhãn AI · Đã tắt</button>
          <section id="ai-panel" hidden>
            <label style="display:flex;gap:8px">
              <span>Nhãn AI</span>
              <button id="ai-switch" type="button" role="switch"
                      aria-label="Nhãn AI" aria-checked="false">Tắt</button>
            </label>
          </section>
        ` : '<button type="button">Đăng</button>'}
      </div>
      <script>
        const row = document.getElementById('ai-row');
        const panel = document.getElementById('ai-panel');
        const toggle = document.getElementById('ai-switch');
        if (row) row.addEventListener('click', () => { panel.hidden = false; });
        if (toggle) toggle.addEventListener('click', () => {
          toggle.setAttribute('aria-checked', 'true');
          toggle.textContent = 'Bật';
          row.textContent = 'Nhãn AI · Đã bật';
        });
      </script>
    </body></html>
  `);
  return page;
}

test('bật Nhãn AI trong composer khi cấu hình đã chọn và bài có media', {
  skip: !chromePath && 'Chrome is not installed',
  timeout: 30000,
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  try {
    const page = await createPage(browser);
    const modal = await page.$('#composer');
    const automation = new FacebookAutomation({
      addAiLabel: true,
      sleep: async () => {},
    });

    assert.equal(await automation._configureAiLabelIfNeeded(page, modal, true), true);
    assert.equal(await page.$eval('#ai-switch', element => element.getAttribute('aria-checked')), 'true');
    assert.match(await page.$eval('#ai-row', element => element.innerText), /Đã bật/);
  } finally {
    await browser.close();
  }
});

test('đóng thông báo lần đầu và quay lại composer sau khi bật Nhãn AI', {
  skip: !chromePath && 'Chrome is not installed',
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
      <!doctype html>
      <html><body>
        <div id="composer" role="dialog" style="width:600px;min-height:300px;padding:20px">
          <div contenteditable="true" role="textbox">Caption</div>
          <button id="ai-row" type="button">Nhãn AI · Đã tắt</button>
        </div>
        <div id="ai-settings" role="dialog" hidden style="width:500px;min-height:220px;padding:20px">
          <button id="back" type="button" aria-label="Quay lại" style="width:40px;height:30px"></button>
          <h2>Gắn nhãn nội dung</h2>
          <button id="ai-switch" type="button" role="switch"
                  aria-label="Nhãn AI" aria-checked="false">Tắt</button>
        </div>
        <script>
          const composer = document.getElementById('composer');
          const settings = document.getElementById('ai-settings');
          document.getElementById('ai-row').addEventListener('click', () => {
            settings.hidden = false;
          });
          document.getElementById('ai-switch').addEventListener('click', event => {
            event.currentTarget.setAttribute('aria-checked', 'true');
            const notice = document.createElement('div');
            notice.id = 'ai-notice';
            notice.setAttribute('role', 'dialog');
            notice.style.cssText = 'width:520px;min-height:240px;padding:20px';
            notice.innerHTML = '<h2>Gắn nhãn nội dung</h2><p>Thêm nhãn AI. Chúng tôi yêu cầu gắn nhãn cho nội dung tạo bằng AI.</p><button id="notice-ok">OK</button>';
            notice.querySelector('#notice-ok').addEventListener('click', () => notice.remove());
            document.body.appendChild(notice);
          });
          document.getElementById('back').addEventListener('click', () => {
            settings.hidden = true;
            composer.dataset.returned = 'true';
          });
        </script>
      </body></html>
    `);
    const composer = await page.$('#composer');
    const automation = new FacebookAutomation({
      addAiLabel: true,
      sleep: async () => {},
    });

    assert.equal(await automation._configureAiLabelIfNeeded(page, composer, true), true);
    assert.equal(await page.$('#ai-notice'), null);
    assert.equal(await page.$eval('#ai-settings', element => element.hidden), true);
    assert.equal(await page.$eval('#composer', element => element.dataset.returned), 'true');
  } finally {
    await browser.close();
  }
});

test('giữ nguyên quy trình cũ khi không chọn Nhãn AI hoặc bài không có media', async () => {
  const automationOff = new FacebookAutomation({ addAiLabel: false });
  automationOff._enableAiLabel = async () => {
    throw new Error('Không được gọi thao tác Nhãn AI');
  };
  assert.equal(await automationOff._configureAiLabelIfNeeded({}, {}, true), false);

  const automationNoMedia = new FacebookAutomation({ addAiLabel: true });
  automationNoMedia._enableAiLabel = automationOff._enableAiLabel;
  assert.equal(await automationNoMedia._configureAiLabelIfNeeded({}, {}, false), false);
});

test('không đăng âm thầm nếu đã chọn nhưng Facebook không hiển thị mục Nhãn AI', {
  skip: !chromePath && 'Chrome is not installed',
  timeout: 30000,
}, async () => {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-first-run', '--disable-gpu'],
  });
  try {
    const page = await createPage(browser, false);
    const modal = await page.$('#composer');
    const automation = new FacebookAutomation({
      addAiLabel: true,
      sleep: async () => {},
    });
    await assert.rejects(
      automation._configureAiLabelIfNeeded(page, modal, true),
      error => error?.code === 'FACEBOOK_AI_LABEL_OPTION_NOT_FOUND'
    );
  } finally {
    await browser.close();
  }
});
