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
    const posts = DataService.getAllWithCustomData();
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
      const ids = DataService.createMany(body);
      res.json({ success: true, data: { created: ids.length, ids } });
    } else {
      const post = DataService.create(body);
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
    const result = DataService.updateMany(updates);
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
    const post = DataService.update(id, req.body);
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
    const result = DataService.deleteMany(ids);
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
    const result = DataService.restoreMany(rows);
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
    const result = DataService.reorder(orderedIds);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    const result = DataService.importSheet(rows);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /pick-file - Open a native Windows file dialog and return full path(s)
 * Desktop only. Returns { paths: [...] } (empty if cancelled).
 */
router.post('/pick-file', (req, res) => {
  const { execFile } = require('child_process');
  // PowerShell WinForms OpenFileDialog (multiselect) → prints full paths, one per line
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
    '$f = New-Object System.Windows.Forms.OpenFileDialog;',
    '$f.Multiselect = $true;',
    "$f.Title = 'Chon file';",
    "$f.Filter = 'Tat ca file (*.*)|*.*';",
    '$owner = New-Object System.Windows.Forms.Form;',
    '$owner.TopMost = $true;',
    'if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $f.FileNames -join [Environment]::NewLine }',
  ].join(' ');

  execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Khong mo duoc hop thoai chon file' });
    }
    const paths = String(stdout || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    res.json({ success: true, data: { paths } });
  });
});

/**
 * GET /export-excel - Export all data to xlsx download
 */
router.get('/export-excel', (req, res) => {
  try {
    const buffer = DataService.exportToExcel();
    const filename = `CovergemAuto_Data_${new Date().toISOString().slice(0, 10)}.xlsx`;

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
    const columns = DataService.getCustomColumns();
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
    const column = DataService.addCustomColumn(name.trim(), col_type || 'text', var_key || '');
    res.json({ success: true, data: column });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /columns/:id - Update custom column name/type
 */
router.put('/columns/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const column = DataService.updateCustomColumn(id, req.body);
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
    const snapshot = DataService.deleteCustomColumn(id);
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
    const column = DataService.restoreCustomColumn(req.body.snapshot);
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
    DataService.setCustomData(post_id, column_id, value);
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
