const assert = require('node:assert/strict');
const test = require('node:test');

const ManagedTargets = require('../src/services/managed-targets.service');

test('managed target catalog normalizes page and channel records', () => {
  const page = ManagedTargets._private.cleanTarget({
    id: '123',
    name: ' Fanpage A ',
    url: 'https://Facebook.com/page-a/?ref=home#top',
  }, 'facebook');
  const channel = ManagedTargets._private.cleanTarget({
    id: 'UC123',
    name: ' Kênh A ',
    url: 'https://www.youtube.com/channel/UC123/?view=0',
  }, 'youtube');

  assert.deepEqual(page, {
    id: '123',
    name: 'Fanpage A',
    url: 'https://facebook.com/page-a',
    type: 'facebook_page',
  });
  assert.deepEqual(channel, {
    id: 'UC123',
    name: 'Kênh A',
    url: 'https://www.youtube.com/channel/UC123',
    type: 'youtube_channel',
  });
});

test('managed target page and channel collection uses stable link selectors', async () => {
  const pages = [];
  const fakePage = {
    goto: async () => {},
    evaluate: async fn => {
      pages.push(String(fn));
      return [];
    },
  };
  await ManagedTargets._private.collectFromPage(fakePage, 'facebook');
  await ManagedTargets._private.collectFromPage(fakePage, 'youtube');
  assert.match(pages[0], /facebook/);
  assert.match(pages[1], /youtube/);
});
