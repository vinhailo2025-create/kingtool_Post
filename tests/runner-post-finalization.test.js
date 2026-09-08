const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-post-finalization-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const { RunnerService } = require('../src/services/runner.service');

test('lưu status và link post trước khi cho phép xếp bình luận', async () => {
  await db.waitReady();
  DataService.ensurePlatformDefaultColumns('facebook');
  const profileResult = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'open')"
  ).run('Profile test', 'profile-finalization');
  const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(profileResult.lastInsertRowid);
  const post = DataService.create({ content: 'Bài kiểm tra finalize', status: 'pending' }, 'facebook');
  const runner = new RunnerService('facebook');
  const order = [];

  runner._broadcastLog = event => {
    if (event.event === 'post_saved') order.push('broadcast');
  };
  runner._scheduleCommentJob = async (_profile, currentPost, result) => {
    order.push('schedule');
    const stored = DataService.getAllWithCustomData('facebook')
      .find(item => item.id === currentPost.id);
    const byVar = new Map(DataService.getCustomColumns('facebook').map(column => [column.var_key, column]));
    assert.equal(stored.status, 'success');
    assert.equal(stored.link, 'https://www.facebook.com/test/posts/123');
    assert.equal(
      stored[`custom_${byVar.get('link_post').id}`],
      'https://www.facebook.com/test/posts/123'
    );
    assert.equal(stored[`custom_${byVar.get('time_post').id}`], '07/08/2026 17:30');
    assert.ok(result.persistedAtMs > 0);
  };

  const result = await runner._finalizePublishedPost(profile, post, {
    postLink: 'https://www.facebook.com/test/posts/123',
    postedAt: '07/08/2026 17:30',
    publishedAtMs: 1,
  });

  assert.deepEqual(order, ['broadcast', 'schedule']);
  assert.ok(result.persistedAtMs > result.publishedAtMs);
});

test('Facebook profile without a permalink stays success and schedules link recovery', async () => {
  const profile = db.prepare('SELECT * FROM browsers LIMIT 1').get();
  const post = DataService.create({
    content: 'Facebook must return a real post link',
    status: 'pending',
  }, 'facebook');
  const runner = new RunnerService('facebook');
  runner._scheduleCommentJob = async () => null;

  const result = await runner._finalizePublishedPost(profile, post, {
    success: true,
    targetType: 'profile',
    profileHref: 'https://www.facebook.com/me',
    postContent: 'Facebook must return a real post link',
    postLink: '',
    postedAt: '15/08/2026 18:00',
  });

  // Bai da len Facebook that; thieu link khong duoc bao loi vi se khien nguoi dung dang trung.
  const stored = db.prepare('SELECT status, link, note FROM posts WHERE id = ?').get(post.id);
  const recovery = db.prepare(
    'SELECT * FROM post_link_recovery_jobs WHERE post_id = ?'
  ).get(post.id);
  assert.equal(result.linkMissing, true);
  assert.equal(stored.status, 'success');
  assert.equal(stored.link, '');
  assert.match(stored.note, /Chưa lấy được link, đang tự động tìm lại/);
  assert.equal(recovery.status, 'waiting');
  assert.equal(recovery.target_type, 'profile');
});

test('Facebook video accepted with a delayed permalink is success and schedules recovery', async () => {
  const profile = db.prepare('SELECT * FROM browsers LIMIT 1').get();
  const post = DataService.create({
    content: 'Delayed Facebook Reel caption',
    image_path: 'C:\\media\\delayed-video.mp4',
    status: 'pending',
  }, 'facebook');
  const runner = new RunnerService('facebook');
  runner._scheduleCommentJob = async () => null;
  const videoBeforeSnapshot = {
    ready: true,
    libraryUrl: 'https://www.facebook.com/example/reels/',
    items: [
      { key: 'video:100', url: 'https://www.facebook.com/reel/100' },
    ],
  };

  const result = await runner._finalizePublishedPost(profile, post, {
    success: true,
    publishedAccepted: true,
    targetType: 'profile',
    profileHref: 'https://www.facebook.com/me',
    postContent: 'Delayed Facebook Reel caption',
    hasVideo: true,
    linkPending: true,
    videoLibraryUrl: videoBeforeSnapshot.libraryUrl,
    videoBeforeSnapshot,
    postLink: '',
    postedAt: '15/08/2026 18:05',
  });

  const stored = db.prepare('SELECT status, link, note FROM posts WHERE id = ?').get(post.id);
  const recovery = db.prepare(
    'SELECT * FROM post_link_recovery_jobs WHERE post_id = ?'
  ).get(post.id);
  assert.equal(stored.status, 'success');
  assert.equal(stored.link, '');
  assert.match(stored.note, /Link video/);
  assert.equal(result.linkPending, true);
  assert.equal(recovery.status, 'waiting');
  assert.equal(recovery.target_type, 'profile');
  assert.equal(recovery.video_library_url, videoBeforeSnapshot.libraryUrl);
  assert.deepEqual(JSON.parse(recovery.video_before_json), videoBeforeSnapshot);
});

test('Group waiting approval remains success and schedules read-only permalink recovery', async () => {
  const profileResult = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'open')"
  ).run('Group finalization', 'group-finalization');
  const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(profileResult.lastInsertRowid);
  const post = DataService.create({ content: 'Approval finalization caption', status: 'pending' }, 'facebook');
  const columns = new Map(
    DataService.getCustomColumns('facebook').map(column => [column.var_key, column])
  );
  DataService.setCustomData(post.id, columns.get('comment').id, 'Comment after approval', 'facebook');
  for (const [key, value] of [
    ['auto_comment_enabled', '1'],
    ['comment_delay_unit', 'sec'],
    ['comment_delay_min', '30'],
    ['comment_delay_max', '30'],
  ]) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  const runner = new RunnerService('facebook');
  await runner._finalizePublishedPost(profile, post, {
    success: true,
    publishedAccepted: true,
    waitingApproval: true,
    postLink: 'Bài đăng chờ duyệt',
    groupUrl: 'https://www.facebook.com/groups/123',
    postContent: 'Approval finalization caption',
    identityType: 'fanpage',
    identityPageUrl: 'https://www.facebook.com/profile.php?id=456',
    postedAt: '08/08/2026 10:00',
  });

  const stored = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  assert.equal(stored.status, 'success');
  assert.match(stored.note, /chờ quản trị viên duyệt/i);
  const job = db.prepare('SELECT * FROM comment_jobs WHERE post_id = ?').get(post.id);
  assert.equal(job.status, 'waiting_approval');
  assert.equal(job.approval_delay_ms, 30000);
  assert.equal(job.group_url, 'https://www.facebook.com/groups/123');
  assert.equal(job.identity_type, 'fanpage');
});

test('Group recovery is scheduled even when automatic comments are disabled', async () => {
  const profile = db.prepare('SELECT * FROM browsers LIMIT 1').get();
  const post = DataService.create({
    content: 'Group post without comments',
    status: 'pending',
  }, 'facebook');
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_comment_enabled', '0')"
  ).run();
  const runner = new RunnerService('facebook');

  await runner._finalizePublishedPost(profile, post, {
    success: true,
    publishedAccepted: true,
    waitingApproval: true,
    postLink: 'Bai dang cho duyet',
    groupUrl: 'https://www.facebook.com/groups/999',
    postContent: 'Group post without comments',
    postedAt: '15/08/2026 18:10',
    targetType: 'group',
  });

  const recovery = db.prepare(
    'SELECT * FROM post_link_recovery_jobs WHERE post_id = ?'
  ).get(post.id);
  const comments = db.prepare(
    'SELECT COUNT(*) AS count FROM comment_jobs WHERE post_id = ?'
  ).get(post.id);
  assert.equal(recovery.status, 'waiting');
  assert.equal(recovery.target_type, 'group');
  assert.equal(comments.count, 0);
});

test('YouTube publish while checks are pending remains success without a permalink', async () => {
  DataService.ensurePlatformDefaultColumns('youtube');
  const profile = db.prepare('SELECT * FROM browsers LIMIT 1').get();
  const post = DataService.create({
    content: 'YouTube pending link',
    image_path: 'C:\\media\\video.mp4',
    status: 'pending',
  }, 'youtube');
  const runner = new RunnerService('youtube');
  runner._scheduleCommentJob = async () => null;

  const result = await runner._finalizePublishedPost(profile, post, {
    success: true,
    postLink: '',
    linkPending: true,
    postedAt: '10/08/2026 12:00',
  });

  const stored = db.prepare('SELECT status, note FROM posts WHERE id = ?').get(post.id);
  assert.equal(stored.status, 'success');
  assert.match(stored.note, /Link video đang đợi cập nhật/);
  assert.equal(result.linkPending, true);
});

test('hàng lỗi trả nguyên nhân vào cả Link và Link Post', async () => {
  DataService.ensurePlatformDefaultColumns('tiktok');
  const post = DataService.create({
    content: 'TikTok failure link',
    image_path: 'C:\\media\\video.mov',
    status: 'pending',
  }, 'tiktok');
  const runner = new RunnerService('tiktok');
  const result = runner._finalizeFailedPost(
    post,
    new Error('TikTok chưa xác nhận đăng thành công')
  );

  const stored = DataService.getAllWithCustomData('tiktok')
    .find(item => item.id === post.id);
  const linkPost = DataService.getCustomColumns('tiktok')
    .find(column => column.var_key === 'link_post');
  assert.equal(result, 'Lỗi: TikTok chưa xác nhận đăng thành công');
  assert.equal(stored.status, 'error');
  assert.equal(stored.link, result);
  assert.equal(stored[`custom_${linkPost.id}`], result);
});

test('lỗi chưa đăng nhập giữ bài ở trạng thái Chờ để chạy lại', async () => {
  const post = DataService.create({
    content: 'Bài chờ đăng nhập lại',
    status: 'pending',
  }, 'facebook');
  const runner = new RunnerService('facebook');
  const error = new Error('Facebook chưa vào session đăng nhập');
  error.code = 'FACEBOOK_NOT_LOGGED_IN';

  runner._deferPostForLogin(post, error);

  const stored = db.prepare('SELECT status, note, link FROM posts WHERE id = ?').get(post.id);
  assert.equal(stored.status, 'pending');
  assert.match(stored.note, /trang thai Cho/i);
  assert.equal(stored.link, '');
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
