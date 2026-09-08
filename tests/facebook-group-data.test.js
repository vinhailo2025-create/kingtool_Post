const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-group-data-test-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const DataService = require('../src/services/data.service');

test('Post_group is optional and is not created when the Facebook data screen opens', async () => {
  await db.waitReady();
  DataService.ensurePlatformDefaultColumns('facebook');

  assert.equal(
    DataService.getCustomColumns('facebook').some(column => column.var_key === 'post_group'),
    false
  );
  assert.equal(
    DataService.getExportColumnSchema('facebook').some(column => column.var_key === 'post_group'),
    false
  );
});

test('group import aliases create Post_group only when at least one row has data', () => {
  DataService.importSheet([
    { 'Nội dung': 'No group', Post_group: '' },
  ], 'facebook');
  assert.equal(
    DataService.getCustomColumns('facebook').some(column => column.var_key === 'post_group'),
    false
  );

  const imported = DataService.importSheet([
    { 'Nội dung': 'A', Post_group: 'https://www.facebook.com/groups/1001' },
    { 'Nội dung': 'B', 'Link Group': 'https://facebook.com/groups/1002/' },
    { 'Nội dung': 'C', 'Group Link': 'https://web.facebook.com/groups/1003?ref=share' },
  ], 'facebook');
  const groupColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'post_group');
  assert.ok(groupColumn);
  assert.equal(groupColumn.name, 'Post_group');
  assert.equal(imported.imported, 3);

  const rows = DataService.getAllWithCustomData('facebook').slice(-3);
  assert.deepEqual(
    rows.map(row => row[`custom_${groupColumn.id}`]),
    [
      'https://www.facebook.com/groups/1001',
      'https://facebook.com/groups/1002/',
      'https://web.facebook.com/groups/1003?ref=share',
    ]
  );
});

test('Post_group export is conditional and ordered between Link Fanpage and content', () => {
  const schema = DataService.getExportColumnSchema('facebook');
  const headers = schema.map(column => column.header);
  assert.ok(headers.indexOf('Link Fanpage') < headers.indexOf('Post_group'));
  assert.ok(headers.indexOf('Post_group') < headers.indexOf('Nội dung'));

  const workbook = XLSX.read(DataService.exportToExcel('facebook'), { type: 'buffer' });
  const header = XLSX.utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]],
    { header: 1 }
  )[0];
  assert.ok(header.includes('Post_group'));

  const groupColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'post_group');
  DataService.deleteCustomColumn(groupColumn.id, 'facebook');
  const withoutGroup = XLSX.read(DataService.exportToExcel('facebook'), { type: 'buffer' });
  const withoutHeader = XLSX.utils.sheet_to_json(
    withoutGroup.Sheets[withoutGroup.SheetNames[0]],
    { header: 1 }
  )[0];
  assert.equal(withoutHeader.includes('Post_group'), false);
});

test('TikTok import never creates the Facebook-only Post_group column', () => {
  DataService.importSheet([
    { 'Nội dung': 'TikTok row', Post_group: 'https://facebook.com/groups/999' },
  ], 'tiktok');
  assert.equal(
    DataService.getCustomColumns('tiktok').some(column => column.var_key === 'post_group'),
    false
  );
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
