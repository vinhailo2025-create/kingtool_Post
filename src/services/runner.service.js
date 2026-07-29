/**
 * Runner Service - Task Execution Engine
 * Manages automation task queue with concurrency control, random delays,
 * realtime WebSocket logging, and activity tracking.
 */

const db = require('../database/init');
const path = require('path');
const fs = require('fs');

const BUILTIN_FIELDS = ['content', 'image_path', 'link', 'target', 'status', 'note'];

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
function getFieldOverrides() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'field_overrides'").get();
    return row && row.value ? JSON.parse(row.value) : {};
  } catch (e) {
    return {};
  }
}

// DÃƒÂ¡Ã‚Â»Ã‚Â±ng map { tokenBiÃƒÂ¡Ã‚ÂºÃ‚Â¿n -> giÃƒÆ’Ã‚Â¡ trÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¹ } cho 1 bÃƒÆ’Ã‚Â i
function buildVarMap(post) {
  const overrides = getFieldOverrides();
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
  const customCols = db.prepare('SELECT * FROM custom_columns').all();
  for (const col of customCols) {
    const key = col.var_key || slugKey(col.name);
    const cd = db.prepare('SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?')
      .get(post.id, col.id);
    map[key] = cd && cd.value != null ? String(cd.value) : '';
  }
  return map;
}

// Thay {{token}} bÃƒÂ¡Ã‚ÂºÃ‚Â±ng giÃƒÆ’Ã‚Â¡ trÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¹ trong map

function ensureCustomColumn(varKey, name = varKey) {
  let col = db.prepare('SELECT * FROM custom_columns WHERE var_key = ? OR name = ?').get(varKey, name);
  if (col) {
    if (col.var_key !== varKey || col.name !== name) {
      db.prepare('UPDATE custom_columns SET name = ?, var_key = ? WHERE id = ?').run(name, varKey, col.id);
      col = db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(col.id);
    }
    return col;
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_order FROM custom_columns').get();
  const result = db.prepare('INSERT INTO custom_columns (name, col_type, var_key, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, 'text', varKey, (maxOrder.max_order || 0) + 1);
  return db.prepare('SELECT * FROM custom_columns WHERE id = ?').get(result.lastInsertRowid);
}

function setCustomValue(postId, varKey, value) {
  const col = ensureCustomColumn(varKey, varKey);
  db.prepare('INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value) VALUES (?, ?, ?)')
    .run(postId, col.id, value || '');
}

function renderTemplate(template, map) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : '';
  });
}

class RunnerService {
  constructor() {
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
        `SELECT * FROM browsers WHERE id IN (${profilePlaceholders})`
      ).all(...profileIds);

      if (profiles.length === 0) {
        this._log(null, 'KhÃƒÆ’Ã‚Â´ng tÃƒÆ’Ã‚Â¬m thÃƒÂ¡Ã‚ÂºÃ‚Â¥y profile nÃƒÆ’Ã‚Â o.', 'error');
        this.isRunning = false;
        return { success: false, message: 'KhÃƒÆ’Ã‚Â´ng tÃƒÆ’Ã‚Â¬m thÃƒÂ¡Ã‚ÂºÃ‚Â¥y profile' };
      }

      // Get candidate posts from DB (theo lÃƒÂ¡Ã‚Â»Ã‚Â±a chÃƒÂ¡Ã‚Â»Ã‚Ân cÃƒÂ¡Ã‚Â»Ã‚Â§a ngÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Âi dÃƒÆ’Ã‚Â¹ng)
      let posts;
      if (dataIds === 'all' || dataIds === '*') {
        posts = db.prepare('SELECT * FROM posts ORDER BY sort_order ASC, id ASC').all();
      } else {
        const dataPlaceholders = dataIds.map(() => '?').join(',');
        posts = db.prepare(
          `SELECT * FROM posts WHERE id IN (${dataPlaceholders}) ORDER BY sort_order ASC, id ASC`
        ).all(...dataIds);
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
          const vmap = buildVarMap(p);
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
    const BrowserService = require('./browser.service');

    try {
      // MÃƒÂ¡Ã‚Â»Ã…Â¸ Chrome (hoÃƒÂ¡Ã‚ÂºÃ‚Â·c dÃƒÆ’Ã‚Â¹ng lÃƒÂ¡Ã‚ÂºÃ‚Â¡i nÃƒÂ¡Ã‚ÂºÃ‚Â¿u Ãƒâ€žÃ¢â‚¬Ëœang mÃƒÂ¡Ã‚Â»Ã…Â¸) rÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“i lÃƒÂ¡Ã‚ÂºÃ‚Â¥y page thÃƒÂ¡Ã‚ÂºÃ‚Â­t
      try {
        let instance = BrowserService.getInstance(profile.id);
        if (!instance) {
          await BrowserService.launch(profile.id);
          instance = BrowserService.getInstance(profile.id);
        }
        page = instance ? instance.page : null;
        if (!page) throw new Error('KhÃƒÆ’Ã‚Â´ng lÃƒÂ¡Ã‚ÂºÃ‚Â¥y Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c tab trÃƒÆ’Ã‚Â¬nh duyÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡t');
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
          const result = await this.processPost(page, post);
          const postedAt = (result && result.postedAt) || new Date().toLocaleString('vi-VN');

          const postLink = (result && result.postLink) || '';
          const note = postLink ? `Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng lÃƒÆ’Ã‚Âºc ${postedAt}` : `Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng lÃƒÆ’Ã‚Âºc ${postedAt} | ChÃƒâ€ Ã‚Â°a lÃƒÂ¡Ã‚ÂºÃ‚Â¥y Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c link`;

          // Update post status in DB + lÃƒâ€ Ã‚Â°u thÃƒÂ¡Ã‚Â»Ã‚Âi gian Ãƒâ€žÃ¢â‚¬ËœÃƒâ€žÃ†â€™ng vÃƒÆ’Ã‚Â o note/link
          db.prepare(
            'UPDATE posts SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run('success', note, post.id);
          setCustomValue(post.id, 'link_post', postLink);
          setCustomValue(post.id, 'time_post', postedAt);

          // Log activity to activity_logs
          db.prepare(
            'INSERT INTO activity_logs (type, profile_id, post_id, message, status, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
          ).run('post', profile.id, post.id, `Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng bÃƒÆ’Ã‚Â i #${post.id} thÃƒÆ’Ã‚Â nh cÃƒÆ’Ã‚Â´ng qua profile "${profile.name}" lÃƒÆ’Ã‚Âºc ${postedAt}${postLink ? ` | ${postLink}` : ''}`, 'success');

          this.progress.completed++;
          this._log(profile.name, `ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ BÃƒÆ’Ã‚Â i #${post.id} - ThÃƒÆ’Ã‚Â nh cÃƒÆ’Ã‚Â´ng lÃƒÆ’Ã‚Âºc ${postedAt}${postLink ? ` | link_post: ${postLink}` : ' | ChÃƒâ€ Ã‚Â°a lÃƒÂ¡Ã‚ÂºÃ‚Â¥y Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c link'} (${this.progress.completed}/${this.progress.total})`, 'success');

        } catch (postErr) {
          this.progress.errors++;

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

        // Broadcast progress update
        if (this._broadcastLog) {
          this._broadcastLog({
            time: new Date().toISOString(),
            profile: profile.name,
            message: '',
            type: 'progress',
            event: 'progress',
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
      if (page) {
        try {
          await BrowserService.close(profile.id);
          this._log(profile.name, 'Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â³ng Chrome.', 'info');
        } catch (closeErr) {
          this._log(profile.name, `LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i khi Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â³ng Chrome: ${closeErr.message}`, 'warning');
        }
      }
    }
  }

  /**
   * Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng 1 bÃƒÆ’Ã‚Â i lÃƒÆ’Ã‚Âªn Facebook theo cÃƒÆ’Ã‚Â¡c bÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºc B1ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“B5.
   * @param {Object} page - Puppeteer page
   * @param {Object} post - BÃƒÂ¡Ã‚ÂºÃ‚Â£n ghi bÃƒÆ’Ã‚Â i tÃƒÂ¡Ã‚Â»Ã‚Â« DB
   * @returns {Promise<Object>} { success, postedAt }
   */
  async processPost(page, post) {
    if (!page) throw new Error('Khong co tab trinh duyet');

    const XP_TIMEOUT = 30000;
    const vmap = buildVarMap(post);
    const content = renderTemplate('{{content}}', vmap);
    const mediaRaw = renderTemplate('{{media}}', vmap);
    const humanDelay = (min = 900, max = 2600) => this._sleep(Math.floor(Math.random() * (max - min + 1)) + min);

    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(2500, 4500);

    // Kiem tra dang nhap bang cookie c_user - tin hieu dang tin cay nhat. Tranh false-positive cua cach
    // do chu "login/dang nhap" trong body (trang da dang nhap van co the chua cac tu nay o menu/footer).
    const getCUser = async () => ((await page.cookies('https://www.facebook.com').catch(() => [])).find(x => x.name === 'c_user') || {}).value;
    let cUser = await getCUser();
    if (!cUser) {
      // Man hinh "Chao mung tro lai / chon tai khoan": FB nho tai khoan nhung chua kich hoat phien
      // (chua co c_user) cho toi khi bam "Tiep tuc/Continue". Mo tay thi nguoi dung bam -> vao binh thuong;
      // tool phai tu bam nut nay thi moi co session. Thu toi 3 lan.
      for (let attempt = 0; attempt < 3 && !cUser; attempt++) {
        const contBtn = await page.evaluateHandle(() => {
          const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
          const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 30 && r.height > 15 && s.visibility !== 'hidden' && s.display !== 'none'; };
          const nodes = Array.from(document.querySelectorAll('[role="button"], button, a, div[tabindex]')).filter(vis);
          return nodes.find(e => { const t = norm(e.innerText || ''); return t === 'continue' || t === 'tiep tuc'; })
            || nodes.find(e => { const t = norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')); return t.includes('continue') || t.includes('tiep tuc'); })
            || null;
        }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
        if (!contBtn) break;
        await humanDelay();
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          contBtn.click().catch(() => {}),
        ]);
        await humanDelay(2500, 4500);
        cUser = await getCUser();
      }
    }
    if (!cUser) {
      // Van chua co c_user -> that su chua dang nhap (man hinh nhap mat khau/tao tai khoan).
      throw new Error('Facebook chua vao session dang nhap (can dang nhap lai profile)');
    }

    let profileHref = cUser ? `https://www.facebook.com/profile.php?id=${cUser}` : await this.getFacebookTimelineHref(page);
    if (!profileHref) throw new Error('B2: Khong lay duoc link timeline profile');

    let owner = await this.getProfileOwner(page, profileHref);

    // Bat buoc vao dung trang profile cua cookie c_user truoc khi crawl va dang bai; khong lay link tu feed/home.
    await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(3500, 6000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this.prepareTimelineForScan(page);
    owner = this._mergeOwner(owner, await this._readOwnerFromPage(page));
    if (owner.vanity) profileHref = `https://www.facebook.com/${owner.vanity}`;
    const beforeLinks = new Set(await this._extractTopOwnPostLinks(page, owner, 3));

    // Vao lai dung trang profile desktop de dang bai.
    await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(3000, 5000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(800, 1500);

    // Lay handle modal "Tao bai viet" hien tai (dialog HIEN THI co o soan / tieu de tao bai viet),
    // KHONG lay dialog dau tien (co the la dialog Thong bao an).
    const getModal = () => page.evaluateHandle(() => {
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
      const vis = e => { const r = e.getBoundingClientRect(); const s2 = getComputedStyle(e); return r.width > 200 && r.height > 150 && s2.visibility !== 'hidden' && s2.display !== 'none'; };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis);
      return dialogs.find(d => {
        if (d.querySelector('div[contenteditable="true"], [role="textbox"]')) return true;
        const t = norm((d.getAttribute('aria-label') || '') + ' ' + (d.innerText || '').slice(0, 80));
        return t.includes('tao bai viet') || t.includes('create post');
      }) || null;
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);

    // Mo composer: lay HANDLE nut composer uu tien "Ban dang nghi gi?", scrollIntoView roi click
    // (dung handle.click de tu cuon toi - tranh loi nut nam ngoai viewport khi dung toa do tinh).
    let modal = await getModal();
    if (!modal) {
      const composerBtn = await page.evaluateHandle(() => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
        const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 20 && st.visibility !== 'hidden' && st.display !== 'none'; };
        let best = null, bestScore = -1;
        Array.from(document.querySelectorAll('[role="button"], div[tabindex]')).forEach(e => {
          if (!visible(e)) return;
          const t = norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || ''));
          let pr = 0;
          if (t.includes('ban dang nghi gi') || t.includes("what's on your mind")) pr = 3;
          else if (t.includes('tao bai viet') || t.includes('create post')) pr = 2;
          else if (t.includes('chia se suy nghi')) pr = 1;
          if (!pr) return;
          const r = e.getBoundingClientRect();
          const score = pr * 1e7 + r.width * r.height;
          if (score > bestScore) { bestScore = score; best = e; }
        });
        return best;
      }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
      if (composerBtn) {
        for (let attempt = 0; attempt < 3 && !modal; attempt++) {
          await page.keyboard.press('Escape').catch(() => {});
          await humanDelay(400, 800);
          await composerBtn.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
          await humanDelay(500, 900);
          await composerBtn.click().catch(() => {});
          for (let t = 0; t < 8 && !modal; t++) { await this._sleep(1000); modal = await getModal(); }
        }
      }
    }
    if (!modal) {
      try {
        const dbg = await page.evaluate(() => {
          const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 30 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none'; };
          return {
            url: location.href, title: document.title,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            dialogCount: document.querySelectorAll('[role="dialog"]').length,
            visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).map(d => (d.innerText || '').replace(/\s+/g, ' ').slice(0, 80)),
            body: (document.body.innerText || '').slice(0, 1200),
          };
        });
        fs.writeFileSync(path.join(__dirname, '..', '..', 'composer-debug.json'), JSON.stringify(dbg, null, 2));
      } catch (_) {}
      throw new Error('B5: Khong mo duoc o soan bai (Tao bai viet)');
    }
    await humanDelay(1500, 2500);

    // O soan noi dung trong modal
    let editable = await modal.evaluateHandle(root => {
      const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 80 && r.height > 20 && st.visibility !== 'hidden' && st.display !== 'none'; };
      const boxes = Array.from(root.querySelectorAll('div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]'));
      return boxes.find(visible) || null;
    }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
    if (editable) { await editable.click(); await humanDelay(600, 1200); }
    if (content && content.trim()) {
      await page.keyboard.type(content, { delay: 25 });
      await humanDelay(1200, 2200);
    }

    // Dinh media (neu co) - tim nut Anh/video TRONG modal
    const mediaPaths = String(mediaRaw || '').split(',').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p)).filter(p => fs.existsSync(p));
    if (mediaPaths.length > 0) {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: XP_TIMEOUT }),
        (async () => {
          const mediaBtn = await modal.evaluateHandle(root => {
            const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase();
            return Array.from(root.querySelectorAll('[role="button"], [aria-label]')).find(e => norm((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).includes('anh/video')) || null;
          }).then(h => (h && h.asElement ? h.asElement() : null)).catch(() => null);
          if (!mediaBtn) throw new Error('B6: Khong thay nut Anh/video');
          await humanDelay();
          await mediaBtn.click();
        })(),
      ]);
      await fileChooser.accept(mediaPaths);
      await this._sleep(4000 + mediaPaths.length * 2500);
      await humanDelay(1200, 2500);
    }

    // Bam nut Dang (khop chinh xac de tranh nham "Dang tai..."). Xu ly buoc "Tiep" neu co.
    // Xac nhan thanh cong bang cach modal "Tao bai viet" bien mat.
    let posted = false;
    for (let step = 0; step < 20 && !posted; step++) {
      const cur = await getModal();
      if (!cur) { posted = true; break; } // modal da dong -> da dang xong
      const clickInfo = await cur.evaluate(root => {
        const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd').toLowerCase().trim();
        const visible = e => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 20 && r.height > 10 && st.visibility !== 'hidden' && st.display !== 'none'; };
        const enabled = e => e.getAttribute('aria-disabled') !== 'true' && !e.matches('[disabled]');
        const parts = e => [norm(e.getAttribute('aria-label') || ''), norm(e.innerText || '')].filter(Boolean);
        const isSubmit = e => parts(e).some(p => p === 'dang' || p === 'post' || p === 'dang bai' || p === 'dang bai viet');
        const isNext = e => parts(e).some(p => p === 'tiep' || p === 'tiep tuc' || p === 'next');
        const nodes = Array.from(root.querySelectorAll('[role="button"], button')).filter(visible);
        let pick = nodes.find(e => enabled(e) && isSubmit(e));
        let kind = 'dang';
        if (!pick) { pick = nodes.find(e => enabled(e) && isNext(e)); kind = 'tiep'; }
        if (!pick) return null;
        const r = pick.getBoundingClientRect();
        return { kind, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }).catch(() => null);
      if (clickInfo) {
        await humanDelay();
        await page.mouse.click(clickInfo.x, clickInfo.y).catch(() => {});
        await humanDelay(2000, 3500);
        if (clickInfo.kind === 'dang') {
          // cho modal dong (toi 8s)
          for (let w = 0; w < 8; w++) { const m = await getModal(); if (!m) { posted = true; break; } await this._sleep(1000); }
        }
      } else {
        await this._sleep(1500);
      }
    }
    if (!posted) throw new Error('B7: Khong tim thay/khong bam duoc nut Dang');

    await this._sleep(8000);
    // Cach chinh (on dinh nhat): tim bai theo noi dung roi HOVER len timestamp -> FB tu inject permalink vao href.
    let postLink = await this.capturePostLinkByHover(page, profileHref, content, owner, beforeLinks);
    if (!postLink) postLink = await this.captureNewTopOwnPostLink(page, profileHref, beforeLinks, owner, 3);
    if (!postLink) postLink = await this.captureNewTimelinePostLink(page, profileHref, beforeLinks, content, owner);
    return { success: true, postedAt: new Date().toLocaleString('vi-VN'), postLink, profileHref };
  }

  // Lay permalink bai vua dang: cuon tim bai theo noi dung (needle), hover len link timestamp
  // ngay tren noi dung -> Facebook inject permalink that vao href (timestamp bi xao tron ky tu + href rong
  // cho toi khi hover). Doc href qua elementFromPoint. Day la cach on dinh nhat vi timeline ao hoa + href lazy.
  async capturePostLinkByHover(page, profileHref, content, owner, beforeLinks) {
    const needle = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 45);
    if (!needle) return '';
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    let own = { vanity: (owner && owner.vanity) || null, id: (owner && owner.id) || null };
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      // Resolve vanity tu canonical de _isOwnPostUrl khop dung (owner truyen vao co the thieu vanity).
      if (!own.vanity) {
        const v = await page.evaluate(() => {
          const c = document.querySelector('link[rel="canonical"]');
          try { const u = new URL((c && c.href) || location.href); const s = u.pathname.split('/').filter(Boolean); if (s[0] && s[0] !== 'profile.php') return s[0]; } catch (e) {}
          return null;
        }).catch(() => null);
        if (v) own.vanity = v;
      }
      // cuon cho toi khi co it nhat 1 bai chua needle xuat hien
      let found = false;
      for (let s = 0; s < 12 && !found; s++) {
        found = await page.evaluate((needle) => {
          const norm = x => String(x || '').replace(/\s+/g, ' ');
          return Array.from(document.querySelectorAll('div,span,p')).some(e => e.children.length < 40 && norm(e.innerText).includes(needle));
        }, needle).catch(() => false);
        if (!found) { await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {}); await this._sleep(1200); }
      }
      if (!found) continue;
      await this._sleep(1500);

      // Duyet MOI node khop needle: scroll node vao giua, lay link timestamp NGAY TREN noi dung
      // va PHAI nam trong viewport (tranh loi node trung lap nam ngoai man hinh -> hover truot).
      const cands = await page.evaluate((needle) => {
        const norm = s => String(s || '').replace(/\s+/g, ' ');
        const nodes = Array.from(document.querySelectorAll('div,span,p')).filter(e => e.children.length < 40 && norm(e.innerText).includes(needle));
        for (const node of nodes) {
          node.scrollIntoView({ block: 'center' });
          const nr = node.getBoundingClientRect();
          const ts = Array.from(document.querySelectorAll('a[role="link"], a[href]')).map(a => {
            const r = a.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: r.top, left: r.left, w: r.width, h: r.height };
          }).filter(a => a.w > 0 && a.h > 0 && a.h < 40 && a.top < nr.top - 8 && a.top > nr.top - 95
            && a.left >= nr.left - 30 && a.left < nr.left + 280
            && a.top > 40 && (a.top + a.h) < window.innerHeight - 20) // trong viewport
            .sort((p, q) => q.top - p.top)
            .slice(0, 4)
            .map(a => ({ x: a.x, y: a.y }));
          if (ts.length) return ts;
        }
        return [];
      }, needle).catch(() => []);

      for (const c of cands) {
        await page.mouse.move(c.x, c.y).catch(() => {});
        await this._sleep(1400);
        const href = await page.evaluate((xy) => {
          const el = document.elementFromPoint(xy.x, xy.y);
          const a = el && el.closest ? el.closest('a[href]') : null;
          return a ? a.href : '';
        }, c).catch(() => '');
        const clean = this.normalizeFacebookPostUrl(href);
        // reel/watch/videos khong mang vanity trong path nen _isOwnPostUrl khong xac thuc duoc,
        // nhung chung den tu timestamp cua dung bai (needle) nen chap nhan.
        const ownOrMedia = this._isOwnPostUrl(clean, own) || /\/(reel|watch|videos)\//.test(clean);
        if (clean && this.looksLikeFacebookPostUrl(clean) && ownOrMedia && !before.has(clean)) {
          return clean;
        }
      }
    }
    return '';
  }

  async getFacebookTimelineHref(page) {
    const href = await page.evaluate(() => {
      const pick = (a) => a && a.href && /^https:\/\/www\.facebook\.com\//.test(a.href) ? a.href : '';
      const direct = Array.from(document.querySelectorAll('a[role="link"][aria-label*="DÃƒÂ²ng thÃ¡Â»Âi gian"]'))[0];
      if (pick(direct)) return direct.href;
      const imgLink = Array.from(document.querySelectorAll('a[role="link"][href*="facebook.com/"]')).find(a => a.querySelector('image, img, svg'));
      return pick(imgLink);
    }).catch(() => '');
    return this.normalizeFacebookPostUrl(href, true);
  }

  normalizeFacebookPostUrl(href, keepProfile = false) {
    if (!href) return '';
    try {
      const u = new URL(href, 'https://www.facebook.com');
      const host = u.hostname.replace(/^(www|m|mbasic|touch|web)\./, '');
      if (host !== 'facebook.com') return '';
      u.protocol = 'https:';
      u.hostname = 'www.facebook.com';
      const dropExact = new Set(['__tn__', 'comment_id', 'refid', 'ref', '_rdr', 'eav', 'sfnsn', 'mibextid', 'paipv', 'rdid', 'notif_t', 'notif_id', 'idorvanity']);
      for (const key of Array.from(u.searchParams.keys())) {
        if (key.startsWith('__cft__') || dropExact.has(key)) u.searchParams.delete(key);
      }
      if (!keepProfile && !this.looksLikeFacebookPostUrl(u.toString())) return '';
      return u.toString();
    } catch { return ''; }
  }

  looksLikeFacebookPostUrl(href) {
    // Bao gom ca video/reel/watch (FB thuong dang video ngan thanh Reel -> permalink dang /reel/<id>).
    return /\/posts\/|\/permalink\/|\/photo(?:\.php|s\/)|\/videos\/|\/reel\/|\/watch\/|story_fbid=|fbid=|multi_permalinks=/.test(String(href || ''));
  }

  async prepareTimelineForScan(page) {
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      await this._sleep(1200);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this._sleep(1500);
  }

  async scanTimelinePostLinks(page, limit = 20) {
    await this.prepareTimelineForScan(page);
    const raw = await page.evaluate((limit) => {
      const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, limit);
      const fromArticles = articles.flatMap((article, articleIndex) => {
        const text = article.innerText || '';
        return Array.from(article.querySelectorAll('a[href]')).map(a => ({ articleIndex, text, href: a.href }));
      });
      const global = Array.from(document.querySelectorAll('a[href]'))
        .map((a, i) => ({ articleIndex: 1000 + i, text: a.innerText || a.getAttribute('aria-label') || '', href: a.href }));
      return fromArticles.concat(global).slice(0, 800);
    }, limit).catch(() => []);
    return [...new Set(raw.map(x => this.normalizeFacebookPostUrl(x.href)).filter(h => h && this.looksLikeFacebookPostUrl(h)))];
  }


  async scanTopOwnPostLinks(page, profileHref, owner = null, limit = 3) {
    await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await this._sleep(3500);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await this._sleep(1000);
    return await this._extractTopOwnPostLinks(page, owner, limit);
  }

  async captureNewTopOwnPostLink(page, profileHref, beforeLinks, owner = null, limit = 3) {
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this._sleep(1000);
      const after = await this._extractTopOwnPostLinks(page, owner, limit);
      const found = after.find(h => !before.has(h));
      try {
        fs.writeFileSync(path.join(__dirname, '..', '..', 'capture-debug-top3.json'), JSON.stringify({
          attempt, owner, profileHref, before: [...before], after, found
        }, null, 2));
      } catch (e) {}
      if (found) return found;
    }
    return '';
  }

  async _extractTopOwnPostLinks(page, owner = null, limit = 3) {
    const raw = await page.evaluate((limit, owner) => {
      const vanity = owner && owner.vanity ? String(owner.vanity).toLowerCase() : '';
      const id = owner && owner.id ? String(owner.id) : '';
      const isPost = (href) => {
        const s = String(href || '');
        if (!/\/posts\/|\/permalink\/|story_fbid=|multi_permalinks=/.test(s)) return false;
        try {
          const u = new URL(s, location.href);
          const first = decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
          if (vanity && first === vanity && /\/posts\//.test(u.pathname)) return true;
          if (id && u.searchParams.get('id') === id) return true;
          if (id && first === id) return true;
          return !vanity && !id;
        } catch (_) { return false; }
      };
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a, i) => {
          const r = a.getBoundingClientRect();
          const article = a.closest('[role="article"]');
          return { i, top: Math.round(r.top), left: Math.round(r.left), href: a.href, text: ((article && article.innerText) || a.innerText || a.getAttribute('aria-label') || '').slice(0, 300) };
        })
        .filter(x => isPost(x.href))
        .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.i - b.i))
        .slice(0, Math.max(limit * 5, 30));
    }, limit, owner || {}).catch(() => []);
    const seen = new Set();
    const links = [];
    for (const x of raw) {
      const clean = this.normalizeFacebookPostUrl(x.href);
      if (!clean || !/\/posts\/|permalink|story_fbid=/.test(clean)) continue;
      if (!this._isOwnPostUrl(clean, owner)) continue;
      if (seen.has(clean)) continue;
      seen.add(clean);
      links.push(clean);
      if (links.length >= limit) break;
    }
    return links;
  }

  async captureNewTimelinePostLink(page, profileHref, beforeLinks, content = '', owner = null) {
    const before = beforeLinks instanceof Set ? beforeLinks : new Set(beforeLinks || []);
    const needle = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const isGoodPost = (h) => /\/posts\/|permalink|story_fbid=/.test(h);
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await this._sleep(3500 + attempt * 1200);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await this._sleep(800);
      // BÃƒÂ i mÃ¡Â»â€ºi thÃ†Â°Ã¡Â»Âng khÃƒÂ´ng nÃ¡ÂºÂ±m trong [role=article] -> tÃƒÂ¬m permalink ngay quanh vÃƒÂ¹ng text bÃƒÂ i mÃ¡Â»â€ºi
      const nearLink = await this._captureNewPostNearText(page, needle, before, owner);
      if (nearLink) return nearLink;
      await this.prepareTimelineForScan(page);
      const scan = await page.evaluate((limit, needle) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ');
        const articles = Array.from(document.querySelectorAll('[role="article"]')).slice(0, limit);
        const fromArticles = articles.flatMap((article, articleIndex) => {
          const text = article.innerText || '';
          return Array.from(article.querySelectorAll('a[href]')).map(a => ({ articleIndex, text: text.slice(0, 1200), href: a.href }));
        });
        const global = Array.from(document.querySelectorAll('a[href]'))
          .map((a, i) => ({ articleIndex: 1000 + i, text: (a.innerText || a.getAttribute('aria-label') || '').slice(0, 1200), href: a.href }));
        const needleArt = needle ? articles.find(a => norm(a.innerText).includes(needle)) : null;
        let needleHrefs = [];
        if (needle) {
          const els = Array.from(document.querySelectorAll('div,span,article,section,li'));
          let node = null;
          for (const e of els) { if (norm(e.innerText).includes(needle) && e.children.length < 30) node = e; }
          let cur = node, hops = 0;
          while (cur && hops < 12) {
            const hs = Array.from(cur.querySelectorAll('a[href]')).map(a => a.href);
            if (hs.some(h => /\/posts\/|permalink|story_fbid=|photo|fbid=/.test(h))) { needleHrefs = [...new Set(hs)].slice(0, 40); break; }
            cur = cur.parentElement; hops++;
          }
        }
        return {
          links: fromArticles.concat(global).slice(0, 800),
          needleFound: !!needleArt,
          bodyHasNeedle: needle ? norm(document.body.innerText).includes(needle) : false,
          articleCount: articles.length,
          needleHrefs
        };
      }, 20, needle).catch(() => ({ links: [], needleFound: false, bodyHasNeedle: false, articleCount: 0, needleHrefs: [] }));
      const raw = scan.links || [];
      const normed = raw.map(x => ({ ...x, href: this.normalizeFacebookPostUrl(x.href) }))
        .filter(x => x.href && this.looksLikeFacebookPostUrl(x.href));
      const picked = normed
        .filter(x => !before.has(x.href) && this._isOwnPostUrl(x.href, owner))
        .map(x => ({ ...x, score: (needle && x.text.includes(needle) ? 100 : 0) + (20 - Math.min(x.articleIndex, 20)) + (/\/posts\//.test(x.href) ? 5 : 0) }))
        .sort((a,b)=>b.score-a.score)[0];
      try {
        fs.writeFileSync(path.join(__dirname, '..', '..', 'capture-debug-desktop.json'), JSON.stringify({
          attempt, profileHref, pageUrl: page.url(), owner, needle, beforeSize: before.size,
          needleFound: scan.needleFound, bodyHasNeedle: scan.bodyHasNeedle, articleCount: scan.articleCount,
          needleHrefs: scan.needleHrefs,
          ownAll: [...new Set(normed.filter(x => this._isOwnPostUrl(x.href, owner)).map(x => x.href))].slice(0, 15),
          ownNew: [...new Set(normed.filter(x => !before.has(x.href) && this._isOwnPostUrl(x.href, owner)).map(x => x.href))].slice(0, 15),
          picked: picked ? { href: picked.href, score: picked.score } : null
        }, null, 2));
      } catch (e) {}
      if (picked && picked.href && picked.score > 0 && /\/posts\/|permalink|story_fbid=/.test(picked.href)) return picked.href;
    }
    return '';
  }

  // LÃ¡ÂºÂ¥y danh tÃƒÂ­nh chÃ¡Â»Â§ account Ã„â€˜ang Ã„â€˜Ã„Æ’ng: vanity (username) + numeric id (tÃ¡Â»Â« cookie c_user)
  async getProfileOwner(page, profileHref) {
    let vanity = null, id = null;
    try {
      const u = new URL(profileHref, 'https://www.facebook.com');
      const segs = u.pathname.split('/').filter(Boolean);
      if (/^profile\.php$/i.test(segs[0] || '')) {
        id = u.searchParams.get('id') || null;
      } else if (segs[0] && !/^(people|pages|groups|watch|story\.php|permalink\.php|photo\.php)$/i.test(segs[0])) {
        vanity = decodeURIComponent(segs[0]);
      }
    } catch (_) {}
    try {
      const cookies = await page.cookies('https://www.facebook.com');
      const c = cookies.find(x => x.name === 'c_user');
      if (c && c.value) id = c.value;
    } catch (_) {}
    return { vanity, id };
  }

  // Ã„ÂÃ¡Â»Âc danh tÃƒÂ­nh chÃ¡Â»Â§ trang tÃ¡Â»Â« chÃƒÂ­nh trang profile Ã„â€˜ang mÃ¡Â»Å¸ (canonical/og:url) Ã„â€˜Ã¡Â»Æ’ lÃ¡ÂºÂ¥y Ã„â€˜Ã†Â°Ã¡Â»Â£c vanity khi profileHref lÃƒÂ  dÃ¡ÂºÂ¡ng sÃ¡Â»â€˜
  async _readOwnerFromPage(page) {
    return await page.evaluate(() => {
      const out = { vanity: null, id: null };
      const can = document.querySelector('link[rel="canonical"]');
      const og = document.querySelector('meta[property="og:url"]');
      const url = (can && can.href) || (og && og.content) || '';
      try {
        const u = new URL(url);
        const segs = u.pathname.split('/').filter(Boolean);
        if (/^profile\.php$/i.test(segs[0] || '')) out.id = u.searchParams.get('id');
        else if (segs[0] && !/^(people|pages|groups|watch|story\.php|permalink\.php|photo\.php)$/i.test(segs[0])) out.vanity = decodeURIComponent(segs[0]);
      } catch (e) {}
      try {
        const html = document.documentElement.innerHTML;
        const m = html.match(/"userID":"(\d+)"/) || html.match(/"entity_id":"(\d+)"/) || html.match(/"owner_id":"(\d+)"/);
        if (m && !out.id) out.id = m[1];
      } catch (e) {}
      return out;
    }).catch(() => ({ vanity: null, id: null }));
  }

  _mergeOwner(a, b) {
    a = a || {}; b = b || {};
    return { vanity: a.vanity || b.vanity || null, id: a.id || b.id || null };
  }

  // LÃ¡ÂºÂ¥y nhanh vanity/id chÃ¡Â»Â§ account tÃ¡Â»Â« canonical cÃ¡Â»Â§a trang mobile (khÃƒÂ´ng quÃƒÂ©t bÃƒÂ i) Ã¢â‚¬â€ mobile trÃ¡ÂºÂ£ canonical Ã¡Â»â€¢n Ã„â€˜Ã¡Â»â€¹nh hÃ†Â¡n desktop

  // Link cÃƒÂ³ thuÃ¡Â»â„¢c Ã„â€˜ÃƒÂºng account Ã„â€˜ang Ã„â€˜Ã„Æ’ng khÃƒÂ´ng (chÃ¡Â»â€˜ng lÃ¡ÂºÂ¥y nhÃ¡ÂºÂ§m bÃƒÂ i ngÃ†Â°Ã¡Â»Âi khÃƒÂ¡c trÃƒÂªn timeline)
  _isOwnPostUrl(href, owner) {
    if (!owner || (!owner.vanity && !owner.id)) return true;
    try {
      const u = new URL(href, 'https://www.facebook.com');
      const idParam = u.searchParams.get('id');
      if (owner.id && idParam && String(idParam) === String(owner.id)) return true;
      // Ã¡ÂºÂ¢nh: owner id nÃ¡ÂºÂ±m trong set=pb.<id>.- hoÃ¡ÂºÂ·c set=a....<id>
      const setParam = u.searchParams.get('set') || '';
      if (owner.id && new RegExp('(?:^|[.:])' + owner.id + '(?:[.:]|$)').test(setParam)) return true;
      const segs = u.pathname.split('/').filter(Boolean);
      const first = segs[0] ? decodeURIComponent(segs[0]).toLowerCase() : '';
      if (owner.vanity && first === String(owner.vanity).toLowerCase()) return true;
      if (owner.id && first === String(owner.id)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  // TÃƒÂ¬m permalink cÃ¡Â»Â§a bÃƒÂ i vÃ¡Â»Â«a Ã„â€˜Ã„Æ’ng bÃ¡ÂºÂ±ng cÃƒÂ¡ch leo DOM tÃ¡Â»Â« chÃƒÂ­nh Ã„â€˜oÃ¡ÂºÂ¡n text nÃ¡Â»â„¢i dung (khÃƒÂ´ng phÃ¡Â»Â¥ thuÃ¡Â»â„¢c [role=article])
  async _captureNewPostNearText(page, needle, before, owner) {
    if (!needle) return '';
    const pick = (href) => {
      const clean = this.normalizeFacebookPostUrl(href);
      if (clean && !before.has(clean) && this._isOwnPostUrl(clean, owner) && /\/posts\/|permalink|story_fbid=/.test(clean)) return clean;
      return '';
    };
    try {
      const containerHandle = await page.evaluateHandle((needle) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ');
        const els = Array.from(document.querySelectorAll('div,span,article,section,li'));
        let node = null;
        for (const e of els) { if (norm(e.innerText).includes(needle) && e.children.length < 30) node = e; }
        if (!node) return null;
        let cur = node, hops = 0;
        while (cur && hops < 12) {
          const has = Array.from(cur.querySelectorAll('a[href]')).some(a => /\/posts\/|permalink|story_fbid=|photo|fbid=/.test(a.href));
          if (has) return cur;
          cur = cur.parentElement; hops++;
        }
        return node;
      }, needle);
      const el = containerHandle && containerHandle.asElement ? containerHandle.asElement() : null;
      if (!el) return '';
      const anchors = await el.$$('a[href]');
      // VÃƒÂ²ng 1: dÃƒÂ¹ng href sÃ¡ÂºÂµn cÃƒÂ³
      for (const a of anchors) {
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
      // VÃƒÂ²ng 2: hover Ã„â€˜Ã¡Â»Æ’ Facebook gÃ¡ÂºÂ¯n permalink
      for (const a of anchors.slice(0, 20)) {
        try { await a.hover(); } catch (_) {}
        await this._sleep(400);
        const href = await page.evaluate(n => n.href, a).catch(() => '');
        const got = pick(href); if (got) return got;
      }
    } catch (_) {}
    return '';
  }

  // Hover cÃƒÂ¡c link trong bÃƒÂ i khÃ¡Â»â€ºp nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Æ’ Facebook lÃ¡Â»â„¢ permalink timestamp, rÃ¡Â»â€œi lÃ¡ÂºÂ¥y link bÃƒÂ i cÃ¡Â»Â§a Ã„â€˜ÃƒÂºng chÃ¡Â»Â§ account
  async _hoverRevealPostLink(page, needle, before, owner) {
    try {
      const artHandle = await page.evaluateHandle((needle) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ');
        const arts = Array.from(document.querySelectorAll('[role="article"]'));
        if (needle) { const m = arts.find(a => norm(a.innerText).includes(needle)); if (m) return m; }
        return arts[0] || null;
      }, needle);
      const artEl = artHandle && artHandle.asElement ? artHandle.asElement() : null;
      if (!artEl) return '';
      const anchors = await artEl.$$('a[role="link"], a[href]');
      for (const a of anchors.slice(0, 14)) {
        try { await a.hover(); } catch (_) {}
        await this._sleep(500);
        const href = await page.evaluate(el => el.href, a).catch(() => '');
        const clean = this.normalizeFacebookPostUrl(href);
        if (clean && this.looksLikeFacebookPostUrl(clean) && !before.has(clean)
          && this._isOwnPostUrl(clean, owner) && /\/posts\/|permalink|story_fbid=/.test(clean)) {
          return clean;
        }
      }
    } catch (_) {}
    return '';
  }

  /**
   * Stop the runner gracefully
   */
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
    return {
      isRunning: this.isRunning,
      progress: { ...this.progress },
      shouldStop: this.shouldStop
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
      type: type
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

// Export singleton instance
module.exports = new RunnerService();




