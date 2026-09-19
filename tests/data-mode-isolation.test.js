const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-data-mode-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const CommentJobService = require('../src/services/comment-job.service');
const RunnerService = require('../src/services/runner.service');

test('post and comment-link rows are isolated for listing, runner selection, and deletion', async () => {
  await db.waitReady();
  const post = DataService.create({ content: 'Post row' }, 'facebook');
  const comment = DataService.create(
    { content: '', link: 'https://facebook.com/test/posts/1' },
    'facebook',
    'comment_link'
  );

  assert.deepEqual(DataService.getAll('facebook').map(row => row.id), [post.id]);
  assert.deepEqual(
    DataService.getAll('facebook', 'comment_link').map(row => row.id),
    [comment.id]
  );
  assert.deepEqual(
    RunnerService.getOrderedCandidatePosts('facebook', 'all', 'post').map(row => row.id),
    [post.id]
  );
  assert.deepEqual(
    RunnerService.getOrderedCandidatePosts('facebook', 'all', 'comment_link').map(row => row.id),
    [comment.id]
  );

  assert.equal(DataService.deleteMany([post.id], 'facebook', 'comment_link').deleted, 0);
  assert.equal(DataService.deleteMany([comment.id], 'facebook', 'comment_link').deleted, 1);
  assert.equal(DataService.getAll('facebook').length, 1);
});

test('undo restore keeps data mode and custom values', () => {
  DataService.ensurePlatformDefaultColumns('facebook');
  const nameColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'name_profile');
  const row = DataService.create({ content: 'Recover me' }, 'facebook');
  DataService.setCustomData(row.id, nameColumn.id, 'Profile restored', 'facebook');
  const snapshot = DataService.getAllWithCustomData('facebook')
    .find(item => item.id === row.id);

  DataService.deleteMany([row.id], 'facebook', 'post');
  DataService.restoreMany([snapshot], 'facebook', 'post');

  const restored = DataService.getAllWithCustomData('facebook')
    .find(item => item.id === row.id);
  assert.equal(restored.data_mode, 'post');
  assert.equal(restored[`custom_${nameColumn.id}`], 'Profile restored');
});

test('same profile, link, and comment is scheduled only once', () => {
  const profile = db.prepare(
    "INSERT INTO browsers (name, profile_dir, status) VALUES (?, ?, 'closed')"
  ).run('Dedupe profile', 'dedupe-profile');
  const firstRow = DataService.create({}, 'facebook', 'comment_link');
  const secondRow = DataService.create({}, 'facebook', 'comment_link');
  const payload = {
    platform: 'facebook',
    profileId: profile.lastInsertRowid,
    postLink: 'https://www.facebook.com/example/posts/123',
    comments: ['Only once'],
  };

  const first = CommentJobService.scheduleCommentOnLink({ ...payload, postId: firstRow.id });
  const second = CommentJobService.scheduleCommentOnLink({ ...payload, postId: secondRow.id });

  assert.equal(first.created_count, 1);
  assert.equal(second.created_count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comment_jobs').get().n, 1);
});

test.after(() => {
  try { CommentJobService.shutdown(); } catch (_) {}
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
