const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../database/init');
const config = require('../../config');
const BrowserService = require('./browser.service');
const DataService = require('./data.service');
const RunnerManager = require('./runner-manager.service');
const LicenseService = require('./license.service');
const CommentColumns = require('./comment-columns.service');
const ManagedTargetsService = require('./managed-targets.service');
const AgentEvents = require('./agent-event.service');
const { PLATFORMS, scopedSettingKey } = require('../platforms/platform.utils');

const TERMINAL = new Set(['success', 'error', 'cancelled']);
const timers = new Map();
const activePumps = new Set();
let initialized = false;
let shuttingDown = false;

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureSchema() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      request_id TEXT UNIQUE,
      batch_id TEXT,
      platform TEXT NOT NULL,
      profile_id INTEGER NOT NULL,
      profile_name TEXT NOT NULL,
      post_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      payload_json TEXT,
      result_json TEXT,
      error TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  try { db.exec('ALTER TABLE agent_jobs ADD COLUMN batch_id TEXT'); } catch (_) {}
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_jobs_queue ON agent_jobs(platform, status, id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_jobs_post ON agent_jobs(platform, post_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_jobs_batch ON agent_jobs(batch_id, id)').run();
}

function init() {
  if (initialized) return;
  ensureSchema();
  AgentEvents.init();
  initialized = true;
  shuttingDown = false;

  // A process restart cannot preserve an in-flight browser action. Requeue it
  // only when the post did not already reach a terminal state.
  const interrupted = db.prepare(`
    SELECT j.job_id, j.post_id, j.platform, p.status AS post_status
    FROM agent_jobs j
    LEFT JOIN posts p ON p.id = j.post_id AND p.platform = j.platform
    WHERE j.status = 'running'
  `).all();
  for (const job of interrupted) {
    if (job.post_status === 'success' || job.post_status === 'error') {
      finalizeFromPost(job.job_id);
      continue;
    }
    db.transaction(() => {
      db.prepare(`UPDATE agent_jobs SET status = 'queued', started_at = NULL,
                  updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`).run(job.job_id);
      db.prepare(`UPDATE posts SET status = 'pending', note = 'Khôi phục hàng đợi Agent API',
                  updated_at = CURRENT_TIMESTAMP WHERE id = ? AND platform = ?`)
        .run(job.post_id, job.platform);
    })();
  }
  for (const platform of PLATFORMS) schedule(platform, 25);
}

function requireInit() {
  if (!initialized) init();
}

function normalizePlatform(value) {
  const platform = String(value || 'facebook').trim().toLowerCase();
  if (!PLATFORMS.includes(platform)) {
    throw errorWithCode(`Nền tảng không được hỗ trợ: ${platform}`, 'AGENT_PLATFORM_INVALID');
  }
  return platform;
}

function resolveProfile(payload, platform) {
  const profiles = BrowserService.getAll(platform);
  const requestedId = Number(payload.profile_id || payload.profileId || 0);
  if (Number.isInteger(requestedId) && requestedId > 0) {
    const profile = profiles.find(item => Number(item.id) === requestedId);
    if (!profile) throw errorWithCode('Không tìm thấy profile cho nền tảng đã chọn.', 'AGENT_PROFILE_NOT_FOUND');
    return profile;
  }

  const requestedName = String(payload.profile || payload.profile_name || '').trim();
  if (!requestedName) {
    throw errorWithCode('Cần truyền profile hoặc profile_id.', 'AGENT_PROFILE_REQUIRED');
  }
  const matches = profiles.filter(item => String(item.name).trim().toLowerCase() === requestedName.toLowerCase());
  if (!matches.length) throw errorWithCode(`Không tìm thấy profile "${requestedName}".`, 'AGENT_PROFILE_NOT_FOUND');
  if (matches.length > 1) {
    throw errorWithCode(`Có nhiều profile tên "${requestedName}"; hãy dùng profile_id.`, 'AGENT_PROFILE_AMBIGUOUS');
  }
  return matches[0];
}

function normalizeMedia(payload) {
  const raw = payload.media !== undefined ? payload.media : payload.image_path;
  const values = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  for (const value of values) {
    if (value.includes(',')) {
      throw errorWithCode('Đường dẫn media không được chứa dấu phẩy.', 'AGENT_MEDIA_INVALID');
    }
    if (!path.isAbsolute(value) || !fs.existsSync(value)) {
      throw errorWithCode(`Không tìm thấy media trên máy: ${value}`, 'AGENT_MEDIA_NOT_FOUND');
    }
  }
  return values.join(',');
}

function normalizeComments(input) {
  const comments = Array.isArray(input) ? input : input ? [input] : [];
  return comments.map(item => {
    if (typeof item === 'string') return { text: item.trim(), media: '' };
    return {
      text: String(item && (item.text || item.content) || '').trim(),
      media: String(item && (item.media || item.image_path) || '').trim(),
    };
  }).filter(item => item.text || item.media);
}

function setCustomValues(postId, platform, values) {
  const columns = DataService.getCustomColumns(platform);
  for (const [key, rawValue] of Object.entries(values)) {
    const value = rawValue == null ? '' : String(rawValue).trim();
    if (!value) continue;
    const column = columns.find(item => item.var_key === key);
    if (column) DataService.setCustomData(postId, column.id, value, platform);
  }
}

function publicPostResult(postId, platform) {
  DataService.ensurePlatformDefaultColumns(platform);
  const post = DataService.getAllWithCustomData(platform).find(item => Number(item.id) === Number(postId));
  if (!post) return null;
  const linkRecovery = platform === 'facebook'
    ? db.prepare(`
      SELECT status FROM post_link_recovery_jobs
      WHERE post_id = ? AND platform = ?
      LIMIT 1
    `).get(postId, platform)
    : null;
  const custom = {};
  for (const column of DataService.getCustomColumns(platform)) {
    custom[column.var_key] = post[`custom_${column.id}`] || '';
  }
  return {
    post_id: Number(post.id),
    platform,
    status: post.status,
    link_post: custom.link_post || post.link || '',
    time_post: custom.time_post || '',
    note: post.note || '',
    comment_status: custom.comment_status || '',
    time_comment: custom.time_comment || '',
    link_pending: Boolean(
      linkRecovery && (linkRecovery.status === 'waiting' || linkRecovery.status === 'running')
    ),
    link_recovery_status: linkRecovery ? linkRecovery.status : null,
  };
}

function isWaitingForPermalink(job) {
  return Boolean(
    job
    && job.platform === 'facebook'
    && job.status === 'running'
    && job.result
    && job.result.status === 'success'
    && job.result.link_pending === true
  );
}

function rowToPublic(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch (_) {}
  return {
    job_id: row.job_id,
    request_id: row.request_id || null,
    batch_id: row.batch_id || null,
    platform: row.platform,
    profile_id: Number(row.profile_id),
    profile: row.profile_name,
    post_id: Number(row.post_id),
    status: row.status,
    result,
    error: row.error || null,
    created_at: row.created_at,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    updated_at: row.updated_at,
  };
}

function finalizeFromPost(jobId) {
  const row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(jobId);
  if (!row) return null;
  const result = publicPostResult(row.post_id, row.platform);
  if (!result || (result.status !== 'success' && result.status !== 'error')) return rowToPublic(row);
  // The Facebook publish is complete, but MCP must keep waiting until the
  // durable recovery resolves the permalink or reaches a terminal outcome.
  const status = result.status === 'success' && result.link_pending === true
    ? 'running'
    : result.status;
  const error = status === 'error' ? (result.note || result.link_post || 'Đăng bài thất bại.') : null;
  db.prepare(`
    UPDATE agent_jobs SET status = ?, result_json = ?, error = ?,
      completed_at = CASE
        WHEN ? = 'running' THEN NULL
        ELSE COALESCE(completed_at, CURRENT_TIMESTAMP)
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run(status, JSON.stringify(result), error, status, jobId);
  return rowToPublic(db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(jobId));
}

function failJob(row, message) {
  const clean = String(message || 'Không thể chạy tác vụ Agent API.');
  const post = publicPostResult(row.post_id, row.platform);
  if (!post || (post.status !== 'success' && post.status !== 'error')) {
    DataService.update(row.post_id, {
      status: 'error',
      note: clean,
      link: `Lỗi: ${clean}`,
    }, row.platform);
  }
  const result = publicPostResult(row.post_id, row.platform);
  db.prepare(`
    UPDATE agent_jobs SET status = 'error', result_json = ?, error = ?,
      completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run(JSON.stringify(result), clean, row.job_id);
}

async function startJob(row) {
  const runner = RunnerManager.get(row.platform);
  if (!runner || runner.isRunning) return false;
  const options = toolRunnerOptions(row.platform);
  db.prepare(`UPDATE agent_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`).run(row.job_id);
  try {
    const runPromise = runner.start({
      profileIds: [Number(row.profile_id)],
      dataIds: [Number(row.post_id)],
      concurrency: options.concurrency,
      delayMin: options.delay_min,
      delayMax: options.delay_max,
      profileDelayMin: options.profile_delay_min,
      profileDelayMax: options.profile_delay_max,
      maxPostsPerProfile: options.max_posts_per_profile,
    });
    await new Promise(resolve => setImmediate(resolve));
    if (runner.isRunning && Number(runner.progress && runner.progress.total) > 0) {
      DataService.update(row.post_id, { status: 'running', note: 'Đang chạy từ Agent API' }, row.platform);
    }
    const summary = await runPromise;
    const finalized = finalizeFromPost(row.job_id);
    if (!finalized || (!TERMINAL.has(finalized.status) && !isWaitingForPermalink(finalized))) {
      failJob(row, summary && summary.message
        ? summary.message
        : 'Runner kết thúc nhưng bài đăng chưa có kết quả.');
    }
  } catch (error) {
    failJob(row, error.message);
  }
  return true;
}

function settingNumber(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = Number(row && row.value);
  return Number.isFinite(value) ? value : fallback;
}

function toolRunnerOptions(platform) {
  const options = {
    concurrency: Math.min(10, Math.max(1, settingNumber('max_concurrency', 2))),
    delay_min: Math.max(0, settingNumber('default_delay_min', 30)),
    delay_max: Math.max(0, settingNumber('default_delay_max', 90)),
    profile_delay_min: Math.max(0, settingNumber('default_profile_delay_min', 10)),
    profile_delay_max: Math.max(0, settingNumber('default_profile_delay_max', 30)),
    max_posts_per_profile: Math.min(1000, Math.max(0, settingNumber(
      scopedSettingKey(platform, 'posts_per_profile_per_run'),
      0
    ))),
  };
  if (options.delay_max < options.delay_min) options.delay_max = options.delay_min;
  if (options.profile_delay_max < options.profile_delay_min) options.profile_delay_max = options.profile_delay_min;
  return options;
}

function nextQueueDelayMs(platform) {
  const options = toolRunnerOptions(platform);
  const min = Math.max(0, Number(options.delay_min) || 0);
  const max = Math.max(min, Number(options.delay_max) || min);
  return Math.floor((Math.random() * (max - min + 1) + min) * 1000);
}

async function startBatch(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const platform = rows[0].platform;
  const runner = RunnerManager.get(platform);
  if (!runner || runner.isRunning) return false;

  const options = toolRunnerOptions(platform);
  let selectedRows = rows;
  if (options.max_posts_per_profile > 0) {
    const counts = new Map();
    selectedRows = rows.filter(row => {
      const profileId = Number(row.profile_id);
      const count = counts.get(profileId) || 0;
      if (count >= options.max_posts_per_profile) return false;
      counts.set(profileId, count + 1);
      return true;
    });
  }
  const profileIds = [...new Set(selectedRows.map(row => Number(row.profile_id)).filter(Number.isInteger))];
  const postIds = [...new Set(selectedRows.map(row => Number(row.post_id)).filter(Number.isInteger))];

  db.transaction(() => {
    for (const row of selectedRows) {
      db.prepare(`UPDATE agent_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`).run(row.job_id);
    }
  })();

  try {
    const runPromise = runner.start({
      profileIds,
      dataIds: postIds,
      concurrency: options.concurrency,
      delayMin: options.delay_min,
      delayMax: options.delay_max,
      profileDelayMin: options.profile_delay_min,
      profileDelayMax: options.profile_delay_max,
      maxPostsPerProfile: options.max_posts_per_profile,
    });
    await new Promise(resolve => setImmediate(resolve));
    if (runner.isRunning && Number(runner.progress && runner.progress.total) > 0) {
      for (const row of selectedRows) {
        DataService.update(row.post_id, { status: 'running', note: 'Đang chạy batch từ Agent API' }, row.platform);
      }
    }
    const summary = await runPromise;
    for (const row of selectedRows) {
      const finalized = finalizeFromPost(row.job_id);
      if (!finalized || (!TERMINAL.has(finalized.status) && !isWaitingForPermalink(finalized))) {
        failJob(row, summary && summary.message
          ? summary.message
          : 'Runner batch kết thúc nhưng bài đăng chưa có kết quả.');
      }
    }
  } catch (error) {
    for (const row of selectedRows) {
      const finalized = finalizeFromPost(row.job_id);
      if (!finalized || (!TERMINAL.has(finalized.status) && !isWaitingForPermalink(finalized))) {
        failJob(row, error.message);
      }
    }
  }
  return true;
}

function schedule(platform, delayMs = 0) {
  if (shuttingDown || timers.has(platform)) return;
  const timer = setTimeout(() => {
    timers.delete(platform);
    pump(platform).catch(error => console.error('Agent queue error:', error.message));
  }, Math.max(0, delayMs));
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(platform, timer);
}

async function pump(platform) {
  requireInit();
  if (shuttingDown || activePumps.has(platform)) return;
  activePumps.add(platform);
  try {
    while (!shuttingDown) {
      const runner = RunnerManager.get(platform);
      if (!runner || runner.isRunning) {
        schedule(platform, 1000);
        return;
      }
      const row = db.prepare(`
        SELECT * FROM agent_jobs WHERE platform = ? AND status = 'queued'
        ORDER BY id ASC LIMIT 1
      `).get(platform);
      if (!row) return;
      if (row.batch_id) {
        const batchRows = db.prepare(`
          SELECT * FROM agent_jobs
          WHERE platform = ? AND batch_id = ? AND status = 'queued'
          ORDER BY id ASC
        `).all(platform, row.batch_id);
        const runnable = [];
        for (const batchRow of batchRows) {
          const existingBatchPost = publicPostResult(batchRow.post_id, batchRow.platform);
          if (existingBatchPost && (existingBatchPost.status === 'success' || existingBatchPost.status === 'error')) {
            finalizeFromPost(batchRow.job_id);
          } else {
            runnable.push(batchRow);
          }
        }
        if (runnable.length) await startBatch(runnable);
        const remaining = db.prepare(`
          SELECT COUNT(*) AS total FROM agent_jobs
          WHERE platform = ? AND batch_id = ? AND status = 'queued'
        `).get(platform, row.batch_id);
        if (Number(remaining && remaining.total) > 0) {
          schedule(platform, nextQueueDelayMs(platform));
          return;
        }
        continue;
      }
      const existing = publicPostResult(row.post_id, row.platform);
      if (existing && (existing.status === 'success' || existing.status === 'error')) {
        finalizeFromPost(row.job_id);
        continue;
      }
      await startJob(row);
      const next = db.prepare(`
        SELECT id FROM agent_jobs WHERE platform = ? AND status = 'queued' ORDER BY id ASC LIMIT 1
      `).get(platform);
      if (next) {
        schedule(platform, nextQueueDelayMs(platform));
        return;
      }
    }
  } finally {
    activePumps.delete(platform);
  }
}

function prepareJob(payload = {}, forcedPlatform = null) {
  const platform = normalizePlatform(forcedPlatform || payload.platform);
  const requestId = String(payload.request_id || payload.requestId || '').trim() || null;
  if (requestId && requestId.length > 128) {
    throw errorWithCode('request_id tối đa 128 ký tự.', 'AGENT_REQUEST_ID_INVALID');
  }
  const profile = resolveProfile(payload, platform);
  const content = String(payload.content || '').trim();
  const imagePath = normalizeMedia(payload);
  if (!content && !imagePath) {
    throw errorWithCode('Bài đăng cần có content hoặc media.', 'AGENT_POST_EMPTY');
  }

  const comments = normalizeComments(payload.comments);
  return { payload, platform, requestId, profile, content, imagePath, comments };
}

function insertPreparedJob(prepared, batchId = null, skipColumnEnsure = false) {
  const { payload, platform, requestId, profile, content, imagePath, comments } = prepared;
  if (!skipColumnEnsure) {
    DataService.ensurePlatformDefaultColumns(platform);
    if (comments.length) DataService.ensureCommentGroupsThrough(comments.length, platform);
  }

  const fanpage = String(payload.fanpage || payload.link_fanpage || '').trim();
  const productId = Array.isArray(payload.product_ids)
    ? payload.product_ids.map(value => String(value || '').trim()).filter(Boolean).join(',')
    : String(payload.product_id || payload.product_ids || '').trim();
  const post = DataService.create({
    content,
    image_path: imagePath,
    link: platform === 'facebook' ? fanpage : String(payload.link || '').trim(),
    target: String(payload.target || '').trim(),
    product_id: productId,
    status: 'pending',
    note: 'Tạo từ Agent API',
  }, platform);

  const custom = {
    ...(payload.custom_fields && typeof payload.custom_fields === 'object' && !Array.isArray(payload.custom_fields)
      ? payload.custom_fields
      : {}),
    name_profile: profile.name,
    link_fanpage: fanpage,
    post_group: payload.group || payload.post_group,
    description: payload.description,
    channel_name: payload.channel || payload.channel_name,
    playlist: payload.playlist,
    privacy_status: payload.privacy_status,
    thumbnail: payload.thumbnail,
    keywords: Array.isArray(payload.keywords) ? payload.keywords.join(',') : payload.keywords,
  };
  comments.forEach((comment, index) => {
    const sequence = index + 1;
    custom[CommentColumns.varKey('comment', sequence)] = comment.text;
    custom[CommentColumns.varKey('comment_media', sequence)] = comment.media;
  });
  setCustomValues(post.id, platform, custom);

  const jobId = `job_${crypto.randomUUID().replace(/-/g, '')}`;
  db.prepare(`
    INSERT INTO agent_jobs (
      job_id, request_id, batch_id, platform, profile_id, profile_name, post_id,
      status, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    jobId,
    requestId,
    batchId,
    platform,
    profile.id,
    profile.name,
    post.id,
    JSON.stringify(payload)
  );
  return rowToPublic(db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(jobId));
}

function normalizeRequestId(payload = {}, fallback = '') {
  const requestId = String(payload.request_id || payload.requestId || fallback || '').trim();
  if (!requestId) return null;
  if (requestId.length > 128) {
    throw errorWithCode('request_id must not exceed 128 characters.', 'AGENT_REQUEST_ID_INVALID');
  }
  return requestId;
}

function existingRequestJob(requestId, platform, postId) {
  if (!requestId) return null;
  const existing = db.prepare('SELECT * FROM agent_jobs WHERE request_id = ?').get(requestId);
  if (!existing) return null;
  if (existing.platform !== platform || Number(existing.post_id) !== Number(postId)) {
    throw errorWithCode(
      'request_id already belongs to another platform or post_id.',
      'AGENT_REQUEST_ID_CONFLICT'
    );
  }
  return rowToPublic(existing);
}

function prepareExistingDataJob(payload = {}, forcedPlatform = null, fallbackRequestId = '') {
  const platform = normalizePlatform(forcedPlatform || payload.platform);
  const postId = Number(payload.post_id || payload.postId);
  if (!Number.isInteger(postId) || postId <= 0) {
    throw errorWithCode('post_id is invalid.', 'AGENT_POST_ID_INVALID');
  }
  const requestId = normalizeRequestId(payload, fallbackRequestId);
  const replay = existingRequestJob(requestId, platform, postId);
  if (replay) return { replay };

  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND platform = ?')
    .get(postId, platform);
  if (!post) {
    throw errorWithCode('The requested pending data row was not found.', 'AGENT_DATA_NOT_FOUND');
  }
  if (String(post.status || '').trim().toLowerCase() !== 'pending') {
    throw errorWithCode(
      `post_id ${postId} is not pending.`,
      'AGENT_DATA_NOT_PENDING'
    );
  }

  DataService.ensurePlatformDefaultColumns(platform);
  const nameColumn = DataService.getCustomColumns(platform)
    .find(column => column.var_key === 'name_profile');
  const mapping = nameColumn
    ? db.prepare('SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?')
      .get(postId, nameColumn.id)
    : null;
  const profileName = String(mapping && mapping.value || '').trim();
  if (!profileName) {
    throw errorWithCode(
      `post_id ${postId} does not have name_profile mapping.`,
      'AGENT_DATA_PROFILE_REQUIRED'
    );
  }
  const profile = resolveProfile({ profile: profileName }, platform);
  if (String(profile.name || '').trim() !== profileName) {
    throw errorWithCode(
      `post_id ${postId} name_profile must exactly match "${profile.name}".`,
      'AGENT_DATA_PROFILE_MISMATCH'
    );
  }
  const active = db.prepare(`
    SELECT job_id FROM agent_jobs
    WHERE platform = ? AND post_id = ? AND status IN ('queued', 'running')
    ORDER BY id DESC LIMIT 1
  `).get(platform, postId);
  if (active) {
    throw errorWithCode(
      `post_id ${postId} already belongs to active job ${active.job_id}.`,
      'AGENT_POST_JOB_ACTIVE'
    );
  }
  return { platform, postId, requestId, profile, payload };
}

function insertExistingDataJob(prepared, batchId = null) {
  const jobId = `job_${crypto.randomUUID().replace(/-/g, '')}`;
  db.prepare(`
    INSERT INTO agent_jobs (
      job_id, request_id, batch_id, platform, profile_id, profile_name, post_id,
      status, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(
    jobId,
    prepared.requestId,
    batchId,
    prepared.platform,
    prepared.profile.id,
    prepared.profile.name,
    prepared.postId,
    JSON.stringify({
      source: 'existing_data',
      post_id: prepared.postId,
      request_id: prepared.requestId,
    })
  );
  return rowToPublic(db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(jobId));
}

function getRuntimeConfig(platform = 'facebook') {
  requireInit();
  platform = normalizePlatform(platform);
  return {
    platform,
    source: 'super-post-king-settings',
    agent_override_allowed: false,
    runner: toolRunnerOptions(platform),
    queue_policy: {
      queued_jobs_auto_resume: true,
      max_posts_per_profile_scope: 'per_runner_pass',
      next_pass_delay_source: 'runner.delay_min_to_delay_max',
      queued_means_blocked: false,
    },
  };
}

function customFieldWritableVia(column) {
  const key = String(column.var_key || '');
  const comment = CommentColumns.parseVarKey(key);
  if (comment) {
    return ['comment', 'comment_media'].includes(comment.base) ? 'comments' : 'read_only';
  }
  const routes = {
    name_profile: 'profile/profile_id',
    link_fanpage: 'fanpage',
    post_group: 'group',
    description: 'description',
    channel_name: 'channel/channel_name',
    playlist: 'playlist',
    privacy_status: 'privacy_status',
    thumbnail: 'thumbnail',
    keywords: 'keywords',
    link_post: 'read_only',
    time_post: 'read_only',
    comment_status: 'read_only',
    time_comment: 'read_only',
  };
  return routes[key] || 'custom_fields';
}

function getDataSchema(platform = 'facebook') {
  requireInit();
  platform = normalizePlatform(platform);
  DataService.ensurePlatformDefaultColumns(platform);
  return {
    platform,
    built_in_fields: [
      { key: 'content', type: 'text', writable_via: 'content' },
      { key: 'image_path', mcp_key: 'media', type: 'file', writable_via: 'media' },
      { key: 'link', type: 'text', writable_via: platform === 'facebook' ? 'fanpage' : 'link' },
      { key: 'target', type: 'text', writable_via: 'target' },
      { key: 'product_id', type: 'text', platform: 'tiktok', writable_via: 'product_id/product_ids' },
      { key: 'status', type: 'system', writable_via: 'read_only' },
      { key: 'note', type: 'system', writable_via: 'read_only' },
      { key: 'data_key', storage_key: 'agent_data_key', type: 'system', writable_via: 'create_data' },
    ],
    custom_fields: DataService.getCustomColumns(platform).map(column => ({
      id: Number(column.id),
      name: column.name,
      key: column.var_key,
      type: column.col_type,
      writable_via: customFieldWritableVia(column),
    })),
    result_fields: ['link_post', 'time_post', 'comment_status', 'time_comment'],
  };
}

function listProfileGroups(platform = 'facebook') {
  requireInit();
  platform = normalizePlatform(platform);
  const profiles = listProfiles(platform);
  return BrowserService.getGroups(platform).map(group => ({
    ...group,
    profiles: profiles
      .filter(profile => (profile.groups || []).some(item => Number(item.id) === Number(group.id)))
      .map(profile => ({ id: profile.id, name: profile.name, status: profile.status, session_valid: profile.session_valid })),
  }));
}

function listTargets(platform = 'facebook', profileIds = []) {
  requireInit();
  platform = normalizePlatform(platform);
  const allowed = new Set((profileIds || []).map(Number).filter(Number.isInteger));
  const managed = platform === 'facebook' || platform === 'youtube'
    ? ManagedTargetsService.all(platform).filter(target => !allowed.size || allowed.has(Number(target.profile_id)))
    : [];
  const savedGroups = [];
  if (platform === 'facebook') {
    const rows = DataService.getAllWithCustomData(platform);
    const groupColumn = DataService.getCustomColumns(platform).find(column => column.var_key === 'post_group');
    if (groupColumn) {
      const seen = new Set();
      for (const row of rows) {
        const value = String(row[`custom_${groupColumn.id}`] || '').trim();
        if (!value || seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        savedGroups.push({ url: value, source: 'platform_data' });
      }
    }
  }
  return { platform, managed_targets: managed, saved_groups: savedGroups };
}

function listPlatformData({ platform = 'facebook', status = '', limit = 200 } = {}) {
  requireInit();
  platform = normalizePlatform(platform);
  DataService.ensurePlatformDefaultColumns(platform);
  const columns = DataService.getCustomColumns(platform);
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
  return DataService.getAllWithCustomData(platform)
    .filter(row => !normalizedStatus || String(row.status || '').trim().toLowerCase() === normalizedStatus)
    .slice(0, safeLimit)
    .map(row => ({
      id: Number(row.id),
      data_key: row.agent_data_key || null,
      platform,
      content: row.content || '',
      media: row.image_path || '',
      link: row.link || '',
      target: row.target || '',
      product_id: row.product_id || '',
      status: row.status || '',
      note: row.note || '',
      custom_fields: Object.fromEntries(columns.map(column => [
        column.var_key,
        row[`custom_${column.id}`] || '',
      ])),
    }));
}

function assignProfiles(payload = {}) {
  requireInit();
  const platform = normalizePlatform(payload.platform);
  const assignments = Array.isArray(payload.assignments) ? payload.assignments : [];
  if (!assignments.length) throw errorWithCode('Cần truyền ít nhất một assignment.', 'AGENT_ASSIGNMENTS_REQUIRED');
  if (assignments.length > 1000) throw errorWithCode('Tối đa 1000 assignment mỗi lần.', 'AGENT_ASSIGNMENTS_TOO_LARGE');

  DataService.ensurePlatformDefaultColumns(platform);
  const nameColumn = DataService.getCustomColumns(platform).find(column => column.var_key === 'name_profile');
  if (!nameColumn) throw errorWithCode('Không tìm thấy cột name_profile.', 'AGENT_NAME_PROFILE_COLUMN_MISSING');
  const rows = new Map(DataService.getAllWithCustomData(platform).map(row => [Number(row.id), row]));
  const seenPosts = new Set();
  const prepared = assignments.map((assignment, index) => {
    const postId = Number(assignment && (assignment.post_id || assignment.id));
    if (!Number.isInteger(postId) || !rows.has(postId)) {
      throw errorWithCode(`Assignment ${index + 1}: không tìm thấy post_id ${postId}.`, 'AGENT_POST_NOT_FOUND');
    }
    if (seenPosts.has(postId)) {
      throw errorWithCode(`post_id ${postId} xuất hiện nhiều lần trong assignments.`, 'AGENT_ASSIGNMENT_DUPLICATE');
    }
    seenPosts.add(postId);
    const activeJob = db.prepare(`
      SELECT job_id, status FROM agent_jobs
      WHERE platform = ? AND post_id = ? AND status IN ('queued', 'running')
      ORDER BY id DESC LIMIT 1
    `).get(platform, postId);
    if (activeJob) {
      throw errorWithCode(`post_id ${postId} đang thuộc job ${activeJob.job_id}; không thể đổi profile.`, 'AGENT_POST_JOB_ACTIVE');
    }
    const profile = resolveProfile(assignment || {}, platform);
    const row = rows.get(postId);
    const currentProfile = String(row[`custom_${nameColumn.id}`] || '').trim();
    return {
      postId,
      profile,
      row,
      changed: currentProfile !== String(profile.name || '').trim(),
    };
  });
  const matchingSchedules = require('./agent-schedule.service').findEnabledAllPending(
    platform,
    prepared
      .filter(item => item.changed && String(item.row.status || '').trim().toLowerCase() === 'pending')
      .map(item => Number(item.profile.id))
  );
  if (matchingSchedules.length && payload.allow_scheduled_consumption !== true) {
    throw errorWithCode(
      `There are ${matchingSchedules.length} enabled all_pending schedules that can consume these rows. `
        + 'Pass allow_scheduled_consumption=true only when that behavior is intended.',
      'AGENT_DATA_ACTIVE_ALL_PENDING_SCHEDULE'
    );
  }

  db.transaction(() => {
    for (const item of prepared) {
      if (!item.changed) continue;
      db.prepare('INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value) VALUES (?, ?, ?)')
        .run(item.postId, nameColumn.id, item.profile.name);
      db.prepare(
        "UPDATE posts SET agent_payload_json = NULL, updated_at = datetime('now') WHERE id = ? AND platform = ?"
      ).run(item.postId, platform);
    }
  })();
  return {
    platform,
    updated: prepared.length,
    changed_count: prepared.filter(item => item.changed).length,
    scheduled_consumption_authorized: matchingSchedules.length > 0
      && payload.allow_scheduled_consumption === true,
    matching_schedules: matchingSchedules,
    assignments: prepared.map(item => ({
      post_id: item.postId,
      profile_id: Number(item.profile.id),
      profile: item.profile.name,
    })),
  };
}

function getCapabilities() {
  return {
    platforms: PLATFORMS,
    common_fields: ['content', 'media', 'comments', 'custom_fields'],
    platform_fields: {
      facebook: ['fanpage', 'fanpages', 'group', 'groups'],
      tiktok: ['product_id', 'product_ids'],
      youtube: ['description', 'channel', 'channel_name', 'playlist', 'privacy_status', 'thumbnail', 'keywords'],
      threads: [],
      instagram: [],
      x: [],
      zalovideo: ['playlist'],
    },
    facebook_target_logic: {
      fanpage_present: 'one job per fanpage',
      group_present: 'one job per group',
      no_fanpage_or_group: 'profile timeline',
    },
    profile_logic: {
      one_profile_per_item: true,
      multi_profile_batch: true,
      distribution_modes: ['mapped', 'all_profiles'],
    },
    publish_groups: {
      persistent: true,
      member_types: ['profile', 'fanpage', 'group', 'default'],
      one_job_per_member: true,
      shared_content: true,
      crud_via_mcp: true,
    },
    publish_campaigns: {
      persistent: true,
      cross_platform: true,
      parallel_platforms: true,
      per_platform_overrides: true,
      one_batch_per_publish_group: true,
      crud_via_mcp: true,
    },
    schedules: {
      persistent: true,
      types: ['once', 'daily', 'custom'],
      timezone: 'Asia/Ho_Chi_Minh',
      crud_via_mcp: true,
      idempotent_create: true,
      settings_source: 'Super Post King settings only',
    },
    pending_data: {
      create_one_via_mcp: true,
      create_batch_via_mcp: true,
      publish_existing_one_via_mcp: true,
      publish_existing_batch_via_mcp: true,
      status: 'pending',
      creates_job: false,
      starts_runner: false,
      idempotent_create: true,
    },
    execution: {
      concurrent_profiles: true,
      same_profile_posts_are_sequential: true,
      settings_source: 'Super Post King settings only',
      agent_can_override_settings: false,
    },
    realtime: {
      durable_events: true,
      resumable_event_id: true,
      notifications: true,
      wait_job: true,
      wait_events: true,
      event_types: [
        'job.queued',
        'job.running',
        'job.progress',
        'job.success',
        'job.error',
        'job.cancelled',
        'link_recovery.updated',
      ],
    },
  };
}

function createJob(payload = {}) {
  requireInit();
  const platform = normalizePlatform(payload.platform);
  LicenseService.assertPlatform(platform);
  const requestId = String(payload.request_id || payload.requestId || '').trim() || null;
  if (requestId) {
    const existing = db.prepare('SELECT * FROM agent_jobs WHERE request_id = ?').get(requestId);
    if (existing) return rowToPublic(existing);
  }
  const job = insertPreparedJob(prepareJob(payload, platform));
  schedule(platform, 0);
  return job;
}

function createDataJob(payload = {}) {
  requireInit();
  const platform = normalizePlatform(payload.platform);
  LicenseService.assertPlatform(platform);
  const fallbackRequestId = `spk:data:${crypto.randomUUID()}`;
  const prepared = prepareExistingDataJob(payload, platform, fallbackRequestId);
  if (prepared.replay) return prepared.replay;
  const job = insertExistingDataJob(prepared);
  schedule(platform, 0);
  return job;
}

function batchStatus(jobs) {
  const statuses = jobs.map(job => job.status);
  if (statuses.some(status => status === 'running')) return 'running';
  if (statuses.some(status => status === 'queued')) return 'queued';
  const successes = statuses.filter(status => status === 'success').length;
  const errors = statuses.filter(status => status === 'error' || status === 'cancelled').length;
  if (statuses.length && successes === statuses.length) return 'success';
  if (successes && errors) return 'partial_success';
  if (statuses.length && errors === statuses.length) return 'error';
  return 'queued';
}

function normalizeBatchKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(key)) {
    throw errorWithCode(
      'batch_key must be 3-160 characters using letters, numbers, dot, dash, underscore or colon.',
      'AGENT_BATCH_KEY_INVALID'
    );
  }
  return key;
}

function dataBatchRequestId(batchKey, itemKey, platform, postId) {
  const digest = crypto.createHash('sha256')
    .update([batchKey, itemKey, platform, postId].join('|'))
    .digest('hex')
    .slice(0, 32);
  return `spk:data:${digest}`;
}

function createDataBatch(payload = {}) {
  requireInit();
  const platform = normalizePlatform(payload.platform);
  LicenseService.assertPlatform(platform);
  const batchKey = normalizeBatchKey(payload.batch_key);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    throw errorWithCode('At least one item is required.', 'AGENT_BATCH_ITEMS_REQUIRED');
  }
  if (items.length > 500) {
    throw errorWithCode('A batch supports at most 500 items.', 'AGENT_BATCH_TOO_LARGE');
  }

  const seenKeys = new Set();
  const seenPosts = new Set();
  const prepared = items.map((item, index) => {
    const itemKey = String(item && item.item_key || '').trim();
    if (!itemKey) {
      throw errorWithCode(`Item ${index + 1} requires item_key.`, 'AGENT_BATCH_ITEM_KEY_REQUIRED');
    }
    if (seenKeys.has(itemKey)) {
      throw errorWithCode(`Duplicate item_key: ${itemKey}`, 'AGENT_BATCH_ITEM_KEY_DUPLICATE');
    }
    seenKeys.add(itemKey);
    const postId = Number(item && (item.post_id || item.postId));
    if (!Number.isInteger(postId) || postId <= 0) {
      throw errorWithCode(`Item ${index + 1} has an invalid post_id.`, 'AGENT_POST_ID_INVALID');
    }
    if (seenPosts.has(postId)) {
      throw errorWithCode(`Duplicate post_id: ${postId}`, 'AGENT_BATCH_POST_DUPLICATE');
    }
    seenPosts.add(postId);
    const requestId = normalizeRequestId(
      item || {},
      dataBatchRequestId(batchKey, itemKey, platform, postId)
    );
    return prepareExistingDataJob({ ...item, post_id: postId, request_id: requestId }, platform);
  });

  const replayed = prepared.filter(item => item.replay).map(item => item.replay);
  if (replayed.length && replayed.length !== prepared.length) {
    throw errorWithCode(
      'The batch mixes existing request_id values with new jobs.',
      'AGENT_BATCH_IDEMPOTENCY_CONFLICT'
    );
  }
  if (replayed.length) {
    const batchIds = [...new Set(replayed.map(job => job.batch_id).filter(Boolean))];
    if (batchIds.length !== 1 || replayed.some(job => job.batch_id !== batchIds[0])) {
      throw errorWithCode(
        'The replayed request_id values do not belong to one existing batch.',
        'AGENT_BATCH_IDEMPOTENCY_CONFLICT'
      );
    }
    return getBatch(batchIds[0]);
  }

  const batchId = `batch_${crypto.randomUUID().replace(/-/g, '')}`;
  const jobs = db.transaction(() => prepared.map(item => insertExistingDataJob(item, batchId)))();
  schedule(platform, 0);
  return {
    batch_id: batchId,
    batch_key: batchKey,
    platform,
    status: batchStatus(jobs),
    total: jobs.length,
    success_count: 0,
    error_count: 0,
    pending_count: jobs.length,
    jobs,
  };
}

function getBatch(batchId) {
  requireInit();
  const id = String(batchId || '').trim();
  if (!id) throw errorWithCode('Cần truyền batch_id.', 'AGENT_BATCH_ID_REQUIRED');
  const rows = db.prepare('SELECT * FROM agent_jobs WHERE batch_id = ? ORDER BY id ASC').all(id);
  if (!rows.length) throw errorWithCode('Không tìm thấy agent batch.', 'AGENT_BATCH_NOT_FOUND');
  const jobs = rows.map(row => getJob(row.job_id));
  return {
    batch_id: id,
    platform: jobs[0].platform,
    status: batchStatus(jobs),
    total: jobs.length,
    success_count: jobs.filter(job => job.status === 'success').length,
    error_count: jobs.filter(job => job.status === 'error' || job.status === 'cancelled').length,
    pending_count: jobs.filter(job => job.status === 'queued' || job.status === 'running').length,
    jobs,
  };
}

function createBatch(payload = {}) {
  requireInit();
  const platform = normalizePlatform(payload.platform);
  LicenseService.assertPlatform(platform);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw errorWithCode('Cần truyền ít nhất một item.', 'AGENT_BATCH_ITEMS_REQUIRED');
  if (items.length > 500) throw errorWithCode('Một batch tối đa 500 item.', 'AGENT_BATCH_TOO_LARGE');

  const existing = [];
  const prepared = [];
  for (const item of items) {
    const requestId = String(item && (item.request_id || item.requestId) || '').trim();
    if (!requestId) throw errorWithCode('Mỗi item trong batch cần request_id.', 'AGENT_BATCH_REQUEST_ID_REQUIRED');
    const found = db.prepare('SELECT * FROM agent_jobs WHERE request_id = ?').get(requestId);
    if (found) existing.push(rowToPublic(found));
    else prepared.push(prepareJob({ ...item, platform }, platform));
  }

  if (existing.length && prepared.length) {
    throw errorWithCode(
      'Batch chứa cả request_id đã tồn tại và request_id mới; hãy lấy batch/job cũ trước khi gửi phần còn lại.',
      'AGENT_BATCH_IDEMPOTENCY_CONFLICT'
    );
  }
  if (existing.length) {
    const existingBatchIds = [...new Set(existing.map(job => job.batch_id).filter(Boolean))];
    if (existingBatchIds.length === 1) return getBatch(existingBatchIds[0]);
    return {
      batch_id: null,
      platform,
      status: batchStatus(existing),
      total: existing.length,
      success_count: existing.filter(job => job.status === 'success').length,
      error_count: existing.filter(job => job.status === 'error' || job.status === 'cancelled').length,
      pending_count: existing.filter(job => job.status === 'queued' || job.status === 'running').length,
      jobs: existing,
    };
  }

  const batchId = `batch_${crypto.randomUUID().replace(/-/g, '')}`;
  DataService.ensurePlatformDefaultColumns(platform);
  const maxComments = Math.max(0, ...prepared.map(item => item.comments.length));
  if (maxComments) DataService.ensureCommentGroupsThrough(maxComments, platform);
  const jobs = db.transaction(() => prepared.map(item => insertPreparedJob(item, batchId, true)))();
  schedule(platform, 0);
  return {
    batch_id: batchId,
    platform,
    status: batchStatus(jobs),
    total: jobs.length,
    success_count: 0,
    error_count: 0,
    pending_count: jobs.length,
    jobs,
  };
}

function getJob(jobId) {
  requireInit();
  let row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(String(jobId || ''));
  if (!row) throw errorWithCode('Không tìm thấy agent job.', 'AGENT_JOB_NOT_FOUND');
  if (!TERMINAL.has(row.status)) {
    const refreshed = finalizeFromPost(row.job_id);
    if (refreshed && TERMINAL.has(refreshed.status)) return refreshed;
    row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(row.job_id);
  }
  return rowToPublic(row);
}

function listJobs({ platform, status, limit = 50 } = {}) {
  requireInit();
  const clauses = [];
  const params = [];
  if (platform) { clauses.push('platform = ?'); params.push(normalizePlatform(platform)); }
  if (status) { clauses.push('status = ?'); params.push(String(status)); }
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const sql = `SELECT * FROM agent_jobs${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
               ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, safeLimit).map(rowToPublic);
}

function listProfiles(platform = 'facebook') {
  platform = normalizePlatform(platform);
  return BrowserService.getAll(platform).map(profile => ({
    id: Number(profile.id),
    name: profile.name,
    platform,
    provider: profile.provider,
    status: profile.status,
    session_valid: Boolean(profile.session_valid),
    groups: profile.groups || [],
  }));
}

function cancelJob(jobId) {
  requireInit();
  const row = db.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(String(jobId || ''));
  if (!row) throw errorWithCode('Không tìm thấy agent job.', 'AGENT_JOB_NOT_FOUND');
  if (row.status !== 'queued') {
    throw errorWithCode('Chỉ có thể hủy job đang chờ.', 'AGENT_JOB_NOT_QUEUED');
  }
  db.transaction(() => {
    db.prepare(`UPDATE agent_jobs SET status = 'cancelled', error = 'Đã hủy',
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`)
      .run(row.job_id);
    db.prepare(`UPDATE posts SET status = 'error', note = 'Agent job đã hủy',
                updated_at = CURRENT_TIMESTAMP WHERE id = ? AND platform = ?`)
      .run(row.post_id, row.platform);
  })();
  return getJob(row.job_id);
}

async function waitForJob(jobId, seconds = 0) {
  const timeoutMs = Math.min(300, Math.max(0, Number(seconds) || 0)) * 1000;
  const deadline = Date.now() + timeoutMs;
  let job = getJob(jobId);
  while (!TERMINAL.has(job.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    job = getJob(jobId);
  }
  return { ...job, timed_out: !TERMINAL.has(job.status) };
}

async function waitForBatch(batchId, seconds = 0) {
  const timeoutMs = Math.min(300, Math.max(0, Number(seconds) || 0)) * 1000;
  const deadline = Date.now() + timeoutMs;
  let batch = getBatch(batchId);
  while ((batch.status === 'queued' || batch.status === 'running') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    batch = getBatch(batchId);
  }
  return { ...batch, timed_out: batch.status === 'queued' || batch.status === 'running' };
}

function shutdown() {
  shuttingDown = true;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

module.exports = {
  init,
  shutdown,
  createJob,
  createBatch,
  createDataJob,
  createDataBatch,
  getJob,
  getBatch,
  listJobs,
  listProfiles,
  getRuntimeConfig,
  getDataSchema,
  listProfileGroups,
  listTargets,
  listPlatformData,
  assignProfiles,
  getCapabilities,
  cancelJob,
  waitForJob,
  waitForBatch,
  _private: {
    publicPostResult,
    finalizeFromPost,
    isWaitingForPermalink,
    normalizeMedia,
    normalizeComments,
    pump,
    startBatch,
    toolRunnerOptions,
    nextQueueDelayMs,
    prepareExistingDataJob,
    insertExistingDataJob,
    customFieldWritableVia,
  },
};
