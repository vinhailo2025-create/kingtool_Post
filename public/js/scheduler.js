/**
 * Global schedule page with platform/project filtering.
 */
const Scheduler = {
  schedules: [],
  profiles: [],
  projectFilter: 'all',

  async load() {
    try {
      const [scheduleResponse, profileResponse] = await Promise.all([
        api('/api/schedules?platform=all'),
        api('/api/browsers?platform=all'),
      ]);
      this.schedules = scheduleResponse.data || [];
      this.profiles = profileResponse.data || [];
      this.render();
    } catch (_) {
      this.schedules = [];
      this.render();
    }
  },

  filteredSchedules() {
    if (this.projectFilter === 'all') return this.schedules;
    return this.schedules.filter(schedule => schedule.platform === this.projectFilter);
  },

  setProjectFilter(platform) {
    this.projectFilter = App.platforms.includes(platform) ? platform : 'all';
    this.render();
  },

  render() {
    const container = document.getElementById('page-scheduler');
    if (!container) return;
    const schedules = this.filteredSchedules();
    const filterOptions = [
      '<option value="all">Tất cả dự án</option>',
      ...App.platforms.map(platform =>
        `<option value="${platform}" ${this.projectFilter === platform ? 'selected' : ''}>${App.platformLabel(platform)}</option>`
      ),
    ].join('');

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
      missed: '<span class="badge badge-warning">Chưa chạy</span>',
      disabled: '<span class="badge badge-closed">Đã tắt</span>',
    };
    const rows = schedules.map(schedule => {
      let profileIds = [];
      try { profileIds = JSON.parse(schedule.profile_ids || '[]'); } catch (_) {}
      let runTime = '';
      if (schedule.schedule_type === 'once' && schedule.schedule_time) {
        runTime = formatDate(schedule.schedule_time);
      } else if (schedule.schedule_type === 'daily' && schedule.schedule_time) {
        runTime = schedule.schedule_time.includes('T')
          ? new Date(schedule.schedule_time).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
          : schedule.schedule_time;
      } else {
        runTime = schedule.cron_expr || '';
      }
      return `
        <tr>
          <td><div class="schedule-name">${this.escapeHtml(schedule.name)}</div></td>
          <td><span class="project-chip project-${schedule.platform}">${this.escapeHtml(App.platformLabel(schedule.platform))}</span></td>
          <td>${typeLabels[schedule.schedule_type] || this.escapeHtml(schedule.schedule_type)}</td>
          <td>${statusLabels[schedule.status] || statusBadge(schedule.status)}</td>
          <td class="browser-cell-muted">${this.escapeHtml(runTime)}</td>
          <td>${profileIds.length}</td>
          <td class="browser-cell-muted">${schedule.last_run ? formatDate(schedule.last_run) : 'Chưa chạy'}</td>
          <td>
            <label class="toggle" title="${schedule.enabled ? 'Tắt' : 'Bật'}">
              <input type="checkbox" ${schedule.enabled ? 'checked' : ''}
                     onchange="Scheduler.toggleSchedule(${schedule.id})">
              <span class="toggle-slider"></span>
            </label>
          </td>
          <td>
            <div class="table-actions">
              <button class="btn btn-ghost btn-sm" onclick="Scheduler.showEditModal(${schedule.id})">Sửa</button>
              ${schedule.schedule_type === 'once' && ['completed', 'error', 'missed'].includes(schedule.status)
                ? `<button class="btn btn-ghost btn-sm" onclick="Scheduler.showEditModal(${schedule.id})">Chạy lại</button>`
                : ''}
              <button class="btn btn-ghost btn-sm danger-link" onclick="Scheduler.deleteSchedule(${schedule.id})">Xóa</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    const body = rows || `
      <tr><td colspan="9">
        <div class="empty-state compact-empty">
          <div class="empty-icon">⏱</div>
          <div class="empty-text">Chưa có lịch hẹn</div>
        </div>
      </td></tr>`;

    container.innerHTML = `
      <div class="lux-panel">
        <div class="lux-panel-title global-page-tools">
          <div class="lux-title">Hẹn giờ</div>
          <div>
            <select class="form-select project-filter-select" onchange="Scheduler.setProjectFilter(this.value)">
              ${filterOptions}
            </select>
            <span class="badge badge-pending">${schedules.length}/${this.schedules.length}</span>
          </div>
        </div>
        <div class="lux-table-wrap">
          <table class="lux-table scheduler-table" data-tour-id="scheduler-table">
            <thead>
              <tr>
                <th>Tên lịch</th>
                <th>Dự án</th>
                <th>Loại</th>
                <th>Trạng thái</th>
                <th>Thời gian</th>
                <th>Profile</th>
                <th>Lần chạy cuối</th>
                <th>Bật</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>`;
  },

  async showEditModal(id) {
    const schedule = this.schedules.find(item => Number(item.id) === Number(id));
    if (!schedule) return;
    let selectedProfileIds = [];
    try { selectedProfileIds = JSON.parse(schedule.profile_ids || '[]').map(Number); } catch (_) {}
    const selected = new Set(selectedProfileIds);
    const profileRows = this.profiles.map(profile => `
      <label class="automation-profile-row">
        <input type="checkbox" name="schedule-profile" value="${profile.id}" ${selected.has(Number(profile.id)) ? 'checked' : ''}>
        <span class="automation-profile-avatar">${this.escapeHtml((profile.name || 'P').charAt(0).toUpperCase())}</span>
        <span class="automation-profile-main"><strong>${this.escapeHtml(profile.name)}</strong></span>
      </label>`).join('');
    const scheduleType = schedule.schedule_type || 'once';
    const dateTime = (() => {
      const raw = String(schedule.schedule_time || '');
      if (!raw.includes('T')) return '';
      // Giá trị không có múi giờ là giờ địa phương; giá trị ISO (Z/+hh:mm) phải đổi về giờ máy.
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return raw.slice(0, 16);
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return '';
      const pad = value => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    })();
    const dailyTime = scheduleType === 'daily' ? (schedule.schedule_time || '').slice(-5) : '';

    showModal(
      `Sửa lịch · ${App.platformLabel(schedule.platform)}`,
      `<div class="schedule-edit-form">
         <label class="form-group">
           <span class="form-label">Tên lịch</span>
           <input class="form-input" id="schedule-edit-name" value="${this.escapeHtml(schedule.name)}">
         </label>
         <label class="form-group">
           <span class="form-label">Loại lịch</span>
           <select class="form-select" id="schedule-edit-type" onchange="Scheduler.updateEditType()">
             <option value="once" ${scheduleType === 'once' ? 'selected' : ''}>Một lần</option>
             <option value="daily" ${scheduleType === 'daily' ? 'selected' : ''}>Hàng ngày</option>
             <option value="custom" ${scheduleType === 'custom' ? 'selected' : ''}>Cron</option>
           </select>
         </label>
         <label class="form-group">
           <span class="form-label">Trạng thái</span>
           <select class="form-select" id="schedule-edit-status">
             <option value="waiting" ${schedule.enabled ? 'selected' : ''}>Đang chờ (bật lịch)</option>
             <option value="disabled" ${schedule.enabled ? '' : 'selected'}>Đã tắt</option>
           </select>
         </label>
         <label class="form-group schedule-edit-once" style="display:${scheduleType === 'once' ? '' : 'none'}">
           <span class="form-label">Thời gian</span>
           <input class="form-input" type="datetime-local" id="schedule-edit-datetime" value="${this.escapeHtml(dateTime)}">
         </label>
         <label class="form-group schedule-edit-daily" style="display:${scheduleType === 'daily' ? '' : 'none'}">
           <span class="form-label">Giờ chạy</span>
           <input class="form-input" type="time" id="schedule-edit-time" value="${this.escapeHtml(dailyTime)}">
         </label>
         <label class="form-group schedule-edit-custom" style="display:${scheduleType === 'custom' ? '' : 'none'}">
           <span class="form-label">Cron</span>
           <input class="form-input" id="schedule-edit-cron" value="${this.escapeHtml(schedule.cron_expr || '')}">
         </label>
         <div class="automation-profile-list schedule-profile-list">${profileRows}</div>
       </div>`,
      `<button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
       <button class="btn btn-primary" onclick="Scheduler.updateSchedule(${schedule.id})">Lưu</button>`
    );
    document.getElementById('modal')?.classList.add('modal-wide');
  },

  updateEditType() {
    const type = document.getElementById('schedule-edit-type')?.value || 'once';
    document.querySelector('.schedule-edit-once').style.display = type === 'once' ? '' : 'none';
    document.querySelector('.schedule-edit-daily').style.display = type === 'daily' ? '' : 'none';
    document.querySelector('.schedule-edit-custom').style.display = type === 'custom' ? '' : 'none';
  },

  async updateSchedule(id) {
    const schedule = this.schedules.find(item => Number(item.id) === Number(id));
    if (!schedule) return;
    const type = document.getElementById('schedule-edit-type')?.value || 'once';
    const profileIds = [...document.querySelectorAll('input[name="schedule-profile"]:checked')]
      .map(input => Number(input.value));
    const name = document.getElementById('schedule-edit-name')?.value.trim();
    const scheduleTime = type === 'once'
      ? document.getElementById('schedule-edit-datetime')?.value
      : type === 'daily'
        ? document.getElementById('schedule-edit-time')?.value
        : null;
    const cronExpr = type === 'custom' ? document.getElementById('schedule-edit-cron')?.value.trim() : null;
    if (!name || !profileIds.length || ((type === 'once' || type === 'daily') && !scheduleTime) || (type === 'custom' && !cronExpr)) {
      showToast('Hãy nhập đủ thông tin lịch', 'warning');
      return;
    }
    try {
      await api(`/api/schedules/${id}?platform=all`, {
        method: 'PUT',
        body: {
          name,
          schedule_type: type,
          schedule_time: scheduleTime,
          cron_expr: cronExpr,
          profile_ids: profileIds,
          enabled: (document.getElementById('schedule-edit-status')?.value || 'waiting') === 'waiting',
        },
      });
      closeModal();
      showToast('Đã cập nhật lịch', 'success');
      await this.load();
    } catch (_) {}
  },

  async toggleSchedule(id) {
    try {
      await api(`/api/schedules/${id}/toggle?platform=all`, { method: 'PATCH' });
      await this.load();
    } catch (_) {
      await this.load();
    }
  },

  async deleteSchedule(id) {
    const confirmed = await showConfirm('Xóa lịch', 'Xóa lịch hẹn đã chọn?');
    if (!confirmed) return;
    try {
      await api(`/api/schedules/${id}?platform=all`, { method: 'DELETE' });
      showToast('Đã xóa lịch', 'success');
      await this.load();
    } catch (_) {}
  },

  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  },
};
