const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-agent-schedule-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
let AgentSchedules;
let SchedulerService;
let profile;
let post;

test.before(async () => {
  await db.waitReady();
  const DataService = require('../src/services/data.service');
  require('../src/services/license.service').assertPlatform = platform => ({
    valid: true,
    platforms: [platform],
  });
  SchedulerService = require('../src/services/scheduler.service');
  AgentSchedules = require('../src/services/agent-schedule.service');

  const inserted = db.prepare(`
    INSERT INTO browsers (name, profile_dir, status)
    VALUES ('Schedule profile', 'schedule-profile', 'closed')
  `).run();
  profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(inserted.lastInsertRowid);
  db.prepare(`
    INSERT INTO browser_platforms (browser_id, platform, enabled, session_valid)
    VALUES (?, 'facebook', 1, 1)
  `).run(profile.id);
  post = DataService.create({ content: 'Scheduled post', status: 'pending' }, 'facebook');
  DataService.ensurePlatformDefaultColumns('facebook');
  const nameColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'name_profile');
  DataService.setCustomData(post.id, nameColumn.id, profile.name, 'facebook');

  for (const [key, value] of [
    ['max_concurrency', '4'],
    ['default_delay_min', '12'],
    ['default_delay_max', '34'],
  ]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
});

test('MCP schedule CRUD is durable, idempotent and uses tool settings', () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    schedule_key: 'mcp-schedule-test-001',
    name: 'MCP schedule test',
    platform: 'facebook',
    schedule_type: 'once',
    schedule_time: future,
    profile_ids: [profile.id],
    data_ids: [post.id],
    enabled: false,
  };
  const created = AgentSchedules.create(payload);
  assert.equal(created.idempotent_replay, false);
  assert.equal(created.created_by, 'mcp');
  assert.equal(created.enabled, false);
  assert.deepEqual(created.profile_ids, [profile.id]);
  assert.deepEqual(created.data_ids, [post.id]);

  const stored = db.prepare('SELECT * FROM schedules WHERE id = ?').get(created.schedule_id);
  assert.equal(stored.concurrency, 4);
  assert.equal(stored.delay_min, 12);
  assert.equal(stored.delay_max, 34);

  const replay = AgentSchedules.create(payload);
  assert.equal(replay.schedule_id, created.schedule_id);
  assert.equal(replay.idempotent_replay, true);
  assert.throws(
    () => AgentSchedules.create({ ...payload, name: 'Conflicting retry' }),
    error => error.code === 'AGENT_SCHEDULE_KEY_CONFLICT'
  );

  const updated = AgentSchedules.update(payload.schedule_key, {
    schedule_type: 'daily',
    schedule_time: '08:30',
  });
  assert.equal(updated.schedule_type, 'daily');
  assert.equal(updated.schedule_time, '08:30');
  assert.equal(updated.enabled, false);

  assert.equal(AgentSchedules.setEnabled(payload.schedule_key, true).enabled, true);
  assert.equal(AgentSchedules.setEnabled(payload.schedule_key, true).enabled, true);
  assert.equal(AgentSchedules.setEnabled(payload.schedule_key, false).enabled, false);
  assert.equal(AgentSchedules.list({ platform: 'facebook' }).length, 1);
  assert.equal(AgentSchedules.get(created.schedule_id).schedule_key, payload.schedule_key);

  const removed = AgentSchedules.remove(payload.schedule_key);
  assert.equal(removed.deleted, true);
  assert.equal(AgentSchedules.list({ platform: 'facebook' }).length, 0);
});

test('schedule validation blocks past times, invalid cron and non-pending rows', () => {
  const base = {
    name: 'Invalid schedule',
    platform: 'facebook',
    profile_ids: [profile.id],
    data_ids: [post.id],
    enabled: false,
  };
  assert.throws(
    () => AgentSchedules.create({
      ...base,
      schedule_key: 'invalid-past',
      schedule_type: 'once',
      schedule_time: new Date(Date.now() - 60000).toISOString(),
    }),
    error => error.code === 'AGENT_SCHEDULE_TIME_PAST'
  );
  assert.throws(
    () => AgentSchedules.create({
      ...base,
      schedule_key: 'invalid-cron',
      schedule_type: 'custom',
      cron_expr: 'not a cron',
    }),
    error => error.code === 'AGENT_SCHEDULE_CRON_INVALID'
  );

  db.prepare("UPDATE posts SET status = 'success' WHERE id = ?").run(post.id);
  assert.throws(
    () => AgentSchedules.create({
      ...base,
      schedule_key: 'invalid-finished-row',
      schedule_type: 'daily',
      schedule_time: '09:00',
    }),
    error => error.code === 'AGENT_SCHEDULE_DATA_NOT_PENDING'
  );
});

test('one-time schedules farther than 24 days are re-armed instead of executed early', () => {
  const originalSetTimeout = global.setTimeout;
  const captured = [];
  global.setTimeout = (_callback, delay) => {
    captured.push(delay);
    return { fake: true };
  };
  try {
    const entry = { job: null, timeout: null };
    const started = SchedulerService._startOnceJob({
      id: 999,
      name: 'Long wait',
      schedule_time: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString(),
    }, entry);
    assert.equal(started, true);
    assert.equal(captured.length, 1);
    assert.ok(captured[0] > 0);
    assert.ok(captured[0] <= 2147483647);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test.after(() => {
  try { SchedulerService.stopAllJobs(); } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
