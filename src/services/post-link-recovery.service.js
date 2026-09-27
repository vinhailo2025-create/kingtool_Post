/**
 * Durable, read-only permalink recovery for Facebook publishes.
 *
 * Facebook can accept a video or a moderated Group post before its permalink
 * is visible. These jobs only inspect already-published content; they never
 * call the publish path.
 */

const db = require('../database/init');
const BrowserService = require('./browser.service');
const ProfileActionQueue = require('./profile-action-queue.service');
const LicenseService = require('./license.service');
const CommentColumns = require('./comment-columns.service');
const AgentEvents = require('./agent-event.service');

const MAX_TIMEOUT = 2147483647;
const RECOVERY_PRIORITY = 105;
const FACEBOOK_LINK_RE = /^https:\/\/(?:www\.)?facebook\.com\//i;
const VIDEO_RE = /\.(?:mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)(?:$|[?#])/i;

function initialDelayMs(targetType) {
  const envKey = targetType === 'group'
    ? 'FB_GROUP_LINK_RECOVERY_INITIAL_MS'
    : 'FB_VIDEO_LINK_RECOVERY_INITIAL_MS';
  const fallback = targetType === 'group' ? 5 * 60 * 1000 : 60 * 1000;
  return Math.max(1000, Number(process.env[envKey]) || fallback);
}

function retryDelayMs(targetType, attempts) {
  const envKey = targetType === 'group'
    ? 'FB_GROUP_LINK_RECOVERY_RECHECK_MS'
    : 'FB_VIDEO_LINK_RECOVERY_RECHECK_MS';
  const fallback = targetType === 'group' ? 30 * 60 * 1000 : 5 * 60 * 1000;
  const configured = Math.max(1000, Number(process.env[envKey]) || fallback);
  return Math.min(30 * 60 * 1000, configured * Math.max(1, Math.min(6, attempts)));
}

function recoveryMaxAttempts(targetType) {
  const envKey = targetType === 'group'
    ? 'FB_GROUP_LINK_RECOVERY_MAX_ATTEMPTS'
    : 'FB_VIDEO_LINK_RECOVERY_MAX_ATTEMPTS';
  const configured = Number(process.env[envKey]);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return targetType === 'group' ? 1 : 12;
}

function recoveryMaxAgeMs(targetType) {
  const envKey = targetType === 'group'
    ? 'FB_GROUP_LINK_RECOVERY_MAX_AGE_MS'
    : 'FB_VIDEO_LINK_RECOVERY_MAX_AGE_MS';
  const configured = Number(process.env[envKey]);
  const fallback = targetType === 'group' ? 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  return Number.isFinite(configured) && configured >= 1000 ? configured : fallback;
}

function parseSqlUtc(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(text)
    ? text
    : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serializeVideoSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const items = Array.isArray(snapshot.items)
    ? snapshot.items.slice(0, 10).map(item => ({
      key: String(item && item.key || '').trim(),
      url: String(item && item.url || '').trim(),
    })).filter(item => item.key && item.url)
    : [];
  return JSON.stringify({
    ready: snapshot.ready === true,
    libraryUrl: String(snapshot.libraryUrl || ''),
    items,
  });
}

function parseVideoSnapshot(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function recoveryExpiryReason(job, now = Date.now()) {
  const maxAttempts = recoveryMaxAttempts(job.target_type);
  if (Number(job.attempts) >= maxAttempts) {
    return `Stopped after ${maxAttempts} unsuccessful permalink lookups`;
  }
  const startedAt = Number(job.published_at_ms) || parseSqlUtc(job.created_at);
  const maxAge = recoveryMaxAgeMs(job.target_type);
  if (startedAt > 0 && now - startedAt >= maxAge) {
    return `Stopped after ${Math.round(maxAge / 3600000)} hours without a permalink`;
  }
  return '';
}

function ensureCustomColumn(varKey, colType = 'text', platform = 'facebook') {
  let column = db.prepare(
    'SELECT * FROM custom_columns WHERE var_key = ? AND platform = ?'
  ).get(varKey, platform);
  if (column) return column;
  const max = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS value FROM custom_columns WHERE platform = ?'
  ).get(platform);
  const inserted = db.prepare(`
    INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform)
    VALUES (?, ?, ?, ?, ?)
  `).run(varKey, colType, varKey, Number(max && max.value) + 1, platform);
  return db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(inserted.lastInsertRowid);
}

function setCustomValue(postId, varKey, value, platform = 'facebook') {
  const column = ensureCustomColumn(varKey, 'text', platform);
  db.prepare(`
    INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value)
    VALUES (?, ?, ?)
  `).run(postId, column.id, value == null ? '' : String(value));
}

function getCustomValue(postId, varKey, platform = 'facebook') {
  const row = db.prepare(`
    SELECT d.value
    FROM post_custom_data d
    JOIN custom_columns c ON c.id = d.column_id
    WHERE d.post_id = ? AND c.platform = ? AND c.var_key = ?
    LIMIT 1
  `).get(postId, platform, varKey);
  return String(row && row.value || '').trim();
}

function publicPostResult(postId, platform = 'facebook', recoveryStatus = '') {
  const post = db.prepare(
    'SELECT * FROM posts WHERE id = ? AND platform = ?'
  ).get(postId, platform);
  if (!post) return null;
  const active = db.prepare(`
    SELECT status FROM post_link_recovery_jobs
    WHERE post_id = ? AND platform = ?
    LIMIT 1
  `).get(postId, platform);
  const state = recoveryStatus || String(active && active.status || '');
  return {
    post_id: Number(post.id),
    platform,
    status: post.status,
    link_post: getCustomValue(postId, 'link_post', platform) || post.link || '',
    time_post: getCustomValue(postId, 'time_post', platform),
    note: post.note || '',
    comment_status: getCustomValue(postId, 'comment_status', platform),
    time_comment: getCustomValue(postId, 'time_comment', platform),
    link_pending: state === 'waiting' || state === 'running',
    link_recovery_status: state || null,
  };
}

function syncAgentJobs(postId, platform, recoveryStatus) {
  const result = publicPostResult(postId, platform, recoveryStatus);
  if (!result) return;
  const rows = db.prepare(
    'SELECT job_id, result_json FROM agent_jobs WHERE post_id = ? AND platform = ?'
  ).all(postId, platform);
  for (const row of rows) {
    let previous = {};
    try { previous = row.result_json ? JSON.parse(row.result_json) : {}; } catch (_) {}
    const pending = result.link_pending === true;
    db.prepare(`
      UPDATE agent_jobs
      SET status = ?, result_json = ?, error = NULL,
          completed_at = CASE
            WHEN ? = 1 THEN NULL
            ELSE COALESCE(completed_at, CURRENT_TIMESTAMP)
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(
      pending ? 'running' : 'success',
      JSON.stringify({ ...previous, ...result }),
      pending ? 1 : 0,
      row.job_id
    );
    AgentEvents.record('link_recovery.updated', {
      job_id: row.job_id,
      platform,
      post_id: postId,
      status: recoveryStatus || result.link_recovery_status || result.status,
      payload: result,
    });
  }
}

class PostLinkRecoveryService {
  constructor() {
    this.timer = null;
    this.initialized = false;
    this.draining = false;
    this.stopping = false;
    this._broadcastLog = null;
  }

  setDefaultBroadcast(fn) {
    this._broadcastLog = typeof fn === 'function' ? fn : null;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.stopping = false;
    db.prepare(`
      UPDATE post_link_recovery_jobs
      SET status = 'waiting', started_at = NULL,
          last_error = CASE
            WHEN COALESCE(last_error, '') = '' THEN 'App restarted during link lookup'
            ELSE last_error
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `).run();
    const activeJobs = db.prepare(`
      SELECT post_id, platform, status
      FROM post_link_recovery_jobs
      WHERE status IN ('waiting', 'running')
    `).all();
    for (const job of activeJobs) syncAgentJobs(job.post_id, job.platform, job.status);
    this._migrateLegacyFalseNegatives();
    this._expireStaleJobs();
    this._armNext();
  }

  shutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      db.prepare(`
        UPDATE post_link_recovery_jobs
        SET status = 'waiting', started_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running'
      `).run();
    } catch (_) {}
    this.initialized = false;
  }

  schedule({
    postId,
    profileId,
    targetType,
    targetUrl,
    postContent,
    identityPageUrl = '',
    hasVideo = false,
    videoLibraryUrl = '',
    videoBeforeSnapshot = null,
    publishedAtMs = 0,
    dueAt = 0,
  }) {
    const normalizedType = String(targetType || '').toLowerCase();
    if (!['profile', 'fanpage', 'group'].includes(normalizedType)) {
      throw new Error(`Unsupported Facebook recovery target: ${targetType}`);
    }
    const normalizedUrl = String(targetUrl || '').trim()
      || (normalizedType === 'profile' ? 'https://www.facebook.com/me' : '');
    if (
      !postId || !profileId || !normalizedUrl
      || (!hasVideo && !String(postContent || '').trim())
    ) {
      throw new Error('Missing post, profile, target URL or caption for link recovery');
    }
    const nextDue = Math.max(
      Date.now(),
      Number(dueAt) || Date.now() + initialDelayMs(normalizedType)
    );
    const videoBeforeJson = serializeVideoSnapshot(videoBeforeSnapshot);
    const existing = db.prepare(`
      SELECT * FROM post_link_recovery_jobs
      WHERE platform = 'facebook' AND post_id = ?
    `).get(postId);
    if (existing && existing.status === 'success' && FACEBOOK_LINK_RE.test(existing.found_link || '')) {
      return existing;
    }

    if (existing) {
      db.prepare(`
        UPDATE post_link_recovery_jobs
        SET profile_id = ?, target_type = ?, target_url = ?, post_content = ?,
            identity_page_url = ?, has_video = ?, video_library_url = ?,
            video_before_json = ?, published_at_ms = ?,
            due_at = ?, status = 'waiting', attempts = 0, last_error = NULL,
            found_link = NULL, started_at = NULL, completed_at = NULL,
            created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        profileId,
        normalizedType,
        normalizedUrl,
        String(postContent).trim(),
        String(identityPageUrl || ''),
        hasVideo ? 1 : 0,
        String(videoLibraryUrl || ''),
        videoBeforeJson,
        Number(publishedAtMs) || Date.now(),
        nextDue,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO post_link_recovery_jobs (
          post_id, platform, profile_id, target_type, target_url,
          post_content, identity_page_url, has_video, video_library_url,
          video_before_json, published_at_ms, due_at, status, attempts,
          created_at, updated_at
        ) VALUES (?, 'facebook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', 0,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        postId,
        profileId,
        normalizedType,
        normalizedUrl,
        String(postContent).trim(),
        String(identityPageUrl || ''),
        hasVideo ? 1 : 0,
        String(videoLibraryUrl || ''),
        videoBeforeJson,
        Number(publishedAtMs) || Date.now(),
        nextDue
      );
    }
    setCustomValue(postId, 'link_post', normalizedType === 'group' ? 'Bài đăng chờ duyệt' : '');
    syncAgentJobs(postId, 'facebook', 'waiting');
    this._armNext();
    return this.getByPost(postId, 'facebook');
  }

  getByPost(postId, platform = 'facebook') {
    return db.prepare(`
      SELECT * FROM post_link_recovery_jobs
      WHERE post_id = ? AND platform = ?
      LIMIT 1
    `).get(postId, platform);
  }

  getStatus() {
    const rows = db.prepare(
      'SELECT status, COUNT(*) AS count FROM post_link_recovery_jobs GROUP BY status'
    ).all();
    return {
      initialized: this.initialized,
      draining: this.draining,
      counts: Object.fromEntries(rows.map(row => [row.status, Number(row.count) || 0])),
    };
  }

  runNow(postId, platform = 'facebook') {
    const job = this.getByPost(postId, platform);
    if (!job) throw new Error(`No link recovery job for post #${postId}`);
    db.prepare(`
      UPDATE post_link_recovery_jobs
      SET status = 'waiting', due_at = ?, started_at = NULL,
          attempts = 0, last_error = NULL, completed_at = NULL,
          created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(Date.now(), job.id);
    this._armNext();
    return this._recover(job.id, { ignoreExpiry: true });
  }

  _migrateLegacyFalseNegatives() {
    const posts = db.prepare(`
      SELECT p.*
      FROM posts p
      WHERE p.platform = 'facebook'
        AND p.status = 'error'
        AND (
          p.note LIKE '%Facebook chua xac minh bai dang%'
          OR p.link LIKE '%Facebook chua xac minh bai dang%'
        )
    `).all();
    for (const post of posts) {
      const agent = db.prepare(`
        SELECT profile_id, started_at, created_at FROM agent_jobs
        WHERE platform = 'facebook' AND post_id = ?
        ORDER BY id DESC LIMIT 1
      `).get(post.id);
      if (!agent || !agent.profile_id || !VIDEO_RE.test(String(post.image_path || ''))) continue;
      const groupUrl = getCustomValue(post.id, 'post_group');
      const fanpageUrl = getCustomValue(post.id, 'link_fanpage');
      const targetType = groupUrl ? 'group' : (fanpageUrl ? 'fanpage' : 'profile');
      const targetUrl = groupUrl || fanpageUrl || 'https://www.facebook.com/me';
      db.prepare(`
        UPDATE posts
        SET status = 'success', link = '',
            note = 'Facebook accepted the post; permalink recovery is running',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND platform = 'facebook'
      `).run(post.id);
      this.schedule({
        postId: post.id,
        profileId: agent.profile_id,
        targetType,
        targetUrl,
        postContent: post.content,
        identityPageUrl: fanpageUrl,
        hasVideo: true,
        publishedAtMs: parseSqlUtc(agent.started_at || agent.created_at) || Date.now(),
        dueAt: Date.now(),
      });
    }
  }

  _armNext() {
    if (!this.initialized || this.stopping || this.draining) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this._expireStaleJobs();
    const next = db.prepare(`
      SELECT id, due_at FROM post_link_recovery_jobs
      WHERE status = 'waiting'
      ORDER BY due_at ASC, id ASC LIMIT 1
    `).get();
    if (!next) return;
    const delay = Math.min(MAX_TIMEOUT, Math.max(0, Number(next.due_at) - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this._drainDue().catch(error => {
        this._log(`Link recovery queue error: ${error.message}`, 'error');
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
        const jobs = db.prepare(`
          SELECT id FROM post_link_recovery_jobs
          WHERE status = 'waiting' AND due_at <= ?
          ORDER BY due_at ASC, id ASC LIMIT 20
        `).all(Date.now());
        if (!jobs.length) break;
        await Promise.allSettled(jobs.map(job => this._recover(job.id)));
      }
    } finally {
      this.draining = false;
      this._armNext();
    }
  }

  async _recover(jobId, options = {}) {
    const claimed = db.prepare(`
      UPDATE post_link_recovery_jobs
      SET status = 'running', attempts = attempts + 1,
          started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'waiting'
    `).run(jobId);
    if (!claimed.changes) return this.getById(jobId);
    const job = this.getById(jobId);
    if (!job) return null;
    const expiryReason = recoveryExpiryReason({
      ...job,
      attempts: Math.max(0, Number(job.attempts) - 1),
    });
    if (expiryReason && options.ignoreExpiry !== true) {
      return this._markExpired(job, expiryReason);
    }

    const currentPost = db.prepare(
      'SELECT link FROM posts WHERE id = ? AND platform = ?'
    ).get(job.post_id, job.platform);
    const storedLink = getCustomValue(job.post_id, 'link_post', job.platform)
      || String(currentPost && currentPost.link || '');
    if (FACEBOOK_LINK_RE.test(storedLink)) {
      return this._markFound(job, storedLink);
    }

    try {
      LicenseService.assertPlatform('facebook');
    } catch (error) {
      return this._markPending(job, `Paused by license: ${error.message}`);
    }

    return ProfileActionQueue.run(job.profile_id, 'recover-facebook-link', async () => {
      let leased = false;
      try {
        const instance = await BrowserService.acquire(job.profile_id, { platform: 'facebook' });
        leased = true;
        if (!instance || !instance.page) throw new Error('Could not open profile for link lookup');
        const { getPlatformAdapter } = require('../platforms');
        const adapter = getPlatformAdapter('facebook');
        if (!await adapter.validateSession(instance.page)) {
          throw new Error('Facebook session is not logged in (missing c_user)');
        }
        const options = {
          identityPageUrl: job.identity_page_url || '',
          publishedAtMs: Number(job.published_at_ms) || 0,
          hasVideo: Number(job.has_video) === 1,
          videoLibraryUrl: job.video_library_url || '',
          videoBeforeSnapshot: parseVideoSnapshot(job.video_before_json),
        };
        const result = job.target_type === 'group'
          ? await adapter.findGroupPost(
            instance.page,
            job.target_url,
            job.post_content,
            options
          )
          : await adapter.findTimelinePost(
            instance.page,
            job.target_url,
            job.post_content,
            {
              ...options,
              targetType: job.target_type,
            }
          );
        if (result && result.permalinkVerified && FACEBOOK_LINK_RE.test(result.postLink || '')) {
          return this._markFound(job, result.postLink);
        }
        return this._markPending(job, 'Published post is not visible yet');
      } catch (error) {
        return this._markPending(job, error.message || String(error));
      } finally {
        if (leased) await BrowserService.release(job.profile_id).catch(() => {});
      }
    }, RECOVERY_PRIORITY);
  }

  getById(id) {
    return db.prepare('SELECT * FROM post_link_recovery_jobs WHERE id = ?').get(id);
  }

  _markPending(job, reason) {
    const expiryReason = recoveryExpiryReason(job);
    if (expiryReason) {
      const expired = this._markExpired(job, expiryReason);
      this._armNext();
      return expired;
    }
    const delay = retryDelayMs(job.target_type, Number(job.attempts) || 1);
    db.prepare(`
      UPDATE post_link_recovery_jobs
      SET status = 'waiting', due_at = ?, last_error = ?,
          started_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(Date.now() + delay, String(reason || ''), job.id);
    syncAgentJobs(job.post_id, job.platform, 'waiting');
    this._log(
      `Post #${job.post_id} has no permalink yet; retrying in ${Math.ceil(delay / 60000)} minute(s).`,
      'info'
    );
    this._armNext();
    return this.getById(job.id);
  }

  _expireStaleJobs() {
    const jobs = db.prepare(`
      SELECT * FROM post_link_recovery_jobs
      WHERE status IN ('waiting', 'running')
      ORDER BY id ASC
    `).all();
    for (const job of jobs) {
      const reason = recoveryExpiryReason(job);
      if (reason) this._markExpired(job, reason);
    }
  }

  _markExpired(job, reason) {
    const message = String(reason || 'Permalink lookup expired');
    const updated = db.prepare(`
      UPDATE post_link_recovery_jobs
      SET status = 'expired', last_error = ?, started_at = NULL,
          completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('waiting', 'running')
    `).run(message, job.id);
    if (!updated.changes) return this.getById(job.id);

    db.prepare(`
      INSERT INTO activity_logs (
        type, profile_id, post_id, message, status, platform, created_at
      ) VALUES ('post_link_recovery', ?, ?, ?, 'warning', ?, CURRENT_TIMESTAMP)
    `).run(
      job.profile_id,
      job.post_id,
      `Stopped automatic permalink lookup for post #${job.post_id}: ${message}`,
      job.platform
    );
    syncAgentJobs(job.post_id, job.platform, 'expired');
    // Chuoi binh luan dang cho link (bai Profile/Fanpage) phai dung ngay,
    // khong de treo o 'waiting_approval' cho mot link se khong bao gio toi.
    if (job.target_type !== 'group') {
      try {
        const CommentJobService = require('./comment-job.service');
        const parked = db.prepare(`
          SELECT * FROM comment_jobs
          WHERE post_id = ? AND platform = ?
            AND status IN ('waiting_approval','approval_checking')
            AND COALESCE(group_url, '') = ''
        `).all(job.post_id, job.platform);
        for (const comment of parked) {
          CommentJobService.markApprovalFailed(
            comment,
            `Dung tim link tu dong: ${message}`
          );
        }
      } catch (_) {}
    }
    this._log(
      `Stopped automatic permalink lookup for post #${job.post_id}: ${message}`,
      'warning'
    );
    return this.getById(job.id);
  }

  _markFound(job, postLink, foundAt = Date.now()) {
    const when = new Date(foundAt).toLocaleString('vi-VN');
    const note = job.target_type === 'group'
      ? `Group permalink recovered at ${when}`
      : Number(job.has_video) === 1
      ? `Video permalink recovered at ${when}`
      : `Post permalink recovered at ${when}`;
    const waitingComments = db.prepare(`
      SELECT * FROM comment_jobs
      WHERE post_id = ? AND platform = ?
        AND status IN ('waiting_approval','approval_checking')
      ORDER BY id ASC
    `).all(job.post_id, job.platform);
    db.transaction(() => {
      db.prepare(`
        UPDATE post_link_recovery_jobs
        SET status = 'success', found_link = ?, last_error = NULL,
            started_at = NULL, completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(postLink, job.id);
      db.prepare(`
        UPDATE posts
        SET status = 'success', link = ?, note = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND platform = ?
      `).run(postLink, note, job.post_id, job.platform);
      setCustomValue(job.post_id, 'link_post', postLink, job.platform);
      db.prepare(`
        UPDATE comment_jobs
        SET post_link = ?, updated_at = CURRENT_TIMESTAMP
        WHERE post_id = ? AND platform = ?
      `).run(postLink, job.post_id, job.platform);
      for (const comment of waitingComments) {
        db.prepare(`
          UPDATE comment_jobs
          SET status = 'waiting', due_at = ?, last_error = NULL,
              started_at = NULL, approval_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(foundAt + Math.max(0, Number(comment.approval_delay_ms) || 0), comment.id);
        setCustomValue(
          job.post_id,
          CommentColumns.varKey('comment_status', comment.sequence_no),
          'waiting',
          job.platform
        );
      }
      db.prepare(`
        INSERT INTO activity_logs (
          type, profile_id, post_id, message, status, platform, created_at
        ) VALUES ('post_link_recovery', ?, ?, ?, 'success', ?, CURRENT_TIMESTAMP)
      `).run(job.profile_id, job.post_id, `Recovered permalink: ${postLink}`, job.platform);
      syncAgentJobs(job.post_id, job.platform, 'success');
    })();

    try {
      const CommentJobService = require('./comment-job.service');
      if (typeof CommentJobService.refreshSchedule === 'function') {
        CommentJobService.refreshSchedule();
      }
    } catch (_) {}
    try {
      require('./telegram-notification.service').notifyStatusChange({
        platform: job.platform,
        postId: job.post_id,
        status: 'success',
        link: postLink,
        detail: note,
        updatedAt: foundAt,
      });
    } catch (_) {}
    if (this._broadcastLog) {
      this._broadcastLog({
        time: new Date(foundAt).toISOString(),
        profile: null,
        message: `Da tu dong cap nhat link bai #${job.post_id}: ${postLink}`,
        type: 'success',
        event: 'post_link_recovered',
        platform: job.platform,
        post_id: job.post_id,
        status: 'success',
        link_post: postLink,
        note,
      });
    }
    this._log(`Recovered permalink for post #${job.post_id}: ${postLink}`, 'success');
    this._armNext();
    return this.getById(job.id);
  }

  _log(message, type = 'info') {
    if (!this._broadcastLog) return;
    this._broadcastLog({
      time: new Date().toISOString(),
      profile: null,
      message,
      type,
      event: 'post_link_recovery',
      platform: 'facebook',
    });
  }
}

const singleton = new PostLinkRecoveryService();
singleton.PostLinkRecoveryService = PostLinkRecoveryService;
singleton.publicPostResult = publicPostResult;
singleton.syncAgentJobs = syncAgentJobs;

module.exports = singleton;
