/**
 * Runner Service - Task Execution Engine
 * Manages automation task queue with concurrency control, random delays,
 * realtime WebSocket logging, and activity tracking.
 */

const db = require('../database/init');
const path = require('path');
const fs = require('fs');
const ProfileActionQueue = require('./profile-action-queue.service');
const { getPlatformAdapter, normalizePlatform } = require('../platforms');
const { scopedSettingKey } = require('../platforms/platform.utils');
const LicenseService = require('./license.service');
const CommentColumns = require('./comment-columns.service');
const InteractionPacing = require('./interaction-pacing.service');
const { repairMojibake } = require('./text-encoding.utils');

const BUILTIN_FIELDS = ['content', 'image_path', 'link', 'target', 'product_id', 'status', 'note'];

// Bai da dang thanh cong nhung adapter khong doc duoc permalink.
// Phan biet ro voi cac ma *_TIMEOUT (chua chac bai da len).
const POST_LINK_NOT_FOUND_CODES = new Set([
  'TIKTOK_POST_LINK_NOT_FOUND',
  'INSTAGRAM_POST_LINK_NOT_FOUND',
  'THREADS_POST_LINK_NOT_FOUND',
  'X_POST_LINK_NOT_FOUND',
]);

// Slug hoá tên cột thành token biến (đồng bộ với init.js / data-manager.js)
function slugKey(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'cot';
}

// Chuẩn hoá status để so khớp pending/chờ (bỏ dấu, thường hoá)
function normalizeStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd');
}
function isPendingStatus(status) {
  const s = normalizeStatus(status);
  return s === 'pending' || s === 'cho'; // 'chá»' -> 'cho'
}

// Đọc field_overrides (đổi tên biến cột mặc định) từ settings
function platformSettingKey(platform, key) {
  return scopedSettingKey(platform, key);
}

function getFieldOverrides(platform = 'facebook') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(platformSettingKey(platform, 'field_overrides'));
    return row && row.value ? JSON.parse(row.value) : {};
  } catch (e) {
    return {};
  }
}

// Dựng map { tokenBiến -> giá trị } cho 1 bài
// Doc cau hinh tu dong binh luan sau khi dang bai (tu bang settings)
function getCommentSettings(platform = 'facebook') {
  try {
    const normalized = normalizePlatform(platform);
    const prefix = normalized === 'facebook' ? '' : `${normalized}_`;
    const rows = db.prepare(
      'SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?, ?, ?)'
    ).all(
      `${prefix}auto_comment_enabled`,
      `${prefix}comment_delay_unit`,
      `${prefix}comment_delay_min`,
      `${prefix}comment_delay_max`,
      `${prefix}comment_intervals`,
      `${prefix}comment_continue_on_error`
    );
    const m = {};
    for (const r of rows) m[r.key.replace(prefix, '')] = r.value;
    let intervals = {};
    try { intervals = m.comment_intervals ? JSON.parse(m.comment_intervals) : {}; } catch (_) {}
    return {
      enabled: m.auto_comment_enabled === '1',
      unit: m.comment_delay_unit === 'min' ? 'min' : 'sec',
      min: parseFloat(m.comment_delay_min) || 0,
      max: parseFloat(m.comment_delay_max) || 0,
      intervals,
      continueOnError: m.comment_continue_on_error !== '0',
    };
  } catch (e) {
    return {
      enabled: false,
      unit: 'sec',
      min: 0,
      max: 0,
      intervals: {},
      continueOnError: true,
    };
  }
}

function randomDelayMs(range, fallback = { min: 60, max: 120, unit: 'sec' }) {
  const source = range && typeof range === 'object' ? range : fallback;
  const unitMs = source.unit === 'min' ? 60000 : 1000;
  const min = Math.max(0, Number(source.min) || 0) * unitMs;
  const max = Math.max(min, Math.max(0, Number(source.max) || 0) * unitMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getPostSettings(platform = 'facebook') {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(platformSettingKey(platform, 'add_ai_label'));
    return {
      addAiLabel: ['facebook', 'zalovideo'].includes(normalizePlatform(platform))
        && row?.value === '1',
    };
  } catch (_) {
    return { addAiLabel: false };
  }
}

function getPlatformTimeoutSettings(platform = 'facebook') {
  if (normalizePlatform(platform) !== 'youtube') return {};
  const defaults = {
    navigation_timeout_ms: ['navigationTimeout', 90000],
    editor_timeout_ms: ['editorTimeout', 180000],
    upload_timeout_ms: ['uploadTimeout', 900000],
    publish_timeout_ms: ['publishTimeout', 180000],
  };
  const result = {};
  for (const [key, [optionName, fallback]] of Object.entries(defaults)) {
    const scopedKey = platformSettingKey(platform, key);
    const row = db.prepare(
      'SELECT value FROM settings WHERE key IN (?, ?) ORDER BY CASE WHEN key = ? THEN 0 ELSE 1 END LIMIT 1'
    ).get(scopedKey, key, scopedKey);
    const parsed = Number(row?.value);
    result[optionName] =
      Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
  }
  return result;
}

function buildVarMap(post, platform = 'facebook') {
  const overrides = getFieldOverrides(platform);
  const map = {};

  // Tên field gốc luôn dùng được
  for (const f of BUILTIN_FIELDS) map[f] = post[f] != null ? String(post[f]) : '';
  // Alias mặc định theo spec: {{media}} = cột hình ảnh
  map['media'] = post.image_path != null ? String(post.image_path) : '';

  // Áp biến do người dùng đổi tên (nếu có)
  for (const f of BUILTIN_FIELDS) {
    const v = overrides[f] && overrides[f].var;
    if (v) map[v] = post[f] != null ? String(post[f]) : '';
  }

  // Cột tuỳ chỉnh: var_key -> value
  const customCols = db.prepare('SELECT * FROM custom_columns WHERE platform = ?').all(platform);
  for (const col of customCols) {
    const key = col.var_key || slugKey(col.name);
    const cd = db.prepare('SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?')
      .get(post.id, col.id);
    map[key] = cd && cd.value != null ? String(cd.value) : '';
  }
  return map;
}

// Thay {{token}} bằng giá trị trong map

function ensureCustomColumn(varKey, name = varKey, colType = 'text', platform = 'facebook') {
  let col = db.prepare(
    'SELECT * FROM custom_columns WHERE platform = ? AND (var_key = ? OR name = ?)'
  ).get(platform, varKey, name);
  if (col) {
    if (col.var_key !== varKey || (varKey === 'comment_media' && col.col_type !== 'file')) {
      db.prepare('UPDATE custom_columns SET var_key = ?, col_type = ? WHERE id = ?')
        .run(varKey, varKey === 'comment_media' ? 'file' : (col.col_type || colType), col.id);
      col = db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(col.id);
    }
    return col;
  }
  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) as max_order FROM custom_columns WHERE platform = ?'
  ).get(platform);
  const result = db.prepare(
    'INSERT INTO custom_columns (name, col_type, var_key, sort_order, platform) VALUES (?, ?, ?, ?, ?)'
  ).run(name, colType, varKey, (maxOrder.max_order || 0) + 1, platform);
  return db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(result.lastInsertRowid);
}

function setCustomValue(postId, varKey, value, colType = 'text', platform = 'facebook') {
  const col = ensureCustomColumn(varKey, varKey, colType, platform);
  db.prepare('INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value) VALUES (?, ?, ?)')
    .run(postId, col.id, value || '');
}

function renderTemplate(template, map) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
  });
}

function getOrderedCandidatePosts(platform, dataIds) {
  const orderSql = `
    ORDER BY CASE WHEN sort_order IS NULL OR sort_order <= 0 THEN id ELSE sort_order END ASC,
             id ASC
  `;
  if (dataIds === 'all' || dataIds === '*') {
    return db.prepare(`SELECT * FROM posts WHERE platform = ? ${orderSql}`).all(platform);
  }
  const ids = [...new Set((dataIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM posts WHERE platform = ? AND id IN (${placeholders}) ${orderSql}`
  ).all(platform, ...ids);
}

function selectPendingPostsForProfile(posts, profileName, platform, maxPostsPerProfile = 0) {
  const target = String(profileName || '').trim();
  const eligible = (posts || []).filter(post => {
    if (!isPendingStatus(post.status)) return false;
    const valueMap = buildVarMap(post, platform);
    return String(valueMap.name_profile || '').trim() === target;
  });
  const limit = Math.min(1000, Math.max(0, parseInt(maxPostsPerProfile, 10) || 0));
  return limit > 0 ? eligible.slice(0, limit) : eligible;
}

class RunnerService {
  constructor(platform = 'facebook') {
    this.platform = normalizePlatform(platform);
    this.isRunning = false;
    this.shouldStop = false;
    this.runningTasks = [];
    this.progress = { total: 0, completed: 0, errors: 0 };
    this._broadcastLog = null;
    this._defaultBroadcast = null; // dùng khi chạy theo lịch (khong co broadcast tu request)
  }

  // Đặt hàm broadcast mặc định (server gọi 1 lần) để lịch hẹn giờ cũng hiện log realtime.
  setDefaultBroadcast(fn) { this._defaultBroadcast = fn; }

  /**
   * Main entry point - start running automation tasks
   * @param {Object} config - Runner configuration
   * @param {Array|string} config.profileIds - Array of browser profile IDs
   * @param {Array|string} config.dataIds - Array of post IDs or 'all'
   * @param {number} config.concurrency - Max concurrent profiles (1-10)
   * @param {number} config.delayMin - Min delay between posts (seconds)
   * @param {number} config.delayMax - Max delay between posts (seconds)
   * @param {number} config.profileDelayMin - Min delay between profiles (seconds)
   * @param {number} config.profileDelayMax - Max delay between profiles (seconds)
   * @param {number} config.maxPostsPerProfile - Max pending rows per profile, 0 = unlimited
   * @param {Function} broadcastLog - WebSocket broadcast function
   */
  async start({
    profileIds,
    dataIds,
    concurrency = 2,
    delayMin = 30,
    delayMax = 90,
    profileDelayMin = 10,
    profileDelayMax = 30,
    maxPostsPerProfile = 0,
  }, broadcastLog) {
    LicenseService.assertPlatform(this.platform);
    if (this.isRunning) {
      throw new Error('Runner đang chạy. Vui lòng dừng trước khi chạy lại.');
    }

    this.isRunning = true;
    this.shouldStop = false;
    this._broadcastLog = broadcastLog || this._defaultBroadcast || null;
    this.runningTasks = [];
    this.progress = { total: 0, completed: 0, errors: 0 };

    try {
      // Get profiles from DB
      const profilePlaceholders = profileIds.map(() => '?').join(',');
      const profiles = db.prepare(
        `SELECT b.* FROM browsers b
         INNER JOIN browser_platforms bp ON bp.browser_id = b.id
         WHERE bp.platform = ? AND bp.enabled = 1
           AND b.id IN (${profilePlaceholders})`
      ).all(this.platform, ...profileIds);

      if (profiles.length === 0) {
        this._log(null, 'Không tìm thấy profile nào.', 'error');
        this.isRunning = false;
        return { success: false, message: 'Không tìm thấy profile' };
      }

      // Get candidate posts from DB (theo lựa chọn của người dùng)
      const posts = getOrderedCandidatePosts(this.platform, dataIds);

      // Nguyên tắc đọc dữ liệu: lọc đồng thời 2 điều kiện
      //  1) status ∈ {pending, chờ}
      //  2) biến name_profile của bài == tên profile trong trình duyệt
      const matchedByProfile = new Map(); // profileId -> posts[]
      let totalMatched = 0;
      const postLimit = Math.min(1000, Math.max(0, parseInt(maxPostsPerProfile, 10) || 0));
      for (const profile of profiles) {
        const mine = selectPendingPostsForProfile(
          posts,
          profile.name,
          this.platform,
          postLimit
        );
        matchedByProfile.set(profile.id, mine);
        totalMatched += mine.length;
        if (mine.length === 0) {
          this._log(profile.name, 'Không có dữ liệu phù hợp (status pending + name_profile khớp).', 'warning');
        }
      }

      if (totalMatched === 0) {
        this._log(null, 'Không có dữ liệu chạy.', 'error');
        this.isRunning = false;
        return { success: false, message: 'Không có dữ liệu chạy' };
      }

      // Chỉ chạy các profile có bài phù hợp
      const profileQueue = profiles.filter(p => (matchedByProfile.get(p.id) || []).length > 0);

      // Calculate total tasks
      this.progress.total = totalMatched;

      this._log(null, `Bắt đầu chạy: ${profileQueue.length} profile, tổng ${totalMatched} bài phù hợp`, 'info');
      this._log(null, `Concurrency: ${concurrency} | Delay bài: ${delayMin}-${delayMax}s | Delay profile: ${profileDelayMin}-${profileDelayMax}s`, 'info');

      this._log(
        null,
        postLimit > 0
          ? `Giới hạn lượt chạy: tối đa ${postLimit} hàng đang Chờ cho mỗi profile`
          : 'Giới hạn lượt chạy: không giới hạn; vẫn chỉ chạy hàng đang Chờ',
        'info'
      );

      // Process profiles with concurrency limit using promise pool
      const activePromises = new Set();

      for (let i = 0; i < profileQueue.length; i++) {
        if (this.shouldStop) {
          this._log(null, 'Đã dừng theo yêu cầu.', 'warning');
          break;
        }

        const profile = profileQueue[i];

        // Wait if concurrency limit reached
        while (activePromises.size >= concurrency) {
          await Promise.race(activePromises);
        }

        if (this.shouldStop) break;

        // Launch profile task (chỉ các bài đã khớp với profile này)
        const myPosts = matchedByProfile.get(profile.id) || [];
        const profilePromise = this._processProfile(profile, myPosts, delayMin, delayMax)
          .then(() => {
            activePromises.delete(profilePromise);
          })
          .catch((err) => {
            activePromises.delete(profilePromise);
            this._log(profile.name, `Lá»—i profile: ${err.message}`, 'error');
          });

        activePromises.add(profilePromise);
        this.runningTasks.push(profilePromise);

        // Delay between launching profiles (only if not the last one and not at concurrency limit)
        if (i < profileQueue.length - 1 && activePromises.size >= concurrency) {
          // Wait for one to finish before continuing
          await Promise.race(activePromises);
          // Add profile delay
          if (!this.shouldStop) {
            const profileDelay = this._randomSeconds(profileDelayMin, profileDelayMax);
            this._log(null, `Chờ ${Math.round(profileDelay / 1000)}s trước khi xử lý profile tiếp theo...`, 'info');
            await this._sleep(profileDelay);
          }
        } else if (i < profileQueue.length - 1) {
          // Small stagger delay when launching concurrent profiles
          const profileDelay = this._randomSeconds(profileDelayMin, profileDelayMax);
          this._log(null, `Chờ ${Math.round(profileDelay / 1000)}s trước khi khởi chạy profile tiếp theo...`, 'info');
          await this._sleep(profileDelay);
        }
      }

      // Wait for all remaining tasks
      await Promise.allSettled([...activePromises]);

    } catch (err) {
      this._log(null, `Lá»—i há»‡ thá»‘ng: ${err.message}`, 'error');
    } finally {
      this.isRunning = false;
      this.runningTasks = [];

      const summary = {
        total: this.progress.total,
        completed: this.progress.completed,
        errors: this.progress.errors,
        stopped: this.shouldStop
      };

      this._log(null, `Hoàn tất: ${summary.completed}/${summary.total} thành công, ${summary.errors} lỗi${summary.stopped ? ' (đã dừng sớm)' : ''}`, summary.errors > 0 ? 'warning' : 'success');

      // Broadcast final status
      if (this._broadcastLog) {
        this._broadcastLog({
          time: new Date().toISOString(),
          profile: null,
          message: 'Runner đã dừng',
          type: 'info',
          event: 'runner_stopped',
          platform: this.platform,
          progress: this.progress
        });
      }

      this.shouldStop = false;
      return summary;
    }
  }

  /**
   * Process all posts for a single profile
   */
  async _processProfile(profile, posts, delayMin, delayMax) {
    this._log(profile.name, 'Đang mở Chrome...', 'info');

    let page = null;
    let leased = false;
    const BrowserService = require('./browser.service');

    try {
      // Mở Chrome (hoặc dùng lại nếu đang mở) rồi lấy page thật
      try {
        await ProfileActionQueue.run(profile.id, 'post', async () => {
          let instance = await BrowserService.acquire(profile.id, { platform: this.platform });
          leased = true;
          page = instance ? instance.page : null;
          if (!page) throw new Error('Không lấy được tab trình duyệt');
        }, 0);
        this._log(profile.name, 'Chrome đã mở thành công.', 'success');
      } catch (launchErr) {
        this._log(profile.name, `Không thể mở Chrome: ${launchErr.message}`, 'error');
        throw launchErr;
      }

      // Process each post
      for (let i = 0; i < posts.length; i++) {
        if (this.shouldStop) {
          this._log(profile.name, 'Dừng theo yêu cầu người dùng.', 'warning');
          break;
        }

        const post = posts[i];
        this._log(profile.name, `Đang xử lý bài #${post.id} (${i + 1}/${posts.length})...`, 'info');

        try {
          // Process the post (thao tác web thật)
          const result = await ProfileActionQueue.run(profile.id, 'post', async () => {
            let instance = BrowserService.getInstance(profile.id);
            if (!instance) {
              instance = await BrowserService.acquire(profile.id, { platform: this.platform });
              leased = true;
            }
            page = instance ? instance.page : null;
            if (!page) throw new Error('Không lấy được tab trình duyệt để đăng bài');
            const published = await this.processPost(page, post, {
              postIndex: i,
              profileName: profile.name,
            });
            return this._finalizePublishedPost(profile, post, published || {});
          }, 0);
          const postedAt = (result && result.postedAt) || new Date().toLocaleString('vi-VN');

          const postLink = (result && result.postLink) || '';

          this.progress.completed++;
          this._log(profile.name, `✅ Bài #${post.id} - Thành công lúc ${postedAt}${postLink ? ` | link_post: ${postLink}` : ' | Chưa lấy được link'} (${this.progress.completed}/${this.progress.total})`, 'success');

        } catch (postErr) {
          postErr.message = repairMojibake(postErr.message);
          // Dung ngay truoc khi bam Dang: khong phai loi, giu hang o Cho de chay lai.
          if (postErr.code === 'RUNNER_STOPPED') {
            this._deferPostForStop(post);
            this._log(profile.name, `⏹ Bài #${post.id} - Đã dừng trước khi bấm Đăng, giữ trạng thái Chờ.`, 'warning');
            break;
          }
          this.progress.errors++;
          await this._markCommentAfterPostFailure(post, postErr);

          // Login is a profile precondition, not a failed publish. Keep the row
          // pending so the user can sign in and retry without editing it back.
          if (postErr.code === 'FACEBOOK_NOT_LOGGED_IN') {
            this._deferPostForLogin(post, postErr);
          } else {
            this._finalizeFailedPost(post, postErr);
          }

          // Log error activity
          db.prepare(
            'INSERT INTO activity_logs (type, profile_id, post_id, message, status, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
          ).run('post', profile.id, post.id, `Lỗi bài #${post.id}: ${postErr.message}`, 'error');

          this._log(profile.name, `❌ Bài #${post.id} - Lỗi: ${postErr.message}`, 'error');
        }

        db.prepare('UPDATE activity_logs SET platform = ? WHERE id = last_insert_rowid()')
          .run(this.platform);

        // Broadcast progress update
        if (this._broadcastLog) {
          this._broadcastLog({
            time: new Date().toISOString(),
            profile: profile.name,
            message: '',
            type: 'progress',
            event: 'progress',
            platform: this.platform,
            progress: { ...this.progress }
          });
        }

        // Random delay between posts (unless it's the last post)
        if (i < posts.length - 1 && !this.shouldStop) {
          const delay = this._randomSeconds(delayMin, delayMax);
          this._log(profile.name, `Chờ ${Math.round(delay / 1000)}s trước bài tiếp theo...`, 'info');
          await this._sleep(delay);
        }
      }

    } finally {
      // Đóng Chrome sau khi xử lý xong profile
      if (leased) {
        try {
          await ProfileActionQueue.run(
            profile.id,
            `${this.platform}:release`,
            () => BrowserService.release(profile.id),
            -100
          );
          this._log(profile.name, 'Đã đóng Chrome.', 'info');
        } catch (closeErr) {
          this._log(profile.name, `Lỗi khi đóng Chrome: ${closeErr.message}`, 'warning');
        }
      }
    }
  }

  _finalizeFailedPost(post, error) {
    const message = repairMojibake(error?.message || error || 'Không xác định được lỗi');
    const failureText = `Lỗi: ${message}`;
    db.transaction(() => {
      db.prepare(
        'UPDATE posts SET status = ?, note = ?, link = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND platform = ?'
      ).run('error', message, failureText, post.id, this.platform);
      setCustomValue(post.id, 'link_post', failureText, 'text', this.platform);
    })();
    try {
      require('./telegram-notification.service').notifyStatusChange({
        platform: this.platform,
        postId: post.id,
        row: post.sort_order || post.id,
        profile: post.profile_name || post.profile || '',
        status: 'error',
        content: post.content,
        error: message,
        detail: failureText,
        link: failureText,
      });
    } catch (_) {}
    return failureText;
  }

  _deferPostForLogin(post, error) {
    const message = repairMojibake(error?.message || error || 'Can dang nhap lai profile');
    const note = `${message}. Bai van o trang thai Cho de chay lai.`;
    db.prepare(
      'UPDATE posts SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND platform = ?'
    ).run('pending', note, post.id, this.platform);
    return note;
  }

  // Dung ngay truoc khi bam Dang: khong phai loi dang bai, giu hang o Cho de chay lai.
  _deferPostForStop(post) {
    const note = 'Đã dừng trước khi bấm Đăng. Bài vẫn ở trạng thái Chờ để chạy lại.';
    db.prepare(
      'UPDATE posts SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND platform = ?'
    ).run('pending', note, post.id, this.platform);
    return note;
  }

  _resolvePublishTarget(post) {
    const adapter = getPlatformAdapter(this.platform);
    if (!adapter || typeof adapter.resolvePublishTarget !== 'function') return {};
    try {
      return adapter.resolvePublishTarget(post, {
        buildVarMap: value => buildVarMap(value, this.platform),
        renderTemplate,
      }) || {};
    } catch (_) {
      return {};
    }
  }

  async _finalizePublishedPost(profile, post, result = {}) {
    const postedAt = result.postedAt || new Date().toLocaleString('vi-VN');
    const postLink = result.postLink || '';
    const waitingApproval = result.waitingApproval === true;
    // Bai da len Facebook that roi. Thieu link chi la thieu du lieu phu:
    // van ghi 'success' va xep job tu dong tim lai link, KHONG bao loi
    // (bao loi se khien nguoi dung chay lai va dang trung bai).
    const linkMissing = this.platform === 'facebook'
      && !waitingApproval
      && (
        ['profile', 'fanpage'].includes(String(result.targetType || '').toLowerCase())
        || result.stoppedAfterPublish === true
      )
      && !/^https:\/\/(?:www\.)?facebook\.com\//i.test(postLink);
    const cleanNote = waitingApproval
      ? `Đăng lúc ${postedAt} | Bài đăng Group đang chờ quản trị viên duyệt`
      : result.stoppedAfterPublish === true
      ? `Đăng lúc ${postedAt} | Dừng sau khi bấm Đăng, đang tự động tìm link`
      : result.linkNotFound === true
      ? `Đăng lúc ${postedAt} | Đã đăng nhưng chưa lấy được link`
      : result.linkPending === true
      ? `Đăng lúc ${postedAt} | Link video đang đợi cập nhật`
      : linkMissing
      ? `Đăng lúc ${postedAt} | Chưa lấy được link, đang tự động tìm lại`
      : postLink
      ? `Đăng lúc ${postedAt}`
      : `Đăng lúc ${postedAt} | Chưa lấy được link`;
    const persistedAtMs = Date.now();

    const persist = db.transaction(() => {
      db.prepare(`
        UPDATE posts
        SET status = ?, note = ?, link = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND platform = ?
      `).run('success', cleanNote, postLink, post.id, this.platform);
      setCustomValue(post.id, 'link_post', postLink, 'text', this.platform);
      setCustomValue(post.id, 'time_post', postedAt, 'text', this.platform);
      db.prepare(`
        INSERT INTO activity_logs (
          type, profile_id, post_id, message, status, platform, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        'post',
        profile.id,
        post.id,
        `Đăng bài #${post.id} thành công qua profile "${profile.name}" lúc ${postedAt}${postLink ? ` | ${postLink}` : ''}`,
        'success',
        this.platform
      );
    });
    persist();

    try {
      require('./telegram-notification.service').notifyStatusChange({
        platform: this.platform,
        postId: post.id,
        row: post.sort_order || post.id,
        profile: profile?.name || '',
        status: waitingApproval ? 'waiting_approval' : 'success',
        content: post.content,
        link: postLink,
        detail: cleanNote,
        time: postedAt,
        updatedAt: persistedAtMs,
      });
    } catch (_) {}

    this._broadcastPostSaved(post.id, postedAt, postLink, cleanNote);

    const finalized = { ...result, postedAt, postLink, persistedAtMs, linkMissing };
    try {
      this._schedulePostLinkRecovery(profile, post, finalized);
    } catch (error) {
      this._log(
        profile.name,
        `Khong xep duoc lich tu dong tim link bai #${post.id}: ${error.message}`,
        'warning'
      );
    }
    try {
      await this._scheduleCommentJob(profile, post, finalized);
    } catch (error) {
      const CommentJobService = require('./comment-job.service');
      CommentJobService.markError(
        post.id,
        `Bài đã đăng thành công nhưng không xếp được bình luận: ${error.message}`,
        this.platform
      );
      this._log(profile.name, `Không xếp được bình luận bài #${post.id}: ${error.message}`, 'warning');
    }
    return finalized;
  }

  _schedulePostLinkRecovery(profile, post, result) {
    if (this.platform !== 'facebook') return null;
    if (
      result.waitingApproval !== true
      && result.linkPending !== true
      && result.linkMissing !== true
    ) return null;
    const targetType = result.waitingApproval === true
      ? 'group'
      : String(result.targetType || 'profile').toLowerCase();
    const targetUrl = targetType === 'group'
      ? result.groupUrl
      : (result.profileHref || result.identityPageUrl || '');
    return require('./post-link-recovery.service').schedule({
      postId: post.id,
      profileId: profile.id,
      targetType,
      targetUrl,
      postContent: result.postContent || post.content || '',
      identityPageUrl: result.identityPageUrl || '',
      hasVideo: result.hasVideo === true || result.linkPending === true,
      videoLibraryUrl: result.videoLibraryUrl || '',
      videoBeforeSnapshot: result.videoBeforeSnapshot || null,
      publishedAtMs: result.publishedAtMs || Date.now(),
    });
  }

  _broadcastPostSaved(postId, postedAt, postLink, note) {
    if (!this._broadcastLog) return;
    this._broadcastLog({
      time: new Date().toISOString(),
      profile: null,
      message: '',
      type: 'success',
      event: 'post_saved',
      platform: this.platform,
      post_id: postId,
      status: 'success',
      link_post: postLink,
      time_post: postedAt,
      note,
    });
  }

  async _scheduleCommentJob(profile, post, result) {
    const CommentJobService = require('./comment-job.service');
    const cfg = getCommentSettings(this.platform);
    const vmap = buildVarMap(post, this.platform);
    const columns = db.prepare(
      'SELECT var_key FROM custom_columns WHERE platform = ?'
    ).all(this.platform);
    const sequences = CommentColumns.sequencesFromColumns(columns);
    const entries = sequences.map(sequence => ({
      sequence,
      commentText: renderTemplate(
        vmap[CommentColumns.varKey('comment', sequence)] || '',
        vmap
      ).trim(),
      mediaRaw: renderTemplate(
        vmap[CommentColumns.varKey('comment_media', sequence)] || '',
        vmap
      ).trim(),
    }));

    if (!cfg.enabled) {
      for (const entry of entries) {
        CommentJobService.markSkipped(
          post.id,
          'Tu dong binh luan dang tat',
          this.platform,
          entry.sequence
        );
      }
      return null;
    }

    const jobs = [];
    for (const entry of entries) {
      if (!entry.commentText && !entry.mediaRaw) {
        CommentJobService.markSkipped(
          post.id,
          'Khong co noi dung hoac media binh luan',
          this.platform,
          entry.sequence
        );
        continue;
      }
      // linkMissing: bai da dang that, link se duoc tim lai tu dong ->
      // van xep binh luan, cho o trang thai cho link thay vi bo luon.
      if (!result.postLink && !result.waitingApproval && !result.linkMissing) {
        CommentJobService.markError(
          post.id,
          'Bai da dang nhung chua lay duoc permalink',
          this.platform,
          entry.sequence
        );
        continue;
      }

      let mediaPath = '';
      if (entry.mediaRaw) {
        mediaPath = path.resolve(entry.mediaRaw);
        const supported = /\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i.test(mediaPath);
        if (!supported) {
          CommentJobService.markError(
            post.id,
            'Dinh dang media binh luan khong duoc ho tro',
            this.platform,
            entry.sequence
          );
          continue;
        }
        if (!fs.existsSync(mediaPath)) {
          CommentJobService.markError(
            post.id,
            `Khong tim thay media binh luan: ${mediaPath}`,
            this.platform,
            entry.sequence
          );
          continue;
        }
      }
      jobs.push({
        sequence: entry.sequence,
        commentText: entry.commentText,
        mediaPath,
      });
    }

    if (!jobs.length) return null;
    const persistedAtMs = Number(result.persistedAtMs) || Date.now();
    const firstDelayMs = randomDelayMs({
      min: cfg.min,
      max: cfg.max,
      unit: cfg.unit,
    }, { min: 0, max: 0, unit: 'sec' });
    const scheduledJobs = jobs.map((job, index) => ({
      ...job,
      dueAt: index === 0 ? persistedAtMs + firstDelayMs : 0,
      delayFromApprovalMs: index === 0 ? firstDelayMs : 0,
      delayAfterPreviousMs: index === 0
        ? 0
        : randomDelayMs(cfg.intervals[String(job.sequence)]),
    }));

    if (result.waitingApproval) {
      return CommentJobService.scheduleWaitingApproval({
        postId: post.id,
        profileId: profile.id,
        groupUrl: result.groupUrl,
        postContent: result.postContent || String(vmap.content || ''),
        identityType: result.identityType || 'profile',
        identityPageUrl: result.identityPageUrl || '',
        jobs: scheduledJobs,
        continueOnError: cfg.continueOnError,
        platform: this.platform,
      });
    }

    if (result.linkMissing) {
      return CommentJobService.scheduleWaitingLink({
        postId: post.id,
        profileId: profile.id,
        postContent: result.postContent || String(vmap.content || ''),
        identityType: String(result.targetType || '').toLowerCase() === 'fanpage'
          ? 'fanpage'
          : 'profile',
        identityPageUrl: result.identityPageUrl || result.profileHref || '',
        jobs: scheduledJobs,
        continueOnError: cfg.continueOnError,
        platform: this.platform,
      });
    }

    return CommentJobService.scheduleChain({
      postId: post.id,
      profileId: profile.id,
      postLink: result.postLink,
      jobs: scheduledJobs,
      continueOnError: cfg.continueOnError,
      platform: this.platform,
    });
  }

  /**
   * Đăng 1 bài lên Facebook theo các bước B1–B5.
   * @param {Object} page - Puppeteer page
   * @param {Object} post - Bản ghi bài từ DB
   * @returns {Promise<Object>} { success, postedAt }
   */
  async processPost(page, post, runtimeContext = {}) {
    const postSettings = getPostSettings(this.platform);
    const antiBotConfig = InteractionPacing.getAntiBotConfig(this.platform);
    const interactionConfig = InteractionPacing.getInteractionConfig();
    await InteractionPacing.performAntiBotWarmup(
      page,
      this.platform,
      antiBotConfig,
      {
        postIndex: runtimeContext.postIndex || 0,
        log: (message, type = 'info') =>
          this._log(runtimeContext.profileName || null, message, type),
        sleep: ms => this._publishSleep(ms),
      }
    );
    const interactionPacer = new InteractionPacing.InteractionPacer(
      page,
      interactionConfig,
      { sleep: ms => this._publishSleep(ms) }
    ).install();
    try {
      return await getPlatformAdapter(this.platform).publish(page, post, {
        buildVarMap: value => buildVarMap(value, this.platform),
        renderTemplate,
        log: (message, type = 'info', profileName = null) => this._log(profileName, message, type),
        sleep: ms => this._publishSleep(ms),
        addAiLabel: postSettings.addAiLabel,
        interactionPacer,
        ...getPlatformTimeoutSettings(this.platform),
      });
    } catch (error) {
      // Dung ngay khi adapter da qua moc bam Dang: bai co the da len that.
      // Ghi thanh cong va de recovery tu tim link; bao loi se khien chay lai -> DANG TRUNG.
      if (
        interactionPacer.publishCommitted
        && (error?.code === 'RUNNER_STOPPED' || this.shouldStop)
      ) {
        const publishedAtMs = Date.now();
        const target = this._resolvePublishTarget(post);
        this._log(
          runtimeContext.profileName || null,
          `Bài #${post.id} bị dừng sau khi bấm Đăng; ghi thành công và tự tìm link.`,
          'warning'
        );
        return {
          success: true,
          publishedAccepted: true,
          postedAt: new Date(publishedAtMs).toLocaleString('vi-VN'),
          publishedAtMs,
          postLink: '',
          linkNotFound: true,
          stoppedAfterPublish: true,
          postContent: post.content || '',
          targetType: target.targetType || '',
          profileHref: target.fanpageHref || target.groupHref || '',
          groupUrl: target.groupHref || '',
        };
      }
      // Dung ngay truoc moc bam Dang: adapter co the nuot RUNNER_STOPPED trong vong retry
      // roi nem loi khac; van quy ve dung de hang giu Cho thay vi bi ghi loi.
      if (this.shouldStop && !interactionPacer.publishCommitted) {
        const stopped = new Error('Runner đã dừng theo yêu cầu người dùng');
        stopped.code = 'RUNNER_STOPPED';
        throw stopped;
      }
      // Cac ma *_POST_LINK_NOT_FOUND nghia la bai DA len that, chi khong doc duoc permalink.
      // Nem loi o day se ghi bai thanh 'error' va nguoi dung chay lai -> DANG TRUNG.
      // (Khac han cac ma *_TIMEOUT: luc do chua chac bai da len nen van phai bao loi.)
      if (POST_LINK_NOT_FOUND_CODES.has(String(error?.code || ''))) {
        const publishedAtMs = Date.now();
        this._log(
          runtimeContext.profileName || null,
          `Bài #${post.id} đã đăng nhưng chưa lấy được link: ${error.message}`,
          'warning'
        );
        return {
          success: true,
          publishedAccepted: true,
          postedAt: new Date(publishedAtMs).toLocaleString('vi-VN'),
          publishedAtMs,
          postLink: '',
          linkNotFound: true,
          postContent: post.content || '',
        };
      }
      throw error;
    } finally {
      interactionPacer.restore();
    }
  }

  async _markCommentAfterPostFailure(post, error) {
    const CommentJobService = require('./comment-job.service');
    const cfg = getCommentSettings(this.platform);
    const vmap = buildVarMap(post, this.platform);
    const columns = db.prepare(
      'SELECT var_key FROM custom_columns WHERE platform = ?'
    ).all(this.platform);

    for (const sequence of CommentColumns.sequencesFromColumns(columns)) {
      const text = renderTemplate(
        vmap[CommentColumns.varKey('comment', sequence)] || '',
        vmap
      ).trim();
      const media = renderTemplate(
        vmap[CommentColumns.varKey('comment_media', sequence)] || '',
        vmap
      ).trim();
      if (!cfg.enabled || (!text && !media)) {
        CommentJobService.markSkipped(post.id, '', this.platform, sequence);
      } else {
        CommentJobService.markError(
          post.id,
          `Bai dang that bai: ${error.message}`,
          this.platform,
          sequence
        );
      }
    }
  }

  // Backward-compatible generic entry points used by existing integrations.
  // Platform-specific DOM code remains inside the two adapter files.
  async commentOnPost(page, postLink, commentText = '', mediaPath = '') {
    return getPlatformAdapter(this.platform).comment(page, postLink, commentText, mediaPath, {
      sleep: ms => this._sleep(ms),
      commentVerificationTimeoutMs: this._commentVerificationTimeoutMs,
      commentUploadTimeoutMs: this._commentUploadTimeoutMs,
      commentLinkPreviewTimeoutMs: this._commentLinkPreviewTimeoutMs,
    });
  }

  async hasExistingComment(page, postLink, commentText = '', mediaPath = '') {
    return getPlatformAdapter(this.platform).hasExistingComment(page, postLink, commentText, mediaPath);
  }

  stop() {
    if (!this.isRunning) {
      return { success: false, message: 'Runner không đang chạy.' };
    }

    this.shouldStop = true;
    this._log(null, 'Đang dừng ngay: ngắt bài đang chạy tại bước hiện tại.', 'warning');

    return { success: true, message: 'Đang dừng runner...' };
  }

  // Sleep dung trong luc dang bai: nem RUNNER_STOPPED de adapter thoat ngay khi nguoi dung dung.
  _publishSleep(ms) {
    const assertRunning = () => {
      if (!this.shouldStop) return;
      const error = new Error('Runner đã dừng theo yêu cầu người dùng');
      error.code = 'RUNNER_STOPPED';
      throw error;
    };
    assertRunning();
    return this._sleep(ms).then(assertRunning);
  }

  /**
   * Get current status
   */
  getStatus() {
    let commentQueue = null;
    try { commentQueue = require('./comment-job.service').getStatus(); } catch (_) {}
    return {
      isRunning: this.isRunning,
      progress: { ...this.progress },
      shouldStop: this.shouldStop,
      commentQueue
    };
  }

  /**
   * Generate random delay in milliseconds
   * @param {number} minSeconds - Minimum delay in seconds
   * @param {number} maxSeconds - Maximum delay in seconds
   * @returns {number} Random ms value between min and max
   */
  _randomSeconds(minSeconds, maxSeconds) {
    const min = Math.max(0, minSeconds) * 1000;
    const max = Math.max(min, maxSeconds * 1000);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Return promise that resolves after random ms between min*1000 and max*1000
   * @param {number} minSeconds - Minimum delay in seconds
   * @param {number} maxSeconds - Maximum delay in seconds
   * @returns {Promise<void>}
   */
  randomDelay(minSeconds, maxSeconds) {
    const ms = this._randomSeconds(minSeconds, maxSeconds);
    return this._sleep(ms);
  }

  /**
   * Sleep for given milliseconds (cancellable via shouldStop)
   */
  _sleep(ms) {
    return new Promise((resolve) => {
      const checkInterval = 500; // Check shouldStop every 500ms
      let elapsed = 0;

      const timer = setInterval(() => {
        elapsed += checkInterval;
        if (this.shouldStop || elapsed >= ms) {
          clearInterval(timer);
          resolve();
        }
      }, checkInterval);

      // Also set a hard timeout
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, ms + 100);
    });
  }

  /**
   * Log a message and broadcast via WebSocket
   * @param {string|null} profileName - Profile name or null for system messages
   * @param {string} message - Log message
   * @param {string} type - Log type: info, success, error, warning
   */
  _log(profileName, message, type = 'info') {
    const cleanProfileName = profileName == null ? profileName : repairMojibake(profileName);
    const cleanMessage = repairMojibake(message);
    const logEntry = {
      time: new Date().toISOString(),
      profile: cleanProfileName,
      message: cleanMessage,
      type: type,
      platform: this.platform,
    };

    // Console log for server-side debugging
    const prefix = cleanProfileName ? `[${cleanProfileName}]` : '[Runner]';
    console.log(`  ${prefix} ${cleanMessage}`);

    // Broadcast to WebSocket clients
    if (this._broadcastLog) {
      this._broadcastLog(logEntry);
    }
  }
}

// Keep the historical export as the Facebook singleton for compatibility.
const singleton = new RunnerService('facebook');
singleton.RunnerService = RunnerService;
singleton.buildVarMap = buildVarMap;
singleton.renderTemplate = renderTemplate;
singleton.getOrderedCandidatePosts = getOrderedCandidatePosts;
singleton.selectPendingPostsForProfile = selectPendingPostsForProfile;
singleton.getPlatformTimeoutSettings = getPlatformTimeoutSettings;
module.exports = singleton;




