/**
 * Super Post - King - Scheduler Routes
 * REST API for managing scheduled posting jobs
 */

const express = require('express');
const router = express.Router();
const SchedulerService = require('../services/scheduler.service');
const platformOf = req => req.query.platform || req.body?.platform || 'facebook';

/**
 * GET / - List all schedules
 */
router.get('/', (req, res) => {
  try {
    const schedules = SchedulerService.getAll(platformOf(req));
    res.json({ success: true, data: schedules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST / - Create a new schedule
 */
router.post('/', (req, res) => {
  try {
    const { name, schedule_time, schedule_type, cron_expr, profile_ids, data_ids, concurrency, delay_min, delay_max } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Tên lịch không được để trống' });
    }

    const schedule = SchedulerService.create({
      name,
      schedule_time,
      schedule_type,
      cron_expr,
      profile_ids,
      data_ids,
      concurrency,
      delay_min,
      delay_max,
      platform: platformOf(req),
    });

    // Broadcast log
    req.app.locals.broadcastLog({
      type: 'schedule',
      message: `Đã tạo lịch: ${schedule.name}`,
      status: 'info',
      time: new Date().toISOString(),
      platform: platformOf(req),
    });

    res.json({ success: true, data: schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /:id - Update a schedule
 */
router.put('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const schedule = SchedulerService.update(id, req.body, platformOf(req));

    if (!schedule) {
      return res.status(404).json({ error: 'Không tìm thấy lịch' });
    }

    req.app.locals.broadcastLog({
      type: 'schedule',
      message: `Đã cập nhật lịch: ${schedule.name}`,
      status: 'info',
      time: new Date().toISOString(),
      platform: platformOf(req),
    });

    res.json({ success: true, data: schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /:id - Delete a schedule
 */
router.delete('/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const schedule = SchedulerService.getById(id, platformOf(req));

    if (!schedule) {
      return res.status(404).json({ error: 'Không tìm thấy lịch' });
    }

    SchedulerService.delete(id, platformOf(req));

    req.app.locals.broadcastLog({
      type: 'schedule',
      message: `Đã xóa lịch: ${schedule.name}`,
      status: 'warning',
      time: new Date().toISOString(),
      platform: platformOf(req),
    });

    res.json({ success: true, message: 'Đã xóa lịch' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /:id/toggle - Toggle enabled state
 */
router.patch('/:id/toggle', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const schedule = SchedulerService.toggle(id, platformOf(req));

    if (!schedule) {
      return res.status(404).json({ error: 'Không tìm thấy lịch' });
    }

    req.app.locals.broadcastLog({
      type: 'schedule',
      message: `${schedule.enabled ? 'Bật' : 'Tắt'} lịch: ${schedule.name}`,
      status: schedule.enabled ? 'success' : 'warning',
      time: new Date().toISOString(),
      platform: platformOf(req),
    });

    res.json({ success: true, data: schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
