const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-pairing-'));
process.env.COVERGEMAUTO_DATA_DIR = tempRoot;

const db = require('../src/database/init');

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('pairing secret stays inside the license service while UI receives only the link', async () => {
  await db.waitReady();
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: JSON.parse(options.body || '{}') });
    if (String(url).endsWith('/api/license/pair-start')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          pair_id: '27b3fc0b-c770-44cb-8730-03068c249163',
          device_secret: 'desktop-only-secret',
          authorize_url: 'https://www.kingautomationai.com/activate?t=27b3fc0b-c770-44cb-8730-03068c249163',
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          poll_interval: 2,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, status: 'pending' }),
    };
  };

  try {
    const license = require('../src/services/license.service');
    const publicPair = await license.startPairing();
    assert.equal(publicPair.pair_id, '27b3fc0b-c770-44cb-8730-03068c249163');
    assert.equal('device_secret' in publicPair, false);

    const status = await license.pollPairing();
    assert.equal(status.status, 'pending');
    assert.equal(requests[1].body.device_secret, 'desktop-only-secret');
    assert.equal(requests[0].body.product, 'super-post-king');
  } finally {
    global.fetch = originalFetch;
  }
});

test('license UI uses pairing and keeps HWID in technical details', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'license.js'), 'utf8');
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'desktop_launcher.py'), 'utf8');
  assert.match(client, /Kích hoạt bằng tài khoản/);
  assert.match(client, /\/api\/license\/pair\/start/);
  assert.match(client, /\/api\/license\/pair\/status/);
  assert.match(client, /Thông tin kỹ thuật/);
  assert.match(client, /Chưa có license — Xem gói \/ Nâng cấp/);
  assert.match(client, /\/superpost/);
  assert.match(client, /pywebview\?\.api\?\.open_external_url/);
  assert.match(launcher, /def open_external_url/);
  assert.match(launcher, /www\.kingautomationai\.com/);
  assert.doesNotMatch(client, /Tôi đã kích hoạt trên web — Lấy license/);
});
