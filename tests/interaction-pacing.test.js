const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-pacing-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const InteractionPacing = require('../src/services/interaction-pacing.service');

test('cấu hình delay chung có mặc định cân bằng và cấu hình chống BOT tách theo nền tảng', async () => {
  await db.waitReady();
  const common = InteractionPacing.getInteractionConfig();
  assert.deepEqual(common, {
    enabled: true,
    preset: 'balanced',
    actionMinMs: 800,
    actionMaxMs: 2200,
    typingMinMs: 20,
    typingMaxMs: 80,
    mediaMinMs: 1000,
    mediaMaxMs: 3000,
    beforePublishMinMs: 2000,
    beforePublishMaxMs: 5000,
  });

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('tiktok_anti_bot_enabled', '1');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('tiktok_anti_bot_action_min', '3');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('tiktok_anti_bot_action_max', '7');

  assert.equal(InteractionPacing.getAntiBotConfig('facebook').enabled, false);
  const tiktok = InteractionPacing.getAntiBotConfig('tiktok');
  assert.equal(tiktok.enabled, true);
  assert.equal(tiktok.actionMin, 3);
  assert.equal(tiktok.actionMax, 7);
});

test('pacer random delay sau click, nhập chữ, media và trước nút Đăng rồi khôi phục page', async () => {
  const waits = [];
  const events = [];
  const mouse = {
    async click() { events.push('click'); },
  };
  const keyboard = {
    async sendCharacter(value) { events.push(`char:${value}`); },
    async type(value, options) { events.push(`type:${value}:${options.delay}`); },
  };
  const originalClick = mouse.click;
  const originalSend = keyboard.sendCharacter;
  const originalType = keyboard.type;
  const page = { mouse, keyboard };
  const pacer = new InteractionPacing.InteractionPacer(
    page,
    InteractionPacing.DEFAULT_INTERACTION,
    {
      random: () => 0,
      sleep: async ms => waits.push(ms),
    }
  ).install();

  await mouse.click();
  await keyboard.sendCharacter('ab');
  await keyboard.type('xy', { delay: 1 });
  await pacer.afterMedia();
  await pacer.beforePublish();
  pacer.restore();

  assert.deepEqual(events, ['click', 'char:a', 'char:b', 'type:xy:20']);
  assert.deepEqual(waits, [800, 20, 20, 800, 800, 1000, 2000]);
  assert.equal(mouse.click, originalClick);
  assert.equal(keyboard.sendCharacter, originalSend);
  assert.equal(keyboard.type, originalType);
  await mouse.click();
  assert.equal(events.at(-1), 'click');
});

test('bước chống BOT chỉ dùng hành vi đọc an toàn và random số lượt trong giới hạn', async () => {
  const events = [];
  const logs = [];
  const page = {
    mouse: {
      async move(x, y, options) {
        events.push(['move', x, y, options.steps]);
      },
    },
    viewport() {
      return { width: 1200, height: 800 };
    },
    async goto(url) {
      events.push(['goto', url]);
    },
    async evaluate(fn, value) {
      const source = String(fn);
      if (source.includes('window.scrollBy')) {
        events.push(['scroll', value]);
        return undefined;
      }
      if (source.includes('querySelectorAll')) return [];
      return { width: 1200, height: 800 };
    },
    async waitForNetworkIdle() {
      events.push(['network-idle']);
    },
  };
  const config = {
    ...InteractionPacing.DEFAULT_ANTI_BOT,
    enabled: true,
    actionMin: 3,
    actionMax: 3,
    openDelayMinMs: 0,
    openDelayMaxMs: 0,
    actionDelayMinMs: 0,
    actionDelayMaxMs: 0,
    readDelayMinMs: 0,
    readDelayMaxMs: 0,
    beforePostMinMs: 0,
    beforePostMaxMs: 0,
    maxTotalMs: 5000,
  };
  const result = await InteractionPacing.performAntiBotWarmup(
    page,
    'facebook',
    config,
    {
      postIndex: 0,
      random: () => 0,
      sleep: async () => {},
      log: message => logs.push(message),
    }
  );

  assert.equal(result.performed, true);
  assert.equal(result.actions.length, 3);
  assert.ok(events.some(event => event[0] === 'goto'));
  assert.ok(events.some(event => event[0] === 'scroll'));
  assert.ok(events.some(event => event[0] === 'move'));
  assert.ok(logs.some(message => message.includes('Chống BOT')));
  assert.doesNotMatch(JSON.stringify(events), /like|follow|share|comment|message/i);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
