const test = require('node:test');
const assert = require('node:assert/strict');

const FacebookAdapter = require('../src/platforms/facebook.adapter');
const { FacebookAutomation } = FacebookAdapter._private;

test('Facebook fanpage targets are normalized and unsafe targets are rejected', () => {
  const automation = new FacebookAutomation();

  assert.equal(
    automation.normalizeFacebookTargetUrl('facebook.com/covergem?ref=bookmarks'),
    'https://www.facebook.com/covergem'
  );
  assert.equal(
    automation.normalizeFacebookTargetUrl('https://m.facebook.com/profile.php?id=123456&ref=test'),
    'https://www.facebook.com/profile.php?id=123456'
  );
  assert.equal(
    automation.normalizeFacebookTargetUrl('https://www.facebook.com/pages/Cover-Gem/123456/'),
    'https://www.facebook.com/pages/Cover-Gem/123456'
  );
  assert.equal(
    automation.normalizeFacebookTargetUrl('https://www.facebook.com/people/Cover-Gem/123456/?ref=page'),
    'https://www.facebook.com/people/Cover-Gem/123456'
  );
  assert.equal(automation.normalizeFacebookTargetUrl('https://facebook.com/groups/123'), '');
  assert.equal(automation.normalizeFacebookTargetUrl('https://facebook.com/covergem/posts/456'), '');
  assert.equal(automation.normalizeFacebookTargetUrl('https://example.com/covergem'), '');
});

test('Fanpage owner detection does not overwrite the page with the signed-in profile id', async () => {
  const automation = new FacebookAutomation();
  const page = {
    cookies: async () => [{ name: 'c_user', value: '999999' }],
  };

  assert.deepEqual(
    await automation.getProfileOwner(page, 'https://www.facebook.com/covergem', {
      includeSessionId: false,
    }),
    { vanity: 'covergem', id: null }
  );
  assert.deepEqual(
    await automation.getProfileOwner(page, 'https://www.facebook.com/profile.php?id=123456', {
      includeSessionId: false,
    }),
    { vanity: null, id: '123456' }
  );
  assert.deepEqual(
    await automation.getProfileOwner(page, 'https://www.facebook.com/profile.php?id=999999'),
    { vanity: null, id: '999999' }
  );
});

test('Profile posting clears a previously selected page identity', async () => {
  const automation = new FacebookAutomation({ sleep: async () => {} });
  const deleted = [];
  const navigated = [];
  automation._gotoFacebookPage = async (page, url) => navigated.push(url);
  const page = {
    cookies: async () => [
      { name: 'c_user', value: '999999', domain: '.facebook.com', path: '/' },
      { name: 'i_user', value: '123456', domain: '.facebook.com', path: '/' },
    ],
    deleteCookie: async cookie => deleted.push(cookie),
  };

  assert.equal(await automation._leavePageIdentity(page), true);
  assert.deepEqual(deleted, [{ name: 'i_user', domain: '.facebook.com', path: '/' }]);
  assert.deepEqual(navigated, ['https://www.facebook.com/']);
});

test('Numeric fanpage links activate the exact Facebook page identity', async () => {
  const automation = new FacebookAutomation();
  const cookies = [];
  const page = {
    setCookie: async cookie => cookies.push(cookie),
  };

  assert.equal(
    await automation._activateNumericPageIdentity(
      page,
      'https://www.facebook.com/profile.php?id=61570755323811'
    ),
    true
  );
  assert.equal(cookies[0].name, 'i_user');
  assert.equal(cookies[0].value, '61570755323811');
  assert.equal(
    await automation._activateNumericPageIdentity(
      page,
      'https://www.facebook.com/people/Cover-Gem/61570755323811'
    ),
    true
  );
  assert.equal(cookies[1].value, '61570755323811');
  assert.equal(
    await automation._activateNumericPageIdentity(page, 'https://www.facebook.com/covergem'),
    false
  );
});

test('Invalid fanpage data fails before browser navigation', async () => {
  const automation = new FacebookAutomation({
    buildVarMap: () => ({
      content: 'test',
      media: '',
      link_fanpage: 'https://example.com/not-facebook',
    }),
  });

  await assert.rejects(
    automation.publish({}, { id: 1 }),
    error => error.code === 'FACEBOOK_FANPAGE_URL_INVALID'
  );
});
