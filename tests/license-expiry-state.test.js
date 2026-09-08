const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-license-'));
process.env.COVERGEMAUTO_DATA_DIR = tempRoot;

const db = require('../src/database/init');

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('online expired response is persisted as expired instead of network error', async () => {
  await db.waitReady();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'license_key',
    'KT-TEST-EXPIRED'
  );

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ valid: false, error: 'License đã hết hạn' }),
  });

  try {
    const license = require('../src/services/license.service');
    const state = await license.verifyOnline();
    assert.equal(state.activated, true);
    assert.equal(state.valid, false);
    assert.equal(state.status, 'expired');
    assert.equal(state.reason, 'License đã hết hạn');
  } finally {
    global.fetch = originalFetch;
  }
});
