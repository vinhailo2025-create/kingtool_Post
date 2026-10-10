/**
 * Super Post - King - Scheduler Service
 * Manages scheduled posting jobs using node-cron
 */

const cron = require('node-cron');
const db = require('../database/init');
const { normalizePlatform, scopedSettingKey } = require('../platforms/platform.utils');

// Active cron jobs: id -> { job, timeout }
const activeJobs = new Map();
const MAX_TIMEOUT = 2147483647;
// Runner cua mot nen tang chi chay mot luot; lich den gio khi runner ban thi xep hang
// (theo thu tu den) va doi thay vi bao loi. Hang doi rieng tung nen tang.
const RUNNER_WAIT_POLL_MS = 5000;
const RUNNER_WAIT_MAX_MS = Math.max(60000, Number(process.env.SCHEDULE_RUNNER_WAIT_MAX_MS) || 2 * 60 * 60 * 1000);
const runnerWaitQueues = new Map();
let defaultBroadcast = null;

function parseDataIds(value) {
  if (value === 'all' || value === '*') return 'all';
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(value || '[]');
    return [...new Set(parsed.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  } catch (_) {
    return [];
  }
}

function scheduledTimeLabel(schedule) {
  const value = String(schedule.schedule_time || '').trim();
  if (schedule.schedule_type === 'once' && value) {
    const local = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (local && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
      return `${local[3]}/${local[2]}/${local[1]} ${local[4]}:${local[5]}`;
    }
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
      });
    }
  }
  if (schedule.schedule_type === 'daily') return `Hằng ngày ${value || '08:00'}`;
  if (schedule.schedule_type === 'custom') return `Cron ${schedule.cron_expr || ''}`.trim();
  return value;
}

function explicitPostIds(schedule) {
  if (!schedule || schedule.task_mode === 'comment_link') return [];
  const ids = parseDataIds(schedule.data_ids);
  return ids === 'all' ? [] : ids;
}

function ensureTimePostColumn(platform) {
  const DataService = require('./data.service');
  DataService.ensurePlatformDefaultColumns(platform);
  return DataService.getCustomColumns(platform).find(column => column.var_key === 'time_post');
}

function broadcastPostState(schedule, postId, status, timePost, note = '') {
  if (typeof defaultBroadcast !== 'function') return;
  try {
    defaultBroadcast({
      time: new Date().toISOString(),
      profile: null,
      message: '',
      type: 'info',
      event: 'post_state',
      platform: schedule.platform,
      schedule_id: schedule.id,
      post_id: postId,
      status,
      time_post: timePost,
      note,
    });
  } catch (_) {}
}

function assertRowsCanBeScheduled(schedule, allowedScheduledIds = []) {
  const ids = explicitPostIds(schedule);
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, status FROM posts
    WHERE platform = ? AND data_mode = 'post' AND id IN (${placeholders})
  `).all(schedule.platform, ...ids);
  const found = new Map(rows.map(row => [Number(row.id), row]));
  const allowed = new Set(allowedScheduledIds.map(Number));
  const invalid = ids.filter(id => {
    const status = String(found.get(id)?.status || '').toLowerCase();
    return status !== 'pending' && !(status === 'scheduled' && allowed.has(id));
  });
  if (invalid.length) {
    throw new Error(`Chỉ hẹn được hàng đang Chờ; các hàng không hợp lệ: ${invalid.join(', ')}`);
  }
}

function markRowsScheduled(schedule) {
  const ids = explicitPostIds(schedule);
  if (!ids.length || !schedule.enabled) return;
  const timePost = scheduledTimeLabel(schedule);
  const timeColumn = ensureTimePostColumn(schedule.platform);
  const updatePost = db.prepare(`
    UPDATE posts
    SET status = 'scheduled', note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND platform = ? AND data_mode = 'post'
  `);
  const updateTime = db.prepare(`
    INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value)
    VALUES (?, ?, ?)
  `);
  db.transaction(() => {
    for (const id of ids) {
      updatePost.run(`Đã hẹn giờ đăng lúc ${timePost}`, id, schedule.platform);
      updateTime.run(id, timeColumn.id, timePost);
    }
  })();
  for (const id of ids) {
    broadcastPostState(schedule, id, 'scheduled', timePost, `Đã hẹn giờ đăng lúc ${timePost}`);
  }
}

function releaseScheduledRows(schedule, { clearTime = false, note = '' } = {}) {
  const ids = explicitPostIds(schedule);
  if (!ids.length) return;
  const timeColumn = ensureTimePostColumn(schedule.platform);
  const updatePost = db.prepare(`
    UPDATE posts
    SET status = 'pending', note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND platform = ? AND data_mode = 'post' AND status = 'scheduled'
  `);
  const clearTimeValue = db.prepare(`
    INSERT OR REPLACE INTO post_custom_data (post_id, column_id, value)
    VALUES (?, ?, '')
  `);
  db.transaction(() => {
    for (const id of ids) {
      updatePost.run(note, id, schedule.platform);
      if (clearTime) clearTimeValue.run(id, timeColumn.id);
    }
  })();
  for (const id of ids) {
    const row = db.prepare(
      'SELECT status, note FROM posts WHERE id = ? AND platform = ?'
    ).get(id, schedule.platform);
    const value = clearTime
      ? ''
      : db.prepare(
        'SELECT value FROM post_custom_data WHERE post_id = ? AND column_id = ?'
      ).get(id, timeColumn.id)?.value || '';
    broadcastPostState(schedule, id, row?.status || 'pending', value, row?.note || note);
  }
}

function waitTimer(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function recordScheduleActivity(schedule, message, status = 'info') {
  try {
    db.prepare(`
      INSERT INTO activity_logs (type, profile_id, post_id, message, status, platform, created_at)
      VALUES ('schedule', NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(message, status, schedule.platform);
  } catch (_) {}
  if (typeof defaultBroadcast === 'function') {
    try {
      defaultBroadcast({
        time: new Date().toISOString(),
        profile: null,
        message,
        type: status === 'error' ? 'error' : status,
        event: 'schedule',
        platform: schedule.platform,
        schedule_id: schedule.id,
      });
    } catch (_) {}
  }
}

function getPostsPerRunSetting(platform) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(scopedSettingKey(platform, 'posts_per_profile_per_run'));
  return Math.min(1000, Math.max(0, parseInt(row?.value, 10) || 0));
}

// Prepared statements
const stmts = {
  getAll: db.prepare('SELECT * FROM schedules WHERE platform = ? ORDER BY created_at DESC'),
  getAllGlobal: db.prepare('SELECT * FROM schedules ORDER BY created_at DESC'),
  getById: db.prepare('SELECT * FROM schedules WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO schedules (
      name, schedule_time, schedule_type, cron_expr, profile_ids, data_ids,
      concurrency, delay_min, delay_max, enabled, status, platform,
      schedule_key, created_by, task_mode
    )
    VALUES (
      @name, @schedule_time, @schedule_type, @cron_expr, @profile_ids, @data_ids,
      @concurrency, @delay_min, @delay_max, @enabled, @status, @platform,
      @schedule_key, @created_by, @task_mode
    )
  `),
  update: db.prepare(`
    UPDATE schedules SET name = @name, schedule_time = @schedule_time, schedule_type = @schedule_type,
    cron_expr = @cron_expr, profile_ids = @profile_ids, data_ids = @data_ids,
    concurrency = @concurrency, delay_min = @delay_min, delay_max = @delay_max,
    enabled = @enabled, status = @status, task_mode = @task_mode
    WHERE id = @id
  `),
  delete: db.prepare('DELETE FROM schedules WHERE id = ?'),
  toggleEnabled: db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?'),
  updateStatus: db.prepare('UPDATE schedules SET status = ? WHERE id = ?'),
  updateLastRun: db.prepare('UPDATE schedules SET last_run = datetime("now"), status = ? WHERE id = ?'),
  getEnabled: db.prepare('SELECT * FROM schedules WHERE enabled = 1'),
  // Sửa dữ liệu cũ: lịch once bị đánh 'completed' nhưng chưa từng chạy
  // (last_run null do bị quá hạn lúc khởi động) -> đổi thành 'missed'.
  fixMissedCompleted: db.prepare(
    "UPDATE schedules SET status = 'missed' WHERE schedule_type = 'once' AND status = 'completed' AND last_run IS NULL"
  ),
};

const SchedulerService = {
  getPostsPerRunSetting,

  setDefaultBroadcast(fn) {
    defaultBroadcast = typeof fn === 'function' ? fn : null;
  },

  /**
   * Doi runner cua nen tang ranh. Tra ve true khi duoc phep chay, false khi het
   * thoi gian cho. Nhieu lich cung doi thi chay lan luot theo thu tu den gio.
   */
  async _waitForRunner(schedule, runner, options = {}) {
    const platform = schedule.platform;
    const pollMs = Number(options.pollMs) || RUNNER_WAIT_POLL_MS;
    const maxWaitMs = Number(options.maxWaitMs) || RUNNER_WAIT_MAX_MS;
    const previous = runnerWaitQueues.get(platform) || Promise.resolve();
    let release;
    const ticket = new Promise(resolve => { release = resolve; });
    runnerWaitQueues.set(platform, previous.then(() => ticket));
    try {
      await previous;
      if (!runner.isRunning) return true;
      const startedAt = Date.now();
      recordScheduleActivity(
        schedule,
        `Lịch #${schedule.id} "${schedule.name}" đến giờ nhưng runner ${platform} đang bận; xếp hàng đợi runner xong.`,
        'warning'
      );
      while (runner.isRunning) {
        if (Date.now() - startedAt >= maxWaitMs) {
          recordScheduleActivity(
            schedule,
            `Lịch #${schedule.id} "${schedule.name}" đợi runner ${platform} quá ${Math.round(maxWaitMs / 60000)} phút; bỏ lượt này.`,
            'error'
          );
          return false;
        }
        await waitTimer(pollMs);
      }
      recordScheduleActivity(
        schedule,
        `Runner ${platform} đã rảnh sau ${Math.round((Date.now() - startedAt) / 1000)}s; bắt đầu chạy lịch #${schedule.id} "${schedule.name}".`,
        'info'
      );
      return true;
    } finally {
      release();
    }
  },

  /**
   * Get all schedules
   */
  getAll(platform = 'facebook') {
    if (String(platform).toLowerCase() === 'all') return stmts.getAllGlobal.all();
    return stmts.getAll.all(normalizePlatform(platform));
  },

  /**
   * Get single schedule by ID
   */
  getById(id, platform = null) {
    const schedule = stmts.getById.get(id);
    if (!schedule || !platform || String(platform).toLowerCase() === 'all') return schedule;
    return schedule.platform === normalizePlatform(platform) ? schedule : null;
  },

  /**
   * Create a new schedule
   */
  create({
    name,
    schedule_time,
    schedule_type = 'once',
    cron_expr,
    profile_ids,
    data_ids,
    concurrency = 1,
    delay_min = 30,
    delay_max = 90,
    platform = 'facebook',
    enabled = true,
    schedule_key = null,
    created_by = 'app',
    task_mode = 'post',
  }) {
    const isEnabled = enabled !== false && enabled !== 0;
    const params = {
      task_mode: task_mode === 'comment_link' ? 'comment_link' : 'post',
      name: name || 'Lịch mới',
      schedule_time: schedule_time || null,
      schedule_type,
      cron_expr: cron_expr || null,
      profile_ids: Array.isArray(profile_ids) ? JSON.stringify(profile_ids) : (profile_ids || '[]'),
      data_ids: Array.isArray(data_ids) ? JSON.stringify(data_ids) : (data_ids || '[]'),
      concurrency: parseInt(concurrency) || 1,
      delay_min: parseInt(delay_min) || 30,
      delay_max: parseInt(delay_max) || 90,
      enabled: isEnabled ? 1 : 0,
      status: isEnabled ? 'waiting' : 'disabled',
      platform: normalizePlatform(platform),
      schedule_key: String(schedule_key || '').trim() || null,
      created_by: String(created_by || 'app').trim() || 'app',
    };

    if (params.enabled) assertRowsCanBeScheduled(params);
    const result = stmts.insert.run(params);
    const schedule = this.getById(result.lastInsertRowid);
    markRowsScheduled(schedule);

    // Auto-start if enabled
    if (schedule && schedule.enabled) {
      this.startJob(schedule);
    }

    return schedule;
  },

  /**
   * Update an existing schedule
   */
  update(id, data, platform = null) {
    const existing = this.getById(id, platform);
    if (!existing) return null;
    const existingIds = explicitPostIds(existing);

    // Stop existing job first
    this.stopJob(id);

    const params = {
      id,
      name: data.name || existing.name,
      schedule_time: data.schedule_time !== undefined ? data.schedule_time : existing.schedule_time,
      schedule_type: data.schedule_type || existing.schedule_type,
      cron_expr: data.cron_expr !== undefined ? data.cron_expr : existing.cron_expr,
      profile_ids: data.profile_ids !== undefined
        ? (Array.isArray(data.profile_ids) ? JSON.stringify(data.profile_ids) : data.profile_ids)
        : existing.profile_ids,
      data_ids: data.data_ids !== undefined
        ? (Array.isArray(data.data_ids) ? JSON.stringify(data.data_ids) : data.data_ids)
        : existing.data_ids,
      concurrency: data.concurrency !== undefined ? parseInt(data.concurrency) : existing.concurrency,
      delay_min: data.delay_min !== undefined ? parseInt(data.delay_min) : existing.delay_min,
      delay_max: data.delay_max !== undefined ? parseInt(data.delay_max) : existing.delay_max,
      enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : Number(existing.enabled) === 1 ? 1 : 0,
      status: data.enabled !== undefined
        ? (data.enabled ? 'waiting' : 'disabled')
        : existing.status,
      task_mode: data.task_mode !== undefined
        ? (data.task_mode === 'comment_link' ? 'comment_link' : 'post')
        : (existing.task_mode || 'post'),
      platform: existing.platform,
    };

    if (params.enabled && params.schedule_type === 'once') {
      const target = new Date(params.schedule_time || '').getTime();
      if (!Number.isFinite(target) || target <= Date.now()) {
        throw new Error('Thời gian hẹn đã qua; hãy chọn thời gian mới để chạy lại lịch.');
      }
    }
    if (params.enabled) assertRowsCanBeScheduled(params, existingIds);
    releaseScheduledRows(existing, { clearTime: true });
    stmts.update.run(params);

    const updated = this.getById(id);
    markRowsScheduled(updated);

    // Restart job if enabled
    if (updated && updated.enabled) {
      this.startJob(updated);
    }

    return updated;
  },

  /**
   * Delete a schedule
   */
  delete(id, platform = null) {
    const schedule = this.getById(id, platform);
    if (!schedule) return null;
    this.stopJob(id);
    releaseScheduledRows(schedule, { clearTime: true });
    return stmts.delete.run(id);
  },

  /**
   * Toggle enabled state
   */
  toggle(id, platform = null) {
    const schedule = this.getById(id, platform);
    if (!schedule) return null;

    const newEnabled = schedule.enabled ? 0 : 1;
    if (newEnabled) assertRowsCanBeScheduled({ ...schedule, enabled: 1 });
    stmts.toggleEnabled.run(newEnabled, id);

    if (newEnabled) {
      const updated = this.getById(id);
      stmts.updateStatus.run('waiting', id);
      markRowsScheduled(updated);
      this.startJob(updated);
    } else {
      this.stopJob(id);
      stmts.updateStatus.run('disabled', id);
      releaseScheduledRows(schedule, { clearTime: true });
    }

    return this.getById(id);
  },

  /**
   * Start a job based on schedule type
   */
  startJob(schedule) {
    // Stop any existing job for this ID first
    this.stopJob(schedule.id);

    const jobEntry = { job: null, timeout: null };

    try {
      let started = false;
      switch (schedule.schedule_type) {
        case 'once':
          started = this._startOnceJob(schedule, jobEntry);
          break;

        case 'daily':
          started = this._startDailyJob(schedule, jobEntry);
          break;

        case 'custom':
          started = this._startCustomJob(schedule, jobEntry);
          break;

        default:
          console.warn(`[Scheduler] Loại lịch không hợp lệ: ${schedule.schedule_type}`);
          return;
      }

      if (!started) return;
      activeJobs.set(schedule.id, jobEntry);
      stmts.updateStatus.run('waiting', schedule.id);
      console.log(`[Scheduler] Đã bắt đầu job #${schedule.id} (${schedule.name}) - ${schedule.schedule_type}`);
    } catch (err) {
      console.error(`[Scheduler] Lỗi khi tạo job #${schedule.id}:`, err.message);
      stmts.updateStatus.run('error', schedule.id);
    }
  },

  /**
   * Start a one-time job using setTimeout
   */
  _startOnceJob(schedule, jobEntry) {
    if (!schedule.schedule_time) {
      console.warn(`[Scheduler] Job #${schedule.id} không có thời gian hẹn`);
      stmts.updateStatus.run('error', schedule.id);
      return false;
    }

    const targetTime = new Date(schedule.schedule_time).getTime();
    const now = Date.now();
    const delay = targetTime - now;

    if (delay <= 0) {
      // Already past when the app started: it never ran, so mark as missed
      // (NOT completed) so the status reflects reality. Re-arm via "Chạy lại".
      console.log(`[Scheduler] Job #${schedule.id} đã quá hạn khi khởi động, đánh dấu chưa chạy (missed)`);
      stmts.updateStatus.run('missed', schedule.id);
      stmts.toggleEnabled.run(0, schedule.id);
      releaseScheduledRows(schedule, { clearTime: true });
      return false;
    }

    // Re-arm long waits instead of running early when the target is farther
    // away than Node's maximum safe setTimeout duration (~24.8 days).
    const arm = () => {
      const remaining = targetTime - Date.now();
      if (remaining > 0) {
        jobEntry.timeout = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT));
        return;
      }
      Promise.resolve(this._executeJob(schedule)).then(succeeded => {
        if (succeeded) stmts.updateStatus.run('completed', schedule.id);
        stmts.toggleEnabled.run(0, schedule.id);
        activeJobs.delete(schedule.id);
      });
    };
    arm();

    const targetDate = new Date(targetTime);
    console.log(`[Scheduler] Job #${schedule.id} sẽ chạy lúc ${targetDate.toLocaleString('vi-VN')}`);
    return true;
  },

  /**
   * Start a daily recurring job using node-cron
   */
  _startDailyJob(schedule, jobEntry) {
    let cronExpr;

    if (schedule.schedule_time) {
      // Parse HH:MM or full datetime to get hours/minutes
      const timeStr = schedule.schedule_time;
      let hours, minutes;

      if (timeStr.includes('T')) {
        // Full datetime format
        const d = new Date(timeStr);
        hours = d.getHours();
        minutes = d.getMinutes();
      } else if (timeStr.includes(':')) {
        // HH:MM format
        const parts = timeStr.split(':');
        hours = parseInt(parts[0]);
        minutes = parseInt(parts[1]);
      } else {
        hours = 8;
        minutes = 0;
      }

      cronExpr = `${minutes} ${hours} * * *`;
    } else {
      // Default to 8:00 AM
      cronExpr = '0 8 * * *';
    }

    if (!cron.validate(cronExpr)) {
      console.warn(`[Scheduler] Cron expression không hợp lệ cho job #${schedule.id}: ${cronExpr}`);
      stmts.updateStatus.run('error', schedule.id);
      return false;
    }

    jobEntry.job = cron.schedule(cronExpr, () => {
      this._executeJob(schedule);
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log(`[Scheduler] Job #${schedule.id} hàng ngày: ${cronExpr}`);
    return true;
  },

  /**
   * Start a custom cron job
   */
  _startCustomJob(schedule, jobEntry) {
    const cronExpr = schedule.cron_expr;

    if (!cronExpr || !cron.validate(cronExpr)) {
      console.warn(`[Scheduler] Cron expression không hợp lệ cho job #${schedule.id}: ${cronExpr}`);
      stmts.updateStatus.run('error', schedule.id);
      return false;
    }

    jobEntry.job = cron.schedule(cronExpr, () => {
      this._executeJob(schedule);
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log(`[Scheduler] Job #${schedule.id} tùy chỉnh: ${cronExpr}`);
    return true;
  },

  /**
   * Execute the scheduled job - calls RunnerService
   */
  async _executeJob(schedule) {
    console.log(`[Scheduler] ⏰ Đang chạy job #${schedule.id}: ${schedule.name}`);

    // Đúng thời điểm hẹn mới đưa hàng về Chờ để runner có thể nhận.
    releaseScheduledRows(schedule, {
      clearTime: false,
      note: `Đã đến giờ hẹn ${scheduledTimeLabel(schedule)}; đang chờ runner`,
    });

    // Update status
    stmts.updateLastRun.run('running', schedule.id);

    try {
      // Lazy-load RunnerService to avoid circular deps
      const RunnerManager = require('./runner-manager.service');
      const RunnerService = RunnerManager.get(schedule.platform);

      // Parse profile and data IDs
      let profileIds = [];
      let dataIds = [];

      try {
        profileIds = JSON.parse(schedule.profile_ids || '[]');
      } catch (e) {
        profileIds = [];
      }
      if (schedule.data_ids === 'all' || schedule.data_ids === '*') {
        dataIds = 'all';
      } else {
        try {
          dataIds = JSON.parse(schedule.data_ids || '[]');
        } catch (e) {
          dataIds = [];
        }
      }

      const maxPostsPerProfile = getPostsPerRunSetting(schedule.platform);

      // Runner ban (dang dang Fanpage/bai khac cung nen tang) -> doi, khong bao loi.
      const allowed = await this._waitForRunner(schedule, RunnerService);
      if (!allowed) {
        throw new Error(`Runner ${schedule.platform} bận quá lâu; lịch chưa được chạy.`);
      }

      // Start runner with schedule config
      const result = await RunnerService.start({
        profileIds,
        dataIds,
        concurrency: schedule.concurrency || 1,
        delayMin: schedule.delay_min || 30,
        delayMax: schedule.delay_max || 90,
        maxPostsPerProfile,
        taskMode: schedule.task_mode || 'post',
      });
      if (!result || result.success === false) {
        throw new Error(result && result.message
          ? result.message
          : 'Runner did not start or completed without a successful result.');
      }

      // Đánh giá kết quả thực tế từ summary {total, completed, errors}.
      // Chỉ coi là hoàn tất khi có bài chạy và KHÔNG có bài nào lỗi.
      const total = Number(result.total) || 0;
      const done = Number(result.completed) || 0;
      const errors = Number(result.errors) || 0;
      const ok = total > 0 && errors === 0;

      if (!ok) {
        const reason = total === 0
          ? 'không có bài nào để đăng'
          : `${done}/${total} thành công, ${errors} lỗi`;
        recordScheduleActivity(
          schedule,
          `Lịch #${schedule.id} "${schedule.name}" chưa hoàn tất: ${reason}.`,
          'error'
        );
        // Recurring quay về chờ để chạy lượt sau; once đánh lỗi.
        stmts.updateStatus.run(schedule.schedule_type !== 'once' ? 'waiting' : 'error', schedule.id);
        return false;
      }

      // Thành công: recurring quay về chờ; once sẽ được đánh 'completed' ở arm().
      if (schedule.schedule_type !== 'once') {
        stmts.updateStatus.run('waiting', schedule.id);
      }

      console.log(`[Scheduler] ✅ Job #${schedule.id} đã hoàn tất (${done}/${total})`);
      return true;
    } catch (err) {
      console.error(`[Scheduler] ❌ Job #${schedule.id} lỗi:`, err.message);
      recordScheduleActivity(schedule, `Lịch #${schedule.id} "${schedule.name}" lỗi: ${err.message}`, 'error');
      // For recurring jobs, set back to waiting so they run again
      if (schedule.schedule_type !== 'once') {
        stmts.updateStatus.run('waiting', schedule.id);
      } else {
        stmts.updateStatus.run('error', schedule.id);
      }
      return false;
    }
  },

  /**
   * Stop a job by ID
   */
  stopJob(id) {
    const entry = activeJobs.get(id);
    if (!entry) return;

    // Stop cron job
    if (entry.job) {
      try {
        entry.job.stop();
      } catch (e) { /* ignore */ }
    }

    // Clear timeout
    if (entry.timeout) {
      clearTimeout(entry.timeout);
    }

    activeJobs.delete(id);
    console.log(`[Scheduler] Đã dừng job #${id}`);
  },

  /**
   * Initialize all enabled jobs on server startup
   */
  initAllJobs() {
    try {
      // Sửa dữ liệu lịch cũ bị "hoàn tất" sai (once chưa từng chạy) trước khi khởi tạo.
      try {
        const fixed = stmts.fixMissedCompleted.run();
        if (fixed && fixed.changes) {
          console.log(`[Scheduler] Đã sửa ${fixed.changes} lịch once "hoàn tất" sai thành "chưa chạy"`);
        }
      } catch (e) { console.error('[Scheduler] Lỗi sửa trạng thái lịch cũ:', e.message); }

      const enabledSchedules = stmts.getEnabled.all();
      console.log(`[Scheduler] Đang khởi tạo ${enabledSchedules.length} job...`);

      for (const schedule of enabledSchedules) {
        markRowsScheduled(schedule);
        this.startJob(schedule);
      }

      console.log(`[Scheduler] ✅ Đã khởi tạo xong tất cả job`);
    } catch (err) {
      console.error('[Scheduler] Lỗi khi khởi tạo jobs:', err.message);
    }
  },

  /**
   * Stop all active jobs (for graceful shutdown)
   */
  stopAllJobs() {
    for (const [id] of activeJobs) {
      this.stopJob(id);
    }
    console.log('[Scheduler] Đã dừng tất cả jobs');
  },

  /**
   * Get count of active jobs
   */
  getActiveJobCount() {
    return activeJobs.size;
  },
};

module.exports = SchedulerService;
