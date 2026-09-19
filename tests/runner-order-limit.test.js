const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-runner-order-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const RunnerService = require('../src/services/runner.service');

test('runner chỉ lấy hàng đang Chờ, đúng thứ tự bảng và đúng giới hạn mỗi lượt', async () => {
  await db.waitReady();
  DataService.ensurePlatformDefaultColumns('tiktok');
  const nameColumn = DataService.getCustomColumns('tiktok')
    .find(column => column.var_key === 'name_profile');

  const pendingLater = DataService.create({ content: 'Hàng 3', status: 'pending' }, 'tiktok');
  const completedFirst = DataService.create({ content: 'Hàng 1', status: 'success' }, 'tiktok');
  const pendingFirst = DataService.create({ content: 'Hàng 2', status: 'Chờ' }, 'tiktok');
  const errorLast = DataService.create({ content: 'Hàng 4', status: 'error' }, 'tiktok');

  for (const [post, sortOrder] of [
    [pendingLater, 3],
    [completedFirst, 1],
    [pendingFirst, 2],
    [errorLast, 4],
  ]) {
    DataService.update(post.id, { sort_order: sortOrder }, 'tiktok');
    DataService.setCustomData(post.id, nameColumn.id, 'Profile 30', 'tiktok');
  }

  const ordered = RunnerService.getOrderedCandidatePosts(
    'tiktok',
    [errorLast.id, pendingLater.id, completedFirst.id, pendingFirst.id]
  );
  assert.deepEqual(
    ordered.map(post => post.id),
    [completedFirst.id, pendingFirst.id, pendingLater.id, errorLast.id]
  );

  const limited = RunnerService.selectPendingPostsForProfile(
    ordered,
    'Profile 30',
    'tiktok',
    1
  );
  assert.deepEqual(limited.map(post => post.id), [pendingFirst.id]);

  const unlimited = RunnerService.selectPendingPostsForProfile(
    ordered,
    'Profile 30',
    'tiktok',
    0
  );
  assert.deepEqual(unlimited.map(post => post.id), [pendingFirst.id, pendingLater.id]);

  const commentRows = RunnerService.selectCommentRowsForProfile(
    ordered,
    'Profile 30',
    'tiktok'
  );
  assert.deepEqual(
    commentRows.map(post => post.id),
    [completedFirst.id, pendingFirst.id, pendingLater.id, errorLast.id]
  );
});

test('lịch hẹn đọc giới hạn lượt đăng theo đúng nền tảng trong Cấu hình', async () => {
  const SchedulerService = require('../src/services/scheduler.service');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('posts_per_profile_per_run', '2');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('tiktok_posts_per_profile_per_run', '5');

  assert.equal(SchedulerService.getPostsPerRunSetting('facebook'), 2);
  assert.equal(SchedulerService.getPostsPerRunSetting('tiktok'), 5);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
