/**
 * BrowserManager - Frontend Chrome Profile Management
 * Card grid UI for managing browser profiles with proxy support
 */

const BrowserManager = {
  profiles: [],
  groups: [],
  selectedProfileIds: new Set(),
  discoveredProfiles: [],
  providerOverview: null,
  providerFilter: 'all',
  groupFilter: new Set(),
  nameSort: 'asc',
  searchText: '',
  nameSyncPromise: null,
  lastNameSyncAt: 0,
  loginPollTimers: new Map(),
  loginScan: {},

  providerLabels: {
    chrome: 'Chrome',
    gologin: 'GoLogin',
    gemlogin: 'GemLogin',
    gpm: 'GPM Login',
    genlogin: 'GenLogin',
  },

  loginPlatformLabels: {
    facebook: 'FB',
    tiktok: 'TikTok',
    youtube: 'YT',
    threads: 'Threads',
    instagram: 'IG',
    x: 'X',
    zalovideo: 'Zalo',
  },

  /**
   * Load and display all browser profiles
   */
  async load() {
    try {
      const [res, providerRes, groupRes] = await Promise.all([
        api('/api/browsers'),
        api('/api/browsers/providers'),
        api('/api/browsers/groups'),
      ]);
      this.profiles = res.data || [];
      this.providerOverview = providerRes.data || null;
      this.groups = groupRes.data || [];
      const validGroupIds = new Set(this.groups.map(group => String(group.id)));
      this.groupFilter = new Set([...this.groupFilter].filter(
        value => value === 'ungrouped' || validGroupIds.has(String(value))
      ));
      const validIds = new Set(this.profiles.map(p => Number(p.id)));
      this.selectedProfileIds = new Set([...this.selectedProfileIds].filter(id => validIds.has(Number(id))));
      this.renderProfilesTable(this.profiles);
      this._refreshProviderNamesAutomatically();
      this._scanLoginsAutomatically();
    } catch (err) {
      // Error already shown by api()
    }
  },

  // Quet offline file Cookies de hien nhan da dang nhap nen tang nao cho tung profile.
  async _scanLoginsAutomatically() {
    try {
      const res = await api('/api/browsers/login-scan', { method: 'POST' });
      this.loginScan = res.data || {};
      this.renderProfilesTable(this.profiles);
    } catch (_) {}
  },

  _loginBadges(id) {
    const map = this.loginScan && this.loginScan[id];
    if (!map || map._state === 'unavailable' || map._state === 'open_unverified') {
      const title = map?._state === 'open_unverified'
        ? 'Đóng Chrome để kiểm tra cookie mới nhất'
        : 'Không đọc được dữ liệu cookie của profile';
      return `<span class="browser-session-state is-unknown" title="${title}">
        <i></i><span>Chưa xác minh</span>
      </span>`;
    }
    const active = Object.keys(this.loginPlatformLabels).filter(platform => map[platform]);
    if (!active.length) {
      return `<span class="browser-session-state is-empty" title="Không tìm thấy cookie đăng nhập còn hiệu lực">
        <i></i><span>Không phát hiện phiên</span>
      </span>`;
    }
    return `<div class="browser-login-badges" title="Cookie đăng nhập còn hiệu lực">
      ${active.map(platform =>
        `<span class="browser-login-badge login-${platform}">${this.loginPlatformLabels[platform]}</span>`
      ).join('')}
    </div>`;
  },

  _visibleProfiles(profiles = this.profiles) {
    const needle = String(this.searchText || '').trim().toLowerCase();
    const filtered = profiles.filter(profile => {
      const provider = profile.provider || 'chrome';
      const providerMatch = this.providerFilter === 'all' || provider === this.providerFilter;
      const profileGroupIds = new Set((profile.groups || []).map(group => String(group.id)));
      const groupMatch = this.groupFilter.size === 0 || [...this.groupFilter].some(value =>
        value === 'ungrouped' ? profileGroupIds.size === 0 : profileGroupIds.has(String(value))
      );
      const textMatch = !needle || [
        profile.name,
        profile.note,
        profile.provider_profile_id,
        ...(profile.groups || []).map(group => group.name),
      ]
        .some(value => String(value || '').toLowerCase().includes(needle));
      return providerMatch && groupMatch && textMatch;
    });
    if (this.nameSort === 'asc' || this.nameSort === 'desc') {
      const direction = this.nameSort === 'desc' ? -1 : 1;
      filtered.sort((left, right) => direction * String(left.name || '').localeCompare(
        String(right.name || ''),
        'vi',
        { numeric: true, sensitivity: 'base' }
      ));
    } else {
      filtered.sort((left, right) => Number(right.id) - Number(left.id));
    }
    return filtered;
  },

  renderProfilesTable(profiles) {
    const container = document.getElementById('page-browsers');
    const visibleProfiles = this._visibleProfiles(profiles || []);
    const selectedCount = this.selectedProfileIds.size;
    const visibleAllSelected = visibleProfiles.length > 0 && visibleProfiles.every(profile => this.selectedProfileIds.has(Number(profile.id)));
    const providerCounts = (profiles || []).reduce((acc, profile) => {
      const key = profile.provider || 'chrome';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const providerFilters = ['all', 'chrome', 'gologin', 'gemlogin', 'gpm', 'genlogin'].map(provider => {
      const label = provider === 'all' ? 'Tất cả' : this.providerLabels[provider];
      const count = provider === 'all' ? profiles.length : (providerCounts[provider] || 0);
      return `<button class="provider-filter ${this.providerFilter === provider ? 'active' : ''}"
                      onclick="BrowserManager.filterProvider('${provider}')">${label}<span>${count}</span></button>`;
    }).join('');
    const groupFilterOptions = [
      `<label><input type="checkbox" value="ungrouped" ${this.groupFilter.has('ungrouped') ? 'checked' : ''}
        onchange="BrowserManager.toggleGroupFilter('ungrouped', this.checked)"> Chưa phân nhóm</label>`,
      ...this.groups.map(group => `
        <label><input type="checkbox" value="${group.id}" ${this.groupFilter.has(String(group.id)) ? 'checked' : ''}
          onchange="BrowserManager.toggleGroupFilter('${group.id}', this.checked)">
          <span>${this._escapeHtml(group.name)}</span><small>${group.profile_count}</small>
        </label>
      `),
    ].join('');
    const rows = visibleProfiles.map(profile => {
      const isOpen = profile.status === 'open';
      const isLogin = profile.status === 'login';
      const checked = this.selectedProfileIds.has(Number(profile.id)) ? 'checked' : '';
      const firstLetter = (profile.name || 'P').charAt(0).toUpperCase();
      const profilePath = profile.profile_path || profile.profile_dir || '';
      const provider = profile.provider || 'chrome';
      const providerLabel = this.providerLabels[provider] || provider;
      const proxyText = profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host
        ? `${profile.proxy_type.toUpperCase()} - ${profile.proxy_host}:${profile.proxy_port || ''}`
        : 'Không proxy';
      const launchBtn = (isOpen || isLogin)
        ? `<button class="btn btn-sm btn-danger" onclick="BrowserManager.closeBrowser(${profile.id})">Đóng</button>`
        : `<button class="btn btn-sm btn-primary" onclick="BrowserManager.launchBrowser(${profile.id})">Mở</button>`;
      const groupNames = (profile.groups || []).map(group => group.name).join(', ');
      const groupTags = (profile.groups || []).length
        ? (profile.groups || []).slice(0, 2).map(group =>
            `<span class="browser-group-tag">${this._escapeHtml(group.name)}</span>`
          ).join('') + ((profile.groups || []).length > 2
            ? `<span class="browser-group-more">+${profile.groups.length - 2}</span>`
            : '')
        : '<span class="browser-ungrouped">Chưa phân nhóm</span>';

      return `
        <tr class="browser-row browser-card ${isOpen ? 'is-open' : ''} ${isLogin ? 'is-login' : ''}" id="browser-card-${profile.id}">
          <td class="browser-select-cell">
            <input type="checkbox" class="browser-row-check" value="${profile.id}" ${checked} onchange="BrowserManager.toggleProfileSelection(${profile.id}, this.checked)">
          </td>
          <td>
            <div class="browser-row-profile">
              <div class="browser-avatar">${firstLetter}</div>
              <div>
                <button type="button" class="browser-name browser-name-copy"
                  title="Bấm để sao chép tên profile"
                  onclick="BrowserManager.copyProfileName(${profile.id})">${this._escapeHtml(profile.name)}</button>
                <div class="browser-row-note">${this._escapeHtml(profile.note || '')}</div>
              </div>
            </div>
          </td>
          <td><span class="provider-badge provider-${provider}">${this._escapeHtml(providerLabel)}</span></td>
          <td class="browser-login-cell">${this._loginBadges(profile.id)}</td>
          <td>
            <button type="button" class="browser-group-cell" title="${this._escapeHtml(groupNames || 'Chưa phân nhóm')}"
                    onclick="BrowserManager.showProfileGroupModal(${profile.id})">${groupTags}</button>
          </td>
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
          <div class="text-muted text-sm">Dùng nút Kết nối Anti-detect ở đầu trang để nhập profile.</div>
        </div>
      </td></tr>`;

    container.innerHTML = `
      <section class="browser-hero" data-tour-id="browser-overview">
        <div>
          <div class="browser-hero-kicker">Browser workspace</div>
          <h2>Một nơi cho mọi trình duyệt</h2>
        </div>
        <div class="browser-hero-actions">
          <button class="btn btn-secondary" data-tour-id="browser-create"
                  onclick="BrowserManager.showAddModal()">Tạo mới</button>
          <button class="btn btn-primary" data-tour-id="browser-connect"
                  onclick="BrowserManager.showProviderImportModal()">Kết nối Anti-detect</button>
        </div>
      </section>
      <div class="lux-panel">
        <div class="lux-panel-title">
          <div>
            <div class="lux-title">Trình duyệt</div>
          </div>
          <div class="browser-panel-tools" data-tour-id="browser-filters">
            <button class="btn btn-secondary btn-sm" data-tour-id="browser-groups"
                    onclick="BrowserManager.showGroupManagerModal()">Quản lý nhóm</button>
            <div class="browser-search-wrap">
            <input class="form-input browser-search" value="${this._escapeHtml(this.searchText)}" oninput="BrowserManager.searchProfiles(this.value)" placeholder="Tìm profile...">
            <span class="badge badge-pending">${visibleProfiles.length}/${profiles.length}</span>
            </div>
          </div>
        </div>
        <div class="provider-filter-row">${providerFilters}</div>
        <div class="browser-bulk-bar ${selectedCount ? 'has-selection' : ''}" data-tour-id="browser-bulk">
          <span>${selectedCount ? `Đã chọn ${selectedCount}` : 'Chọn profile để thao tác'}</span>
          <div>
            <button class="btn btn-secondary btn-sm" onclick="BrowserManager.showManagedTargetsModal()" title="Fanpage và kênh YouTube">Danh sách</button>
            <button class="btn btn-secondary btn-sm" onclick="BrowserManager.bulkLaunch()" ${selectedCount ? '' : 'disabled'}>Mở</button>
            <button class="btn btn-secondary btn-sm" onclick="BrowserManager.bulkClose()" ${selectedCount ? '' : 'disabled'}>Đóng</button>
            <button class="btn btn-secondary btn-sm" onclick="BrowserManager.showBulkGroupModal()" ${selectedCount ? '' : 'disabled'}>Chuyển nhóm</button>
            <button class="btn btn-danger btn-sm" onclick="BrowserManager.bulkDelete()" ${selectedCount ? '' : 'disabled'}>Xóa</button>
          </div>
        </div>
        <div class="lux-table-wrap" data-tour-id="browser-table">
          <table class="lux-table browser-table">
            <thead>
              <tr>
                <th style="width:56px;">
                  <input type="checkbox" class="browser-row-check" ${visibleAllSelected ? 'checked' : ''} onchange="BrowserManager.toggleAllProfiles(this.checked)">
                </th>
                <th>
                  <button type="button" class="browser-profile-sort"
                          onclick="BrowserManager.toggleProfileSort()"
                          title="Đổi thứ tự tên profile">
                    Profile <span>${this.nameSort === 'desc' ? '↓' : '↑'}</span>
                  </button>
                </th>
                <th>Loại</th>
              <th title="Nền tảng có cookie đăng nhập còn hiệu lực">Phiên đăng nhập</th>
                <th>
                  <div class="browser-group-header">
                    <span>Nhóm</span>
                    <details class="browser-column-filter browser-group-filter">
                      <summary title="Lọc theo nhóm" aria-label="Lọc theo nhóm">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M4 5h16l-6.2 7.2v5.1l-3.6 1.8v-6.9L4 5Z"></path>
                        </svg>
                        ${this.groupFilter.size ? `<i>${this.groupFilter.size}</i>` : ''}
                      </summary>
                      <div class="browser-column-filter-menu" onclick="event.stopPropagation()">
                        <div class="browser-column-filter-head">
                          <span>Lọc theo nhóm</span>
                          <button type="button" onclick="BrowserManager.clearGroupFilter()">Bỏ lọc</button>
                        </div>
                        ${groupFilterOptions}
                      </div>
                    </details>
                  </div>
                </th>
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

  async showManagedTargetsModal(type = 'facebook') {
    const profiles = this._visibleProfiles(this.profiles);
    const defaultSelected = this.selectedProfileIds.size
      ? new Set([...this.selectedProfileIds].map(Number))
      : new Set();
    const response = await api(`/api/browsers/targets?type=${encodeURIComponent(type)}`);
    this.managedTargets = response.data || {};
    this.managedTargetType = type === 'youtube' ? 'youtube' : 'facebook';
    const profileRows = profiles.length ? profiles.map(profile => `
      <label class="managed-target-profile">
        <input type="checkbox" class="managed-target-profile-check" value="${profile.id}"
          ${defaultSelected.has(Number(profile.id)) ? 'checked' : ''}>
        <span>${this._escapeHtml(profile.name || `Profile ${profile.id}`)}</span>
        <small>${this._escapeHtml(this.providerLabels[profile.provider] || profile.provider || 'Chrome')}</small>
      </label>
    `).join('') : '<div class="text-muted text-sm">Chưa có profile.</div>';
    const body = `
      <div class="managed-target-tabs">
        <button class="btn btn-sm ${this.managedTargetType === 'facebook' ? 'btn-primary' : 'btn-secondary'}"
          onclick="BrowserManager.showManagedTargetsModal('facebook')">Fanpage</button>
        <button class="btn btn-sm ${this.managedTargetType === 'youtube' ? 'btn-primary' : 'btn-secondary'}"
          onclick="BrowserManager.showManagedTargetsModal('youtube')">Kênh YouTube</button>
      </div>
      <div class="managed-target-profile-head">
        <strong>Chọn profile</strong>
        <button class="btn btn-link btn-sm" onclick="BrowserManager.toggleManagedTargetProfiles(true)">Chọn tất cả</button>
      </div>
      <div class="managed-target-profile-list">${profileRows}</div>
      <div id="managed-target-results">${this._managedTargetResultHtml(this.managedTargetType, [...defaultSelected])}</div>
    `;
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Đóng</button>
      <button class="btn btn-secondary" onclick="BrowserManager.viewManagedTargets()">Xem danh sách</button>
      <button class="btn btn-primary" onclick="BrowserManager.scanManagedTargets()">Cập nhật</button>
    `;
    showModal('Danh sách', body, footer);
    document.getElementById('modal')?.classList.add('modal-wide');
  },

  _managedTargetResultHtml(type, profileIds = []) {
    const values = Array.isArray(this.managedTargets) ? this.managedTargets : [];
    const allowed = new Set((profileIds || []).map(Number));
    const filtered = values.filter(item => !allowed.size || allowed.has(Number(item.profile_id)));
    if (!filtered.length) {
      return '<div class="managed-target-empty">Chưa có dữ liệu. Chọn profile rồi bấm Cập nhật.</div>';
    }
    const rows = filtered.map(item => `
      <tr>
        <td>${this._escapeHtml(item.profile_name || '')}</td>
        <td>${this._escapeHtml(item.name || '')}</td>
        <td><a href="${this._escapeHtml(item.url || '#')}" target="_blank" rel="noreferrer">${this._escapeHtml(item.url || '')}</a></td>
        <td>${item.checked_at ? new Date(item.checked_at).toLocaleString('vi-VN') : ''}</td>
      </tr>
    `).join('');
    return `
      <div class="managed-target-summary">${filtered.length} ${type === 'youtube' ? 'kênh' : 'Fanpage'}</div>
      <div class="managed-target-table-wrap">
        <table class="lux-table managed-target-table">
          <thead><tr><th>Profile</th><th>Tên</th><th>Link</th><th>Cập nhật</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  },

  _managedTargetProfileIds() {
    return [...document.querySelectorAll('.managed-target-profile-check:checked')].map(input => Number(input.value));
  },

  toggleManagedTargetProfiles(checked) {
    document.querySelectorAll('.managed-target-profile-check').forEach(input => { input.checked = checked; });
  },

  async viewManagedTargets() {
    const profileIds = this._managedTargetProfileIds();
    if (!profileIds.length) return showToast('Chọn ít nhất 1 profile', 'warning');
    const type = this.managedTargetType || 'facebook';
    const response = await api(`/api/browsers/targets?type=${encodeURIComponent(type)}`);
    this.managedTargets = response.data || [];
    const result = document.getElementById('managed-target-results');
    if (result) result.innerHTML = this._managedTargetResultHtml(type, profileIds);
  },

  async scanManagedTargets() {
    const profileIds = this._managedTargetProfileIds();
    if (!profileIds.length) return showToast('Chọn ít nhất 1 profile', 'warning');
    const type = this.managedTargetType || 'facebook';
    const result = document.getElementById('managed-target-results');
    if (result) result.innerHTML = '<div class="managed-target-empty">Đang lấy danh sách...</div>';
    try {
      const response = await api('/api/browsers/targets/scan', {
        method: 'POST',
        body: { type, profileIds },
      });
      const payload = response.data || {};
      this.managedTargets = payload.data || [];
      if (result) {
        result.innerHTML = `
          <div class="managed-target-summary">Đã cập nhật ${payload.results?.filter(item => item.success).length || 0}/${payload.results?.length || 0} profile</div>
          ${this._managedTargetResultHtml(type, profileIds)}`;
      }
      showToast('Đã cập nhật danh sách', 'success');
    } catch (error) {
      if (result) result.innerHTML = `<div class="managed-target-empty">${this._escapeHtml(error.message || 'Không lấy được danh sách')}</div>`;
    }
  },

  filterProvider(provider) {
    this.providerFilter = provider;
    this.renderProfilesTable(this.profiles);
  },

  toggleGroupFilter(groupId, checked) {
    groupId = String(groupId);
    if (checked) this.groupFilter.add(groupId);
    else this.groupFilter.delete(groupId);
    this.renderProfilesTable(this.profiles);
    const details = document.querySelector('.browser-group-filter');
    if (details) details.open = true;
  },

  clearGroupFilter() {
    this.groupFilter.clear();
    this.renderProfilesTable(this.profiles);
  },

  toggleProfileSort() {
    this.nameSort = this.nameSort === 'asc' ? 'desc' : 'asc';
    this.renderProfilesTable(this.profiles);
  },

  searchProfiles(value) {
    this.searchText = value || '';
    this.renderProfilesTable(this.profiles);
    const input = document.querySelector('.browser-search');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  },

  async copyProfileName(id) {
    const profile = this.profiles.find(item => Number(item.id) === Number(id));
    if (!profile) return;
    const name = String(profile.name || '');
    try {
      let copied = false;
      if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(name);
          copied = true;
        } catch (_) {}
      }
      if (!copied) {
        const input = document.createElement('textarea');
        input.value = name;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        copied = document.execCommand('copy');
        input.remove();
      }
      if (!copied) throw new Error('Copy was rejected');
      showToast(`Đã sao chép tên profile: ${name}`, 'success');
    } catch (_) {
      showToast('Không sao chép được tên profile', 'error');
    }
  },

  _groupCheckboxes(selectedIds = []) {
    const selected = new Set((selectedIds || []).map(Number));
    if (!this.groups.length) {
      return '<div class="browser-group-empty">Chưa có nhóm. Hãy tạo nhóm trong mục Quản lý nhóm.</div>';
    }
    return this.groups.map(group => `
      <label class="browser-group-choice">
        <input type="checkbox" class="browser-group-choice-input" value="${group.id}"
               ${selected.has(Number(group.id)) ? 'checked' : ''}>
        <span>${this._escapeHtml(group.name)}</span>
        <small>${group.profile_count} profile</small>
      </label>
    `).join('');
  },

  showGroupManagerModal() {
    const rows = this.groups.length ? this.groups.map(group => `
      <div class="browser-group-manage-row">
        <input class="form-input" id="browser-group-name-${group.id}"
               value="${this._escapeHtml(group.name)}" maxlength="60">
        <span>${group.profile_count} profile</span>
        <button class="btn btn-secondary btn-sm" onclick="BrowserManager.renameGroup(${group.id})">Lưu</button>
        <button class="btn btn-secondary btn-sm danger-link" onclick="BrowserManager.deleteGroup(${group.id})">Xóa</button>
      </div>
    `).join('') : '<div class="browser-group-empty">Chưa có nhóm profile.</div>';
    const body = `
      <div class="browser-group-create">
        <input class="form-input" id="browser-new-group-name" maxlength="60"
               placeholder="Tên nhóm mới" onkeydown="if(event.key === 'Enter') BrowserManager.createGroup()">
        <button class="btn btn-primary" onclick="BrowserManager.createGroup()">Tạo nhóm</button>
      </div>
      <div class="browser-group-manage-list">${rows}</div>
      <div class="browser-group-safe-note">Xóa nhóm chỉ gỡ nhãn nhóm, không xóa profile hoặc dữ liệu trình duyệt.</div>
    `;
    showModal(
      'Quản lý nhóm profile',
      body,
      '<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>'
    );
  },

  async createGroup() {
    const name = document.getElementById('browser-new-group-name')?.value?.trim() || '';
    if (!name) return showToast('Nhập tên nhóm trước', 'warning');
    await api('/api/browsers/groups', { method: 'POST', body: { name } });
    showToast('Đã tạo nhóm', 'success');
    await this.load();
    this.showGroupManagerModal();
  },

  async renameGroup(id) {
    const name = document.getElementById(`browser-group-name-${id}`)?.value?.trim() || '';
    if (!name) return showToast('Tên nhóm không được để trống', 'warning');
    await api(`/api/browsers/groups/${id}`, { method: 'PUT', body: { name } });
    showToast('Đã đổi tên nhóm', 'success');
    await this.load();
    this.showGroupManagerModal();
  },

  async deleteGroup(id) {
    const group = this.groups.find(item => Number(item.id) === Number(id));
    if (!group) return;
    const confirmed = await showConfirm(
      'Xóa nhóm profile',
      `Xóa nhóm <strong>${this._escapeHtml(group.name)}</strong>?<br>`
      + 'Profile trong nhóm sẽ được giữ nguyên và chỉ mất nhãn nhóm này.'
    );
    if (!confirmed) {
      this.showGroupManagerModal();
      return;
    }
    await api(`/api/browsers/groups/${id}`, { method: 'DELETE' });
    showToast('Đã xóa nhóm, profile vẫn được giữ nguyên', 'success');
    await this.load();
    this.showGroupManagerModal();
  },

  showProfileGroupModal(profileId) {
    const profile = this.profiles.find(item => Number(item.id) === Number(profileId));
    if (!profile) return;
    const selectedIds = (profile.groups || []).map(group => Number(group.id));
    const body = `
      <div class="browser-group-edit-summary">
        <strong>${this._escapeHtml(profile.name)}</strong>
        <span>Có thể chọn một hoặc nhiều nhóm.</span>
      </div>
      <div class="browser-group-choice-list">${this._groupCheckboxes(selectedIds)}</div>
    `;
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="BrowserManager.saveProfileGroups(${profileId})">Lưu nhóm</button>
    `;
    showModal('Nhóm của profile', body, footer);
  },

  async saveProfileGroups(profileId) {
    const groupIds = [...document.querySelectorAll('.browser-group-choice-input:checked')]
      .map(input => Number(input.value));
    await api('/api/browsers/groups/members/assign', {
      method: 'PUT',
      body: { profileIds: [profileId], groupIds, mode: 'replace' },
    });
    closeModal();
    showToast(groupIds.length ? 'Đã cập nhật nhóm profile' : 'Đã chuyển về Chưa phân nhóm', 'success');
    await this.load();
  },

  showBulkGroupModal() {
    const profileIds = [...this.selectedProfileIds].map(Number);
    if (!profileIds.length) return showToast('Vui lòng chọn ít nhất 1 profile', 'warning');
    const body = `
      <div class="browser-group-edit-summary">
        <strong>${profileIds.length} profile đã chọn</strong>
        <span>Chọn cách áp dụng để không làm mất nhóm hiện có ngoài ý muốn.</span>
      </div>
      <label class="form-group">
        <span class="form-label">Thao tác</span>
        <select class="form-select" id="browser-group-bulk-mode">
          <option value="add">Thêm vào nhóm - giữ nhóm hiện có</option>
          <option value="remove">Gỡ khỏi nhóm đã chọn</option>
          <option value="replace">Thay thế toàn bộ nhóm</option>
        </select>
      </label>
      <div class="browser-group-choice-list">${this._groupCheckboxes()}</div>
      <div class="browser-group-safe-note">Chọn “Thay thế toàn bộ” và không tích nhóm nào để chuyển về Chưa phân nhóm.</div>
    `;
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="BrowserManager.saveBulkGroups()">Áp dụng</button>
    `;
    showModal('Chuyển nhóm profile', body, footer);
  },

  async saveBulkGroups() {
    const profileIds = [...this.selectedProfileIds].map(Number);
    const mode = document.getElementById('browser-group-bulk-mode')?.value || 'add';
    const groupIds = [...document.querySelectorAll('.browser-group-choice-input:checked')]
      .map(input => Number(input.value));
    if (mode !== 'replace' && !groupIds.length) {
      return showToast('Chọn ít nhất một nhóm để thêm hoặc gỡ', 'warning');
    }
    await api('/api/browsers/groups/members/assign', {
      method: 'PUT',
      body: { profileIds, groupIds, mode },
    });
    closeModal();
    showToast(`Đã cập nhật nhóm cho ${profileIds.length} profile`, 'success');
    await this.load();
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

  async bulkDelete() {
    const profileIds = [...this.selectedProfileIds].map(Number);
    if (!profileIds.length) return showToast('Vui lòng chọn ít nhất 1 profile', 'warning');
    const confirmed = await showConfirm(
      'Xóa nhiều profile',
      `Xóa <strong>${profileIds.length} profile</strong> đã chọn khỏi tool?<br>`
      + 'Dữ liệu gốc của GoLogin, GemLogin, GPM và GenLogin sẽ không bị xóa.'
    );
    if (!confirmed) return;
    try {
      const response = await api('/api/browsers/bulk/delete', {
        method: 'DELETE',
        body: { profileIds },
      });
      const result = response.data || {};
      for (const item of result.results || []) {
        if (item.success) this.selectedProfileIds.delete(Number(item.id));
      }
      showToast(
        result.failureCount
          ? `Đã xóa ${result.successCount}/${result.total} profile; ${result.failureCount} profile lỗi`
          : `Đã xóa ${result.successCount} profile`,
        result.failureCount ? 'warning' : 'success',
        5000
      );
      await this.load();
    } catch (_) {}
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

  showProfileLog(id) {
    const profile = this.profiles.find(p => Number(p.id) === Number(id));
    if (!profile) return;
    const logs = (typeof Runner !== 'undefined' && Array.isArray(Runner.logEntries))
      ? Runner.logEntries.filter(item =>
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
    if (provider === 'gpm') return `
      ${input('Local API', 'provider-api-url', cfg.gpm_api_url, 'http://127.0.0.1:9495/api/v1')}
      ${input('File GPMLoginGlobal.exe', 'provider-executable-path', cfg.gpm_executable_path, '...\\GPMLoginGlobal\\GPMLoginGlobal.exe')}`;
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
    if (provider === 'gpm') return {
      gpm_api_url: value('provider-api-url'),
      gpm_executable_path: value('provider-executable-path'),
    };
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

  _refreshProviderNamesAutomatically() {
    const hasExternalProfiles = this.profiles.some(profile => (profile.provider || 'chrome') !== 'chrome');
    if (!hasExternalProfiles || this.nameSyncPromise || Date.now() - this.lastNameSyncAt < 60000) return;
    this.lastNameSyncAt = Date.now();
    this.nameSyncPromise = (async () => {
      const response = await apiSilent('/api/browsers/providers/refresh-names', {
        method: 'POST',
        body: {},
      });
      const result = response.data || {};
      if (!result.changed && !result.displayNameChanged) return;
      const profilesResponse = await apiSilent('/api/browsers');
      this.profiles = profilesResponse.data || [];
      const validIds = new Set(this.profiles.map(profile => Number(profile.id)));
      this.selectedProfileIds = new Set(
        [...this.selectedProfileIds].filter(id => validIds.has(Number(id)))
      );
      this.renderProfilesTable(this.profiles);
    })().catch(() => {}).finally(() => {
      this.nameSyncPromise = null;
    });
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
      <div class="discovered-profile-list">${rows}</div>`;
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
    const response = await api('/api/browsers/providers/import', {
      method: 'POST',
      body: { profiles, platforms: App.platforms },
    });
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
          <p style="font-size: 14px;">Nhấn <strong>Tạo mới</strong> để tạo profile Chrome mới</p>
        </div>
      `;
      return;
    }

    let html = '<div class="browser-grid">';

    profiles.forEach(profile => {
      const isOpen = profile.status === 'open';
      const isLogin = profile.status === 'login';
      const provider = profile.provider || 'chrome';
      const firstLetter = (profile.name || 'P').charAt(0).toUpperCase();

      // Proxy info text
      let proxyText = 'Không có proxy';
      if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host) {
        proxyText = `${profile.proxy_type.toUpperCase()} — ${profile.proxy_host}:${profile.proxy_port || ''}`;
      }

      // Status badge
      const statusHtml = isLogin
        ? '<span class="badge badge-pending">Đang đăng nhập</span>'
        : isOpen
        ? '<span class="badge badge-open">🟢 Đang mở</span>'
        : '<span class="badge badge-closed">🔴 Đã đóng</span>';

      // Action buttons
      const launchBtn = (isOpen || isLogin)
        ? `<button class="btn btn-sm btn-danger" onclick="BrowserManager.closeBrowser(${profile.id})">🔴 Đóng Chrome</button>`
        : `<button class="btn btn-sm btn-primary" onclick="BrowserManager.launchBrowser(${profile.id})">🟢 Mở Chrome</button>`;

      html += `
        <div class="browser-card ${isOpen ? 'is-open' : ''} ${isLogin ? 'is-login' : ''}" id="browser-card-${profile.id}">
          <div class="browser-card-header">
            <div class="browser-avatar">${firstLetter}</div>
            <div>
              <button type="button" class="browser-name browser-name-copy"
                title="Bấm để sao chép tên profile"
                onclick="BrowserManager.copyProfileName(${profile.id})">${this._escapeHtml(profile.name)}</button>
              <div style="margin-top: 4px;">${statusHtml}</div>
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
      `Xóa profile <strong>${this._escapeHtml(name)}</strong> khỏi tool?<br>Dữ liệu gốc của trình duyệt Anti-detect không bị xóa.`
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

  _watchLoginClose(id) {
    id = Number(id);
    const currentTimer = this.loginPollTimers.get(id);
    if (currentTimer) clearTimeout(currentTimer);
    const timer = setTimeout(async () => {
      try {
        const response = await apiSilent(`/api/browsers/${id}/status`);
        if (response.data?.status === 'login') {
          this._watchLoginClose(id);
          return;
        }
        this.loginPollTimers.delete(id);
        await this.load();
      } catch (_) {
        this._watchLoginClose(id);
      }
    }, 1500);
    this.loginPollTimers.set(id, timer);
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
      const platform = encodeURIComponent(App.currentPlatform || 'facebook');
      const response = await api(`/api/browsers/${id}/launch?platform=${platform}`, { method: 'POST' });
      showToast(response.displayNameSync?.changed
        ? 'Đã đồng bộ tên profile và mở trình duyệt'
        : 'Đã mở trình duyệt', 'success');
      // Refresh after a short delay to let status update
      await this.load();
      if (response.mode === 'login') this._watchLoginClose(id);
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
      const loginTimer = this.loginPollTimers.get(Number(id));
      if (loginTimer) clearTimeout(loginTimer);
      this.loginPollTimers.delete(Number(id));
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
