'use strict';

const { EventEmitter } = require('events');
const db = require('../database/init');

const emitter = new EventEmitter();
const TERMINAL_EVENT_TYPES = new Set([
  'job.success',
  'job.error',
  'job.cancelled',
]);

let initialized = false;
let watcher = null;
let cursor = 0;

function ensureSchema() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      job_id TEXT,
      batch_id TEXT,
      platform TEXT,
      profile_name TEXT,
      post_id INTEGER,
      status TEXT,
      error TEXT,
      payload_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_agent_job_events_job ON agent_job_events(job_id, event_id)'
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_agent_job_events_batch ON agent_job_events(batch_id, event_id)'
  ).run();
  db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_agent_job_events_created ON agent_job_events(event_id)'
  ).run();

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS agent_jobs_event_insert_v1
    AFTER INSERT ON agent_jobs
    BEGIN
      INSERT INTO agent_job_events (
        event_type, job_id, batch_id, platform, profile_name, post_id,
        status, error, created_at
      ) VALUES (
        'job.queued', NEW.job_id, NEW.batch_id, NEW.platform, NEW.profile_name,
        NEW.post_id, NEW.status, NEW.error, CURRENT_TIMESTAMP
      );
    END;

    CREATE TRIGGER IF NOT EXISTS agent_jobs_event_status_v1
    AFTER UPDATE OF status ON agent_jobs
    WHEN OLD.status <> NEW.status
    BEGIN
      INSERT INTO agent_job_events (
        event_type, job_id, batch_id, platform, profile_name, post_id,
        status, error, created_at
      ) VALUES (
        CASE NEW.status
          WHEN 'queued' THEN 'job.queued'
          WHEN 'running' THEN 'job.running'
          WHEN 'success' THEN 'job.success'
          WHEN 'error' THEN 'job.error'
          WHEN 'cancelled' THEN 'job.cancelled'
          ELSE 'job.progress'
        END,
        NEW.job_id, NEW.batch_id, NEW.platform, NEW.profile_name, NEW.post_id,
        NEW.status, NEW.error, CURRENT_TIMESTAMP
      );
    END;
  `);
}

function parsePayload(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function publicEvent(row) {
  return {
    event_id: Number(row.event_id),
    type: row.event_type,
    job_id: row.job_id || null,
    batch_id: row.batch_id || null,
    platform: row.platform || null,
    profile: row.profile_name || null,
    post_id: row.post_id == null ? null : Number(row.post_id),
    status: row.status || null,
    error: row.error || null,
    payload: parsePayload(row.payload_json),
    created_at: row.created_at,
    terminal: TERMINAL_EVENT_TYPES.has(row.event_type),
  };
}

function latestEventId() {
  if (!initialized) ensureSchema();
  const row = db.prepare('SELECT MAX(event_id) AS event_id FROM agent_job_events').get();
  return Number(row && row.event_id) || 0;
}

function poll() {
  const rows = db.prepare(`
    SELECT * FROM agent_job_events
    WHERE event_id > ?
    ORDER BY event_id ASC
    LIMIT 500
  `).all(cursor);
  for (const row of rows) {
    cursor = Math.max(cursor, Number(row.event_id) || 0);
    emitter.emit('event', publicEvent(row));
  }
}

function init() {
  if (initialized) return;
  ensureSchema();
  initialized = true;
  cursor = latestEventId();
  db.prepare(`
    DELETE FROM agent_job_events
    WHERE event_id <= (
      SELECT CASE WHEN MAX(event_id) > 5000 THEN MAX(event_id) - 5000 ELSE 0 END
      FROM agent_job_events
    )
  `).run();
}

function stop() {
  if (watcher) clearInterval(watcher);
  watcher = null;
  initialized = false;
  emitter.removeAllListeners('event');
}

function record(eventType, data = {}) {
  if (!initialized) init();
  const payload = data.payload === undefined ? null : JSON.stringify(data.payload);
  const result = db.prepare(`
    INSERT INTO agent_job_events (
      event_type, job_id, batch_id, platform, profile_name, post_id,
      status, error, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    String(eventType || 'job.progress'),
    data.job_id || null,
    data.batch_id || null,
    data.platform || null,
    data.profile || data.profile_name || null,
    data.post_id == null ? null : Number(data.post_id),
    data.status || null,
    data.error || null,
    payload
  );
  const row = db.prepare('SELECT * FROM agent_job_events WHERE event_id = ?')
    .get(result.lastInsertRowid);
  poll();
  return publicEvent(row);
}

function list(options = {}) {
  if (!initialized) init();
  const afterEventId = Math.max(0, Number(
    options.after_event_id ?? options.afterEventId ?? 0
  ) || 0);
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 100));
  const clauses = ['event_id > ?'];
  const params = [afterEventId];
  if (options.job_id) {
    clauses.push('job_id = ?');
    params.push(String(options.job_id));
  }
  if (options.batch_id) {
    clauses.push('batch_id = ?');
    params.push(String(options.batch_id));
  }
  if (options.platform) {
    clauses.push('platform = ?');
    params.push(String(options.platform).toLowerCase());
  }
  const rows = db.prepare(`
    SELECT * FROM agent_job_events
    WHERE ${clauses.join(' AND ')}
    ORDER BY event_id ASC
    LIMIT ?
  `).all(...params, limit);
  const events = rows.map(publicEvent);
  return {
    events,
    count: events.length,
    after_event_id: afterEventId,
    last_event_id: events.length ? events[events.length - 1].event_id : afterEventId,
  };
}

async function wait(options = {}) {
  const seconds = Math.min(300, Math.max(0, Number(options.wait_seconds) || 30));
  const deadline = Date.now() + (seconds * 1000);
  let result = list(options);
  while (!result.events.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    result = list(options);
  }
  return {
    ...result,
    timed_out: result.events.length === 0,
  };
}

function status() {
  if (!initialized) init();
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM agent_jobs
  `).get() || {};
  const lastError = db.prepare(`
    SELECT * FROM agent_job_events
    WHERE event_type = 'job.error'
    ORDER BY event_id DESC
    LIMIT 1
  `).get();
  return {
    realtime: true,
    last_event_id: latestEventId(),
    queued_jobs: Number(counts.queued) || 0,
    running_jobs: Number(counts.running) || 0,
    last_error: lastError ? publicEvent(lastError) : null,
  };
}

function subscribe(listener) {
  if (!initialized) init();
  emitter.on('event', listener);
  if (!watcher) {
    watcher = setInterval(poll, 200);
    if (typeof watcher.unref === 'function') watcher.unref();
  }
  return () => emitter.off('event', listener);
}

module.exports = {
  init,
  stop,
  record,
  list,
  wait,
  status,
  subscribe,
  latestEventId,
  _private: { ensureSchema, publicEvent, poll },
};
