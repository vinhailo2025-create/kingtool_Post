const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-agent-data-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
let AgentData;
let AgentJobs;
let DataService;
let mediaPath;
let profile;

test.before(async () => {
  await db.waitReady();
  AgentData = require('../src/services/agent-data.service');
  AgentJobs = require('../src/services/agent-job.service');
  DataService = require('../src/services/data.service');
  AgentJobs.init();

  const inserted = db.prepare(`
    INSERT INTO browsers (name, profile_dir, status)
    VALUES ('Draft profile', 'draft-profile', 'closed')
  `).run();
  profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(inserted.lastInsertRowid);
  db.prepare(`
    INSERT INTO browser_platforms (browser_id, platform, enabled, session_valid)
    VALUES (?, 'facebook', 1, 1)
  `).run(profile.id);
  DataService.ensurePlatformDefaultColumns('facebook');
  DataService.addCustomColumn('Campaign tag', 'text', 'campaign_tag', 'facebook');

  mediaPath = path.join(testRoot, 'draft-image.jpg');
  fs.writeFileSync(mediaPath, 'test image');
});

test('creates one pending row without a job or runner and replays by data_key', () => {
  const payload = {
    data_key: 'draft-single-001',
    platform: 'facebook',
    profile_id: profile.id,
    content: 'Nội dung chờ từ MCP',
    media: [mediaPath],
    fanpage: 'https://www.facebook.com/example.page',
    comments: [{ text: 'Bình luận chờ', media: mediaPath }],
    custom_fields: { campaign_tag: 'launch' },
  };
  const beforeJobs = db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total;
  const created = AgentData.create(payload);

  assert.equal(created.status, 'pending');
  assert.equal(created.data_key, payload.data_key);
  assert.equal(created.profile_id, Number(profile.id));
  assert.equal(created.profile, 'Draft profile');
  assert.equal(created.mapping_ready, true);
  assert.equal(created.target_type, 'fanpage');
  assert.equal(created.target_url, payload.fanpage);
  assert.equal(created.custom_fields.campaign_tag, 'launch');
  assert.equal(created.job_created, false);
  assert.equal(created.runner_started, false);
  assert.equal(created.idempotent_replay, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total, beforeJobs);

  const replay = AgentData.create(payload);
  assert.equal(replay.post_id, created.post_id);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(DataService.getAll('facebook').filter(row => row.agent_data_key === payload.data_key).length, 1);

  assert.throws(
    () => AgentData.create({ ...payload, content: 'Nội dung khác' }),
    error => error.code === 'AGENT_DATA_KEY_CONFLICT'
  );
});

test('creates an atomic pending batch and allows rows without profile mapping', () => {
  const payload = {
    platform: 'facebook',
    items: [
      { data_key: 'draft-batch-001', content: 'Hàng chưa gán profile' },
      {
        data_key: 'draft-batch-002',
        content: 'Hàng đã gán profile',
        profile: 'Draft profile',
        group: 'https://www.facebook.com/groups/123456789',
      },
    ],
  };
  const beforeJobs = db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total;
  const created = AgentData.createBatch(payload);
  assert.equal(created.status, 'pending');
  assert.equal(created.total, 2);
  assert.equal(created.created_count, 2);
  assert.equal(created.replay_count, 0);
  assert.equal(created.job_count, 0);
  assert.equal(created.runner_started, false);
  assert.equal(created.items[0].mapping_ready, false);
  assert.equal(created.items[1].mapping_ready, true);
  assert.equal(created.items[1].target_type, 'group');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total, beforeJobs);

  const replay = AgentData.createBatch(payload);
  assert.equal(replay.created_count, 0);
  assert.equal(replay.replay_count, 2);
  assert.deepEqual(
    replay.items.map(item => item.post_id),
    created.items.map(item => item.post_id)
  );

  const beforeRows = DataService.getAll('facebook').length;
  assert.throws(
    () => AgentData.createBatch({
      platform: 'facebook',
      items: [
        { data_key: 'draft-atomic-valid', content: 'Không được ghi dở' },
        { data_key: 'draft-atomic-invalid', content: 'Profile sai', profile_id: 999999 },
      ],
    }),
    error => error.code === 'AGENT_PROFILE_NOT_FOUND'
  );
  assert.equal(DataService.getAll('facebook').length, beforeRows);
});

test('rejects mixed idempotency batches and managed custom fields', () => {
  const beforeRows = DataService.getAll('facebook').length;
  assert.throws(
    () => AgentData.createBatch({
      platform: 'facebook',
      items: [
        { data_key: 'draft-batch-001', content: 'Hàng chưa gán profile' },
        { data_key: 'draft-new-mixed', content: 'Không được tạo' },
      ],
    }),
    error => error.code === 'AGENT_DATA_BATCH_IDEMPOTENCY_CONFLICT'
  );
  assert.equal(DataService.getAll('facebook').length, beforeRows);

  assert.throws(
    () => AgentData.create({
      data_key: 'draft-managed-field',
      platform: 'facebook',
      content: 'Không hợp lệ',
      custom_fields: { name_profile: 'Draft profile' },
    }),
    error => error.code === 'AGENT_DATA_CUSTOM_FIELD_MANAGED'
  );
});

test.after(() => {
  try { AgentJobs.shutdown(); } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
