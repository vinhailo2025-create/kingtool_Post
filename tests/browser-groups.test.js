const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-browser-groups-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const BrowserService = require('../src/services/browser.service');

test('một profile thuộc nhiều nhóm và số lượng nhóm dùng chung toàn tool', async () => {
  await db.waitReady();
  const first = BrowserService.create({ name: 'Profile nhóm 1' }, 'facebook');
  const second = BrowserService.create({ name: 'Profile nhóm 2' }, 'facebook');
  BrowserService.syncProfiles([first.id], 'tiktok');

  const sales = BrowserService.createGroup('Bán hàng', 'facebook');
  const review = BrowserService.createGroup('Review', 'facebook');
  assert.throws(
    () => BrowserService.createGroup('bán HÀNG', 'facebook'),
    /đã tồn tại/
  );

  BrowserService.assignGroups([first.id], [sales.id, review.id], 'replace', 'facebook');
  BrowserService.assignGroups([second.id], [review.id], 'add', 'facebook');

  const facebookProfiles = BrowserService.getAll('facebook');
  assert.deepEqual(
    facebookProfiles.find(profile => profile.id === first.id).groups.map(group => group.name),
    ['Bán hàng', 'Review']
  );
  assert.deepEqual(
    facebookProfiles.find(profile => profile.id === second.id).groups.map(group => group.name),
    ['Review']
  );

  const facebookGroups = BrowserService.getGroups('facebook');
  assert.equal(facebookGroups.find(group => group.id === sales.id).profile_count, 1);
  assert.equal(facebookGroups.find(group => group.id === review.id).profile_count, 2);
  const tiktokGroups = BrowserService.getGroups('tiktok');
  assert.equal(tiktokGroups.find(group => group.id === sales.id).profile_count, 1);
  assert.equal(tiktokGroups.find(group => group.id === review.id).profile_count, 2);
  const globalGroups = BrowserService.getGroups('all');
  assert.equal(globalGroups.find(group => group.id === review.id).profile_count, 2);
});

test('thêm, gỡ, thay thế và xóa nhóm không xóa profile', () => {
  const profiles = BrowserService.getAll('facebook');
  const first = profiles.find(profile => profile.name === 'Profile nhóm 1');
  const second = profiles.find(profile => profile.name === 'Profile nhóm 2');
  const groups = BrowserService.getGroups('facebook');
  const sales = groups.find(group => group.name === 'Bán hàng');
  const review = groups.find(group => group.name === 'Review');

  BrowserService.assignGroups([second.id], [sales.id], 'add', 'facebook');
  assert.deepEqual(
    BrowserService.getById(second.id) && BrowserService.getAll('facebook')
      .find(profile => profile.id === second.id).groups.map(group => group.name),
    ['Bán hàng', 'Review']
  );

  BrowserService.assignGroups([second.id], [review.id], 'remove', 'facebook');
  assert.deepEqual(
    BrowserService.getAll('facebook').find(profile => profile.id === second.id)
      .groups.map(group => group.name),
    ['Bán hàng']
  );

  BrowserService.assignGroups([first.id, second.id], [], 'replace', 'facebook');
  assert.equal(
    BrowserService.getAll('facebook').filter(profile => [first.id, second.id].includes(profile.id))
      .every(profile => profile.groups.length === 0),
    true
  );

  BrowserService.assignGroups([first.id], [sales.id, review.id], 'replace', 'facebook');
  BrowserService.deleteGroup(sales.id);
  const preserved = BrowserService.getAll('facebook').find(profile => profile.id === first.id);
  assert.ok(preserved);
  assert.deepEqual(preserved.groups.map(group => group.name), ['Review']);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
