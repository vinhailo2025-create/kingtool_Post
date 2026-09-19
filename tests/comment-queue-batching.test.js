const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-comment-batching-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const { CommentJobService } = require('../src/services/comment-job.service');

test('due comments stay sequential per profile while different profiles can overlap', async () => {
  await db.waitReady();
  const profiles = [1, 2];
  for (const profileId of profiles) {
    db.prepare(
      'INSERT INTO browsers (id, name, profile_dir, status) VALUES (?, ?, ?, ?)'
    ).run(profileId, `profile-${profileId}`, `profile-${profileId}`, 'closed');
  }

  const insertPost = db.prepare(
    "INSERT INTO posts (content, status, platform, data_mode) VALUES (?, 'success', 'facebook', 'comment_link')"
  );
  const insertJob = db.prepare(`
    INSERT INTO comment_jobs (
      post_id, profile_id, post_link, comment_text, due_at, status, platform
    ) VALUES (?, ?, ?, ?, ?, 'waiting', 'facebook')
  `);
  for (const profileId of profiles) {
    for (let index = 0; index < 2; index++) {
      const post = insertPost.run(`post-${profileId}-${index}`);
      insertJob.run(
        post.lastInsertRowid,
        profileId,
        `https://www.facebook.com/test/${profileId}/${index}`,
        `comment-${profileId}-${index}`,
        Date.now() - 1
      );
    }
  }

  const service = new CommentJobService();
  service.initialized = true;
  const activeByProfile = new Map();
  let activeTotal = 0;
  let maxActiveTotal = 0;

  service._executeJob = async jobId => {
    const job = db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(jobId);
    const current = (activeByProfile.get(job.profile_id) || 0) + 1;
    activeByProfile.set(job.profile_id, current);
    activeTotal += 1;
    maxActiveTotal = Math.max(maxActiveTotal, activeTotal);
    assert.equal(current, 1, 'một profile không được chạy hai bình luận cùng lúc');
    await new Promise(resolve => setTimeout(resolve, 20));
    db.prepare("UPDATE comment_jobs SET status = 'success' WHERE id = ?").run(jobId);
    activeByProfile.set(job.profile_id, current - 1);
    activeTotal -= 1;
  };

  await service._drainDue();
  assert.ok(maxActiveTotal >= 2, 'hai profile khác nhau vẫn được phép chạy song song');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM comment_jobs WHERE status = 'success'").get().count,
    4
  );
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
