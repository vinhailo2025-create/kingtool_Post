'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist', 'desktop_launcher.dist');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-browser-callbacks-'));
process.env.COVERGEMAUTO_DATA_DIR = dataRoot;

function runRemote(fn, args = [], globals = {}) {
  return vm.runInNewContext(
    `(${fn.toString()})(...__args)`,
    { ...globals, __args: args }
  );
}

async function verifyWindowTitle() {
  const service = require(path.join(dist, 'src', 'services', 'browser-window-name.service'));
  const document = {
    title: 'Home',
    head: null,
    documentElement: null,
    readyState: 'complete',
  };
  runRemote(service.installTitlePrefix, ['Vinh-Sora'], {
    document,
    window: {},
    MutationObserver: function MutationObserver() {},
  });
  assert.equal(document.title, 'Vinh-Sora • Home');
}

async function verifyManagedTargets() {
  const service = require(path.join(dist, 'src', 'services', 'managed-targets.service'));
  const anchor = {
    href: 'https://www.facebook.com/example-page',
    textContent: 'Example Page',
    getAttribute: () => '',
  };
  const page = {
    goto: async () => {},
    evaluate: async (fn, ...args) => runRemote(fn, args, {
      document: { querySelectorAll: () => [anchor] },
    }),
  };
  const targets = await service._private.collectFromPage(page, 'facebook');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].name, 'Example Page');
}

async function verifyInteractionPacing() {
  const service = require(path.join(dist, 'src', 'services', 'interaction-pacing.service'));
  const page = {
    goto: async () => {},
    evaluate: async (fn, ...args) => runRemote(fn, args, {
      window: { scrollBy: () => {} },
      innerHeight: 800,
      innerWidth: 1200,
    }),
  };
  const result = await service.performAntiBotWarmup(page, 'threads', {
    enabled: true,
    fullEachPost: true,
    maxTotalMs: 1000,
    actionMin: 1,
    actionMax: 1,
    openDelayMinMs: 0,
    openDelayMaxMs: 0,
    readDelayMinMs: 0,
    readDelayMaxMs: 0,
    actionDelayMinMs: 0,
    actionDelayMaxMs: 0,
    beforePostMinMs: 0,
    beforePostMaxMs: 0,
    extraSafeEnabled: false,
    extraProbability: 0,
    onError: 'continue',
  }, {
    random: () => 0,
    sleep: async () => {},
    log: () => {},
    postIndex: 0,
  });
  assert.equal(result.performed, true);
  assert.equal(result.actions.length, 1);
}

async function verifyBrowserHelpers() {
  const service = require(path.join(dist, 'src', 'services', 'browser.service'));
  const workArea = await service._getPageWorkArea({
    evaluate: async (fn, ...args) => runRemote(fn, args, {
      screen: {
        availLeft: 10,
        availTop: 20,
        availWidth: 1000,
        availHeight: 700,
        width: 1100,
        height: 800,
      },
    }),
  });
  assert.equal(workArea.left, 10);
  assert.equal(workArea.top, 20);
  assert.equal(workArea.width, 1000);
  assert.equal(workArea.height, 700);

  const navigator = {};
  const localeApplied = await service._applyPlatformLocale({
    setExtraHTTPHeaders: async () => {},
    evaluateOnNewDocument: async (fn, ...args) => runRemote(fn, args, { navigator }),
    target: () => ({
      createCDPSession: async () => ({
        send: async () => {},
        detach: async () => {},
      }),
    }),
    url: () => 'https://www.tiktok.com/',
  }, 'tiktok');
  assert.equal(localeApplied, true);
  assert.equal(navigator.language, 'en-US');
  assert.deepEqual(Array.from(navigator.languages), ['en-US', 'en']);

  const moved = await service._applyWindowBounds({
    createCDPSession: async () => {
      throw new Error('CDP unavailable');
    },
    evaluate: async (fn, ...args) => runRemote(fn, args, {
      window: {
        moveTo: () => {},
        resizeTo: () => {},
      },
      outerWidth: 900,
      outerHeight: 600,
    }),
  }, { left: 30, top: 40, width: 900, height: 600 });
  assert.equal(moved, true);
}

async function main() {
  await verifyWindowTitle();
  await verifyManagedTargets();
  await verifyInteractionPacing();
  await verifyBrowserHelpers();
  console.log('Protected browser callbacks execute without external decoder references.');
}

main()
  .finally(() => {
    const resolved = path.resolve(dataRoot);
    const tempRoot = path.resolve(os.tmpdir());
    if (resolved.startsWith(`${tempRoot}${path.sep}`)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  })
  .catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
