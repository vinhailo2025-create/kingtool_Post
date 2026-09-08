const test = require('node:test');
const assert = require('node:assert/strict');

const FacebookAdapter = require('../src/platforms/facebook.adapter');
const { FacebookAutomation, extractFacebookEntityId } = FacebookAdapter._private;

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
  let actingAsPage = true;
  automation._gotoFacebookPage = async (page, url) => navigated.push(url);
  const page = {
    cookies: async () => [
      { name: 'c_user', value: '999999', domain: '.facebook.com', path: '/' },
      ...(actingAsPage
        ? [{ name: 'i_user', value: '123456', domain: '.facebook.com', path: '/' }]
        : []),
    ],
    deleteCookie: async cookie => {
      deleted.push(cookie);
      actingAsPage = false;
    },
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

test('Facebook Group URLs are normalized separately from Fanpage identity', () => {
  const automation = new FacebookAutomation();

  assert.equal(
    automation.normalizeFacebookGroupUrl('facebook.com/groups/123456/?ref=share'),
    'https://www.facebook.com/groups/123456'
  );
  assert.equal(
    automation.normalizeFacebookGroupUrl('https://web.facebook.com/groups/my-group'),
    'https://www.facebook.com/groups/my-group'
  );
  assert.equal(
    automation.normalizeFacebookGroupUrl('https://facebook.com/groups/123/posts/456'),
    ''
  );
  assert.equal(automation.normalizeFacebookGroupUrl('https://facebook.com/covergem'), '');

  const target = automation.resolvePublishTarget({
    content: 'Group target',
    post_group: 'https://facebook.com/groups/123456',
    link_fanpage: 'https://facebook.com/profile.php?id=777',
  });
  assert.equal(target.targetType, 'group');
  assert.equal(target.groupHref, 'https://www.facebook.com/groups/123456');
  assert.equal(target.fanpageHref, 'https://www.facebook.com/profile.php?id=777');

  const groupAsProfile = automation.resolvePublishTarget({
    content: 'Profile into Group',
    post_group: 'https://facebook.com/groups/123456',
    link_fanpage: '',
  });
  assert.equal(groupAsProfile.targetType, 'group');
  assert.equal(groupAsProfile.fanpageHref, '');

  const legacyProfile = automation.resolvePublishTarget({
    content: 'Legacy Profile',
    post_group: '',
    link_fanpage: '',
  });
  assert.equal(legacyProfile.targetType, 'profile');
  const legacyFanpage = automation.resolvePublishTarget({
    content: 'Legacy Fanpage',
    post_group: '',
    link_fanpage: 'https://facebook.com/profile.php?id=777',
  });
  assert.equal(legacyFanpage.targetType, 'fanpage');
});

test('Invalid Group data fails before browser navigation', async () => {
  const automation = new FacebookAutomation({
    buildVarMap: () => ({
      content: 'test',
      media: '',
      link_fanpage: '',
      post_group: 'https://example.com/groups/123',
    }),
  });

  await assert.rejects(
    automation.publish({}, { id: 1 }),
    error => error.code === 'FACEBOOK_GROUP_URL_INVALID'
  );
});

test('posting identity is restored to Profile even when Group publishing fails', async () => {
  const automation = new FacebookAutomation({ sleep: async () => {} });
  const calls = [];
  automation._leavePageIdentity = async () => {
    calls.push('profile');
    return true;
  };

  await assert.rejects(
    automation._withRestoredProfileIdentity({}, async () => {
      calls.push('publish');
      throw new Error('composer changed');
    }),
    /composer changed/
  );
  assert.deepEqual(calls, ['profile', 'publish', 'profile']);
});

test('Fanpage identity verification rejects a different i_user', async () => {
  const automation = new FacebookAutomation();
  const page = {
    cookies: async () => [
      { name: 'c_user', value: '100' },
      { name: 'i_user', value: '999' },
    ],
  };
  await assert.rejects(
    automation._verifyPageIdentity(
      page,
      'https://www.facebook.com/profile.php?id=777'
    ),
    error => error.code === 'FACEBOOK_PAGE_IDENTITY_MISMATCH'
  );
});

test('Vanity Fanpage resolves its numeric identity from Facebook route data', () => {
  const html = [
    '<script>',
    '{"userID":"100063491983075","userVanity":"CoachKDOL.MVP","viewerID":"100"}',
    '</script>',
  ].join('');
  assert.equal(
    extractFacebookEntityId(html, 'https://www.facebook.com/CoachKDOL.MVP/'),
    '100063491983075'
  );
  assert.equal(
    extractFacebookEntityId(html, 'https://www.facebook.com/another-page/'),
    ''
  );
});

test('Vanity Fanpage identity recovers by setting the resolved numeric i_user', async () => {
  const automation = new FacebookAutomation({ sleep: async () => {} });
  const calls = [];
  let recovered = false;
  automation._switchToPageIfPrompted = async () => false;
  automation._readPageIdentityId = async () => '100063491983075';
  automation._activateNumericPageIdentity = async (_page, href) => {
    calls.push(['activate', href]);
    recovered = true;
    return true;
  };
  automation._gotoFacebookPage = async (_page, href) => calls.push(['goto', href]);
  automation._verifyPageIdentity = async (_page, href) => {
    if (!recovered) {
      const error = new Error('identity missing');
      error.code = 'FACEBOOK_PAGE_IDENTITY_MISMATCH';
      throw error;
    }
    assert.equal(
      href,
      'https://www.facebook.com/profile.php?id=100063491983075'
    );
    return { cUser: '100', iUser: '100063491983075' };
  };

  const result = await automation._verifyOrRecoverPageIdentity(
    {},
    'https://www.facebook.com/CoachKDOL.MVP/'
  );
  assert.equal(result.iUser, '100063491983075');
  assert.deepEqual(calls, [
    ['activate', 'https://www.facebook.com/profile.php?id=100063491983075'],
    ['goto', 'https://www.facebook.com/CoachKDOL.MVP/'],
  ]);
});
