const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-agent-conflicts-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const LicenseService = require('../src/services/license.service');
LicenseService.assertPlatform = platform => ({ valid: true, platforms: [platform] });
const RunnerManager = require('../src/services/runner-manager.service');
const DataService = require('../src/services/data.service');
const AgentData = require('../src/services/agent-data.service');
const AgentJobs = require('../src/services/agent-job.service');
const AgentSchedules = require('../src/services/agent-schedule.service');

let firstProfile;
let secondProfile;
let campaignColumn;
let SchedulerService;

function addProfile(name, directory) {
  const inserted = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'closed')"
  ).run(name, directory);
  db.prepare(`
    INSERT INTO browser_platforms (browser_id, platform, enabled, session_valid)
    VALUES (?, 'facebook', 1, 1)
  `).run(inserted.lastInsertRowid);
  return db.prepare('SELECT * FROM browsers WHERE id = ?').get(inserted.lastInsertRowid);
}

function futureIso(minutes = 60) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

test.before(async () => {
  await db.waitReady();
  SchedulerService = require('../src/services/scheduler.service');
  AgentJobs.init();
  firstProfile = addProfile('Conflict Profile A', 'conflict-profile-a');
  secondProfile = addProfile('Conflict Profile B', 'conflict-profile-b');
  DataService.ensurePlatformDefaultColumns('facebook');
  campaignColumn = DataService.addCustomColumn(
    'Campaign tag',
    'text',
    'campaign_tag',
    'facebook'
  );
  RunnerManager.get('facebook').isRunning = true;
});

test('invalid pending batch leaves group and comment schema unchanged', () => {
  const before = new Set(
    DataService.getCustomColumns('facebook').map(column => column.var_key)
  );
  assert.equal(before.has('post_group'), false);
  assert.equal(before.has('comment_2'), false);

  assert.throws(
    () => AgentData.createBatch({
      platform: 'facebook',
      items: [
        {
          data_key: 'invalid-schema-row-1',
          content: 'Valid first row',
          group: 'https://www.facebook.com/groups/123456',
          comments: ['First', 'Second'],
        },
        {
          data_key: 'invalid-schema-row-2',
          content: 'Invalid profile',
          profile_id: 999999,
        },
      ],
    }),
    error => error.code === 'AGENT_PROFILE_NOT_FOUND'
  );

  const after = new Set(
    DataService.getCustomColumns('facebook').map(column => column.var_key)
  );
  assert.equal(after.has('post_group'), false);
  assert.equal(after.has('comment_2'), false);
});

test('publishes existing pending rows without duplicating posts', () => {
  const single = AgentData.create({
    data_key: 'publish-existing-single',
    platform: 'facebook',
    profile_id: firstProfile.id,
    content: 'Existing single row',
  });
  const beforePosts = DataService.getCount('facebook');
  const firstJob = AgentJobs.createDataJob({
    platform: 'facebook',
    post_id: single.post_id,
    request_id: 'publish-existing-single-request',
  });
  assert.equal(firstJob.post_id, single.post_id);
  assert.equal(firstJob.status, 'queued');
  assert.equal(DataService.getCount('facebook'), beforePosts);

  const replay = AgentJobs.createDataJob({
    platform: 'facebook',
    post_id: single.post_id,
    request_id: 'publish-existing-single-request',
  });
  assert.equal(replay.job_id, firstJob.job_id);
  assert.throws(
    () => AgentJobs.createDataJob({
      platform: 'facebook',
      post_id: single.post_id,
      request_id: 'publish-existing-single-second-request',
    }),
    error => error.code === 'AGENT_POST_JOB_ACTIVE'
  );

  const drafts = AgentData.createBatch({
    platform: 'facebook',
    items: [
      {
        data_key: 'publish-existing-batch-a',
        profile_id: firstProfile.id,
        content: 'Existing batch A',
      },
      {
        data_key: 'publish-existing-batch-b',
        profile_id: secondProfile.id,
        content: 'Existing batch B',
      },
    ],
  });
  const beforeBatchPosts = DataService.getCount('facebook');
  const payload = {
    platform: 'facebook',
    batch_key: 'publish-existing-batch-key',
    items: drafts.items.map((item, index) => ({
      item_key: `existing-${index + 1}`,
      post_id: item.post_id,
    })),
  };
  const batch = AgentJobs.createDataBatch(payload);
  assert.equal(batch.total, 2);
  assert.deepEqual(
    batch.jobs.map(job => job.post_id),
    drafts.items.map(item => item.post_id)
  );
  assert.equal(DataService.getCount('facebook'), beforeBatchPosts);
  const batchReplay = AgentJobs.createDataBatch(payload);
  assert.equal(batchReplay.batch_id, batch.batch_id);
  assert.deepEqual(
    batchReplay.jobs.map(job => job.job_id),
    batch.jobs.map(job => job.job_id)
  );
});

test('edits invalidate create-data replay metadata and schema routes stay accurate', () => {
  const builtinEdit = {
    data_key: 'stale-builtin-payload',
    platform: 'facebook',
    profile_id: firstProfile.id,
    content: 'Original content',
  };
  const builtinRow = AgentData.create(builtinEdit);
  DataService.update(builtinRow.post_id, { content: 'Original content' }, 'facebook');
  assert.ok(
    db.prepare('SELECT agent_payload_json FROM posts WHERE id = ?').get(builtinRow.post_id)
      .agent_payload_json
  );
  const linkPostColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'link_post');
  DataService.setCustomData(
    builtinRow.post_id,
    linkPostColumn.id,
    'https://www.facebook.com/example/posts/result',
    'facebook'
  );
  assert.ok(
    db.prepare('SELECT agent_payload_json FROM posts WHERE id = ?').get(builtinRow.post_id)
      .agent_payload_json
  );
  DataService.update(builtinRow.post_id, { content: 'Edited content' }, 'facebook');
  assert.equal(
    db.prepare('SELECT agent_payload_json FROM posts WHERE id = ?').get(builtinRow.post_id)
      .agent_payload_json,
    null
  );
  assert.throws(
    () => AgentData.create(builtinEdit),
    error => error.code === 'AGENT_DATA_KEY_CONFLICT'
  );

  const customEdit = {
    data_key: 'stale-custom-payload',
    platform: 'facebook',
    profile_id: firstProfile.id,
    content: 'Custom field row',
  };
  const customRow = AgentData.create(customEdit);
  DataService.setCustomData(
    customRow.post_id,
    campaignColumn.id,
    'changed',
    'facebook'
  );
  assert.throws(
    () => AgentData.create(customEdit),
    error => error.code === 'AGENT_DATA_KEY_CONFLICT'
  );

  const mappingEdit = {
    data_key: 'stale-profile-payload',
    platform: 'facebook',
    profile_id: firstProfile.id,
    content: 'Profile mapping row',
  };
  const mappingRow = AgentData.create(mappingEdit);
  AgentJobs.assignProfiles({
    platform: 'facebook',
    assignments: [{ post_id: mappingRow.post_id, profile_id: firstProfile.id }],
  });
  assert.ok(
    db.prepare('SELECT agent_payload_json FROM posts WHERE id = ?').get(mappingRow.post_id)
      .agent_payload_json
  );
  AgentJobs.assignProfiles({
    platform: 'facebook',
    assignments: [{ post_id: mappingRow.post_id, profile_id: secondProfile.id }],
  });
  assert.throws(
    () => AgentData.create(mappingEdit),
    error => error.code === 'AGENT_DATA_KEY_CONFLICT'
  );

  DataService.ensureCommentGroup(1, 'facebook');
  const facebookSchema = AgentJobs.getDataSchema('facebook');
  const facebookFields = new Map(
    facebookSchema.custom_fields.map(field => [field.key, field.writable_via])
  );
  assert.equal(facebookFields.get('name_profile'), 'profile/profile_id');
  assert.equal(facebookFields.get('link_fanpage'), 'fanpage');
  assert.equal(facebookFields.get('link_post'), 'read_only');
  assert.equal(facebookFields.get('comment'), 'comments');
  assert.equal(facebookFields.get('comment_status'), 'read_only');
  assert.equal(facebookFields.get('campaign_tag'), 'custom_fields');

  const youtubeSchema = AgentJobs.getDataSchema('youtube');
  const youtubeFields = new Map(
    youtubeSchema.custom_fields.map(field => [field.key, field.writable_via])
  );
  assert.equal(youtubeFields.get('description'), 'description');
  assert.equal(youtubeFields.get('channel_name'), 'channel/channel_name');
  assert.equal(youtubeFields.get('thumbnail'), 'thumbnail');
  assert.throws(
    () => AgentData.create({
      data_key: 'managed-youtube-description',
      platform: 'youtube',
      content: 'Invalid custom route',
      custom_fields: { description: 'Must use description' },
    }),
    error => error.code === 'AGENT_DATA_CUSTOM_FIELD_MANAGED'
  );
});

test('schedule rejects unmapped or mismatched rows and treats runner refusal as error', async () => {
  const unmapped = DataService.create(
    { content: 'Unmapped scheduled row', status: 'pending' },
    'facebook'
  );
  assert.throws(
    () => AgentSchedules.create({
      schedule_key: 'schedule-unmapped-row',
      name: 'Unmapped row',
      platform: 'facebook',
      schedule_type: 'once',
      schedule_time: futureIso(),
      profile_ids: [firstProfile.id],
      data_ids: [unmapped.id],
      enabled: false,
    }),
    error => error.code === 'AGENT_SCHEDULE_DATA_PROFILE_REQUIRED'
  );

  const mismatched = AgentData.create({
    data_key: 'schedule-mismatched-row',
    platform: 'facebook',
    profile_id: firstProfile.id,
    content: 'Mismatched scheduled row',
  });
  assert.throws(
    () => AgentSchedules.create({
      schedule_key: 'schedule-mismatched-profile',
      name: 'Mismatched profile',
      platform: 'facebook',
      schedule_type: 'once',
      schedule_time: futureIso(),
      profile_ids: [secondProfile.id],
      data_ids: [mismatched.post_id],
      enabled: false,
    }),
    error => error.code === 'AGENT_SCHEDULE_DATA_PROFILE_MISMATCH'
  );

  const executable = AgentData.create({
    data_key: 'schedule-runner-refusal-row',
    platform: 'facebook',
    profile_id: secondProfile.id,
    content: 'Runner refusal row',
  });
  const schedule = SchedulerService.create({
    name: 'Runner refusal',
    schedule_time: futureIso(),
    schedule_type: 'once',
    profile_ids: [secondProfile.id],
    data_ids: [executable.post_id],
    platform: 'facebook',
    enabled: false,
  });
  const runner = RunnerManager.get('facebook');
  const originalStart = runner.start;
  // Runner ranh nhung tu choi start -> lich phai bao loi (runner ban thi lich doi, xem test rieng).
  runner.isRunning = false;
  runner.start = async () => ({ success: false, message: 'Runner is busy' });
  const succeeded = await SchedulerService._executeJob(schedule);
  runner.start = originalStart;
  runner.isRunning = true;
  assert.equal(succeeded, false);
  assert.equal(SchedulerService.getById(schedule.id).status, 'error');
});

test('lịch đến giờ khi runner bận thì xếp hàng đợi rồi chạy, không báo lỗi', async () => {
  const row = AgentData.create({
    data_key: 'schedule-wait-for-runner-row',
    platform: 'facebook',
    profile_id: secondProfile.id,
    content: 'Wait for busy runner',
  });
  const schedule = SchedulerService.create({
    name: 'Wait for runner',
    schedule_time: futureIso(),
    schedule_type: 'once',
    profile_ids: [secondProfile.id],
    data_ids: [row.post_id],
    platform: 'facebook',
    enabled: false,
  });
  const runner = RunnerManager.get('facebook');
  const originalStart = runner.start;
  const originalWait = SchedulerService._waitForRunner;
  const started = [];
  runner.start = async config => { started.push(config.dataIds); return { success: true }; };
  SchedulerService._waitForRunner = (entry, target) => originalWait.call(SchedulerService, entry, target, { pollMs: 50 });
  runner.isRunning = true;
  const pending = SchedulerService._executeJob(schedule);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(started, []);
  runner.isRunning = false;
  const succeeded = await pending;
  runner.start = originalStart;
  SchedulerService._waitForRunner = originalWait;
  runner.isRunning = true;
  assert.equal(succeeded, true);
  assert.deepEqual(started, [[row.post_id]]);
  const waitLog = db.prepare(
    "SELECT status, message FROM activity_logs WHERE type = 'schedule' ORDER BY id"
  ).all();
  assert.ok(waitLog.some(log => log.status === 'warning' && /đang bận/.test(log.message)));
  assert.ok(waitLog.some(log => log.status === 'info' && /đã rảnh/.test(log.message)));
});

test('enabled all_pending schedules require explicit create and assignment opt-in', () => {
  const schedule = AgentSchedules.create({
    schedule_key: 'active-all-pending-profile-a',
    name: 'Active all pending',
    platform: 'facebook',
    schedule_type: 'once',
    schedule_time: futureIso(120),
    profile_ids: [firstProfile.id],
    all_pending: true,
    enabled: true,
  });
  assert.equal(schedule.all_pending, true);

  const guarded = {
    data_key: 'guarded-create-data',
    platform: 'facebook',
    profile_id: firstProfile.id,
    content: 'Guarded data',
  };
  assert.throws(
    () => AgentData.create(guarded),
    error => error.code === 'AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE'
  );
  const authorized = AgentData.create({
    ...guarded,
    allow_scheduled_consumption: true,
  });
  assert.equal(authorized.scheduled_consumption_authorized, true);
  assert.equal(authorized.matching_schedules[0].schedule_id, schedule.schedule_id);

  const unmapped = AgentData.create({
    data_key: 'guarded-assignment-data',
    platform: 'facebook',
    content: 'Assign later',
  });
  assert.throws(
    () => AgentJobs.assignProfiles({
      platform: 'facebook',
      assignments: [{ post_id: unmapped.post_id, profile_id: firstProfile.id }],
    }),
    error => error.code === 'AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE'
  );
  const assignment = AgentJobs.assignProfiles({
    platform: 'facebook',
    allow_scheduled_consumption: true,
    assignments: [{ post_id: unmapped.post_id, profile_id: firstProfile.id }],
  });
  assert.equal(assignment.scheduled_consumption_authorized, true);
  assert.equal(assignment.matching_schedules[0].schedule_id, schedule.schedule_id);
  AgentSchedules.setEnabled(schedule.schedule_id, false);
});

test.after(() => {
  try { SchedulerService.stopAll(); } catch (_) {}
  try { AgentJobs.shutdown(); } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
