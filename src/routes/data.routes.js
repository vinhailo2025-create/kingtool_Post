/**
 * Data Routes - API endpoints for posts management
 * Mounted at /api/data
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const DataService = require('../services/data.service');
const DataSyncService = require('../services/data-sync.service');
const { normalizePlatform } = require('../platforms/platform.utils');
const CommentJobService = require('../services/comment-job.service');
const CommentColumns = require('../services/comment-columns.service');

function platformOf(req) {
  const value = req.query.platform || (req.body && req.body.platform);
  return normalizePlatform(value);
}

function dataModeOf(req) {
  const value = req.query.mode
    || (req.body && (req.body.data_mode || req.body.mode));
  return value === 'comment' || value === 'comment_link' ? 'comment_link' : 'post';
}

function syncSourcePlatformOf(req) {
  const value = req.query.source_platform
    || (req.body && req.body.source_platform)
    || platformOf(req);
  return normalizePlatform(value);
}

// Configure multer for Excel file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(config.UPLOADS_DIR)) {
      fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });
    }
    cb(null, config.UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = `import_${Date.now()}_${file.originalname}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file Excel (.xlsx, .xls) hoặc CSV (.csv)'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

/**
 * GET / - List all posts
 */
router.get('/', (req, res) => {
  try {
    const posts = DataService.getAllWithCustomData(platformOf(req), dataModeOf(req));
    res.json({ success: true, data: posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST / - Create one or many posts
 * Accepts single object or array
 */
router.post('/', (req, res) => {
  try {
    const body = req.body;

    if (Array.isArray(body)) {
      const ids = DataService.createMany(body, platformOf(req), dataModeOf(req));
      res.json({ success: true, data: { created: ids.length, ids } });
    } else {
      const post = DataService.create(body, platformOf(req), dataModeOf(req));
      res.json({ success: true, data: post });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /bulk - Bulk update posts
 * Body: { updates: [{id, ...fields}] }
 */
router.put('/bulk', (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({ error: 'Cần truyền mảng updates' });
    }
    const result = DataService.updateMany(updates, platformOf(req), dataModeOf(req));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /:id - Update single post
 */
router.put('/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'ID không hợp lệ' });
    }
    const post = DataService.update(id, req.body, platformOf(req), dataModeOf(req));
    if (!post) {
      return res.status(404).json({ error: 'Không tìm thấy bài viết' });
    }
    res.json({ success: true, data: post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /bulk - Bulk delete posts
 * Body: { ids: [...] }
 */
router.delete('/bulk', (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Cần truyền mảng ids' });
    }
    const result = DataService.deleteMany(ids, platformOf(req), dataModeOf(req));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /restore - Restore previously deleted rows
 */
router.post('/restore', (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Cần truyền mảng rows' });
    }
    const result = DataService.restoreMany(rows, platformOf(req), dataModeOf(req));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /reorder - Reorder posts
 * Body: { orderedIds: [...] }
 */
router.post('/reorder', (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!orderedIds || !Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'Cần truyền mảng orderedIds' });
    }
    const result = DataService.reorder(orderedIds, platformOf(req), dataModeOf(req));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Cross-platform column synchronization
// ============================================

router.get('/sync/rules', (req, res) => {
  try {
    const rules = DataSyncService.getRules(syncSourcePlatformOf(req), req.query.source_var_key || '');
    res.json({ success: true, data: rules });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/sync/targets', (req, res) => {
  try {
    const data = DataSyncService.describeTargets(
      syncSourcePlatformOf(req),
      req.query.source_var_key,
      req.query.create_missing !== '0'
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/sync/rules', (req, res) => {
  try {
    const data = DataSyncService.saveRules(
      syncSourcePlatformOf(req),
      req.body.source_var_key,
      req.body.target_platforms,
      req.body
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sync/preview', (req, res) => {
  try {
    const data = DataSyncService.preview({
      ...req.body,
      source_platform: syncSourcePlatformOf(req),
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sync/execute', (req, res) => {
  try {
    const data = DataSyncService.execute({
      ...req.body,
      source_platform: syncSourcePlatformOf(req),
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sync/auto', (req, res) => {
  try {
    const data = DataSyncService.runAutomatic(
      syncSourcePlatformOf(req),
      req.body.source_var_key,
      req.body.source_post_ids
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sync/runs/:id/undo', (req, res) => {
  try {
    const data = DataSyncService.undo(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /import-excel - Upload xlsx file, return sheet names + data for preview
 */
router.post('/import-excel', upload.single('file'), (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Không có file được tải lên' });
    }

    filePath = req.file.path;
    const result = DataService.importFromExcel(filePath);

    // Return sheets with preview data (first 5 rows per sheet)
    const preview = result.sheets.map(sheet => ({
      name: sheet.name,
      totalRows: sheet.data.length,
      columns: sheet.data.length > 0 ? Object.keys(sheet.data[0]) : [],
      preview: sheet.data.slice(0, 5),
      data: sheet.data, // Full data for import
    }));

    res.json({ success: true, data: { sheets: preview, filePath } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up uploaded file
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore cleanup errors */ }
    }
  }
});

/**
 * POST /import-sheet - Import selected rows into DB
 * Body: { rows: [...] }
 */
router.post('/import-sheet', (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Không có dữ liệu để import' });
    }
    const result = DataService.importSheet(rows, platformOf(req), dataModeOf(req));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /pick-file - Open a native file dialog and return full path(s)
 * Desktop only. Returns { paths: [...] } (empty if cancelled).
 * Windows: PowerShell WinForms OpenFileDialog. macOS: osascript "choose file".
 */
router.post('/pick-file', (req, res) => {
  const { execFile } = require('child_process');

  // Helper: chuẩn hoá stdout → mảng đường dẫn tuyệt đối, mỗi dòng 1 file
  const toPaths = (stdout) => String(stdout || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (process.platform === 'win32') {
    // PowerShell WinForms OpenFileDialog (multiselect) → prints full paths, one per line
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
      '[System.Windows.Forms.Application]::EnableVisualStyles();',
      '$f = New-Object System.Windows.Forms.OpenFileDialog;',
      '$f.Multiselect = $true;',
      '$f.AutoUpgradeEnabled = $true;',
      '$f.CheckFileExists = $true;',
      '$f.RestoreDirectory = $true;',
      "$f.Title = 'Chon Media tu may';",
      "$f.Filter = 'Media ho tro|*.mp4;*.mov;*.m4v;*.avi;*.mkv;*.webm;*.wmv;*.mpeg;*.mpg;*.3gp;*.jpg;*.jpeg;*.png;*.webp|Tat ca file (*.*)|*.*';",
      '$owner = New-Object System.Windows.Forms.Form;',
      '$owner.TopMost = $true;',
      '$owner.ShowInTaskbar = $false;',
      '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None;',
      '$owner.Opacity = 0.01;',
      '$owner.Width = 1; $owner.Height = 1;',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen;',
      '$owner.Show(); $owner.Activate();',
      'try { if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileNames -join [Environment]::NewLine } } finally { $owner.Close(); $owner.Dispose(); $f.Dispose(); }',
    ].join(' ');

    return execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err) {
        return res.status(500).json({ error: 'Khong mo duoc hop thoai chon file' });
      }
      res.json({ success: true, data: { paths: toPaths(stdout) } });
    });
  }

  if (process.platform === 'darwin') {
    // macOS: osascript "choose file" (multiselect) → in ra POSIX path, mỗi dòng 1 file
    const osaArgs = [
      '-e', 'set theFiles to choose file with prompt "Chọn Media từ máy" with multiple selections allowed',
      '-e', 'set out to ""',
      '-e', 'repeat with f in theFiles',
      '-e', 'set out to out & POSIX path of f & linefeed',
      '-e', 'end repeat',
      '-e', 'return out',
    ];

    return execFile('osascript', osaArgs, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        // Người dùng bấm Cancel → osascript thoát khác 0 kèm "User canceled" → coi như không chọn gì
        const msg = String(stderr || err.message || '');
        if (/User canceled|-128/i.test(msg)) {
          return res.json({ success: true, data: { paths: [] } });
        }
        return res.status(500).json({ error: 'Khong mo duoc hop thoai chon file' });
      }
      res.json({ success: true, data: { paths: toPaths(stdout) } });
    });
  }

  // Nền tảng khác (Linux...) chưa hỗ trợ hộp thoại native
  return res.status(500).json({ error: 'Khong mo duoc hop thoai chon file' });
});

/**
 * GET /export-excel - Export all data to xlsx download
 */
router.get('/export-excel', (req, res) => {
  try {
    const platform = platformOf(req);
    const buffer = DataService.exportToExcel(platform, dataModeOf(req));
    const filename = `Super_Post_King_${platform}_Data_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Custom Columns API
// ============================================

/**
 * GET /columns - List all custom columns
 */
router.get('/columns', (req, res) => {
  try {
    const platform = platformOf(req);
    DataService.ensurePlatformDefaultColumns(platform);
    const columns = DataService.getCustomColumns(platform);
    res.json({ success: true, data: columns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /columns - Add a new custom column
 * Body: { name, col_type }
 */
router.post('/columns', (req, res) => {
  try {
    const { name, col_type, var_key } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Tên cột không được để trống' });
    }
    const column = DataService.addCustomColumn(name.trim(), col_type || 'text', var_key || '', platformOf(req));
    res.json({ success: true, data: column });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /columns/comment-group - Add the next four-column comment group.
 */
router.post('/columns/comment-group', (req, res) => {
  try {
    const group = DataService.addNextCommentGroup(platformOf(req));
    res.json({ success: true, data: group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /columns/comment-group/:sequence - Delete a complete comment group.
 */
router.delete('/columns/comment-group/:sequence', (req, res) => {
  try {
    const sequence = Number(req.params.sequence);
    if (!Number.isInteger(sequence) || sequence < 1) {
      return res.status(400).json({ error: 'Số thứ tự nhóm bình luận không hợp lệ' });
    }
    const snapshot = DataService.deleteCommentGroup(sequence, platformOf(req));
    res.json({ success: true, data: snapshot });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/**
 * PUT /columns/:id - Update custom column name/type
 */
router.put('/columns/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const column = DataService.updateCustomColumn(id, req.body, platformOf(req));
    res.json({ success: true, data: column });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /columns/:id - Delete a custom column and its data
 */
router.delete('/columns/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const snapshot = DataService.deleteCustomColumn(id, platformOf(req));
    res.json({ success: true, data: snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /columns/restore - Restore a deleted custom column
 */
router.post('/columns/restore', (req, res) => {
  try {
    const column = DataService.restoreCustomColumn(req.body.snapshot, platformOf(req));
    res.json({ success: true, data: column });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /custom-data - Update custom column value for a post
 * Body: { post_id, column_id, value }
 */
router.put('/custom-data', (req, res) => {
  try {
    const { post_id, column_id, value } = req.body;
    const platform = platformOf(req);
    const column = DataService.getCustomColumns(platform)
      .find(item => item.id === Number(column_id));
    const parsed = CommentColumns.parseVarKey(column && column.var_key);
    if (
      parsed
      && parsed.base === 'comment_status'
      && !['waiting', 'success', 'error', 'skipped'].includes(String(value || ''))
    ) {
      return res.status(400).json({
        error: 'Không thể đặt trạng thái hệ thống bằng tay. Hãy chọn Đang chờ, Thành công, Lỗi hoặc Bỏ qua.',
      });
    }
    DataService.setCustomData(post_id, column_id, value, platform);
    if (parsed && parsed.base === 'comment_status') {
      CommentJobService.updateManualStatus(
        Number(post_id),
        parsed.sequence,
        String(value || ''),
        platform
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Handle multer errors
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File quá lớn (tối đa 50MB)' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
