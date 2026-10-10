/**
 * Super Post - King - Settings & Backup Routes
 * Mounted at /api/settings
 */

const express = require('express');
const router = express.Router();
const BackupService = require('../services/backup.service');
const AgentKitService = require('../services/agent-kit.service');
const CloudMcpService = require('../services/cloud-mcp.service');
const { normalizePlatform, scopedSettingKey } = require('../platforms/platform.utils');
const PLATFORM_KEYS = new Set([
  'field_overrides',
  'add_ai_label',
  'text_background_mode',
  'text_background_index',
  'posts_per_profile_per_run',
  'auto_comment_enabled',
  'comment_delay_unit',
  'comment_delay_min',
  'comment_delay_max',
  'comment_intervals',
  'comment_continue_on_error',
  'anti_bot_enabled',
  'anti_bot_extra_safe_enabled',
  'anti_bot_preset',
  'anti_bot_action_min',
  'anti_bot_action_max',
  'anti_bot_open_delay_min_ms',
  'anti_bot_open_delay_max_ms',
  'anti_bot_action_delay_min_ms',
  'anti_bot_action_delay_max_ms',
  'anti_bot_read_delay_min_ms',
  'anti_bot_read_delay_max_ms',
  'anti_bot_before_post_min_ms',
  'anti_bot_before_post_max_ms',
  'anti_bot_max_total_ms',
  'anti_bot_extra_probability',
  'anti_bot_full_each_post',
  'anti_bot_on_error',
  'navigation_timeout_ms',
  'editor_timeout_ms',
  'upload_timeout_ms',
  'publish_timeout_ms',
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

router.get('/agent-mcp/status', (_req, res) => {
  try {
    res.json({ success: true, data: AgentKitService.status() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/agent-mcp/install', async (_req, res) => {
  try {
    const data = await AgentKitService.installOrRepair();
    res.json({
      success: true,
      data,
      message: 'Da cai dat va sua ket noi Agent & MCP.',
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      code: err.code || 'AGENT_KIT_INSTALL_FAILED',
    });
  }
});

router.get('/cloud-mcp/status', (_req, res) => {
  res.json({ success: true, data: CloudMcpService.status() });
});

router.post('/cloud-mcp/connect', async (_req, res) => {
  try {
    const data = await CloudMcpService.connectNow();
    res.json({ success: true, data, message: 'Dang ket noi Cloud MCP.' });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      code: err.code || 'CLOUD_MCP_CONNECT_FAILED',
    });
  }
});

router.post('/cloud-mcp/disconnect', async (_req, res) => {
  try {
    const data = await CloudMcpService.disconnect();
    res.json({ success: true, data, message: 'Da ngat Cloud MCP.' });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      code: err.code || 'CLOUD_MCP_DISCONNECT_FAILED',
    });
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
