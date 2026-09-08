const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FacebookAutomation,
  facebookVideoKey,
  normalizeFacebookCaption,
  publishedTimeMatches,
} = require('../src/platforms/facebook.adapter')._private;

test('video library URLs follow the target-specific Facebook routes', () => {
  const automation = new FacebookAutomation();

  assert.equal(
    automation.facebookVideoLibraryUrl(
      'profile',
      'https://www.facebook.com/vinhaiautomation',
      { vanity: 'vinhaiautomation' }
    ),
    'https://www.facebook.com/vinhaiautomation/reels/'
  );
  assert.equal(
    automation.facebookVideoLibraryUrl(
      'fanpage',
      'https://www.facebook.com/profile.php?id=123456',
      { id: '123456' }
    ),
    'https://www.facebook.com/profile.php?id=123456&sk=reels_tab'
  );
  assert.equal(
    automation.facebookVideoLibraryUrl(
      'group',
      'https://www.facebook.com/groups/987654'
    ),
    'https://www.facebook.com/groups/987654/media/videos'
  );
});

test('equivalent Facebook video URLs use the same stable video key', () => {
  assert.equal(
    facebookVideoKey('https://www.facebook.com/reel/123456?mibextid=test'),
    'video:123456'
  );
  assert.equal(
    facebookVideoKey('https://www.facebook.com/example/videos/123456/'),
    'video:123456'
  );
  assert.equal(
    facebookVideoKey('https://www.facebook.com/watch/?v=123456'),
    'video:123456'
  );
  assert.equal(
    facebookVideoKey(
      'https://www.facebook.com/groups/10/posts/20',
      { allowGroupPosts: true }
    ),
    'group-post:10:20'
  );
});

test('new video link must be the only difference in two consecutive scans', async () => {
  const automation = new FacebookAutomation({ sleep: async () => {} });
  const old = { key: 'video:100', url: 'https://www.facebook.com/reel/100' };
  const fresh = { key: 'video:200', url: 'https://www.facebook.com/reel/200' };
  const extra = { key: 'video:300', url: 'https://www.facebook.com/reel/300' };
  const scans = [
    { ready: true, items: [fresh, extra, old] },
    { ready: true, items: [fresh, old] },
    { ready: true, items: [fresh, old] },
  ];
  automation.scanFacebookVideoSnapshot = async () => scans.shift();

  const result = await automation.captureNewFacebookVideoLink(
    {},
    'https://www.facebook.com/example/reels/',
    { ready: true, items: [old] },
    { attempts: 3 }
  );

  assert.equal(result, fresh.url);
});

test('caption matching ignores Facebook punctuation and ellipsis changes', () => {
  const submitted = 'Đằng sau một người đàn ông đi xa là một mái nhà bình yên...';
  const rendered = 'Đằng sau một người đàn ông đi xa là một mái nhà bình yên. Vợ không cần đứng trước.';
  assert.ok(normalizeFacebookCaption(rendered).includes(
    normalizeFacebookCaption(submitted, 80)
  ));
});

test('pinned old Reel is rejected and fresh Reel is selected by publish time', async () => {
  const expected = Date.parse('2026-09-03T14:31:16Z');
  const current = { id: '' };
  const automation = new FacebookAutomation({ sleep: async () => {} });
  automation._mediaPermalinksFromTabs = async () => [];
  automation._reelIdsFromTabs = async () => ['old-pinned', 'fresh-publish'];
  automation._pagePublishedNear = async () => ({
    matched: current.id === 'fresh-publish',
    timestamps: [
      current.id === 'fresh-publish'
        ? expected - 4 * 60 * 1000
        : expected - 35 * 24 * 60 * 60 * 1000,
    ],
  });
  const page = {
    async goto(url) {
      current.id = url.split('/').pop();
    },
    async evaluate() {
      return current.id === 'fresh-publish'
        ? 'Đằng sau một người đàn ông đi xa là một mái nhà bình yên. Vợ không cần đứng trước.'
        : 'Đằng sau một người đàn ông đi xa là một mái nhà bình yên... bài đã ghim từ lâu';
    },
  };

  const result = await automation.captureReelByCaption(
    page,
    'https://www.facebook.com/example',
    'Đằng sau một người đàn ông đi xa là một mái nhà bình yên...',
    { vanity: 'example' },
    10,
    expected
  );

  assert.equal(result, 'https://www.facebook.com/reel/fresh-publish');
});

test('Reel with exact caption is accepted when Facebook omits timestamp metadata', async () => {
  const caption = 'Chạy ads mà vẫn đi cà phê, du lịch thảnh thơi — tin nổi không?';
  const candidate = 'https://www.facebook.com/share/r/AbC_123/';
  const automation = new FacebookAutomation({ sleep: async () => {} });
  automation._mediaPermalinksFromTabs = async () => [candidate];
  automation._pagePublishedNear = async () => ({ matched: false, timestamps: [] });
  const page = {
    async goto() {},
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes('document.body.innerText')) return caption;
      return 'https://www.facebook.com/reel/987654321';
    },
  };

  const result = await automation.captureReelByCaption(
    page,
    'https://www.facebook.com/vinhaiautomation',
    caption,
    { vanity: 'vinhaiautomation' },
    10,
    Date.now()
  );

  assert.equal(result, 'https://www.facebook.com/reel/987654321');
});

test('media link normalization supports current Facebook video URL shapes', () => {
  const automation = new FacebookAutomation({ sleep: async () => {} });
  const urls = [
    'https://www.facebook.com/share/r/AbC_123/',
    'https://www.facebook.com/watch/?v=123456789',
    'https://www.facebook.com/video.php?v=123456789',
    'https://www.facebook.com/reel/nonNumericToken',
  ];

  for (const url of urls) {
    assert.ok(automation.normalizeFacebookPostUrl(url), url);
  }
});

test('Group đã duyệt được chấp nhận sau giờ gửi nhưng bài ghim cũ vẫn bị loại', () => {
  const submittedAt = Date.parse('2026-09-03T14:31:16Z');
  const oldPinnedAt = submittedAt - 20 * 24 * 60 * 60 * 1000;
  const approvedLaterAt = submittedAt + 16 * 60 * 60 * 1000;

  assert.equal(publishedTimeMatches([oldPinnedAt], submittedAt, 2 * 60 * 60 * 1000, true), false);
  assert.equal(publishedTimeMatches([approvedLaterAt], submittedAt, 2 * 60 * 60 * 1000, true), true);
  assert.equal(publishedTimeMatches([approvedLaterAt], submittedAt), false);
});

test('dò bài Group dùng mốc thời gian cho phép duyệt muộn', async () => {
  const automation = new FacebookAutomation({ sleep: async () => {} });
  const candidate = 'https://www.facebook.com/groups/1001/posts/3003';
  let verificationOptions = null;
  automation._findGroupPostInFeed = async () => candidate;
  automation.verifyPublishedPostCandidate = async (
    _page,
    _postLink,
    _content,
    _publishedAtMs,
    options
  ) => {
    verificationOptions = options;
    return { matched: true, postLink: candidate };
  };

  const result = await automation.findGroupPost(
    {},
    'https://www.facebook.com/groups/1001',
    'Caption đã đăng và đang chờ duyệt',
    { publishedAtMs: Date.now() - 16 * 60 * 60 * 1000 }
  );

  assert.equal(result.postLink, candidate);
  assert.equal(verificationOptions.allowPublishedAfter, true);
});
