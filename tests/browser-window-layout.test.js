const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-window-layout-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const BrowserService = require('../src/services/browser.service');

test('browser_per_screen reserves distinct real-window tiles during concurrent launches', async () => {
  await db.waitReady();
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'browser_layout_rows'").run();
  db.prepare("UPDATE settings SET value = '4' WHERE key = 'browser_layout_columns'").run();
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'browser_window_ratio'").run();
  const workArea = { left: 0, top: 0, width: 1920, height: 1040 };
  const layouts = [101, 102, 103, 104].map(id => BrowserService._getWindowLayout(id, workArea));
  assert.deepEqual(layouts, [
    { width: 480, height: 520, left: 0, top: 0 },
    { width: 480, height: 520, left: 480, top: 0 },
    { width: 480, height: 520, left: 960, top: 0 },
    { width: 480, height: 520, left: 1440, top: 0 },
  ]);
});

test('two browsers preserve the screen aspect ratio and stay inside the real work area', async () => {
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'browser_layout_rows'").run();
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'browser_layout_columns'").run();
  const workArea = { left: 0, top: 0, width: 1707, height: 912 };
  assert.deepEqual(BrowserService._getWindowLayout(201, workArea), {
    width: 853, height: 456, left: 0, top: 0,
  });
  assert.deepEqual(BrowserService._getWindowLayout(202, workArea), {
    width: 853, height: 456, left: 853, top: 0,
  });
});

test('managed Chrome shrinks device-scale-factor so small tiles keep a desktop viewport', async () => {
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'browser_layout_rows'").run();
  db.prepare("UPDATE settings SET value = '4' WHERE key = 'browser_layout_columns'").run();
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'browser_window_ratio'").run();
  const workArea = { left: 0, top: 0, width: 1920, height: 1040 };
  const layout = BrowserService._getWindowLayout(401, workArea, 'chrome');
  // Ô 480x520 nhỏ hơn ngưỡng desktop -> hạ scale, nở CSS viewport.
  assert.equal(layout.scale, 0.48);
  assert.equal(layout.width, 1000);
  assert.equal(layout.height, 1083);
  // Footprint vật lý (DIP*scale) vẫn đúng bằng ô cũ 480x520.
  assert.equal(Math.round(layout.width * layout.scale), 480);
  assert.equal(Math.round(layout.height * layout.scale), 520);
});

test('large tiles keep the original geometry with no scale override', async () => {
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'browser_layout_rows'").run();
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'browser_layout_columns'").run();
  const workArea = { left: 0, top: 0, width: 1920, height: 1040 };
  const layout = BrowserService._getWindowLayout(402, workArea, 'chrome');
  assert.equal(layout.scale, undefined);
  assert.deepEqual(layout, { width: 1920, height: 1040, left: 0, top: 0 });
});

test('non-chrome providers never receive a scale override', async () => {
  db.prepare("UPDATE settings SET value = '2' WHERE key = 'browser_layout_rows'").run();
  db.prepare("UPDATE settings SET value = '4' WHERE key = 'browser_layout_columns'").run();
  const workArea = { left: 0, top: 0, width: 1920, height: 1040 };
  const layout = BrowserService._getWindowLayout(403, workArea, 'gemlogin');
  assert.equal(layout.scale, undefined);
  assert.equal(layout.width, 480);
  assert.equal(layout.height, 520);
});

test('layout changes real native window bounds', async () => {
  const calls = [];
  const session = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
      return {};
    },
    detach: async () => {},
  };
  const page = {
    createCDPSession: async () => session,
    evaluate: async () => { throw new Error('fallback should not run'); },
  };
  const layout = { width: 960, height: 520, left: 960, top: 520 };
  assert.equal(await BrowserService._applyWindowBounds(page, layout), true);
  assert.deepEqual(calls.map(call => call.method), [
    'Browser.getWindowForTarget',
    'Browser.setWindowBounds',
    'Browser.setWindowBounds',
  ]);
  assert.deepEqual(calls[2].params.bounds, layout);
  assert.equal(calls.some(call => call.method.startsWith('Emulation.')), false);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
