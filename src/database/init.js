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
        status      TEXT DEFAULT 'pending',
        note        TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
      auto_backup: '0',
    };

    for (const [key, value] of Object.entries(defaultSettings)) {
      this._db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
  }
}

// Create singleton instance
const db = new DatabaseWrapper();

module.exports = db;
