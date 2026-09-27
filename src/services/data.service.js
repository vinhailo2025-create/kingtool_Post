/**
 * Data Service - CRUD operations for posts table
 * Handles all data management including Excel import/export
 */
const db = require('../database/init');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { normalizePlatform, scopedSettingKey } = require('../platforms/platform.utils');
const { sanitizeMediaPath } = require('./media-path.utils');
const CommentColumns = require('./comment-columns.service');

function normalizeDataMode(value) {
  return value === 'comment' || value === 'comment_link' ? 'comment_link' : 'post';
}

const REQUIRED_CUSTOM_COLUMNS = Object.freeze([
  { name: 'name_profile', var_key: 'name_profile', col_type: 'text' },
  { name: 'link_post', var_key: 'link_post', col_type: 'text' },
  { name: 'time_post', var_key: 'time_post', col_type: 'text' },
]);

const PLATFORM_DEFAULT_COLUMNS = Object.freeze({
  facebook: Object.freeze([
    { name: 'Link Fanpage', var_key: 'link_fanpage', col_type: 'text' },
    { name: 'Hình Thumbnail', var_key: 'thumbnail', col_type: 'file' },
  ]),
  youtube: Object.freeze([
    { name: 'Mô tả video', var_key: 'description', col_type: 'text' },
    { name: 'Tên kênh', var_key: 'channel_name', col_type: 'text' },
    { name: 'Danh sách phát', var_key: 'playlist', col_type: 'text' },
    { name: 'Trạng thái lưu', var_key: 'privacy_status', col_type: 'select' },
    { name: 'Hình Thumbnail', var_key: 'thumbnail', col_type: 'file' },
    { name: 'Từ khóa', var_key: 'keywords', col_type: 'text' },
  ]),
  zalovideo: Object.freeze([
    { name: 'Danh sách phát', var_key: 'playlist', col_type: 'text' },
  ]),
});

const SYSTEM_CUSTOM_LABELS = Object.freeze({
  post_group: 'Post_group',
  name_profile: 'Tên Profile',
  link_fanpage: 'Link Fanpage',
  description: 'Mô tả video',
  channel_name: 'Tên kênh',
  playlist: 'Danh sách phát',
  privacy_status: 'Trạng thái lưu',
  thumbnail: 'Hình Thumbnail',
  keywords: 'Từ khóa',
  link_post: 'Link Post',
  time_post: 'Thời gian đăng',
  comment: 'Nội dung bình luận',
  comment_media: 'Media bình luận',
  time_comment: 'Thời gian bình luận',
  comment_status: 'Trạng thái bình luận',
});

const PROTECTED_CUSTOM_VAR_KEYS = new Set([
  ...REQUIRED_CUSTOM_COLUMNS.map(column => column.var_key),
  ...Object.values(PLATFORM_DEFAULT_COLUMNS).flat().map(column => column.var_key),
]);

const FACEBOOK_GROUP_COLUMN = Object.freeze({
  name: 'Post_group',
  var_key: 'post_group',
  col_type: 'text',
});
const FACEBOOK_GROUP_IMPORT_ALIASES = new Set([
  'post_group',
  'post group',
  'link group',
  'group link',
]);

const DataService = {
  /** Ensure every column rendered by the data grid exists before import/export. */
  ensurePlatformDefaultColumns(platform = 'facebook') {
    platform = normalizePlatform(platform);
    const platformDefinitions = PLATFORM_DEFAULT_COLUMNS[platform] || [];
    const definitions = [
      ...REQUIRED_CUSTOM_COLUMNS,
      ...platformDefinitions,
    ];
    if (!definitions.length) return [];

    const find = db.prepare(
      'SELECT * FROM custom_columns WHERE platform = ? AND var_key = ?'
    );
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM custom_columns WHERE platform = ?'
    );
    const insert = db.prepare(
      'INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform) VALUES (?, ?, ?, ?, ?)'
    );
    const updateType = db.prepare('UPDATE custom_columns SET col_type = ? WHERE id = ?');

    db.transaction(() => {
      let nextOrder = Number(maxOrder.get(platform).max_order || 0) + 1;
      for (const definition of definitions) {
        const existing = find.get(platform, definition.var_key);
        if (!existing) {
          insert.run(definition.name, definition.col_type, definition.var_key, nextOrder++, platform);
        } else if (existing.col_type !== definition.col_type) {
          updateType.run(definition.col_type, existing.id);
        }
      }
    })();

    return platformDefinitions.map(definition => find.get(platform, definition.var_key));
  },

  ensureFacebookGroupColumn() {
    const existing = db.prepare(
      'SELECT * FROM custom_columns WHERE platform = ? AND var_key = ?'
    ).get('facebook', FACEBOOK_GROUP_COLUMN.var_key);
    if (existing) return existing;
    return this.addCustomColumn(
      FACEBOOK_GROUP_COLUMN.name,
      FACEBOOK_GROUP_COLUMN.col_type,
      FACEBOOK_GROUP_COLUMN.var_key,
      'facebook'
    );
  },

  getCommentSequences(platform = 'facebook') {
    return CommentColumns.sequencesFromColumns(this.getCustomColumns(platform));
  },

  ensureCommentGroup(sequence, platform = 'facebook') {
    platform = normalizePlatform(platform);
    sequence = CommentColumns.normalizeSequence(sequence);
    const definitions = CommentColumns.definitions(sequence);
    const find = db.prepare(
      'SELECT * FROM custom_columns WHERE platform = ? AND var_key = ?'
    );
    const insert = db.prepare(
      'INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform) VALUES (?, ?, ?, ?, ?)'
    );
    const maxOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM custom_columns WHERE platform = ?'
    );

    db.transaction(() => {
      let nextOrder = Number(maxOrder.get(platform).max_order || 0) + 1;
      for (const definition of definitions) {
        const existing = find.get(platform, definition.varKey);
        if (!existing) {
          insert.run(
            definition.name,
            definition.colType,
            definition.varKey,
            nextOrder++,
            platform
          );
        }
      }
    })();

    if (sequence >= 2) this.ensureCommentInterval(sequence, platform);
    return {
      sequence,
      columns: definitions.map(definition => find.get(platform, definition.varKey)),
    };
  },

  ensureCommentGroupsThrough(sequence, platform = 'facebook') {
    const highest = CommentColumns.normalizeSequence(sequence);
    const groups = [];
    for (let current = 1; current <= highest; current++) {
      groups.push(this.ensureCommentGroup(current, platform));
    }
    return groups;
  },

  addNextCommentGroup(platform = 'facebook') {
    platform = normalizePlatform(platform);
    this.ensurePlatformDefaultColumns(platform);
    const sequences = this.getCommentSequences(platform);
    const next = sequences.length ? Math.max(...sequences) + 1 : 1;
    return this.ensureCommentGroup(next, platform);
  },

  ensureCommentInterval(sequence, platform = 'facebook') {
    platform = normalizePlatform(platform);
    sequence = CommentColumns.normalizeSequence(sequence);
    if (sequence < 2) return;
    const key = scopedSettingKey(platform, 'comment_intervals');
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    let intervals = {};
    try { intervals = row && row.value ? JSON.parse(row.value) : {}; } catch (_) {}
    if (!intervals[String(sequence)]) {
      intervals[String(sequence)] = { min: 60, max: 120, unit: 'sec' };
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(key, JSON.stringify(intervals));
    }
  },

  deleteCommentGroup(sequence, platform = 'facebook') {
    platform = normalizePlatform(platform);
    sequence = CommentColumns.normalizeSequence(sequence);

    const active = db.prepare(`
      SELECT COUNT(*) AS count
      FROM comment_jobs
      WHERE platform = ? AND sequence_no = ?
        AND status IN ('blocked', 'waiting', 'running')
    `).get(platform, sequence);
    if (Number(active && active.count) > 0) {
      throw new Error(`Bình luận ${sequence} đang có lịch chờ hoặc đang chạy`);
    }

    const definitions = CommentColumns.definitions(sequence);
    const columns = definitions
      .map(definition => db.prepare(
        'SELECT * FROM custom_columns WHERE platform = ? AND var_key = ?'
      ).get(platform, definition.varKey))
      .filter(Boolean);
    if (!columns.length) return null;

    const snapshots = columns.map(column => ({
      column,
      values: db.prepare('SELECT * FROM post_custom_data WHERE column_id = ?').all(column.id),
    }));
    db.transaction(() => {
      for (const column of columns) {
        db.prepare('DELETE FROM post_custom_data WHERE column_id = ?').run(column.id);
        db.prepare('DELETE FROM custom_columns WHERE id = ?').run(column.id);
      }
      const settingKey = scopedSettingKey(platform, 'comment_intervals');
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey);
      let intervals = {};
      try { intervals = row && row.value ? JSON.parse(row.value) : {}; } catch (_) {}
      delete intervals[String(sequence)];
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(settingKey, JSON.stringify(intervals));
    })();
    return { sequence, snapshots };
  },

  getFieldOverrides(platform = 'facebook') {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?')
        .get(scopedSettingKey(platform, 'field_overrides'));
      return row && row.value ? JSON.parse(row.value) : {};
    } catch (_) {
      return {};
    }
  },

  /**
   * Ordered export schema. The first columns mirror the grid exactly; legacy
   * built-in fields that are not currently rendered remain at the end so an
   * export/import round trip never loses stored data.
   */
  getExportColumnSchema(platform = 'facebook') {
    platform = normalizePlatform(platform);
    this.ensurePlatformDefaultColumns(platform);
    const overrides = this.getFieldOverrides(platform);
    const customColumns = this.getCustomColumns(platform);
    const customByVar = new Map(customColumns.map(column => [column.var_key, column]));
    const usedCustomIds = new Set();
    const columns = [{ kind: 'rownum', header: 'Stt', width: 6 }];

    const builtin = (field, fallback, width, colType = 'text') => {
      const override = overrides[field] || {};
      columns.push({
        kind: 'builtin',
        field,
        header: override.label || fallback,
        aliases: [field, fallback, override.var].filter(Boolean),
        col_type: colType,
        width,
      });
    };
    const custom = (varKey, fallbackLabel = '') => {
      const column = customByVar.get(varKey);
      if (!column || usedCustomIds.has(column.id)) return;
      usedCustomIds.add(column.id);
      columns.push({
        kind: 'custom',
        id: column.id,
        var_key: column.var_key,
        header: fallbackLabel || SYSTEM_CUSTOM_LABELS[varKey] || column.name,
        aliases: [
          column.name,
          column.var_key,
          SYSTEM_CUSTOM_LABELS[varKey],
          fallbackLabel,
        ].filter(Boolean),
        col_type: column.col_type || 'text',
        width: column.col_type === 'file' ? 40 : 28,
      });
    };

    custom('name_profile', SYSTEM_CUSTOM_LABELS.name_profile);
    if (platform === 'facebook') custom('link_fanpage', SYSTEM_CUSTOM_LABELS.link_fanpage);
    if (platform === 'facebook') custom('post_group', SYSTEM_CUSTOM_LABELS.post_group);
    builtin('content', 'Nội dung', 50);
    builtin('image_path', 'Media', 40, 'file');
    if (platform === 'facebook') custom('thumbnail', SYSTEM_CUSTOM_LABELS.thumbnail);

    if (platform === 'youtube') {
      for (const varKey of ['description', 'channel_name', 'playlist', 'privacy_status', 'thumbnail', 'keywords']) {
        custom(varKey, SYSTEM_CUSTOM_LABELS[varKey]);
      }
    }
    if (platform === 'zalovideo') custom('playlist', SYSTEM_CUSTOM_LABELS.playlist);
    if (platform === 'tiktok') builtin('product_id', 'ID_Sản Phẩm', 24);
    builtin('status', 'Trạng thái', 16);
    for (const varKey of ['link_post', 'time_post']) {
      custom(varKey, SYSTEM_CUSTOM_LABELS[varKey]);
    }
    for (const sequence of this.getCommentSequences(platform)) {
      for (const field of CommentColumns.COMMENT_FIELDS) {
        const varKey = CommentColumns.varKey(field.base, sequence);
        custom(varKey, CommentColumns.label(field.base, sequence));
      }
    }

    // User-created columns are rendered/exported after the standard workflow columns.
    for (const column of customColumns) custom(column.var_key, column.name);

    // Preserve older stored fields even though the current grid does not render them.
    builtin('link', 'Link', 40);
    builtin('target', 'Nhóm/Trang', 30);
    builtin('note', 'Ghi chú', 30);

    const usedHeaders = new Set();
    for (const column of columns) {
      const base = String(column.header || column.field || column.var_key || '').trim() || 'Cột';
      let header = base;
      let suffix = column.var_key || column.field || 'column';
      let counter = 2;
      while (usedHeaders.has(header.toLowerCase())) {
        header = `${base} [${suffix}${counter > 2 ? `_${counter}` : ''}]`;
        counter++;
      }
      column.header = header;
      usedHeaders.add(header.toLowerCase());
    }
    return columns;
  },

  /**
   * Get all posts ordered by sort_order
   */
  getAll(platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    dataMode = normalizeDataMode(dataMode);
    return db.prepare(`
      SELECT * FROM posts
      WHERE platform = ? AND data_mode = ?
      ORDER BY sort_order ASC, id ASC
    `).all(platform, dataMode);
  },

  /**
   * Create a single post, auto-set sort_order to end of list
   */
  create(data, platform = 'facebook', dataMode = null) {
    platform = normalizePlatform(platform || data.platform);
    dataMode = normalizeDataMode(dataMode || data.data_mode);
    const maxOrder = db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) as max_order
      FROM posts WHERE platform = ? AND data_mode = ?
    `).get(platform, dataMode);
    const sortOrder = maxOrder.max_order + 1;

    const stmt = db.prepare(`
      INSERT INTO posts (
        sort_order, content, image_path, link, target, product_id, status, note, platform,
        agent_data_key, agent_payload_json, data_mode
      )
      VALUES (
        @sort_order, @content, @image_path, @link, @target, @product_id, @status, @note, @platform,
        @agent_data_key, @agent_payload_json, @data_mode
      )
    `);

    const result = stmt.run({
      sort_order: sortOrder,
      content: data.content || '',
      image_path: sanitizeMediaPath(data.image_path),
      link: data.link || '',
      target: data.target || '',
      product_id: data.product_id || '',
      status: data.status || 'pending',
      note: data.note || '',
      platform,
      agent_data_key: String(data.agent_data_key || '').trim() || null,
      agent_payload_json: data.agent_payload_json || null,
      data_mode: dataMode,
    });

    return db.prepare('SELECT * FROM posts WHERE id = ?').get(result.lastInsertRowid);
  },

  /**
   * Restore rows with their original ids. Used by undo after deleting rows.
   */
  restoreMany(rows, platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    dataMode = normalizeDataMode(dataMode);
    if (!Array.isArray(rows) || rows.length === 0) return { restored: 0 };
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO posts (
        id, sort_order, content, image_path, link, target, product_id, status, note, platform,
        sync_key, agent_data_key, agent_payload_json, data_mode, created_at, updated_at
      )
      VALUES (
        @id, @sort_order, @content, @image_path, @link, @target, @product_id, @status, @note, @platform,
        @sync_key, @agent_data_key, @agent_payload_json, @data_mode, @created_at, @updated_at
      )
    `);
    const restoreCustom = db.prepare(`
      INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value)
      VALUES (?, ?, ?)
    `);
    const restoreAll = db.transaction((items) => {
      for (const row of items) {
        stmt.run({
          id: row.id,
          sort_order: row.sort_order || 0,
          content: row.content || '',
          image_path: sanitizeMediaPath(row.image_path),
          link: row.link || '',
          target: row.target || '',
          product_id: row.product_id || '',
          status: row.status || 'pending',
          note: row.note || '',
          platform,
          sync_key: row.sync_key || null,
          agent_data_key: row.agent_data_key || null,
          agent_payload_json: row.agent_payload_json || null,
          data_mode: normalizeDataMode(row.data_mode || dataMode),
          created_at: row.created_at || new Date().toISOString(),
          updated_at: row.updated_at || new Date().toISOString(),
        });
        for (const [field, value] of Object.entries(row)) {
          const match = /^custom_(\d+)$/.exec(field);
          if (match) restoreCustom.run(row.id, Number(match[1]), value == null ? '' : String(value));
        }
      }
    });
    restoreAll(rows);
    return { restored: rows.length };
  },

  /**
   * Bulk create posts from array of rows
   */
  createMany(rows, platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    dataMode = normalizeDataMode(dataMode);
    const maxOrder = db.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) as max_order
      FROM posts WHERE platform = ? AND data_mode = ?
    `).get(platform, dataMode);
    let sortOrder = maxOrder.max_order + 1;

    const stmt = db.prepare(`
      INSERT INTO posts (
        sort_order, content, image_path, link, target, product_id, status, note, platform,
        agent_data_key, agent_payload_json, data_mode
      )
      VALUES (
        @sort_order, @content, @image_path, @link, @target, @product_id, @status, @note, @platform,
        @agent_data_key, @agent_payload_json, @data_mode
      )
    `);

    const insertedIds = [];

    const insertAll = db.transaction((rows) => {
      for (const row of rows) {
        const result = stmt.run({
          sort_order: sortOrder++,
          content: row.content || '',
          image_path: sanitizeMediaPath(row.image_path),
          link: row.link || '',
          target: row.target || '',
          product_id: row.product_id || '',
          status: row.status || 'pending',
          note: row.note || '',
          platform,
          agent_data_key: String(row.agent_data_key || '').trim() || null,
          agent_payload_json: row.agent_payload_json || null,
          data_mode: normalizeDataMode(row.data_mode || dataMode),
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
  update(id, data, platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    dataMode = normalizeDataMode(dataMode);
    const previous = db.prepare(
      'SELECT * FROM posts WHERE id = ? AND platform = ? AND data_mode = ?'
    ).get(id, platform, dataMode);
    // Build dynamic SET clause from provided fields
    const allowedFields = ['content', 'image_path', 'link', 'target', 'product_id', 'status', 'note', 'sort_order'];
    const updates = [];
    const params = { id };

    let invalidatesAgentPayload = false;
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        updates.push(`${field} = @${field}`);
        const nextValue = field === 'image_path' ? sanitizeMediaPath(data[field]) : data[field];
        params[field] = nextValue;
        if (
          ['content', 'image_path', 'link', 'target', 'product_id'].includes(field)
          && String(previous && previous[field] || '') !== String(nextValue || '')
        ) {
          invalidatesAgentPayload = true;
        }
      }
    }

    if (updates.length === 0) {
      return db.prepare(
        'SELECT * FROM posts WHERE id = ? AND platform = ? AND data_mode = ?'
      ).get(id, platform, dataMode);
    }

    if (invalidatesAgentPayload) updates.push('agent_payload_json = NULL');
    updates.push("updated_at = datetime('now')");

    params.platform = platform;
    params.data_mode = dataMode;
    const sql = `UPDATE posts SET ${updates.join(', ')}
                 WHERE id = @id AND platform = @platform AND data_mode = @data_mode`;
    db.prepare(sql).run(params);

    const updated = db.prepare(
      'SELECT * FROM posts WHERE id = ? AND platform = ? AND data_mode = ?'
    ).get(id, platform, dataMode);
    if (updated && previous && data.status !== undefined && String(previous.status) !== String(updated.status)) {
      try {
        require('./telegram-notification.service').notifyStatusChange({
          platform,
          postId: updated.id,
          row: updated.sort_order || updated.id,
          status: updated.status,
          previousStatus: previous.status,
          content: updated.content,
          link: updated.link,
          detail: updated.note,
          updatedAt: updated.updated_at,
        });
      } catch (_) {}
    }
    return updated;
  },

  /**
   * Bulk update posts: [{id, ...fields}]
   */
  updateMany(updates, platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    dataMode = normalizeDataMode(dataMode);
    const allowedFields = ['content', 'image_path', 'link', 'target', 'product_id', 'status', 'note', 'sort_order'];
    const previousById = new Map(
      (updates || []).filter(item => item && item.id).map(item => [
        item.id,
        db.prepare(
          'SELECT * FROM posts WHERE id = ? AND platform = ? AND data_mode = ?'
        ).get(item.id, platform, dataMode),
      ])
    );

    const updateAll = db.transaction((items) => {
      for (const item of items) {
        if (!item.id) continue;

        const setClauses = [];
        const params = { id: item.id, platform, data_mode: dataMode };

        let invalidatesAgentPayload = false;
        for (const field of allowedFields) {
          if (item[field] !== undefined) {
            setClauses.push(`${field} = @${field}`);
            const nextValue = field === 'image_path' ? sanitizeMediaPath(item[field]) : item[field];
            params[field] = nextValue;
            const previous = previousById.get(item.id);
            if (
              ['content', 'image_path', 'link', 'target', 'product_id'].includes(field)
              && String(previous && previous[field] || '') !== String(nextValue || '')
            ) {
              invalidatesAgentPayload = true;
            }
          }
        }

        if (setClauses.length === 0) continue;

        if (invalidatesAgentPayload) setClauses.push('agent_payload_json = NULL');
        setClauses.push("updated_at = datetime('now')");
        const sql = `UPDATE posts SET ${setClauses.join(', ')}
                     WHERE id = @id AND platform = @platform AND data_mode = @data_mode`;
        db.prepare(sql).run(params);
      }
    });

    updateAll(updates);
    try {
      const TelegramService = require('./telegram-notification.service');
      for (const item of updates || []) {
        if (!item?.id || item.status === undefined) continue;
        const previous = previousById.get(item.id);
        const updated = db.prepare(
          'SELECT * FROM posts WHERE id = ? AND platform = ? AND data_mode = ?'
        ).get(item.id, platform, dataMode);
        if (updated && previous && String(previous.status) !== String(updated.status)) {
          TelegramService.notifyStatusChange({
            platform,
            postId: updated.id,
            row: updated.sort_order || updated.id,
            status: updated.status,
            previousStatus: previous.status,
            content: updated.content,
            link: updated.link,
            detail: updated.note,
            updatedAt: updated.updated_at,
          });
        }
      }
    } catch (_) {}
    return { updated: updates.length };
  },

  /**
   * Bulk delete posts by ids array
   */
  deleteMany(ids, platform = 'facebook', dataMode = 'post') {
    if (!ids || ids.length === 0) return { deleted: 0 };

    const placeholders = ids.map(() => '?').join(',');
    const result = db.prepare(`
      DELETE FROM posts
      WHERE id IN (${placeholders}) AND platform = ? AND data_mode = ?
    `).run(...ids, normalizePlatform(platform), normalizeDataMode(dataMode));
    return { deleted: result.changes };
  },

  /**
   * Reorder posts based on array of ids (position = index)
   */
  reorder(orderedIds, platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    dataMode = normalizeDataMode(dataMode);
    const reorderAll = db.transaction((ids) => {
      const stmt = db.prepare(`
        UPDATE posts SET sort_order = ?
        WHERE id = ? AND platform = ? AND data_mode = ?
      `);
      ids.forEach((id, index) => {
        stmt.run(index + 1, id, platform, dataMode);
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
   * Maps common column names to DB fields.
   * Nhận lại được mọi cột tuỳ chỉnh của nền tảng (khớp theo tên cột hoặc var_key),
   * nên file vừa xuất ra nhập lại là đủ dữ liệu, không rơi cột nào.
   */
  importSheet(rows, platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    dataMode = normalizeDataMode(dataMode);
    this.ensurePlatformDefaultColumns(platform);
    if (platform === 'facebook') {
      const hasGroupData = (rows || []).some(row => Object.entries(row || {}).some(
        ([header, value]) => FACEBOOK_GROUP_IMPORT_ALIASES.has(
          String(header || '').toLowerCase().trim()
        ) && String(value ?? '').trim()
      ));
      if (hasGroupData) this.ensureFacebookGroupColumn();
    }
    let highestCommentSequence = 0;
    for (const row of rows || []) {
      for (const header of Object.keys(row || {})) {
        highestCommentSequence = Math.max(
          highestCommentSequence,
          CommentColumns.sequenceFromHeader(header) || 0
        );
      }
    }
    if (highestCommentSequence > 0) this.ensureCommentGroupsThrough(highestCommentSequence, platform);
    const exportSchema = this.getExportColumnSchema(platform);
    const schemaLookup = new Map(exportSchema.map(column => [
      String(column.header || '').toLowerCase().trim(),
      column,
    ]));
    // Tra cột tuỳ chỉnh theo cả tên hiển thị lẫn var_key để khớp được file do
    // tool xuất ra (dùng tên) và file khách tự làm (thường dùng var_key)
    const customColumnLookup = new Map();
    for (const column of this.getCustomColumns(platform)) {
      const aliases = [column.name, column.var_key];
      for (const alias of aliases) {
        const key = String(alias || '').toLowerCase().trim();
        if (key && !customColumnLookup.has(key)) customColumnLookup.set(key, column);
      }
    }

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
      'media': 'image_path',

      'product_id': 'product_id',
      'id_sản phẩm': 'product_id',
      'id_san_pham': 'product_id',
      'id sản phẩm': 'product_id',
      'id san pham': 'product_id',
      'mã sản phẩm': 'product_id',
      'ma san pham': 'product_id',

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
    for (const column of exportSchema) {
      if (column.kind !== 'builtin') continue;
      for (const alias of [column.header, ...(column.aliases || [])]) {
        const key = String(alias || '').toLowerCase().trim();
        if (key) fieldMap[key] = column.field;
      }
    }

    for (const column of exportSchema) {
      if (column.kind !== 'custom') continue;
      const customColumn = customColumnLookup.get(String(column.var_key || '').toLowerCase());
      if (!customColumn) continue;
      for (const alias of [column.header, ...(column.aliases || [])]) {
        const key = String(alias || '').toLowerCase().trim();
        if (key) customColumnLookup.set(key, customColumn);
      }
    }

    // Tên khác của cột Link Fanpage mà khách hay gõ trong file tự làm
    const fanpageAliases = ['link_fanpage', 'link fanpage', 'fanpage', 'fanpage link', 'link trang'];
    const groupAliases = [...FACEBOOK_GROUP_IMPORT_ALIASES];

    const preparedRows = rows.map(row => {
      const mapped = {};
      const customValues = {};
      for (const [key, value] of Object.entries(row)) {
        const normalizedKey = key.toLowerCase().trim();
        if (normalizedKey === '#' || normalizedKey === 'stt') continue;

        const schemaColumn = schemaLookup.get(normalizedKey);
        if (schemaColumn && schemaColumn.kind === 'builtin') {
          mapped[schemaColumn.field] = String(value ?? '');
          continue;
        }
        if (schemaColumn && schemaColumn.kind === 'custom') {
          customValues[schemaColumn.id] = String(value ?? '');
          continue;
        }

        // Cột chuẩn của bài đăng
        const dbField = fieldMap[normalizedKey];
        if (dbField) {
          mapped[dbField] = String(value ?? '');
          continue;
        }

        // Cột tuỳ chỉnh của nền tảng
        const customColumn = customColumnLookup.get(normalizedKey)
          || (platform === 'facebook' && fanpageAliases.includes(normalizedKey)
            ? customColumnLookup.get('link_fanpage')
            : null)
          || (platform === 'facebook' && groupAliases.includes(normalizedKey)
            ? customColumnLookup.get('post_group')
            : null);
        if (customColumn) {
          customValues[customColumn.id] = String(value ?? '');
        }
      }
      // If no fields were mapped, try to use first columns in order
      if (Object.keys(mapped).length === 0 && Object.keys(customValues).length === 0) {
        const values = Object.values(row);
        if (values[0] !== undefined) mapped.content = String(values[0] || '');
        if (values[1] !== undefined) mapped.image_path = String(values[1] || '');
        const offset = normalizePlatform(platform) === 'tiktok' ? 1 : 0;
        if (offset && values[2] !== undefined) mapped.product_id = String(values[2] || '');
        if (values[2 + offset] !== undefined) mapped.link = String(values[2 + offset] || '');
        if (values[3 + offset] !== undefined) mapped.target = String(values[3 + offset] || '');
        if (values[4 + offset] !== undefined) mapped.note = String(values[4 + offset] || '');
      }
      return { mapped, customValues };
    });

    // Filter out completely empty rows
    const validRows = preparedRows.filter(row =>
      Object.values(row.mapped).some(v => v && v.trim() !== '')
      || Object.values(row.customValues).some(v => v && v.trim() !== '')
    );

    const insertedIds = this.createMany(validRows.map(row => row.mapped), platform, dataMode);
    for (let index = 0; index < insertedIds.length; index++) {
      const values = validRows[index]?.customValues || {};
      for (const [columnId, value] of Object.entries(values)) {
        if (value) this.setCustomData(insertedIds[index], Number(columnId), value, platform);
      }
    }
    return { imported: insertedIds.length, ids: insertedIds };
  },

  /**
   * Export all posts to xlsx buffer.
   * Xuất đúng những cột đang hiển thị trong bảng dữ liệu, gồm cả cột tuỳ chỉnh
   * của nền tảng (tên profile, link bài, thời gian đăng, bình luận...). Trước đây
   * chỉ xuất mấy cột cố định nên xuất ra rồi nhập lại là mất sạch phần còn lại.
   */
  exportToExcel(platform = 'facebook', dataMode = 'post') {
    platform = normalizePlatform(platform);
    const schema = this.getExportColumnSchema(platform);
    const posts = this.getAllWithCustomData(platform, dataMode);
    const rows = [
      schema.map(column => column.header),
      ...posts.map((post, index) => schema.map(column => {
        if (column.kind === 'rownum') return index + 1;
        if (column.kind === 'builtin') return post[column.field] ?? '';
        return post[`custom_${column.id}`] ?? '';
      })),
    ];

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!cols'] = schema.map(column => ({ wch: column.width || 28 }));
    worksheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(schema.length - 1)}1` };

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Dữ liệu');

    // Write to buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    return buffer;
  },

  /**
   * Get total post count
   */
  getCount(platform = 'facebook') {
    const row = db.prepare('SELECT COUNT(*) as count FROM posts WHERE platform = ?').get(normalizePlatform(platform));
    return row.count;
  },

  /**
   * Get post count by status
   */
  getCountByStatus(status, platform = 'facebook') {
    const row = db.prepare('SELECT COUNT(*) as count FROM posts WHERE status = ? AND platform = ?').get(status, normalizePlatform(platform));
    return row.count;
  },

  // ============================================
  // Custom Columns
  // ============================================

  /**
   * Get all custom columns
   */
  getCustomColumns(platform = 'facebook') {
    return db.prepare('SELECT * FROM custom_columns WHERE platform = ? ORDER BY sort_order ASC, id ASC')
      .all(normalizePlatform(platform));
  },

  /**
   * Add a new custom column
   */
  addCustomColumn(name, col_type = 'text', var_key = '', platform = 'facebook') {
    platform = normalizePlatform(platform);
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM custom_columns WHERE platform = ?').get(platform);
    const key = this.uniqueVarKey(var_key || this.slugKey(name), null, platform);
    const result = db.prepare(
      'INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform) VALUES (?, ?, ?, ?, ?)'
    ).run(name, col_type, key, (maxOrder.max_order || 0) + 1, platform);
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
  uniqueVarKey(key, excludeId = null, platform = 'facebook') {
    platform = normalizePlatform(platform);
    let base = this.slugKey(key);
    let candidate = base;
    let n = 2;
    while (true) {
      const row = excludeId
        ? db.prepare('SELECT id FROM custom_columns WHERE var_key = ? AND id != ? AND platform = ?').get(candidate, excludeId, platform)
        : db.prepare('SELECT id FROM custom_columns WHERE var_key = ? AND platform = ?').get(candidate, platform);
      if (!row) return candidate;
      candidate = base + '_' + n;
      n++;
    }
  },

  /**
   * Update custom column
   */
  updateCustomColumn(id, data, platform = 'facebook') {
    platform = normalizePlatform(platform);
    const existing = db.prepare(
      'SELECT * FROM custom_columns WHERE id = ? AND platform = ?'
    ).get(id, platform);
    if (!existing) return null;
    const commentField = CommentColumns.parseVarKey(existing.var_key);
    const protectedColumn = PROTECTED_CUSTOM_VAR_KEYS.has(existing.var_key) || Boolean(commentField);
    if (protectedColumn && (
      data.name !== undefined
      || data.col_type !== undefined
      || (data.var_key !== undefined && data.var_key !== existing.var_key)
    )) {
      throw new Error('Cột mặc định không được sửa');
    }
    const updates = [];
    const params = [];
    if (data.name !== undefined) { updates.push('name = ?'); params.push(data.name); }
    if (data.col_type !== undefined) { updates.push('col_type = ?'); params.push(data.col_type); }
    if (data.var_key !== undefined) {
      const key = this.uniqueVarKey(data.var_key, id, platform);
      updates.push('var_key = ?'); params.push(key);
    }
    if (data.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(data.sort_order); }
    if (updates.length > 0) {
      params.push(id, platform);
      db.prepare(`UPDATE custom_columns SET ${updates.join(', ')} WHERE id = ? AND platform = ?`).run(...params);
    }
    return db.prepare('SELECT * FROM custom_columns WHERE id = ? AND platform = ?').get(id, platform);
  },

  /**
   * Delete custom column and all its data
   */
  deleteCustomColumn(id, platform = 'facebook') {
    const snapshot = this.getCustomColumnSnapshot(id, platform);
    if (!snapshot) return null;
    if (PROTECTED_CUSTOM_VAR_KEYS.has(snapshot.column.var_key)) {
      throw new Error('Cột mặc định không được xóa');
    }
    if (CommentColumns.parseVarKey(snapshot.column.var_key)) {
      throw new Error('Hãy xóa cả nhóm bình luận thay vì xóa từng cột');
    }
    db.prepare('DELETE FROM post_custom_data WHERE column_id = ?').run(id);
    db.prepare('DELETE FROM custom_columns WHERE id = ?').run(id);
    return snapshot;
  },

  getCustomColumnSnapshot(id, platform = 'facebook') {
    const column = db.prepare(
      'SELECT * FROM custom_columns WHERE id = ? AND platform = ?'
    ).get(id, normalizePlatform(platform));
    if (!column) return null;
    const values = db.prepare('SELECT * FROM post_custom_data WHERE column_id = ?').all(id);
    return { column, values };
  },

  restoreCustomColumn(snapshot, platform = 'facebook') {
    if (!snapshot || !snapshot.column) return null;
    const col = snapshot.column;
    db.prepare(`
      INSERT OR REPLACE INTO custom_columns (id, name, col_type, var_key, sort_order, platform, created_at)
      VALUES (@id, @name, @col_type, @var_key, @sort_order, @platform, @created_at)
    `).run({
      id: col.id,
      name: col.name,
      col_type: col.col_type || 'text',
      var_key: col.var_key || this.slugKey(col.name),
      sort_order: col.sort_order || 0,
      platform: normalizePlatform(platform),
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
  setCustomData(postId, columnId, value, platform = 'facebook', options = {}) {
    platform = normalizePlatform(platform);
    const post = db.prepare('SELECT id FROM posts WHERE id = ? AND platform = ?').get(postId, platform);
    const column = db.prepare('SELECT id, var_key FROM custom_columns WHERE id = ? AND platform = ?').get(columnId, platform);
    const previous = db.prepare(
      'SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?'
    ).get(postId, columnId);
    const storedValue = value || '';
    const commentField = CommentColumns.parseVarKey(column && column.var_key);
    const affectsAgentPayload = !['link_post', 'time_post'].includes(column && column.var_key)
      && !(commentField && ['comment_status', 'time_comment'].includes(commentField.base));
    if (!post || !column) throw new Error('Dữ liệu hoặc cột không thuộc nền tảng đang chọn');
    db.prepare(
      'INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value) VALUES (?, ?, ?)'
    ).run(postId, columnId, storedValue);
    if (
      !options.preserveAgentPayload
      && affectsAgentPayload
      && String(previous && previous.value || '') !== String(storedValue)
    ) {
      db.prepare(
        "UPDATE posts SET agent_payload_json = NULL, updated_at = datetime('now') WHERE id = ? AND platform = ?"
      ).run(postId, platform);
    }
  },

  /**
   * Get all posts with custom column data merged in
   */
  getAllWithCustomData(platform = 'facebook', dataMode = 'post') {
    const posts = this.getAll(platform, dataMode);
    const customCols = this.getCustomColumns(platform);

    if (customCols.length === 0) return posts;

    // Get all custom data in one query
    const postIds = posts.map(post => post.id);
    const allCustomData = postIds.length
      ? db.prepare(`SELECT * FROM post_custom_data WHERE post_id IN (${postIds.map(() => '?').join(',')})`).all(...postIds)
      : [];

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
