/**
 * Super Post - King - Dashboard (đầy đủ: lọc + biểu đồ Chart.js)
 */
const Dashboard = {
  charts: {},
  timer: null,
  mcpRefreshTimer: null,
  data: {},
  filters: { platform: 'all', days: 7, status: 'all', auto: false },
  mcpFilters: { client: 'all', state: 'all' },

  platformLabels() {
    return Object.assign({ all: 'Tất cả' }, App.platformLabels);
  },

  _loadFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem('dash-filters') || '{}');
      this.filters = Object.assign(this.filters, saved);
    } catch (e) {}
    try {
      const saved = JSON.parse(localStorage.getItem('dash-mcp-filters') || '{}');
      this.mcpFilters = Object.assign(this.mcpFilters, saved);
    } catch (e) {}
  },
  _saveFilters() {
    try { localStorage.setItem('dash-filters', JSON.stringify(this.filters)); } catch (e) {}
  },
  _saveMcpFilters() {
    try { localStorage.setItem('dash-mcp-filters', JSON.stringify(this.mcpFilters)); } catch (e) {}
  },

  cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  },

  async load() {
    this._loadFilters();
    this._destroyCharts();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this._renderShell();
    await this._refresh();
    this._setupAuto();
  },

  _setupAuto() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.filters.auto) return;
    this.timer = setInterval(() => {
      const pg = document.getElementById('page-dashboard');
      if (pg && pg.classList.contains('active')) this._refresh();
    }, 30000);
  },

  onFilterChange() {
    const pf = document.getElementById('df-platform');
    const dv = document.getElementById('df-days');
    const st = document.getElementById('df-status');
    const au = document.getElementById('df-auto');
    if (pf) this.filters.platform = pf.value;
    if (dv) this.filters.days = Number(dv.value) || 7;
    if (st) this.filters.status = st.value;
    if (au) this.filters.auto = au.checked;
    this._saveFilters();
    this._setupAuto();
    this._refresh();
  },

  onMcpFilterChange() {
    const client = document.getElementById('dash-mcp-filter-client');
    const state = document.getElementById('dash-mcp-filter-state');
    if (client) this.mcpFilters.client = client.value;
    if (state) this.mcpFilters.state = state.value;
    this._saveMcpFilters();
    this._renderMcpOverview();
  },

  async refreshMcp() {
    try {
      const response = await apiSilent('/api/settings/agent-mcp/status');
      this.data.agentMcp = response.data || null;
    } catch (_) {
      this.data.agentMcp = null;
    }
    this._renderMcpOverview();
  },

  onAgentEvent() {
    clearTimeout(this.mcpRefreshTimer);
    this.mcpRefreshTimer = setTimeout(() => {
      const page = document.getElementById('page-dashboard');
      if (page?.classList.contains('active')) this.refreshMcp();
    }, 250);
  },

  _q() {
    return `platform=${encodeURIComponent(this.filters.platform)}&days=${this.filters.days}`;
  },

  async _refresh() {
    try {
      const [summary, ts, byPlat, byProv, upcoming, alerts, activity, agentMcp] = await Promise.all([
        apiSilent(`/api/stats/summary?${this._q()}`),
        apiSilent(`/api/stats/timeseries?${this._q()}`),
        apiSilent(`/api/stats/by-platform?days=${this.filters.days}`),
        apiSilent('/api/stats/by-provider'),
        apiSilent(`/api/stats/upcoming?platform=${this.filters.platform}`),
        apiSilent(`/api/stats/alerts?platform=${this.filters.platform}`),
        apiSilent(`/api/stats/activity?platform=${this.filters.platform}&status=${this.filters.status}&limit=15`),
        apiSilent('/api/settings/agent-mcp/status').catch(() => ({ data: null })),
      ]);
      this.data = {
        summary: summary.data || {},
        ts: ts.data || [],
        byPlat: byPlat.data || [],
        byProv: byProv.data || [],
        upcoming: upcoming.data || [],
        alerts: alerts.data || {},
        activity: activity.data || [],
        agentMcp: agentMcp.data || null,
      };
      this._renderKPIs();
      this._renderPlatformGrid();
      this._renderMcpOverview();
      this._renderCharts();
      this._renderAlerts();
      this._renderUpcoming();
      this._renderActivity();
    } catch (err) {
      console.error('Dashboard refresh error:', err);
    }
  },

  // ---------- Shell ----------
  _renderShell() {
    const pl = this.platformLabels();
    const opt = (v, label, cur) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
    const container = document.getElementById('page-dashboard');
    container.innerHTML = `
      <div class="dash-filters">
        <div class="df-group">
          <label>Nền tảng</label>
          <select id="df-platform" class="form-select" onchange="Dashboard.onFilterChange()">
            ${['all', ...App.platforms].map((p) => opt(p, pl[p] || p, this.filters.platform)).join('')}
          </select>
        </div>
        <div class="df-group">
          <label>Thời gian</label>
          <select id="df-days" class="form-select" onchange="Dashboard.onFilterChange()">
            ${opt(1, 'Hôm nay', this.filters.days)}${opt(7, '7 ngày', this.filters.days)}${opt(30, '30 ngày', this.filters.days)}${opt(90, '90 ngày', this.filters.days)}
          </select>
        </div>
        <div class="df-group">
          <label>Trạng thái</label>
          <select id="df-status" class="form-select" onchange="Dashboard.onFilterChange()">
            ${opt('all', 'Tất cả', this.filters.status)}${opt('success', 'Thành công', this.filters.status)}${opt('error', 'Lỗi', this.filters.status)}${opt('info', 'Thông tin', this.filters.status)}
          </select>
        </div>
        <label class="df-toggle"><input type="checkbox" id="df-auto" ${this.filters.auto ? 'checked' : ''} onchange="Dashboard.onFilterChange()"> Tự làm mới</label>
        <div class="df-spacer"></div>
        <button class="btn btn-secondary btn-sm" onclick="Dashboard._refresh()">🔄 Làm mới</button>
        <button class="btn btn-secondary btn-sm" onclick="Dashboard.exportCSV()">📤 Xuất CSV</button>
      </div>

      <div class="dash-kpi-strip" id="kpi-row"></div>

      <section class="platform-grid" id="platform-grid" aria-label="Bài đăng theo nền tảng"></section>

      <div id="alert-box"></div>

      <section class="dash-mcp-panel" id="dash-mcp-panel" aria-label="Thống kê Agent và MCP"></section>

      <div class="dash-charts">
        <div class="card chart-card" style="grid-column: span 2;">
          <div class="card-header"><div class="card-title">📈 Bài đăng theo ngày</div></div>
          <div class="chart-box"><canvas id="chart-line"></canvas></div>
        </div>
        <div class="card chart-card">
          <div class="card-header"><div class="card-title">🗂️ Kho dữ liệu</div></div>
          <div class="chart-box"><canvas id="chart-store"></canvas></div>
        </div>
        <div class="card chart-card">
          <div class="card-header"><div class="card-title">🌐 Profile theo provider</div></div>
          <div class="chart-box"><canvas id="chart-prov"></canvas></div>
        </div>
      </div>

      <div class="grid-2 mb-20">
        <div class="card">
          <div class="card-header"><div class="card-title">⏰ Lịch sắp chạy</div></div>
          <div id="upcoming-box"></div>
        </div>
        <div class="card">
          <div class="card-header"><div class="card-title">🕐 Hoạt động gần đây</div></div>
          <div id="activity-box"></div>
        </div>
      </div>
    `;
  },

  // ---------- KPIs ----------
  _delta(v) {
    if (v === 0 || v == null) return `<span class="kpi-delta">—</span>`;
    const up = v > 0;
    return `<span class="kpi-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(v)}%</span>`;
  },

  _renderKPIs() {
    const s = this.data.summary || {};
    const chip = (icon, value, label, delta, extra = '') => `
      <div class="kpi-chip${extra ? ' ' + extra : ''}">
        <div class="kpi-chip-icon">${icon}</div>
        <div class="kpi-chip-body">
          <div class="kpi-chip-value">${value}</div>
          <div class="kpi-chip-label">${label}</div>
        </div>
        ${delta || ''}
      </div>`;
    document.getElementById('kpi-row').innerHTML =
      chip('✅', s.successPosts ?? 0, 'Bài thành công', '') +
      chip('🎯', (s.successRate ?? 0) + '%', 'Tỷ lệ thành công', '') +
      chip('🌐', `${s.activeProfiles ?? 0}<span class="kpi-chip-sub">/${s.totalProfiles ?? 0}</span>`, 'Profile hoạt động') +
      chip('⏰', s.upcomingSchedules ?? 0, 'Lịch đang bật') +
      chip('💬', s.commentQueue ?? 0, 'Hàng đợi bình luận');
  },

  _platformIcon(p) {
    const src = ({
      facebook: '/assets/platforms/facebook.webp', tiktok: '/assets/platforms/tiktok.png',
      youtube: '/assets/platforms/youtube.webp', threads: '/assets/platforms/threads.png',
      instagram: '/assets/platforms/instagram.png', x: '/assets/platforms/x.png',
      zalovideo: '/assets/platforms/zalo-video.svg',
    })[p];
    if (!src) return '🌐';
    return `<span class="platform-icon platform-icon-${p}"><img src="${src}" alt=""></span>`;
  },

  _goPlatform(p) {
    const sel = document.getElementById('df-platform');
    if (sel) { sel.value = p; this.onFilterChange(); }
  },

  _renderPlatformGrid() {
    const box = document.getElementById('platform-grid');
    if (!box) return;
    const rows = Array.isArray(this.data.byPlat) ? this.data.byPlat : [];
    const pl = this.platformLabels();
    const active = this.filters.platform;
    const total = rows.reduce((a, x) => a + (x.success || 0) + (x.error || 0), 0);
    const card = (p, label, icon, success, error, isAll) => {
      const attempts = success + error;
      const rate = attempts > 0 ? Math.round((success / attempts) * 100) : 0;
      return `
      <button type="button" class="platform-card${active === p ? ' is-active' : ''}"
              onclick="Dashboard._goPlatform('${p}')" title="Xem chi tiết ${this._esc(label)}">
        <div class="platform-card-top">
          <span class="platform-ico">${icon}</span>
          <span class="platform-name">${this._esc(label)}</span>
        </div>
        <div class="platform-count">${success}<span class="platform-count-sub">bài${isAll ? '' : ' đăng'}</span></div>
        <div class="platform-rate-bar"><span style="width:${rate}%"></span></div>
      </button>`;
    };
    const allCard = card('all', 'Tất cả', '🧮',
      rows.reduce((a, x) => a + (x.success || 0), 0),
      rows.reduce((a, x) => a + (x.error || 0), 0), true);
    const platCards = rows
      .filter(x => (x.success || 0) + (x.error || 0) > 0 || active === 'all')
      .map(x => card(x.platform, pl[x.platform] || x.platform, this._platformIcon(x.platform), x.success || 0, x.error || 0))
      .join('');
    box.innerHTML = total === 0 && active === 'all'
      ? '<div class="platform-empty text-muted text-sm">Chưa có bài đăng nào trong khoảng thời gian này</div>'
      : allCard + platCards;
  },

  _renderMcpOverview() {
    const root = document.getElementById('dash-mcp-panel');
    if (!root) return;
    const value = this.data.agentMcp;

    if (!value) {
      root.innerHTML = `
        <div class="dash-mcp-bar is-empty">
          <span class="dash-mcp-bar-title"><span class="status-dot offline"></span>Agent &amp; MCP</span>
          <span class="dash-mcp-bar-note">Chưa đọc được thống kê</span>
          <button class="btn btn-secondary btn-sm" type="button" onclick="Dashboard.refreshMcp()">Thử lại</button>
        </div>`;
      return;
    }

    const realtime = value.realtime || {};
    const allClients = Array.isArray(value.clients) ? value.clients : [];
    const connected = allClients.filter(client => client.configured).length;
    const lastError = realtime.last_error;
    const online = !!realtime.realtime;

    root.innerHTML = `
      <div class="dash-mcp-bar">
        <span class="dash-mcp-bar-title ${online ? 'is-online' : ''}">
          <span class="status-dot ${online ? 'online' : 'offline'}"></span>Agent &amp; MCP
        </span>
        <span class="dash-mcp-bar-item"><strong>${Number(realtime.running_jobs) || 0}</strong> chạy</span>
        <span class="dash-mcp-bar-item"><strong>${Number(realtime.queued_jobs) || 0}</strong> chờ</span>
        <span class="dash-mcp-bar-item"><strong>${connected}/${allClients.length}</strong> client</span>
        <span class="dash-mcp-bar-item">event <strong>${Number(realtime.last_event_id) || 0}</strong></span>
        ${lastError
          ? `<span class="dash-mcp-bar-err" title="${this._esc(lastError.error || '')}">⚠ ${this._esc(lastError.profile || lastError.platform || 'Agent')} · ${this._esc(lastError.error || 'Không rõ lỗi')}</span>`
          : '<span class="dash-mcp-bar-ok">Không lỗi gần đây</span>'}
        <button class="btn btn-secondary btn-sm dash-mcp-bar-btn" type="button" onclick="Dashboard.refreshMcp()">Làm mới</button>
      </div>`;
  },

  // ---------- Charts ----------
  _destroyCharts() {
    Object.values(this.charts).forEach((c) => { try { c.destroy(); } catch (e) {} });
    this.charts = {};
  },

  _palette() {
    return {
      accent: this.cssVar('--accent', '#6366f1'),
      success: this.cssVar('--success', '#22c55e'),
      error: this.cssVar('--error', '#ef4444'),
      warning: this.cssVar('--warning', '#f59e0b'),
      info: this.cssVar('--info', '#3b82f6'),
      grid: this.cssVar('--border-color', '#2a2d3e'),
      text: this.cssVar('--text-secondary', '#94a3b8'),
    };
  },

  _renderCharts() {
    if (typeof Chart === 'undefined') return;
    this._destroyCharts();
    const c = this._palette();
    Chart.defaults.color = c.text;
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    const d = this.data;

    // Line
    const labels = d.ts.map((x) => { const p = x.date.split('-'); return `${p[2]}/${p[1]}`; });
    this.charts.line = new Chart(document.getElementById('chart-line'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          this._area('Thành công', d.ts.map((x) => x.success), c.success),
          this._area('Lỗi', d.ts.map((x) => x.error), c.error),
        ],
      },
      options: this._lineOpts(c),
    });

    // Store status
    const s = d.summary || {};
    const st = s.postStore || { pending: 0, success: 0, error: 0 };
    this.charts.store = new Chart(document.getElementById('chart-store'), {
      type: 'doughnut',
      data: {
        labels: ['Chờ', 'Thành công', 'Lỗi'],
        datasets: [{ data: [st.pending || 0, st.success || 0, st.error || 0], backgroundColor: [c.warning, c.success, c.error], borderWidth: 0 }],
      },
      options: this._donutOpts(''),
    });

    // Provider
    this.charts.prov = new Chart(document.getElementById('chart-prov'), {
      type: 'bar',
      data: {
        labels: d.byProv.map((x) => x.provider),
        datasets: [{ label: 'Số profile', data: d.byProv.map((x) => x.count), backgroundColor: c.accent, borderRadius: 4 }],
      },
      options: this._barOpts(c),
    });
  },

  _area(label, data, color) {
    return { label, data, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.35, borderWidth: 2, pointRadius: 2 };
  },
  _lineOpts(c) {
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { grid: { color: c.grid } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: c.grid } },
      },
    };
  },
  _barOpts(c) {
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: c.grid } },
      },
    };
  },
  _donutOpts(center) {
    return {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom' }, title: center ? { display: true, text: center, position: 'bottom' } : undefined },
    };
  },

  // ---------- Alerts / Upcoming / Activity ----------
  _renderAlerts() {
    const a = this.data.alerts || {};
    const box = document.getElementById('alert-box');
    const items = [];
    if (a.overdueSchedules > 0) items.push(`⏰ ${a.overdueSchedules} lịch quá hạn chưa chạy`);
    box.innerHTML = items.length
      ? `<div class="alert-banner">${items.map((t) => `<span>${t}</span>`).join('')}</div>`
      : '';
  },

  _renderUpcoming() {
    const list = this.data.upcoming || [];
    const box = document.getElementById('upcoming-box');
    if (!list.length) { box.innerHTML = '<div class="text-muted text-sm" style="padding:16px 0;text-align:center">Không có lịch nào đang bật</div>'; return; }
    const pl = this.platformLabels();
    box.innerHTML = `<div class="dash-list">${list.map((s) => `
      <div class="dash-list-item">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${this._esc(s.name || 'Lịch')}</div>
          <div class="text-muted text-sm">${pl[s.platform] || s.platform} · ${s.type === 'once' ? formatDate(s.next) : (s.type === 'daily' ? 'Hàng ngày' : 'Cron ' + (s.cron || ''))}</div>
        </div>
        ${s.overdue ? '<span class="badge badge-error">Quá hạn</span>' : '<span class="badge badge-pending">Chờ</span>'}
      </div>`).join('')}</div>`;
  },

  _renderActivity() {
    const list = this.data.activity || [];
    const box = document.getElementById('activity-box');
    if (!list.length) { box.innerHTML = '<div class="text-muted text-sm" style="padding:16px 0;text-align:center">Chưa có hoạt động</div>'; return; }
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️', running: '🔄' };
    box.innerHTML = `<div class="activity-list">${list.map((a) => `
      <div class="activity-item">
        <div class="activity-icon">${icons[a.status] || '📋'}</div>
        <div class="activity-time">${a.created_at ? formatTime(a.created_at) : ''}</div>
        <div style="flex:1;min-width:0">
          <span style="color:var(--accent);font-weight:600;margin-right:6px">${this._esc(a.profile_name || 'Hệ thống')}</span>
          <span style="color:var(--text-secondary)">${this._esc(a.message || '')}</span>
        </div>
        ${statusBadge(a.status)}
      </div>`).join('')}</div>`;
  },

  // ---------- CSV ----------
  exportCSV() {
    const s = this.data.summary || {};
    const rows = [
      ['Chỉ số', 'Giá trị'],
      ['Nền tảng', this.filters.platform],
      ['Khoảng ngày', this.filters.days],
      ['Bài thành công', s.successPosts || 0],
      ['Lỗi', s.errorPosts || 0],
      ['Tỷ lệ thành công (%)', s.successRate || 0],
      ['Profile hoạt động', `${s.activeProfiles || 0}/${s.totalProfiles || 0}`],
      [],
      ['Ngày', 'Thành công', 'Lỗi'],
      ...(this.data.ts || []).map((x) => [x.date, x.success, x.error]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dashboard_${this.filters.platform}_${this.filters.days}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },

  _esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
