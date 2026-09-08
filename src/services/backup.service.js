/**
 * Super Post - King - Backup & Settings Service
 * Handles backup creation/restore and settings management
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const archiver = require('archiver');
const unzipper = require('unzipper');
const config = require('../../config');
const db = require('../database/init');

const MAX_RESTORE_FILES = 100000;
const MAX_RESTORE_BYTES = 20 * 1024 * 1024 * 1024;

function safeRestoreEntry(entryPath) {
  const portable = String(entryPath || '').replace(/\\/g, '/');
  if (!portable || portable.includes('\0') || portable.startsWith('/') || /^[a-z]:/i.test(portable)) {
    throw new Error(`Backup chứa đường dẫn không an toàn: ${entryPath}`);
  }

  const normalized = path.posix.normalize(portable).replace(/\/+$/, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Backup chứa đường dẫn không an toàn: ${entryPath}`);
  }

  const allowed = normalized === 'covergem.db'
    || normalized === 'covergem.db-wal'
    || normalized === 'covergem.db-shm'
    || normalized === 'chrome-profiles'
    || normalized.startsWith('chrome-profiles/');
  if (!allowed) return '';
  return normalized;
}

function isSymbolicLink(entry) {
  const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function extractBackupSafely(backupPath, tempDir) {
  const archive = await unzipper.Open.file(backupPath);
  let fileCount = 0;
  let totalBytes = 0;
  const approved = [];

  // Validate the complete central directory before writing the first file.
  for (const entry of archive.files) {
    const relative = safeRestoreEntry(entry.path);
    if (!relative) continue;
    if (isSymbolicLink(entry)) {
      throw new Error(`Backup chứa liên kết không được hỗ trợ: ${entry.path}`);
    }
    if (entry.type !== 'File' && entry.type !== 'Directory') {
      throw new Error(`Backup chứa mục không được hỗ trợ: ${entry.path}`);
    }
    if (entry.type === 'File') {
      fileCount += 1;
      totalBytes += Number(entry.uncompressedSize) || 0;
      if (fileCount > MAX_RESTORE_FILES || totalBytes > MAX_RESTORE_BYTES) {
        throw new Error('Backup vượt quá giới hạn khôi phục an toàn.');
      }
    }
    approved.push({ entry, relative });
  }

  const resolvedRoot = path.resolve(tempDir);
  for (const { entry, relative } of approved) {
    const destination = path.resolve(resolvedRoot, ...relative.split('/'));
    const insideRoot = destination === resolvedRoot
      || destination.startsWith(`${resolvedRoot}${path.sep}`);
    if (!insideRoot) throw new Error(`Backup chứa đường dẫn không an toàn: ${entry.path}`);

    if (entry.type === 'Directory') {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await pipeline(entry.stream(), fs.createWriteStream(destination, { flags: 'wx' }));
  }
}

const BackupService = {
  /**
   * Create a backup zip containing DB + chrome profiles
   * @returns {{ filename: string, size: number, createdAt: string }}
   */
  async createBackup() {
    // Ensure backups directory exists
    if (!fs.existsSync(config.BACKUPS_DIR)) {
      fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });
    }

    const now = new Date();
    const timestamp = now.getFullYear()
      + '-' + String(now.getMonth() + 1).padStart(2, '0')
      + '-' + String(now.getDate()).padStart(2, '0')
      + '_' + String(now.getHours()).padStart(2, '0')
      + '-' + String(now.getMinutes()).padStart(2, '0')
      + '-' + String(now.getSeconds()).padStart(2, '0');

    const filename = `backup_${timestamp}.zip`;
    const outputPath = path.join(config.BACKUPS_DIR, filename);

    // Run WAL checkpoint to flush pending writes to the main DB file
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      // Non-critical, continue
    }

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      output.on('close', () => {
        const stats = fs.statSync(outputPath);
        resolve({
          filename,
          size: stats.size,
          createdAt: now.toISOString(),
        });
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);

      // Add database file
      if (fs.existsSync(config.DB_PATH)) {
        archive.file(config.DB_PATH, { name: 'covergem.db' });
      }

      // Also include WAL and SHM files if they exist (for consistency)
      const walPath = config.DB_PATH + '-wal';
      const shmPath = config.DB_PATH + '-shm';
      if (fs.existsSync(walPath)) {
        archive.file(walPath, { name: 'covergem.db-wal' });
      }
      if (fs.existsSync(shmPath)) {
        archive.file(shmPath, { name: 'covergem.db-shm' });
      }

      // Add chrome-profiles directory
      if (fs.existsSync(config.CHROME_PROFILES_DIR)) {
        archive.directory(config.CHROME_PROFILES_DIR, 'chrome-profiles');
      }

      archive.finalize();
    });
  },

  /**
   * List all backup files sorted by date descending
   * @returns {Array<{ filename: string, size: number, createdAt: string }>}
   */
  listBackups() {
    if (!fs.existsSync(config.BACKUPS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(config.BACKUPS_DIR)
      .filter(f => f.startsWith('backup_') && f.endsWith('.zip'));

    const backups = files.map(filename => {
      const filePath = path.join(config.BACKUPS_DIR, filename);
      const stats = fs.statSync(filePath);
      return {
        filename,
        size: stats.size,
        createdAt: stats.mtime.toISOString(),
      };
    });

    // Sort by date descending (newest first)
    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return backups;
  },

  /**
   * Restore from a backup zip file
   * @param {string} filename - The backup zip filename
   * @returns {{ message: string }}
   */
  async restoreBackup(filename) {
    // Sanitize filename to prevent path traversal
    const sanitized = path.basename(filename);
    const backupPath = path.join(config.BACKUPS_DIR, sanitized);

    if (!fs.existsSync(backupPath)) {
      throw new Error('Backup file không tồn tại');
    }

    // Close all active Chrome instances first
    try {
      const BrowserService = require('./browser.service');
      if (BrowserService && typeof BrowserService.closeAll === 'function') {
        await BrowserService.closeAll();
      }
    } catch (e) {
      // BrowserService may not be available, continue
    }

    // Create temp directory for extraction
    const tempDir = path.join(config.BACKUPS_DIR, '_restore_temp_' + Date.now());
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    try {
      await extractBackupSafely(backupPath, tempDir);

      // Restore database file
      const tempDbPath = path.join(tempDir, 'covergem.db');
      if (fs.existsSync(tempDbPath)) {
        // Close the database connection before copying
        try {
          db.close();
        } catch (e) {
          // Already closed or error, continue
        }

        // Copy the database file
        fs.copyFileSync(tempDbPath, config.DB_PATH);

        // Also copy WAL and SHM files if they exist in backup
        const tempWalPath = path.join(tempDir, 'covergem.db-wal');
        const tempShmPath = path.join(tempDir, 'covergem.db-shm');
        const walPath = config.DB_PATH + '-wal';
        const shmPath = config.DB_PATH + '-shm';

        if (fs.existsSync(tempWalPath)) {
          fs.copyFileSync(tempWalPath, walPath);
        } else if (fs.existsSync(walPath)) {
          // Remove existing WAL if backup doesn't have one
          fs.unlinkSync(walPath);
        }

        if (fs.existsSync(tempShmPath)) {
          fs.copyFileSync(tempShmPath, shmPath);
        } else if (fs.existsSync(shmPath)) {
          fs.unlinkSync(shmPath);
        }
      }

      // Restore chrome-profiles directory
      const tempProfilesDir = path.join(tempDir, 'chrome-profiles');
      if (fs.existsSync(tempProfilesDir)) {
        // Ensure target directory exists
        if (!fs.existsSync(config.CHROME_PROFILES_DIR)) {
          fs.mkdirSync(config.CHROME_PROFILES_DIR, { recursive: true });
        }

        // Copy all profiles from backup to chrome-profiles dir
        copyDirRecursive(tempProfilesDir, config.CHROME_PROFILES_DIR);
      }

      return {
        message: 'Khôi phục thành công! Vui lòng khởi động lại server để áp dụng thay đổi database.',
      };
    } finally {
      // Clean up temp directory
      try {
        deleteDirRecursive(tempDir);
      } catch (e) {
        // Non-critical cleanup error
      }
    }
  },

  /**
   * Delete a backup zip file
   * @param {string} filename - The backup zip filename
   */
  deleteBackup(filename) {
    const sanitized = path.basename(filename);
    const backupPath = path.join(config.BACKUPS_DIR, sanitized);

    if (!fs.existsSync(backupPath)) {
      throw new Error('Backup file không tồn tại');
    }

    fs.unlinkSync(backupPath);
  },

  /**
   * Get all settings as key-value object
   * @returns {Object}
   */
  getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return settings;
  },

  /**
   * Update settings with key-value pairs
   * @param {Object} settings - { key: value, ... }
   */
  updateSettings(settings) {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const updateMany = db.transaction((entries) => {
      for (const [key, value] of entries) {
        stmt.run(key, String(value));
      }
    });
    updateMany(Object.entries(settings));
  },
};

/**
 * Recursively copy a directory
 */
function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Recursively delete a directory
 */
function deleteDirRecursive(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

module.exports = BackupService;
module.exports._private = { safeRestoreEntry, isSymbolicLink, extractBackupSafely };
