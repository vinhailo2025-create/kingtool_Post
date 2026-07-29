/**
 * Data Service - CRUD operations for posts table
 * Handles all data management including Excel import/export
 */
const db = require('../database/init');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const DataService = {
  /**
   * Get all posts ordered by sort_order
   */
  getAll() {
    return db.prepare(`
      SELECT * FROM posts ORDER BY sort_order ASC, id ASC
    `).all();
  },

  /**
   * Create a single post, auto-set sort_order to end of list
   */
  create(data) {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM posts').get();
    const sortOrder = maxOrder.max_order + 1;

    const stmt = db.prepare(`
      INSERT INTO posts (sort_order, content, image_path, link, target, status, note)
      VALUES (@sort_order, @content, @image_path, @link, @target, @status, @note)
    `);

    const result = stmt.run({
      sort_order: sortOrder,
      content: data.content || '',
      image_path: data.image_path || '',
      link: data.link || '',
      target: data.target || '',
      status: data.status || 'pending',
      note: data.note || '',
    });

    return db.prepare('SELECT * FROM posts WHERE id = ?').get(result.lastInsertRowid);
  },

  /**
   * Restore rows with their original ids. Used by undo after deleting rows.
   */
  restoreMany(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return { restored: 0 };
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO posts (id, sort_order, content, image_path, link, target, status, note, created_at, updated_at)
      VALUES (@id, @sort_order, @content, @image_path, @link, @target, @status, @note, @created_at, @updated_at)
    `);
    const restoreAll = db.transaction((items) => {
      for (const row of items) {
        stmt.run({
          id: row.id,
          sort_order: row.sort_order || 0,
          content: row.content || '',
          image_path: row.image_path || '',
          link: row.link || '',
          target: row.target || '',
          status: row.status || 'pending',
          note: row.note || '',
          created_at: row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || new Date().toISOString(),
        });
      }
    });
    restoreAll(rows);
    return { restored: rows.length };
  },

  /**
   * Bulk create posts from array of rows
   */
  createMany(rows) {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM posts').get();
    let sortOrder = maxOrder.max_order + 1;

    const stmt = db.prepare(`
      INSERT INTO posts (sort_order, content, image_path, link, target, status, note)
      VALUES (@sort_order, @content, @image_path, @link, @target, @status, @note)
    `);

    const insertedIds = [];

    const insertAll = db.transaction((rows) => {
      for (const row of rows) {
        const result = stmt.run({
          sort_order: sortOrder++,
          content: row.content || '',
          image_path: row.image_path || '',
          link: row.link || '',
          target: row.target || '',
          status: row.status || 'pending',
          note: row.note || '',
        });
        insertedIds.push(result.lastInsertRowid);
      }
    });

    insertAll(rows);
    return insertedIds;
  },

  /**
   * Update a single post by id
   */
  update(id, data) {
    // Build dynamic SET clause from provided fields
    const allowedFields = ['content', 'image_path', 'link', 'target', 'status', 'note', 'sort_order'];
    const updates = [];
    const params = { id };

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = @${field}`);
        params[field] = data[field];
      }
    }

    if (updates.length === 0) {
      return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    }

    updates.push("updated_at = datetime('now')");

    const sql = `UPDATE posts SET ${updates.join(', ')} WHERE id = @id`;
    db.prepare(sql).run(params);

    return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  },

  /**
   * Bulk update posts: [{id, ...fields}]
   */
  updateMany(updates) {
    const allowedFields = ['content', 'image_path', 'link', 'target', 'status', 'note', 'sort_order'];

    const updateAll = db.transaction((items) => {
      for (const item of items) {
        if (!item.id) continue;

        const setClauses = [];
        const params = { id: item.id };

        for (const field of allowedFields) {
          if (item[field] !== undefined) {
            setClauses.push(`${field} = @${field}`);
            params[field] = item[field];
          }
        }

        if (setClauses.length === 0) continue;

        setClauses.push("updated_at = datetime('now')");
        const sql = `UPDATE posts SET ${setClauses.join(', ')} WHERE id = @id`;
        db.prepare(sql).run(params);
      }
    });

    updateAll(updates);
    return { updated: updates.length };
  },

  /**
   * Bulk delete posts by ids array
   */
  deleteMany(ids) {
    if (!ids || ids.length === 0) return { deleted: 0 };

    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM posts WHERE id IN (${placeholders})`).run(...ids);
    return { deleted: result.changes };
  },

  /**
   * Reorder posts based on array of ids (position = index)
   */
  reorder(orderedIds) {
    const reorderAll = db.transaction((ids) => {
      const stmt = db.prepare('UPDATE posts SET sort_order = ? WHERE id = ?');
      ids.forEach((id, index) => {
        stmt.run(index + 1, id);
      });
    });

    reorderAll(orderedIds);
    return { reordered: orderedIds.length };
  },

  /**
   * Read an xlsx file, parse all sheets, return { sheets: [{ name, data }] }
   */
  importFromExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheets = [];

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      sheets.push({
        name: sheetName,
        data: jsonData,
      });
    }

    return { sheets };
  },

  /**
   * Import parsed rows into posts table
   * Maps common column names to DB fields
   */
  importSheet(rows) {
    // Column name mapping (Vietnamese and English variations)
    const fieldMap = {
      'content': 'content',
      'nội dung': 'content',
      'noi dung': 'content',
      'bài viết': 'content',
      'bai viet': 'content',
      'text': 'content',

      'image_path': 'image_path',
      'hình ảnh': 'image_path',
      'hinh anh': 'image_path',
      'image': 'image_path',
      'ảnh': 'image_path',
      'anh': 'image_path',
      'file': 'image_path',

      'link': 'link',
      'url': 'link',
      'đường dẫn': 'link',
      'duong dan': 'link',

      'target': 'target',
      'nhóm': 'target',
      'nhom': 'target',
      'trang': 'target',
      'nhóm/trang': 'target',
      'nhom/trang': 'target',
      'group': 'target',
      'page': 'target',

      'status': 'status',
      'trạng thái': 'status',
      'trang thai': 'status',

      'note': 'note',
      'ghi chú': 'note',
      'ghi chu': 'note',
      'notes': 'note',
    };

    const mappedRows = rows.map(row => {
      const mapped = {};
      for (const [key, value] of Object.entries(row)) {
        const normalizedKey = key.toLowerCase().trim();
        const dbField = fieldMap[normalizedKey];
        if (dbField) {
          mapped[dbField] = String(value || '');
        }
      }
      // If no fields were mapped, try to use first columns in order
      if (Object.keys(mapped).length === 0) {
        const values = Object.values(row);
        if (values[0] !== undefined) mapped.content = String(values[0] || '');
        if (values[1] !== undefined) mapped.image_path = String(values[1] || '');
        if (values[2] !== undefined) mapped.link = String(values[2] || '');
        if (values[3] !== undefined) mapped.target = String(values[3] || '');
        if (values[4] !== undefined) mapped.note = String(values[4] || '');
      }
      return mapped;
    });

    // Filter out completely empty rows
    const validRows = mappedRows.filter(row =>
      Object.values(row).some(v => v && v.trim() !== '')
    );

    const insertedIds = this.createMany(validRows);
    return { imported: insertedIds.length, ids: insertedIds };
  },

  /**
   * Export all posts to xlsx buffer
   */
  exportToExcel() {
    const posts = this.getAll();

    // Map to export-friendly column names
    const exportData = posts.map((post, index) => ({
      '#': index + 1,
      'Nội dung': post.content || '',
      'Hình ảnh': post.image_path || '',
      'Link': post.link || '',
      'Nhóm/Trang': post.target || '',
      'Trạng thái': post.status || '',
      'Ghi chú': post.note || '',
    }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportData);

    // Set column widths
    worksheet['!cols'] = [
      { wch: 5 },   // #
      { wch: 50 },  // Nội dung
      { wch: 40 },  // Hình ảnh
      { wch: 40 },  // Link
      { wch: 30 },  // Nhóm/Trang
      { wch: 15 },  // Trạng thái
      { wch: 30 },  // Ghi chú
    ];

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Dữ liệu');

    // Write to buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return buffer;
  },

  /**
   * Get total post count
   */
  getCount() {
    const row = db.prepare('SELECT COUNT(*) as count FROM posts').get();
    return row.count;
  },

  /**
   * Get post count by status
   */
  getCountByStatus(status) {
    const row = db.prepare('SELECT COUNT(*) as count FROM posts WHERE status = ?').get(status);
    return row.count;
  },

  // ============================================
  // Custom Columns
  // ============================================

  /**
   * Get all custom columns
   */
  getCustomColumns() {
    return db.prepare('SELECT * FROM custom_columns ORDER BY sort_order ASC, id ASC').all();
  },

  /**
   * Add a new custom column
   */
  addCustomColumn(name, col_type = 'text', var_key = '') {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM custom_columns').get();
    const key = this.uniqueVarKey(var_key || this.slugKey(name));
    const result = db.prepare(
      'INSERT INTO custom_columns (name, col_type, var_key, sort_order) VALUES (?, ?, ?, ?)'
    ).run(name, col_type, key, (maxOrder.max_order || 0) + 1);
    return db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(result.lastInsertRowid);
  },

  slugKey(name) {
    const s = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return s || 'cot';
  },

  // Ensure the var_key is unique across custom_columns (append _2, _3, ... if taken)
  uniqueVarKey(key, excludeId = null) {
    let base = this.slugKey(key);
    let candidate = base;
    let n = 2;
    while (true) {
      const row = excludeId
        ? db.prepare('SELECT id FROM custom_columns WHERE var_key = ? AND id != ?').get(candidate, excludeId)
        : db.prepare('SELECT id FROM custom_columns WHERE var_key = ?').get(candidate);
      if (!row) return candidate;
      candidate = base + '_' + n;
      n++;
    }
  },

  /**
   * Update custom column
   */
  updateCustomColumn(id, data) {
    const updates = [];
    const params = [];
    if (data.name !== undefined) { updates.push('name = ?'); params.push(data.name); }
    if (data.col_type !== undefined) { updates.push('col_type = ?'); params.push(data.col_type); }
    if (data.var_key !== undefined) {
      const key = this.uniqueVarKey(data.var_key, id);
      updates.push('var_key = ?'); params.push(key);
    }
    if (data.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(data.sort_order); }
    if (updates.length > 0) {
      params.push(id);
      db.prepare(`UPDATE custom_columns SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    return db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(id);
  },

  /**
   * Delete custom column and all its data
   */
  deleteCustomColumn(id) {
    const snapshot = this.getCustomColumnSnapshot(id);
    db.prepare('DELETE FROM post_custom_data WHERE column_id = ?').run(id);
    db.prepare('DELETE FROM custom_columns WHERE id = ?').run(id);
    return snapshot;
  },

  getCustomColumnSnapshot(id) {
    const column = db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(id);
    if (!column) return null;
    const values = db.prepare('SELECT * FROM post_custom_data WHERE column_id = ?').all(id);
    return { column, values };
  },

  restoreCustomColumn(snapshot) {
    if (!snapshot || !snapshot.column) return null;
    const col = snapshot.column;
    db.prepare(`
      INSERT OR REPLACE INTO custom_columns (id, name, col_type, var_key, sort_order, created_at)
      VALUES (@id, @name, @col_type, @var_key, @sort_order, @created_at)
    `).run({
      id: col.id,
      name: col.name,
      col_type: col.col_type || 'text',
      var_key: col.var_key || this.slugKey(col.name),
      sort_order: col.sort_order || 0,
      created_at: col.created_at || new Date().toISOString(),
    });
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO post_custom_data (id, post_id, column_id, value)
      VALUES (@id, @post_id, @column_id, @value)
    `);
    const values = Array.isArray(snapshot.values) ? snapshot.values : [];
    const restoreValues = db.transaction((items) => {
      for (const item of items) {
        stmt.run({
          id: item.id,
          post_id: item.post_id,
          column_id: item.column_id,
          value: item.value || '',
        });
      }
    });
    restoreValues(values);
    return col;
  },

  /**
   * Set custom column value for a post
   */
  setCustomData(postId, columnId, value) {
    db.prepare(
      'INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value) VALUES (?, ?, ?)'
    ).run(postId, columnId, value || '');
  },

  /**
   * Get all posts with custom column data merged in
   */
  getAllWithCustomData() {
    const posts = this.getAll();
    const customCols = this.getCustomColumns();

    if (customCols.length === 0) return posts;

    // Get all custom data in one query
    const allCustomData = db.prepare('SELECT * FROM post_custom_data').all();

    // Build lookup: postId -> { colId -> value }
    const dataMap = {};
    for (const cd of allCustomData) {
      if (!dataMap[cd.post_id]) dataMap[cd.post_id] = {};
      dataMap[cd.post_id][cd.column_id] = cd.value;
    }

    // Merge custom data into posts
    return posts.map(post => {
      const custom = dataMap[post.id] || {};
      for (const col of customCols) {
        post[`custom_${col.id}`] = custom[col.id] || '';
      }
      return post;
    });
  },
};

module.exports = DataService;
