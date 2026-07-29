/**
 * CovergemAuto - Stats Routes
 * Dashboard statistics API
 */

const express = require('express');
const router = express.Router();
const StatsService = require('../services/stats.service');

/**
 * GET /summary - Dashboard summary stats
 */
router.get('/summary', (req, res) => {
  try {
    const summary = StatsService.getSummary();
    res.json({ success: true, data: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /chart - Daily post chart data
 */
router.get('/chart', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const chart = StatsService.getDailyChart(days);
    res.json({ success: true, data: chart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /activity - Recent activity list
 */
router.get('/activity', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const activity = StatsService.getRecentActivity(limit);
    res.json({ success: true, data: activity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
