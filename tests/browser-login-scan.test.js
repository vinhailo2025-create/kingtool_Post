const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-login-scan-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const BrowserService = require('../src/services/browser.service');
const db = require('../src/database/init');
const { cookieIsUsable, detectPlatformLogins } = BrowserService._private;

test('login scan rejects expired and empty cookies', () => {
  const now = Date.now();
  assert.equal(cookieIsUsable({
    name: 'c_user',
    host: 'facebook.com',
    hasValue: false,
    expires: 0,
  }, now), false);
  assert.equal(cookieIsUsable({
    name: 'c_user',
    host: 'facebook.com',
    hasValue: true,
    expires: Math.floor(now / 1000) - 60,
  }, now), false);
  assert.equal(cookieIsUsable({
    name: 'c_user',
    host: 'facebook.com',
    hasValue: true,
    expires: Math.floor(now / 1000) + 3600,
  }, now), true);
});

test('login scan requires strong platform session cookies', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const detected = detectPlatformLogins([
    { name: 'c_user', host: '.facebook.com', hasValue: true, expires: future },
    { name: 'SID', host: '.google.com', hasValue: true, expires: future },
    { name: 'SAPISID', host: '.google.com', hasValue: true, expires: future },
    { name: 'ct0', host: '.x.com', hasValue: true, expires: future },
    { name: 'sessionid', host: '.instagram.com', hasValue: true, expires: future },
  ]);
  assert.ok(detected.includes('facebook'));
  assert.ok(detected.includes('youtube'));
  assert.ok(!detected.includes('x'), 'ct0 alone must not count as an X login');
  assert.ok(!detected.includes('instagram'), 'Instagram also needs ds_user_id');
});

test('browser login column labels uncertain scans without claiming logged out', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'browser-manager.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  assert.match(ui, /Phiên đăng nhập/);
  assert.match(ui, /Chưa xác minh/);
  assert.match(ui, /Không phát hiện phiên/);
  assert.doesNotMatch(ui, /Chưa đăng nhập<\/span>/);
  assert.match(css, /\.browser-session-state/);
});

test.after(async () => {
  try { await db.waitReady(); db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
