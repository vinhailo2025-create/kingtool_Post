/**
 * Cross-platform, per-column data synchronization.
 *
 * Columns are matched by their stable var_key and rows are matched by a
 * hidden sync_key. Sync writes never invoke another rule, so automatic rules
 * are one-way and cannot bounce changes back and forth.
 */
const crypto = require('crypto');
const db = require('../database/init');
const { normalizePlatform } = require('../platforms/platform.utils');
const { sanitizeMediaPath } = require('./media-path.utils');

const PLATFORMS = Object.freeze(['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo']);
const BUILTIN_COLUMNS = Object.freeze({
  content: { var_key: 'content', name: 'Nội dung', col_type: 'text', field: 'content' },
  image_path: { var_key: 'image_path', name: 'Media', col_type: 'file', field: 'image_path' },
  target: { var_key: 'target', name: 'Nhóm/Trang', col_type: 'text', field: 'target' },
  note: { var_key: 'note', name: 'Ghi chú', col_type: 'text', field: 'note' },
  product_id: { var_key: 'product_id', name: 'ID Sản phẩm', col_type: 'text', field: 'product_id', platforms: ['tiktok'] },
});
const BLOCKED_VAR_KEYS = new Set([
  'status', 'link', 'link_post', 'time_post', 'time_comment', 'comment_status',
]);
const CONFLICT_POLICIES = new Set(['fill_empty', 'overwrite']);
const DEFAULT_CONFLICT_POLICY = 'overwrite';

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function normalizeValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function normalizePlatforms(values, sourcePlatform) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const platform = normalizePlatform(value);
    if (!PLATFORMS.includes(platform) || platform === sourcePlatform || result.includes(platform)) continue;
    result.push(platform);
  }
  return result;
}

function normalizePostIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter(Number.isInteger).filter(id => id > 0))];
}

function conflictPolicy(value) {
  return CONFLICT_POLICIES.has(value) ? value : DEFAULT_CONFLICT_POLICY;
}

function builtinFor(varKey, platform) {
  const column = BUILTIN_COLUMNS[varKey];
  if (!column) return null;
  if (column.platforms && !column.platforms.includes(platform)) return null;
  return { ...column, kind: 'builtin', id: null, platform };
}

function customFor(varKey, platform) {
  const row = db.prepare(
    'SELECT * FROM custom_columns WHERE platform = ? AND var_key = ?'
  ).get(platform, varKey);
  return row ? {
    kind: 'custom', id: Number(row.id), var_key: row.var_key,
    name: row.name, col_type: row.col_type || 'text', platform,
  } : null;
}

function resolveColumn(varKey, platform) {
  varKey = String(varKey || '').trim();
  if (!varKey || BLOCKED_VAR_KEYS.has(varKey)) return null;
  return builtinFor(varKey, platform) || customFor(varKey, platform);
}

function createCompatibleCustomColumn(sourceColumn, targetPlatform) {
  if (!sourceColumn || BLOCKED_VAR_KEYS.has(sourceColumn.var_key) || sourceColumn.var_key === 'product_id') {
    return null;
  }
  const existing = customFor(sourceColumn.var_key, targetPlatform);
  if (existing) return existing;
  const max = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM custom_columns WHERE platform = ?'
  ).get(targetPlatform);
  const result = db.prepare(`
    INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    sourceColumn.name || sourceColumn.var_key,
    sourceColumn.col_type || 'text',
    sourceColumn.var_key,
    Number(max.max_order || 0) + 1,
    targetPlatform
  );
  return customFor(sourceColumn.var_key, targetPlatform)
    || { kind: 'custom', id: Number(result.lastInsertRowid), ...sourceColumn, platform: targetPlatform };
}

function compatible(sourceColumn, targetColumn) {
  if (!sourceColumn || !targetColumn) return false;
  if (sourceColumn.var_key !== targetColumn.var_key) return false;
  if (sourceColumn.col_type === targetColumn.col_type) return true;
  // Text and number values are both persisted as strings in this project.
  return ['text', 'number', 'select'].includes(sourceColumn.col_type)
    && ['text', 'number', 'select'].includes(targetColumn.col_type);
}

function sourceRows(platform, postIds) {
  if (!postIds.length) {
    return db.prepare('SELECT * FROM posts WHERE platform = ? ORDER BY sort_order, id').all(platform);
  }
  const placeholders = postIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM posts WHERE platform = ? AND id IN (${placeholders}) ORDER BY sort_order, id`
  ).all(platform, ...postIds);
}

function valueFor(post, column) {
  if (!post || !column) return '';
  if (column.kind === 'builtin') {
    const value = normalizeValue(post[column.field]);
    return column.field === 'image_path' ? sanitizeMediaPath(value) : value;
  }
  const row = db.prepare(
    'SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?'
  ).get(post.id, column.id);
  return normalizeValue(row && row.value);
}

function setValue(postId, column, value) {
  value = normalizeValue(value);
  if (column.kind === 'builtin') {
    if (column.field === 'image_path') value = sanitizeMediaPath(value);
    db.prepare(`UPDATE posts SET ${column.field} = ?, updated_at = datetime('now') WHERE id = ? AND platform = ?`)
      .run(value, postId, column.platform);
    return;
  }
  db.prepare(`
    INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value)
    VALUES (?, ?, ?)
  `).run(postId, column.id, value);
  db.prepare("UPDATE posts SET updated_at = datetime('now') WHERE id = ? AND platform = ?")
    .run(postId, column.platform);
}

function ensureSyncKey(post) {
  if (post.sync_key) return post.sync_key;
  const syncKey = crypto.randomUUID();
  db.prepare('UPDATE posts SET sync_key = ? WHERE id = ? AND platform = ?')
    .run(syncKey, post.id, post.platform);
  post.sync_key = syncKey;
  return syncKey;
}

function findTargetPost(platform, syncKey) {
  if (!syncKey) return null;
  return db.prepare('SELECT * FROM posts WHERE platform = ? AND sync_key = ?').get(platform, syncKey) || null;
}

function createTargetPost(platform, syncKey) {
  const max = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM posts WHERE platform = ?'
  ).get(platform);
  const result = db.prepare(`
    INSERT INTO posts
      (sort_order, content, image_path, link, target, product_id, status, note, platform, sync_key)
    VALUES (?, '', '', '', '', '', 'pending', '', ?, ?)
  `).run(Number(max.max_order || 0) + 1, platform, syncKey);
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(result.lastInsertRowid);
}

function describeTarget(sourceColumn, targetPlatform, createMissing) {
  let targetColumn = resolveColumn(sourceColumn.var_key, targetPlatform);
  if (targetColumn && compatible(sourceColumn, targetColumn)) {
    return { platform: targetPlatform, status: 'matched', column: targetColumn };
  }
  if (targetColumn) {
    return { platform: targetPlatform, status: 'type_mismatch', column: targetColumn };
  }
  const platformScopedBuiltin = BUILTIN_COLUMNS[sourceColumn.var_key]
    && BUILTIN_COLUMNS[sourceColumn.var_key].platforms;
  if (platformScopedBuiltin || BLOCKED_VAR_KEYS.has(sourceColumn.var_key)) {
    return { platform: targetPlatform, status: 'unsupported', column: null };
  }
  return {
    platform: targetPlatform,
    status: createMissing ? 'will_create_column' : 'missing_column',
    column: null,
  };
}

function targetSpecsFrom(options, sourcePlatform) {
  if (Array.isArray(options.target_specs)) {
    return options.target_specs
      .map(spec => ({
        platform: normalizePlatform(spec.platform),
        conflict_policy: conflictPolicy(spec.conflict_policy),
        create_missing: spec.create_missing !== false && Number(spec.create_missing) !== 0,
      }))
      .filter(spec => PLATFORMS.includes(spec.platform) && spec.platform !== sourcePlatform)
      .filter((spec, index, list) => list.findIndex(item => item.platform === spec.platform) === index);
  }
  const policy = conflictPolicy(options.conflict_policy);
  const createMissing = options.create_missing !== false && Number(options.create_missing) !== 0;
  return normalizePlatforms(options.target_platforms, sourcePlatform)
    .map(platform => ({ platform, conflict_policy: policy, create_missing: createMissing }));
}

const DataSyncService = {
  platforms: PLATFORMS,

  getRules(sourcePlatform, sourceVarKey = '') {
    sourcePlatform = normalizePlatform(sourcePlatform);
    const params = [sourcePlatform];
    let where = 'source_platform = ?';
    if (sourceVarKey) {
      where += ' AND source_var_key = ?';
      params.push(String(sourceVarKey));
    }
    return db.prepare(`SELECT * FROM data_sync_rules WHERE ${where} ORDER BY source_var_key, target_platform`)
      .all(...params)
      .map(rule => ({ ...rule, enabled: !!rule.enabled, create_missing: !!rule.create_missing }));
  },

  describeTargets(sourcePlatform, sourceVarKey, createMissing = true) {
    sourcePlatform = normalizePlatform(sourcePlatform);
    const sourceColumn = resolveColumn(sourceVarKey, sourcePlatform);
    if (!sourceColumn) throw new Error('Cột nguồn không hỗ trợ đồng bộ');
    return {
      source: sourceColumn,
      targets: PLATFORMS
        .filter(platform => platform !== sourcePlatform)
        .map(platform => describeTarget(sourceColumn, platform, createMissing)),
    };
  },

  saveRules(sourcePlatform, sourceVarKey, targets, defaults = {}) {
    sourcePlatform = normalizePlatform(sourcePlatform);
    const sourceColumn = resolveColumn(sourceVarKey, sourcePlatform);
    if (!sourceColumn) throw new Error('Cột nguồn không hỗ trợ đồng bộ tự động');
    const normalizedTargets = normalizePlatforms(targets, sourcePlatform);
    const policy = conflictPolicy(defaults.conflict_policy);
    const createMissing = defaults.create_missing !== false && Number(defaults.create_missing) !== 0;
    const enabled = defaults.enabled !== false && Number(defaults.enabled) !== 0;

    db.transaction(() => {
      db.prepare('DELETE FROM data_sync_rules WHERE source_platform = ? AND source_var_key = ?')
        .run(sourcePlatform, sourceVarKey);
      const insert = db.prepare(`
        INSERT INTO data_sync_rules
          (source_platform, source_var_key, target_platform, target_var_key,
           conflict_policy, create_missing, enabled, policy_explicit)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `);
      for (const targetPlatform of normalizedTargets) {
        const description = describeTarget(sourceColumn, targetPlatform, createMissing);
        if (['unsupported', 'type_mismatch'].includes(description.status)) continue;
        insert.run(
          sourcePlatform, sourceVarKey, targetPlatform, sourceVarKey,
          policy, createMissing ? 1 : 0, enabled ? 1 : 0
        );
      }
    })();
    return this.getRules(sourcePlatform, sourceVarKey);
  },

  preview(options = {}) {
    const sourcePlatform = normalizePlatform(options.source_platform);
    const sourceVarKey = String(options.source_var_key || '').trim();
    const sourceColumn = resolveColumn(sourceVarKey, sourcePlatform);
    if (!sourceColumn) throw new Error('Cột nguồn không hỗ trợ đồng bộ');
    const specs = targetSpecsFrom(options, sourcePlatform);
    if (!specs.length) throw new Error('Hãy chọn ít nhất một nền tảng đích');
    const rows = sourceRows(sourcePlatform, normalizePostIds(options.source_post_ids));
    const result = { source_platform: sourcePlatform, source_var_key: sourceVarKey, rows: rows.length, targets: [] };

    for (const spec of specs) {
      const description = describeTarget(sourceColumn, spec.platform, spec.create_missing);
      const target = {
        platform: spec.platform,
        status: description.status,
        column_name: description.column ? description.column.name : sourceColumn.name,
        will_update: 0, will_create: 0, will_skip: 0, conflicts: 0,
      };
      if (['unsupported', 'type_mismatch', 'missing_column'].includes(description.status)) {
        target.will_skip = rows.length;
        result.targets.push(target);
        continue;
      }
      for (const row of rows) {
        const sourceValue = valueFor(row, sourceColumn);
        if (isEmpty(sourceValue)) { target.will_skip++; continue; }
        const targetPost = findTargetPost(spec.platform, row.sync_key);
        if (!targetPost) {
          if (spec.create_missing) target.will_create++;
          else target.will_skip++;
          continue;
        }
        const targetColumn = description.column;
        const oldValue = targetColumn ? valueFor(targetPost, targetColumn) : '';
        if (oldValue === sourceValue) {
          target.will_skip++;
          continue;
        }
        if (spec.conflict_policy === 'fill_empty' && !isEmpty(oldValue)) {
          target.will_skip++;
          target.conflicts++;
        } else {
          target.will_update++;
        }
      }
      result.targets.push(target);
    }
    result.total_changes = result.targets.reduce((sum, item) => sum + item.will_update + item.will_create, 0);
    result.total_skipped = result.targets.reduce((sum, item) => sum + item.will_skip, 0);
    return result;
  },

  execute(options = {}) {
    const sourcePlatform = normalizePlatform(options.source_platform);
    const sourceVarKey = String(options.source_var_key || '').trim();
    const sourceColumn = resolveColumn(sourceVarKey, sourcePlatform);
    if (!sourceColumn) throw new Error('Cột nguồn không hỗ trợ đồng bộ');
    const specs = targetSpecsFrom(options, sourcePlatform);
    if (!specs.length) throw new Error('Hãy chọn ít nhất một nền tảng đích');
    const rows = sourceRows(sourcePlatform, normalizePostIds(options.source_post_ids));
    const mode = options.mode === 'auto' ? 'auto' : 'manual';
    const run = db.prepare(`
      INSERT INTO data_sync_runs (mode, source_platform, source_var_key, status)
      VALUES (?, ?, ?, 'running')
    `).run(mode, sourcePlatform, sourceVarKey);
    const runId = Number(run.lastInsertRowid);
    const summary = { run_id: runId, mode, changed: 0, created: 0, skipped: 0, targets: [] };

    try {
      db.transaction(() => {
        const record = db.prepare(`
          INSERT INTO data_sync_run_items
            (run_id, source_post_id, target_post_id, target_platform, target_var_key,
             target_column_id, old_value, new_value, created_post)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const spec of specs) {
          const detail = { platform: spec.platform, changed: 0, created: 0, skipped: 0, status: 'matched' };
          let targetColumn = resolveColumn(sourceVarKey, spec.platform);
          if (!targetColumn && spec.create_missing) {
            targetColumn = createCompatibleCustomColumn(sourceColumn, spec.platform);
            if (targetColumn) detail.status = 'created_column';
          }
          if (!targetColumn || !compatible(sourceColumn, targetColumn)) {
            detail.status = targetColumn ? 'type_mismatch' : 'unsupported';
            detail.skipped = rows.length;
            summary.skipped += rows.length;
            summary.targets.push(detail);
            continue;
          }
          for (const row of rows) {
            const sourceValue = valueFor(row, sourceColumn);
            if (isEmpty(sourceValue)) { detail.skipped++; summary.skipped++; continue; }
            const syncKey = ensureSyncKey(row);
            let targetPost = findTargetPost(spec.platform, syncKey);
            let createdPost = false;
            if (!targetPost) {
              if (!spec.create_missing) { detail.skipped++; summary.skipped++; continue; }
              targetPost = createTargetPost(spec.platform, syncKey);
              createdPost = true;
            }
            const oldValue = valueFor(targetPost, targetColumn);
            if (oldValue === sourceValue) {
              detail.skipped++; summary.skipped++; continue;
            }
            if (spec.conflict_policy === 'fill_empty' && !isEmpty(oldValue)) {
              detail.skipped++; summary.skipped++; continue;
            }
            setValue(targetPost.id, targetColumn, sourceValue);
            record.run(
              runId, row.id, targetPost.id, spec.platform, sourceVarKey,
              targetColumn.id, oldValue, sourceValue, createdPost ? 1 : 0
            );
            detail.changed++;
            summary.changed++;
            if (createdPost) { detail.created++; summary.created++; }
          }
          summary.targets.push(detail);
        }
        db.prepare(`
          UPDATE data_sync_runs
          SET status = 'success', summary_json = ?, completed_at = datetime('now')
          WHERE id = ?
        `).run(JSON.stringify(summary), runId);
      })();
      return summary;
    } catch (error) {
      db.prepare(`
        UPDATE data_sync_runs SET status = 'error', summary_json = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify({ error: error.message }), runId);
      throw error;
    }
  },

  runAutomatic(sourcePlatform, sourceVarKey, sourcePostIds) {
    sourcePlatform = normalizePlatform(sourcePlatform);
    const rules = this.getRules(sourcePlatform, sourceVarKey).filter(rule => rule.enabled);
    if (!rules.length) return { runs: [], changed: 0, created: 0, skipped: 0 };
    const result = { runs: [], changed: 0, created: 0, skipped: 0 };
    for (const rule of rules) {
      const run = this.execute({
        mode: 'auto', source_platform: sourcePlatform, source_var_key: sourceVarKey,
        source_post_ids: sourcePostIds,
        target_specs: [{
          platform: rule.target_platform,
          conflict_policy: rule.conflict_policy,
          create_missing: !!rule.create_missing,
        }],
      });
      result.runs.push(run.run_id);
      result.changed += run.changed;
      result.created += run.created;
      result.skipped += run.skipped;
    }
    return result;
  },

  undo(runId) {
    runId = Number(runId);
    const run = db.prepare('SELECT * FROM data_sync_runs WHERE id = ?').get(runId);
    if (!run) throw new Error('Không tìm thấy lần đồng bộ');
    if (run.undone_at) throw new Error('Lần đồng bộ này đã được hoàn tác');
    const items = db.prepare(
      'SELECT * FROM data_sync_run_items WHERE run_id = ? ORDER BY id DESC'
    ).all(runId);
    const result = { run_id: runId, restored: 0, removed: 0, skipped: 0 };
    const removedPosts = new Set();

    db.transaction(() => {
      for (const item of items) {
        const key = `${item.target_platform}:${item.target_post_id}`;
        if (removedPosts.has(key)) continue;
        const post = db.prepare('SELECT * FROM posts WHERE id = ? AND platform = ?')
          .get(item.target_post_id, item.target_platform);
        if (!post) { result.skipped++; continue; }
        const column = item.target_column_id
          ? customFor(item.target_var_key, item.target_platform)
          : resolveColumn(item.target_var_key, item.target_platform);
        if (!column || valueFor(post, column) !== normalizeValue(item.new_value)) {
          result.skipped++;
          continue;
        }
        if (item.created_post) {
          db.prepare('DELETE FROM post_custom_data WHERE post_id = ?').run(item.target_post_id);
          db.prepare('DELETE FROM posts WHERE id = ? AND platform = ?')
            .run(item.target_post_id, item.target_platform);
          removedPosts.add(key);
          result.removed++;
        } else {
          setValue(item.target_post_id, column, item.old_value);
          result.restored++;
        }
      }
      db.prepare("UPDATE data_sync_runs SET status = 'undone', undone_at = datetime('now') WHERE id = ?")
        .run(runId);
    })();
    return result;
  },
};

module.exports = DataSyncService;
