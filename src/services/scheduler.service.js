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
      schedule_key, created_by
    )
    VALUES (
      @name, @schedule_time, @schedule_type, @cron_expr, @profile_ids, @data_ids,
      @concurrency, @delay_min, @delay_max, @enabled, @status, @platform,
      @schedule_key, @created_by
    )
  `),
  update: db.prepare(`
    UPDATE schedules SET name = @name, schedule_time = @schedule_time, schedule_type = @schedule_type,
    cron_expr = @cron_expr, profile_ids = @profile_ids, data_ids = @data_ids,
    concurrency = @concurrency, delay_min = @delay_min, delay_max = @delay_max,
    enabled = @enabled, status = @status
    WHERE id = @id
  `),
  delete: db.prepare('DELETE FROM schedules WHERE id = ?'),
  toggleEnabled: db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?'),
  updateStatus: db.prepare('UPDATE schedules SET status = ? WHERE id = ?'),
  updateLastRun: db.prepare('UPDATE schedules SET last_run = datetime("now"), status = ? WHERE id = ?'),
  getEnabled: db.prepare('SELECT * FROM schedules WHERE enabled = 1'),
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
  }) {
    const isEnabled = enabled !== false && enabled !== 0;
    const params = {
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

    const result = stmts.insert.run(params);
    const schedule = this.getById(result.lastInsertRowid);

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
    };

    stmts.update.run(params);

    const updated = this.getById(id);

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
    if (!this.getById(id, platform)) return null;
    this.stopJob(id);
    return stmts.delete.run(id);
  },

  /**
   * Toggle enabled state
   */
  toggle(id, platform = null) {
    const schedule = this.getById(id, platform);
    if (!schedule) return null;

    const newEnabled = schedule.enabled ? 0 : 1;
    stmts.toggleEnabled.run(newEnabled, id);

    if (newEnabled) {
      const updated = this.getById(id);
      stmts.updateStatus.run('waiting', id);
      this.startJob(updated);
    } else {
      this.stopJob(id);
      stmts.updateStatus.run('disabled', id);
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
      // Already past, mark as completed
      console.log(`[Scheduler] Job #${schedule.id} đã quá hạn, đánh dấu hoàn tất`);
      stmts.updateStatus.run('completed', schedule.id);
      stmts.toggleEnabled.run(0, schedule.id);
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
      });
      if (!result || result.success === false) {
        throw new Error(result && result.message
          ? result.message
          : 'Runner did not start or completed without a successful result.');
      }

      // Update status after execution (for recurring jobs, set back to waiting)
      if (schedule.schedule_type !== 'once') {
        stmts.updateStatus.run('waiting', schedule.id);
      }

      console.log(`[Scheduler] ✅ Job #${schedule.id} đã hoàn tất`);
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
      const enabledSchedules = stmts.getEnabled.all();
      console.log(`[Scheduler] Đang khởi tạo ${enabledSchedules.length} job...`);

      for (const schedule of enabledSchedules) {
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
