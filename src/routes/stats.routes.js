/**
 * Super Post - King - Stats Routes
 * Dashboard statistics API (có lọc nền tảng, khoảng thời gian, trạng thái)
 */

const express = require('express');
const router = express.Router();
const StatsService = require('../services/stats.service');

const P = (req) => req.query.platform || 'all';
const D = (req) => parseInt(req.query.days) || 7;

function wrap(fn) {
  return (req, res) => {
    try {
      res.json({ success: true, data: fn(req) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

router.get('/summary', wrap((req) => StatsService.getSummary(P(req), D(req))));
router.get('/timeseries', wrap((req) => StatsService.getTimeseries(P(req), D(req))));
router.get('/by-platform', wrap((req) => StatsService.getByPlatform(D(req))));
router.get('/post-status', wrap((req) => StatsService.getSummary(P(req), D(req)).postStore));
router.get('/by-provider', wrap(() => StatsService.getByProvider()));
router.get('/upcoming', wrap((req) => StatsService.getUpcoming(P(req), parseInt(req.query.limit) || 8)));
router.get('/alerts', wrap((req) => StatsService.getAlerts(P(req))));
router.get(
  '/activity',
  wrap((req) => StatsService.getRecentActivity(P(req), req.query.status || 'all', parseInt(req.query.limit) || 12))
);

// Tương thích cũ
router.get('/chart', wrap((req) => StatsService.getDailyChart(D(req))));

module.exports = router;
