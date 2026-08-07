const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-fanpage-data-test-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');

test('Facebook data imports and exports the Link Fanpage column', async () => {
  await db.waitReady();
  const DataService = require('../src/services/data.service');

  const result = DataService.importSheet([
    {
      'Nội dung': 'Fanpage test row',
      'Link Fanpage': 'https://www.facebook.com/covergem',
    },
    {
      'Nội dung': 'Profile test row',
      'Link Fanpage': '',
    },
  ], 'facebook');

  assert.equal(result.imported, 2);
  const fanpageColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'link_fanpage');
  assert.ok(fanpageColumn);

  const rows = DataService.getAllWithCustomData('facebook');
  assert.equal(rows[0][`custom_${fanpageColumn.id}`], 'https://www.facebook.com/covergem');
  assert.equal(rows[1][`custom_${fanpageColumn.id}`], '');

  const workbook = XLSX.read(DataService.exportToExcel('facebook'), { type: 'buffer' });
  const exported = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
  assert.equal(exported[0]['Link Fanpage'], 'https://www.facebook.com/covergem');
  assert.equal(exported[1]['Link Fanpage'], '');
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
