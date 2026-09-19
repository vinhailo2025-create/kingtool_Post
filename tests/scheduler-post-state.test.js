const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-scheduled-state-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
let DataService;
let SchedulerService;
let RunnerManager;
let RunnerService;

test.before(async () => {
  await db.waitReady();
  DataService = require('../src/services/data.service');
  SchedulerService = require('../src/services/scheduler.service');
  RunnerManager = require('../src/services/runner-manager.service');
  ({ RunnerService } = require('../src/services/runner.service'));
});

function customValue(postId, platform, varKey) {
  return db.prepare(`
    SELECT pcd.value
    FROM post_custom_data pcd
    JOIN custom_columns cc ON cc.id = pcd.column_id
    WHERE pcd.post_id = ? AND cc.platform = ? AND cc.var_key = ?
  `).get(postId, platform, varKey)?.value || '';
}

function postState(postId, platform) {
  return db.prepare('SELECT * FROM posts WHERE id = ? AND platform = ?').get(postId, platform);
}

test('scheduled rows keep planned time, become pending at due time, and edits resync the time', async () => {
  DataService.ensurePlatformDefaultColumns('facebook');
  const post = DataService.create({ content: 'scheduled post', status: 'pending' }, 'facebook');
  const firstTime = '2026-10-20T08:30';
  const secondTime = '2026-10-21T09:45';
  const schedule = SchedulerService.create({
    name: 'Scheduled state',
    platform: 'facebook',
    schedule_type: 'once',
    schedule_time: firstTime,
    profile_ids: [1],
    data_ids: [post.id],
  });

  assert.equal(postState(post.id, 'facebook').status, 'scheduled');
  assert.equal(customValue(post.id, 'facebook', 'time_post'), '20/10/2026 08:30');

  SchedulerService.update(schedule.id, { schedule_time: secondTime }, 'facebook');
  assert.equal(postState(post.id, 'facebook').status, 'scheduled');
  assert.equal(customValue(post.id, 'facebook', 'time_post'), '21/10/2026 09:45');

  const originalGet = RunnerManager.get;
  let statusSeenByRunner = '';
  RunnerManager.get = () => ({
    isRunning: false,
    start: async () => {
      statusSeenByRunner = postState(post.id, 'facebook').status;
      return { success: true };
    },
  });
  try {
    await SchedulerService._executeJob(SchedulerService.getById(schedule.id));
  } finally {
    RunnerManager.get = originalGet;
  }

  assert.equal(statusSeenByRunner, 'pending');
  assert.equal(postState(post.id, 'facebook').status, 'pending');
  assert.equal(customValue(post.id, 'facebook', 'time_post'), '21/10/2026 09:45');
});

test('disabling a schedule restores pending and clears planned time', async () => {
  const post = DataService.create({ content: 'toggle schedule', status: 'pending' }, 'facebook');
  const schedule = SchedulerService.create({
    name: 'Toggle state',
    platform: 'facebook',
    schedule_type: 'once',
    schedule_time: '2026-11-20T10:15',
    profile_ids: [1],
    data_ids: [post.id],
  });
  assert.equal(postState(post.id, 'facebook').status, 'scheduled');

  SchedulerService.toggle(schedule.id, 'facebook');
  assert.equal(postState(post.id, 'facebook').status, 'pending');
  assert.equal(customValue(post.id, 'facebook', 'time_post'), '');
});

test('runner writes running state and replaces planned time with actual publish time', async () => {
  DataService.ensurePlatformDefaultColumns('youtube');
  const post = DataService.create({ content: 'publish state', status: 'pending' }, 'youtube');
  const timeColumn = DataService.getCustomColumns('youtube').find(column => column.var_key === 'time_post');
  DataService.setCustomData(post.id, timeColumn.id, '22/10/2026 11:00', 'youtube');

  const runner = new RunnerService('youtube');
  runner._markPostRunning(post);
  assert.equal(postState(post.id, 'youtube').status, 'running');
  assert.equal(customValue(post.id, 'youtube', 'time_post'), '22/10/2026 11:00');

  await runner._finalizePublishedPost(
    { id: 1, name: 'profile-test' },
    post,
    {
      postedAt: '22/10/2026 11:03:12',
      postLink: 'https://www.youtube.com/watch?v=test',
    }
  );
  assert.equal(postState(post.id, 'youtube').status, 'success');
  assert.equal(customValue(post.id, 'youtube', 'time_post'), '22/10/2026 11:03:12');
});

test.after(() => {
  try { SchedulerService.stopAllJobs(); } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
