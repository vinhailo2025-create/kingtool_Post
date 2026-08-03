/**
 * CovergemAuto - Stats Service
 * Số liệu dashboard: KPI + so kỳ trước, timeseries, theo nền tảng, kho dữ liệu,
 * provider, lịch sắp chạy, cảnh báo, hoạt động — có lọc nền tảng & khoảng thời gian.
 */

const db = require('../database/init');
let PLATFORMS = ['facebook', 'tiktok', 'youtube', 'instagram', 'threads', 'x'];
try { PLATFORMS = require('../platforms/platform.utils').PLATFORMS || PLATFORMS; } catch (e) {}

function normPlatform(p) {
  return p && p !== 'all' && PLATFORMS.includes(p) ? p : 'all';
}

// Đếm activity_logs type=post theo status trong khoảng [fromDays..toDays) ngày trước
function countPosts(status, fromDays, toDays, platform) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM activity_logs
    WHERE type = 'post' AND status = ?
      AND created_at >= datetime('now', '-' || ? || ' days')
      AND created_at <  datetime('now', '-' || ? || ' days')
      AND (? = 'all' OR platform = ?)
  `).get(status, fromDays, toDays, platform, platform);
  return row ? row.c : 0;
}

const StatsService = {
  getSummary(platform = 'all', days = 7) {
    platform = normPlatform(platform);
    days = Math.max(1, Number(days) || 7);

    const success = countPosts('success', days, 0, platform);
    const error = countPosts('error', days, 0, platform);
    const prevSuccess = countPosts('success', days * 2, days, platform);
    const prevError = countPosts('error', days * 2, days, platform);

    const attempts = success + error;
    const successRate = attempts > 0 ? Math.round((success / attempts) * 100) : 0;
    const prevAttempts = prevSuccess + prevError;
    const prevRate = prevAttempts > 0 ? Math.round((prevSuccess / prevAttempts) * 100) : 0;

    const pctDelta = (cur, prev) => {
      if (prev === 0) return cur > 0 ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 100);
    };

    // Profiles
    let activeProfiles, totalProfiles;
    if (platform === 'all') {
      activeProfiles = db.prepare("SELECT COUNT(*) c FROM browsers WHERE status='open'").get().c;
      totalProfiles = db.prepare('SELECT COUNT(*) c FROM browsers').get().c;
    } else {
      totalProfiles = db.prepare(
        'SELECT COUNT(*) c FROM browser_platforms WHERE platform=? AND enabled=1'
      ).get(platform).c;
      activeProfiles = db.prepare(`
        SELECT COUNT(*) c FROM browser_platforms bp
        JOIN browsers b ON b.id = bp.browser_id
        WHERE bp.platform=? AND bp.enabled=1 AND b.status='open'
      `).get(platform).c;
    }

    const upcomingSchedules = db.prepare(
      'SELECT COUNT(*) c FROM schedules WHERE enabled=1 AND (? = \'all\' OR platform = ?)'
    ).get(platform, platform).c;

    let commentQueue = 0;
    try {
      commentQueue = db.prepare(
        "SELECT COUNT(*) c FROM comment_jobs WHERE status IN ('waiting','running') AND (? = 'all' OR platform = ?)"
      ).get(platform, platform).c;
    } catch (e) {}

    // Kho dữ liệu (posts) theo trạng thái
    const store = { pending: 0, success: 0, error: 0, running: 0 };
    const rows = db.prepare(
      "SELECT status, COUNT(*) c FROM posts WHERE (? = 'all' OR platform = ?) GROUP BY status"
    ).all(platform, platform);
    for (const r of rows) if (r.status in store) store[r.status] = r.c;

    return {
      platform,
      days,
      successPosts: success,
      errorPosts: error,
      successRate,
      deltaSuccess: pctDelta(success, prevSuccess),
      deltaError: pctDelta(error, prevError),
      deltaRate: successRate - prevRate,
      activeProfiles,
      totalProfiles,
      upcomingSchedules,
      commentQueue,
      postStore: store,
    };
  },

  getTimeseries(platform = 'all', days = 7) {
    platform = normPlatform(platform);
    days = Math.max(1, Number(days) || 7);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const dateRow = db.prepare("SELECT date('now', '-' || ? || ' days') d").get(i);
      const cnt = (status) =>
        db.prepare(`
          SELECT COUNT(*) c FROM activity_logs
          WHERE type='post' AND status=?
            AND date(created_at) = date('now', '-' || ? || ' days')
            AND (? = 'all' OR platform = ?)
        `).get(status, i, platform, platform).c;
      out.push({ date: dateRow.d, success: cnt('success'), error: cnt('error') });
    }
    return out;
  },

  getByPlatform(days = 7) {
    days = Math.max(1, Number(days) || 7);
    return PLATFORMS.map((p) => ({
      platform: p,
      success: countPosts('success', days, 0, p),
      error: countPosts('error', days, 0, p),
    }));
  },

  getByProvider() {
    return db
      .prepare("SELECT COALESCE(provider,'chrome') provider, COUNT(*) c FROM browsers GROUP BY provider")
      .all()
      .map((r) => ({ provider: r.provider, count: r.c }));
  },

  getUpcoming(platform = 'all', limit = 8) {
    platform = normPlatform(platform);
    const rows = db.prepare(
      "SELECT * FROM schedules WHERE enabled=1 AND (? = 'all' OR platform = ?) ORDER BY schedule_time ASC LIMIT ?"
    ).all(platform, platform, Math.max(1, Number(limit) || 8));
    const now = Date.now();
    return rows.map((s) => {
      let next = s.schedule_time;
      let overdue = false;
      if (s.schedule_type === 'once' && s.schedule_time) {
        overdue = new Date(s.schedule_time).getTime() < now && s.status !== 'completed';
      }
      return {
        id: s.id,
        name: s.name,
        platform: s.platform || 'facebook',
        type: s.schedule_type,
        next,
        cron: s.cron_expr,
        last_run: s.last_run,
        status: s.status,
        overdue,
      };
    });
  },

  getAlerts(platform = 'all') {
    platform = normPlatform(platform);
    let lostSessions = 0;
    try {
      lostSessions = db.prepare(
        "SELECT COUNT(*) c FROM browser_platforms WHERE session_valid=0 AND enabled=1 AND (? = 'all' OR platform = ?)"
      ).get(platform, platform).c;
    } catch (e) {}
    const overdueSchedules = db.prepare(`
      SELECT COUNT(*) c FROM schedules
      WHERE enabled=1 AND schedule_type='once' AND status!='completed'
        AND schedule_time < datetime('now') AND (? = 'all' OR platform = ?)
    `).get(platform, platform).c;
    return { lostSessions, overdueSchedules };
  },

  getRecentActivity(platform = 'all', status = 'all', limit = 12) {
    platform = normPlatform(platform);
    const st = status && status !== 'all' ? status : 'all';
    return db.prepare(`
      SELECT a.id, a.type, a.profile_id, a.post_id, a.message, a.status, a.created_at, a.platform,
             COALESCE(b.name, 'Hệ thống') AS profile_name
      FROM activity_logs a
      LEFT JOIN browsers b ON a.profile_id = b.id
      WHERE (? = 'all' OR a.platform = ?) AND (? = 'all' OR a.status = ?)
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(platform, platform, st, st, Math.max(1, Number(limit) || 12));
  },

  // Giữ tương thích cũ
  getDailyChart(days = 7) {
    return this.getTimeseries('all', days).map((d) => ({ date: d.date, count: d.success }));
  },
};

module.exports = StatsService;
