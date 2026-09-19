/**
 * Platform automation dialog. Browser profiles are global; post data remains
 * scoped to the platform currently open in the workspace.
 */
const Automation = {
  profiles: [],
  selectedProfileIds: new Set(),
  providerFilters: new Set(),
  groupFilters: new Set(),
  searchText: '',
  mode: 'now',

  storageKey(platform = App.currentPlatform) {
    return `covergem-automation-${platform}`;
  },

  savedConfig() {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey()) || '{}');
    } catch (_) {
      return {};
    }
  },

  async show() {
    try {
      const response = await api('/api/browsers?platform=all');
      this.profiles = response.data || [];
    } catch (_) {
      this.profiles = [];
    }

    const saved = this.savedConfig();
    const validIds = new Set(this.profiles.map(profile => Number(profile.id)));
    this.selectedProfileIds = new Set(
      (saved.profileIds || []).map(Number).filter(id => validIds.has(id))
    );
    this.mode = saved.mode === 'schedule' ? 'schedule' : 'now';
    this.searchText = '';
    this.providerFilters = new Set();
    this.groupFilters = new Set();

    showModal(
      `Tự động hóa · ${App.platformLabel()}`,
      '<div id="automation-modal-content"></div>',
      `<button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
       <button class="btn btn-secondary" onclick="Automation.save()">Lưu</button>
       <button class="btn btn-primary" id="automation-run-button"
               data-tour-id="automation-run" onclick="Automation.run()">Chạy</button>`
    );
    document.getElementById('modal')?.classList.add('modal-wide');
    this.render(saved.scheduleTime || '');
  },

  visibleProfiles() {
    const needle = String(this.searchText || '').trim().toLowerCase();
    return this.profiles.filter(profile => [
        profile.name,
        profile.provider,
        ...(profile.groups || []).map(group => group.name),
      ].some(value => !needle || String(value || '').toLowerCase().includes(needle))
      && (this.providerFilters.size === 0
        || this.providerFilters.has(profile.provider || 'chrome'))
      && (this.groupFilters.size === 0
        || [...this.groupFilters].some(groupId => {
          const profileGroupIds = new Set((profile.groups || []).map(group => String(group.id)));
          return groupId === 'ungrouped'
            ? profileGroupIds.size === 0
            : profileGroupIds.has(String(groupId));
        })));
  },

  availableGroups() {
    const groups = new Map();
    for (const profile of this.profiles) {
      for (const group of profile.groups || []) groups.set(String(group.id), group);
    }
    return [...groups.values()].sort((left, right) =>
      String(left.name || '').localeCompare(String(right.name || ''), 'vi', { sensitivity: 'base' })
    );
  },

  render(scheduleTime = null) {
    const container = document.getElementById('automation-modal-content');
    if (!container) return;
    const visible = this.visibleProfiles();
    const allVisibleSelected = visible.length > 0
      && visible.every(profile => this.selectedProfileIds.has(Number(profile.id)));
    const currentScheduleTime = scheduleTime === null
      ? (document.getElementById('automation-schedule-time')?.value || '')
      : scheduleTime;
    const providerCounts = this.profiles.reduce((counts, profile) => {
      const provider = profile.provider || 'chrome';
      counts[provider] = (counts[provider] || 0) + 1;
      return counts;
    }, {});
    const providers = ['chrome', 'gologin', 'gemlogin', 'gpm', 'genlogin'];
    const providerOptions = providers.map(provider => `
      <label>
        <input type="checkbox" ${this.providerFilters.has(provider) ? 'checked' : ''}
               onchange="Automation.toggleProviderFilter('${provider}', this.checked)">
        <span>${this.escapeHtml(BrowserManager.providerLabels[provider] || provider)}</span>
        <small>${providerCounts[provider] || 0}</small>
      </label>`).join('');
    const groupOptions = [
      `<label>
        <input type="checkbox" ${this.groupFilters.has('ungrouped') ? 'checked' : ''}
               onchange="Automation.toggleGroupFilter('ungrouped', this.checked)">
        <span>Chưa phân nhóm</span>
      </label>`,
      ...this.availableGroups().map(group => `
        <label>
          <input type="checkbox" ${this.groupFilters.has(String(group.id)) ? 'checked' : ''}
                 onchange="Automation.toggleGroupFilter('${group.id}', this.checked)">
          <span>${this.escapeHtml(group.name)}</span>
        </label>`),
    ].join('');
    const activeFilterCount = this.providerFilters.size + this.groupFilters.size;
    const profileRows = visible.map(profile => {
      const id = Number(profile.id);
      const checked = this.selectedProfileIds.has(id) ? 'checked' : '';
      const provider = BrowserManager.providerLabels[profile.provider || 'chrome'] || profile.provider || 'Chrome';
      const groups = (profile.groups || []).map(group => group.name).join(', ');
      return `
        <label class="automation-profile-row">
          <input type="checkbox" value="${id}" ${checked}
                 onchange="Automation.toggleProfile(${id}, this.checked)">
          <span class="automation-profile-avatar">${this.escapeHtml((profile.name || 'P').charAt(0).toUpperCase())}</span>
          <span class="automation-profile-main">
            <strong>${this.escapeHtml(profile.name)}</strong>
            <small>${this.escapeHtml(groups)}</small>
          </span>
          <span class="provider-badge provider-${this.escapeHtml(profile.provider || 'chrome')}">${this.escapeHtml(provider)}</span>
        </label>`;
    }).join('') || '<div class="automation-profile-empty">Không có profile</div>';

    container.innerHTML = `
      <div class="automation-modal">
        <div class="automation-profile-toolbar">
          <label>
            <input type="checkbox" ${allVisibleSelected ? 'checked' : ''}
                   onchange="Automation.toggleAll(this.checked)">
            <span>Chọn tất cả</span>
          </label>
          <input class="form-input" value="${this.escapeHtml(this.searchText)}"
                 oninput="Automation.search(this.value)" placeholder="Tìm profile">
          <span>${this.selectedProfileIds.size}/${this.profiles.length}</span>
        </div>
        <div class="automation-filter-bar">
          <details class="automation-filter-dropdown automation-provider-filter">
            <summary>Loại trình duyệt${this.providerFilters.size ? `<i>${this.providerFilters.size}</i>` : ''}</summary>
            <div class="automation-filter-menu">${providerOptions}</div>
          </details>
          <details class="automation-filter-dropdown automation-group-filter">
            <summary>Nhóm${this.groupFilters.size ? `<i>${this.groupFilters.size}</i>` : ''}</summary>
            <div class="automation-filter-menu">${groupOptions}</div>
          </details>
          ${activeFilterCount
            ? `<button type="button" class="automation-clear-filters" onclick="Automation.clearFilters()">Bỏ lọc</button>`
            : ''}
          <span>${visible.length} profile</span>
        </div>
        <div class="automation-profile-list" data-tour-id="automation-profiles">${profileRows}</div>
        <div class="automation-run-options" data-tour-id="automation-mode">
          <label class="${this.mode === 'now' ? 'active' : ''}">
            <input type="radio" name="automation-run-mode" value="now"
                   ${this.mode === 'now' ? 'checked' : ''}
                   onchange="Automation.setMode('now')">
            <span>Chạy ngay</span>
          </label>
          <label class="${this.mode === 'schedule' ? 'active' : ''}">
            <input type="radio" name="automation-run-mode" value="schedule"
                   ${this.mode === 'schedule' ? 'checked' : ''}
                   onchange="Automation.setMode('schedule')">
            <span>Hẹn giờ</span>
          </label>
        </div>
        <div class="automation-schedule-row" style="display:${this.mode === 'schedule' ? 'grid' : 'none'}">
          <label>
            <span>Thời gian hẹn</span>
            <input type="datetime-local" class="form-input" id="automation-schedule-time"
                   value="${this.escapeHtml(currentScheduleTime)}">
          </label>
        </div>
      </div>`;
  },

  setMode(mode) {
    this.mode = mode === 'schedule' ? 'schedule' : 'now';
    this.render();
  },

  search(value) {
    this.searchText = value || '';
    this.render();
    const input = document.querySelector('.automation-profile-toolbar .form-input');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  },

  toggleProviderFilter(provider, checked) {
    if (checked) this.providerFilters.add(provider);
    else this.providerFilters.delete(provider);
    this.render();
    const details = document.querySelector('.automation-provider-filter');
    if (details) details.open = true;
  },

  toggleGroupFilter(groupId, checked) {
    groupId = String(groupId);
    if (checked) this.groupFilters.add(groupId);
    else this.groupFilters.delete(groupId);
    this.render();
    const details = document.querySelector('.automation-group-filter');
    if (details) details.open = true;
  },

  clearFilters() {
    this.providerFilters.clear();
    this.groupFilters.clear();
    this.render();
  },

  toggleProfile(id, checked) {
    if (checked) this.selectedProfileIds.add(Number(id));
    else this.selectedProfileIds.delete(Number(id));
    this.render();
  },

  toggleAll(checked) {
    for (const profile of this.visibleProfiles()) {
      if (checked) this.selectedProfileIds.add(Number(profile.id));
      else this.selectedProfileIds.delete(Number(profile.id));
    }
    this.render();
  },

  collect() {
    const profileIds = [...this.selectedProfileIds].map(Number);
    if (!profileIds.length) {
      showToast('Hãy chọn ít nhất 1 profile', 'warning');
      return null;
    }
    const scheduleTime = document.getElementById('automation-schedule-time')?.value || '';
    if (this.mode === 'schedule') {
      if (!scheduleTime) {
        showToast('Hãy chọn thời gian hẹn', 'warning');
        return null;
      }
      if (new Date(scheduleTime).getTime() <= Date.now()) {
        showToast('Thời gian hẹn phải lớn hơn thời gian hiện tại', 'warning');
        return null;
      }
    }
    const selectedRows = DataManager.gridApi
      ? DataManager.gridApi.getSelectedRows().filter(row => row && row.id)
      : [];
    const taskMode = (window.DataManager && DataManager.getViewMode
      && DataManager.getViewMode() === 'comment') ? 'comment_link' : 'post';
    return {
      platform: App.currentPlatform,
      mode: this.mode,
      scheduleTime,
      profileIds,
      dataIds: selectedRows.length ? selectedRows.map(row => Number(row.id)) : 'all',
      taskMode,
    };
  },

  persist(config) {
    localStorage.setItem(this.storageKey(config.platform), JSON.stringify({
      mode: config.mode,
      scheduleTime: config.scheduleTime,
      profileIds: config.profileIds,
    }));
  },

  save() {
    const config = this.collect();
    if (!config) return;
    this.persist(config);
    showToast('Đã lưu cấu hình tự động hóa', 'success');
  },

  async run() {
    const config = this.collect();
    if (!config) return;
    this.persist(config);
    closeModal();
    try {
      if (config.mode === 'schedule') {
        await api(`/api/schedules?platform=${encodeURIComponent(config.platform)}`, {
          method: 'POST',
          body: {
            platform: config.platform,
            name: `${App.platformLabel(config.platform)} · ${new Date(config.scheduleTime).toLocaleString('vi-VN')}`,
            schedule_type: 'once',
            schedule_time: config.scheduleTime,
            profile_ids: config.profileIds,
            data_ids: config.dataIds,
            task_mode: config.taskMode,
          },
        });
        if (typeof DataManager !== 'undefined' && DataManager.load) await DataManager.load();
        showToast('Đã tạo lịch hẹn', 'success');
      } else {
        await api(`/api/runner/start?platform=${encodeURIComponent(config.platform)}`, {
          method: 'POST',
          body: {
            platform: config.platform,
            profileIds: config.profileIds,
            dataIds: config.dataIds,
            taskMode: config.taskMode,
          },
        });
        showToast('Đã bắt đầu chạy tự động hóa', 'success');
      }
    } catch (_) {}
  },

  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  },
};
