/**
 * CovergemAuto - Settings & Backup Routes
 * Mounted at /api/settings
 */

const express = require('express');
const router = express.Router();
const BackupService = require('../services/backup.service');
const { normalizePlatform, scopedSettingKey } = require('../platforms/platform.utils');
const PLATFORM_KEYS = new Set([
  'field_overrides',
  'auto_comment_enabled',
  'comment_delay_unit',
  'comment_delay_min',
  'comment_delay_max',
]);

function platformOf(req) {
  return normalizePlatform(req.query.platform);
}

// ============================================
// Settings
// ============================================

/**
 * GET /api/settings
 * Get all settings as key-value object
 */
router.get('/', (req, res) => {
  try {
    const settings = BackupService.getSettings();
    const platform = platformOf(req);
    if (platform !== 'facebook') {
      for (const key of PLATFORM_KEYS) {
        const scoped = scopedSettingKey(platform, key);
        if (Object.prototype.hasOwnProperty.call(settings, scoped)) settings[key] = settings[scoped];
      }
    }
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/settings
 * Update settings with key-value pairs
 * Body: { key: value, ... }
 */
router.put('/', (req, res) => {
  try {
    const platform = platformOf(req);
    const settings = {};
    for (const [key, value] of Object.entries(req.body || {})) {
      settings[PLATFORM_KEYS.has(key) ? scopedSettingKey(platform, key) : key] = value;
    }
    if (!settings || typeof settings !== 'object' || Object.keys(settings).length === 0) {
      return res.status(400).json({ error: 'Dữ liệu cài đặt không hợp lệ' });
    }

    BackupService.updateSettings(settings);
    res.json({ success: true, data: { message: 'Đã lưu cài đặt' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Backup
// ============================================

/**
 * POST /api/settings/backup/create
 * Create a new backup
 */
router.post('/backup/create', async (req, res) => {
  try {
    const result = await BackupService.createBackup();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: 'Tạo backup thất bại: ' + err.message });
  }
});

/**
 * GET /api/settings/backup/list
 * List all backups
 */
router.get('/backup/list', (req, res) => {
  try {
    const backups = BackupService.listBackups();
    res.json({ success: true, data: backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/settings/backup/restore/:filename
 * Restore from a backup file
 */
router.post('/backup/restore/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).json({ error: 'Thiếu tên file backup' });
    }

    const result = await BackupService.restoreBackup(filename);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: 'Khôi phục thất bại: ' + err.message });
  }
});

/**
 * DELETE /api/settings/backup/:filename
 * Delete a backup file
 */
router.delete('/backup/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).json({ error: 'Thiếu tên file backup' });
    }

    BackupService.deleteBackup(filename);
    res.json({ success: true, data: { message: 'Đã xóa backup' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
