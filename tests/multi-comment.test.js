const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-multi-comment-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const CommentJobService = require('../src/services/comment-job.service');
const AgentData = require('../src/services/agent-data.service');
const { RunnerService } = require('../src/services/runner.service');

function addFacebookProfile(name, directory) {
  const inserted = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'closed')"
  ).run(name, directory);
  db.prepare(`
    INSERT INTO browser_platforms (browser_id, platform, enabled, session_valid)
    VALUES (?, 'facebook', 1, 1)
  `).run(inserted.lastInsertRowid);
  return db.prepare('SELECT * FROM browsers WHERE id = ?').get(inserted.lastInsertRowid);
}

test.before(async () => {
  await db.waitReady();
  DataService.ensurePlatformDefaultColumns('facebook');
});

test('thêm Bình luận tự sinh đủ bốn cột và tăng số lớn nhất', () => {
  assert.deepEqual(DataService.getCommentSequences('facebook'), []);
  const first = DataService.addNextCommentGroup('facebook');
  assert.equal(first.sequence, 1);
  assert.deepEqual(
    first.columns.map(column => column.var_key),
    ['comment', 'comment_media', 'time_comment', 'comment_status']
  );
  const second = DataService.addNextCommentGroup('facebook');
  assert.equal(second.sequence, 2);
  assert.deepEqual(
    second.columns.map(column => column.var_key),
    ['comment_2', 'comment_media_2', 'time_comment_2', 'comment_status_2']
  );

  const third = DataService.addNextCommentGroup('facebook');
  assert.equal(third.sequence, 3);
  DataService.deleteCommentGroup(2, 'facebook');
  const fourth = DataService.addNextCommentGroup('facebook');
  assert.equal(fourth.sequence, 4);
  assert.throws(
    () => DataService.deleteCustomColumn(
      DataService.getCustomColumns('facebook').find(column => column.var_key === 'comment').id,
      'facebook'
    ),
    /nhóm bình luận/
  );
  DataService.deleteCommentGroup(1, 'facebook');
  assert.deepEqual(DataService.getCommentSequences('facebook'), [3, 4]);
});

test('chuỗi bình luận chỉ mở khóa lượt kế tiếp sau khi lượt trước kết thúc', async () => {
  const profile = db.prepare(
    'INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, ?)'
  ).run('multi-profile', 'multi-profile-dir', 'closed');
  const post = db.prepare(
    'INSERT INTO posts (content, status, platform) VALUES (?, ?, ?)'
  ).run('multi post', 'success', 'facebook');

  const jobs = CommentJobService.scheduleChain({
    postId: post.lastInsertRowid,
    profileId: profile.lastInsertRowid,
    postLink: 'https://www.facebook.com/test/posts/multi',
    jobs: [
      { sequence: 1, commentText: 'one', dueAt: Date.now() + 600000 },
      { sequence: 3, commentText: 'three', delayAfterPreviousMs: 2000 },
      { sequence: 4, commentText: 'four', delayAfterPreviousMs: 3000 },
    ],
    continueOnError: true,
    platform: 'facebook',
  });

  assert.deepEqual(jobs.map(job => job.status), ['waiting', 'blocked', 'blocked']);
  await CommentJobService._markSuccess(jobs[0], '07/08/2026 18:00');
  let refreshed = db.prepare(
    'SELECT * FROM comment_jobs WHERE chain_id = ? ORDER BY sequence_no'
  ).all(jobs[0].chain_id);
  assert.deepEqual(refreshed.map(job => job.status), ['success', 'waiting', 'blocked']);
  assert.ok(refreshed[1].due_at >= Date.now() + 1500);

  await CommentJobService._markFailed(refreshed[1], 'test error');
  refreshed = db.prepare(
    'SELECT * FROM comment_jobs WHERE chain_id = ? ORDER BY sequence_no'
  ).all(jobs[0].chain_id);
  assert.deepEqual(refreshed.map(job => job.status), ['success', 'error', 'waiting']);
});

test('import cột Bình luận có số tự tạo nhóm còn thiếu và giữ đúng dữ liệu', () => {
  const result = DataService.importSheet([{
    'Nội dung': 'Bài import nhiều bình luận',
    'Bình luận 5': 'https://s.shopee.vn/7KmUQoM3Hc',
    'Media bình luận 5': 'C:/media/comment-5.png',
    'Thời gian bình luận 5': '07/08/2026 18:30',
    'Trạng thái bình luận 5': 'success',
  }], 'facebook');

  assert.equal(result.imported, 1);
  const byVar = new Map(
    DataService.getCustomColumns('facebook').map(column => [column.var_key, column])
  );
  for (const base of ['comment', 'comment_media', 'time_comment', 'comment_status']) {
    assert.ok(byVar.has(`${base}_5`), `thiếu ${base}_5`);
  }
  const row = DataService.getAllWithCustomData('facebook')
    .find(item => item.id === result.ids[0]);
  assert.equal(row[`custom_${byVar.get('comment_5').id}`], 'https://s.shopee.vn/7KmUQoM3Hc');
  assert.equal(row[`custom_${byVar.get('comment_status_5').id}`], 'success');

  const commentHeaders = DataService.getExportColumnSchema('facebook')
    .filter(column => column.kind === 'custom' && /comment|bình luận/i.test(column.var_key || column.header))
    .map(column => column.header);
  assert.deepEqual(commentHeaders.slice(-4), [
    'Bình luận 5',
    'Media bình luận 5',
    'Thời gian bình luận 5',
    'Trạng thái bình luận 5',
  ]);
});

test('scheduleCommentOnLink xếp N job (đầu waiting) và ghi comment/comment_status lên post', () => {
  const profile = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'closed')"
  ).run('link-comment-profile', 'link-comment-dir');
  const post = db.prepare(
    'INSERT INTO posts (content, status, platform) VALUES (?, ?, ?)'
  ).run('', 'Đã xếp bình luận', 'facebook');
  const postLink = 'https://www.facebook.com/test/posts/link-comment';
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('comment_delay_min', '600');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('comment_delay_max', '600');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('comment_intervals', JSON.stringify({ 2: { min: 600, max: 600, unit: 'sec' } }));

  const scheduledAt = Date.now();
  const jobs = CommentJobService.scheduleCommentOnLink({
    platform: 'facebook',
    postId: post.lastInsertRowid,
    profileId: profile.lastInsertRowid,
    postLink,
    comments: ['xin chào', { text: 'câu hai', media: '' }],
  });

  assert.deepEqual(jobs.map(job => job.status), ['waiting', 'blocked']);
  assert.deepEqual(jobs.map(job => job.sequence_no), [1, 2]);
  assert.equal(jobs[0].post_link, postLink);
  assert.ok(jobs[0].due_at >= scheduledAt);
  assert.ok(jobs[0].due_at <= Date.now() + 1000);
  assert.equal(jobs[1].delay_after_previous_ms, 0);
  assert.equal(jobs[0].continue_on_error, 1);

  const byVar = new Map(
    DataService.getCustomColumns('facebook').map(column => [column.var_key, column])
  );
  const row = DataService.getAllWithCustomData('facebook')
    .find(item => item.id === post.lastInsertRowid);
  assert.equal(row[`custom_${byVar.get('comment').id}`], 'xin chào');
  assert.equal(row[`custom_${byVar.get('comment_2').id}`], 'câu hai');
  assert.equal(row[`custom_${byVar.get('comment_status').id}`], 'waiting');
  assert.equal(row[`custom_${byVar.get('comment_status_2').id}`], 'blocked');
  assert.equal(row[`custom_${byVar.get('link_post').id}`], postLink);
});

test('bình luận riêng bỏ qua trạng thái bài đăng, chạy ngay và không tạo chuỗi trùng', () => {
  const profile = addFacebookProfile('Comment Only Profile', 'comment-only-dir');
  const post = DataService.create({
    content: 'Bài đã đăng từ trước',
    status: 'success',
  }, 'facebook');
  const byVar = new Map(
    DataService.getCustomColumns('facebook').map(column => [column.var_key, column])
  );
  DataService.setCustomData(post.id, byVar.get('name_profile').id, profile.name, 'facebook');
  DataService.setCustomData(
    post.id,
    byVar.get('link_post').id,
    'https://www.facebook.com/test/posts/comment-only',
    'facebook'
  );
  DataService.setCustomData(post.id, byVar.get('comment').id, 'Bình luận ngay', 'facebook');
  const row = DataService.getAllWithCustomData('facebook')
    .find(item => item.id === post.id);
  const runner = new RunnerService('facebook');
  const matched = new Map([[profile.id, [row]]]);

  const first = runner._runCommentLinks(matched, [profile]);
  assert.equal(first.scheduled, 1);
  assert.equal(
    db.prepare('SELECT status FROM posts WHERE id = ?').get(post.id).status,
    'success'
  );
  const job = db.prepare(
    'SELECT status, due_at, delay_after_previous_ms FROM comment_jobs WHERE post_id = ?'
  ).get(post.id);
  assert.equal(job.status, 'waiting');
  assert.ok(job.due_at <= Date.now() + 1000);
  assert.equal(job.delay_after_previous_ms, 0);

  db.prepare("UPDATE comment_jobs SET status = 'success' WHERE post_id = ?").run(post.id);
  const replay = runner._runCommentLinks(matched, [profile]);
  assert.equal(replay.scheduled, 0);
  assert.equal(replay.skipped, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM comment_jobs WHERE post_id = ?').get(post.id).n,
    1
  );
});

test('commentLinks tạo row non-pending, idempotent theo data_key và validate đầu vào', () => {
  addFacebookProfile('CommentLinks Profile', 'commentlinks-dir');
  const link = 'https://www.facebook.com/test/posts/agent-link';
  const before = DataService.getCount('facebook');

  const result = AgentData.commentLinks({
    platform: 'facebook',
    items: [{
      data_key: 'comment-link-row-1',
      link,
      profile: 'CommentLinks Profile',
      comments: ['bình luận mcp'],
    }],
  });
  assert.equal(result.total, 1);
  assert.equal(result.scheduled_count, 1);
  assert.equal(result.replay_count, 0);
  const postId = result.items[0].post_id;
  assert.equal(
    db.prepare('SELECT status FROM posts WHERE id = ?').get(postId).status,
    'Đã xếp bình luận'
  );
  assert.equal(DataService.getCount('facebook'), before + 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM comment_jobs WHERE post_id = ?').get(postId).n,
    1
  );

  const replay = AgentData.commentLinks({
    platform: 'facebook',
    items: [{
      data_key: 'comment-link-row-1',
      link,
      profile: 'CommentLinks Profile',
      comments: ['bình luận mcp'],
    }],
  });
  assert.equal(replay.scheduled_count, 0);
  assert.equal(replay.replay_count, 1);
  assert.equal(replay.items[0].post_id, postId);
  assert.equal(DataService.getCount('facebook'), before + 1);

  assert.throws(
    () => AgentData.commentLinks({
      platform: 'facebook',
      items: [{
        data_key: 'comment-link-bad-url',
        link: 'https://example.com/not-facebook',
        profile: 'CommentLinks Profile',
        comments: ['a'],
      }],
    }),
    error => error.code === 'AGENT_DATA_TARGET_INVALID'
  );

  assert.throws(
    () => AgentData.commentLinks({
      platform: 'facebook',
      items: [{
        data_key: 'comment-link-no-comment',
        link,
        profile: 'CommentLinks Profile',
      }],
    }),
    error => error.code === 'AGENT_DATA_COMMENT_EMPTY'
  );

  addFacebookProfile('Ambiguous CL', 'ambi-cl-1');
  addFacebookProfile('Ambiguous CL', 'ambi-cl-2');
  assert.throws(
    () => AgentData.commentLinks({
      platform: 'facebook',
      items: [{
        data_key: 'comment-link-ambiguous',
        link,
        profile: 'Ambiguous CL',
        comments: ['a'],
      }],
    }),
    error => error.code === 'AGENT_PROFILE_AMBIGUOUS'
  );
});

test.after(() => {
  try { CommentJobService.shutdown(); } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
