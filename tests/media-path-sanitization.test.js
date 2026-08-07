const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'covergem-media-sanitize-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const db = require('../src/database/init');
const { sanitizeMediaPath } = require('../src/services/media-path.utils');

test('media path helper removes every double quote', () => {
  assert.equal(sanitizeMediaPath('"C:\\media\\"clip".mp4"'), 'C:\\media\\clip.mp4');
  assert.equal(sanitizeMediaPath(null), '');
});

test('all DataService write flows store Media without double quotes', async () => {
  await db.waitReady();
  const DataService = require('../src/services/data.service');

  const created = DataService.create({ image_path: '"C:\\create\\one.jpg"' }, 'facebook');
  assert.equal(created.image_path, 'C:\\create\\one.jpg');

  const updated = DataService.update(created.id, { image_path: 'C:\\update\\"two".mp4' }, 'facebook');
  assert.equal(updated.image_path, 'C:\\update\\two.mp4');

  const ids = DataService.createMany([{ image_path: '"C:\\many\\three.png"' }], 'tiktok');
  DataService.updateMany([{ id: ids[0], image_path: '"C:\\bulk\\four.mov"' }], 'tiktok');
  assert.equal(DataService.getAll('tiktok')[0].image_path, 'C:\\bulk\\four.mov');

  DataService.restoreMany([{ id: 900001, image_path: '"C:\\restore\\five.webp"' }], 'instagram');
  assert.equal(DataService.getAll('instagram')[0].image_path, 'C:\\restore\\five.webp');

  DataService.importSheet([{ Media: '"C:\\import\\six.mp4"' }], 'youtube');
  assert.equal(DataService.getAll('youtube')[0].image_path, 'C:\\import\\six.mp4');
});

test('database startup migration removes quotes already stored by older versions', async () => {
  await db.waitReady();
  db.prepare(`
    INSERT INTO posts (sort_order, content, image_path, status, platform)
    VALUES (1, '', '"C:\\legacy\\seven.jpg"', 'pending', 'x')
  `).run();

  db._createTables();
  assert.equal(db.prepare("SELECT image_path FROM posts WHERE platform = 'x'").get().image_path, 'C:\\legacy\\seven.jpg');
});

test.after(() => {
  try { db.close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
