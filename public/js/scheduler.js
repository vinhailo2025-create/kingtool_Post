/**
 * CovergemAuto - Scheduler Frontend Module
 * UI for managing scheduled posting jobs
 */

const Scheduler = {
  schedules: [],
  profiles: [],

  /**
   * Load schedules and render
   */
  async load() {
    try {
      const [schedRes, profRes] = await Promise.all([
        api('/api/schedules'),
        api('/api/browsers'),
      ]);
      this.schedules = schedRes.data || [];
      this.profiles = profRes.data || [];
      this.renderSchedulesTable(this.schedules);
    } catch (err) {
      console.error('Scheduler load error:', err);
      this.renderSchedulesTable([]);
    }
  },

  renderSchedulesTable(schedules) {
    const container = document.getElementById('page-scheduler');

    if (!schedules || schedules.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⏰</div>
          <div class="empty-text">Chưa có lịch hẹn nào</div>
          <div class="text-muted text-sm">Tạo lịch từ tab Trình duyệt bằng nút Tự động hoá.</div>
        </div>
      `;
      return;
    }

    const typeLabels = {
      once: '<span class="badge badge-pending">Một lần</span>',
      daily: '<span class="badge badge-success">Hàng ngày</span>',
      custom: '<span class="badge badge-running">Cron</span>',
    };
    const statusLabels = {
      waiting: '<span class="badge badge-pending">Đang chờ</span>',
      running: '<span class="badge badge-running">Đang chạy</span>',
      completed: '<span class="badge badge-success">Hoàn tất</span>',
      error: '<span class="badge badge-error">Lỗi</span>',
      disabled: '<span class="badge badge-closed">Tắt</span>',
    };

    const rows = schedules.map(s => {
      let profileIds = [];
      try { profileIds = JSON.parse(s.profile_ids || '[]'); } catch (e) {}
      let timeInfo = '';
      if (s.schedule_type === 'once' && s.schedule_time) {
        timeInfo = formatDate(s.schedule_time);
      } else if (s.schedule_type === 'daily' && s.schedule_time) {
        const time = s.schedule_time.includes('T')
          ? new Date(s.schedule_time).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
          : s.schedule_time;
        timeInfo = `Mỗi ngày ${time}`;
      } else if (s.schedule_type === 'custom' && s.cron_expr) {
        timeInfo = s.cron_expr;
      }
      const lastRun = s.last_run ? formatDate(s.last_run) : 'Chưa chạy';

      return `
        <tr class="schedule-row">
          <td>
            <div class="schedule-name">${this._escapeHtml(s.name)}</div>
            <div class="schedule-details">${this._escapeHtml(s.note || '')}</div>
          </td>
          <td>${typeLabels[s.schedule_type] || this._escapeHtml(s.schedule_type || '')}</td>
          <td>${statusLabels[s.status] || statusBadge(s.status)}</td>
          <td class="browser-cell-muted">${this._escapeHtml(timeInfo)}</td>
          <td>${profileIds.length} profile</td>
          <td class="browser-cell-muted">${this._escapeHtml(lastRun)}</td>
          <td>
            <label class="toggle" title="${s.enabled ? 'Tắt' : 'Bật'}">
              <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="Scheduler.toggleSchedule(${s.id})">
              <span class="toggle-slider"></span>
            </label>
          </td>
          <td>
            <div class="table-actions">
              <button class="btn btn-ghost btn-sm" onclick="Scheduler.showEditModal(${s.id})" title="Chỉnh sửa">Sửa</button>
              <button class="btn btn-ghost btn-sm danger-link" onclick="Scheduler.deleteSchedule(${s.id})" title="Xóa">Xóa</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="lux-panel">
        <div class="lux-panel-title">
          <div>
            <div class="lux-title">Hẹn giờ chạy</div>
            <div class="lux-subtitle">Tổng hợp lịch tạo từ tab Trình duyệt, theo dõi trạng thái và lần chạy cuối.</div>
          </div>
          <span class="badge badge-pending">${schedules.length} lịch</span>
        </div>
        <div class="lux-table-wrap">
          <table class="lux-table scheduler-table">
            <thead>
              <tr>
                <th>Tên lịch</th>
                <th>Loại</th>
                <th>Trạng thái</th>
                <th>Thời gian</th>
                <th>Profile</th>
                <th>Lần chạy cuối</th>
                <th>Bật</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  },

  /**
   * Render schedule list
   */
  renderSchedules(schedules) {
    const container = document.getElementById('page-scheduler');

    if (!schedules || schedules.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⏰</div>
          <div class="empty-text">Chưa có lịch hẹn nào</div>
          <button class="btn btn-primary" onclick="Scheduler.showAddModal()">➕ Tạo lịch đầu tiên</button>
        </div>
      `;
      return;
    }

    const typeLabels = {
      once: '<span class="badge badge-pending">🕐 Một lần</span>',
      daily: '<span class="badge badge-success">🔄 Hàng ngày</span>',
      custom: '<span class="badge badge-running">⚙️ Tùy chỉnh</span>',
    };

    const statusLabels = {
      waiting: '<span class="badge badge-pending">⏳ Đang chờ</span>',
      running: '<span class="badge badge-running">🔄 Đang chạy</span>',
      completed: '<span class="badge badge-success">✅ Hoàn tất</span>',
      error: '<span class="badge badge-error">❌ Lỗi</span>',
      disabled: '<span class="badge badge-closed">⏸ Tắt</span>',
    };

    let html = '<div class="schedule-list">';

    for (const s of schedules) {
      // Parse profile IDs
      let profileIds = [];
      try { profileIds = JSON.parse(s.profile_ids || '[]'); } catch (e) {}
      const profileCount = profileIds.length;

      // Time info
      let timeInfo = '';
      if (s.schedule_type === 'once' && s.schedule_time) {
        timeInfo = `📅 ${formatDate(s.schedule_time)}`;
      } else if (s.schedule_type === 'daily' && s.schedule_time) {
        const time = s.schedule_time.includes('T')
          ? new Date(s.schedule_time).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
          : s.schedule_time;
        timeInfo = `🕐 Mỗi ngày lúc ${time}`;
      } else if (s.schedule_type === 'custom' && s.cron_expr) {
        timeInfo = `⚙️ Cron: ${s.cron_expr}`;
      }

      // Last run
      const lastRun = s.last_run ? `Chạy lần cuối: ${formatDate(s.last_run)}` : 'Chưa chạy';

      html += `
        <div class="schedule-item">
          <div class="schedule-info">
            <div class="schedule-name">${this._escapeHtml(s.name)}</div>
            <div class="schedule-details">
              ${typeLabels[s.schedule_type] || s.schedule_type}
              ${statusLabels[s.status] || statusBadge(s.status)}
              <span style="margin-left: 8px; color: var(--text-muted);">
                ${timeInfo} · 👤 ${profileCount} profile · ${lastRun}
              </span>
            </div>
          </div>
          <label class="toggle" title="${s.enabled ? 'Tắt' : 'Bật'}">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="Scheduler.toggleSchedule(${s.id})">
            <span class="toggle-slider"></span>
          </label>
          <button class="btn btn-ghost btn-sm" onclick="Scheduler.showEditModal(${s.id})" title="Chỉnh sửa">✏️</button>
          <button class="btn btn-ghost btn-sm" onclick="Scheduler.deleteSchedule(${s.id})" title="Xóa">🗑</button>
        </div>
      `;
    }

    html += '</div>';
    container.innerHTML = html;
  },

  /**
   * Show add schedule modal
   */
  async showAddModal() {
    // Ensure profiles are loaded
    if (this.profiles.length === 0) {
      try {
        const res = await api('/api/browsers');
        this.profiles = res.data || [];
      } catch (e) {}
    }

    const body = this._buildForm(null);
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="Scheduler.createSchedule()">✅ Tạo lịch</button>
    `;
    showModal('Tạo lịch hẹn mới', body, footer);

    // Setup type change handler
    this._setupTypeToggle();
  },

  /**
   * Show edit schedule modal
   */
  async showEditModal(id) {
    const schedule = this.schedules.find(s => s.id === id);
    if (!schedule) return;

    // Ensure profiles are loaded
    if (this.profiles.length === 0) {
      try {
        const res = await api('/api/browsers');
        this.profiles = res.data || [];
      } catch (e) {}
    }

    const body = this._buildForm(schedule);
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="Scheduler.updateSchedule(${id})">💾 Lưu</button>
    `;
    showModal('Chỉnh sửa lịch hẹn', body, footer);

    // Setup type change handler
    this._setupTypeToggle();
  },

  /**
   * Build the form HTML
   */
  _buildForm(schedule) {
    const s = schedule || {};
    const scheduleType = s.schedule_type || 'once';

    // Parse selected profile IDs
    let selectedProfiles = [];
    try { selectedProfiles = JSON.parse(s.profile_ids || '[]'); } catch (e) {}

    // Profile checkboxes
    let profileCheckboxes = '';
    if (this.profiles.length > 0) {
      profileCheckboxes = this.profiles.map(p => {
        const checked = selectedProfiles.includes(p.id) ? 'checked' : '';
        return `
          <label class="profile-check-item">
            <input type="checkbox" name="sched_profile" value="${p.id}" ${checked}>
            <span>${this._escapeHtml(p.name)}</span>
          </label>
        `;
      }).join('');
    } else {
      profileCheckboxes = '<p class="text-muted text-sm">Chưa có profile nào. Vui lòng tạo profile trước.</p>';
    }

    // Format schedule_time for inputs
    let datetimeValue = '';
    let timeValue = '';
    if (s.schedule_time) {
      if (s.schedule_time.includes('T')) {
        datetimeValue = s.schedule_time.slice(0, 16);
        const d = new Date(s.schedule_time);
        timeValue = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      } else if (s.schedule_time.includes(':')) {
        timeValue = s.schedule_time;
      }
    }

    return `
      <div class="form-group">
        <label class="form-label">Tên lịch</label>
        <input type="text" class="form-input" id="sched-name" value="${this._escapeHtml(s.name || '')}" placeholder="VD: Đăng bài buổi sáng">
      </div>

      <div class="form-group">
        <label class="form-label">Loại lịch</label>
        <select class="form-select" id="sched-type" onchange="Scheduler._onTypeChange()">
          <option value="once" ${scheduleType === 'once' ? 'selected' : ''}>🕐 Một lần</option>
          <option value="daily" ${scheduleType === 'daily' ? 'selected' : ''}>🔄 Hàng ngày</option>
          <option value="custom" ${scheduleType === 'custom' ? 'selected' : ''}>⚙️ Tùy chỉnh (Cron)</option>
        </select>
      </div>

      <div class="form-group" id="sched-once-field" style="display: ${scheduleType === 'once' ? '' : 'none'}">
        <label class="form-label">Thời gian chạy</label>
        <input type="datetime-local" class="form-input" id="sched-datetime" value="${datetimeValue}">
      </div>

      <div class="form-group" id="sched-daily-field" style="display: ${scheduleType === 'daily' ? '' : 'none'}">
        <label class="form-label">Giờ chạy hàng ngày</label>
        <input type="time" class="form-input" id="sched-time" value="${timeValue}">
      </div>

      <div class="form-group" id="sched-custom-field" style="display: ${scheduleType === 'custom' ? '' : 'none'}">
        <label class="form-label">Cron Expression</label>
        <input type="text" class="form-input" id="sched-cron" value="${this._escapeHtml(s.cron_expr || '')}" placeholder="*/30 * * * *">
        <span class="text-sm text-muted">Định dạng: phút giờ ngày tháng thứ (VD: 0 8 * * * = 8h sáng mỗi ngày)</span>
      </div>

      <div class="form-group">
        <label class="form-label">Chọn Profile</label>
        <div class="profile-checklist" id="sched-profiles">
          ${profileCheckboxes}
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Concurrency</label>
          <input type="number" class="form-input" id="sched-concurrency" value="${s.concurrency || 1}" min="1" max="10">
        </div>
        <div class="form-group">
          <label class="form-label">Delay tối thiểu (giây)</label>
          <input type="number" class="form-input" id="sched-delay-min" value="${s.delay_min || 30}" min="1">
        </div>
        <div class="form-group">
          <label class="form-label">Delay tối đa (giây)</label>
          <input type="number" class="form-input" id="sched-delay-max" value="${s.delay_max || 90}" min="1">
        </div>
      </div>
    `;
  },

  /**
   * Handle schedule type change - show/hide relevant fields
   */
  _onTypeChange() {
    const type = document.getElementById('sched-type').value;
    document.getElementById('sched-once-field').style.display = type === 'once' ? '' : 'none';
    document.getElementById('sched-daily-field').style.display = type === 'daily' ? '' : 'none';
    document.getElementById('sched-custom-field').style.display = type === 'custom' ? '' : 'none';
  },

  /**
   * Setup type toggle after modal is shown
   */
  _setupTypeToggle() {
    // Already handled via inline onchange
  },

  /**
   * Collect form data
   */
  _collectFormData() {
    const type = document.getElementById('sched-type').value;

    let scheduleTime = null;
    let cronExpr = null;

    if (type === 'once') {
      scheduleTime = document.getElementById('sched-datetime').value || null;
      if (!scheduleTime) {
        showToast('Vui lòng chọn thời gian chạy', 'warning');
        return null;
      }
    } else if (type === 'daily') {
      scheduleTime = document.getElementById('sched-time').value || null;
      if (!scheduleTime) {
        showToast('Vui lòng chọn giờ chạy', 'warning');
        return null;
      }
    } else if (type === 'custom') {
      cronExpr = document.getElementById('sched-cron').value.trim() || null;
      if (!cronExpr) {
        showToast('Vui lòng nhập cron expression', 'warning');
        return null;
      }
    }

    // Collect selected profiles
    const profileCheckboxes = document.querySelectorAll('#sched-profiles input[name="sched_profile"]:checked');
    const profileIds = Array.from(profileCheckboxes).map(cb => parseInt(cb.value));

    if (profileIds.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 profile', 'warning');
      return null;
    }

    const name = document.getElementById('sched-name').value.trim();
    if (!name) {
      showToast('Vui lòng nhập tên lịch', 'warning');
      return null;
    }

    return {
      name,
      schedule_type: type,
      schedule_time: scheduleTime,
      cron_expr: cronExpr,
      profile_ids: profileIds,
      concurrency: parseInt(document.getElementById('sched-concurrency').value) || 1,
      delay_min: parseInt(document.getElementById('sched-delay-min').value) || 30,
      delay_max: parseInt(document.getElementById('sched-delay-max').value) || 90,
    };
  },

  /**
   * Create new schedule
   */
  async createSchedule() {
    const formData = this._collectFormData();
    if (!formData) return;

    try {
      await api('/api/schedules', { method: 'POST', body: formData });
      showToast('Đã tạo lịch hẹn', 'success');
      closeModal();
      this.load();
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Update existing schedule
   */
  async updateSchedule(id) {
    const formData = this._collectFormData();
    if (!formData) return;

    try {
      await api(`/api/schedules/${id}`, { method: 'PUT', body: formData });
      showToast('Đã cập nhật lịch hẹn', 'success');
      closeModal();
      this.load();
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Delete a schedule
   */
  async deleteSchedule(id) {
    const confirmed = await showConfirm('Xóa lịch hẹn', 'Bạn có chắc muốn xóa lịch hẹn này?');
    if (!confirmed) return;

    try {
      await api(`/api/schedules/${id}`, { method: 'DELETE' });
      showToast('Đã xóa lịch hẹn', 'success');
      this.load();
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Toggle schedule enabled/disabled
   */
  async toggleSchedule(id) {
    try {
      const res = await api(`/api/schedules/${id}/toggle`, { method: 'PATCH' });
      const schedule = res.data;
      showToast(`${schedule.enabled ? 'Đã bật' : 'Đã tắt'} lịch: ${schedule.name}`, schedule.enabled ? 'success' : 'warning');
      this.load();
    } catch (err) {
      this.load(); // Refresh to revert toggle state
    }
  },

  /**
   * Escape HTML to prevent XSS
   */
  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};
