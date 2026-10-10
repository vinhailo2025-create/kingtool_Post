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
const { normalizePlatform, platformLabel } = require('../platforms/platform.utils');
const CommentColumns = require('./comment-columns.service');

const MAX_TIMEOUT = 2147483647;
const SESSION_RETRY_MS = 5 * 60 * 1000;
const COMMENT_PRIORITY = 100;
const APPROVAL_PRIORITY = 110;

function approvalRecheckMs() {
  return Math.max(
    60000,
    Number(process.env.FB_GROUP_APPROVAL_RECHECK_MS) || 30 * 60 * 1000
  );
}

function ensureCustomColumn(varKey, colType = 'text', platform = 'facebook') {
  platform = normalizePlatform(platform);
  let col = db.prepare(
    'SELECT * FROM custom_columns WHERE var_key = ? AND platform = ?'
  ).get(varKey, platform);
  const parsed = CommentColumns.parseVarKey(varKey);
  if (col) {
    if (parsed && parsed.base === 'comment_media' && col.col_type !== 'file') {
      db.prepare('UPDATE custom_columns SET col_type = ? WHERE id = ?').run('file', col.id);
      col = db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(col.id);
    }
    return col;
  }
  if (parsed) {
    // Cột bình luận luôn đi theo nhóm 4 cột, không tạo lẻ một cột.
    // Không dùng db.transaction vì hàm này có thể được gọi bên trong transaction khác.
    const find = db.prepare('SELECT * FROM custom_columns WHERE var_key = ? AND platform = ?');
    let nextOrder = Number(db.prepare(
      'SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM custom_columns WHERE platform = ?'
    ).get(platform).max_order || 0) + 1;
    for (const definition of CommentColumns.definitions(parsed.sequence)) {
      if (find.get(definition.varKey, platform)) continue;
      db.prepare(
        'INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform) VALUES (?, ?, ?, ?, ?)'
      ).run(definition.name, definition.colType, definition.varKey, nextOrder++, platform);
    }
    return find.get(varKey, platform);
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

    db.prepare(
      "UPDATE comment_jobs SET chain_id = 'legacy-' || id WHERE chain_id IS NULL OR chain_id = ''"
    ).run();
    db.prepare(
      'UPDATE comment_jobs SET sequence_no = 1 WHERE sequence_no IS NULL OR sequence_no < 1'
    ).run();
    db.prepare(`
      UPDATE comment_jobs
      SET status = 'waiting_approval', started_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'approval_checking'
    `).run();

    const interrupted = db.prepare(
      "SELECT post_id, platform, sequence_no FROM comment_jobs WHERE status = 'running'"
    ).all();
    // A running job may already have reached Facebook. Never send it again
    // automatically after a crash because that can create duplicate comments.
    db.prepare(`
      UPDATE comment_jobs
      SET status = 'error', started_at = NULL, completed_at = CURRENT_TIMESTAMP,
          last_error = 'Tool dừng khi đang gửi; không tự thử lại để tránh bình luận trùng',
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `).run();
    for (const job of interrupted) {
      setCustomValue(
        job.post_id,
        CommentColumns.varKey('comment_status', job.sequence_no),
        'error',
        'text',
        job.platform
      );
    }
    for (const job of db.prepare(
      "SELECT post_id, platform, sequence_no, status FROM comment_jobs WHERE status IN ('waiting','waiting_approval')"
    ).all()) {
      setCustomValue(
        job.post_id,
        CommentColumns.varKey('comment_status', job.sequence_no),
        job.status,
        'text',
        job.platform
      );
    }

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
      const interrupted = db.prepare(
        "SELECT post_id, platform, sequence_no FROM comment_jobs WHERE status = 'running'"
      ).all();
      db.prepare(`
        UPDATE comment_jobs
        SET status = 'error', started_at = NULL, completed_at = CURRENT_TIMESTAMP,
            last_error = 'Tool dừng khi đang gửi; không tự thử lại để tránh bình luận trùng',
            updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
      `).run();
      for (const job of interrupted) {
        setCustomValue(
          job.post_id,
          CommentColumns.varKey('comment_status', job.sequence_no),
          'error',
          'text',
          job.platform
        );
      }
    } catch (_) {}
    this.initialized = false;
  }

  schedule({
    postId,
    profileId,
    postLink,
    commentText = '',
    mediaPath = '',
    dueAt,
    platform = 'facebook',
    sequence = 1,
  }) {
    const jobs = this.scheduleChain({
      postId,
      profileId,
      postLink,
      jobs: [{ sequence, commentText, mediaPath, dueAt, delayAfterPreviousMs: 0 }],
      continueOnError: true,
      platform,
    });
    return jobs[0] || null;
  }

  scheduleWaitingApproval({
    postId,
    profileId,
    groupUrl,
    postContent,
    identityType = 'profile',
    identityPageUrl = '',
    jobs = [],
    continueOnError = true,
    platform = 'facebook',
  }) {
    return this.scheduleChain({
      postId,
      profileId,
      postLink: 'Bài đăng chờ duyệt',
      jobs,
      continueOnError,
      platform,
      waitingApproval: true,
      groupUrl,
      postContent,
      identityType,
      identityPageUrl,
    });
  }

  // Bai Profile/Fanpage da dang xong nhung chua lay duoc link.
  // Do chuoi binh luan vao trang thai cho, de post-link-recovery.service
  // tim link roi tu danh thuc lai (thay vi bao loi va bo luon binh luan).
  scheduleWaitingLink({
    postId,
    profileId,
    postContent,
    identityType = 'profile',
    identityPageUrl = '',
    jobs = [],
    continueOnError = true,
    platform = 'facebook',
  }) {
    return this.scheduleChain({
      postId,
      profileId,
      postLink: 'Đang chờ lấy link',
      jobs,
      continueOnError,
      platform,
      waitingApproval: true,
      groupUrl: '',
      postContent,
      identityType,
      identityPageUrl,
    });
  }

  // Binh luan hang loat vao mot link Facebook co san (khong dang bai).
  // Ghi comment{n}/comment_media{n}/link_post lên hàng riêng để hiển thị
  // trên grid, rồi xếp chuỗi comment jobs bằng scheduleChain.
  scheduleCommentOnLink({
    platform = 'facebook',
    postId,
    profileId,
    postLink,
    comments = [],
    continueOnError,
    identityType = 'profile',
    identityPageUrl = '',
  }) {
    platform = normalizePlatform(platform);
    const link = String(postLink || '').trim();
    if (!postId) throw new Error('Thiếu postId để bình luận theo link');
    if (!profileId) throw new Error('Thiếu profile để bình luận theo link');
    if (!link) throw new Error('Thiếu link bài để bình luận');

    const normalized = (Array.isArray(comments) ? comments : [comments])
      .map(item => {
        if (item && typeof item === 'object') {
          return {
            text: String(item.text || item.comment || '').trim(),
            media: String(item.media || item.mediaPath || item.comment_media || '').trim(),
          };
        }
        return { text: String(item || '').trim(), media: '' };
      })
      .filter(item => item.text || item.media);
    if (!normalized.length) throw new Error('Không có nội dung bình luận');

    // Dam bao du nhom cot binh luan (hien grid + retry doc lai)
    require('./data.service').ensureCommentGroupsThrough(normalized.length, platform);
    normalized.forEach((item, index) => {
      const sequence = index + 1;
      setCustomValue(postId, CommentColumns.varKey('comment', sequence), item.text, 'text', platform);
      if (item.media) {
        setCustomValue(
          postId,
          CommentColumns.varKey('comment_media', sequence),
          item.media,
          'file',
          platform
        );
      }
    });
    setCustomValue(postId, 'link_post', link, 'text', platform);

    const fresh = [];
    const replayed = [];
    normalized.forEach((item, index) => {
      const existing = db.prepare(`
        SELECT * FROM comment_jobs
        WHERE platform = ? AND profile_id = ? AND post_link = ?
          AND COALESCE(comment_text, '') = ?
          AND COALESCE(media_path, '') = ?
        ORDER BY id ASC LIMIT 1
      `).get(platform, profileId, link, item.text, item.media);
      if (existing) {
        replayed.push(existing);
        setCustomValue(
          postId,
          CommentColumns.varKey('comment_status', index + 1),
          'skipped',
          'text',
          platform
        );
      } else {
        fresh.push({ ...item, sequence: index + 1 });
      }
    });
    if (!fresh.length) {
      db.prepare(`
        UPDATE posts
        SET note = 'Đã bỏ qua: link và nội dung này đã có lịch sử bình luận',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND platform = ?
      `).run(postId, platform);
      replayed.created_count = 0;
      this._log(null, `Bỏ qua hàng #${postId}: link và nội dung đã chạy trước đó.`, 'warning', platform);
      return replayed;
    }

    // Bình luận theo link là tác vụ riêng: chạy ngay và không dùng rule delay
    // hay công tắc tự động bình luận của luồng đăng bài.
    const cont = continueOnError === undefined ? true : !!continueOnError;
    const now = Date.now();
    const jobs = fresh.map((item, index) => ({
      sequence: item.sequence,
      commentText: item.text,
      mediaPath: item.media,
      dueAt: index === 0 ? now : 0,
      delayAfterPreviousMs: 0,
    }));

    const fanpageHref = String(identityPageUrl || '').trim();
    const created = this.scheduleChain({
      postId,
      profileId,
      postLink: link,
      jobs,
      continueOnError: cont,
      platform,
      identityType: fanpageHref ? 'fanpage' : (identityType || 'profile'),
      identityPageUrl: fanpageHref,
    });
    created.created_count = created.length;
    return created;
  }

  scheduleChain({
    postId,
    profileId,
    postLink,
    jobs = [],
    continueOnError = true,
    platform = 'facebook',
    waitingApproval = false,
    groupUrl = '',
    postContent = '',
    identityType = 'profile',
    identityPageUrl = '',
  }) {
    platform = normalizePlatform(platform);
    const ordered = [...jobs]
      .filter(job => job && (job.commentText || job.mediaPath))
      .sort((a, b) => Number(a.sequence || 1) - Number(b.sequence || 1));
    if (!ordered.length) return [];

    const chainId = `${postId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const tx = db.transaction(() => {
      const created = [];
      let previousJobId = null;
      const insert = db.prepare(`
        INSERT INTO comment_jobs (
          post_id, profile_id, post_link, comment_text, media_path,
          due_at, status, attempts, platform, sequence_no, chain_id,
          previous_job_id, delay_after_previous_ms, continue_on_error,
          group_url, post_content, identity_type, identity_page_url,
          approval_delay_ms, approval_checked_at, approval_attempts,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, NULL, 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `);

      for (let index = 0; index < ordered.length; index++) {
        const item = ordered[index];
        const sequence = CommentColumns.normalizeSequence(item.sequence);
        const status = index === 0
          ? (waitingApproval ? 'waiting_approval' : 'waiting')
          : 'blocked';
        const runAt = status === 'waiting'
          ? Math.max(0, Number(item.dueAt) || Date.now())
          : (status === 'waiting_approval' ? Date.now() + approvalRecheckMs() : 0);
        const approvalDelayMs = Math.max(
          0,
          Number(item.delayFromApprovalMs ?? item.approvalDelayMs) || 0
        );
        const result = insert.run(
          postId,
          profileId,
          postLink,
          item.commentText || '',
          item.mediaPath || '',
          runAt,
          status,
          platform,
          sequence,
          chainId,
          previousJobId,
          Math.max(0, Number(item.delayAfterPreviousMs) || 0),
          continueOnError ? 1 : 0,
          groupUrl || '',
          postContent || '',
          identityType === 'fanpage' ? 'fanpage' : 'profile',
          identityPageUrl || '',
          approvalDelayMs
        );
        previousJobId = result.lastInsertRowid;
        setCustomValue(
          postId,
          CommentColumns.varKey('time_comment', sequence),
          '',
          'text',
          platform
        );
        setCustomValue(
          postId,
          CommentColumns.varKey('comment_status', sequence),
          status,
          'text',
          platform
        );
        created.push(db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(result.lastInsertRowid));
      }
      return created;
    });

    const created = tx();
    const first = created[0];
    const waitSeconds = Math.max(0, Math.round((first.due_at - Date.now()) / 1000));
    this._log(
      null,
      waitingApproval
        ? (groupUrl
          ? `Da xep ${created.length} binh luan cho bai #${postId}; cho quan tri vien duyet bai.`
          : `Da xep ${created.length} binh luan cho bai #${postId}; cho lay duoc link bai.`)
        : `Da xep ${created.length} binh luan cho bai #${postId}; binh luan dau sau ${waitSeconds}s.`,
      'info',
      platform
    );
    this._armNext();
    return created;
  }

  markApprovalFound(job, postLink, foundAt = Date.now()) {
    if (!job || !job.id) throw new Error('Khong co job cho duyet de cap nhat');
    const chainId = job.chain_id;
    const normalizedFoundAt = Math.max(0, Number(foundAt) || Date.now());
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE comment_jobs
        SET post_link = ?, approval_checked_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE chain_id = ?
      `).run(postLink, chainId);
      db.prepare(`
        UPDATE comment_jobs
        SET status = 'waiting', due_at = ?,
            last_error = NULL, started_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('waiting_approval','approval_checking')
      `).run(
        normalizedFoundAt + Math.max(0, Number(job.approval_delay_ms) || 0),
        job.id
      );
      setCustomValue(job.post_id, 'link_post', postLink, 'text', job.platform);
      setCustomValue(
        job.post_id,
        CommentColumns.varKey('comment_status', job.sequence_no),
        'waiting',
        'text',
        job.platform
      );
      db.prepare(`
        UPDATE posts
        SET link = ?, note = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND platform = ?
      `).run(
        postLink,
        job.group_url
          ? `Bài Group đã được duyệt; tìm thấy permalink lúc ${new Date(normalizedFoundAt).toLocaleString('vi-VN')}`
          : `Đã tìm được link bài lúc ${new Date(normalizedFoundAt).toLocaleString('vi-VN')}`,
        job.post_id,
        job.platform
      );
    });
    tx();
    try {
      const recovery = require('./post-link-recovery.service');
      const recoveryJob = recovery.getByPost(job.post_id, job.platform);
      if (recoveryJob && recoveryJob.status !== 'success') {
        recovery._markFound(recoveryJob, postLink, normalizedFoundAt);
      }
    } catch (_) {}
    this._notifyTelegram(job, 'waiting', `Đã tìm thấy link: ${postLink}`, postLink);
    this._log(
      null,
      `Da tim thay bai Group #${job.post_id} sau khi duyet: ${postLink}`,
      'success',
      job.platform
    );
    this._armNext();
    return db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(job.id);
  }

  markApprovalPending(job, reason = '') {
    const nextDue = Date.now() + approvalRecheckMs();
    db.prepare(`
      UPDATE comment_jobs
      SET status = 'waiting_approval', due_at = ?,
          approval_checked_at = CURRENT_TIMESTAMP,
          approval_attempts = COALESCE(approval_attempts, 0) + 1,
          started_at = NULL, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('waiting_approval','approval_checking')
    `).run(nextDue, reason || null, job.id);
    setCustomValue(
      job.post_id,
      CommentColumns.varKey('comment_status', job.sequence_no),
      'waiting_approval',
      'text',
      job.platform
    );
    this._notifyTelegram(job, 'waiting_approval', reason);
    this._log(
      null,
      job.group_url
        ? `Bai Group #${job.post_id} chua duoc duyet; se tim lai sau khoang 30 phut.`
        : `Bai #${job.post_id} chua co link; se kiem tra lai sau khoang 30 phut.`,
      'info',
      job.platform
    );
    this._armNext();
    return db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(job.id);
  }

  retry(postId, platform = 'facebook', sequence = null) {
    platform = normalizePlatform(platform);
    const sequenceFilter = sequence == null ? '' : 'AND sequence_no = ?';
    const params = sequence == null
      ? [postId, platform]
      : [postId, platform, CommentColumns.normalizeSequence(sequence)];
    const job = db.prepare(`
      SELECT * FROM comment_jobs
      WHERE post_id = ? AND platform = ?
        ${sequenceFilter}
      ORDER BY id DESC
      LIMIT 1
    `).get(...params);
    if (!job) throw new Error(`Không tìm thấy lịch bình luận của bài #${postId}`);
    if (job.status !== 'error') {
      throw new Error(`Chỉ chạy lại lịch bình luận đang lỗi; trạng thái hiện tại: ${job.status}`);
    }

    db.prepare(`
      UPDATE comment_jobs
      SET status = 'waiting', due_at = ?, attempts = 0, started_at = NULL,
          completed_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(Date.now(), job.id);
    setCustomValue(
      postId,
      CommentColumns.varKey('time_comment', job.sequence_no),
      '',
      'text',
      platform
    );
    setCustomValue(
      postId,
      CommentColumns.varKey('comment_status', job.sequence_no),
      'waiting',
      'text',
      platform
    );
    this._armNext();
    return db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(job.id);
  }

  markSkipped(postId, reason = '', platform = 'facebook', sequence = 1) {
    setCustomValue(postId, CommentColumns.varKey('time_comment', sequence), '', 'text', platform);
    setCustomValue(postId, CommentColumns.varKey('comment_status', sequence), 'skipped', 'text', platform);
    this._notifyTelegram({ post_id: postId, sequence_no: sequence, platform }, 'skipped', reason);
    if (reason) this._log(null, `Bỏ qua bình luận bài #${postId}: ${reason}`, 'warning', platform);
  }

  markError(postId, reason, platform = 'facebook', sequence = 1) {
    setCustomValue(postId, CommentColumns.varKey('time_comment', sequence), '', 'text', platform);
    setCustomValue(postId, CommentColumns.varKey('comment_status', sequence), 'error', 'text', platform);
    this._notifyTelegram({ post_id: postId, sequence_no: sequence, platform }, 'error', reason);
    this._log(null, `Không thể xếp bình luận bài #${postId}: ${reason}`, 'error', platform);
  }

  updateManualStatus(postId, sequence, status, platform = 'facebook') {
    platform = normalizePlatform(platform);
    sequence = CommentColumns.normalizeSequence(sequence);
    const allowed = new Set(['waiting', 'success', 'error', 'skipped']);
    if (!allowed.has(status)) return null;
    const job = db.prepare(`
      SELECT * FROM comment_jobs
      WHERE post_id = ? AND platform = ? AND sequence_no = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(postId, platform, sequence);
    if (!job || job.status === 'running') return job || null;

    if (status === 'waiting') {
      db.prepare(`
        UPDATE comment_jobs
        SET status = 'waiting', due_at = ?, attempts = 0, started_at = NULL,
            completed_at = NULL, last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(Date.now(), job.id);
      this._armNext();
    } else {
      const terminal = ['success', 'error', 'skipped'].includes(status);
      db.prepare(`
        UPDATE comment_jobs
        SET status = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, terminal ? new Date().toISOString() : null, job.id);
      if (terminal) {
        this._unlockNext(
          { ...job, status },
          status !== 'error' || Number(job.continue_on_error) !== 0
        );
      }
    }
    return db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(job.id);
  }

  // Dừng hàng đợi bình luận. cancel=false: tạm dừng (giữ để chạy tiếp);
  // cancel=true: hủy xóa khỏi hàng đợi. Bình luận đang gửi (running) hoặc đang
  // tìm bài (approval_checking) KHÔNG bị đụng để tránh bình luận trùng.
  stop({ platform = 'all', cancel = false } = {}) {
    const scope = platform === 'all' ? 'all' : normalizePlatform(platform);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = db.prepare(`
      SELECT * FROM comment_jobs
      WHERE status IN ('waiting','waiting_approval','blocked')
        AND (? = 'all' OR platform = ?)
    `).all(scope, scope);
    const runningLeft = db.prepare(`
      SELECT COUNT(*) AS count FROM comment_jobs
      WHERE status IN ('running','approval_checking') AND (? = 'all' OR platform = ?)
    `).get(scope, scope).count;

    const tx = db.transaction(() => {
      for (const job of pending) {
        if (cancel) {
          db.prepare('DELETE FROM comment_jobs WHERE id = ?').run(job.id);
          setCustomValue(
            job.post_id,
            CommentColumns.varKey('comment_status', job.sequence_no),
            '',
            'text',
            job.platform
          );
          setCustomValue(
            job.post_id,
            CommentColumns.varKey('time_comment', job.sequence_no),
            '',
            'text',
            job.platform
          );
        } else {
          db.prepare(`
            UPDATE comment_jobs
            SET status = 'stopped', started_at = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(job.id);
          setCustomValue(
            job.post_id,
            CommentColumns.varKey('comment_status', job.sequence_no),
            'stopped',
            'text',
            job.platform
          );
        }
      }
    });
    tx();

    const runningNote = runningLeft
      ? `; ${runningLeft} bình luận đang gửi vẫn chạy nốt`
      : '';
    this._log(
      null,
      cancel
        ? `Đã hủy ${pending.length} bình luận đang chờ${runningNote}.`
        : `Đã tạm dừng ${pending.length} bình luận đang chờ${runningNote}.`,
      'warning',
      scope === 'all' ? 'facebook' : scope
    );
    this._armNext();
    return {
      platform: scope,
      mode: cancel ? 'cancel' : 'pause',
      affected: pending.length,
      running_left: Number(runningLeft) || 0,
    };
  }

  // Chạy tiếp các bình luận đã tạm dừng (status 'stopped').
  resume({ platform = 'all' } = {}) {
    const scope = platform === 'all' ? 'all' : normalizePlatform(platform);
    const stopped = db.prepare(`
      SELECT * FROM comment_jobs
      WHERE status = 'stopped' AND (? = 'all' OR platform = ?)
      ORDER BY chain_id ASC, sequence_no ASC, id ASC
    `).all(scope, scope);

    const tx = db.transaction(() => {
      for (const job of stopped) {
        let isHead = !job.previous_job_id;
        if (job.previous_job_id) {
          const prev = db.prepare('SELECT status FROM comment_jobs WHERE id = ?').get(job.previous_job_id);
          isHead = Boolean(prev && prev.status === 'success');
        }
        if (isHead) {
          const hasRealLink = /^https?:\/\//i.test(String(job.post_link || ''));
          const status = hasRealLink ? 'waiting' : 'waiting_approval';
          db.prepare(`
            UPDATE comment_jobs
            SET status = ?, due_at = ?, started_at = NULL,
                last_error = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(status, Date.now(), job.id);
          setCustomValue(
            job.post_id,
            CommentColumns.varKey('comment_status', job.sequence_no),
            status,
            'text',
            job.platform
          );
        } else {
          db.prepare(`
            UPDATE comment_jobs
            SET status = 'blocked', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(job.id);
          setCustomValue(
            job.post_id,
            CommentColumns.varKey('comment_status', job.sequence_no),
            'blocked',
            'text',
            job.platform
          );
        }
      }
    });
    tx();

    this._log(
      null,
      `Đã chạy tiếp ${stopped.length} bình luận đã tạm dừng.`,
      'info',
      scope === 'all' ? 'facebook' : scope
    );
    this._armNext();
    return { platform: scope, resumed: stopped.length };
  }

  getWaitingCount() {
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM comment_jobs WHERE status IN ('waiting','waiting_approval')"
    ).get();
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

  refreshSchedule() {
    this._armNext();
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
      WHERE status IN ('waiting','waiting_approval')
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
          WHERE status IN ('waiting','waiting_approval') AND due_at <= ?
          ORDER BY due_at ASC, id ASC
          LIMIT 50
        `).all(Date.now());
        if (dueJobs.length === 0) break;
        // Keep each physical profile strictly sequential. Claiming every due
        // job at once made queued work appear as "running" for a long time.
        const jobsByProfile = new Map();
        for (const job of dueJobs) {
          const key = String(job.profile_id);
          if (!jobsByProfile.has(key)) jobsByProfile.set(key, []);
          jobsByProfile.get(key).push(job);
        }
        await Promise.allSettled([...jobsByProfile.values()].map(async jobs => {
          for (const job of jobs) {
            if (this.stopping) break;
            if (job.status === 'waiting_approval') {
              await this._recoverWaitingApproval(job.id);
            } else {
              await this._executeJob(job.id);
            }
          }
        }));
      }
    } finally {
      this.draining = false;
      this._armNext();
    }
  }

  async _recoverWaitingApproval(jobId) {
    const claim = db.prepare(`
      UPDATE comment_jobs
      SET status = 'approval_checking', started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'waiting_approval'
    `).run(jobId);
    if (!claim || !claim.changes) return;
    const job = db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    if (job.platform !== 'facebook' || !job.post_content) {
      this.markApprovalPending(job, 'Thieu URL Group hoac noi dung de tim bai');
      return;
    }
    // Khong co group_url = bai Profile/Fanpage dang cho lay lai link.
    // post-link-recovery.service da mo trinh duyet tim ho roi, o day chi doc ket qua
    // de tranh hai service cung mo mot profile de tim cung mot bai.
    if (!job.group_url) {
      return this._awaitRecoveredLink(job);
    }

    try {
      LicenseService.assertPlatform('facebook');
    } catch (error) {
      this.markApprovalPending(job, `Tam dung do license: ${error.message}`);
      return;
    }

    return ProfileActionQueue.run(job.profile_id, 'find-group-post', async () => {
      const BrowserService = require('./browser.service');
      const { getPlatformAdapter } = require('../platforms');
      const adapter = getPlatformAdapter('facebook');
      let leased = false;
      try {
        const instance = await BrowserService.acquire(job.profile_id, { platform: job.platform });
        leased = true;
        if (!instance || !instance.page) throw new Error('Khong lay duoc tab de tim bai Group');
        const valid = await adapter.validateSession(instance.page);
        if (!valid) throw new Error('Facebook mat dang nhap; thieu cookie c_user');
        const result = await adapter.findGroupPost(
          instance.page,
          job.group_url,
          job.post_content,
          { identityPageUrl: job.identity_page_url || '' }
        );
        if (result && result.postLink && result.permalinkVerified) {
          return this.markApprovalFound(job, result.postLink, Date.now());
        }
        return this.markApprovalPending(job, 'Chua tim thay bai da duoc duyet');
      } catch (error) {
        return this.markApprovalPending(job, error.message || String(error));
      } finally {
        if (leased) await BrowserService.release(job.profile_id).catch(() => {});
      }
    }, APPROVAL_PRIORITY);
  }

  _awaitRecoveredLink(job) {
    let recoveryJob = null;
    try {
      recoveryJob = require('./post-link-recovery.service').getByPost(job.post_id, job.platform);
    } catch (_) {}
    const link = String((recoveryJob && recoveryJob.found_link) || '');
    if (/^https:\/\/(?:www\.)?facebook\.com\//i.test(link)) {
      return this.markApprovalFound(job, link, Date.now());
    }
    const status = String((recoveryJob && recoveryJob.status) || '');
    if (!recoveryJob || ['expired', 'error'].includes(status)) {
      return this.markApprovalFailed(
        job,
        'Khong tim lai duoc link bai dang; hay dien link thu cong roi chay lai binh luan'
      );
    }
    return this.markApprovalPending(job, 'Dang cho lay lai link bai dang');
  }

  markApprovalFailed(job, reason = '') {
    db.prepare(`
      UPDATE comment_jobs
      SET status = 'error', due_at = 0, started_at = NULL,
          completed_at = CURRENT_TIMESTAMP, last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('waiting_approval','approval_checking')
    `).run(reason || null, job.id);
    setCustomValue(
      job.post_id,
      CommentColumns.varKey('comment_status', job.sequence_no),
      'error',
      'text',
      job.platform
    );
    this._unlockNext(job, false);
    this._notifyTelegram(job, 'error', reason);
    this._log(null, `Khong the binh luan bai #${job.post_id}: ${reason}`, 'error', job.platform);
    this._armNext();
    return db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(job.id);
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
    setCustomValue(
      job.post_id,
      CommentColumns.varKey('comment_status', job.sequence_no),
      'running',
      'text',
      job.platform
    );
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
        const instance = await BrowserService.acquire(job.profile_id, { platform });
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
            job.media_path || '',
            {
              identityPageUrl: job.identity_page_url || '',
              manageIdentity: platform === 'facebook',
            }
          );
          await this._markSuccess(job, result && result.postedAt);
          return;
        } catch (error) {
          const message = error.message || String(error);
          if (error && error.submitted) {
            await this._markSuccess(job);
            db.prepare(
              'UPDATE comment_jobs SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(`Đã bấm gửi nhưng không xác minh được; không tự thử lại: ${message}`, job.id);
            this._log(
              null,
              `Bài #${job.post_id} đã bấm gửi; dừng sau một lần để tránh bình luận trùng.`,
              'warning',
              job.platform
            );
            return;
          }
          await this._markFailed(job, message);
        }
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
    setCustomValue(
      job.post_id,
      CommentColumns.varKey('comment_status', job.sequence_no),
      'waiting',
      'text',
      job.platform
    );
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
      setCustomValue(
        job.post_id,
        CommentColumns.varKey('comment_status', job.sequence_no),
        'success',
        'text',
        job.platform
      );
      setCustomValue(
        job.post_id,
        CommentColumns.varKey('time_comment', job.sequence_no),
        actualTime,
        'text',
        job.platform
      );
      db.prepare(`
        INSERT INTO activity_logs (
          type, profile_id, post_id, message, status, platform, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run('comment', job.profile_id, job.post_id, `Bình luận bài #${job.post_id} thành công lúc ${actualTime}`, 'success', job.platform);
    });
    tx();
    this._notifyTelegram(job, 'success', `Đã hoàn tất lúc ${actualTime}`);
    this._unlockNext(job, true);
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
      setCustomValue(
        job.post_id,
        CommentColumns.varKey('comment_status', job.sequence_no),
        'error',
        'text',
        job.platform
      );
      setCustomValue(
        job.post_id,
        CommentColumns.varKey('time_comment', job.sequence_no),
        '',
        'text',
        job.platform
      );
      db.prepare(`
        INSERT INTO activity_logs (
          type, profile_id, post_id, message, status, platform, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run('comment', job.profile_id, job.post_id, `Lỗi bình luận bài #${job.post_id}: ${message}`, 'error', job.platform);
    });
    tx();
    this._notifyTelegram(job, 'error', message, message);
    this._unlockNext(job, Number(job.continue_on_error) !== 0);
    this._log(null, `Bình luận bài #${job.post_id} thất bại: ${message}`, 'error', job.platform);
  }

  _notifyTelegram(job, status, detail = '', link = '') {
    try {
      require('./telegram-notification.service').notifyStatusChange({
        platform: job.platform,
        postId: job.post_id,
        row: job.post_id,
        profile: job.profile_name || '',
        status,
        detail,
        link,
        error: status === 'error' ? detail : '',
        content: job.comment_text || '',
        eventKey: `comment:${job.id || `${job.post_id}:${job.sequence_no}`}:${status}:${detail}`,
      });
    } catch (_) {}
  }

  _unlockNext(job, shouldContinue) {
    const blocked = db.prepare(`
      SELECT * FROM comment_jobs
      WHERE chain_id = ? AND status = 'blocked'
      ORDER BY sequence_no ASC, id ASC
    `).all(job.chain_id);
    if (!blocked.length) return null;

    if (!shouldContinue) {
      db.transaction(() => {
        for (const item of blocked) {
          db.prepare(`
            UPDATE comment_jobs
            SET status = 'skipped', completed_at = CURRENT_TIMESTAMP,
                last_error = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'blocked'
          `).run('Da dung chuoi do binh luan truoc bi loi', item.id);
          setCustomValue(
            item.post_id,
            CommentColumns.varKey('comment_status', item.sequence_no),
            'skipped',
            'text',
            item.platform
          );
          setCustomValue(
            item.post_id,
            CommentColumns.varKey('time_comment', item.sequence_no),
            '',
            'text',
            item.platform
          );
        }
      })();
      return null;
    }

    const next = blocked[0];
    const dueAt = Date.now() + Math.max(0, Number(next.delay_after_previous_ms) || 0);
    const changed = db.prepare(`
      UPDATE comment_jobs
      SET status = 'waiting', due_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'blocked'
    `).run(dueAt, next.id);
    if (!changed || !changed.changes) return null;

    setCustomValue(
      next.post_id,
      CommentColumns.varKey('comment_status', next.sequence_no),
      'waiting',
      'text',
      next.platform
    );
    const waitSeconds = Math.max(0, Math.round((dueAt - Date.now()) / 1000));
    this._log(
      null,
      `Binh luan ${next.sequence_no} cua bai #${next.post_id} se chay sau ${waitSeconds}s.`,
      'info',
      next.platform
    );
    return db.prepare('SELECT * FROM comment_jobs WHERE id = ?').get(next.id);
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
