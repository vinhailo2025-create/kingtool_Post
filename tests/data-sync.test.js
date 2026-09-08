const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-data-sync-test-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');

test('manual and automatic column sync match var_key and sync_key safely', async () => {
  await db.waitReady();
  const DataService = require('../src/services/data.service');
  const DataSyncService = require('../src/services/data-sync.service');

  const source = DataService.create({ content: 'Bản gốc', image_path: 'C:\\media\\video.mp4' }, 'facebook');
  const first = DataSyncService.execute({
    source_platform: 'facebook',
    source_var_key: 'content',
    source_post_ids: [source.id],
    target_platforms: ['tiktok', 'instagram'],
    conflict_policy: 'fill_empty',
    create_missing: true,
  });

  assert.equal(first.changed, 2);
  assert.equal(first.created, 2);
  const linkedSource = DataService.getAll('facebook')[0];
  const tiktok = DataService.getAll('tiktok')[0];
  const instagram = DataService.getAll('instagram')[0];
  assert.ok(linkedSource.sync_key);
  assert.equal(tiktok.sync_key, linkedSource.sync_key);
  assert.equal(instagram.sync_key, linkedSource.sync_key);
  assert.equal(tiktok.content, 'Bản gốc');

  DataService.update(tiktok.id, { content: 'Giữ dữ liệu đích' }, 'tiktok');
  DataService.update(source.id, { content: 'Nội dung mới' }, 'facebook');
  const safe = DataSyncService.execute({
    source_platform: 'facebook', source_var_key: 'content', source_post_ids: [source.id],
    target_platforms: ['tiktok'], conflict_policy: 'fill_empty', create_missing: true,
  });
  assert.equal(safe.changed, 0);
  assert.equal(DataService.getAll('tiktok')[0].content, 'Giữ dữ liệu đích');

  const overwrite = DataSyncService.execute({
    source_platform: 'facebook', source_var_key: 'content', source_post_ids: [source.id],
    target_platforms: ['tiktok'], conflict_policy: 'overwrite', create_missing: true,
  });
  assert.equal(overwrite.changed, 1);
  assert.equal(DataService.getAll('tiktok')[0].content, 'Nội dung mới');
  assert.equal(DataSyncService.undo(overwrite.run_id).restored, 1);
  assert.equal(DataService.getAll('tiktok')[0].content, 'Giữ dữ liệu đích');

  DataService.update(tiktok.id, { content: 'TikTok sửa ngược về Facebook' }, 'tiktok');
  const reverseDefault = DataSyncService.execute({
    source_platform: 'tiktok',
    source_var_key: 'content',
    source_post_ids: [tiktok.id],
    target_platforms: ['facebook'],
    create_missing: true,
  });
  assert.equal(reverseDefault.changed, 1);
  assert.equal(DataService.getAll('facebook')[0].content, 'TikTok sửa ngược về Facebook');

  DataSyncService.saveRules('tiktok', 'content', ['facebook'], {
    create_missing: true,
    enabled: true,
  });
  assert.equal(
    DataSyncService.getRules('tiktok', 'content')[0].conflict_policy,
    'overwrite'
  );
  DataService.update(tiktok.id, { content: 'TikTok tự động sửa Facebook' }, 'tiktok');
  const reverseAutomatic = DataSyncService.runAutomatic('tiktok', 'content', [tiktok.id]);
  assert.equal(reverseAutomatic.changed, 1);
  assert.equal(DataService.getAll('facebook')[0].content, 'TikTok tự động sửa Facebook');

  const sourceColumn = DataService.addCustomColumn('Chiến dịch', 'text', 'campaign', 'facebook');
  DataService.setCustomData(source.id, sourceColumn.id, 'Summer 2026', 'facebook');
  const customRun = DataSyncService.execute({
    source_platform: 'facebook', source_var_key: 'campaign', source_post_ids: [source.id],
    target_platforms: ['threads'], conflict_policy: 'fill_empty', create_missing: true,
  });
  assert.equal(customRun.changed, 1);
  const targetColumn = DataService.getCustomColumns('threads').find(column => column.var_key === 'campaign');
  assert.ok(targetColumn);
  const threadsRow = DataService.getAllWithCustomData('threads')[0];
  assert.equal(threadsRow[`custom_${targetColumn.id}`], 'Summer 2026');

  DataSyncService.saveRules('facebook', 'image_path', ['youtube', 'x'], {
    conflict_policy: 'overwrite', create_missing: true, enabled: true,
  });
  const automatic = DataSyncService.runAutomatic('facebook', 'image_path', [source.id]);
  assert.equal(automatic.changed, 2);
  assert.equal(DataService.getAll('youtube')[0].image_path, 'C:\\media\\video.mp4');
  assert.equal(DataService.getAll('x')[0].image_path, 'C:\\media\\video.mp4');

  const preview = DataSyncService.preview({
    source_platform: 'facebook', source_var_key: 'image_path', source_post_ids: [source.id],
    target_platforms: ['youtube'], conflict_policy: 'fill_empty', create_missing: true,
  });
  assert.equal(preview.total_changes, 0);
  assert.equal(preview.targets[0].conflicts, 0);

  for (const platform of ['youtube', 'threads', 'instagram', 'x', 'zalovideo']) {
    const platformSource = DataService.create(
      { content: `${platform} → Facebook` },
      platform
    );
    const reverse = DataSyncService.execute({
      source_platform: platform,
      source_var_key: 'content',
      source_post_ids: [platformSource.id],
      target_platforms: ['facebook'],
      create_missing: true,
    });
    assert.equal(reverse.changed, 1, `${platform} must sync to Facebook`);
    const linkedPlatformSource = DataService.getAll(platform)
      .find(item => item.id === platformSource.id);
    const target = DataService.getAll('facebook')
      .find(row => row.sync_key === linkedPlatformSource.sync_key);
    assert.equal(target.content, `${platform} → Facebook`);
  }

  const zaloSource = DataService.getAll('zalovideo')
    .find(row => row.content === 'zalovideo → Facebook');
  const fanOut = DataSyncService.execute({
    source_platform: 'zalovideo',
    source_var_key: 'content',
    source_post_ids: [zaloSource.id],
    target_platforms: ['tiktok', 'youtube', 'threads'],
    create_missing: true,
  });
  assert.equal(fanOut.changed, 3);
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
