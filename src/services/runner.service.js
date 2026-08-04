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

const BUILTIN_FIELDS = ['content', 'image_path', 'link', 'target', 'product_id', 'status', 'note'];

// Slug hoÃƒÆ’Ã‚Â¡ tÃƒÆ’Ã‚Âªn cÃƒÂ¡Ã‚Â»Ã¢â€žÂ¢t thÃƒÆ’Ã‚Â nh token biÃƒÂ¡Ã‚ÂºÃ‚Â¿n (Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“ng bÃƒÂ¡Ã‚Â»Ã¢â€žÂ¢ vÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºi init.js / data-manager.js)
function slugKey(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')
    .replace(/Ã„â€˜/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'cot';
}

// ChuÃƒÂ¡Ã‚ÂºÃ‚Â©n hoÃƒÆ’Ã‚Â¡ status Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã†â€™ so khÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºp pending/chÃƒÂ¡Ã‚Â»Ã‚Â (bÃƒÂ¡Ã‚Â»Ã‚Â dÃƒÂ¡Ã‚ÂºÃ‚Â¥u, thÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Âng hoÃƒÆ’Ã‚Â¡)
function normalizeStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd');
}
function isPendingStatus(status) {
  const s = normalizeStatus(status);
  return s === 'pending' || s === 'cho'; // 'chÃƒÂ¡Ã‚Â»Ã‚Â' -> 'cho'
}

// Ãƒâ€žÃ‚ÂÃƒÂ¡Ã‚Â»Ã‚Âc field_overrides (Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¢i tÃƒÆ’Ã‚Âªn biÃƒÂ¡Ã‚ÂºÃ‚Â¿n cÃƒÂ¡Ã‚Â»Ã¢â€žÂ¢t mÃƒÂ¡Ã‚ÂºÃ‚Â·c Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¹nh) tÃƒÂ¡Ã‚Â»Ã‚Â« settings
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

// DÃƒÂ¡Ã‚Â»Ã‚Â±ng map { tokenBiÃƒÂ¡Ã‚ÂºÃ‚Â¿n -> giÃƒÆ’Ã‚Â¡ trÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¹ } cho 1 bÃƒÆ’Ã‚Â i
// Doc cau hinh tu dong binh luan sau khi dang bai (tu bang settings)
function getCommentSettings(platform = 'facebook') {
  try {
    const normalized = normalizePlatform(platform);
    const prefix = normalized === 'facebook' ? '' : `${normalized}_`;
    const rows = db.prepare(
      'SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)'
    ).all(
      `${prefix}auto_comment_enabled`,
      `${prefix}comment_delay_unit`,
      `${prefix}comment_delay_min`,
      `${prefix}comment_delay_max`
    );
    const m = {};
    for (const r of rows) m[r.key.replace(prefix, '')] = r.value;
    return {
      enabled: m.auto_comment_enabled === '1',
      unit: m.comment_delay_unit === 'min' ? 'min' : 'sec',
      min: parseFloat(m.comment_delay_min) || 0,
      max: parseFloat(m.comment_delay_max) || 0,
    };
  } catch (e) {
    return { enabled: false, unit: 'sec', min: 0, max: 0 };
  }
}

function buildVarMap(post, platform = 'facebook') {
  const overrides = getFieldOverrides(platform);
  const map = {};

  // TÃƒÆ’Ã‚Âªn field gÃƒÂ¡Ã‚Â»Ã¢â‚¬Ëœc luÃƒÆ’Ã‚Â´n dÃƒÆ’Ã‚Â¹ng Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c
  for (const f of BUILTIN_FIELDS) map[f] = post[f] != null ? String(post[f]) : '';
  // Alias mÃƒÂ¡Ã‚ÂºÃ‚Â·c Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¹nh theo spec: {{media}} = cÃƒÂ¡Ã‚Â»Ã¢â€žÂ¢t hÃƒÆ’Ã‚Â¬nh ÃƒÂ¡Ã‚ÂºÃ‚Â£nh
  map['media'] = post.image_path != null ? String(post.image_path) : '';

  // ÃƒÆ’Ã‚Âp biÃƒÂ¡Ã‚ÂºÃ‚Â¿n do ngÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Âi dÃƒÆ’Ã‚Â¹ng Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¢i tÃƒÆ’Ã‚Âªn (nÃƒÂ¡Ã‚ÂºÃ‚Â¿u cÃƒÆ’Ã‚Â³)
  for (const f of BUILTIN_FIELDS) {
    const v = overrides[f] && overrides[f].var;
    if (v) map[v] = post[f] != null ? String(post[f]) : '';
  }

  // CÃƒÂ¡Ã‚Â»Ã¢â€žÂ¢t tuÃƒÂ¡Ã‚Â»Ã‚Â³ chÃƒÂ¡Ã‚Â»Ã¢â‚¬Â°nh: var_key -> value
  const customCols = db.prepare('SELECT * FROM custom_columns WHERE platform = ?').all(platform);
  for (const col of customCols) {
    const key = col.var_key || slugKey(col.name);
    const cd = db.prepare('SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?')
      .get(post.id, col.id);
    map[key] = cd && cd.value != null ? String(cd.value) : '';
  }
  return map;
}

// Thay {{token}} bÃƒÂ¡Ã‚ÂºÃ‚Â±ng giÃƒÆ’Ã‚Â¡ trÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¹ trong map

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
   * @param {Function} broadcastLog - WebSocket broadcast function
   */
  async start({ profileIds, dataIds, concurrency = 2, delayMin = 30, delayMax = 90, profileDelayMin = 10, profileDelayMax = 30 }, broadcastLog) {
    LicenseService.assertPlatform(this.platform);
    if (this.isRunning) {
      throw new Error('Runner Ãƒâ€žÃ¢â‚¬Ëœang chÃƒÂ¡Ã‚ÂºÃ‚Â¡y. Vui lÃƒÆ’Ã‚Â²ng dÃƒÂ¡Ã‚Â»Ã‚Â«ng trÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºc khi chÃƒÂ¡Ã‚ÂºÃ‚Â¡y lÃƒÂ¡Ã‚ÂºÃ‚Â¡i.');
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
        this._log(null, 'KhÃƒÆ’Ã‚Â´ng tÃƒÆ’Ã‚Â¬m thÃƒÂ¡Ã‚ÂºÃ‚Â¥y profile nÃƒÆ’Ã‚Â o.', 'error');
        this.isRunning = false;
        return { success: false, message: 'KhÃƒÆ’Ã‚Â´ng tÃƒÆ’Ã‚Â¬m thÃƒÂ¡Ã‚ÂºÃ‚Â¥y profile' };
      }

      // Get candidate posts from DB (theo lÃƒÂ¡Ã‚Â»Ã‚Â±a chÃƒÂ¡Ã‚Â»Ã‚Ân cÃƒÂ¡Ã‚Â»Ã‚Â§a ngÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Âi dÃƒÆ’Ã‚Â¹ng)
      let posts;
      if (dataIds === 'all' || dataIds === '*') {
        posts = db.prepare(
          'SELECT * FROM posts WHERE platform = ? ORDER BY sort_order ASC, id ASC'
        ).all(this.platform);
      } else {
        const dataPlaceholders = dataIds.map(() => '?').join(',');
        posts = db.prepare(
          `SELECT * FROM posts WHERE platform = ? AND id IN (${dataPlaceholders}) ORDER BY sort_order ASC, id ASC`
        ).all(this.platform, ...dataIds);
      }

      // NguyÃƒÆ’Ã‚Âªn tÃƒÂ¡Ã‚ÂºÃ‚Â¯c Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã‚Âc dÃƒÂ¡Ã‚Â»Ã‚Â¯ liÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡u: lÃƒÂ¡Ã‚Â»Ã‚Âc Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“ng thÃƒÂ¡Ã‚Â»Ã‚Âi 2 Ãƒâ€žÃ¢â‚¬ËœiÃƒÂ¡Ã‚Â»Ã‚Âu kiÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡n
      //  1) status ÃƒÂ¢Ã‹â€ Ã‹â€  {pending, chÃƒÂ¡Ã‚Â»Ã‚Â}
      //  2) biÃƒÂ¡Ã‚ÂºÃ‚Â¿n name_profile cÃƒÂ¡Ã‚Â»Ã‚Â§a bÃƒÆ’Ã‚Â i == tÃƒÆ’Ã‚Âªn profile trong trÃƒÆ’Ã‚Â¬nh duyÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡t
      const matchedByProfile = new Map(); // profileId -> posts[]
      let totalMatched = 0;
      for (const profile of profiles) {
        const target = String(profile.name || '').trim();
        const mine = posts.filter(p => {
          if (!isPendingStatus(p.status)) return false;
          const vmap = buildVarMap(p, this.platform);
          const np = String(vmap['name_profile'] || '').trim();
          return np && np === target;
        });
        matchedByProfile.set(profile.id, mine);
        totalMatched += mine.length;
        if (mine.length === 0) {
          this._log(profile.name, 'KhÃƒÆ’Ã‚Â´ng cÃƒÆ’Ã‚Â³ dÃƒÂ¡Ã‚Â»Ã‚Â¯ liÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡u phÃƒÆ’Ã‚Â¹ hÃƒÂ¡Ã‚Â»Ã‚Â£p (status pending + name_profile khÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºp).', 'warning');
        }
      }

      if (totalMatched === 0) {
        this._log(null, 'KhÃƒÆ’Ã‚Â´ng cÃƒÆ’Ã‚Â³ dÃƒÂ¡Ã‚Â»Ã‚Â¯ liÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡u chÃƒÂ¡Ã‚ÂºÃ‚Â¡y.', 'error');
        this.isRunning = false;
        return { success: false, message: 'KhÃƒÆ’Ã‚Â´ng cÃƒÆ’Ã‚Â³ dÃƒÂ¡Ã‚Â»Ã‚Â¯ liÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡u chÃƒÂ¡Ã‚ÂºÃ‚Â¡y' };
      }

      // ChÃƒÂ¡Ã‚Â»Ã¢â‚¬Â° chÃƒÂ¡Ã‚ÂºÃ‚Â¡y cÃƒÆ’Ã‚Â¡c profile cÃƒÆ’Ã‚Â³ bÃƒÆ’Ã‚Â i phÃƒÆ’Ã‚Â¹ hÃƒÂ¡Ã‚Â»Ã‚Â£p
      const profileQueue = profiles.filter(p => (matchedByProfile.get(p.id) || []).length > 0);

      // Calculate total tasks
      this.progress.total = totalMatched;

      this._log(null, `BÃƒÂ¡Ã‚ÂºÃ‚Â¯t Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚ÂºÃ‚Â§u chÃƒÂ¡Ã‚ÂºÃ‚Â¡y: ${profileQueue.length} profile, tÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¢ng ${totalMatched} bÃƒÆ’Ã‚Â i phÃƒÆ’Ã‚Â¹ hÃƒÂ¡Ã‚Â»Ã‚Â£p`, 'info');
      this._log(null, `Concurrency: ${concurrency} | Delay bÃƒÆ’Ã‚Â i: ${delayMin}-${delayMax}s | Delay profile: ${profileDelayMin}-${profileDelayMax}s`, 'info');

      // Process profiles with concurrency limit using promise pool
      const activePromises = new Set();

      for (let i = 0; i < profileQueue.length; i++) {
        if (this.shouldStop) {
          this._log(null, 'Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ dÃƒÂ¡Ã‚Â»Ã‚Â«ng theo yÃƒÆ’Ã‚Âªu cÃƒÂ¡Ã‚ÂºÃ‚Â§u.', 'warning');
          break;
        }

        const profile = profileQueue[i];

        // Wait if concurrency limit reached
        while (activePromises.size >= concurrency) {
          await Promise.race(activePromises);
        }

        if (this.shouldStop) break;

        // Launch profile task (chÃƒÂ¡Ã‚Â»Ã¢â‚¬Â° cÃƒÆ’Ã‚Â¡c bÃƒÆ’Ã‚Â i Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ khÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºp vÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºi profile nÃƒÆ’Ã‚Â y)
        const myPosts = matchedByProfile.get(profile.id) || [];
        const profilePromise = this._processProfile(profile, myPosts, delayMin, delayMax)
          .then(() => {
            activePromises.delete(profilePromise);
          })
          .catch((err) => {
            activePromises.delete(profilePromise);
            this._log(profile.name, `LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i profile: ${err.message}`, 'error');
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
            this._log(null, `ChÃƒÂ¡Ã‚Â»Ã‚Â ${Math.round(profileDelay / 1000)}s trÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºc khi xÃƒÂ¡Ã‚Â»Ã‚Â­ lÃƒÆ’Ã‚Â½ profile tiÃƒÂ¡Ã‚ÂºÃ‚Â¿p theo...`, 'info');
            await this._sleep(profileDelay);
          }
        } else if (i < profileQueue.length - 1) {
          // Small stagger delay when launching concurrent profiles
          const profileDelay = this._randomSeconds(profileDelayMin, profileDelayMax);
          this._log(null, `ChÃƒÂ¡Ã‚Â»Ã‚Â ${Math.round(profileDelay / 1000)}s trÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºc khi khÃƒÂ¡Ã‚Â»Ã…Â¸i chÃƒÂ¡Ã‚ÂºÃ‚Â¡y profile tiÃƒÂ¡Ã‚ÂºÃ‚Â¿p theo...`, 'info');
          await this._sleep(profileDelay);
        }
      }

      // Wait for all remaining tasks
      await Promise.allSettled([...activePromises]);

    } catch (err) {
      this._log(null, `LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i hÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡ thÃƒÂ¡Ã‚Â»Ã¢â‚¬Ëœng: ${err.message}`, 'error');
    } finally {
      this.isRunning = false;
      this.runningTasks = [];

      const summary = {
        total: this.progress.total,
        completed: this.progress.completed,
        errors: this.progress.errors,
        stopped: this.shouldStop
      };

      this._log(null, `HoÃƒÆ’Ã‚Â n tÃƒÂ¡Ã‚ÂºÃ‚Â¥t: ${summary.completed}/${summary.total} thÃƒÆ’Ã‚Â nh cÃƒÆ’Ã‚Â´ng, ${summary.errors} lÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i${summary.stopped ? ' (Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ dÃƒÂ¡Ã‚Â»Ã‚Â«ng sÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºm)' : ''}`, summary.errors > 0 ? 'warning' : 'success');

      // Broadcast final status
      if (this._broadcastLog) {
        this._broadcastLog({
          time: new Date().toISOString(),
          profile: null,
          message: 'Runner Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ dÃƒÂ¡Ã‚Â»Ã‚Â«ng',
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
    this._log(profile.name, 'Ãƒâ€žÃ‚Âang mÃƒÂ¡Ã‚Â»Ã…Â¸ Chrome...', 'info');

    let page = null;
    let leased = false;
    const BrowserService = require('./browser.service');

    try {
      // MÃƒÂ¡Ã‚Â»Ã…Â¸ Chrome (hoÃƒÂ¡Ã‚ÂºÃ‚Â·c dÃƒÆ’Ã‚Â¹ng lÃƒÂ¡Ã‚ÂºÃ‚Â¡i nÃƒÂ¡Ã‚ÂºÃ‚Â¿u Ãƒâ€žÃ¢â‚¬Ëœang mÃƒÂ¡Ã‚Â»Ã…Â¸) rÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“i lÃƒÂ¡Ã‚ÂºÃ‚Â¥y page thÃƒÂ¡Ã‚ÂºÃ‚Â­t
      try {
        await ProfileActionQueue.run(profile.id, 'post', async () => {
          let instance = await BrowserService.acquire(profile.id);
          leased = true;
          page = instance ? instance.page : null;
          if (!page) throw new Error('Không lấy được tab trình duyệt');
        }, 0);
        this._log(profile.name, 'Chrome Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ mÃƒÂ¡Ã‚Â»Ã…Â¸ thÃƒÆ’Ã‚Â nh cÃƒÆ’Ã‚Â´ng.', 'success');
      } catch (launchErr) {
        this._log(profile.name, `KhÃƒÆ’Ã‚Â´ng thÃƒÂ¡Ã‚Â»Ã†â€™ mÃƒÂ¡Ã‚Â»Ã…Â¸ Chrome: ${launchErr.message}`, 'error');
        throw launchErr;
      }

      // Process each post
      for (let i = 0; i < posts.length; i++) {
        if (this.shouldStop) {
          this._log(profile.name, 'DÃƒÂ¡Ã‚Â»Ã‚Â«ng theo yÃƒÆ’Ã‚Âªu cÃƒÂ¡Ã‚ÂºÃ‚Â§u ngÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Âi dÃƒÆ’Ã‚Â¹ng.', 'warning');
          break;
        }

        const post = posts[i];
        this._log(profile.name, `Ãƒâ€žÃ‚Âang xÃƒÂ¡Ã‚Â»Ã‚Â­ lÃƒÆ’Ã‚Â½ bÃƒÆ’Ã‚Â i #${post.id} (${i + 1}/${posts.length})...`, 'info');

        try {
          // Process the post (thao tÃƒÆ’Ã‚Â¡c web thÃƒÂ¡Ã‚ÂºÃ‚Â­t)
          const result = await ProfileActionQueue.run(profile.id, 'post', async () => {
            let instance = BrowserService.getInstance(profile.id);
            if (!instance) {
              instance = await BrowserService.acquire(profile.id);
              leased = true;
            }
            page = instance ? instance.page : null;
            if (!page) throw new Error('Không lấy được tab trình duyệt để đăng bài');
            return this.processPost(page, post);
          }, 0);
          const postedAt = (result && result.postedAt) || new Date().toLocaleString('vi-VN');

          const postLink = (result && result.postLink) || '';
          const cleanNote = postLink
            ? `Đăng lúc ${postedAt}`
            : `Đăng lúc ${postedAt} | Chưa lấy được link`;
          const note = postLink ? `Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng lÃƒÆ’Ã‚Âºc ${postedAt}` : `Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng lÃƒÆ’Ã‚Âºc ${postedAt} | ChÃƒâ€ Ã‚Â°a lÃƒÂ¡Ã‚ÂºÃ‚Â¥y Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c link`;

          // Update post status in DB + lÃƒâ€ Ã‚Â°u thÃƒÂ¡Ã‚Â»Ã‚Âi gian Ãƒâ€žÃ¢â‚¬ËœÃƒâ€žÃ†â€™ng vÃƒÆ’Ã‚Â o note/link
          db.prepare(
            'UPDATE posts SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run('success', cleanNote, post.id);
          setCustomValue(post.id, 'link_post', postLink, 'text', this.platform);
          setCustomValue(post.id, 'time_post', postedAt, 'text', this.platform);

          // Log activity to activity_logs
          db.prepare(
            'INSERT INTO activity_logs (type, profile_id, post_id, message, status, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
          ).run('post', profile.id, post.id, `Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng bÃƒÆ’Ã‚Â i #${post.id} thÃƒÆ’Ã‚Â nh cÃƒÆ’Ã‚Â´ng qua profile "${profile.name}" lÃƒÆ’Ã‚Âºc ${postedAt}${postLink ? ` | ${postLink}` : ''}`, 'success');

          db.prepare('UPDATE activity_logs SET platform = ? WHERE id = last_insert_rowid()')
            .run(this.platform);
          await this._scheduleCommentJob(profile, post, result || {});

          this.progress.completed++;
          this._log(profile.name, `ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ BÃƒÆ’Ã‚Â i #${post.id} - ThÃƒÆ’Ã‚Â nh cÃƒÆ’Ã‚Â´ng lÃƒÆ’Ã‚Âºc ${postedAt}${postLink ? ` | link_post: ${postLink}` : ' | ChÃƒâ€ Ã‚Â°a lÃƒÂ¡Ã‚ÂºÃ‚Â¥y Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c link'} (${this.progress.completed}/${this.progress.total})`, 'success');

        } catch (postErr) {
          this.progress.errors++;
          await this._markCommentAfterPostFailure(post, postErr);

          // Update post status to error
          db.prepare(
            'UPDATE posts SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run('error', postErr.message, post.id);

          // Log error activity
          db.prepare(
            'INSERT INTO activity_logs (type, profile_id, post_id, message, status, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
          ).run('post', profile.id, post.id, `LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i bÃƒÆ’Ã‚Â i #${post.id}: ${postErr.message}`, 'error');

          this._log(profile.name, `ÃƒÂ¢Ã‚ÂÃ…â€™ BÃƒÆ’Ã‚Â i #${post.id} - LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i: ${postErr.message}`, 'error');
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
          this._log(profile.name, `ChÃƒÂ¡Ã‚Â»Ã‚Â ${Math.round(delay / 1000)}s trÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºc bÃƒÆ’Ã‚Â i tiÃƒÂ¡Ã‚ÂºÃ‚Â¿p theo...`, 'info');
          await this._sleep(delay);
        }
      }

    } finally {
      // Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â³ng Chrome sau khi xÃƒÂ¡Ã‚Â»Ã‚Â­ lÃƒÆ’Ã‚Â½ xong profile
      if (leased) {
        try {
          await ProfileActionQueue.run(
            profile.id,
            `${this.platform}:release`,
            () => BrowserService.release(profile.id),
            -100
          );
          this._log(profile.name, 'Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â³ng Chrome.', 'info');
        } catch (closeErr) {
          this._log(profile.name, `LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i khi Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â³ng Chrome: ${closeErr.message}`, 'warning');
        }
      }
    }
  }

  async _scheduleCommentJob(profile, post, result) {
    const CommentJobService = require('./comment-job.service');
    const cfg = getCommentSettings(this.platform);
    const vmap = buildVarMap(post, this.platform);
    const commentText = renderTemplate(
      vmap.comment != null ? String(vmap.comment) : '',
      vmap
    ).trim();
    const mediaRaw = renderTemplate(
      vmap.comment_media != null ? String(vmap.comment_media) : '',
      vmap
    ).trim();

    if (!cfg.enabled) {
      CommentJobService.markSkipped(post.id, 'Tự động bình luận đang tắt', this.platform);
      return null;
    }
    if (!commentText && !mediaRaw) {
      CommentJobService.markSkipped(post.id, 'Không có nội dung hoặc media bình luận', this.platform);
      return null;
    }
    if (!result.postLink) {
      CommentJobService.markError(post.id, 'Bài đã đăng nhưng chưa lấy được permalink', this.platform);
      return null;
    }

    let mediaPath = '';
    if (mediaRaw) {
      mediaPath = path.resolve(mediaRaw);
      const supported = /\.(?:png|jpe?g|gif|webp|bmp|mp4|mov|m4v|avi|mkv|webm|wmv|mpeg|mpg|3gp)$/i.test(mediaPath);
      if (!supported) {
        CommentJobService.markError(post.id, 'Định dạng media bình luận không được hỗ trợ', this.platform);
        return null;
      }
      if (!fs.existsSync(mediaPath)) {
        CommentJobService.markError(post.id, `Không tìm thấy media bình luận: ${mediaPath}`, this.platform);
        return null;
      }
    }

    const unitMs = cfg.unit === 'min' ? 60000 : 1000;
    const lo = Math.max(0, cfg.min) * unitMs;
    const hi = Math.max(lo, cfg.max * unitMs);
    const delayMs = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    const publishedAtMs = Number(result.publishedAtMs) || Date.now();

    return CommentJobService.schedule({
      postId: post.id,
      profileId: profile.id,
      postLink: result.postLink,
      commentText,
      mediaPath,
      dueAt: publishedAtMs + delayMs,
      platform: this.platform,
    });
  }

  async _markCommentAfterPostFailure(post, error) {
    const CommentJobService = require('./comment-job.service');
    const cfg = getCommentSettings(this.platform);
    const vmap = buildVarMap(post, this.platform);
    const text = renderTemplate(vmap.comment || '', vmap).trim();
    const media = renderTemplate(vmap.comment_media || '', vmap).trim();
    if (!cfg.enabled || (!text && !media)) {
      CommentJobService.markSkipped(post.id, '', this.platform);
    } else {
      CommentJobService.markError(post.id, `Bài đăng thất bại: ${error.message}`, this.platform);
    }
  }

  /**
   * Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng 1 bÃƒÆ’Ã‚Â i lÃƒÆ’Ã‚Âªn Facebook theo cÃƒÆ’Ã‚Â¡c bÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºc B1ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“B5.
   * @param {Object} page - Puppeteer page
   * @param {Object} post - BÃƒÂ¡Ã‚ÂºÃ‚Â£n ghi bÃƒÆ’Ã‚Â i tÃƒÂ¡Ã‚Â»Ã‚Â« DB
   * @returns {Promise<Object>} { success, postedAt }
   */
  async processPost(page, post) {
    return getPlatformAdapter(this.platform).publish(page, post, {
      buildVarMap: value => buildVarMap(value, this.platform),
      renderTemplate,
      log: (message, type = 'info', profileName = null) => this._log(profileName, message, type),
      sleep: ms => this._sleep(ms),
    });
  }

  // Backward-compatible generic entry points used by existing integrations.
  // Platform-specific DOM code remains inside the two adapter files.
  async commentOnPost(page, postLink, commentText = '', mediaPath = '') {
    return getPlatformAdapter(this.platform).comment(page, postLink, commentText, mediaPath, {
      sleep: ms => this._sleep(ms),
      commentVerificationTimeoutMs: this._commentVerificationTimeoutMs,
      commentUploadTimeoutMs: this._commentUploadTimeoutMs,
    });
  }

  async hasExistingComment(page, postLink, commentText = '', mediaPath = '') {
    return getPlatformAdapter(this.platform).hasExistingComment(page, postLink, commentText, mediaPath);
  }

  stop() {
    if (!this.isRunning) {
      return { success: false, message: 'Runner khÃƒÆ’Ã‚Â´ng Ãƒâ€žÃ¢â‚¬Ëœang chÃƒÂ¡Ã‚ÂºÃ‚Â¡y.' };
    }

    this.shouldStop = true;
    this._log(null, 'Ãƒâ€žÃ‚Âang dÃƒÂ¡Ã‚Â»Ã‚Â«ng... ChÃƒÂ¡Ã‚Â»Ã‚Â cÃƒÆ’Ã‚Â¡c tÃƒÆ’Ã‚Â¡c vÃƒÂ¡Ã‚Â»Ã‚Â¥ hiÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡n tÃƒÂ¡Ã‚ÂºÃ‚Â¡i hoÃƒÆ’Ã‚Â n tÃƒÂ¡Ã‚ÂºÃ‚Â¥t.', 'warning');

    return { success: true, message: 'Ãƒâ€žÃ‚Âang dÃƒÂ¡Ã‚Â»Ã‚Â«ng runner...' };
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
    const logEntry = {
      time: new Date().toISOString(),
      profile: profileName,
      message: message,
      type: type,
      platform: this.platform,
    };

    // Console log for server-side debugging
    const prefix = profileName ? `[${profileName}]` : '[Runner]';
    console.log(`  ${prefix} ${message}`);

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
module.exports = singleton;




