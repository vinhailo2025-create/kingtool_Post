const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-browser-login-test-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');

class FakeChromeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 45678;
    this.exitCode = null;
    queueMicrotask(() => this.emit('spawn'));
  }

  kill() {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

test('Chrome mới đăng nhập thủ công không dùng Puppeteer và giữ nguyên profile', async () => {
  await db.waitReady();
  const BrowserService = require('../src/services/browser.service');
  const profile = BrowserService.create({ name: 'Google login test' });
  const chromePath = path.join(testRoot, 'Google', 'Chrome', 'chrome.exe');
  fs.mkdirSync(path.dirname(chromePath), { recursive: true });
  fs.writeFileSync(chromePath, 'fake chrome');

  const cookieFile = path.join(profile.profile_path, 'Default', 'Network', 'Cookies');
  fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
  fs.writeFileSync(cookieFile, 'cookie-data-must-stay');

  const originalFindChromePath = BrowserService.findChromePath;
  const originalSpawner = BrowserService._spawnManualChrome;
  const originalLaunch = BrowserService.launch;
  let launch = null;
  BrowserService.findChromePath = async () => chromePath;
  BrowserService._spawnManualChrome = (executablePath, args, options) => {
    launch = { executablePath, args, options };
    return new FakeChromeProcess();
  };

  try {
    const opened = await BrowserService.open(profile.id);
    assert.equal(opened.mode, 'login');
    assert.equal(launch.executablePath, chromePath);
    assert.ok(launch.args.includes(`--user-data-dir=${profile.profile_path}`));
    // Mo trang New Tab mac dinh, khong ep vao Facebook hay bat ky URL nao.
    assert.equal(launch.args.some(arg => /^https?:\/\//i.test(arg)), false);
    assert.equal(launch.args.some(arg => /remote-debugging/i.test(arg)), false);
    assert.equal(launch.args.some(arg => /enable-automation/i.test(arg)), false);
    assert.equal(launch.options.windowsHide, false);

    assert.equal(BrowserService.getById(profile.id).status, 'login');
    const status = await BrowserService.getStatus(profile.id, 'youtube');
    assert.equal(status.isOpen, true);
    assert.equal(status.isLoginOpen, true);
    assert.equal(status.mode, 'login');
    await assert.rejects(
      BrowserService.launch(profile.id, { platform: 'youtube' }),
      /đóng cửa sổ Đăng nhập/
    );

    let automationStarted = false;
    BrowserService.launch = async id => {
      assert.equal(BrowserService.getById(id).status, 'closed');
      automationStarted = true;
      return { success: true };
    };
    await BrowserService.acquire(profile.id, { platform: 'youtube' });
    assert.equal(automationStarted, true);
    assert.equal(BrowserService.getLeaseCount(profile.id), 1);
    await BrowserService.release(profile.id);
    assert.equal(BrowserService.getById(profile.id).status, 'closed');
    assert.equal(fs.readFileSync(cookieFile, 'utf8'), 'cookie-data-must-stay');
  } finally {
    BrowserService.findChromePath = originalFindChromePath;
    BrowserService._spawnManualChrome = originalSpawner;
    BrowserService.launch = originalLaunch;
    await BrowserService.close(profile.id).catch(() => {});
    await BrowserService.delete(profile.id).catch(() => {});
  }
});

test('giao diện chỉ có một nút Mở và tự theo dõi Chrome thường khi đóng', () => {
  const root = path.join(__dirname, '..');
  const browserManager = fs.readFileSync(path.join(root, 'public/js/browser-manager.js'), 'utf8');
  const browserRoutes = fs.readFileSync(path.join(root, 'src/routes/browser.routes.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

  assert.doesNotMatch(browserManager, />Đăng nhập<\/button>/);
  assert.match(browserManager, /\/api\/browsers\/\$\{id\}\/launch/);
  assert.match(browserManager, /_watchLoginClose\(id\)/);
  assert.match(browserManager, /response\.mode === 'login'/);
  assert.match(browserManager, />Tạo mới<\/button>/);
  assert.doesNotMatch(browserManager, />Chrome mới<\/button>/);
  assert.match(browserRoutes, /BrowserService\.open\(parseInt\(req\.params\.id\)/);
  assert.doesNotMatch(browserRoutes, /router\.post\('\/:id\/login'/);
  assert.match(html, /browser-manager\.js\?v=20260917login1/);
  assert.match(browserManager, /launch\?platform=\$\{platform\}/);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
