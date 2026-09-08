const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-link-recovery-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;
process.env.FB_VIDEO_LINK_RECOVERY_INITIAL_MS = '600000';
process.env.FB_GROUP_LINK_RECOVERY_INITIAL_MS = '600000';
process.env.FB_GROUP_LINK_RECOVERY_MAX_ATTEMPTS = '2';
process.env.FB_GROUP_LINK_RECOVERY_MAX_AGE_MS = '86400000';

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const AgentJobs = require('../src/services/agent-job.service');
const PostLinkRecoveryService = require('../src/services/post-link-recovery.service');

let profile;

test.before(async () => {
  await db.waitReady();
  DataService.ensurePlatformDefaultColumns('facebook');
  const inserted = db.prepare(`
    INSERT INTO browsers (name, profile_dir, status)
    VALUES ('Recovery profile', 'recovery-profile', 'closed')
  `).run();
  profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(inserted.lastInsertRowid);
});

test('durable recovery survives app restart without republishing', () => {
  const post = DataService.create({
    content: 'Persistent delayed Reel',
    image_path: 'C:\\media\\persistent.mp4',
    status: 'success',
  }, 'facebook');
  const agentJobId = 'job_restart_link_pending';
  db.prepare(`
    INSERT INTO agent_jobs (
      job_id, platform, profile_id, profile_name, post_id, status,
      payload_json, result_json, completed_at, created_at, updated_at
    ) VALUES (?, 'facebook', ?, ?, ?, 'success', '{}', '{}', CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(agentJobId, profile.id, profile.name, post.id);
  const scheduled = PostLinkRecoveryService.schedule({
    postId: post.id,
    profileId: profile.id,
    targetType: 'profile',
    targetUrl: 'https://www.facebook.com/me',
    postContent: post.content,
    hasVideo: true,
  });
  db.prepare(`
    UPDATE post_link_recovery_jobs SET status = 'running' WHERE id = ?
  `).run(scheduled.id);
  db.prepare(`
    UPDATE agent_jobs SET status = 'success', completed_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run(agentJobId);

  PostLinkRecoveryService.init();
  const restored = PostLinkRecoveryService.getByPost(post.id);
  const restoredAgent = db.prepare(
    'SELECT status, completed_at, result_json FROM agent_jobs WHERE job_id = ?'
  ).get(agentJobId);
  assert.equal(restored.status, 'waiting');
  assert.equal(restored.post_content, post.content);
  assert.equal(restoredAgent.status, 'running');
  assert.equal(restoredAgent.completed_at, null);
  assert.equal(JSON.parse(restoredAgent.result_json).link_pending, true);
  assert.match(PostLinkRecoveryService._recover.toString(), /findTimelinePost/);
  assert.doesNotMatch(PostLinkRecoveryService._recover.toString(), /\.publish\s*\(/);
});

test('video-only recovery keeps the ten-link snapshot without requiring a caption', () => {
  const post = DataService.create({
    content: '',
    image_path: 'C:\\media\\video-only.mp4',
    status: 'success',
  }, 'facebook');
  const snapshot = {
    ready: true,
    libraryUrl: 'https://www.facebook.com/example/reels/',
    items: [
      { key: 'video:100', url: 'https://www.facebook.com/reel/100' },
    ],
  };
  const scheduled = PostLinkRecoveryService.schedule({
    postId: post.id,
    profileId: profile.id,
    targetType: 'profile',
    targetUrl: 'https://www.facebook.com/example',
    postContent: '',
    hasVideo: true,
    videoLibraryUrl: snapshot.libraryUrl,
    videoBeforeSnapshot: snapshot,
  });

  assert.equal(scheduled.status, 'waiting');
  assert.equal(scheduled.video_library_url, snapshot.libraryUrl);
  assert.deepEqual(JSON.parse(scheduled.video_before_json), snapshot);
});

test('MCP job remains running while Facebook permalink recovery is pending', () => {
  const post = DataService.create({
    content: 'MCP must wait for this Reel permalink',
    image_path: 'C:\\media\\mcp-pending.mp4',
    status: 'success',
  }, 'facebook');
  const agentJobId = 'job_mcp_link_pending';
  db.prepare(`
    INSERT INTO agent_jobs (
      job_id, platform, profile_id, profile_name, post_id, status,
      payload_json, result_json, created_at, updated_at
    ) VALUES (?, 'facebook', ?, ?, ?, 'running', '{}', '{}',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(agentJobId, profile.id, profile.name, post.id);

  PostLinkRecoveryService.schedule({
    postId: post.id,
    profileId: profile.id,
    targetType: 'profile',
    targetUrl: 'https://www.facebook.com/me',
    postContent: post.content,
    hasVideo: true,
  });
  const finalized = AgentJobs._private.finalizeFromPost(agentJobId);
  const stored = db.prepare(
    'SELECT status, completed_at, result_json FROM agent_jobs WHERE job_id = ?'
  ).get(agentJobId);
  const result = JSON.parse(stored.result_json);

  assert.equal(finalized.status, 'running');
  assert.equal(AgentJobs._private.isWaitingForPermalink(finalized), true);
  assert.equal(stored.status, 'running');
  assert.equal(stored.completed_at, null);
  assert.equal(result.status, 'success');
  assert.equal(result.link_pending, true);
  assert.equal(result.link_recovery_status, 'waiting');
});

test('recovered link updates post, custom data and Agent API result atomically', () => {
  const post = DataService.create({
    content: 'Recover this exact Reel caption',
    image_path: 'C:\\media\\recover.mp4',
    status: 'success',
  }, 'facebook');
  const agentJobId = 'job_link_recovery_test';
  db.prepare(`
    INSERT INTO agent_jobs (
      job_id, platform, profile_id, profile_name, post_id, status,
      payload_json, result_json, error, created_at, updated_at
    ) VALUES (?, 'facebook', ?, ?, ?, 'error', '{}', '{}', 'old false negative',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(agentJobId, profile.id, profile.name, post.id);
  const scheduled = PostLinkRecoveryService.schedule({
    postId: post.id,
    profileId: profile.id,
    targetType: 'profile',
    targetUrl: 'https://www.facebook.com/me',
    postContent: post.content,
    hasVideo: true,
  });

  const permalink = 'https://www.facebook.com/reel/123456789';
  PostLinkRecoveryService._markFound(scheduled, permalink, Date.now());

  const stored = db.prepare('SELECT status, link FROM posts WHERE id = ?').get(post.id);
  const custom = db.prepare(`
    SELECT d.value
    FROM post_custom_data d
    JOIN custom_columns c ON c.id = d.column_id
    WHERE d.post_id = ? AND c.platform = 'facebook' AND c.var_key = 'link_post'
  `).get(post.id);
  const agent = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(agentJobId);
  const result = JSON.parse(agent.result_json);

  assert.equal(stored.status, 'success');
  assert.equal(stored.link, permalink);
  assert.equal(custom.value, permalink);
  assert.equal(agent.status, 'success');
  assert.equal(agent.error, null);
  assert.equal(result.link_post, permalink);
  assert.equal(result.link_pending, false);
  assert.equal(result.link_recovery_status, 'success');
});

test('Group link recovery exists even when there are no comment jobs', () => {
  const post = DataService.create({
    content: 'Moderated Group post without comments',
    status: 'success',
  }, 'facebook');
  const recovery = PostLinkRecoveryService.schedule({
    postId: post.id,
    profileId: profile.id,
    targetType: 'group',
    targetUrl: 'https://www.facebook.com/groups/1001',
    postContent: post.content,
  });
  const commentCount = db.prepare(
    'SELECT COUNT(*) AS count FROM comment_jobs WHERE post_id = ?'
  ).get(post.id);

  assert.equal(recovery.status, 'waiting');
  assert.equal(recovery.target_type, 'group');
  assert.equal(commentCount.count, 0);
});

test('Group recovery hết giới hạn sẽ dừng vĩnh viễn và không còn mở profile', () => {
  const post = DataService.create({
    content: 'Group permalink cannot retry forever',
    status: 'success',
  }, 'facebook');
  const recovery = PostLinkRecoveryService.schedule({
    postId: post.id,
    profileId: profile.id,
    targetType: 'group',
    targetUrl: 'https://www.facebook.com/groups/1001',
    postContent: post.content,
  });
  db.prepare(
    "UPDATE post_link_recovery_jobs SET attempts = 2, status = 'waiting' WHERE id = ?"
  ).run(recovery.id);

  PostLinkRecoveryService._expireStaleJobs();

  const expired = PostLinkRecoveryService.getByPost(post.id);
  const result = PostLinkRecoveryService.publicPostResult(post.id, 'facebook');
  assert.equal(expired.status, 'expired');
  assert.match(expired.last_error, /2 unsuccessful permalink lookups/);
  assert.equal(result.link_pending, false);
  assert.equal(result.link_recovery_status, 'expired');
});

test('runNow bỏ qua hạn cũ đúng một lượt để thực sự dò lại permalink', async () => {
  const post = DataService.create({
    content: 'Manual retry for an old successful video',
    image_path: 'C:\\media\\old-video.mp4',
    status: 'success',
  }, 'facebook');
  PostLinkRecoveryService.schedule({
    postId: post.id,
    profileId: profile.id,
    targetType: 'profile',
    targetUrl: 'https://www.facebook.com/me',
    postContent: post.content,
    hasVideo: true,
    publishedAtMs: Date.now() - 7 * 60 * 60 * 1000,
  });
  const originalRecover = PostLinkRecoveryService._recover;
  let received = null;
  PostLinkRecoveryService._recover = async (jobId, options) => {
    received = { jobId, options };
    return PostLinkRecoveryService.getByPost(post.id);
  };
  try {
    await PostLinkRecoveryService.runNow(post.id);
  } finally {
    PostLinkRecoveryService._recover = originalRecover;
  }

  assert.equal(received.jobId, PostLinkRecoveryService.getByPost(post.id).id);
  assert.deepEqual(received.options, { ignoreExpiry: true });
  assert.match(
    originalRecover.toString(),
    /options\.ignoreExpiry !== true/
  );
});

test.after(() => {
  PostLinkRecoveryService.shutdown();
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
