/**
 * Durable scheduler for comments posted after supported platform posts.
 *
 * Jobs are persisted before a timer is armed. On startup, waiting jobs and
 * jobs interrupted while running are restored. Browser actions are serialized
 * per profile by ProfileActionQueue, so a due comment never manipulates the
 * same Chrome profile while a post is being published.
 */

const db = require('../database/init');
const fs = require('fs');
const ProfileActionQueue = require('./profile-action-queue.service');
const LicenseService = require('./license.service');
const { PLATFORMS, normalizePlatform, platformLabel } = require('../platforms/platform.utils');

const MAX_TIMEOUT = 2147483647;
const SESSION_RETRY_MS = 5 * 60 * 1000;
const COMMENT_PRIORITY = 100;

function ensureCustomColumn(varKey, colType = 'text', platform = 'facebook') {
  platform = normalizePlatform(platform);
  let col = db.prepare(
    'SELECT * FROM custom_columns WHERE var_key = ? AND platform = ?'
  ).get(varKey, platform);
  if (col) {
    if (varKey === 'comment_media' && col.col_type !== 'file') {
      db.prepare('UPDATE custom_columns SET col_type = ? WHERE id = ?').run('file', col.id);
      col = db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(col.id);
    }
    return col;
  }

  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM custom_columns WHERE platform = ?'
  ).get(platform);
  const result = db.prepare(
    'INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform) VALUES (?, ?, ?, ?, ?)'
  ).run(varKey, colType, varKey, (maxOrder.max_order || 0) + 1, platform);
  return db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(result.lastInsertRowid);
}

function setCustomValue(postId, varKey, value, colType = 'text', platform = 'facebook') {
  const col = ensureCustomColumn(varKey, colType, platform);
  db.prepare(
    'INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value) VALUES (?, ?, ?)'
  ).run(postId, col.id, value == null ? '' : String(value));
}

class CommentJobService {
  constructor() {
    this.timer = null;
    this.initialized = false;
    this.draining = false;
    this.stopping = false;
    this._broadcastLog = null;
  }

  setDefaultBroadcast(fn) {
    this._broadcastLog = fn;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.stopping = false;

    for (const platform of PLATFORMS) {
      ensureCustomColumn('comment', 'text', platform);
      ensureCustomColumn('comment_media', 'file', platform);
      ensureCustomColumn('time_comment', 'text', platform);
      ensureCustomColumn('comment_status', 'text', platform);
    }

    // The selected recovery policy is at-least-once: an interrupted running
    // job is always sent again after restart, even though this may duplicate
    // a comment that Facebook accepted just before the crash.
    db.prepare(`
      UPDATE comment_jobs
      SET status = 'waiting', started_at = NULL,
          last_error = CASE
            WHEN last_error IS NULL OR last_error = '' THEN 'Tool dung/crash khi dang gui; da xep lai'
            ELSE last_error
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `).run();

    this._log(null, `Đã khôi phục ${this.getWaitingCount()} lịch bình luận.`, 'info');
    this._armNext();
  }

  shutdown() {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      db.prepare(`
        UPDATE comment_jobs
        SET status = 'waiting', started_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
      `).run();
    } catch (_) {}
    this.initialized = false;
  }

  schedule({ postId, profileId, postLink, commentText = '', mediaPath = '', dueAt, platform = 'facebook' }) {
    platform = normalizePlatform(platform);
    const runAt = Math.max(0, Number(dueAt) || Date.now());
    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO comment_jobs (
          post_id, profile_id, post_link, comment_text, media_path,
          due_at, status, attempts, platform, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(postId, profileId, postLink, commentText || '', mediaPath || '', runAt, platform);
      setCustomValue(postId, 'time_comment', '', 'text', platform);
      setCustomValue(postId, 'comment_status', 'waiting', 'text', platform);
      return db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(result.lastInsertRowid);
    });

    const job = tx();
    const waitSeconds = Math.max(0, Math.round((job.due_at - Date.now()) / 1000));
    this._log(null, `Đã xếp lịch bình luận bài #${postId} sau ${waitSeconds}s.`, 'info', platform);
    this._armNext();
    return job;
  }

  markSkipped(postId, reason = '', platform = 'facebook') {
    setCustomValue(postId, 'time_comment', '', 'text', platform);
    setCustomValue(postId, 'comment_status', 'skipped', 'text', platform);
    if (reason) this._log(null, `Bỏ qua bình luận bài #${postId}: ${reason}`, 'warning', platform);
  }

  markError(postId, reason, platform = 'facebook') {
    setCustomValue(postId, 'time_comment', '', 'text', platform);
    setCustomValue(postId, 'comment_status', 'error', 'text', platform);
    this._log(null, `Không thể xếp bình luận bài #${postId}: ${reason}`, 'error', platform);
  }

  getWaitingCount() {
    const row = db.prepare("SELECT COUNT(*) AS count FROM comment_jobs WHERE status = 'waiting'").get();
    return Number(row && row.count) || 0;
  }

  getStatus() {
    const rows = db.prepare(
      'SELECT status, COUNT(*) AS count FROM comment_jobs GROUP BY status'
    ).all();
    const counts = {};
    for (const row of rows) counts[row.status] = Number(row.count) || 0;
    return { initialized: this.initialized, draining: this.draining, counts };
  }

  _armNext() {
    if (!this.initialized || this.stopping) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.draining) return;

    const next = db.prepare(`
      SELECT * FROM comment_jobs
      WHERE status = 'waiting'
      ORDER BY due_at ASC, id ASC
      LIMIT 1
    `).get();
    if (!next) return;

    const delay = Math.min(MAX_TIMEOUT, Math.max(0, Number(next.due_at) - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this._drainDue().catch(error => {
        this._log(null, `Lỗi hàng đợi bình luận: ${error.message}`, 'error');
        this.draining = false;
        this._armNext();
      });
    }, delay);
  }

  async _drainDue() {
    if (this.draining || this.stopping) return;
    this.draining = true;

    try {
      while (!this.stopping) {
        const dueJobs = db.prepare(`
          SELECT * FROM comment_jobs
          WHERE status = 'waiting' AND due_at <= ?
          ORDER BY due_at ASC, id ASC
          LIMIT 50
        `).all(Date.now());
        if (dueJobs.length === 0) break;
        await Promise.allSettled(dueJobs.map(job => this._executeJob(job.id)));
      }
    } finally {
      this.draining = false;
      this._armNext();
    }
  }

  async _executeJob(jobId) {
    const claim = db.prepare(`
      UPDATE comment_jobs
      SET status = 'running', started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'waiting'
    `).run(jobId);
    if (!claim || !claim.changes) return;

    let job = db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    try {
      LicenseService.assertPlatform(job.platform);
    } catch (error) {
      await this._rescheduleForSession(job, `Tạm dừng do license: ${error.message}`);
      return;
    }
    this._log(null, `Đến hạn bình luận bài #${job.post_id}; đang chờ profile rảnh...`, 'info', job.platform);

    return ProfileActionQueue.run(job.profile_id, 'comment', async () => {
      const BrowserService = require('./browser.service');
      const { getPlatformAdapter } = require('../platforms');
      const platform = normalizePlatform(job.platform);
      const adapter = getPlatformAdapter(platform);
      let leased = false;

      try {
        const instance = await BrowserService.acquire(job.profile_id);
        leased = true;
        if (!instance || !instance.page) throw new Error('Không lấy được tab trình duyệt để bình luận');

        const page = instance.page;
        const sessionValid = await adapter.validateSession(page);
        if (!sessionValid) {
          await this._rescheduleForSession(
            job,
            `${platformLabel(platform)} mất đăng nhập; sẽ thử lại sau 5 phút`
          );
          return;
        }

        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          db.prepare(`
            UPDATE comment_jobs
            SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(job.id);
          try {
            const result = await adapter.comment(
              page,
              job.post_link,
              job.comment_text || '',
              job.media_path || ''
            );
            await this._markSuccess(job, result && result.postedAt);
            return;
          } catch (error) {
            lastError = error;
            db.prepare(
              'UPDATE comment_jobs SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(error.message || String(error), job.id);

            if (error && error.submitted) {
              const exists = await adapter.hasExistingComment(
                page,
                job.post_link,
                job.comment_text || '',
                job.media_path || ''
              ).catch(() => false);
              if (exists) {
                await this._markSuccess(job);
                return;
              }
            }

            if (attempt < 2) {
              this._log(null, `Bình luận bài #${job.post_id} lỗi; reload và thử lại 1 lần.`, 'warning', job.platform);
              await new Promise(resolve => setTimeout(resolve, 2500));
            }
          }
        }

        await this._markFailed(job, lastError ? lastError.message : 'Không xác minh được bình luận');
      } catch (error) {
        await this._markFailed(job, error.message || String(error));
      } finally {
        if (leased) {
          await BrowserService.release(job.profile_id).catch(() => {});
        }
      }
    }, COMMENT_PRIORITY);
  }

  async _rescheduleForSession(job, reason) {
    const nextDue = Date.now() + SESSION_RETRY_MS;
    db.prepare(`
      UPDATE comment_jobs
      SET status = 'waiting', due_at = ?, started_at = NULL,
          last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextDue, reason, job.id);
    setCustomValue(job.post_id, 'comment_status', 'waiting', 'text', job.platform);
    this._log(null, `Bài #${job.post_id}: ${reason}`, 'warning', job.platform);
  }

  async _markSuccess(job, postedAt = null) {
    const actualTime = postedAt || new Date().toLocaleString('vi-VN');
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE comment_jobs
        SET status = 'success', completed_at = CURRENT_TIMESTAMP,
            last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(job.id);
      setCustomValue(job.post_id, 'comment_status', 'success', 'text', job.platform);
      setCustomValue(job.post_id, 'time_comment', actualTime, 'text', job.platform);
      db.prepare(`
        INSERT INTO activity_logs (
          type, profile_id, post_id, message, status, platform, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run('comment', job.profile_id, job.post_id, `Bình luận bài #${job.post_id} thành công lúc ${actualTime}`, 'success', job.platform);
    });
    tx();
    this._log(null, `Đã bình luận thành công bài #${job.post_id} lúc ${actualTime}.`, 'success', job.platform);
  }

  async _markFailed(job, reason) {
    const message = reason || 'Bình luận thất bại';
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE comment_jobs
        SET status = 'error', completed_at = CURRENT_TIMESTAMP,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(message, job.id);
      setCustomValue(job.post_id, 'comment_status', 'error', 'text', job.platform);
      setCustomValue(job.post_id, 'time_comment', '', 'text', job.platform);
      db.prepare(`
        INSERT INTO activity_logs (
          type, profile_id, post_id, message, status, platform, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run('comment', job.profile_id, job.post_id, `Lỗi bình luận bài #${job.post_id}: ${message}`, 'error', job.platform);
    });
    tx();
    this._log(null, `Bình luận bài #${job.post_id} thất bại: ${message}`, 'error', job.platform);
  }

  _log(profile, message, type = 'info', platform = 'facebook') {
    console.log(`  [CommentQueue] ${message}`);
    if (this._broadcastLog) {
      this._broadcastLog({
        time: new Date().toISOString(),
        profile,
        message,
        type,
        platform: normalizePlatform(platform),
        event: 'comment_job',
      });
    }
  }
}

const singleton = new CommentJobService();
singleton.CommentJobService = CommentJobService;
singleton.ensureCustomColumn = ensureCustomColumn;
singleton.setCustomValue = setCustomValue;

module.exports = singleton;
