/**
 * BrowserManager - Frontend Chrome Profile Management
 * Card grid UI for managing browser profiles with proxy support
 */

const BrowserManager = {
  profiles: [],
  selectedProfileIds: new Set(),
  discoveredProfiles: [],
  providerOverview: null,
  providerFilter: 'all',
  searchText: '',

  providerLabels: {
    chrome: 'Chrome',
    gologin: 'GoLogin',
    gemlogin: 'GemLogin',
    gpm: 'GPM Login',
    genlogin: 'GenLogin',
  },

  /**
   * Load and display all browser profiles
   */
  async load() {
    try {
      const [res, providerRes] = await Promise.all([
        api('/api/browsers'),
        api('/api/browsers/providers'),
      ]);
      this.profiles = res.data || [];
      this.providerOverview = providerRes.data || null;
      const validIds = new Set(this.profiles.map(p => Number(p.id)));
      this.selectedProfileIds = new Set([...this.selectedProfileIds].filter(id => validIds.has(Number(id))));
      this.renderProfilesTable(this.profiles);
    } catch (err) {
      // Error already shown by api()
    }
  },

  _visibleProfiles(profiles = this.profiles) {
    const needle = String(this.searchText || '').trim().toLowerCase();
    return profiles.filter(profile => {
      const provider = profile.provider || 'chrome';
      const providerMatch = this.providerFilter === 'all' || provider === this.providerFilter;
      const textMatch = !needle || [profile.name, profile.note, profile.provider_profile_id]
        .some(value => String(value || '').toLowerCase().includes(needle));
      return providerMatch && textMatch;
    });
  },

  renderProfilesTable(profiles) {
    const container = document.getElementById('page-browsers');
    const visibleProfiles = this._visibleProfiles(profiles || []);
    const selectedCount = this.selectedProfileIds.size;
    const visibleAllSelected = visibleProfiles.length > 0 && visibleProfiles.every(profile => this.selectedProfileIds.has(Number(profile.id)));
    const automationPanel = this._buildAutomationPanel(selectedCount);
    const providerCounts = (profiles || []).reduce((acc, profile) => {
      const key = profile.provider || 'chrome';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const providerFilters = ['all', 'chrome', 'gologin', 'gemlogin', 'gpm', 'genlogin'].map(provider => {
      const label = provider === 'all' ? 'Tất cả' : this.providerLabels[provider];
      const count = provider === 'all' ? profiles.length : (providerCounts[provider] || 0);
      return `<button class="provider-filter ${this.providerFilter === provider ? 'active' : ''}" onclick="BrowserManager.filterProvider('${provider}')">${label}<span>${count}</span></button>`;
    }).join('');

    const rows = visibleProfiles.map(profile => {
      const isOpen = profile.status === 'open';
      const checked = this.selectedProfileIds.has(Number(profile.id)) ? 'checked' : '';
      const firstLetter = (profile.name || 'P').charAt(0).toUpperCase();
      const profilePath = profile.profile_path || profile.profile_dir || '';
      const provider = profile.provider || 'chrome';
      const providerLabel = this.providerLabels[provider] || provider;
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
          <td><span class="provider-badge provider-${provider}">${this._escapeHtml(providerLabel)}</span></td>
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
    }).join('') || `
      <tr><td colspan="9">
        <div class="empty-state browser-empty">
          <div class="empty-icon">◎</div>
          <div class="empty-text">${profiles.length ? 'Không có profile phù hợp bộ lọc' : 'Chưa có profile trình duyệt'}</div>
          <button class="btn btn-primary" onclick="BrowserManager.showProviderImportModal()">Nhập profile Anti-detect</button>
        </div>
      </td></tr>`;

    container.innerHTML = `
      <section class="browser-hero">
        <div>
          <div class="browser-hero-kicker">Browser workspace</div>
          <h2>Một nơi cho mọi trình duyệt</h2>
          <p>Chọn nhiều profile, chạy đồng thời và dùng chung an toàn cho Facebook, TikTok và YouTube.</p>
        </div>
        <div class="browser-hero-actions">
          <button class="btn btn-secondary" onclick="BrowserManager.refreshProviderNames()">Đồng bộ tên</button>
          <button class="btn btn-secondary" onclick="BrowserManager.showAddModal()">Chrome mới</button>
          <button class="btn btn-primary" onclick="BrowserManager.showProviderImportModal()">Kết nối Anti-detect</button>
        </div>
      </section>
      <div class="lux-panel">
        <div class="lux-panel-title">
          <div>
            <div class="lux-title">Trình duyệt</div>
            <div class="lux-subtitle">Profile gốc được giữ nguyên; tool chỉ kết nối và điều phối tác vụ.</div>
          </div>
          <div class="browser-search-wrap">
            <input class="form-input browser-search" value="${this._escapeHtml(this.searchText)}" oninput="BrowserManager.searchProfiles(this.value)" placeholder="Tìm profile...">
            <span class="badge badge-pending">${visibleProfiles.length}/${profiles.length}</span>
          </div>
        </div>
        <div class="provider-filter-row">${providerFilters}</div>
        ${automationPanel}
        <div class="lux-table-wrap">
          <table class="lux-table browser-table">
            <thead>
              <tr>
                <th style="width:56px;">
                  <input type="checkbox" class="browser-row-check" ${visibleAllSelected ? 'checked' : ''} onchange="BrowserManager.toggleAllProfiles(this.checked)">
                </th>
                <th>Profile</th>
                <th>Loại</th>
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

  filterProvider(provider) {
    this.providerFilter = provider;
    this.renderProfilesTable(this.profiles);
  },

  searchProfiles(value) {
    this.searchText = value || '';
    this.renderProfilesTable(this.profiles);
    const input = document.querySelector('.browser-search');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  },

  _buildAutomationPanel(selectedCount) {
    const disabled = selectedCount === 0 ? 'disabled' : '';
    const syncButtons = App.platforms
      .filter(platform => platform !== App.currentPlatform)
      .map(platform => `<button class="btn btn-secondary btn-sm" onclick="BrowserManager.syncSelected('${platform}')" ${disabled}>
        Đồng bộ sang ${App.platformLabel(platform)}
      </button>`)
      .join('');
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
          <button class="btn btn-secondary btn-sm" onclick="BrowserManager.bulkLaunch()" ${disabled}>Mở đã chọn</button>
          <button class="btn btn-secondary btn-sm" onclick="BrowserManager.bulkClose()" ${disabled}>Đóng đã chọn</button>
          ${syncButtons}
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
    const visibleIds = this._visibleProfiles().map(p => Number(p.id));
    if (checked) visibleIds.forEach(id => this.selectedProfileIds.add(id));
    else visibleIds.forEach(id => this.selectedProfileIds.delete(id));
    this.renderProfilesTable(this.profiles);
  },

  async bulkLaunch() {
    await this._bulkBrowserAction('launch');
  },

  async bulkClose() {
    await this._bulkBrowserAction('close');
  },

  async _bulkBrowserAction(action) {
    const profileIds = [...this.selectedProfileIds].map(Number);
    if (!profileIds.length) return showToast('Vui lòng chọn ít nhất 1 profile', 'warning');
    const response = await api(`/api/browsers/bulk/${action}`, { method: 'POST', body: { profileIds } });
    const failed = (response.data || []).filter(item => !item.success);
    if (failed.length) showToast(`${failed.length} profile lỗi; ${profileIds.length - failed.length} profile thành công`, 'warning', 5000);
    else showToast(`${action === 'launch' ? 'Đã mở' : 'Đã đóng'} ${profileIds.length} profile`, 'success');
    await this.load();
  },

  async syncSelected(targetPlatform) {
    const profileIds = [...this.selectedProfileIds].map(Number);
    if (!profileIds.length) return showToast('Vui lòng chọn ít nhất 1 profile', 'warning');
    if (!App.platforms.includes(targetPlatform) || targetPlatform === App.currentPlatform) return;
    try {
      const response = await api('/api/browsers/sync', {
        method: 'POST',
        body: { profileIds, targetPlatform },
      });
      const linked = response.data?.linked || 0;
      showToast(
        linked ? `Đã đồng bộ ${linked} profile sang ${App.platformLabel(targetPlatform)}`
          : 'Các profile đã được đồng bộ trước đó',
        'success'
      );
    } catch (_) {}
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
      ? Runner.logEntries.filter(item =>
          (item.platform || 'facebook') === App.currentPlatform &&
          (!item.profile || item.profile === profile.name)
        )
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

  async showProviderImportModal(provider = null) {
    if (!this.providerOverview) {
      const response = await api('/api/browsers/providers');
      this.providerOverview = response.data;
    }
    this.importProvider = provider || this.importProvider || 'gologin';
    const options = ['gologin', 'gemlogin', 'gpm', 'genlogin'].map(key =>
      `<button class="provider-choice ${this.importProvider === key ? 'active' : ''}" onclick="BrowserManager.showProviderImportModal('${key}')">${this.providerLabels[key]}</button>`
    ).join('');
    const body = `
      <div class="provider-import-intro">
        <strong>Kết nối profile gốc</strong>
        <span>Không sao chép cookie, fingerprint hoặc thư mục trình duyệt.</span>
      </div>
      <div class="provider-choice-row">${options}</div>
      <div class="provider-config-card">${this._providerConfigFields(this.importProvider)}</div>
      <div class="provider-safety-note">Hãy đóng profile đang mở thủ công trước khi dùng chế độ thư mục trực tiếp. GPM/GenLogin sẽ kết nối qua API và CDP.</div>
    `;
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="BrowserManager.discoverProvider()">Quét profile</button>
    `;
    showModal('Kết nối trình duyệt Anti-detect', body, footer);
    document.getElementById('modal')?.classList.add('modal-wide');
  },

  _providerConfigFields(provider) {
    const cfg = this.providerOverview?.config || {};
    const input = (label, id, value, placeholder = '') => `
      <label class="auto-field">${label}
        <input class="form-input" id="${id}" value="${this._escapeHtml(value || '')}" placeholder="${this._escapeHtml(placeholder)}">
      </label>`;
    if (provider === 'gologin') return `
      ${input('Thư mục profiles', 'provider-profiles-dir', cfg.gologin_profiles_dir, '...\\GoLogin\\profiles')}
      ${input('File Orbita chrome.exe', 'provider-executable-path', cfg.gologin_executable_path, '...\\orbita-browser-142\\chrome.exe')}`;
    if (provider === 'gemlogin') return `
      ${input('Local API', 'provider-api-url', cfg.gemlogin_api_url, 'http://127.0.0.1:1010/api')}
      ${input('Thư mục profiles', 'provider-profiles-dir', cfg.gemlogin_profiles_dir, '...\\.gemlogin\\profile\\profiles')}
      ${input('File GemLogin chrome.exe', 'provider-executable-path', cfg.gemlogin_executable_path, '...\\Chrome-bin\\chrome.exe')}
      ${input('Thư mục extension', 'provider-extension-path', cfg.gemlogin_extension_path, '...\\extensions\\chrome_gem_v1')}`;
    if (provider === 'gpm') return input('Local API', 'provider-api-url', cfg.gpm_api_url, 'http://127.0.0.1:9495/api/v1');
    return `
      ${input('Local API', 'provider-api-url', cfg.genlogin_api_url, 'http://127.0.0.1:55550/backend/profiles')}
      <label class="auto-field">Access token <span class="field-hint">${cfg.genlogin_has_token ? 'Đã lưu — để trống nếu giữ nguyên' : 'Không cần với API local 3.0'}</span>
        <input class="form-input" type="password" id="provider-token" placeholder="Token (tùy chọn)">
      </label>`;
  },

  _providerConfigData() {
    const provider = this.importProvider;
    const value = id => document.getElementById(id)?.value?.trim() || '';
    if (provider === 'gologin') return {
      gologin_profiles_dir: value('provider-profiles-dir'),
      gologin_executable_path: value('provider-executable-path'),
    };
    if (provider === 'gemlogin') return {
      gemlogin_api_url: value('provider-api-url'),
      gemlogin_profiles_dir: value('provider-profiles-dir'),
      gemlogin_executable_path: value('provider-executable-path'),
      gemlogin_extension_path: value('provider-extension-path'),
    };
    if (provider === 'gpm') return { gpm_api_url: value('provider-api-url') };
    const config = { genlogin_api_url: value('provider-api-url') };
    const token = value('provider-token');
    if (token) config.genlogin_token = token;
    return config;
  },

  async discoverProvider() {
    const response = await api('/api/browsers/providers/discover', {
      method: 'POST',
      body: { provider: this.importProvider, config: this._providerConfigData() },
    });
    this.discoveredProfiles = response.data || [];
    if (!this.discoveredProfiles.length) {
      showToast(`Không tìm thấy profile ${this.providerLabels[this.importProvider]}`, 'warning');
      return;
    }
    this._showDiscoveredProfiles();
  },

  async refreshProviderNames() {
    const response = await api('/api/browsers/providers/refresh-names', { method: 'POST', body: {} });
    const result = response.data || {};
    if (result.errors?.length && !result.changed) {
      showToast('Chưa kết nối được ứng dụng Anti-detect để đọc tên', 'warning', 5000);
    } else if (result.unmatched) {
      showToast(`Đã cập nhật ${result.changed || 0} tên; ${result.unmatched} profile cũ không còn trong danh sách của ứng dụng`, 'warning', 6000);
    } else {
      showToast(result.changed
        ? `Đã cập nhật đúng tên cho ${result.changed} profile`
        : `Tên ${result.matched || 0} profile đã đồng bộ`, 'success');
    }
    await this.load();
  },

  _showDiscoveredProfiles() {
    const rows = this.discoveredProfiles.map((profile, index) => `
      <label class="discovered-profile-row">
        <input type="checkbox" class="discovered-check" value="${index}" checked>
        <span class="browser-avatar small">${this._escapeHtml((profile.name || 'P').charAt(0).toUpperCase())}</span>
        <span class="discovered-profile-info">
          <strong>${this._escapeHtml(profile.name)}</strong>
          <small>${this._escapeHtml(profile.provider_profile_id || '')}</small>
        </span>
        <span class="provider-badge provider-${profile.provider}">${this._escapeHtml(this.providerLabels[profile.provider] || profile.provider)}</span>
      </label>
    `).join('');
    const body = `
      <div class="import-summary"><strong>Tìm thấy ${this.discoveredProfiles.length} profile</strong><span>Chọn một hoặc nhiều profile để nhập.</span></div>
      <label class="select-all-line"><input type="checkbox" checked onchange="BrowserManager.toggleDiscovered(this.checked)"> Chọn tất cả</label>
      <div class="discovered-profile-list">${rows}</div>
      <div class="platform-assignment">
        <strong>Dùng profile cho</strong>
        <label><input type="checkbox" id="import-facebook" ${App.currentPlatform === 'facebook' ? 'checked' : ''}> Facebook</label>
        <label><input type="checkbox" id="import-tiktok" ${App.currentPlatform === 'tiktok' ? 'checked' : ''}> TikTok</label>
        <label><input type="checkbox" id="import-youtube" ${App.currentPlatform === 'youtube' ? 'checked' : ''}> YouTube</label>
        <label><input type="checkbox" id="import-threads" ${App.currentPlatform === 'threads' ? 'checked' : ''}> Threads</label>
        <label><input type="checkbox" id="import-instagram" ${App.currentPlatform === 'instagram' ? 'checked' : ''}> Instagram</label>
        <label><input type="checkbox" id="import-x" ${App.currentPlatform === 'x' ? 'checked' : ''}> X</label>
        <button class="btn btn-secondary btn-sm" onclick="BrowserManager.selectAllPlatforms()">Chọn tất cả</button>
      </div>`;
    const footer = `
      <button class="btn btn-secondary" onclick="BrowserManager.showProviderImportModal('${this.importProvider}')">Quay lại</button>
      <button class="btn btn-primary" onclick="BrowserManager.importDiscoveredProfiles()">Nhập profile đã chọn</button>`;
    showModal(`Profile ${this.providerLabels[this.importProvider]}`, body, footer);
    document.getElementById('modal')?.classList.add('modal-wide');
  },

  toggleDiscovered(checked) {
    document.querySelectorAll('.discovered-check').forEach(input => { input.checked = checked; });
  },

  selectAllPlatforms() {
    document.getElementById('import-facebook').checked = true;
    document.getElementById('import-tiktok').checked = true;
    document.getElementById('import-youtube').checked = true;
    document.getElementById('import-threads').checked = true;
    document.getElementById('import-instagram').checked = true;
    document.getElementById('import-x').checked = true;
  },

  async importDiscoveredProfiles() {
    const indexes = [...document.querySelectorAll('.discovered-check:checked')].map(input => Number(input.value));
    const profiles = indexes.map(index => this.discoveredProfiles[index]).filter(Boolean);
    if (!profiles.length) return showToast('Chọn ít nhất 1 profile', 'warning');
    const platforms = [];
    if (document.getElementById('import-facebook')?.checked) platforms.push('facebook');
    if (document.getElementById('import-tiktok')?.checked) platforms.push('tiktok');
    if (document.getElementById('import-youtube')?.checked) platforms.push('youtube');
    if (document.getElementById('import-threads')?.checked) platforms.push('threads');
    if (document.getElementById('import-instagram')?.checked) platforms.push('instagram');
    if (document.getElementById('import-x')?.checked) platforms.push('x');
    if (!platforms.length) return showToast('Chọn ít nhất một nền tảng', 'warning');
    const response = await api('/api/browsers/providers/import', { method: 'POST', body: { profiles, platforms } });
    closeModal();
    const result = response.data || {};
    showToast(`Đã nhập ${result.created || 0}, cập nhật ${result.updated || 0} profile`, 'success');
    await this.load();
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

    const body = (profile.provider || 'chrome') === 'chrome'
      ? this._buildFormHtml(profile)
      : this._buildExternalFormHtml(profile);
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="BrowserManager.updateProfile(${id})">Lưu thay đổi</button>
    `;
    showModal('Sửa Profile', body, footer);

    // Setup proxy type toggle
    this._setupProxyToggle();
  },

  _buildExternalFormHtml(profile) {
    return `
      <div class="provider-import-intro">
        <span class="provider-badge provider-${profile.provider}">${this._escapeHtml(this.providerLabels[profile.provider] || profile.provider)}</span>
        <span>ID: ${this._escapeHtml(profile.provider_profile_id || '')}</span>
      </div>
      <div class="form-group">
        <label class="form-label">Tên hiển thị</label>
        <input class="form-input" id="bf-name" value="${this._escapeHtml(profile.name || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Thư mục dữ liệu gốc</label>
        <input class="form-input" id="bf-external-user-data-dir" value="${this._escapeHtml(profile.external_user_data_dir || '')}" placeholder="Để trống nếu dùng API">
      </div>
      <div class="form-group">
        <label class="form-label">File trình duyệt</label>
        <input class="form-input" id="bf-external-executable-path" value="${this._escapeHtml(profile.external_executable_path || '')}" placeholder="Để trống nếu dùng API">
      </div>
      <div class="form-group">
        <label class="form-label">CDP endpoint <span class="field-hint">Chỉ dùng khi gắn vào phiên đang mở</span></label>
        <input class="form-input" id="bf-provider-endpoint" value="${this._escapeHtml(profile.provider_endpoint || '')}" placeholder="ws://127.0.0.1:... hoặc http://127.0.0.1:port">
      </div>
      <div class="form-group">
        <label class="form-label">Ghi chú</label>
        <textarea class="form-input" id="bf-note" rows="2">${this._escapeHtml(profile.note || '')}</textarea>
      </div>`;
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
    const profile = this.profiles.find(item => Number(item.id) === Number(id));
    const formData = profile && (profile.provider || 'chrome') !== 'chrome'
      ? {
          name: document.getElementById('bf-name')?.value?.trim() || '',
          external_user_data_dir: document.getElementById('bf-external-user-data-dir')?.value?.trim() || '',
          external_executable_path: document.getElementById('bf-external-executable-path')?.value?.trim() || '',
          provider_endpoint: document.getElementById('bf-provider-endpoint')?.value?.trim() || '',
          note: document.getElementById('bf-note')?.value?.trim() || '',
        }
      : this._getFormData();

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
      `Bỏ profile <strong>${this._escapeHtml(name)}</strong> khỏi ${App.platformLabel()}?<br>Thư mục Chrome chỉ bị xóa khi profile không còn được nền tảng nào sử dụng.`
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
      const response = await api(`/api/browsers/${id}/launch`, { method: 'POST' });
      showToast(response.displayNameSync?.changed
        ? 'Đã đồng bộ tên profile và mở trình duyệt'
        : 'Đang mở trình duyệt...', 'success');
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
