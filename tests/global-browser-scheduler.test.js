const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-global-workspace-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const BrowserService = require('../src/services/browser.service');
let SchedulerService;

test.before(async () => {
  await db.waitReady();
  SchedulerService = require('../src/services/scheduler.service');
});

test('profile mới và profile cũ đều dùng chung trên mọi nền tảng', async () => {
  const profile = BrowserService.create({ name: 'Global profile' });
  for (const platform of ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo']) {
    assert.equal(BrowserService.getAll(platform).some(item => item.id === profile.id), true);
  }
  assert.equal(BrowserService.getAll('all').filter(item => item.id === profile.id).length, 1);
});

test('lịch toàn cục tổng hợp và thao tác được lịch của mọi nền tảng', () => {
  const profile = BrowserService.getAll('all')[0];
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const facebook = SchedulerService.create({
    name: 'Facebook schedule',
    schedule_time: future,
    profile_ids: [profile.id],
    data_ids: 'all',
    platform: 'facebook',
  });
  const tiktok = SchedulerService.create({
    name: 'TikTok schedule',
    schedule_time: future,
    profile_ids: [profile.id],
    data_ids: 'all',
    platform: 'tiktok',
  });

  assert.equal(SchedulerService.getAll('all').length, 2);
  assert.equal(SchedulerService.getAll('facebook').length, 1);
  assert.equal(SchedulerService.getAll('tiktok').length, 1);
  assert.equal(
    SchedulerService.update(tiktok.id, { name: 'TikTok updated' }, 'all').name,
    'TikTok updated'
  );
  assert.equal(SchedulerService.toggle(facebook.id, 'all').enabled, 0);
  assert.ok(SchedulerService.delete(facebook.id, 'all'));
  assert.ok(SchedulerService.delete(tiktok.id, 'all'));
  assert.equal(SchedulerService.getAll('all').length, 0);
});

test.after(async () => {
  try { SchedulerService.stopAllJobs(); } catch (_) {}
  for (const profile of BrowserService.getAll('all')) {
    try { await BrowserService.delete(profile.id); } catch (_) {}
  }
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
