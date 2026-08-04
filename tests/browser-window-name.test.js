const test = require('node:test');
const assert = require('node:assert/strict');

const BrowserWindowNameService = require('../src/services/browser-window-name.service');

test('browser window identity sanitizes the name and binds current and future pages', async () => {
  const calls = [];
  const page = {
    evaluateOnNewDocument: async (fn, name) => calls.push(['future', typeof fn, name]),
    evaluate: async (fn, name) => calls.push(['current', typeof fn, name]),
  };
  let targetHandler;
  const browser = {
    pages: async () => [page],
    on: (event, handler) => {
      assert.equal(event, 'targetcreated');
      targetHandler = handler;
    },
  };

  const result = await BrowserWindowNameService.bind(browser, '  Tiktok3\n ');
  assert.deepEqual(result, { name: 'Tiktok3', pages: 1, skipped: false });
  assert.deepEqual(calls, [
    ['future', 'function', 'Tiktok3'],
    ['current', 'function', 'Tiktok3'],
  ]);

  const secondPage = {
    evaluateOnNewDocument: async (fn, name) => calls.push(['future-2', typeof fn, name]),
    evaluate: async (fn, name) => calls.push(['current-2', typeof fn, name]),
  };
  await targetHandler({ page: async () => secondPage });
  assert.deepEqual(calls.slice(-2), [
    ['future-2', 'function', 'Tiktok3'],
    ['current-2', 'function', 'Tiktok3'],
  ]);
});
