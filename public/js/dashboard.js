/**
 * CovergemAuto - Dashboard Frontend Module
 * Shows stats, charts, and recent activity
 */

const Dashboard = {
  /**
   * Load all dashboard data and render
   */
  async load() {
    try {
      const [summaryRes, chartRes, activityRes] = await Promise.all([
        api('/api/stats/summary'),
        api('/api/stats/chart'),
        api('/api/stats/activity'),
      ]);

      const summary = summaryRes.data || {};
      const chart = chartRes.data || [];
      const activity = activityRes.data || [];

      this.render(summary, chart, activity);
    } catch (err) {
      console.error('Dashboard load error:', err);
      this.render({}, [], []);
    }
  },

  /**
   * Render the full dashboard
   */
  render(summary, chart, activity) {
    const s = {
      totalPosts: summary.totalPosts || 0,
      todayPosts: summary.todayPosts || 0,
      weekPosts: summary.weekPosts || 0,
      successRate: summary.successRate || 0,
      totalSuccess: summary.totalSuccess || 0,
      totalError: summary.totalError || 0,
      activeProfiles: summary.activeProfiles || 0,
      totalProfiles: summary.totalProfiles || 0,
      upcomingSchedules: summary.upcomingSchedules || 0,
    };

    const container = document.getElementById('page-dashboard');
    container.innerHTML = `
      <!-- Stats Grid -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📝</div>
          <div class="stat-value">${s.todayPosts}</div>
          <div class="stat-label">Bài đăng hôm nay</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📊</div>
          <div class="stat-value">${s.weekPosts}</div>
          <div class="stat-label">Tuần này</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">🌐</div>
          <div class="stat-value">${s.activeProfiles} <span style="font-size: 14px; color: var(--text-muted);">/ ${s.totalProfiles}</span></div>
          <div class="stat-label">Profile hoạt động</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">⏰</div>
          <div class="stat-value">${s.upcomingSchedules}</div>
          <div class="stat-label">Lịch hẹn</div>
        </div>
      </div>

      <!-- Charts Grid -->
      <div class="grid-2 mb-20">
        <!-- Bar Chart -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">📈 Bài đăng 7 ngày qua</div>
          </div>
          ${this._renderBarChart(chart)}
        </div>

        <!-- Donut Chart -->
        <div class="card">
          <div class="card-header">
            <div class="card-title">🎯 Tỷ lệ thành công</div>
          </div>
          ${this._renderDonutChart(s)}
        </div>
      </div>

      <!-- Recent Activity -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">🕐 Hoạt động gần đây</div>
        </div>
        ${this._renderActivity(activity)}
      </div>
    `;
  },

  /**
   * Render CSS bar chart
   */
  _renderBarChart(chart) {
    if (!chart || chart.length === 0) {
      return '<div class="bar-chart" style="align-items: center; justify-content: center;"><span class="text-muted">Chưa có dữ liệu</span></div>';
    }

    const maxCount = Math.max(...chart.map(d => d.count), 1);

    const bars = chart.map(d => {
      const heightPct = maxCount > 0 ? Math.max((d.count / maxCount) * 100, 2) : 2;
      // Format date as dd/mm
      const parts = d.date.split('-');
      const label = parts.length >= 3 ? `${parts[2]}/${parts[1]}` : d.date;

      return `
        <div class="bar-column">
          <div class="bar-value">${d.count}</div>
          <div class="bar" style="height: ${heightPct}%"></div>
          <div class="bar-label">${label}</div>
        </div>
      `;
    }).join('');

    return `<div class="bar-chart">${bars}</div>`;
  },

  /**
   * Render CSS donut chart with conic-gradient
   */
  _renderDonutChart(stats) {
    const total = stats.totalSuccess + stats.totalError;
    const rate = stats.successRate;

    if (total === 0) {
      return `
        <div style="display: flex; align-items: center; gap: 24px; padding: 10px 0;">
          <div class="donut-chart" style="background: conic-gradient(var(--border-color) 0deg 360deg);">
            <div class="donut-center">—</div>
          </div>
          <div>
            <div style="font-size: 14px; color: var(--text-muted); margin-bottom: 12px;">Chưa có dữ liệu</div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                <span style="width: 10px; height: 10px; border-radius: 50%; background: var(--success); display: inline-block;"></span>
                <span style="color: var(--text-secondary);">Thành công: 0</span>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
                <span style="width: 10px; height: 10px; border-radius: 50%; background: var(--error); display: inline-block;"></span>
                <span style="color: var(--text-secondary);">Lỗi: 0</span>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const successDeg = (rate / 100) * 360;

    return `
      <div style="display: flex; align-items: center; gap: 24px; padding: 10px 0;">
        <div class="donut-chart" style="background: conic-gradient(var(--success) 0deg ${successDeg}deg, var(--error) ${successDeg}deg 360deg);">
          <div class="donut-center">${rate}%</div>
        </div>
        <div>
          <div style="font-size: 22px; font-weight: 700; color: var(--text-white); margin-bottom: 4px;">${rate}%</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">Tổng: ${total} lần chạy</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
              <span style="width: 10px; height: 10px; border-radius: 50%; background: var(--success); display: inline-block;"></span>
              <span style="color: var(--text-secondary);">Thành công: ${stats.totalSuccess}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; font-size: 13px;">
              <span style="width: 10px; height: 10px; border-radius: 50%; background: var(--error); display: inline-block;"></span>
              <span style="color: var(--text-secondary);">Lỗi: ${stats.totalError}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Render recent activity list
   */
  _renderActivity(activity) {
    if (!activity || activity.length === 0) {
      return '<div class="text-muted text-sm" style="padding: 20px 0; text-align: center;">Chưa có hoạt động nào</div>';
    }

    const statusIcons = {
      success: '✅',
      error: '❌',
      info: 'ℹ️',
      warning: '⚠️',
      running: '🔄',
    };

    const typeIcons = {
      post: '📝',
      login: '🔑',
      schedule: '⏰',
      browser: '🌐',
      system: '💻',
    };

    let html = '<div class="activity-list">';

    for (const a of activity) {
      const icon = typeIcons[a.type] || statusIcons[a.status] || '📋';
      const time = a.created_at ? formatTime(a.created_at) : '';
      const profileName = a.profile_name || 'Hệ thống';

      html += `
        <div class="activity-item">
          <div class="activity-icon">${icon}</div>
          <div class="activity-time">${time}</div>
          <div style="flex: 1; min-width: 0;">
            <span style="color: var(--accent); font-weight: 600; margin-right: 6px;">${this._escapeHtml(profileName)}</span>
            <span style="color: var(--text-secondary);">${this._escapeHtml(a.message || '')}</span>
          </div>
          ${statusBadge(a.status)}
        </div>
      `;
    }

    html += '</div>';
    return html;
  },

  /**
   * Escape HTML
   */
  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
