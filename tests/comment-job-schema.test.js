const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-comment-test-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');

test('comment job persists inputs and never auto-retries an interrupted send', async () => {
  await db.waitReady();
  const CommentJobService = require('../src/services/comment-job.service');

  db.prepare(
    'INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, ?)'
  ).run('test-profile', 'test-profile-dir', 'closed');
  const profile = db.prepare('SELECT * FROM browsers WHERE name = ?').get('test-profile');
  const postResult = db.prepare(
    'INSERT INTO posts (content, status) VALUES (?, ?)'
  ).run('test post', 'success');

  db.prepare(`
    INSERT INTO comment_jobs (
      post_id, profile_id, post_link, comment_text, media_path,
      due_at, status, attempts
    ) VALUES (?, ?, ?, ?, ?, ?, 'running', 1)
  `).run(
    postResult.lastInsertRowid,
    profile.id,
    'https://www.facebook.com/test/posts/1',
    'durable text',
    '',
    Date.now() + 3600000
  );

  CommentJobService.init();
  const restored = db.prepare('SELECT * FROM comment_jobs LIMIT 1').get();
  assert.equal(restored.status, 'error');
  assert.match(restored.last_error, /không tự thử lại/i);
  assert.equal(restored.comment_text, 'durable text');
  assert.equal(restored.sequence_no, 1);
  assert.match(restored.chain_id, /^legacy-/);

  const second = CommentJobService.schedule({
    postId: postResult.lastInsertRowid,
    profileId: profile.id,
    postLink: 'https://www.facebook.com/test/posts/2',
    commentText: 'scheduled text',
    mediaPath: 'C:\\tmp\\test.png',
    dueAt: Date.now() + 7200000,
  });
  assert.equal(second.status, 'waiting');
  assert.equal(second.sequence_no, 1);
  assert.ok(second.chain_id);

  const statusColumn = db.prepare(
    "SELECT * FROM custom_columns WHERE var_key = 'comment_status'"
  ).get();
  const statusValue = db.prepare(
    'SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?'
  ).get(postResult.lastInsertRowid, statusColumn.id);
  assert.equal(statusValue.value, 'waiting');

  db.prepare("UPDATE comment_jobs SET status = 'error' WHERE id = ?").run(second.id);
  const retried = CommentJobService.retry(postResult.lastInsertRowid);
  assert.equal(retried.id, second.id);
  assert.equal(retried.status, 'waiting');
  assert.equal(retried.attempts, 0);

  CommentJobService.shutdown();
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
