/**
 * CovergemAuto - Stats Service
 * Provides dashboard statistics and activity data
 */

const db = require('../database/init');

const StatsService = {
  /**
   * Get dashboard summary stats
   */
  getSummary() {
    // Total posts
    const totalPosts = db.prepare('SELECT COUNT(*) as count FROM posts').get().count;

    // Today's successful posts from activity_logs
    const todayPosts = db.prepare(`
      SELECT COUNT(*) as count FROM activity_logs
      WHERE type = 'post' AND status = 'success'
      AND date(created_at) = date('now')
    `).get().count;

    // This week's successful posts
    const weekPosts = db.prepare(`
      SELECT COUNT(*) as count FROM activity_logs
      WHERE type = 'post' AND status = 'success'
      AND created_at >= datetime('now', '-7 days')
    `).get().count;

    // Success rate
    const totalSuccess = db.prepare(`
      SELECT COUNT(*) as count FROM activity_logs
      WHERE type = 'post' AND status = 'success'
    `).get().count;

    const totalError = db.prepare(`
      SELECT COUNT(*) as count FROM activity_logs
      WHERE type = 'post' AND status = 'error'
    `).get().count;

    const totalAttempts = totalSuccess + totalError;
    const successRate = totalAttempts > 0
      ? Math.round((totalSuccess / totalAttempts) * 100)
      : 0;

    // Active and total profiles
    const activeProfiles = db.prepare(`
      SELECT COUNT(*) as count FROM browsers WHERE status = 'open'
    `).get().count;

    const totalProfiles = db.prepare(`
      SELECT COUNT(*) as count FROM browsers
    `).get().count;

    // Upcoming enabled schedules
    const upcomingSchedules = db.prepare(`
      SELECT COUNT(*) as count FROM schedules WHERE enabled = 1
    `).get().count;

    return {
      totalPosts,
      todayPosts,
      weekPosts,
      successRate,
      totalSuccess,
      totalError,
      activeProfiles,
      totalProfiles,
      upcomingSchedules,
    };
  },

  /**
   * Get daily post chart data for last N days
   */
  getDailyChart(days = 7) {
    const results = [];

    for (let i = days - 1; i >= 0; i--) {
      const row = db.prepare(`
        SELECT COUNT(*) as count FROM activity_logs
        WHERE type = 'post' AND status = 'success'
        AND date(created_at) = date('now', '-' || ? || ' days')
      `).get(i);

      // Get the date string
      const dateRow = db.prepare(`
        SELECT date('now', '-' || ? || ' days') as d
      `).get(i);

      results.push({
        date: dateRow.d,
        count: row.count,
      });
    }

    return results;
  },

  /**
   * Get recent activity with profile name
   */
  getRecentActivity(limit = 10) {
    const activities = db.prepare(`
      SELECT
        a.id,
        a.type,
        a.profile_id,
        a.post_id,
        a.message,
        a.status,
        a.created_at,
        COALESCE(b.name, 'Hệ thống') as profile_name
      FROM activity_logs a
      LEFT JOIN browsers b ON a.profile_id = b.id
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(limit);

    return activities;
  },
};

module.exports = StatsService;
