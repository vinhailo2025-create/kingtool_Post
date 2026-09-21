const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'src', 'services', 'license.service.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'public', 'js', 'license.js'), 'utf8');
const account = fs.readFileSync(path.join(root, 'public', 'js', 'account.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('license expiry is separated from network verification', () => {
  assert.match(service, /function verifySignedClaims/);
  assert.match(service, /license_expires_at[\s\S]*expiredState/);
  assert.match(service, /status:\s*'expired'/);
  assert.match(service, /license_last_status/);
  assert.match(service, /classifyOnlineFailure/);
  assert.match(service, /hết hạn\|het han\|expired/);
  assert.match(service, /licenseFetch/);
});

test('expired license overlay offers renewal and recheck actions', () => {
  assert.match(client, /License đã hết hạn/);
  assert.match(client, /Nâng cấp \/ Gia hạn/);
  assert.match(client, /Tôi đã gia hạn — Kiểm tra lại/);
  assert.match(client, /id="lic-refresh"/);
  assert.match(client, /\/api\/license\/refresh/);
  assert.match(client, /expired:\s*'Đã hết hạn'/);
  assert.match(html, /license\.js\?v=20260921license1/);
});

test('active license account always offers upgrade or renewal', () => {
  assert.match(account, /onclick="Account\.buyMore\(\)">Nâng cấp \/ Gia hạn/);
  assert.match(account, /onclick="Account\.refresh\(\)">Kiểm tra trạng thái mới/);
  assert.match(account, /this\.openWeb\('\/customer'\)/);
});

test('active license refreshes after returning from the website and periodically', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(client, /window\.addEventListener\('focus', refreshAfterFocus\)/);
  assert.match(client, /api\('\/api\/license\/refresh'/);
  assert.match(server, /30 \* 60 \* 1000/);
  assert.match(html, /account\.js\?v=20260921license1/);
});
