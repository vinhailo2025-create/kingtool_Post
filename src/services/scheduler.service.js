/**
 * CovergemAuto - Scheduler Service
 * Manages scheduled posting jobs using node-cron
 */

const cron = require('node-cron');
const db = require('../database/init');

// Active cron jobs: id -> { job, timeout }
const activeJobs = new Map();

// Prepared statements
const stmts = {
  getAll: db.prepare('SELECT * FROM schedules ORDER BY created_at DESC'),
  getById: db.prepare('SELECT * FROM schedules WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO schedules (name, schedule_time, schedule_type, cron_expr, profile_ids, data_ids, concurrency, delay_min, delay_max, enabled, status)
    VALUES (@name, @schedule_time, @schedule_type, @cron_expr, @profile_ids, @data_ids, @concurrency, @delay_min, @delay_max, @enabled, @status)
  `),
  update: db.prepare(`
    UPDATE schedules SET name = @name, schedule_time = @schedule_time, schedule_type = @schedule_type,
    cron_expr = @cron_expr, profile_ids = @profile_ids, data_ids = @data_ids,
    concurrency = @concurrency, delay_min = @delay_min, delay_max = @delay_max
    WHERE id = @id
  `),
  delete: db.prepare('DELETE FROM schedules WHERE id = ?'),
  toggleEnabled: db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?'),
  updateStatus: db.prepare('UPDATE schedules SET status = ? WHERE id = ?'),
  updateLastRun: db.prepare('UPDATE schedules SET last_run = datetime("now"), status = ? WHERE id = ?'),
  getEnabled: db.prepare('SELECT * FROM schedules WHERE enabled = 1'),
};

const SchedulerService = {
  /**
   * Get all schedules
   */
  getAll() {
    return stmts.getAll.all();
  },

  /**
   * Get single schedule by ID
   */
  getById(id) {
    return stmts.getById.get(id);
  },

  /**
   * Create a new schedule
   */
  create({ name, schedule_time, schedule_type = 'once', cron_expr, profile_ids, data_ids, concurrency = 1, delay_min = 30, delay_max = 90 }) {
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
      enabled: 1,
      status: 'waiting',
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
  update(id, data) {
    const existing = this.getById(id);
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
  delete(id) {
    this.stopJob(id);
    return stmts.delete.run(id);
  },

  /**
   * Toggle enabled state
   */
  toggle(id) {
    const schedule = this.getById(id);
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
      switch (schedule.schedule_type) {
        case 'once':
          this._startOnceJob(schedule, jobEntry);
          break;

        case 'daily':
          this._startDailyJob(schedule, jobEntry);
          break;

        case 'custom':
          this._startCustomJob(schedule, jobEntry);
          break;

        default:
          console.warn(`[Scheduler] Loại lịch không hợp lệ: ${schedule.schedule_type}`);
          return;
      }

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
      return;
    }

    const targetTime = new Date(schedule.schedule_time).getTime();
    const now = Date.now();
    const delay = targetTime - now;

    if (delay <= 0) {
      // Already past, mark as completed
      console.log(`[Scheduler] Job #${schedule.id} đã quá hạn, đánh dấu hoàn tất`);
      stmts.updateStatus.run('completed', schedule.id);
      stmts.toggleEnabled.run(0, schedule.id);
      return;
    }

    // Cap setTimeout at ~24 days (max safe 32-bit int) to avoid overflow
    const safeDelay = Math.min(delay, 2147483647);

    jobEntry.timeout = setTimeout(() => {
      this._executeJob(schedule);
      // One-shot: mark completed and disable
      stmts.updateStatus.run('completed', schedule.id);
      stmts.toggleEnabled.run(0, schedule.id);
      activeJobs.delete(schedule.id);
    }, safeDelay);

    const targetDate = new Date(targetTime);
    console.log(`[Scheduler] Job #${schedule.id} sẽ chạy lúc ${targetDate.toLocaleString('vi-VN')}`);
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
      return;
    }

    jobEntry.job = cron.schedule(cronExpr, () => {
      this._executeJob(schedule);
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log(`[Scheduler] Job #${schedule.id} hàng ngày: ${cronExpr}`);
  },

  /**
   * Start a custom cron job
   */
  _startCustomJob(schedule, jobEntry) {
    const cronExpr = schedule.cron_expr;

    if (!cronExpr || !cron.validate(cronExpr)) {
      console.warn(`[Scheduler] Cron expression không hợp lệ cho job #${schedule.id}: ${cronExpr}`);
      stmts.updateStatus.run('error', schedule.id);
      return;
    }

    jobEntry.job = cron.schedule(cronExpr, () => {
      this._executeJob(schedule);
    }, { timezone: 'Asia/Ho_Chi_Minh' });

    console.log(`[Scheduler] Job #${schedule.id} tùy chỉnh: ${cronExpr}`);
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
      const RunnerService = require('./runner.service');

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

      // Start runner with schedule config
      await RunnerService.start({
        profileIds,
        dataIds,
        concurrency: schedule.concurrency || 1,
        delayMin: schedule.delay_min || 30,
        delayMax: schedule.delay_max || 90,
      });

      // Update status after execution (for recurring jobs, set back to waiting)
      if (schedule.schedule_type !== 'once') {
        stmts.updateStatus.run('waiting', schedule.id);
      }

      console.log(`[Scheduler] ✅ Job #${schedule.id} đã hoàn tất`);
    } catch (err) {
      console.error(`[Scheduler] ❌ Job #${schedule.id} lỗi:`, err.message);
      // For recurring jobs, set back to waiting so they run again
      if (schedule.schedule_type !== 'once') {
        stmts.updateStatus.run('waiting', schedule.id);
      } else {
        stmts.updateStatus.run('error', schedule.id);
      }
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
