const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-agent-api-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const LicenseService = require('../src/services/license.service');
LicenseService.assertPlatform = platform => ({ valid: true, platforms: [platform] });
const RunnerManager = require('../src/services/runner-manager.service');
const AgentAuth = require('../src/services/agent-auth.service');
const AgentJobs = require('../src/services/agent-job.service');
const DataService = require('../src/services/data.service');
const PublishGroups = require('../src/services/publish-group.service');
const PublishCampaigns = require('../src/services/publish-campaign.service');
const AgentRoutes = require('../src/routes/agent.routes');

test('lọc target không biến profile_ids rỗng thành profile 0', () => {
  assert.deepEqual(AgentRoutes._private.parseProfileIds(undefined), []);
  assert.deepEqual(AgentRoutes._private.parseProfileIds(''), []);
  assert.deepEqual(AgentRoutes._private.parseProfileIds(' 2, 7, ,0,bad '), [2, 7]);
});

test('Agent API tạo job từ dữ liệu agent và trả kết quả của tool', async () => {
  await db.waitReady();
  AgentJobs.init();
  const profileResult = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'closed')"
  ).run('Profile Agent 01', 'profile-agent-01');
  db.prepare(`
    INSERT INTO browser_platforms (browser_id, platform, enabled, session_valid)
    VALUES (?, 'facebook', 1, 1)
  `).run(profileResult.lastInsertRowid);

  // Keep the real browser runner idle but unavailable; this verifies queue/data
  // behavior without opening a browser in the test suite.
  const runner = RunnerManager.get('facebook');
  runner.isRunning = true;
  const job = AgentJobs.createJob({
    request_id: 'agent-test-001',
    platform: 'facebook',
    profile: 'Profile Agent 01',
    content: 'Nội dung từ agent',
  });
  assert.equal(job.status, 'queued');
  assert.equal(job.profile, 'Profile Agent 01');

  const duplicate = AgentJobs.createJob({
    request_id: 'agent-test-001',
    platform: 'facebook',
    profile: 'Profile Agent 01',
    content: 'Không được tạo hàng thứ hai',
  });
  assert.equal(duplicate.job_id, job.job_id);
  assert.equal(DataService.getAllWithCustomData('facebook').length, 1);

  const post = DataService.getAllWithCustomData('facebook')[0];
  const columns = new Map(DataService.getCustomColumns('facebook').map(col => [col.var_key, col]));
  assert.equal(post.content, 'Nội dung từ agent');
  assert.equal(post[`custom_${columns.get('name_profile').id}`], 'Profile Agent 01');

  DataService.update(post.id, {
    status: 'success',
    link: 'https://www.facebook.com/test/posts/agent-001',
    note: 'Đăng thành công',
  }, 'facebook');
  DataService.setCustomData(
    post.id,
    columns.get('link_post').id,
    'https://www.facebook.com/test/posts/agent-001',
    'facebook'
  );
  DataService.setCustomData(post.id, columns.get('time_post').id, '01/09/2026 15:30', 'facebook');

  const completed = AgentJobs.getJob(job.job_id);
  assert.equal(completed.status, 'success');
  assert.equal(completed.result.link_post, 'https://www.facebook.com/test/posts/agent-001');
  assert.equal(completed.result.time_post, '01/09/2026 15:30');
  runner.isRunning = false;
});

test('Agent API key được sinh và so sánh an toàn', async () => {
  await db.waitReady();
  const key = AgentAuth.ensureKey();
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(AgentAuth._private.equalKey(key, key), true);
  assert.equal(AgentAuth._private.equalKey(key, `${key}x`), false);
  assert.equal(fs.readFileSync(AgentAuth.keyPath(), 'utf8').trim(), key);

  fs.writeFileSync(AgentAuth.keyPath(), 'corrupt-key\n');
  const repaired = AgentAuth.ensureKey();
  assert.match(repaired, /^[a-f0-9]{64}$/);
  assert.notEqual(repaired, 'corrupt-key');
  assert.equal(fs.readFileSync(AgentAuth.keyPath(), 'utf8').trim(), repaired);
});

test('Agent batch giữ mapping từng hàng và lấy đa luồng/delay từ cài đặt tool', async () => {
  await db.waitReady();
  const second = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'closed')"
  ).run('Profile Agent 02', 'profile-agent-02');
  db.prepare(`
    INSERT INTO browser_platforms (browser_id, platform, enabled, session_valid)
    VALUES (?, 'facebook', 1, 1)
  `).run(second.lastInsertRowid);

  for (const [key, value] of [
    ['max_concurrency', '4'],
    ['default_delay_min', '11'],
    ['default_delay_max', '22'],
    ['default_profile_delay_min', '3'],
    ['default_profile_delay_max', '7'],
  ]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  const runner = RunnerManager.get('facebook');
  runner.isRunning = true;
  const batch = AgentJobs.createBatch({
    platform: 'facebook',
    concurrency: 9,
    delay_min: 0,
    items: [
      {
        request_id: 'agent-batch-001-profile-01',
        profile: 'Profile Agent 01',
        content: 'Bài batch cho profile 01',
      },
      {
        request_id: 'agent-batch-001-profile-02',
        profile: 'Profile Agent 02',
        content: 'Bài batch cho profile 02',
      },
    ],
  });

  assert.match(batch.batch_id, /^batch_/);
  assert.equal(batch.status, 'queued');
  assert.equal(batch.jobs.length, 2);
  assert.deepEqual(batch.jobs.map(job => job.profile), ['Profile Agent 01', 'Profile Agent 02']);
  assert.ok(batch.jobs.every(job => job.batch_id === batch.batch_id));

  const duplicate = AgentJobs.createBatch({
    platform: 'facebook',
    items: [
      { request_id: 'agent-batch-001-profile-01', profile: 'Profile Agent 01', content: 'ignored' },
      { request_id: 'agent-batch-001-profile-02', profile: 'Profile Agent 02', content: 'ignored' },
    ],
  });
  assert.equal(duplicate.batch_id, batch.batch_id);
  assert.equal(duplicate.jobs.length, 2);

  const runtime = AgentJobs.getRuntimeConfig('facebook');
  assert.equal(runtime.agent_override_allowed, false);
  assert.deepEqual(runtime.runner, {
    concurrency: 4,
    delay_min: 11,
    delay_max: 22,
    profile_delay_min: 3,
    profile_delay_max: 7,
    max_posts_per_profile: 0,
  });
  assert.deepEqual(runtime.queue_policy, {
    queued_jobs_auto_resume: true,
    max_posts_per_profile_scope: 'per_runner_pass',
    next_pass_delay_source: 'runner.delay_min_to_delay_max',
    queued_means_blocked: false,
  });
  const schema = AgentJobs.getDataSchema('facebook');
  assert.ok(schema.custom_fields.some(field => field.key === 'link_fanpage'));
  assert.ok(schema.custom_fields.some(field => field.key === 'name_profile'));

  const rows = db.prepare('SELECT * FROM agent_jobs WHERE batch_id = ? ORDER BY id').all(batch.batch_id);
  const originalStart = runner.start;
  let capturedConfig = null;
  runner.isRunning = false;
  runner.start = config => {
    capturedConfig = config;
    runner.isRunning = true;
    runner.progress = { total: rows.length, completed: 0, errors: 0 };
    return new Promise(resolve => setTimeout(() => {
      for (const row of rows) {
        DataService.update(row.post_id, {
          status: 'success',
          link: `https://www.facebook.com/test/posts/${row.post_id}`,
          note: 'Đăng batch thành công',
        }, 'facebook');
      }
      runner.progress = { total: rows.length, completed: rows.length, errors: 0 };
      runner.isRunning = false;
      resolve({ success: true });
    }, 10));
  };
  await AgentJobs._private.startBatch(rows);
  runner.start = originalStart;
  assert.equal(capturedConfig.concurrency, 4);
  assert.equal(capturedConfig.delayMin, 11);
  assert.equal(capturedConfig.delayMax, 22);
  assert.equal(capturedConfig.profileDelayMin, 3);
  assert.equal(capturedConfig.profileDelayMax, 7);
  assert.equal(capturedConfig.profileIds.length, 2);
  assert.equal(capturedConfig.dataIds.length, 2);
  assert.equal(AgentJobs.getBatch(batch.batch_id).status, 'success');
  runner.isRunning = false;
});

test('MCP bridge khai báo đủ tool gửi bài và nhận kết quả', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'super-post-mcp-server.js'),
    'utf8'
  );
  assert.match(source, /super_post_publish/);
  assert.match(source, /super_post_publish_batch/);
  assert.match(source, /super_post_get_runtime_config/);
  assert.match(source, /super_post_get_data_schema/);
  assert.match(source, /super_post_get_capabilities/);
  assert.match(source, /super_post_get_job/);
  assert.match(source, /super_post_list_profile_groups/);
  assert.match(source, /super_post_list_targets/);
  assert.match(source, /super_post_list_platform_data/);
  assert.match(source, /super_post_create_data/);
  assert.match(source, /super_post_create_data_batch/);
  assert.match(source, /super_post_publish_data/);
  assert.match(source, /super_post_publish_data_batch/);
  assert.match(source, /super_post_assign_profiles/);
  assert.match(source, /super_post_list_publish_groups/);
  assert.match(source, /super_post_get_publish_group/);
  assert.match(source, /super_post_create_publish_group/);
  assert.match(source, /super_post_update_publish_group/);
  assert.match(source, /super_post_delete_publish_group/);
  assert.match(source, /super_post_publish_group/);
  assert.match(source, /super_post_list_publish_campaigns/);
  assert.match(source, /super_post_get_publish_campaign/);
  assert.match(source, /super_post_create_publish_campaign/);
  assert.match(source, /super_post_update_publish_campaign/);
  assert.match(source, /super_post_delete_publish_campaign/);
  assert.match(source, /super_post_publish_campaign/);
  assert.match(source, /wait_seconds/);
  assert.match(source, /link_post/);
});

test('Agent mapper đọc dữ liệu và đổi profile mà không tạo job đăng', async () => {
  await db.waitReady();
  const beforeJobs = db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total;
  const post = DataService.create({
    content: 'Hàng dữ liệu chỉ dùng để đổi mapping',
    status: 'pending',
  }, 'facebook');

  const result = AgentJobs.assignProfiles({
    platform: 'facebook',
    assignments: [{ post_id: post.id, profile: 'Profile Agent 02' }],
  });
  assert.equal(result.updated, 1);
  assert.equal(result.assignments[0].profile, 'Profile Agent 02');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total, beforeJobs);

  const data = AgentJobs.listPlatformData({ platform: 'facebook', status: 'pending', limit: 1000 });
  const mapped = data.find(item => item.id === Number(post.id));
  assert.ok(mapped);
  assert.equal(mapped.custom_fields.name_profile, 'Profile Agent 02');

  const groups = AgentJobs.listProfileGroups('facebook');
  assert.ok(Array.isArray(groups));
  const targets = AgentJobs.listTargets('facebook', []);
  assert.equal(targets.platform, 'facebook');
  assert.ok(Array.isArray(targets.managed_targets));
  assert.ok(Array.isArray(targets.saved_groups));
});

test('Nhóm đăng lưu được nhiều profile, Fanpage và Facebook Group mà không tạo job', async () => {
  await db.waitReady();
  const beforeJobs = db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total;
  const first = db.prepare("SELECT id FROM browsers WHERE name = 'Profile Agent 01'").get();
  const second = db.prepare("SELECT id FROM browsers WHERE name = 'Profile Agent 02'").get();
  const created = PublishGroups.create({
    group_key: 'sales-team-01',
    name: 'Nhóm bán hàng 01',
    platform: 'facebook',
    members: [
      { target_type: 'profile', profile_id: first.id },
      { target_type: 'profile', profile_id: second.id },
      { target_type: 'fanpage', profile_id: first.id, target_url: 'https://www.facebook.com/page-a' },
      { target_type: 'group', profile_id: first.id, target_url: 'https://www.facebook.com/groups/group-a' },
      { target_type: 'group', profile_id: first.id, target_url: 'https://www.facebook.com/groups/group-b' },
    ],
  });
  assert.equal(created.member_count, 5);
  assert.deepEqual(created.members.map(member => member.target_type), [
    'profile', 'profile', 'fanpage', 'group', 'group',
  ]);
  assert.equal(PublishGroups.get('sales-team-01').id, created.id);
  assert.equal(PublishGroups.get('Nhóm bán hàng 01', 'facebook').group_key, 'sales-team-01');
  assert.equal(PublishGroups.list({ platform: 'facebook' }).some(group => group.id === created.id), true);

  const updated = PublishGroups.update('sales-team-01', {
    name: 'Nhóm bán hàng chính',
    members: [
      { target_type: 'profile', profile_id: first.id },
      { target_type: 'fanpage', profile_id: first.id, target_url: 'https://www.facebook.com/page-a' },
    ],
  });
  assert.equal(updated.name, 'Nhóm bán hàng chính');
  assert.equal(updated.member_count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total, beforeJobs);

  const deleted = PublishGroups.remove(created.id);
  assert.equal(deleted.deleted, true);
  assert.throws(() => PublishGroups.get(created.id), error => error.code === 'PUBLISH_GROUP_NOT_FOUND');
});

test('Chiến dịch đăng lưu nhiều Nhóm đăng thuộc nhiều nền tảng mà không tạo job', async () => {
  await db.waitReady();
  const beforeJobs = db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total;
  const first = db.prepare("SELECT id FROM browsers WHERE name = 'Profile Agent 01'").get();
  db.prepare(`
    INSERT OR REPLACE INTO browser_platforms (browser_id, platform, enabled, session_valid)
    VALUES (?, 'tiktok', 1, 1)
  `).run(first.id);
  const facebook = PublishGroups.create({
    group_key: 'campaign-facebook-01',
    name: 'Nhóm Facebook cho chiến dịch',
    platform: 'facebook',
    members: [{ target_type: 'profile', profile_id: first.id }],
  });
  const tiktok = PublishGroups.create({
    group_key: 'campaign-tiktok-01',
    name: 'Nhóm TikTok cho chiến dịch',
    platform: 'tiktok',
    members: [{ target_type: 'default', profile_id: first.id }],
  });

  const created = PublishCampaigns.create({
    campaign_key: 'launch-all-platforms-01',
    name: 'Ra mắt đa nền tảng',
    publish_groups: [
      { identifier: facebook.group_key, platform: 'facebook' },
      { identifier: tiktok.group_key, platform: 'tiktok' },
    ],
  });
  assert.equal(created.group_count, 2);
  assert.deepEqual(created.platforms, ['facebook', 'tiktok']);
  assert.equal(PublishCampaigns.get('launch-all-platforms-01').id, created.id);
  assert.equal(PublishCampaigns.list().some(campaign => campaign.id === created.id), true);

  const updated = PublishCampaigns.update(created.id, { name: 'Ra mắt toàn kênh' });
  assert.equal(updated.name, 'Ra mắt toàn kênh');
  assert.equal(updated.group_count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM agent_jobs').get().total, beforeJobs);

  assert.equal(PublishCampaigns.remove(created.id).deleted, true);
  assert.throws(() => PublishCampaigns.get(created.id), error => error.code === 'PUBLISH_CAMPAIGN_NOT_FOUND');
  assert.equal(PublishGroups.get(facebook.id).group_key, facebook.group_key);
  PublishGroups.remove(facebook.id);
  PublishGroups.remove(tiktok.id);
});

test.after(() => {
  AgentJobs.shutdown();
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
