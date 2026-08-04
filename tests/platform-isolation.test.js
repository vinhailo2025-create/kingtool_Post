const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-platform-test-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');

test('Facebook, TikTok, YouTube, Threads, Instagram and X data and runner state are isolated', async () => {
  await db.waitReady();
  const DataService = require('../src/services/data.service');
  const RunnerManager = require('../src/services/runner-manager.service');

  DataService.create({ content: 'facebook post' }, 'facebook');
  DataService.create({ content: 'tiktok post', product_id: 'SKU-001' }, 'tiktok');
  DataService.create({ content: 'youtube post' }, 'youtube');
  DataService.create({ content: 'threads post', image_path: 'threads.jpg' }, 'threads');
  DataService.create({ content: 'instagram post', image_path: 'instagram.jpg' }, 'instagram');
  DataService.create({ content: 'x post', image_path: 'x.jpg' }, 'x');
  DataService.addCustomColumn('Facebook only', 'text', 'fb_only', 'facebook');
  DataService.addCustomColumn('TikTok only', 'text', 'tt_only', 'tiktok');
  DataService.addCustomColumn('YouTube only', 'text', 'yt_only', 'youtube');
  DataService.addCustomColumn('Threads only', 'text', 'threads_only', 'threads');
  DataService.addCustomColumn('Instagram only', 'text', 'instagram_only', 'instagram');
  DataService.addCustomColumn('X only', 'text', 'x_only', 'x');

  assert.deepEqual(DataService.getAll('facebook').map(row => row.content), ['facebook post']);
  assert.deepEqual(DataService.getAll('tiktok').map(row => row.content), ['tiktok post']);
  assert.deepEqual(DataService.getAll('youtube').map(row => row.content), ['youtube post']);
  assert.deepEqual(DataService.getAll('threads').map(row => row.content), ['threads post']);
  assert.deepEqual(DataService.getAll('instagram').map(row => row.content), ['instagram post']);
  assert.deepEqual(DataService.getAll('x').map(row => row.content), ['x post']);
  assert.equal(DataService.getAll('tiktok')[0].product_id, 'SKU-001');
  assert.deepEqual(DataService.getCustomColumns('facebook').map(row => row.var_key), ['fb_only']);
  assert.deepEqual(DataService.getCustomColumns('tiktok').map(row => row.var_key), ['tt_only']);
  assert.deepEqual(DataService.getCustomColumns('youtube').map(row => row.var_key), ['yt_only']);
  assert.deepEqual(DataService.getCustomColumns('threads').map(row => row.var_key), ['threads_only']);
  assert.deepEqual(DataService.getCustomColumns('instagram').map(row => row.var_key), ['instagram_only']);
  assert.deepEqual(DataService.getCustomColumns('x').map(row => row.var_key), ['x_only']);

  const youtubeDefaults = DataService.ensurePlatformDefaultColumns('youtube');
  assert.deepEqual(
    youtubeDefaults.map(column => [column.name, column.var_key, column.col_type]),
    [
      ['Mô tả video', 'description', 'text'],
      ['Tên kênh', 'channel_name', 'text'],
      ['Danh sách phát', 'playlist', 'text'],
      ['Trạng thái lưu', 'privacy_status', 'select'],
      ['Hình Thumbnail', 'thumbnail', 'file'],
      ['Từ khóa', 'keywords', 'text'],
    ]
  );
  assert.deepEqual(DataService.getCustomColumns('facebook').map(row => row.var_key), ['fb_only']);
  assert.deepEqual(DataService.getCustomColumns('tiktok').map(row => row.var_key), ['tt_only']);

  assert.notEqual(RunnerManager.get('facebook'), RunnerManager.get('tiktok'));
  assert.notEqual(RunnerManager.get('facebook'), RunnerManager.get('youtube'));
  assert.notEqual(RunnerManager.get('tiktok'), RunnerManager.get('youtube'));
  assert.notEqual(RunnerManager.get('facebook'), RunnerManager.get('threads'));
  assert.notEqual(RunnerManager.get('tiktok'), RunnerManager.get('threads'));
  assert.notEqual(RunnerManager.get('youtube'), RunnerManager.get('threads'));
  assert.notEqual(RunnerManager.get('facebook'), RunnerManager.get('instagram'));
  assert.notEqual(RunnerManager.get('threads'), RunnerManager.get('instagram'));
  assert.notEqual(RunnerManager.get('instagram'), RunnerManager.get('x'));
  assert.notEqual(RunnerManager.get('facebook'), RunnerManager.get('x'));
  RunnerManager.get('facebook').isRunning = true;
  assert.equal(RunnerManager.get('tiktok').isRunning, false);
  assert.equal(RunnerManager.get('youtube').isRunning, false);
  assert.equal(RunnerManager.get('threads').isRunning, false);
  assert.equal(RunnerManager.get('instagram').isRunning, false);
  assert.equal(RunnerManager.get('x').isRunning, false);
  RunnerManager.get('facebook').isRunning = false;
});

test('profile sync links one physical Chrome profile across all platforms', async () => {
  const BrowserService = require('../src/services/browser.service');
  const profile = BrowserService.create({ name: 'Shared profile' }, 'facebook');

  assert.equal(BrowserService.getAll('facebook').length, 1);
  assert.equal(BrowserService.getAll('tiktok').length, 0);
  assert.equal(BrowserService.getAll('youtube').length, 0);
  assert.equal(BrowserService.getAll('threads').length, 0);
  assert.equal(BrowserService.getAll('instagram').length, 0);
  assert.equal(BrowserService.getAll('x').length, 0);
  assert.equal(BrowserService.syncProfiles([profile.id], 'tiktok').linked, 1);
  assert.equal(BrowserService.syncProfiles([profile.id], 'tiktok').linked, 0);
  assert.equal(BrowserService.getAll('tiktok')[0].id, profile.id);
  assert.equal(BrowserService.syncProfiles([profile.id], 'youtube').linked, 1);
  assert.equal(BrowserService.getAll('youtube')[0].id, profile.id);
  assert.equal(BrowserService.syncProfiles([profile.id], 'threads').linked, 1);
  assert.equal(BrowserService.getAll('threads')[0].id, profile.id);
  assert.equal(BrowserService.syncProfiles([profile.id], 'instagram').linked, 1);
  assert.equal(BrowserService.getAll('instagram')[0].id, profile.id);
  assert.equal(BrowserService.syncProfiles([profile.id], 'x').linked, 1);
  assert.equal(BrowserService.getAll('x')[0].id, profile.id);

  const result = await BrowserService.unlinkPlatform(profile.id, 'facebook');
  assert.equal(result.deletedPhysicalProfile, false);
  assert.equal(BrowserService.getAll('facebook').length, 0);
  assert.equal(BrowserService.getAll('tiktok').length, 1);
  assert.equal(BrowserService.getAll('youtube').length, 1);
  assert.equal(BrowserService.getAll('threads').length, 1);
  assert.equal(BrowserService.getAll('instagram').length, 1);
  assert.equal(BrowserService.getAll('x').length, 1);
});

test('X adapter validates input, session cookies and permalink format', async () => {
  const XAdapter = require('../src/platforms/x.adapter');
  await assert.rejects(
    XAdapter.publish({}, {}),
    error => error.code === 'X_DATA_REQUIRED'
  );
  assert.equal(
    await XAdapter.validateSession({
      cookies: async () => [{ name: 'auth_token', value: 'logged-in' }],
    }),
    true
  );
  assert.equal(
    XAdapter._private.normalizeXPostUrl('https://x.com/covergem/status/1234567890?ref=test'),
    'https://x.com/covergem/status/1234567890'
  );
  assert.equal(
    XAdapter._private.normalizeXPostUrl('https://twitter.com/covergem/status/1234567890/analytics'),
    'https://x.com/covergem/status/1234567890'
  );
  assert.equal(XAdapter._private.normalizeXPostUrl('https://example.com/covergem/status/1'), '');
  assert.throws(
    () => XAdapter._private.assertAccountAvailable({
      __covergemXAccountRestriction: {
        code: 'X_ACCOUNT_SUSPENDED',
        message: 'Tài khoản bị đình chỉ',
      },
    }),
    error => error.code === 'X_ACCOUNT_SUSPENDED'
  );
});

test('Instagram adapter validates media, session cookies and permalink format', async () => {
  const InstagramAdapter = require('../src/platforms/instagram.adapter');
  await assert.rejects(
    InstagramAdapter.publish({}, {}),
    error => error.code === 'INSTAGRAM_MEDIA_REQUIRED'
  );
  const tooSmall = path.join(testRoot, 'instagram-too-small.png');
  fs.writeFileSync(tooSmall, Buffer.from('small'));
  await assert.rejects(
    InstagramAdapter.publish({}, { image_path: tooSmall }),
    error => error.code === 'INSTAGRAM_MEDIA_TOO_SMALL'
  );
  assert.equal(
    await InstagramAdapter.validateSession({
      cookies: async () => [{ name: 'sessionid', value: 'logged-in' }],
    }),
    true
  );
  assert.equal(
    InstagramAdapter._private.normalizeInstagramPostUrl('https://www.instagram.com/p/ABC123/?utm_source=test'),
    'https://www.instagram.com/p/ABC123/'
  );
  assert.equal(
    InstagramAdapter._private.normalizeInstagramPostUrl('https://www.instagram.com/reel/XYZ789/'),
    'https://www.instagram.com/reel/XYZ789/'
  );
  assert.equal(
    InstagramAdapter._private.normalizeInstagramPostUrl('https://www.instagram.com/covergem/p/OWNER123/'),
    'https://www.instagram.com/covergem/p/OWNER123/'
  );
  assert.equal(InstagramAdapter._private.normalizeInstagramPostUrl('https://example.com/p/ABC123/'), '');
});

test('Threads adapter validates input, session cookies and permalink format', async () => {
  const ThreadsAdapter = require('../src/platforms/threads.adapter');
  await assert.rejects(
    ThreadsAdapter.publish({}, {}),
    error => error.code === 'THREADS_DATA_REQUIRED'
  );
  assert.equal(
    await ThreadsAdapter.validateSession({
      cookies: async () => [{ name: 'sessionid', value: 'logged-in' }],
    }),
    true
  );
  assert.equal(
    ThreadsAdapter._private.normalizeThreadsUrl('https://www.threads.com/@covergem/post/ABC123?hl=vi'),
    'https://www.threads.com/@covergem/post/ABC123'
  );
  assert.equal(ThreadsAdapter._private.normalizeThreadsUrl('https://example.com/@covergem/post/ABC123'), '');

  const profileUrl = 'https://www.threads.com/@covergem';
  const oldLink = `${profileUrl}/post/OLD001`;
  const unrelatedOldLink = `${profileUrl}/post/OLD002`;
  const exactNewLink = `${profileUrl}/post/NEW003`;
  const page = {
    url: () => profileUrl,
    evaluate: async () => [
      { href: unrelatedOldLink, text: 'Một bài cũ vừa được virtual list render thêm' },
      { href: exactNewLink, text: 'covergem 1m Nội dung Threads cần lấy đúng' },
      { href: oldLink, text: 'covergem 2m Nội dung cũ' },
    ],
    reload: async () => {},
  };
  assert.equal(
    await ThreadsAdapter._private.captureJustPublishedLink(
      page,
      profileUrl,
      [{ url: oldLink }],
      'Nội dung Threads cần lấy đúng',
      { linkTimeout: 5000, navigationTimeout: 5000, settleMs: 0 }
    ),
    exactNewLink
  );
});

test('YouTube adapter validates media before publishing', async () => {
  const YouTubeAdapter = require('../src/platforms/youtube.adapter');
  await assert.rejects(
    YouTubeAdapter.publish({}, {}),
    error => error.code === 'YOUTUBE_TITLE_REQUIRED'
  );
  assert.equal(
    await YouTubeAdapter.validateSession({
      cookies: async () => [{ name: 'SAPISID', value: 'logged-in' }],
    }),
    true
  );
});

test('TikTok publish validates required input and never reports a false success', async () => {
  const TikTokAdapter = require('../src/platforms/tiktok.adapter');
  await assert.rejects(
    TikTokAdapter.publish({}, {}),
    error => error.code === 'TIKTOK_MEDIA_REQUIRED'
  );
});

test('TikTok comment jobs persist with their platform for crash recovery', async () => {
  const CommentJobService = require('../src/services/comment-job.service');
  const browser = db.prepare('SELECT id FROM browsers LIMIT 1').get();
  const post = db.prepare("SELECT id FROM posts WHERE platform = 'tiktok' LIMIT 1").get();
  CommentJobService.init();
  const job = CommentJobService.schedule({
    postId: post.id,
    profileId: browser.id,
    postLink: 'https://www.tiktok.com/@test/video/1',
    commentText: 'TikTok comment',
    dueAt: Date.now() + 3600000,
    platform: 'tiktok',
  });
  assert.equal(job.platform, 'tiktok');
  assert.equal(
    db.prepare('SELECT platform FROM comment_jobs WHERE id = ?').get(job.id).platform,
    'tiktok'
  );
  assert.ok(
    db.prepare(
      "SELECT id FROM custom_columns WHERE platform = 'tiktok' AND var_key = 'comment_status'"
    ).get()
  );
  CommentJobService.shutdown();
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
