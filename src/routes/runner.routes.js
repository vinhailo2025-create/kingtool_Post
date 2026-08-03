/**
 * Runner Routes - /api/runner
 * Controls starting, stopping, and monitoring automation task execution.
 */

const express = require('express');
const router = express.Router();
const RunnerManager = require('../services/runner-manager.service');
const LicenseService = require('../services/license.service');
const db = require('../database/init');
const platformOf = req => req.query.platform || req.body?.platform || 'facebook';

function settingNumber(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * POST /api/runner/start
 * Start the runner with provided configuration.
 * Returns immediately - tasks run in background with WebSocket log updates.
 *
 * Body: {
 *   profileIds: number[],      - Browser profile IDs to use
 *   dataIds: number[]|'all',   - Post IDs to process, or 'all'
 *   concurrency: number,       - Max concurrent profiles (1-10)
 *   delayMin: number,          - Min delay between posts (seconds)
 *   delayMax: number,          - Max delay between posts (seconds)
 *   profileDelayMin: number,   - Min delay between profiles (seconds)
 *   profileDelayMax: number    - Max delay between profiles (seconds)
 * }
 */
router.post('/start', (req, res) => {
  try {
    const platform = platformOf(req);

    // Kiểm tra license trước khi chạy
    const state = LicenseService.getState();
    if (!state.valid) {
      return res.status(403).json({ error: state.reason || 'License chưa kích hoạt hoặc đã hết hạn.', licenseInvalid: true });
    }
    if (!state.platforms.includes(platform)) {
      return res.status(403).json({ error: `Nền tảng "${platform}" chưa được cấp phép trong gói của bạn.`, platformNotAllowed: true });
    }

    const runnerService = RunnerManager.get(platform);
    const defaults = {
      concurrency: settingNumber('max_concurrency', 2),
      delayMin: settingNumber('default_delay_min', 30),
      delayMax: settingNumber('default_delay_max', 90),
      profileDelayMin: settingNumber('default_profile_delay_min', 10),
      profileDelayMax: settingNumber('default_profile_delay_max', 30),
    };
    const {
      profileIds,
      dataIds,
      concurrency = defaults.concurrency,
      delayMin = defaults.delayMin,
      delayMax = defaults.delayMax,
      profileDelayMin = defaults.profileDelayMin,
      profileDelayMax = defaults.profileDelayMax
    } = req.body;

    // Validate inputs
    if (!profileIds || !Array.isArray(profileIds) || profileIds.length === 0) {
      return res.status(400).json({ error: 'Vui lòng chọn ít nhất 1 profile.' });
    }

    if (!dataIds || (Array.isArray(dataIds) && dataIds.length === 0)) {
      return res.status(400).json({ error: 'Vui lòng chọn dữ liệu bài đăng.' });
    }

    if (runnerService.isRunning) {
      return res.status(400).json({ error: 'Runner đang chạy. Vui lòng dừng trước khi chạy lại.' });
    }

    const config = {
      profileIds: profileIds.map(Number),
      dataIds: dataIds === 'all' ? 'all' : dataIds.map(Number),
      concurrency: Math.min(Math.max(1, Number(concurrency) || defaults.concurrency), 10),
      delayMin: Math.max(0, Number(delayMin) || defaults.delayMin),
      delayMax: Math.max(0, Number(delayMax) || defaults.delayMax),
      profileDelayMin: Math.max(0, Number(profileDelayMin) || defaults.profileDelayMin),
      profileDelayMax: Math.max(0, Number(profileDelayMax) || defaults.profileDelayMax)
    };

    // Ensure max >= min
    if (config.delayMax < config.delayMin) config.delayMax = config.delayMin;
    if (config.profileDelayMax < config.profileDelayMin) config.profileDelayMax = config.profileDelayMin;

    // Start runner asynchronously (don't await - return immediately)
    const broadcastLog = req.app.locals.broadcastLog;
    runnerService.start(config, broadcastLog).catch(err => {
      console.error('Runner error:', err);
      broadcastLog({
        time: new Date().toISOString(),
        profile: null,
        message: `Lỗi runner: ${err.message}`,
        type: 'error',
      event: 'runner_error'
      , platform
      });
    });

    res.json({
      success: true,
      message: 'Runner đã bắt đầu chạy.',
      config
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/runner/stop
 * Stop the runner gracefully.
 */
router.post('/stop', (req, res) => {
  try {
    const runnerService = RunnerManager.get(platformOf(req));
    const result = runnerService.stop();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/runner/status
 * Get current runner status and progress.
 */
router.get('/status', (req, res) => {
  try {
    const runnerService = RunnerManager.get(platformOf(req));
    const status = runnerService.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
