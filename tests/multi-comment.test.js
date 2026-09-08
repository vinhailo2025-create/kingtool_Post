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

test.before(async () => {
  await db.waitReady();
  DataService.ensurePlatformDefaultColumns('facebook');
});

test('thêm Bình luận tự sinh đủ bốn cột và tăng số lớn nhất', () => {
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
    /mặc định/
  );
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

test.after(() => {
  try { CommentJobService.shutdown(); } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
