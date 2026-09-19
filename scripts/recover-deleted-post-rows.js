const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const result = [];
    while (stmt.step()) result.push(stmt.getAsObject());
    return result;
  } finally {
    stmt.free();
  }
}

function one(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch (_) {
    return {};
  }
}

async function main() {
  const [databasePath, backupDatabasePath] = process.argv.slice(2);
  if (!databasePath || !backupDatabasePath) {
    throw new Error('Usage: node scripts/recover-deleted-post-rows.js <database> <older-backup>');
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(databasePath));
  const old = new SQL.Database(fs.readFileSync(backupDatabasePath));
  const safetyPath = `${databasePath}.before-row-recovery-${Date.now()}.bak`;
  fs.copyFileSync(databasePath, safetyPath);

  try {
    try { db.run("ALTER TABLE posts ADD COLUMN data_mode TEXT DEFAULT 'post'"); } catch (_) {}
    db.run("UPDATE posts SET data_mode = 'post' WHERE data_mode IS NULL OR data_mode = ''");
    db.run(`
      UPDATE posts
      SET data_mode = 'comment_link'
      WHERE status = 'Đã xếp bình luận' AND COALESCE(content, '') = ''
    `);

    const existingIds = new Set(rows(db, 'SELECT id FROM posts').map(item => Number(item.id)));
    const insert = db.prepare(`
      INSERT INTO posts (
        id, sort_order, content, image_path, link, target, product_id, status, note,
        created_at, updated_at, platform, sync_key, agent_data_key, agent_payload_json, data_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let restoredFromBackup = 0;
    let reconstructed = 0;

    db.run('BEGIN');
    try {
      for (const row of rows(old, "SELECT * FROM posts WHERE platform = 'facebook' ORDER BY id")) {
        if (existingIds.has(Number(row.id))) continue;
        insert.run([
          row.id, row.sort_order || row.id, row.content || '', row.image_path || '',
          row.link || '', row.target || '', row.product_id || '', row.status || 'pending',
          row.note || '', row.created_at || new Date().toISOString(),
          row.updated_at || row.created_at || new Date().toISOString(), 'facebook',
          row.sync_key || null, row.agent_data_key || null, row.agent_payload_json || null, 'post',
        ]);
        existingIds.add(Number(row.id));
        restoredFromBackup += 1;
      }

      const customColumns = new Map(rows(
        db,
        "SELECT id, var_key FROM custom_columns WHERE platform = 'facebook'"
      ).map(item => [Number(item.id), item.var_key]));
      const customByPost = new Map();
      for (const value of rows(db, `
        SELECT d.post_id, d.column_id, d.value
        FROM post_custom_data d
        JOIN custom_columns c ON c.id = d.column_id
        LEFT JOIN posts p ON p.id = d.post_id
        WHERE p.id IS NULL AND c.platform = 'facebook'
      `)) {
        const postId = Number(value.post_id);
        if (!customByPost.has(postId)) customByPost.set(postId, {});
        customByPost.get(postId)[customColumns.get(Number(value.column_id))] = value.value || '';
      }

      const firstCommentOnly = one(db, `
        SELECT MIN(j.post_id) AS id
        FROM comment_jobs j
        LEFT JOIN posts p ON p.id = j.post_id
        LEFT JOIN agent_jobs a ON a.post_id = j.post_id AND a.platform = 'facebook'
        LEFT JOIN activity_logs l ON l.post_id = j.post_id AND l.platform = 'facebook' AND l.type = 'post'
        LEFT JOIN post_link_recovery_jobs r ON r.post_id = j.post_id AND r.platform = 'facebook'
        WHERE p.id IS NULL AND a.id IS NULL AND l.id IS NULL AND r.id IS NULL
      `);
      const postCutoff = Number(firstCommentOnly && firstCommentOnly.id) - 1;

      for (const [postId, custom] of [...customByPost.entries()].sort((a, b) => a[0] - b[0])) {
        if (existingIds.has(postId) || (postCutoff > 0 && postId > postCutoff)) continue;

        const agent = one(
          db,
          "SELECT * FROM agent_jobs WHERE post_id = ? AND platform = 'facebook' ORDER BY id DESC LIMIT 1",
          [postId]
        );
        const recovery = one(
          db,
          "SELECT * FROM post_link_recovery_jobs WHERE post_id = ? AND platform = 'facebook' ORDER BY id DESC LIMIT 1",
          [postId]
        );
        const activity = one(
          db,
          "SELECT * FROM activity_logs WHERE post_id = ? AND platform = 'facebook' AND type = 'post' ORDER BY id DESC LIMIT 1",
          [postId]
        );
        const comment = one(
          db,
          "SELECT * FROM comment_jobs WHERE post_id = ? AND platform = 'facebook' AND COALESCE(post_content, '') <> '' ORDER BY id LIMIT 1",
          [postId]
        );
        const payload = parseJson(agent && agent.payload_json);
        const result = parseJson(agent && agent.result_json);
        const media = Array.isArray(payload.media) ? payload.media.join(',') : (payload.media || '');
        const status = result.status
          || (activity && activity.status)
          || (agent && ['success', 'error'].includes(agent.status) ? agent.status : '')
          || (custom.time_post ? 'success' : 'pending');
        const link = result.link_post || custom.link_post || '';
        const target = payload.group || payload.fanpage || custom.post_group || custom.link_fanpage || '';
        const note = result.note
          || (agent && agent.error)
          || (activity && activity.message)
          || 'Khôi phục hàng đăng bài từ dữ liệu còn lại';

        insert.run([
          postId, postId, payload.content || (recovery && recovery.post_content)
            || (comment && comment.post_content) || '',
          media, link, target, payload.product_id || '', status, note,
          (agent && agent.created_at) || (recovery && recovery.created_at)
            || (activity && activity.created_at) || new Date().toISOString(),
          (agent && (agent.completed_at || agent.updated_at)) || (activity && activity.created_at)
            || new Date().toISOString(),
          'facebook', null, null, agent && agent.payload_json, 'post',
        ]);
        existingIds.add(postId);
        reconstructed += 1;
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    } finally {
      insert.free();
    }

    fs.writeFileSync(databasePath, Buffer.from(db.export()));
    console.log(JSON.stringify({
      restored_from_backup: restoredFromBackup,
      reconstructed_from_history: reconstructed,
      total_restored: restoredFromBackup + reconstructed,
      safety_backup: safetyPath,
      source_backup: path.resolve(backupDatabasePath),
    }, null, 2));
  } finally {
    db.close();
    old.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
