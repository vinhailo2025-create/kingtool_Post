/**
 * BrowserManager - Frontend Chrome Profile Management
 * Card grid UI for managing browser profiles with proxy support
 */

const BrowserManager = {
  profiles: [],
  selectedProfileIds: new Set(),

  /**
   * Load and display all browser profiles
   */
  async load() {
    try {
      const res = await api('/api/browsers');
      this.profiles = res.data || [];
      const validIds = new Set(this.profiles.map(p => Number(p.id)));
      this.selectedProfileIds = new Set([...this.selectedProfileIds].filter(id => validIds.has(Number(id))));
      this.renderProfilesTable(this.profiles);
    } catch (err) {
      // Error already shown by api()
    }
  },

  renderProfilesTable(profiles) {
    const container = document.getElementById('page-browsers');

    if (!profiles || profiles.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🌐</div>
          <div class="empty-text">Chưa có profile nào</div>
          <button class="btn btn-primary" onclick="BrowserManager.showAddModal()">➕ Thêm Profile</button>
        </div>
      `;
      return;
    }

    const selectedCount = this.selectedProfileIds.size;
    const automationPanel = this._buildAutomationPanel(selectedCount);

    const rows = profiles.map(profile => {
      const isOpen = profile.status === 'open';
      const checked = this.selectedProfileIds.has(Number(profile.id)) ? 'checked' : '';
      const firstLetter = (profile.name || 'P').charAt(0).toUpperCase();
      const profilePath = profile.profile_path || profile.profile_dir || '';
      const proxyText = profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host
        ? `${profile.proxy_type.toUpperCase()} - ${profile.proxy_host}:${profile.proxy_port || ''}`
        : 'Không proxy';
      const sessionHtml = profile.session_valid
        ? '<span class="badge badge-success">Đã đăng nhập</span>'
        : '<span class="badge badge-closed">Chưa đăng nhập</span>';
      const statusHtml = isOpen
        ? '<span class="badge badge-open">Đang mở</span>'
        : '<span class="badge badge-closed">Đã đóng</span>';
      const launchBtn = isOpen
        ? `<button class="btn btn-sm btn-danger" onclick="BrowserManager.closeBrowser(${profile.id})">Đóng</button>`
        : `<button class="btn btn-sm btn-primary" onclick="BrowserManager.launchBrowser(${profile.id})">Mở</button>`;

      return `
        <tr class="browser-row browser-card ${isOpen ? 'is-open' : ''}" id="browser-card-${profile.id}">
          <td class="browser-select-cell">
            <input type="checkbox" class="browser-row-check" value="${profile.id}" ${checked} onchange="BrowserManager.toggleProfileSelection(${profile.id}, this.checked)">
          </td>
          <td>
            <div class="browser-row-profile">
              <div class="browser-avatar">${firstLetter}</div>
              <div>
                <div class="browser-name">${this._escapeHtml(profile.name)}</div>
                <div class="browser-row-note">${this._escapeHtml(profile.note || '')}</div>
              </div>
            </div>
          </td>
          <td>${statusHtml}</td>
          <td>${sessionHtml}</td>
          <td class="browser-cell-muted">${this._escapeHtml(proxyText)}</td>
          <td class="browser-path" title="${this._escapeHtml(profilePath)}">${this._escapeHtml(profilePath)}</td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="BrowserManager.showProfileLog(${profile.id})">Log</button>
          </td>
          <td>
            <div class="browser-actions table-actions">
              ${launchBtn}
              <button class="btn btn-sm btn-secondary" onclick="BrowserManager.showEditModal(${profile.id})">Sửa</button>
              <button class="btn btn-sm btn-secondary danger-link" onclick="BrowserManager.deleteProfile(${profile.id})">Xóa</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="lux-panel">
        <div class="lux-panel-title">
          <div>
            <div class="lux-title">Trình duyệt</div>
            <div class="lux-subtitle">Mỗi profile là một dòng, dễ quét trạng thái và thao tác nhanh.</div>
          </div>
          <span class="badge badge-pending">${profiles.length} profile</span>
        </div>
        ${automationPanel}
        <div class="lux-table-wrap">
          <table class="lux-table browser-table">
            <thead>
              <tr>
                <th style="width:56px;">
                  <input type="checkbox" class="browser-row-check" ${selectedCount === profiles.length ? 'checked' : ''} onchange="BrowserManager.toggleAllProfiles(this.checked)">
                </th>
                <th>Profile</th>
                <th>Trạng thái</th>
                <th>Phiên</th>
                <th>Proxy</th>
                <th>Thư mục</th>
                <th>Log</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  },

  _buildAutomationPanel(selectedCount) {
    const disabled = selectedCount === 0 ? 'disabled' : '';
    return `
      <div class="automation-dock">
        <div class="automation-dock-head">
          <div>
            <div class="automation-title">Tự động hoá</div>
            <div class="automation-subtitle">${selectedCount > 0 ? `Đã chọn ${selectedCount} trình duyệt` : 'Chọn trình duyệt bên dưới để mở cấu hình chạy'}</div>
          </div>
          <div class="automation-mode">
            <label><input type="radio" name="browser-auto-mode" value="now" checked onchange="BrowserManager.updateAutomationMode()"> Chạy ngay</label>
            <label><input type="radio" name="browser-auto-mode" value="schedule" onchange="BrowserManager.updateAutomationMode()"> Hẹn giờ</label>
          </div>
        </div>
        <div class="automation-default-note">
          Cấu hình đồng thời, delay bài và delay profile dùng mặc định trong mục Cài đặt.
        </div>
        <div class="automation-schedule" id="automation-schedule-fields" style="display:none;">
          <label class="auto-field">Tên lịch
            <input class="form-input" id="auto-schedule-name" value="Lịch tự động" ${disabled}>
          </label>
          <label class="auto-field">Kiểu hẹn giờ
            <select class="form-select" id="auto-schedule-type" onchange="BrowserManager.updateScheduleType()" ${disabled}>
              <option value="once">Một lần</option>
              <option value="daily">Hàng ngày</option>
              <option value="custom">Cron</option>
            </select>
          </label>
          <label class="auto-field auto-schedule-once">Thời gian chạy
            <input class="form-input" id="auto-schedule-datetime" type="datetime-local" ${disabled}>
          </label>
          <label class="auto-field auto-schedule-daily" style="display:none;">Giờ chạy
            <input class="form-input" id="auto-schedule-time" type="time" ${disabled}>
          </label>
          <label class="auto-field auto-schedule-custom" style="display:none;">Cron
            <input class="form-input" id="auto-schedule-cron" placeholder="0 8 * * *" ${disabled}>
          </label>
        </div>
        <div class="automation-actions">
          <button class="btn btn-secondary btn-sm" onclick="BrowserManager.toggleAllProfiles(true)">Chọn tất cả</button>
          <button class="btn btn-secondary btn-sm" onclick="BrowserManager.toggleAllProfiles(false)">Bỏ chọn</button>
          <button class="btn btn-success btn-sm" onclick="BrowserManager.runAutomation()" ${disabled}>Tự động hoá</button>
        </div>
      </div>
    `;
  },

  toggleProfileSelection(id, checked) {
    id = Number(id);
    if (checked) this.selectedProfileIds.add(id);
    else this.selectedProfileIds.delete(id);
    this.renderProfilesTable(this.profiles);
  },

  toggleAllProfiles(checked) {
    this.selectedProfileIds = checked ? new Set(this.profiles.map(p => Number(p.id))) : new Set();
    this.renderProfilesTable(this.profiles);
  },

  updateAutomationMode() {
    const mode = document.querySelector('input[name="browser-auto-mode"]:checked')?.value || 'now';
    const scheduleFields = document.getElementById('automation-schedule-fields');
    if (scheduleFields) scheduleFields.style.display = mode === 'schedule' ? 'grid' : 'none';
  },

  updateScheduleType() {
    const type = document.getElementById('auto-schedule-type')?.value || 'once';
    document.querySelectorAll('.auto-schedule-once').forEach(el => el.style.display = type === 'once' ? '' : 'none');
    document.querySelectorAll('.auto-schedule-daily').forEach(el => el.style.display = type === 'daily' ? '' : 'none');
    document.querySelectorAll('.auto-schedule-custom').forEach(el => el.style.display = type === 'custom' ? '' : 'none');
  },

  _automationConfig() {
    const selectedIds = [...this.selectedProfileIds].map(Number);
    if (selectedIds.length === 0) {
      showToast('Chọn ít nhất 1 trình duyệt trước', 'warning');
      return null;
    }
    return {
      profileIds: selectedIds,
      dataIds: 'all',
    };
  },

  async runAutomation() {
    const mode = document.querySelector('input[name="browser-auto-mode"]:checked')?.value || 'now';
    const config = this._automationConfig();
    if (!config) return;

    if (mode === 'now') {
      await api('/api/runner/start', { method: 'POST', body: config });
      showToast('Đã bắt đầu chạy tự động hoá', 'success');
      if (typeof Runner !== 'undefined') {
        Runner.isRunning = true;
        Runner.startPolling();
      }
      return;
    }

    const scheduleType = document.getElementById('auto-schedule-type')?.value || 'once';
    let scheduleTime = null;
    let cronExpr = null;
    if (scheduleType === 'once') scheduleTime = document.getElementById('auto-schedule-datetime')?.value || null;
    if (scheduleType === 'daily') scheduleTime = document.getElementById('auto-schedule-time')?.value || null;
    if (scheduleType === 'custom') cronExpr = document.getElementById('auto-schedule-cron')?.value?.trim() || null;
    if ((scheduleType === 'once' || scheduleType === 'daily') && !scheduleTime) {
      showToast('Chọn thời gian hẹn giờ trước', 'warning');
      return;
    }
    if (scheduleType === 'custom' && !cronExpr) {
      showToast('Nhập cron trước', 'warning');
      return;
    }

    await api('/api/schedules', {
      method: 'POST',
      body: {
        name: document.getElementById('auto-schedule-name')?.value?.trim() || 'Lịch tự động',
        schedule_type: scheduleType,
        schedule_time: scheduleTime,
        cron_expr: cronExpr,
        profile_ids: config.profileIds,
        data_ids: 'all',
      },
    });
    showToast('Đã tạo lịch tự động hoá', 'success');
    if (typeof App !== 'undefined') App.navigateTo('scheduler');
  },

  showProfileLog(id) {
    const profile = this.profiles.find(p => Number(p.id) === Number(id));
    if (!profile) return;
    const logs = (typeof Runner !== 'undefined' && Array.isArray(Runner.logEntries))
      ? Runner.logEntries.filter(item => !item.profile || item.profile === profile.name)
      : [];
    const rows = logs.length ? logs.slice(-80).map(item => {
      const time = item.time ? new Date(item.time).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const cls = item.type && item.type !== 'info' ? ` ${item.type}` : '';
      const name = item.profile || 'Hệ thống';
      return `
        <div class="log-entry">
          <span class="log-time">${time}</span>
          <span class="log-profile">[${this._escapeHtml(name)}]</span>
          <span class="log-message${cls}">${this._escapeHtml(item.message || '')}</span>
        </div>
      `;
    }).join('') : '<div class="text-muted text-sm" style="padding:18px;text-align:center;">Chưa có log cho phiên chạy này.</div>';
    const body = `<div class="runner-log profile-log-modal">${rows}</div>`;
    showModal(`Log - ${profile.name}`, body, '<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>');
  },

  /**
   * Render browser profiles as a card grid
   */
  renderProfiles(profiles) {
    const container = document.getElementById('page-browsers');

    if (!profiles || profiles.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--text-muted);">
          <div style="font-size: 48px; margin-bottom: 16px;">🌐</div>
          <h3 style="color: var(--text-secondary); margin-bottom: 8px;">Chưa có profile nào</h3>
          <p style="font-size: 14px;">Nhấn <strong>Thêm Profile</strong> để tạo profile Chrome mới</p>
        </div>
      `;
      return;
    }

    let html = '<div class="browser-grid">';

    profiles.forEach(profile => {
      const isOpen = profile.status === 'open';
      const firstLetter = (profile.name || 'P').charAt(0).toUpperCase();

      // Proxy info text
      let proxyText = 'Không có proxy';
      if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host) {
        proxyText = `${profile.proxy_type.toUpperCase()} — ${profile.proxy_host}:${profile.proxy_port || ''}`;
      }

      // Session badge
      const sessionHtml = profile.session_valid
        ? '<span class="badge badge-success">✅ Đã đăng nhập</span>'
        : '<span class="badge badge-closed">⚪ Chưa đăng nhập</span>';

      // Status badge
      const statusHtml = isOpen
        ? '<span class="badge badge-open">🟢 Đang mở</span>'
        : '<span class="badge badge-closed">🔴 Đã đóng</span>';

      // Action buttons
      const launchBtn = isOpen
        ? `<button class="btn btn-sm btn-danger" onclick="BrowserManager.closeBrowser(${profile.id})">🔴 Đóng Chrome</button>`
        : `<button class="btn btn-sm btn-primary" onclick="BrowserManager.launchBrowser(${profile.id})">🟢 Mở Chrome</button>`;

      html += `
        <div class="browser-card ${isOpen ? 'is-open' : ''}" id="browser-card-${profile.id}">
          <div class="browser-card-header">
            <div class="browser-avatar">${firstLetter}</div>
            <div>
              <div class="browser-name">${this._escapeHtml(profile.name)}</div>
              <div style="margin-top: 4px;">${statusHtml} ${sessionHtml}</div>
            </div>
          </div>

          <div class="browser-meta">
            <div class="browser-meta-item">
              <span class="meta-icon">🌐</span>
              <span>${proxyText}</span>
            </div>
            ${profile.note ? `
            <div class="browser-meta-item">
              <span class="meta-icon">📝</span>
              <span>${this._escapeHtml(profile.note)}</span>
            </div>
            ` : ''}
            <div class="browser-meta-item">
              <span class="meta-icon">📁</span>
              <span style="font-size: 11px; opacity: 0.6;">${this._escapeHtml(profile.profile_dir)}</span>
            </div>
          </div>

          <div class="browser-actions">
            ${launchBtn}
            <button class="btn btn-sm btn-secondary" onclick="BrowserManager.showEditModal(${profile.id})">✏️ Sửa</button>
            <button class="btn btn-sm btn-secondary" onclick="BrowserManager.deleteProfile(${profile.id})" style="color: var(--error);">🗑 Xóa</button>
          </div>
        </div>
      `;
    });

    html += '</div>';
    container.innerHTML = html;
  },

  /**
   * Show add profile modal
   */
  showAddModal() {
    const body = this._buildFormHtml();
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="BrowserManager.createProfile()">Tạo Profile</button>
    `;
    showModal('Thêm Profile Mới', body, footer);

    // Setup proxy type toggle
    this._setupProxyToggle();
  },

  /**
   * Show edit profile modal
   */
  showEditModal(id) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) {
      showToast('Không tìm thấy profile', 'error');
      return;
    }

    const body = this._buildFormHtml(profile);
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="BrowserManager.updateProfile(${id})">Lưu thay đổi</button>
    `;
    showModal('Sửa Profile', body, footer);

    // Setup proxy type toggle
    this._setupProxyToggle();
  },

  /**
   * Build the form HTML for add/edit modal
   */
  _buildFormHtml(profile = null) {
    const val = (field) => profile ? (profile[field] || '') : '';
    const proxyType = profile ? (profile.proxy_type || 'none') : 'none';
    const showProxy = proxyType !== 'none';

    return `
      <div class="form-group">
        <label class="form-label">Tên Profile <span style="color: var(--error);">*</span></label>
        <input type="text" class="form-input" id="bf-name" value="${this._escapeHtml(val('name'))}" placeholder="VD: Tài khoản chính" />
      </div>

      <div class="form-group">
        <label class="form-label">Loại Proxy</label>
        <select class="form-input" id="bf-proxy-type" onchange="BrowserManager._setupProxyToggle()">
          <option value="none" ${proxyType === 'none' ? 'selected' : ''}>Không dùng proxy</option>
          <option value="http" ${proxyType === 'http' ? 'selected' : ''}>HTTP / HTTPS</option>
          <option value="socks5" ${proxyType === 'socks5' ? 'selected' : ''}>SOCKS5</option>
        </select>
      </div>

      <div id="proxy-fields" style="display: ${showProxy ? 'block' : 'none'};">
        <div style="display: grid; grid-template-columns: 1fr 120px; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Proxy Host</label>
            <input type="text" class="form-input" id="bf-proxy-host" value="${this._escapeHtml(val('proxy_host'))}" placeholder="VD: 123.45.67.89" />
          </div>
          <div class="form-group">
            <label class="form-label">Port</label>
            <input type="number" class="form-input" id="bf-proxy-port" value="${val('proxy_port')}" placeholder="8080" />
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label">Username</label>
            <input type="text" class="form-input" id="bf-proxy-user" value="${this._escapeHtml(val('proxy_user'))}" placeholder="(tùy chọn)" />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" class="form-input" id="bf-proxy-pass" value="${this._escapeHtml(val('proxy_pass'))}" placeholder="(tùy chọn)" />
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Ghi chú</label>
        <textarea class="form-input" id="bf-note" rows="2" placeholder="Ghi chú tùy chọn...">${this._escapeHtml(val('note'))}</textarea>
      </div>
    `;
  },

  /**
   * Toggle visibility of proxy fields based on proxy_type selection
   */
  _setupProxyToggle() {
    const proxyType = document.getElementById('bf-proxy-type');
    const proxyFields = document.getElementById('proxy-fields');
    if (proxyType && proxyFields) {
      proxyFields.style.display = proxyType.value !== 'none' ? 'block' : 'none';
    }
  },

  /**
   * Collect form data from the modal
   */
  _getFormData() {
    return {
      name: document.getElementById('bf-name').value.trim(),
      proxy_type: document.getElementById('bf-proxy-type').value,
      proxy_host: document.getElementById('bf-proxy-host')?.value.trim() || '',
      proxy_port: document.getElementById('bf-proxy-port')?.value || '',
      proxy_user: document.getElementById('bf-proxy-user')?.value.trim() || '',
      proxy_pass: document.getElementById('bf-proxy-pass')?.value || '',
      note: document.getElementById('bf-note').value.trim(),
    };
  },

  /**
   * Create a new profile
   */
  async createProfile() {
    const formData = this._getFormData();

    if (!formData.name) {
      showToast('Vui lòng nhập tên profile', 'warning');
      return;
    }

    try {
      await api('/api/browsers', {
        method: 'POST',
        body: formData,
      });
      closeModal();
      showToast('Đã tạo profile thành công', 'success');
      this.load();
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Update an existing profile
   */
  async updateProfile(id) {
    const formData = this._getFormData();

    if (!formData.name) {
      showToast('Vui lòng nhập tên profile', 'warning');
      return;
    }

    try {
      await api(`/api/browsers/${id}`, {
        method: 'PUT',
        body: formData,
      });
      closeModal();
      showToast('Đã cập nhật profile', 'success');
      this.load();
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Delete a profile with confirmation
   */
  async deleteProfile(id) {
    const profile = this.profiles.find(p => p.id === id);
    const name = profile ? profile.name : `#${id}`;

    const confirmed = await showConfirm(
      'Xóa Profile',
      `Bạn có chắc chắn muốn xóa profile <strong>${this._escapeHtml(name)}</strong>?<br>Dữ liệu Chrome profile sẽ bị xóa vĩnh viễn.`
    );

    if (!confirmed) return;

    try {
      await api(`/api/browsers/${id}`, { method: 'DELETE' });
      showToast('Đã xóa profile', 'success');
      this.load();
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Launch Chrome for a profile
   */
  async launchBrowser(id) {
    const card = document.getElementById(`browser-card-${id}`);
    if (card) {
      // Disable buttons while launching
      card.querySelectorAll('.browser-actions button').forEach(btn => btn.disabled = true);
    }

    try {
      await api(`/api/browsers/${id}/launch`, { method: 'POST' });
      showToast('Đang mở trình duyệt...', 'success');
      // Refresh after a short delay to let status update
      await this.load();
    } catch (err) {
      // Error already shown by api()
      if (card) {
        card.querySelectorAll('.browser-actions button').forEach(btn => btn.disabled = false);
      }
    }
  },

  /**
   * Close Chrome for a profile
   */
  async closeBrowser(id) {
    try {
      await api(`/api/browsers/${id}/close`, { method: 'POST' });
      showToast('Đã đóng trình duyệt', 'success');
      setTimeout(() => this.load(), 500);
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * HTML escape utility
   */
  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
