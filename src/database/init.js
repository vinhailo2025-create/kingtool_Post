/**
 * SQLite Database Initialization using sql.js
 * Provides a better-sqlite3-compatible API wrapper around sql.js
 * so all services work without modification.
 */
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('../../config');

// Turn a column name into a safe variable token (shared with client slugVar)
function slugKey(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'cot';
}

// Ensure database directory exists
const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// --------------------------------------------------
// Wrapper class: provides better-sqlite3-like API
// --------------------------------------------------
class DatabaseWrapper {
  constructor() {
    this._db = null;
    this._ready = false;
    this._inTransaction = false;
    this._initPromise = this._init();
  }

  async _init() {
    const SQL = await initSqlJs();

    // Load existing database or create new
    if (fs.existsSync(config.DB_PATH)) {
      const fileBuffer = fs.readFileSync(config.DB_PATH);
      this._db = new SQL.Database(fileBuffer);
    } else {
      this._db = new SQL.Database();
    }

    this._ready = true;
    this._createTables();
    this._save();
  }

  /** Ensure DB is ready (synchronous check, throws if not ready yet) */
  _ensureReady() {
    if (!this._ready) {
      throw new Error('Database not initialized yet. Await db.waitReady() first.');
    }
  }

  /** Wait for DB to be ready */
  async waitReady() {
    await this._initPromise;
  }

  // ---------- better-sqlite3-compatible API ----------

  /**
   * Execute raw SQL (multiple statements, no return value)
   */
  exec(sql) {
    this._ensureReady();
    this._db.run(sql);
    this._save();
  }

  /**
   * Pragma (simplified - handles common pragmas)
   */
  pragma(pragmaStr) {
    this._ensureReady();
    // sql.js doesn't support WAL or some pragmas, silently ignore
    try {
      const results = this._db.exec(`PRAGMA ${pragmaStr}`);
      if (results && results.length > 0) {
        return results[0].values;
      }
    } catch (e) {
      // ignore pragma errors
    }
    return undefined;
  }

  /**
   * Prepare a SQL statement - returns an object with run/get/all methods
   * Compatible with better-sqlite3's prepare() API
   */
  prepare(sql) {
    this._ensureReady();
    const self = this;

    return {
      /**
       * Run the statement (INSERT/UPDATE/DELETE)
       * Accepts named params (@name) as object or positional params as arguments
       */
      run(...args) {
        self._ensureReady();
        const params = self._normalizeParams(args);
        self._db.run(sql, params);

        const lastId = self._db.exec('SELECT last_insert_rowid() as id');
        const changes = self._db.exec('SELECT changes() as c');
        const result = {
          lastInsertRowid: lastId.length > 0 ? lastId[0].values[0][0] : 0,
          changes: changes.length > 0 ? changes[0].values[0][0] : 0,
        };

        if (!self._inTransaction) self._save();
        return result;
      },

      /**
       * Get a single row
       */
      get(...args) {
        self._ensureReady();
        const params = self._normalizeParams(args);
        const stmt = self._db.prepare(sql);
        stmt.bind(params);
        let row = undefined;
        if (stmt.step()) {
          row = stmt.getAsObject();
        }
        stmt.free();
        return row;
      },

      /**
       * Get all matching rows
       */
      all(...args) {
        self._ensureReady();
        const params = self._normalizeParams(args);
        const stmt = self._db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
      },
    };
  }

  /**
   * Create a transaction wrapper (like better-sqlite3's .transaction())
   */
  transaction(fn) {
    const self = this;
    return function (...args) {
      self._ensureReady();
      self._db.run('BEGIN TRANSACTION');
      self._inTransaction = true;
      try {
        const result = fn(...args);
        self._inTransaction = false;
        self._db.run('COMMIT');
        self._save();
        return result;
      } catch (err) {
        self._inTransaction = false;
        try {
          self._db.run('ROLLBACK');
        } catch (rollbackErr) {}
        throw err;
      }
    };
  }

  /**
   * Close the database
   */
  close() {
    if (this._db) {
      this._save();
      this._db.close();
      this._ready = false;
    }
  }

  // ---------- Internal helpers ----------

  /**
   * Normalize parameters for sql.js binding
   * better-sqlite3 uses: stmt.run(val1, val2) or stmt.run({ @key: val })
   * sql.js uses: stmt.bind([val1, val2]) or stmt.bind({ $key: val, :key: val })
   */
  _normalizeParams(args) {
    if (args.length === 0) return [];

    // Single object argument = named parameters
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
      const obj = args[0];
      const result = {};
      for (const [key, value] of Object.entries(obj)) {
        // sql.js uses $key or :key or @key syntax
        const paramKey = key.startsWith('@') || key.startsWith('$') || key.startsWith(':')
          ? key
          : `@${key}`;
        // sql.js doesn't handle boolean, convert to int
        if (typeof value === 'boolean') {
          result[paramKey] = value ? 1 : 0;
        } else if (value === undefined) {
          result[paramKey] = null;
        } else {
          result[paramKey] = value;
        }
      }
      return result;
    }

    // Multiple arguments = positional parameters
    // sql.js wants an array for positional binding
    return args.map(v => {
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v === undefined) return null;
      return v;
    });
  }

  /**
   * Save database to disk
   */
  _save() {
    if (!this._db) return;
    try {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(config.DB_PATH, buffer);
    } catch (e) {
      console.error('Error saving database:', e.message);
    }
  }

  /**
   * Create all tables
   */
  _createTables() {
    this._db.run(`
      CREATE TABLE IF NOT EXISTS posts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order  INTEGER,
        content     TEXT,
        image_path  TEXT,
        link        TEXT,
        target      TEXT,
        product_id  TEXT,
        status      TEXT DEFAULT 'pending',
        note        TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { this._db.run("ALTER TABLE posts ADD COLUMN platform TEXT DEFAULT 'facebook'"); } catch (e) {}
    try { this._db.run("ALTER TABLE posts ADD COLUMN product_id TEXT DEFAULT ''"); } catch (e) {}
    // Stable identity shared by equivalent rows on different platforms.
    // It is intentionally hidden from the grid and only managed by data sync.
    try { this._db.run('ALTER TABLE posts ADD COLUMN sync_key TEXT'); } catch (e) {}
    this._db.run("UPDATE posts SET platform = 'facebook' WHERE platform IS NULL OR platform = ''");
    this._db.run('CREATE INDEX IF NOT EXISTS idx_posts_platform ON posts(platform, sort_order, id)');
    this._db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_platform_sync_key ON posts(platform, sync_key) WHERE sync_key IS NOT NULL AND sync_key <> ''");

    this._db.run(`
      CREATE TABLE IF NOT EXISTS browsers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        profile_dir   TEXT NOT NULL UNIQUE,
        proxy_type    TEXT DEFAULT 'none',
        proxy_host    TEXT,
        proxy_port    INTEGER,
        proxy_user    TEXT,
        proxy_pass    TEXT,
        status        TEXT DEFAULT 'closed',
        session_valid INTEGER DEFAULT 0,
        note          TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Browser-provider metadata. Existing rows stay native Chrome profiles.
    // External user-data directories belong to their provider and are never
    // copied/deleted by CovergemAuto.
    try { this._db.run("ALTER TABLE browsers ADD COLUMN provider TEXT DEFAULT 'chrome'"); } catch (e) {}
    try { this._db.run('ALTER TABLE browsers ADD COLUMN provider_profile_id TEXT'); } catch (e) {}
    try { this._db.run("ALTER TABLE browsers ADD COLUMN connection_mode TEXT DEFAULT 'managed'"); } catch (e) {}
    try { this._db.run('ALTER TABLE browsers ADD COLUMN external_user_data_dir TEXT'); } catch (e) {}
    try { this._db.run('ALTER TABLE browsers ADD COLUMN external_executable_path TEXT'); } catch (e) {}
    try { this._db.run('ALTER TABLE browsers ADD COLUMN external_launch_args TEXT'); } catch (e) {}
    try { this._db.run('ALTER TABLE browsers ADD COLUMN external_extension_path TEXT'); } catch (e) {}
    try { this._db.run('ALTER TABLE browsers ADD COLUMN provider_endpoint TEXT'); } catch (e) {}
    try { this._db.run('ALTER TABLE browsers ADD COLUMN provider_metadata TEXT'); } catch (e) {}
    this._db.run("UPDATE browsers SET provider = 'chrome' WHERE provider IS NULL OR provider = ''");
    this._db.run("UPDATE browsers SET connection_mode = CASE WHEN provider = 'chrome' THEN 'managed' ELSE 'direct' END WHERE connection_mode IS NULL OR connection_mode = ''");
    this._db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_browsers_provider_profile ON browsers(provider, provider_profile_id) WHERE provider_profile_id IS NOT NULL AND provider_profile_id <> ''");

    // One physical Chrome profile may be assigned to Facebook, TikTok, or
    // both. The physical profile remains in browsers; this table only controls
    // which workspace can use it and stores platform-specific session state.
    this._db.run(`
      CREATE TABLE IF NOT EXISTS browser_platforms (
        browser_id        INTEGER NOT NULL,
        platform          TEXT NOT NULL,
        session_valid     INTEGER DEFAULT 0,
        enabled           INTEGER DEFAULT 1,
        last_session_check DATETIME,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (browser_id, platform)
      )
    `);
    this._db.run(`
      INSERT OR IGNORE INTO browser_platforms (browser_id, platform, session_valid, enabled)
      SELECT b.id, 'facebook', COALESCE(b.session_valid, 0), 1
      FROM browsers b
      WHERE NOT EXISTS (
        SELECT 1 FROM browser_platforms bp WHERE bp.browser_id = b.id
      )
    `);
    this._db.run('CREATE INDEX IF NOT EXISTS idx_browser_platforms_platform ON browser_platforms(platform, enabled, browser_id)');

    this._db.run(`
      CREATE TABLE IF NOT EXISTS schedules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT,
        schedule_time TEXT,
        schedule_type TEXT DEFAULT 'once',
        cron_expr     TEXT,
        profile_ids   TEXT,
        data_ids      TEXT,
        concurrency   INTEGER DEFAULT 1,
        delay_min     INTEGER DEFAULT 30,
        delay_max     INTEGER DEFAULT 90,
        enabled       INTEGER DEFAULT 1,
        last_run      DATETIME,
        status        TEXT DEFAULT 'waiting',
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { this._db.run("ALTER TABLE schedules ADD COLUMN platform TEXT DEFAULT 'facebook'"); } catch (e) {}
    this._db.run("UPDATE schedules SET platform = 'facebook' WHERE platform IS NULL OR platform = ''");
    this._db.run('CREATE INDEX IF NOT EXISTS idx_schedules_platform ON schedules(platform, enabled, id)');

    this._db.run(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT,
        profile_id  INTEGER,
        post_id     INTEGER,
        message     TEXT,
        status      TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { this._db.run("ALTER TABLE activity_logs ADD COLUMN platform TEXT DEFAULT 'facebook'"); } catch (e) {}
    this._db.run("UPDATE activity_logs SET platform = 'facebook' WHERE platform IS NULL OR platform = ''");
    this._db.run('CREATE INDEX IF NOT EXISTS idx_activity_platform ON activity_logs(platform, created_at)');

    // Durable queue for comments scheduled after a post is published.
    // due_at is stored as Unix milliseconds so overdue jobs can be restored
    // without timezone ambiguity after the desktop tool restarts.
    this._db.run(`
      CREATE TABLE IF NOT EXISTS comment_jobs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id       INTEGER NOT NULL,
        profile_id    INTEGER NOT NULL,
        post_link     TEXT NOT NULL,
        comment_text  TEXT,
        media_path    TEXT,
        due_at        INTEGER NOT NULL,
        status        TEXT DEFAULT 'waiting',
        attempts      INTEGER DEFAULT 0,
        last_error    TEXT,
        started_at    DATETIME,
        completed_at  DATETIME,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { this._db.run("ALTER TABLE comment_jobs ADD COLUMN platform TEXT DEFAULT 'facebook'"); } catch (e) {}
    this._db.run("UPDATE comment_jobs SET platform = 'facebook' WHERE platform IS NULL OR platform = ''");
    this._db.run('CREATE INDEX IF NOT EXISTS idx_comment_jobs_due ON comment_jobs(status, due_at, id)');
    this._db.run('CREATE INDEX IF NOT EXISTS idx_comment_jobs_profile ON comment_jobs(profile_id, status, due_at)');
    this._db.run('CREATE INDEX IF NOT EXISTS idx_comment_jobs_platform ON comment_jobs(platform, status, due_at, id)');

    // Custom columns (user-defined dynamic columns)
    this._db.run(`
      CREATE TABLE IF NOT EXISTS custom_columns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        col_type    TEXT DEFAULT 'text',
        var_key     TEXT,
        sort_order  INTEGER DEFAULT 0,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try { this._db.run("ALTER TABLE custom_columns ADD COLUMN platform TEXT DEFAULT 'facebook'"); } catch (e) {}
    this._db.run("UPDATE custom_columns SET platform = 'facebook' WHERE platform IS NULL OR platform = ''");
    this._db.run('CREATE INDEX IF NOT EXISTS idx_custom_columns_platform ON custom_columns(platform, sort_order, id)');

    // Migration: add var_key to older databases, then backfill from name slug
    try { this._db.run('ALTER TABLE custom_columns ADD COLUMN var_key TEXT'); } catch (e) { /* already exists */ }
    try {
      const res = this._db.exec("SELECT id, name FROM custom_columns WHERE var_key IS NULL OR var_key = ''");
      if (res && res.length > 0) {
        for (const row of res[0].values) {
          const id = row[0];
          const key = slugKey(String(row[1] || ''));
          this._db.run('UPDATE custom_columns SET var_key = ? WHERE id = ?', [key, id]);
        }
      }
    } catch (e) { /* ignore backfill errors */ }

    // Custom column data (stores values for dynamic columns per post)
    this._db.run(`
      CREATE TABLE IF NOT EXISTS post_custom_data (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id     INTEGER NOT NULL,
        column_id   INTEGER NOT NULL,
        value       TEXT,
        UNIQUE(post_id, column_id)
      )
    `);

    // Per-column synchronization rules. One source column can fan out to
    // several platforms; each direction is explicit to prevent sync loops.
    this._db.run(`
      CREATE TABLE IF NOT EXISTS data_sync_rules (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source_platform   TEXT NOT NULL,
        source_var_key    TEXT NOT NULL,
        target_platform   TEXT NOT NULL,
        target_var_key    TEXT NOT NULL,
        conflict_policy   TEXT DEFAULT 'fill_empty',
        create_missing    INTEGER DEFAULT 1,
        enabled           INTEGER DEFAULT 1,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_platform, source_var_key, target_platform, target_var_key)
      )
    `);
    this._db.run('CREATE INDEX IF NOT EXISTS idx_data_sync_rules_source ON data_sync_rules(source_platform, source_var_key, enabled)');

    // Every manual/automatic execution is auditable and can be undone.
    this._db.run(`
      CREATE TABLE IF NOT EXISTS data_sync_runs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        mode              TEXT DEFAULT 'manual',
        source_platform   TEXT NOT NULL,
        source_var_key    TEXT NOT NULL,
        status            TEXT DEFAULT 'running',
        summary_json      TEXT,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at      DATETIME,
        undone_at         DATETIME
      )
    `);
    this._db.run(`
      CREATE TABLE IF NOT EXISTS data_sync_run_items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            INTEGER NOT NULL,
        source_post_id    INTEGER NOT NULL,
        target_post_id    INTEGER NOT NULL,
        target_platform   TEXT NOT NULL,
        target_var_key    TEXT NOT NULL,
        target_column_id  INTEGER,
        old_value         TEXT,
        new_value         TEXT,
        created_post      INTEGER DEFAULT 0,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this._db.run('CREATE INDEX IF NOT EXISTS idx_data_sync_run_items_run ON data_sync_run_items(run_id, id)');

    this._db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Insert default settings
    const defaultSettings = {
      chrome_path: '',
      max_concurrency: '5',
      default_delay_min: '30',
      default_delay_max: '90',
      default_profile_delay_min: '10',
      default_profile_delay_max: '30',
      browser_per_screen: '1',
      browser_layout_rows: '2',
      browser_layout_columns: '4',
      browser_window_ratio: '1',
      profile_open_delay_ms: '0',
      browser_launch_retry_count: '0',
      auto_backup: '0',
      auto_comment_enabled: '0',
      comment_delay_unit: 'sec',
      comment_delay_min: '30',
      comment_delay_max: '60',
      gologin_profiles_dir: '',
      gologin_executable_path: '',
      gemlogin_profiles_dir: '',
      gemlogin_executable_path: '',
      gemlogin_extension_path: '',
      gemlogin_api_url: 'http://127.0.0.1:1010/api',
      gpm_api_url: 'http://127.0.0.1:9495/api/v1',
      genlogin_api_url: 'http://127.0.0.1:55550/backend/profiles',
      genlogin_token: '',
    };

    for (const [key, value] of Object.entries(defaultSettings)) {
      this._db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }
}

// Create singleton instance
const db = new DatabaseWrapper();

module.exports = db;
