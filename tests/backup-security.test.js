const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const archiver = require('archiver');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'super-post-backup-security-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;
const BackupService = require('../src/services/backup.service');

function createZip(zipPath, entries) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const [name, content] of entries) archive.append(content, { name });
    archive.finalize();
  });
}

test('backup restore chỉ chấp nhận database và chrome-profiles trong thư mục tạm', () => {
  const { safeRestoreEntry } = BackupService._private;
  assert.equal(safeRestoreEntry('covergem.db'), 'covergem.db');
  assert.equal(
    safeRestoreEntry('chrome-profiles/Profile 1/Preferences'),
    'chrome-profiles/Profile 1/Preferences'
  );
  assert.equal(safeRestoreEntry('notes.txt'), '');
  assert.throws(() => safeRestoreEntry('../outside.txt'), /không an toàn/);
  assert.throws(() => safeRestoreEntry('C:\\outside.txt'), /không an toàn/);
  assert.throws(() => safeRestoreEntry('/outside.txt'), /không an toàn/);
});

test('safe extractor bỏ file ngoài manifest và chỉ ghi vào restore root', async () => {
  const zipPath = path.join(testRoot, 'safe-backup.zip');
  const restoreRoot = path.join(testRoot, 'restore');
  fs.mkdirSync(restoreRoot, { recursive: true });
  await createZip(zipPath, [
    ['covergem.db', 'database'],
    ['chrome-profiles/Profile 1/Preferences', 'profile'],
    ['not-part-of-backup.txt', 'ignored'],
  ]);

  await BackupService._private.extractBackupSafely(zipPath, restoreRoot);
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'covergem.db'), 'utf8'), 'database');
  assert.equal(
    fs.readFileSync(path.join(restoreRoot, 'chrome-profiles', 'Profile 1', 'Preferences'), 'utf8'),
    'profile'
  );
  assert.equal(fs.existsSync(path.join(restoreRoot, 'not-part-of-backup.txt')), false);
});

test.after(() => {
  try { require('../src/database/init').close(); } catch (_) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});
