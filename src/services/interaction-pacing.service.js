const db = require('../database/init');
const { normalizePlatform, scopedSettingKey } = require('../platforms/platform.utils');

const HOME_URLS = Object.freeze({
  facebook: 'https://www.facebook.com/',
  tiktok: 'https://www.tiktok.com/',
  youtube: 'https://www.youtube.com/',
  threads: 'https://www.threads.com/',
  instagram: 'https://www.instagram.com/',
  x: 'https://x.com/home',
  zalovideo: 'https://video.zalo.me/',
});

const DEFAULT_ANTI_BOT = Object.freeze({
  enabled: false,
  extraSafeEnabled: false,
  preset: 'balanced',
  actionMin: 2,
  actionMax: 5,
  openDelayMinMs: 3000,
  openDelayMaxMs: 8000,
  actionDelayMinMs: 1000,
  actionDelayMaxMs: 5000,
  readDelayMinMs: 2000,
  readDelayMaxMs: 7000,
  beforePostMinMs: 2000,
  beforePostMaxMs: 6000,
  maxTotalMs: 35000,
  extraProbability: 25,
  fullEachPost: false,
  onError: 'continue',
});

const DEFAULT_INTERACTION = Object.freeze({
  enabled: true,
  captionInputMode: 'fast',
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

const lastPlans = new Map();

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  const result = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(result, min), max);
}

function orderedRange(minValue, maxValue, fallbackMin, fallbackMax, floor, ceiling) {
  const min = numberInRange(minValue, fallbackMin, floor, ceiling);
  const max = numberInRange(maxValue, fallbackMax, floor, ceiling);
  return { min, max: Math.max(min, max) };
}

function randomBetween(min, max, random = Math.random) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  return low + Math.floor(random() * (high - low + 1));
}

function readSettings(keys) {
  if (!keys.length) return {};
  const placeholders = keys.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`
  ).all(...keys);
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}

function platformKey(platform, key) {
  return scopedSettingKey(normalizePlatform(platform), key);
}

function getAntiBotConfig(platform = 'facebook') {
  platform = normalizePlatform(platform);
  const names = [
    'anti_bot_enabled',
    'anti_bot_extra_safe_enabled',
    'anti_bot_preset',
    'anti_bot_action_min',
    'anti_bot_action_max',
    'anti_bot_open_delay_min_ms',
    'anti_bot_open_delay_max_ms',
    'anti_bot_action_delay_min_ms',
    'anti_bot_action_delay_max_ms',
    'anti_bot_read_delay_min_ms',
    'anti_bot_read_delay_max_ms',
    'anti_bot_before_post_min_ms',
    'anti_bot_before_post_max_ms',
    'anti_bot_max_total_ms',
    'anti_bot_extra_probability',
    'anti_bot_full_each_post',
    'anti_bot_on_error',
  ];
  const keys = names.map(name => platformKey(platform, name));
  const rows = readSettings(keys);
  const value = name => rows[platformKey(platform, name)];
  const actions = orderedRange(
    value('anti_bot_action_min'),
    value('anti_bot_action_max'),
    DEFAULT_ANTI_BOT.actionMin,
    DEFAULT_ANTI_BOT.actionMax,
    1,
    20
  );
  const openDelay = orderedRange(
    value('anti_bot_open_delay_min_ms'),
    value('anti_bot_open_delay_max_ms'),
    DEFAULT_ANTI_BOT.openDelayMinMs,
    DEFAULT_ANTI_BOT.openDelayMaxMs,
    0,
    60000
  );
  const actionDelay = orderedRange(
    value('anti_bot_action_delay_min_ms'),
    value('anti_bot_action_delay_max_ms'),
    DEFAULT_ANTI_BOT.actionDelayMinMs,
    DEFAULT_ANTI_BOT.actionDelayMaxMs,
    0,
    30000
  );
  const readDelay = orderedRange(
    value('anti_bot_read_delay_min_ms'),
    value('anti_bot_read_delay_max_ms'),
    DEFAULT_ANTI_BOT.readDelayMinMs,
    DEFAULT_ANTI_BOT.readDelayMaxMs,
    0,
    30000
  );
  const beforePost = orderedRange(
    value('anti_bot_before_post_min_ms'),
    value('anti_bot_before_post_max_ms'),
    DEFAULT_ANTI_BOT.beforePostMinMs,
    DEFAULT_ANTI_BOT.beforePostMaxMs,
    0,
    30000
  );
  return {
    enabled: value('anti_bot_enabled') === '1',
    extraSafeEnabled: value('anti_bot_extra_safe_enabled') === '1',
    preset: ['light', 'balanced', 'custom'].includes(value('anti_bot_preset'))
      ? value('anti_bot_preset')
      : DEFAULT_ANTI_BOT.preset,
    actionMin: actions.min,
    actionMax: actions.max,
    openDelayMinMs: openDelay.min,
    openDelayMaxMs: openDelay.max,
    actionDelayMinMs: actionDelay.min,
    actionDelayMaxMs: actionDelay.max,
    readDelayMinMs: readDelay.min,
    readDelayMaxMs: readDelay.max,
    beforePostMinMs: beforePost.min,
    beforePostMaxMs: beforePost.max,
    maxTotalMs: numberInRange(
      value('anti_bot_max_total_ms'),
      DEFAULT_ANTI_BOT.maxTotalMs,
      3000,
      180000
    ),
    extraProbability: numberInRange(
      value('anti_bot_extra_probability'),
      DEFAULT_ANTI_BOT.extraProbability,
      0,
      100
    ),
    fullEachPost: value('anti_bot_full_each_post') === '1',
    onError: value('anti_bot_on_error') === 'stop' ? 'stop' : 'continue',
  };
}

function getInteractionConfig() {
  const names = [
    'interaction_delay_enabled',
    'caption_input_mode',
    'interaction_delay_preset',
    'interaction_delay_min_ms',
    'interaction_delay_max_ms',
    'interaction_typing_min_ms',
    'interaction_typing_max_ms',
    'interaction_media_min_ms',
    'interaction_media_max_ms',
    'interaction_before_publish_min_ms',
    'interaction_before_publish_max_ms',
  ];
  const rows = readSettings(names);
  const action = orderedRange(
    rows.interaction_delay_min_ms,
    rows.interaction_delay_max_ms,
    DEFAULT_INTERACTION.actionMinMs,
    DEFAULT_INTERACTION.actionMaxMs,
    0,
    15000
  );
  const typing = orderedRange(
    rows.interaction_typing_min_ms,
    rows.interaction_typing_max_ms,
    DEFAULT_INTERACTION.typingMinMs,
    DEFAULT_INTERACTION.typingMaxMs,
    0,
    1000
  );
  const media = orderedRange(
    rows.interaction_media_min_ms,
    rows.interaction_media_max_ms,
    DEFAULT_INTERACTION.mediaMinMs,
    DEFAULT_INTERACTION.mediaMaxMs,
    0,
    30000
  );
  const beforePublish = orderedRange(
    rows.interaction_before_publish_min_ms,
    rows.interaction_before_publish_max_ms,
    DEFAULT_INTERACTION.beforePublishMinMs,
    DEFAULT_INTERACTION.beforePublishMaxMs,
    0,
    30000
  );
  return {
    enabled: rows.interaction_delay_enabled !== '0',
    captionInputMode: rows.caption_input_mode === 'typing' ? 'typing' : 'fast',
    preset: ['fast', 'balanced', 'slow', 'custom'].includes(rows.interaction_delay_preset)
      ? rows.interaction_delay_preset
      : DEFAULT_INTERACTION.preset,
    actionMinMs: action.min,
    actionMaxMs: action.max,
    typingMinMs: typing.min,
    typingMaxMs: typing.max,
    mediaMinMs: media.min,
    mediaMaxMs: media.max,
    beforePublishMinMs: beforePublish.min,
    beforePublishMaxMs: beforePublish.max,
  };
}

async function scrollAction(page, random) {
  const amount = randomBetween(220, 780, random) * (random() < 0.25 ? -1 : 1);
  await page.evaluate(value => window.scrollBy({ top: value, behavior: 'smooth' }), amount);
  return amount > 0 ? 'cuộn xuống' : 'cuộn lên';
}

async function moveAction(page, random) {
  const viewport = typeof page.viewport === 'function' ? page.viewport() : null;
  const size = viewport || await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const width = Math.max(320, Number(size?.width) || 1280);
  const height = Math.max(240, Number(size?.height) || 720);
  const x = randomBetween(Math.round(width * 0.18), Math.round(width * 0.82), random);
  const y = randomBetween(Math.round(height * 0.18), Math.round(height * 0.78), random);
  await page.mouse.move(x, y, { steps: randomBetween(8, 24, random) });
  return 'di chuyển chuột';
}

async function hoverAction(page, random) {
  const points = await page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 40 && rect.height > 25
        && rect.bottom > 0 && rect.right > 0
        && rect.top < innerHeight && rect.left < innerWidth
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll(
      'main [role="article"], main img, header, nav, [role="main"] img'
    )).filter(visible).slice(0, 30).map(element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
  }).catch(() => []);
  if (!points.length) return moveAction(page, random);
  const point = points[randomBetween(0, points.length - 1, random)];
  await page.mouse.move(point.x, point.y, { steps: randomBetween(8, 22, random) });
  return 'hover vùng nội dung';
}

async function waitLoadAction(page) {
  if (typeof page.waitForNetworkIdle === 'function') {
    await page.waitForNetworkIdle({ idleTime: 350, timeout: 2500 }).catch(() => {});
  }
  return 'chờ trang ổn định';
}

async function expandTextAction(page) {
  const clicked = await page.evaluate(() => {
    const normalize = value => String(value || '').normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 20 && rect.height > 10
        && rect.bottom > 0 && rect.top < innerHeight
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const button = Array.from(document.querySelectorAll(
      'main button, main [role="button"], main [tabindex="0"]'
    )).filter(visible).find(element =>
      ['xem them', 'see more', 'more'].includes(normalize(
        element.innerText || element.getAttribute('aria-label')
      ))
    );
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  return clicked ? 'mở rộng nội dung' : 'dừng đọc';
}

function buildPlan(config, count, random) {
  const base = ['scroll', 'move', 'hover', 'pause', 'wait'];
  const plan = [];
  for (let index = 0; index < count; index++) {
    let pool = base;
    if (config.extraSafeEnabled && random() * 100 < config.extraProbability) {
      pool = [...base, 'expand'];
    }
    const previous = plan[plan.length - 1];
    let action = pool[randomBetween(0, pool.length - 1, random)];
    if (
      action === previous
      && action === plan[plan.length - 2]
      && pool.some(candidate => candidate !== action)
    ) {
      action = pool.find(candidate => candidate !== action);
    }
    plan.push(action);
  }
  return plan;
}

async function performAntiBotWarmup(page, platform, config, context = {}) {
  if (!config?.enabled) return { performed: false, actions: [] };
  const random = context.random || Math.random;
  const wait = context.sleep || sleep;
  const log = typeof context.log === 'function' ? context.log : () => {};
  const full = context.postIndex === 0 || config.fullEachPost;
  const maxTotalMs = full ? config.maxTotalMs : Math.min(config.maxTotalMs, 12000);
  const startedAt = Date.now();
  const count = full
    ? randomBetween(config.actionMin, config.actionMax, random)
    : randomBetween(1, Math.min(2, config.actionMax), random);
  let plan = buildPlan(config, count, random);
  const planKey = `${normalizePlatform(platform)}:${plan.join(',')}`;
  if (lastPlans.get(normalizePlatform(platform)) === planKey && plan.length > 1) {
    plan = [...plan.slice(1), plan[0]];
  }
  lastPlans.set(normalizePlatform(platform), `${normalizePlatform(platform)}:${plan.join(',')}`);

  const ensureBudget = ms => Math.max(0, Math.min(ms, maxTotalMs - (Date.now() - startedAt)));
  try {
    const homeUrl = HOME_URLS[normalizePlatform(platform)];
    if (homeUrl && typeof page.goto === 'function') {
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    const openDelay = ensureBudget(randomBetween(
      config.openDelayMinMs,
      config.openDelayMaxMs,
      random
    ));
    await wait(openDelay);
    log(`Chống BOT: ${plan.length} thao tác ngẫu nhiên, tối đa ${Math.round(maxTotalMs / 1000)} giây`, 'info');

    const completed = [];
    for (const action of plan) {
      if (Date.now() - startedAt >= maxTotalMs) break;
      let label = action;
      if (action === 'scroll') label = await scrollAction(page, random);
      else if (action === 'move') label = await moveAction(page, random);
      else if (action === 'hover') label = await hoverAction(page, random);
      else if (action === 'wait') label = await waitLoadAction(page);
      else if (action === 'expand') label = await expandTextAction(page);
      else {
        label = 'dừng đọc';
        await wait(ensureBudget(randomBetween(
          config.readDelayMinMs,
          config.readDelayMaxMs,
          random
        )));
      }
      completed.push(label);
      const between = ensureBudget(randomBetween(
        config.actionDelayMinMs,
        config.actionDelayMaxMs,
        random
      ));
      await wait(between);
    }
    const beforePost = ensureBudget(randomBetween(
      config.beforePostMinMs,
      config.beforePostMaxMs,
      random
    ));
    await wait(beforePost);
    log(`Chống BOT hoàn tất: ${completed.join(' · ')}`, 'info');
    return {
      performed: true,
      actions: completed,
      elapsedMs: Date.now() - startedAt,
      full,
    };
  } catch (error) {
    if (error?.code === 'RUNNER_STOPPED' || config.onError === 'stop') throw error;
    log(`Bỏ qua bước chống BOT: ${error.message}`, 'warning');
    return { performed: false, actions: [], skipped: true, error: error.message };
  }
}

class InteractionPacer {
  constructor(page, config, dependencies = {}) {
    this.page = page;
    this.config = config || DEFAULT_INTERACTION;
    this.random = dependencies.random || Math.random;
    this.wait = dependencies.sleep || sleep;
    this.restoreCallbacks = [];
    this.publishCommitted = false;
  }

  _duration(min, max) {
    return randomBetween(min, max, this.random);
  }

  async afterAction() {
    if (!this.config.enabled) return;
    await this.wait(this._duration(this.config.actionMinMs, this.config.actionMaxMs));
  }

  async afterMedia() {
    if (!this.config.enabled) return;
    await this.wait(this._duration(this.config.mediaMinMs, this.config.mediaMaxMs));
  }

  async beforePublish() {
    // Luon di qua `wait` (ke ca khi tat pacing) de runner co co hoi ngat truoc
    // moc bam Dang. Sau moc nay adapter bam Dang ngay, nen dung giua chung
    // phai coi la bai da len de khong dang trung.
    await this.wait(this.config.enabled
      ? this._duration(this.config.beforePublishMinMs, this.config.beforePublishMaxMs)
      : 0);
    this.publishCommitted = true;
  }

  install() {
    if (!this.config.enabled || !this.page) return this;
    const mouse = this.page.mouse;
    if (mouse && typeof mouse.click === 'function') {
      const original = mouse.click;
      const wrapped = async (...args) => {
        const result = await original.apply(mouse, args);
        await this.afterAction();
        return result;
      };
      mouse.click = wrapped;
      this.restoreCallbacks.push(() => {
        if (mouse.click === wrapped) mouse.click = original;
      });
    }

    const keyboard = this.page.keyboard;
    if (keyboard && typeof keyboard.sendCharacter === 'function') {
      const original = keyboard.sendCharacter;
      const fastInput = text => original.call(keyboard, text);
      keyboard.__covergemFastInputText = fastInput;
      const wrapped = async text => {
        for (const character of String(text || '')) {
          await original.call(keyboard, character);
          await this.wait(this._duration(
            this.config.typingMinMs,
            this.config.typingMaxMs
          ));
        }
        await this.afterAction();
      };
      keyboard.sendCharacter = wrapped;
      this.restoreCallbacks.push(() => {
        if (keyboard.sendCharacter === wrapped) keyboard.sendCharacter = original;
        if (keyboard.__covergemFastInputText === fastInput) {
          delete keyboard.__covergemFastInputText;
        }
      });
    }
    if (keyboard && typeof keyboard.type === 'function') {
      const original = keyboard.type;
      const wrapped = async (text, options = {}) => {
        const result = await original.call(keyboard, text, {
          ...options,
          delay: this._duration(this.config.typingMinMs, this.config.typingMaxMs),
        });
        await this.afterAction();
        return result;
      };
      keyboard.type = wrapped;
      this.restoreCallbacks.push(() => {
        if (keyboard.type === wrapped) keyboard.type = original;
      });
    }
    return this;
  }

  restore() {
    while (this.restoreCallbacks.length) {
      try { this.restoreCallbacks.pop()(); } catch (_) {}
    }
  }
}

module.exports = {
  DEFAULT_ANTI_BOT,
  DEFAULT_INTERACTION,
  getAntiBotConfig,
  getInteractionConfig,
  performAntiBotWarmup,
  InteractionPacer,
  randomBetween,
};
