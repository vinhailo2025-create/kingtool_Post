const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-group-approval-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const CommentJobService = require('../src/services/comment-job.service');

test('waiting_approval job persists Group, content, identity and comment delay', async () => {
  await db.waitReady();
  DataService.ensurePlatformDefaultColumns('facebook');
  const profile = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'open')"
  ).run('Group profile', 'group-profile');
  const post = DataService.create({ content: 'Unique approval caption', status: 'success' }, 'facebook');

  const jobs = CommentJobService.scheduleWaitingApproval({
    postId: post.id,
    profileId: profile.lastInsertRowid,
    groupUrl: 'https://www.facebook.com/groups/1001',
    postContent: 'Unique approval caption',
    identityType: 'fanpage',
    identityPageUrl: 'https://www.facebook.com/profile.php?id=2002',
    jobs: [
      {
        sequence: 1,
        commentText: 'Comment after approval',
        mediaPath: '',
        delayFromApprovalMs: 90000,
        delayAfterPreviousMs: 0,
      },
    ],
    platform: 'facebook',
  });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'waiting_approval');
  assert.equal(jobs[0].group_url, 'https://www.facebook.com/groups/1001');
  assert.equal(jobs[0].post_content, 'Unique approval caption');
  assert.equal(jobs[0].identity_type, 'fanpage');
  assert.equal(jobs[0].identity_page_url, 'https://www.facebook.com/profile.php?id=2002');
  assert.equal(jobs[0].approval_delay_ms, 90000);

  CommentJobService.shutdown();
  CommentJobService.init();
  const restored = db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(jobs[0].id);
  assert.equal(restored.status, 'waiting_approval');
});

test('approval recovery updates link_post and starts comment delay without publishing', () => {
  const waiting = db.prepare(
    "SELECT * FROM comment_jobs WHERE status = 'waiting_approval' ORDER BY id DESC LIMIT 1"
  ).get();
  const foundAt = Date.now();
  CommentJobService.markApprovalFound(
    waiting,
    'https://www.facebook.com/groups/1001/posts/3003',
    foundAt
  );

  const updated = db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(waiting.id);
  assert.equal(updated.status, 'waiting');
  assert.equal(updated.post_link, 'https://www.facebook.com/groups/1001/posts/3003');
  assert.equal(updated.due_at, foundAt + 90000);

  const groupColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'link_post');
  const custom = db.prepare(
    'SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?'
  ).get(waiting.post_id, groupColumn.id);
  assert.equal(custom.value, 'https://www.facebook.com/groups/1001/posts/3003');
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(waiting.post_id);
  assert.match(post.note, /đã được duyệt/i);
});

test('approval recovery is read-only and never calls the publish path', () => {
  const source = CommentJobService._recoverWaitingApproval.toString();
  assert.match(source, /findGroupPost/);
  assert.doesNotMatch(source, /\.publish\s*\(/);
});

test.after(() => {
  CommentJobService.shutdown();
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
