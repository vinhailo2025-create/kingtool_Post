/**
 * DataManager - Enhanced AG Grid data management module
 * Features: Custom columns, range selection, copy/paste/delete,
 * resizable rows/columns, word wrap, file path support, rich headers
 */
const DataManager = (() => {
  let gridApi = null;
  let gridInitialized = false;
  let customColumns = [];
  let isUndoRedoInProgress = false;
  let syncRules = [];
  let syncModalState = null;
  let profilePickerState = null;
  const pendingAutoSync = new Map();
  const SYNC_BLOCKED_VARS = new Set(['status', 'link', 'link_fanpage', 'link_post', 'time_post', 'time_comment', 'comment_status']);
  const PLATFORM_META = {
    facebook: { label: 'Facebook', icon: '/assets/platforms/facebook.webp' },
    tiktok: { label: 'TikTok', icon: '/assets/platforms/tiktok.png' },
    youtube: { label: 'YouTube', icon: '/assets/platforms/youtube.webp' },
    threads: { label: 'Threads', icon: '/assets/platforms/threads.png' },
    instagram: { label: 'Instagram', icon: '/assets/platforms/instagram.png' },
    x: { label: 'X', icon: '/assets/platforms/x.png' },
  };
  const PROFILE_PROVIDER_LABELS = {
    chrome: 'Chrome',
    gologin: 'GoLogin',
    gemlogin: 'GemLogin',
    gpm: 'GPM Login',
    genlogin: 'GenLogin',
  };

  // Fixed password for custom-data / variable features (constant on every machine)
  const CUSTOM_PASSWORD = '123456';
  let customUnlocked = false;

  // Turn a column name into a memorable variable token, e.g. "Tên Profile" -> ten_profile
  function slugVar(name) {
    const s = String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return s || 'cot';
  }

  // Built-in (default) columns. Label hiển thị + biến đều có thể đổi tên.
  // `field` là cột thật trong DB (không đổi); `label`/`var` chỉ là mặc định gợi ý.
  const BUILTIN_FIELDS = [
    { field: 'content',    label: 'Nội dung' },
    { field: 'image_path', label: 'Hình ảnh' },
    { field: 'product_id', label: 'ID_Sản Phẩm', platform: 'tiktok' },
    { field: 'link',       label: 'Link' },
    { field: 'target',     label: 'Nhóm/Trang' },
    { field: 'status',     label: 'Trạng thái' },
    { field: 'note',       label: 'Ghi chú' },
  ];
  // Overrides do người dùng đặt, lưu ở settings key `field_overrides`.
  // { content: { label: '...', var: '...' }, ... }
  let fieldOverrides = {};

  function fieldLabel(field, fallback) {
    const o = fieldOverrides[field];
    return (o && o.label) ? o.label : fallback;
  }
  function fieldVar(field) {
    const o = fieldOverrides[field];
    return (o && o.var) ? o.var : field;
  }
  function sanitizeMediaValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/"/g, '');
  }
  async function loadFieldOverrides() {
    try {
      const res = await apiSilent('/api/settings');
      const raw = res && res.data ? res.data.field_overrides : null;
      fieldOverrides = raw ? JSON.parse(raw) : {};
    } catch (e) { fieldOverrides = {}; }
  }

  // Range selection state
  const rangeState = {
    isDragging: false,
    active: false,
    startRowIdx: -1,
    startColId: null,
    endRowIdx: -1,
    endColId: null,
  };


  // Undo/Redo stack
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 50;

  // ============================================
  // Build Column Definitions (dynamic)
  // ============================================
  // Tìm cột tùy chỉnh theo biến (var_key)
  function customColByVar(varKey) {
    return customColumns.find(c => (c.var_key || slugVar(c.name)) === varKey);
  }

  function hasEnabledSyncRule(varKey) {
    return syncRules.some(rule => rule.source_var_key === varKey && rule.enabled);
  }

  class SyncColumnHeader {
    init(params) {
      this.params = params;
      const varKey = params.column.getColDef()._syncVarKey;
      const root = document.createElement('div');
      root.className = 'sync-column-header';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'sync-column-label';
      label.textContent = params.displayName || '';
      label.title = `Sắp xếp theo ${params.displayName || 'cột'}`;
      label.addEventListener('click', event => params.progressSort(!!event.shiftKey));

      this.sortMark = document.createElement('span');
      this.sortMark.className = 'sync-column-sort';
      const updateSort = () => {
        const sort = params.column.getSort();
        this.sortMark.textContent = sort === 'asc' ? '↑' : sort === 'desc' ? '↓' : '';
      };
      updateSort();
      params.column.addEventListener('sortChanged', updateSort);
      this.removeSortListener = () => params.column.removeEventListener('sortChanged', updateSort);

      const syncButton = document.createElement('button');
      syncButton.type = 'button';
      syncButton.className = 'column-sync-button' + (hasEnabledSyncRule(varKey) ? ' is-auto' : '');
      syncButton.innerHTML = '<span aria-hidden="true">↻</span>';
      syncButton.title = hasEnabledSyncRule(varKey)
        ? 'Đồng bộ tự động đang bật · Bấm để cài đặt'
        : 'Đồng bộ cột này sang nền tảng khác';
      syncButton.setAttribute('aria-label', syncButton.title);
      syncButton.addEventListener('click', event => {
        event.stopPropagation();
        showColumnSyncModal(
          varKey,
          params.displayName || varKey,
          params.column.getColDef()._syncColType || 'text'
        );
      });

      root.appendChild(label);
      root.appendChild(this.sortMark);
      root.appendChild(syncButton);
      this.eGui = root;
    }

    getGui() { return this.eGui; }
    refresh() { return false; }
    destroy() { if (this.removeSortListener) this.removeSortListener(); }
  }

  function syncableColumn(def, varKey, colType = 'text') {
    if (!varKey || SYNC_BLOCKED_VARS.has(varKey)) return def;
    def._syncVarKey = varKey;
    def._syncColType = colType;
    def.headerComponent = SyncColumnHeader;
    return def;
  }

  // Tạo colDef cho 1 cột tùy chỉnh
  function customColDef(col, opts) {
    opts = opts || {};
    const def = {
      headerName: opts.label || col.name,
      field: `custom_${col.id}`,
      minWidth: opts.minWidth || 120,
      editable: opts.editable !== false,
      autoHeight: true,
      wrapText: true,
      cellClass: 'cell-wrap' + (opts.isLink ? ' cell-link' : ''),
      _customColId: col.id,
      _customColType: col.col_type,
      headerComponentParams: { customColId: col.id },
    };
    if (opts.width) { def.width = opts.width; } else { def.flex = opts.flex || 1; }
    if (col.col_type === 'file') { def.cellRenderer = imagePathRenderer; def.tooltipValueGetter = (p) => p.value || ''; }
    if (col.col_type === 'select') {
      const values = opts.selectValues || [];
      def.editable = false;
      def._selectValues = values;
      def.cellRenderer = selectCellRenderer;
    }
    if (opts.largeText) {
      def.cellEditor = 'agLargeTextCellEditor';
      def.cellEditorPopup = true;
      def.cellEditorParams = { maxLength: 10000, rows: 8, cols: 55 };
    }
    if (opts.cellRenderer) def.cellRenderer = opts.cellRenderer;
    return syncableColumn(def, col.var_key || slugVar(col.name), col.col_type || 'text');
  }

  function buildColumnDefs() {
    const cols = [
      {
        headerName: '', field: 'checkbox', colId: 'checkbox',
        headerCheckboxSelection: true, checkboxSelection: true,
        width: 56, maxWidth: 56, minWidth: 56, pinned: 'left',
        suppressHeaderMenuButton: true, sortable: false, filter: false,
        editable: false, resizable: false, suppressMovable: true,
        lockPosition: 'left', cellClass: 'cell-checkbox', headerClass: 'header-checkbox',
      },
      {
        headerName: 'Stt', colId: 'rownum',
        valueGetter: (params) => {
          if (!params.node || params.node.rowIndex == null) return '';
          return params.node.rowIndex + 1;
        },
        width: 68, maxWidth: 80, minWidth: 56, pinned: 'left',
        suppressHeaderMenuButton: true, sortable: false, filter: false,
        editable: false, suppressMovable: true, lockPosition: 'left',
        cellClass: 'cell-row-number',
      },
    ];

    // name_profile (ngay sau Stt)
    const npc = customColByVar('name_profile');
    if (npc) cols.push(customColDef(npc, {
      label: 'Tên Profile', editable: true, width: 190,
      cellRenderer: profileNameRenderer,
    }));

    if (App.currentPlatform === 'facebook') {
      const fanpageLink = customColByVar('link_fanpage');
      if (fanpageLink) cols.push(customColDef(fanpageLink, {
        label: 'Link Fanpage', editable: true, isLink: true, minWidth: 220, flex: 1,
      }));
    }

    // Nội dung
    cols.push(syncableColumn({
      headerName: fieldLabel('content', 'Nội dung'), field: 'content',
      minWidth: 220, flex: 2, editable: true,
      cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true,
      cellEditorParams: { maxLength: 10000, rows: 10, cols: 60 },
      autoHeight: true, wrapText: true, cellClass: 'cell-wrap',
    }, 'content', 'text'));

    // Media (image_path)
    cols.push(syncableColumn({
      headerName: 'Media', field: 'image_path',
      minWidth: 200, flex: 1, editable: true, autoHeight: true, wrapText: true,
      cellClass: 'cell-wrap', cellRenderer: imagePathRenderer,
      valueParser: params => sanitizeMediaValue(params.newValue),
      tooltipValueGetter: (p) => p.value || '',
    }, 'image_path', 'file'));

    // YouTube posting data. These columns are platform-owned custom fields,
    // so Facebook and TikTok rows remain completely independent.
    if (App.currentPlatform === 'youtube') {
      const description = customColByVar('description');
      if (description) cols.push(customColDef(description, {
        label: 'Mô tả video', minWidth: 240, flex: 2, largeText: true,
      }));

      const channelName = customColByVar('channel_name');
      if (channelName) cols.push(customColDef(channelName, {
        label: 'Tên kênh', minWidth: 160, flex: 1,
      }));

      const playlist = customColByVar('playlist');
      if (playlist) cols.push(customColDef(playlist, {
        label: 'Danh sách phát', minWidth: 180, flex: 1,
      }));

      const privacyStatus = customColByVar('privacy_status');
      if (privacyStatus) cols.push(customColDef(privacyStatus, {
        label: 'Trạng thái lưu', width: 170,
        selectValues: ['Không công khai', 'Riêng tư', 'Công khai'],
      }));

      const thumbnail = customColByVar('thumbnail');
      if (thumbnail) cols.push(customColDef(thumbnail, {
        label: 'Hình Thumbnail', minWidth: 210, flex: 1,
      }));

      const keywords = customColByVar('keywords');
      if (keywords) cols.push(customColDef(keywords, {
        label: 'Từ khóa', minWidth: 200, flex: 1, largeText: true,
      }));
    }

    // TikTok product identifier
    if (App.currentPlatform === 'tiktok') {
      cols.push(syncableColumn({
        headerName: fieldLabel('product_id', 'ID_Sản Phẩm'), field: 'product_id',
        width: 180, minWidth: 150, maxWidth: 240, editable: true,
        autoHeight: true, wrapText: true, cellClass: 'cell-wrap',
      }, 'product_id', 'text'));
    }

    // Trạng thái
    cols.push({
      headerName: fieldLabel('status', 'Trạng thái'), field: 'status',
      width: 140, minWidth: 120, maxWidth: 170, editable: true,
      cellEditor: 'agSelectCellEditor',
      cellEditorParams: { values: ['pending', 'running', 'success', 'error'] },
      cellRenderer: statusCellRenderer,
    });

    // link_post (tự điền sau khi đăng)
    const lpc = customColByVar('link_post');
    if (lpc) cols.push(customColDef(lpc, { label: 'Link Post', editable: false, isLink: true, minWidth: 210, flex: 1 }));

    // time_post (tự điền thời gian đăng)
    const tpc = customColByVar('time_post');
    if (tpc) cols.push(customColDef(tpc, { label: 'Thời gian đăng', editable: false, width: 172 }));

    // Dữ liệu đầu vào và kết quả của hàng đợi bình luận bền vững
    const cc = customColByVar('comment');
    if (cc) cols.push(customColDef(cc, {
      label: 'Nội dung bình luận', editable: true, minWidth: 220, flex: 2, largeText: true,
    }));

    const cmc = customColByVar('comment_media');
    if (cmc) cols.push(customColDef(cmc, {
      label: 'Media bình luận', editable: true, minWidth: 200, flex: 1,
    }));

    const ctc = customColByVar('time_comment');
    if (ctc) cols.push(customColDef(ctc, {
      label: 'Thời gian bình luận', editable: false, width: 172,
    }));

    const csc = customColByVar('comment_status');
    if (csc) cols.push(customColDef(csc, {
      label: 'Trạng thái bình luận', editable: false, width: 172,
      cellRenderer: commentStatusCellRenderer,
    }));

    return cols;
  }

  // ============================================
  // Custom Cell Renderers
  // ============================================
  function imagePathRenderer(params) {
    const value = params.value || '';
    const container = document.createElement('div');
    container.className = 'cell-image-path';

    const textSpan = document.createElement('span');
    textSpan.className = 'image-path-text';
    textSpan.textContent = value || '';
    textSpan.title = value;

    const browseBtn = document.createElement('button');
    browseBtn.className = 'image-browse-btn';
    browseBtn.textContent = '📁';
    browseBtn.title = 'Chọn file từ máy';
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      browseFile(params);
    });

    container.appendChild(textSpan);
    container.appendChild(browseBtn);
    return container;
  }

  function profileNameRenderer(params) {
    const value = params.value || '';
    const container = document.createElement('div');
    container.className = 'cell-profile-name';

    const textSpan = document.createElement('span');
    textSpan.className = 'profile-name-text';
    textSpan.textContent = value || '';
    textSpan.title = value || 'Chưa chọn profile';

    const pickBtn = document.createElement('button');
    pickBtn.className = 'profile-pick-btn';
    pickBtn.type = 'button';
    pickBtn.textContent = '👤';
    pickBtn.title = 'Chọn profile từ tab Trình duyệt';
    pickBtn.setAttribute('aria-label', 'Chọn profile từ tab Trình duyệt');
    pickBtn.addEventListener('click', event => {
      event.stopPropagation();
      showProfilePicker(params);
    });

    container.appendChild(textSpan);
    container.appendChild(pickBtn);
    return container;
  }

  function getNameProfileColumn() {
    return customColByVar('name_profile');
  }

  function targetRowsForProfilePicker(params) {
    if (!gridApi) return [];
    const selected = gridApi.getSelectedRows();
    if (selected.length > 1) return selected;
    if (params && params.data) return [params.data];
    const focused = gridApi.getFocusedCell();
    if (focused) {
      const node = gridApi.getDisplayedRowAtIndex(focused.rowIndex);
      if (node && node.data) return [node.data];
    }
    return selected.length ? selected : [];
  }

  function profilePickerTargets() {
    const rows = targetRowsForProfilePicker(profilePickerState && profilePickerState.params);
    const seen = new Set();
    return rows.filter(row => row && row.id && !seen.has(row.id) && seen.add(row.id));
  }

  async function showProfilePicker(params = undefined) {
    if (params === undefined && profilePickerState) params = profilePickerState.params || null;
    if (params === undefined) params = null;
    const nameCol = getNameProfileColumn();
    if (!nameCol) {
      showToast('Chưa có cột name_profile', 'warning');
      return;
    }
    const targets = params ? targetRowsForProfilePicker(params) : targetRowsForProfilePicker(null);
    if (!targets.length) {
      showToast('Chọn ít nhất 1 hàng hoặc bấm vào ô Tên Profile trước', 'warning');
      return;
    }
    profilePickerState = {
      params,
      profiles: [],
      provider: 'all',
      session: 'all',
      search: '',
    };
    showModal(
      `Chọn profile · ${App.platformLabel()}`,
      '<div class="profile-picker-loading"><span class="sync-loader"></span><div>Đang tải danh sách profile...</div></div>',
      '<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>'
    );
    document.getElementById('modal')?.classList.add('modal-wide');
    try {
      const res = await apiSilent('/api/browsers');
      profilePickerState.profiles = res.data || [];
      renderProfilePickerModal();
    } catch (err) {
      document.getElementById('modal-body').innerHTML = `<div class="sync-preview-empty error">${escapeHtml(err.message)}</div>`;
    }
  }

  function visibleProfileChoices() {
    if (!profilePickerState) return [];
    const needle = String(profilePickerState.search || '').trim().toLowerCase();
    return profilePickerState.profiles.filter(profile => {
      const provider = profile.provider || 'chrome';
      const providerMatch = profilePickerState.provider === 'all' || provider === profilePickerState.provider;
      const sessionValid = !!profile.session_valid;
      const sessionMatch = profilePickerState.session === 'all'
        || (profilePickerState.session === 'valid' ? sessionValid : !sessionValid);
      const textMatch = !needle || [profile.name, profile.note, profile.provider_profile_id, provider]
        .some(value => String(value || '').toLowerCase().includes(needle));
      return providerMatch && sessionMatch && textMatch;
    });
  }

  function renderProfilePickerModal() {
    if (!profilePickerState) return;
    const profiles = profilePickerState.profiles || [];
    const targets = profilePickerTargets();
    const providerCounts = profiles.reduce((acc, profile) => {
      const key = profile.provider || 'chrome';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const filters = ['all', 'chrome', 'gologin', 'gemlogin', 'gpm', 'genlogin'].map(provider => {
      const label = provider === 'all' ? 'Tất cả' : PROFILE_PROVIDER_LABELS[provider];
      const count = provider === 'all' ? profiles.length : (providerCounts[provider] || 0);
      return `<button class="provider-filter ${profilePickerState.provider === provider ? 'active' : ''}" data-profile-provider="${provider}">
        ${label}<span>${count}</span>
      </button>`;
    }).join('');
    const choices = visibleProfileChoices();
    const rows = choices.map(profile => {
      const provider = profile.provider || 'chrome';
      const providerLabel = PROFILE_PROVIDER_LABELS[provider] || provider;
      const sessionHtml = profile.session_valid
        ? '<span class="badge badge-success">Đã đăng nhập</span>'
        : '<span class="badge badge-closed">Chưa đăng nhập</span>';
      const statusHtml = profile.status === 'open'
        ? '<span class="badge badge-open">Đang mở</span>'
        : '<span class="badge badge-closed">Đã đóng</span>';
      const avatar = escapeHtml((profile.name || 'P').charAt(0).toUpperCase());
      return `<button class="profile-picker-row" type="button" data-profile-id="${profile.id}">
        <span class="browser-avatar small">${avatar}</span>
        <span class="profile-picker-main">
          <strong>${escapeHtml(profile.name || '')}</strong>
          <small>${escapeHtml(profile.note || profile.provider_profile_id || '')}</small>
        </span>
        <span class="provider-badge provider-${provider}">${escapeHtml(providerLabel)}</span>
        ${sessionHtml}
        ${statusHtml}
      </button>`;
    }).join('') || '<div class="profile-picker-empty">Không có profile phù hợp bộ lọc.</div>';

    const current = targets.length === 1
      ? String(targets[0][`custom_${getNameProfileColumn().id}`] || '').trim()
      : '';
    const body = `
      <div class="profile-picker">
        <div class="profile-picker-summary">
          <div>
            <strong>${targets.length} hàng sẽ được gán profile</strong>
            <span>Dữ liệu được lưu vào cột text <code>name_profile</code>; vẫn copy/paste/fill xuống bình thường.</span>
          </div>
          ${current ? `<span class="badge badge-pending">Hiện tại: ${escapeHtml(current)}</span>` : ''}
        </div>
        <div class="provider-filter-row profile-picker-filters">${filters}</div>
        <div class="profile-picker-tools">
          <input class="form-input" id="profile-picker-search" value="${escapeHtml(profilePickerState.search)}" placeholder="Tìm profile theo tên, ghi chú, ID...">
          <select class="form-select" id="profile-picker-session">
            <option value="all" ${profilePickerState.session === 'all' ? 'selected' : ''}>Tất cả phiên</option>
            <option value="valid" ${profilePickerState.session === 'valid' ? 'selected' : ''}>Đã đăng nhập</option>
            <option value="invalid" ${profilePickerState.session === 'invalid' ? 'selected' : ''}>Chưa đăng nhập</option>
          </select>
        </div>
        <div class="profile-picker-list">${rows}</div>
      </div>`;
    document.getElementById('modal-body').innerHTML = body;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-secondary" onclick="DataManager.showProfilePicker()">Làm mới</button>
      <button class="btn btn-secondary" onclick="closeModal()">Đóng</button>`;

    document.querySelectorAll('[data-profile-provider]').forEach(button => {
      button.addEventListener('click', () => {
        profilePickerState.provider = button.getAttribute('data-profile-provider') || 'all';
        renderProfilePickerModal();
      });
    });
    const searchEl = document.getElementById('profile-picker-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        profilePickerState.search = searchEl.value || '';
        renderProfilePickerModal();
      });
      searchEl.focus();
      searchEl.setSelectionRange(searchEl.value.length, searchEl.value.length);
    }
    const sessionEl = document.getElementById('profile-picker-session');
    if (sessionEl) {
      sessionEl.addEventListener('change', () => {
        profilePickerState.session = sessionEl.value || 'all';
        renderProfilePickerModal();
      });
    }
    document.querySelectorAll('.profile-picker-row[data-profile-id]').forEach(button => {
      button.addEventListener('click', () => {
        const id = Number(button.getAttribute('data-profile-id'));
        const profile = (profilePickerState.profiles || []).find(item => Number(item.id) === id);
        if (profile) assignProfileName(profile.name || '');
      });
    });
  }

  function assignProfileName(profileName) {
    const nameCol = getNameProfileColumn();
    if (!gridApi || !nameCol || !profileName) return;
    const field = `custom_${nameCol.id}`;
    const rows = profilePickerTargets();
    if (!rows.length) {
      showToast('Chưa chọn hàng để gán profile', 'warning');
      return;
    }
    for (const row of rows) {
      const node = gridApi.getRowNode(String(row.id));
      if (node) node.setDataValue(field, profileName);
    }
    closeModal();
    showToast(`Đã gán profile "${profileName}" cho ${rows.length} hàng`, 'success');
  }

  // Select columns are rendered as a real dropdown so one click opens the
  // choices immediately (AG Grid's edit-only select required a second action).
  function selectCellRenderer(params) {
    const select = document.createElement('select');
    select.className = 'form-select custom-select-cell';
    select.title = 'Chọn giá trị';
    const values = Array.isArray(params.colDef._selectValues) ? params.colDef._selectValues : [];
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      option.selected = String(value) === String(params.value || '');
      select.appendChild(option);
    });
    if (params.value && !values.includes(params.value)) {
      const option = document.createElement('option');
      option.value = params.value;
      option.textContent = params.value;
      option.selected = true;
      select.insertBefore(option, select.firstChild);
    }
    select.addEventListener('click', event => event.stopPropagation());
    select.addEventListener('change', () => {
      if (params.node && params.colDef.field) params.node.setDataValue(params.colDef.field, select.value);
    });
    return select;
  }

  function statusCellRenderer(params) {
    const statusMap = {
      pending: { label: '⏳ Chờ', cls: 'badge-pending' },
      running: { label: '🔄 Đang chạy', cls: 'badge-running' },
      success: { label: '✅ Thành công', cls: 'badge-success' },
      error: { label: '❌ Lỗi', cls: 'badge-error' },
    };
    const info = statusMap[params.value] || { label: params.value || '', cls: 'badge-closed' };
    const span = document.createElement('span');
    span.className = `badge ${info.cls}`;
    span.textContent = info.label;
    return span;
  }

  function commentStatusCellRenderer(params) {
    const statusMap = {
      waiting: { label: '⏳ Đang chờ', cls: 'badge-pending' },
      success: { label: '✅ Thành công', cls: 'badge-success' },
      error: { label: '❌ Lỗi', cls: 'badge-error' },
      skipped: { label: '⏭ Bỏ qua', cls: 'badge-closed' },
    };
    const info = statusMap[params.value] || { label: params.value || '', cls: 'badge-closed' };
    const span = document.createElement('span');
    span.className = `badge ${info.cls}`;
    span.textContent = info.label;
    return span;
  }

  // ============================================
  // Grid Initialization
  // ============================================
  function initGrid() {
    const container = document.getElementById('page-data');
    if (!container) return;

    container.innerHTML = `
      <div id="data-grid-wrapper" style="display:flex;flex-direction:column;height:100%;">
        <div id="data-grid" class="ag-theme-alpine-dark-custom" style="flex:1;width:100%;min-height:0;"></div>
        <div class="data-grid-footer">
          <span id="data-row-count">0 hàng</span>
          <span id="data-selected-count"></span>
        </div>
      </div>
    `;

    const gridDiv = document.getElementById('data-grid');

    const gridOptions = {
      columnDefs: buildColumnDefs(),
      defaultColDef: {
        sortable: true,
        filter: true,
        resizable: true,
        editable: false,
        wrapHeaderText: true,
        autoHeaderHeight: true,
      },
      rowSelection: 'multiple',
      suppressRowClickSelection: true,
      rowDragManaged: true,
      animateRows: true,
      undoRedoCellEditing: true,
      undoRedoCellEditingLimit: 30,
      rowDragEntireRow: false,
      suppressMoveWhenRowDragging: false,
      getRowId: (params) => String(params.data.id),
      tooltipShowDelay: 400,

      suppressCopyRowsToClipboard: false,
      suppressClipboardPaste: false,
      processCellForClipboard: (params) => params.value || '',
      processCellFromClipboard: (params) => params.value,

      // Row height
      rowHeight: null, // auto height
      getRowHeight: () => null, // let autoHeight handle it

      // Events
      onCellValueChanged: onCellValueChanged,
      onRowDragEnd: onRowDragEnd,
      onSelectionChanged: onSelectionChanged,
      onGridReady: () => { updateFooter(); },
      onPasteEnd: onPasteEnd,
    };

    gridApi = agGrid.createGrid(gridDiv, gridOptions);
    gridInitialized = true;

    // Keyboard shortcuts
    gridDiv.addEventListener('keydown', handleKeyDown);

    // Range selection via mouse drag
    gridDiv.addEventListener('mousedown', onRangeMouseDown);
    document.addEventListener('mousemove', onRangeMouseMove);
    document.addEventListener('mouseup', onRangeMouseUp);

    // Keep the overlay aligned while scrolling (horizontal + vertical)
    gridApi.addEventListener('bodyScroll', () => { if (rangeState.active) highlightRange(); });
  }

  // ============================================
  // Event Handlers
  // ============================================
  async function onCellValueChanged(event) {
    if (isUndoRedoInProgress) return;

    const { data, colDef, newValue, oldValue, node } = event;
    if (!data || !data.id) return;

    const field = colDef.field;
    if (!field || field === 'checkbox' || field === 'drag') return;
    const valueToSave = field === 'image_path' ? sanitizeMediaValue(newValue) : newValue;
    if (newValue !== valueToSave) {
      data[field] = valueToSave;
      if (node) gridApi.refreshCells({ rowNodes: [node], columns: [field], force: true });
    }
    if (valueToSave === oldValue) return;

    pushUndo({ type: 'cellEdit', rowId: data.id, field, oldValue, newValue: valueToSave });

    if (field.startsWith('custom_')) {
      const colId = parseInt(field.replace('custom_', ''));
      try {
        await apiSilent('/api/data/custom-data', {
          method: 'PUT',
          body: { post_id: data.id, column_id: colId, value: valueToSave || '' },
        });
        queueAutomaticSync(data.id, colDef._syncVarKey);
      } catch (err) {
        data[field] = oldValue;
        gridApi.applyTransaction({ update: [data] });
        showToast('Loi luu: ' + err.message, 'error');
      }
      return;
    }

    try {
      await apiSilent(`/api/data/${data.id}`, {
        method: 'PUT',
        body: { [field]: valueToSave },
      });
      queueAutomaticSync(data.id, colDef._syncVarKey);
    } catch (err) {
      data[field] = oldValue;
      gridApi.applyTransaction({ update: [data] });
      showToast('Loi luu: ' + err.message, 'error');
    }
  }

  async function onRowDragEnd() {
    const orderedIds = [];
    gridApi.forEachNode((node) => {
      if (node.data && node.data.id) orderedIds.push(node.data.id);
    });
    try {
      await apiSilent('/api/data/reorder', { method: 'POST', body: { orderedIds } });
    } catch (err) {
      showToast('Loi sap xep: ' + err.message, 'error');
    }
  }

  function onSelectionChanged() {
    if (rangeState.active) clearRangeHighlight();
    updateFooter();
  }

  async function onPasteEnd(event) {
    // After paste, save all changed cells
    // AG Grid will fire onCellValueChanged for each cell, so we don't need extra logic here
  }

  function updateFooter() {
    const countEl = document.getElementById('data-row-count');
    const selectedEl = document.getElementById('data-selected-count');
    if (gridApi) {
      let count = 0;
      gridApi.forEachNode(() => count++);
      if (countEl) countEl.textContent = `${count} hàng`;
      const selected = gridApi.getSelectedRows();
      if (selectedEl) {
        selectedEl.textContent = selected.length > 0 ? `Đã chọn ${selected.length} hàng` : '';
      }
    }
  }

  // ============================================
  // Keyboard Shortcuts
  // ============================================
  function handleKeyDown(e) {
    if (!gridApi) return;

    // Delete key - clear range or focused cell
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
      if (rangeState.active) {
        e.preventDefault();
        clearRangeCells();
        return;
      }
      const focusedCell = gridApi.getFocusedCell();
      if (focusedCell) {
        e.preventDefault();
        clearSelectedCells(focusedCell);
      }
    }

    const inEditor = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');

    // Ctrl+C - copy the active range
    if (e.key === 'c' && e.ctrlKey && rangeState.active && !inEditor) {
      e.preventDefault();
      copyRange();
      return;
    }

    // Ctrl+V - paste into the active range
    if (e.key === 'v' && e.ctrlKey && rangeState.active && !inEditor) {
      e.preventDefault();
      pasteRange();
      return;
    }

    // Ctrl+Z - undo
    if (e.key === 'z' && e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }

    // Ctrl+Y or Ctrl+Shift+Z - redo
    if ((e.key === 'y' && e.ctrlKey) || (e.key === 'z' && e.ctrlKey && e.shiftKey)) {
      e.preventDefault();
      redo();
      return;
    }

    // Ctrl+Enter - add new row
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      addRow();
    }
  }

  async function clearSelectedCells(focusedCell) {
    const field = focusedCell.column.getColId();
    if (!field || field === 'checkbox' || field === 'drag' || field === '0') return;

    const selectedRows = gridApi.getSelectedRows();
    const undoCells = [];
    const updates = new Map();
    const customUpdates = [];

    const rowsToProcess = selectedRows.length > 0 ? selectedRows : [];
    if (rowsToProcess.length === 0) {
      const node = gridApi.getDisplayedRowAtIndex(focusedCell.rowIndex);
      if (node && node.data) rowsToProcess.push(node.data);
    }

    for (const rowData of rowsToProcess) {
      undoCells.push({ rowId: rowData.id, field, oldValue: rowData[field] || '' });
      const node = gridApi.getRowNode(String(rowData.id));
      if (node) node.setDataValue(field, '');

      if (field.startsWith('custom_')) {
        const colId = parseInt(field.replace('custom_', ''));
        customUpdates.push({ post_id: rowData.id, column_id: colId, value: '' });
      } else {
        if (!updates.has(rowData.id)) updates.set(rowData.id, { id: rowData.id });
        updates.get(rowData.id)[field] = '';
      }
    }

    if (undoCells.length > 0) {
      pushUndo({ type: 'clearCells', cells: undoCells });
    }

    try {
      if (updates.size > 0) {
        await apiSilent('/api/data/bulk', { method: 'PUT', body: { updates: Array.from(updates.values()) } });
      }
      for (const cu of customUpdates) {
        await apiSilent('/api/data/custom-data', { method: 'PUT', body: cu });
      }
    } catch (err) {
      showToast('Loi xoa du lieu: ' + err.message, 'error');
    }
  }

  // ============================================
  // Range Selection (Excel-style drag)
  // ============================================

  const NON_DATA_COLS = new Set(['checkbox', 'drag', 'rownum', '0']);

  function getCellInfoFromEl(el) {
    if (!el || !el.closest) return null;
    const cellEl = el.closest('.ag-cell');
    const rowEl = el.closest('.ag-row');
    if (!cellEl || !rowEl) return null;
    const colId = cellEl.getAttribute('col-id');
    const rowIdx = parseInt(rowEl.getAttribute('row-index'));
    if (!colId || isNaN(rowIdx)) return null;
    if (NON_DATA_COLS.has(colId)) return null;
    return { colId, rowIdx, cellEl };
  }

  function getEditableColIds() {
    if (!gridApi) return [];
    const ids = [];
    gridApi.getAllDisplayedColumns().forEach(col => {
      const id = col.getColId();
      if (id && !NON_DATA_COLS.has(id)) ids.push(id);
    });
    return ids;
  }

  function getCellsInRange() {
    if (!rangeState.active || rangeState.startRowIdx < 0) return [];
    const b = getRangeBounds();
    if (!b) return [];
    const cells = [];
    for (let r = b.minRow; r <= b.maxRow; r++) {
      for (let c = b.minCol; c <= b.maxCol; c++) {
        cells.push({ rowIdx: r, colId: b.allCols[c] });
      }
    }
    return cells;
  }

  function getRangeBounds() {
    const allCols = getEditableColIds();
    const sIdx = allCols.indexOf(rangeState.startColId);
    const eIdx = allCols.indexOf(rangeState.endColId !== null ? rangeState.endColId : rangeState.startColId);
    if (sIdx < 0) return null;
    return {
      allCols,
      minRow: Math.min(rangeState.startRowIdx, rangeState.endRowIdx),
      maxRow: Math.max(rangeState.startRowIdx, rangeState.endRowIdx),
      minCol: Math.min(sIdx, eIdx < 0 ? sIdx : eIdx),
      maxCol: Math.max(sIdx, eIdx < 0 ? sIdx : eIdx),
    };
  }

  // Overlay element that draws the selection box ON TOP of cells (never touches
  // cell DOM, so data is never hidden/duplicated and there is no autoHeight thrash)
  function ensureOverlay() {
    let ov = document.getElementById('range-overlay');
    if (!ov) {
      const gridDiv = document.getElementById('data-grid');
      if (!gridDiv) return null;
      ov = document.createElement('div');
      ov.id = 'range-overlay';
      gridDiv.appendChild(ov);
    }
    return ov;
  }

  function highlightRange() {
    const gridDiv = document.getElementById('data-grid');
    const ov = ensureOverlay();
    if (!gridDiv || !ov) return;

    if (!rangeState.active) { ov.style.display = 'none'; return; }
    const b = getRangeBounds();
    if (!b) { ov.style.display = 'none'; return; }

    // Union bounding box of all rendered cells that fall inside the range
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, found = false;
    gridDiv.querySelectorAll('.ag-cell').forEach((cellEl) => {
      const colId = cellEl.getAttribute('col-id');
      const c = b.allCols.indexOf(colId);
      if (c < 0 || c < b.minCol || c > b.maxCol) return;
      const rowEl = cellEl.closest('.ag-row');
      if (!rowEl) return;
      const r = parseInt(rowEl.getAttribute('row-index'));
      if (isNaN(r) || r < b.minRow || r > b.maxRow) return;
      const rect = cellEl.getBoundingClientRect();
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
      found = true;
    });

    if (!found) { ov.style.display = 'none'; return; }

    const gridRect = gridDiv.getBoundingClientRect();
    // Clamp inside the scrollable body area (below header, within center viewport)
    const headerEl = gridDiv.querySelector('.ag-header');
    const vpEl = gridDiv.querySelector('.ag-body-viewport') || gridDiv.querySelector('.ag-center-cols-viewport');
    const headerBottom = headerEl ? headerEl.getBoundingClientRect().bottom : gridRect.top;
    const vpRect = vpEl ? vpEl.getBoundingClientRect() : gridRect;

    const clLeft = Math.max(left, vpRect.left);
    const clRight = Math.min(right, vpRect.right);
    const clTop = Math.max(top, headerBottom, vpRect.top);
    const clBottom = Math.min(bottom, vpRect.bottom);

    if (clRight <= clLeft || clBottom <= clTop) { ov.style.display = 'none'; return; }

    ov.style.display = 'block';
    ov.style.left = (clLeft - gridRect.left) + 'px';
    ov.style.top = (clTop - gridRect.top) + 'px';
    ov.style.width = (clRight - clLeft) + 'px';
    ov.style.height = (clBottom - clTop) + 'px';
  }

  function clearRangeHighlight() {
    rangeState.active = false;
    rangeState.isDragging = false;
    rangeState.startRowIdx = -1;
    rangeState.startColId = null;
    rangeState.endRowIdx = -1;
    rangeState.endColId = null;
    const ov = document.getElementById('range-overlay');
    if (ov) ov.style.display = 'none';
    updateRangeFooter();
  }

  function updateRangeFooter() {
    const el = document.getElementById('data-selected-count');
    if (!el) return;
    if (rangeState.active) {
      const cells = getCellsInRange();
      el.textContent = 'Vùng chọn: ' + cells.length + ' ô  ·  Ctrl+C sao chép · Ctrl+V dán · Delete xoá';
    } else {
      const selected = gridApi ? gridApi.getSelectedRows() : [];
      el.textContent = selected.length > 0 ? 'Da chon ' + selected.length + ' hang' : '';
    }
  }

  let _autoScrollTimer = null;
  let _lastMouseX = 0, _lastMouseY = 0;

  function getCellInfoFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return getCellInfoFromEl(el);
  }

  function getBodyViewport() {
    const gridDiv = document.getElementById('data-grid');
    if (!gridDiv) return null;
    return gridDiv.querySelector('.ag-body-viewport') || gridDiv.querySelector('.ag-center-cols-viewport');
  }

  // Tìm chỉ số hàng theo toạ độ Y (không cần con trỏ trúng ô) — chọn hàng render gần nhất.
  function rowIdxFromY(clientY) {
    const gridDiv = document.getElementById('data-grid');
    if (!gridDiv) return null;
    let best = null, bestDist = Infinity;
    gridDiv.querySelectorAll('.ag-row').forEach((rowEl) => {
      const r = parseInt(rowEl.getAttribute('row-index'));
      if (isNaN(r)) return;
      const rect = rowEl.getBoundingClientRect();
      if (rect.height <= 0) return;
      let d = 0;
      if (clientY < rect.top) d = rect.top - clientY;
      else if (clientY > rect.bottom) d = clientY - rect.bottom;
      if (d < bestDist) { bestDist = d; best = r; }
    });
    return best;
  }

  // Cập nhật điểm cuối vùng chọn từ toạ độ (hàng bám theo Y, cột theo ô dưới con trỏ)
  function updateRangeEnd(clientX, clientY) {
    const info = getCellInfoFromPoint(clientX, clientY);
    const colId = (info && info.colId) || rangeState.endColId;
    let rowIdx = rowIdxFromY(clientY);
    if (rowIdx == null) rowIdx = rangeState.endRowIdx;
    if (rowIdx === rangeState.endRowIdx && colId === rangeState.endColId) return;
    rangeState.endRowIdx = rowIdx;
    rangeState.endColId = colId;
    const isMulti = rangeState.endRowIdx !== rangeState.startRowIdx || rangeState.endColId !== rangeState.startColId;
    if (isMulti) rangeState.active = true;
    highlightRange();
    updateRangeFooter();
  }

  function startAutoScroll() {
    if (_autoScrollTimer) return;
    _autoScrollTimer = setInterval(() => {
      if (!rangeState.isDragging) return;
      const vp = getBodyViewport();
      if (!vp) return;
      const rect = vp.getBoundingClientRect();
      const EDGE = 36;
      let dy = 0;
      if (_lastMouseY < rect.top + EDGE) dy = -Math.max(14, (rect.top + EDGE - _lastMouseY));
      else if (_lastMouseY > rect.bottom - EDGE) dy = Math.max(14, (_lastMouseY - (rect.bottom - EDGE)));
      if (dy !== 0) {
        vp.scrollTop += dy;
        const cy = Math.max(rect.top + 2, Math.min(rect.bottom - 2, _lastMouseY));
        updateRangeEnd(_lastMouseX, cy);
      }
    }, 60);
  }

  function stopAutoScroll() {
    if (_autoScrollTimer) { clearInterval(_autoScrollTimer); _autoScrollTimer = null; }
  }

  function onRangeMouseDown(e) {
    if (e.button !== 0) return;
    // Don't intercept buttons/inputs/editors inside cells
    const tag = e.target.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target.closest && e.target.closest('.ag-cell-inline-editing')) return;
    // Ignore clicks on checkbox / row-drag columns (let AG Grid handle them)
    if (e.target.closest && e.target.closest('.ag-cell[col-id="checkbox"], .ag-cell[col-id="drag"]')) return;

    const info = getCellInfoFromEl(e.target);
    if (!info) {
      clearRangeHighlight();
      return;
    }
    clearRangeHighlight();
    rangeState.isDragging = true;
    rangeState.startRowIdx = info.rowIdx;
    rangeState.startColId = info.colId;
    rangeState.endRowIdx = info.rowIdx;
    rangeState.endColId = info.colId;
    rangeState.active = false;
    _lastMouseX = e.clientX; _lastMouseY = e.clientY;

    const gridDiv = document.getElementById('data-grid');
    if (gridDiv) gridDiv.classList.add('range-dragging');
    startAutoScroll();
  }

  function onRangeMouseMove(e) {
    if (!rangeState.isDragging) return;
    e.preventDefault();
    // Kill any native text selection started by the drag
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) sel.removeAllRanges();
    _lastMouseX = e.clientX; _lastMouseY = e.clientY;
    updateRangeEnd(e.clientX, e.clientY);
  }

  // Clicking or dragging selects cells only. Checkboxes own whole-row selection.
  function onRangeMouseUp() {
    stopAutoScroll();
    if (!rangeState.isDragging) return;
    rangeState.isDragging = false;
    const gridDiv = document.getElementById('data-grid');
    if (gridDiv) gridDiv.classList.remove('range-dragging');
    // A click is a one-cell range. Row selection is reserved for the checkbox column.
    rangeState.active = true;
    highlightRange();
    updateRangeFooter();
  }

  async function clearRangeCells() {
    const cells = getCellsInRange();
    if (cells.length === 0) return;

    const undoCells = [];
    const updates = new Map();
    const customUpdates = [];

    for (const { rowIdx, colId } of cells) {
      const node = gridApi.getDisplayedRowAtIndex(rowIdx);
      if (!node || !node.data || !node.data.id) continue;
      const oldValue = node.data[colId] || '';
      undoCells.push({ rowId: node.data.id, field: colId, oldValue });
      node.setDataValue(colId, '');

      if (colId.startsWith('custom_')) {
        const columnId = parseInt(colId.replace('custom_', ''));
        customUpdates.push({ post_id: node.data.id, column_id: columnId, value: '' });
      } else {
        if (!updates.has(node.data.id)) updates.set(node.data.id, { id: node.data.id });
        updates.get(node.data.id)[colId] = '';
      }
    }

    if (undoCells.length > 0) pushUndo({ type: 'clearCells', cells: undoCells });

    try {
      if (updates.size > 0) {
        await apiSilent('/api/data/bulk', { method: 'PUT', body: { updates: Array.from(updates.values()) } });
      }
      for (const cu of customUpdates) {
        await apiSilent('/api/data/custom-data', { method: 'PUT', body: cu });
      }
      showToast('Da xoa ' + undoCells.length + ' o trong vung chon', 'success');
    } catch (err) {
      showToast('Loi xoa: ' + err.message, 'error');
    }
    // keep the range so user can immediately paste/fill again
  }

  // ============================================
  // Copy / Paste on the active range (Excel-style)
  // ============================================
  async function copyRange() {
    const b = getRangeBounds();
    if (!b) return;
    const lines = [];
    for (let r = b.minRow; r <= b.maxRow; r++) {
      const node = gridApi.getDisplayedRowAtIndex(r);
      const cells = [];
      for (let c = b.minCol; c <= b.maxCol; c++) {
        const colId = b.allCols[c];
        const v = node && node.data ? (node.data[colId] == null ? '' : node.data[colId]) : '';
        cells.push(String(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' '));
      }
      lines.push(cells.join('\t'));
    }
    const tsv = lines.join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      const nCells = (b.maxRow - b.minRow + 1) * (b.maxCol - b.minCol + 1);
      showToast('Da copy ' + nCells + ' o', 'success');
    } catch (err) {
      showToast('Trinh duyet chan copy clipboard', 'error');
    }
  }

  async function pasteRange() {
    const b = getRangeBounds();
    if (!b) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      showToast('Trinh duyet chan doc clipboard', 'error');
      return;
    }
    if (text == null || text === '') return;

    const matrix = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map(l => l.split('\t'));
    const single = matrix.length === 1 && matrix[0].length === 1;

    const setCells = [];
    const updates = new Map();
    const customUpdates = [];

    isUndoRedoInProgress = true;
    try {
      for (let r = b.minRow; r <= b.maxRow; r++) {
        const node = gridApi.getDisplayedRowAtIndex(r);
        if (!node || !node.data || !node.data.id) continue;
        for (let c = b.minCol; c <= b.maxCol; c++) {
          const colId = b.allCols[c];
          let val;
          if (single) {
            val = matrix[0][0];
          } else {
            const ri = r - b.minRow;
            const ci = c - b.minCol;
            if (ri >= matrix.length) continue;
            const rowArr = matrix[ri];
            if (ci >= rowArr.length) continue;
            val = rowArr[ci];
          }
          if (val === undefined) continue;
          if (colId === 'image_path') val = sanitizeMediaValue(val);
          const oldValue = node.data[colId] == null ? '' : node.data[colId];
          if (String(oldValue) === String(val)) continue;
          setCells.push({ rowId: node.data.id, field: colId, oldValue, newValue: val });
          node.setDataValue(colId, val);
          if (colId.startsWith('custom_')) {
            customUpdates.push({ post_id: node.data.id, column_id: parseInt(colId.replace('custom_', '')), value: val || '' });
          } else {
            if (!updates.has(node.data.id)) updates.set(node.data.id, { id: node.data.id });
            updates.get(node.data.id)[colId] = val;
          }
        }
      }
    } finally {
      isUndoRedoInProgress = false;
    }

    if (setCells.length === 0) { showToast('Khong co gi de dan', 'info'); return; }
    if (setCells.length > 0) pushUndo({ type: 'setCells', cells: setCells });

    try {
      if (updates.size > 0) {
        await apiSilent('/api/data/bulk', { method: 'PUT', body: { updates: Array.from(updates.values()) } });
      }
      for (const cu of customUpdates) {
        await apiSilent('/api/data/custom-data', { method: 'PUT', body: cu });
      }
      showToast('Da dan ' + setCells.length + ' o', 'success');
    } catch (err) {
      showToast('Loi dan: ' + err.message, 'error');
    }
  }

  // ============================================
  // Password gate (custom data / variable features)
  // ============================================
  function requireCustomAccess(onSuccess) {
    if (customUnlocked) { onSuccess(); return; }
    const bodyHtml = `
      <div class="form-group">
        <label class="form-label">Nhập mật khẩu để dùng tính năng biến dữ liệu / cột tùy chỉnh</label>
        <input type="password" class="form-input" id="custom-pass" placeholder="Mật khẩu" autofocus>
      </div>`;
    const footerHtml = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="DataManager._verifyCustomPassword()">🔓 Mở khóa</button>`;
    showModal('Xác thực', bodyHtml, footerHtml);
    window._customAccessCb = onSuccess;
    setTimeout(() => {
      const i = document.getElementById('custom-pass');
      if (i) {
        i.focus();
        i.addEventListener('keydown', (e) => { if (e.key === 'Enter') _verifyCustomPassword(); });
      }
    }, 200);
  }

  function _verifyCustomPassword() {
    const el = document.getElementById('custom-pass');
    const val = el ? el.value : '';
    if (val === CUSTOM_PASSWORD) {
      customUnlocked = true;
      closeModal();
      showToast('Da mo khoa tinh nang', 'success');
      const cb = window._customAccessCb;
      window._customAccessCb = null;
      if (typeof cb === 'function') cb();
    } else {
      showToast('Mat khau khong dung', 'error');
    }
  }

  // ============================================
  // File Browse (native dialog → full path)
  // ============================================
  async function browseFile(params) {
    const field = params.colDef.field;
    const id = params.data.id;
    try {
      const result = await apiSilent('/api/data/pick-file', { method: 'POST' });
      if (result.success && result.data && result.data.paths && result.data.paths.length > 0) {
        const fullPath = result.data.paths[0];
        const rowNode = gridApi.getRowNode(String(id));
        if (rowNode) rowNode.setDataValue(field, fullPath);
        return;
      }
      // Cancelled or no selection
      if (result.success) return;
      throw new Error('no-native');
    } catch (err) {
      // Fallback for web mode: plain file input (filename only)
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx';
      input.style.display = 'none';
      input.addEventListener('change', () => {
        if (!input.files || input.files.length === 0) return;
        const fileName = input.files[0].name;
        const rowNode = gridApi.getRowNode(String(id));
        if (rowNode) rowNode.setDataValue(field, fileName);
        input.remove();
      });
      document.body.appendChild(input);
      input.click();
    }
  }

  // ============================================
  // Per-column cross-platform synchronization
  // ============================================

  async function loadSyncRules() {
    try {
      const result = await apiSilent('/api/data/sync/rules');
      syncRules = result.success && Array.isArray(result.data) ? result.data : [];
    } catch (_) {
      syncRules = [];
    }
  }

  function queueAutomaticSync(postId, varKey) {
    if (!varKey || !hasEnabledSyncRule(varKey)) return;
    const sourcePlatform = App.currentPlatform;
    const queueKey = `${sourcePlatform}:${varKey}`;
    let pending = pendingAutoSync.get(queueKey);
    if (!pending) pending = { ids: new Set(), timer: null, sourcePlatform, varKey };
    pending.ids.add(Number(postId));
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(async () => {
      pendingAutoSync.delete(queueKey);
      try {
        await apiSilent('/api/data/sync/auto', {
          method: 'POST',
          body: {
            source_platform: pending.sourcePlatform,
            source_var_key: pending.varKey,
            source_post_ids: Array.from(pending.ids),
          },
        });
      } catch (err) {
        showToast('Đồng bộ tự động lỗi: ' + err.message, 'error', 5000);
      }
    }, 450);
    pendingAutoSync.set(queueKey, pending);
  }

  function platformInfo(platform) {
    return PLATFORM_META[platform] || { label: platform, icon: '' };
  }

  function syncTargetStatus(status) {
    const map = {
      matched: ['Sẵn sàng', 'ready'],
      will_create_column: ['Sẽ tạo cột', 'create'],
      missing_column: ['Thiếu cột', 'blocked'],
      type_mismatch: ['Khác kiểu dữ liệu', 'blocked'],
      unsupported: ['Không hỗ trợ', 'blocked'],
    };
    return map[status] || [status || 'Không xác định', 'blocked'];
  }

  async function showColumnSyncModal(varKey, label, colType) {
    if (!varKey || SYNC_BLOCKED_VARS.has(varKey)) return;
    syncModalState = { varKey, label, colType, tab: 'manual', targets: [], lastPayload: null };
    showModal('Đồng bộ cột', `
      <div class="sync-loading">
        <span class="sync-loader"></span>
        <div><strong>Đang kiểm tra cột tương ứng</strong><small>Hệ thống ghép cột theo biến {{${escapeHtml(varKey)}}}</small></div>
      </div>
    `, '<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>');
    document.getElementById('modal').classList.add('modal-wide');
    try {
      const result = await apiSilent(`/api/data/sync/targets?source_var_key=${encodeURIComponent(varKey)}&create_missing=1`);
      if (!syncModalState || syncModalState.varKey !== varKey) return;
      syncModalState.targets = result.data.targets || [];
      renderSyncModal();
    } catch (err) {
      showToast('Không kiểm tra được cột đích: ' + err.message, 'error');
      closeModal();
    }
  }

  function renderSyncModal() {
    if (!syncModalState) return;
    const state = syncModalState;
    const existingRules = syncRules.filter(rule => rule.source_var_key === state.varKey);
    const existingTargets = new Set(existingRules.map(rule => rule.target_platform));
    const firstRule = existingRules[0];
    const selectedRows = gridApi ? gridApi.getSelectedRows().length : 0;
    let filteredRows = 0;
    if (gridApi) gridApi.forEachNodeAfterFilterAndSort(() => filteredRows++);

    const targetCards = state.targets.map(target => {
      const info = platformInfo(target.platform);
      const [statusLabel, statusClass] = syncTargetStatus(target.status);
      const disabled = ['unsupported', 'type_mismatch'].includes(target.status);
      const checked = existingTargets.has(target.platform);
      return `
        <label class="sync-platform-card ${disabled ? 'is-disabled' : ''}">
          <input class="sync-target-check" type="checkbox" value="${target.platform}"
            ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
          <span class="sync-platform-icon"><img src="${info.icon}" alt=""></span>
          <span class="sync-platform-copy"><strong>${info.label}</strong><small>${escapeHtml(state.label)} → ${escapeHtml(target.column ? target.column.name : state.label)}</small></span>
          <span class="sync-match-status ${statusClass}">${statusLabel}</span>
        </label>`;
    }).join('');

    const commonOptions = `
      <div class="sync-options-grid">
        <label class="sync-option-field">
          <span>Xử lý dữ liệu đã có</span>
          <select id="sync-conflict-policy" class="form-select">
            <option value="fill_empty" ${!firstRule || firstRule.conflict_policy === 'fill_empty' ? 'selected' : ''}>Chỉ điền ô trống</option>
            <option value="overwrite" ${firstRule && firstRule.conflict_policy === 'overwrite' ? 'selected' : ''}>Ghi đè dữ liệu hiện có</option>
          </select>
        </label>
        <label class="sync-check-option">
          <input id="sync-create-missing" type="checkbox" ${!firstRule || firstRule.create_missing ? 'checked' : ''}>
          <span><strong>Tạo dữ liệu còn thiếu</strong><small>Tự tạo cột và dòng đích khi cần</small></span>
        </label>
      </div>`;

    const manualPanel = `
      <div class="sync-options-grid">
        <label class="sync-option-field">
          <span>Phạm vi đồng bộ</span>
          <select id="sync-scope" class="form-select">
            <option value="selected" ${selectedRows ? 'selected' : ''} ${selectedRows ? '' : 'disabled'}>Dòng đã chọn (${selectedRows})</option>
            <option value="filtered" ${selectedRows ? '' : 'selected'}>Dòng đang hiển thị (${filteredRows})</option>
            <option value="all">Toàn bộ bảng</option>
          </select>
        </label>
        <div class="sync-safety-note"><strong>Xem trước trước khi ghi</strong><small>Không thay đổi dữ liệu cho tới khi bạn xác nhận.</small></div>
      </div>
      ${commonOptions}
      <div id="sync-preview" class="sync-preview-empty">Chọn nền tảng đích rồi bấm “Xem trước”.</div>`;

    const autoPanel = `
      <div class="sync-auto-banner">
        <span class="sync-auto-dot"></span>
        <div><strong>Đồng bộ sau khi lưu ô</strong><small>Thay đổi được gom trong 450ms, chạy một chiều và không tạo vòng lặp.</small></div>
        <label class="toggle"><input id="sync-auto-enabled" type="checkbox" ${!firstRule || firstRule.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
      ${commonOptions}
      <div class="sync-safety-note full"><strong>Quy tắc an toàn</strong><small>Xóa dữ liệu nguồn không tự xóa dữ liệu đích. Các cột kết quả đăng bài không được đồng bộ tự động.</small></div>`;

    const bodyHtml = `
      <div class="sync-direction-card">
        <span class="sync-source-platform"><img src="${platformInfo(App.currentPlatform).icon}" alt=""></span>
        <div><small>Nguồn · ${platformInfo(App.currentPlatform).label}</small><strong>${escapeHtml(state.label)}</strong><code>{{${escapeHtml(state.varKey)}}}</code></div>
        <span class="sync-direction-arrow">→</span>
        <div class="sync-direction-target"><small>Đích</small><strong>Chọn nền tảng bên dưới</strong></div>
      </div>
      <div class="sync-tabs">
        <button class="sync-tab ${state.tab === 'manual' ? 'active' : ''}" onclick="DataManager._switchSyncTab('manual')">Thủ công</button>
        <button class="sync-tab ${state.tab === 'auto' ? 'active' : ''}" onclick="DataManager._switchSyncTab('auto')">Tự động</button>
      </div>
      <div class="sync-section-title"><span>Nền tảng đích</span><small>Ghép chính xác bằng var_key và kiểu dữ liệu</small></div>
      <div class="sync-platform-grid">${targetCards}</div>
      ${state.tab === 'manual' ? manualPanel : autoPanel}`;

    const footerHtml = state.tab === 'manual'
      ? `<button class="btn btn-secondary" onclick="closeModal()">Hủy</button><button class="btn btn-primary" onclick="DataManager._previewColumnSync()">Xem trước đồng bộ</button>`
      : `<button class="btn btn-secondary" onclick="closeModal()">Hủy</button><button class="btn btn-primary" onclick="DataManager._saveAutoSyncRules()">Lưu tự động</button>`;
    showModal('Đồng bộ cột', bodyHtml, footerHtml);
    document.getElementById('modal').classList.add('modal-wide');
  }

  function _switchSyncTab(tab) {
    if (!syncModalState || !['manual', 'auto'].includes(tab)) return;
    syncModalState.tab = tab;
    renderSyncModal();
  }

  function checkedSyncTargets() {
    return Array.from(document.querySelectorAll('.sync-target-check:checked')).map(input => input.value);
  }

  function sourceIdsForScope(scope) {
    if (!gridApi || scope === 'all') return [];
    if (scope === 'selected') return gridApi.getSelectedRows().map(row => row.id);
    const ids = [];
    gridApi.forEachNodeAfterFilterAndSort(node => { if (node.data && node.data.id) ids.push(node.data.id); });
    return ids;
  }

  async function _previewColumnSync() {
    if (!syncModalState) return;
    const targets = checkedSyncTargets();
    if (!targets.length) { showToast('Hãy chọn ít nhất một nền tảng đích', 'warning'); return; }
    const scope = document.getElementById('sync-scope').value;
    const payload = {
      source_platform: App.currentPlatform,
      source_var_key: syncModalState.varKey,
      source_post_ids: sourceIdsForScope(scope),
      target_platforms: targets,
      conflict_policy: document.getElementById('sync-conflict-policy').value,
      create_missing: document.getElementById('sync-create-missing').checked,
    };
    syncModalState.lastPayload = payload;
    const previewEl = document.getElementById('sync-preview');
    previewEl.className = 'sync-preview-empty';
    previewEl.innerHTML = '<span class="sync-loader"></span> Đang phân tích dữ liệu…';
    try {
      const result = await apiSilent('/api/data/sync/preview', { method: 'POST', body: payload });
      const preview = result.data;
      const rows = preview.targets.map(target => {
        const info = platformInfo(target.platform);
        const [, statusClass] = syncTargetStatus(target.status);
        return `<div class="sync-preview-row">
          <span class="sync-platform-icon small"><img src="${info.icon}" alt=""></span>
          <strong>${info.label}</strong>
          <span class="sync-preview-count success">${target.will_update + target.will_create} thay đổi</span>
          <span class="sync-preview-count">${target.will_skip} bỏ qua</span>
          ${target.conflicts ? `<span class="sync-preview-count warning">${target.conflicts} đã có dữ liệu</span>` : ''}
          ${statusClass === 'blocked' ? `<span class="sync-preview-count warning">Không tương thích</span>` : ''}
        </div>`;
      }).join('');
      previewEl.className = 'sync-preview-result';
      previewEl.innerHTML = `<div class="sync-preview-summary"><strong>${preview.total_changes} ô sẽ thay đổi</strong><span>${preview.total_skipped} ô được giữ nguyên</span></div>${rows}`;
      document.getElementById('modal-footer').innerHTML = `
        <button class="btn btn-secondary" onclick="DataManager._switchSyncTab('manual')">Quay lại</button>
        <button class="btn btn-primary" ${preview.total_changes ? '' : 'disabled'} onclick="DataManager._executeColumnSync()">Đồng bộ ngay</button>`;
    } catch (err) {
      previewEl.className = 'sync-preview-empty error';
      previewEl.textContent = err.message;
    }
  }

  async function _executeColumnSync() {
    if (!syncModalState || !syncModalState.lastPayload) return;
    const previewEl = document.getElementById('sync-preview');
    previewEl.className = 'sync-preview-empty';
    previewEl.innerHTML = '<span class="sync-loader"></span> Đang đồng bộ an toàn…';
    try {
      const result = await apiSilent('/api/data/sync/execute', {
        method: 'POST', body: syncModalState.lastPayload,
      });
      const summary = result.data;
      previewEl.className = 'sync-complete';
      previewEl.innerHTML = `
        <span class="sync-complete-icon">✓</span>
        <div><strong>Đồng bộ hoàn tất</strong><small>${summary.changed} ô đã cập nhật · ${summary.created} dòng mới · ${summary.skipped} ô giữ nguyên</small></div>`;
      document.getElementById('modal-footer').innerHTML = `
        <button class="btn btn-secondary" onclick="DataManager._undoSyncRun(${summary.run_id})">Hoàn tác</button>
        <button class="btn btn-primary" onclick="closeModal()">Xong</button>`;
      showToast(`Đã đồng bộ ${summary.changed} ô`, 'success');
    } catch (err) {
      previewEl.className = 'sync-preview-empty error';
      previewEl.textContent = err.message;
    }
  }

  async function _saveAutoSyncRules() {
    if (!syncModalState) return;
    const targets = checkedSyncTargets();
    try {
      const result = await apiSilent('/api/data/sync/rules', {
        method: 'PUT',
        body: {
          source_var_key: syncModalState.varKey,
          target_platforms: targets,
          conflict_policy: document.getElementById('sync-conflict-policy').value,
          create_missing: document.getElementById('sync-create-missing').checked,
          enabled: document.getElementById('sync-auto-enabled').checked,
        },
      });
      syncRules = syncRules.filter(rule => rule.source_var_key !== syncModalState.varKey).concat(result.data || []);
      if (gridApi) gridApi.refreshHeader();
      closeModal();
      showToast(targets.length ? 'Đã lưu đồng bộ tự động' : 'Đã tắt đồng bộ tự động cho cột', 'success');
    } catch (err) {
      showToast('Không lưu được quy tắc: ' + err.message, 'error');
    }
  }

  async function _undoSyncRun(runId) {
    try {
      const result = await apiSilent(`/api/data/sync/runs/${runId}/undo`, { method: 'POST' });
      closeModal();
      showToast(`Đã hoàn tác ${result.data.restored + result.data.removed} thay đổi`, 'success');
    } catch (err) {
      showToast('Không thể hoàn tác: ' + err.message, 'error');
    }
  }

  // ============================================
  // Public Methods
  // ============================================

  // Tạo các cột hệ thống bắt buộc nếu chưa có
  async function ensureRequiredColumns() {
    const need = [
      { var_key: 'name_profile', name: 'name_profile', col_type: 'text' },
      { var_key: 'link_post', name: 'link_post', col_type: 'text' },
      { var_key: 'time_post', name: 'time_post', col_type: 'text' },
      { var_key: 'comment', name: 'comment', col_type: 'text' },
      { var_key: 'comment_media', name: 'comment_media', col_type: 'file' },
      { var_key: 'time_comment', name: 'time_comment', col_type: 'text' },
      { var_key: 'comment_status', name: 'comment_status', col_type: 'text' },
    ];
    if (App.currentPlatform === 'facebook') {
      need.splice(1, 0, { var_key: 'link_fanpage', name: 'Link Fanpage', col_type: 'text' });
    }
    let created = false;
    for (const n of need) {
      const existing = customColByVar(n.var_key);
      if (!existing) {
        try {
          await apiSilent('/api/data/columns', { method: 'POST', body: { name: n.name, col_type: n.col_type, var_key: n.var_key } });
          created = true;
        } catch (e) {}
      } else if (existing.col_type !== n.col_type) {
        try {
          const r = await apiSilent(`/api/data/columns/${existing.id}`, {
            method: 'PUT', body: { col_type: n.col_type },
          });
          if (r.success && r.data) Object.assign(existing, r.data);
        } catch (e) {}
      }
    }
    if (created) {
      try {
        const r = await apiSilent('/api/data/columns');
        if (r.success) customColumns = r.data;
      } catch (e) {}
    }
  }

  async function load() {
    // Clear any active range so stale highlights don't stick to reloaded rows
    if (gridInitialized) clearRangeHighlight();
    // Load field overrides (tên/biến cột mặc định) + custom columns first
    await loadFieldOverrides();
    await loadSyncRules();
    try {
      const colResult = await apiSilent('/api/data/columns');
      if (colResult.success) customColumns = colResult.data;
    } catch (e) { customColumns = []; }

    // Đảm bảo các cột hệ thống đăng bài và bình luận tồn tại
    await ensureRequiredColumns();

    if (!gridInitialized) {
      initGrid();
    } else {
      gridApi.setGridOption('columnDefs', buildColumnDefs());
    }

    try {
      const result = await apiSilent('/api/data');
      if (result.success && gridApi) {
        gridApi.setGridOption('rowData', result.data);
        updateFooter();
      }
    } catch (err) {
      showToast('Loi tai du lieu: ' + err.message, 'error');
    }
  }

  async function addRow() {
    try {
      const result = await apiSilent('/api/data', {
        method: 'POST',
        body: { content: '', status: 'pending' },
      });
      if (result.success && gridApi) {
        for (const col of customColumns) {
          result.data[`custom_${col.id}`] = '';
        }
        gridApi.applyTransaction({ add: [result.data] });
        pushUndo({ type: 'addRow', rowId: result.data.id });
        updateFooter();
        setTimeout(() => {
          const rowNode = gridApi.getRowNode(String(result.data.id));
          if (rowNode) {
            gridApi.ensureIndexVisible(rowNode.rowIndex);
          }
        }, 100);
      }
    } catch (err) {
      showToast('Loi them hang: ' + err.message, 'error');
    }
  }

  async function deleteSelected() {
    if (!gridApi) return;
    const selectedRows = gridApi.getSelectedRows();
    if (selectedRows.length === 0) {
      showToast('Chưa chọn hàng nào để xóa', 'warning');
      return;
    }
    const confirmed = await showConfirm(
      'Xác nhận xóa',
      `Bạn có chắc muốn xóa ${selectedRows.length} hàng đã chọn?`
    );
    if (!confirmed) return;

    const ids = selectedRows.map(row => row.id);
    const rowSnapshots = selectedRows.map(row => ({ ...row }));
    try {
      const result = await apiSilent('/api/data/bulk', { method: 'DELETE', body: { ids } });
      if (result.success && gridApi) {
        gridApi.applyTransaction({ remove: selectedRows });
        pushUndo({ type: 'deleteRows', rows: rowSnapshots });
        updateFooter();
        showToast('Da xoa ' + result.data.deleted + ' hang', 'success');
      }
    } catch (err) {
      showToast('Loi xoa: ' + err.message, 'error');
    }
  }

  // ============================================
  // Add Custom Column
  // ============================================
  function showAddColumnModal() {
    if (!customUnlocked) { requireCustomAccess(showAddColumnModal); return; }
    const bodyHtml = `
      <div class="form-group">
        <label class="form-label">Tên cột</label>
        <input type="text" class="form-input" id="col-name" placeholder="Ví dụ: Hashtag, Ghi chú 2..." autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">Loại cột</label>
        <select class="form-select" id="col-type">
          <option value="text">📝 Văn bản (Text)</option>
          <option value="file">📁 Đường dẫn file (File Path)</option>
          <option value="number">🔢 Số (Number)</option>
          <option value="select">📋 Chọn (Select)</option>
        </select>
      </div>
      <div style="margin-top:4px;padding:10px 14px;background:var(--bg-input);border-radius:var(--radius-sm);font-size:12px;color:var(--text-muted);">
        <div style="margin-bottom:4px;font-weight:600;color:var(--text-secondary);">Loại cột:</div>
        <div>📝 <b>Văn bản</b> — Nhập text tự do, tự xuống dòng</div>
        <div>📁 <b>File Path</b> — Đường dẫn file, có nút chọn file</div>
        <div>🔢 <b>Số</b> — Chỉ nhập số</div>
        <div>📋 <b>Select</b> — Chọn từ danh sách</div>
      </div>
    `;
    const footerHtml = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="DataManager._confirmAddColumn()">➕ Thêm cột</button>
    `;
    showModal('Thêm cột mới', bodyHtml, footerHtml);
    // Focus input after modal opens
    setTimeout(() => {
      const input = document.getElementById('col-name');
      if (input) input.focus();
    }, 200);
  }

  async function _confirmAddColumn() {
    const name = document.getElementById('col-name').value.trim();
    const colType = document.getElementById('col-type').value;
    if (!name) {
      showToast('Vui lòng nhập tên cột', 'warning');
      return;
    }
    closeModal();
    try {
      const result = await apiSilent('/api/data/columns', {
        method: 'POST',
        body: { name, col_type: colType },
      });
      if (result.success) {
        customColumns.push(result.data);
        gridApi.setGridOption('columnDefs', buildColumnDefs());
        gridApi.forEachNode(node => {
          if (node.data) node.data[`custom_${result.data.id}`] = '';
        });
        gridApi.refreshCells({ force: true });
        showToast('Da them cot "' + name + '"', 'success');
      }
    } catch (err) {
      showToast('Loi them cot: ' + err.message, 'error');
    }
  }

  // ============================================
  // Manage Custom Columns (rename / change type / delete)
  // ============================================
  function typeOptions(selected) {
    const types = [
      { v: 'text', label: '📝 Văn bản' },
      { v: 'file', label: '📁 File' },
      { v: 'number', label: '🔢 Số' },
      { v: 'select', label: '📋 Select' },
    ];
    return types.map(t => `<option value="${t.v}" ${t.v === selected ? 'selected' : ''}>${t.label}</option>`).join('');
  }

  function showManageColumnsModal() {
    if (!customUnlocked) { requireCustomAccess(showManageColumnsModal); return; }
    if (customColumns.length === 0) {
      showToast('Chưa có cột tùy chỉnh nào. Bấm "Thêm cột" để tạo.', 'info');
      return;
    }

    const listHtml = customColumns.map(col => `
      <div class="col-edit-row">
        <input type="text" class="form-input col-edit-name" id="colname-${col.id}" value="${escapeHtml(col.name)}" placeholder="Tên cột">
        <select class="form-select col-edit-type" id="coltype-${col.id}">${typeOptions(col.col_type)}</select>
        <button class="btn btn-primary btn-sm" onclick="DataManager._renameColumn(${col.id})">💾 Lưu</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--error);" onclick="DataManager._deleteColumn(${col.id}, '${escapeHtml(col.name)}')">🗑</button>
      </div>
    `).join('');

    const bodyHtml = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Sửa tên cột / đổi loại rồi bấm 💾 Lưu. Tên cột cũng là tên biến dữ liệu.</div>
      <div class="col-edit-list">${listHtml}</div>
    `;
    showModal('Quản lý cột tùy chỉnh', bodyHtml,
      `<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>`
    );
  }

  async function _renameColumn(colId) {
    // Name field may come from the manage modal (colname-) or the variable modal (varname-)
    const nameEl = document.getElementById('colname-' + colId) || document.getElementById('varname-' + colId);
    const typeEl = document.getElementById('coltype-' + colId);
    const name = nameEl ? nameEl.value.trim() : '';
    const col_type = typeEl ? typeEl.value : undefined;
    if (!name) { showToast('Tên cột không được để trống', 'warning'); return; }
    const fromVarModal = !!document.getElementById('varname-' + colId);
    const fromManageModal = !!document.getElementById('colname-' + colId);
    try {
      await apiSilent(`/api/data/columns/${colId}`, { method: 'PUT', body: { name, col_type } });
      const col = customColumns.find(c => c.id === colId);
      if (col) { col.name = name; if (col_type) col.col_type = col_type; }
      gridApi.setGridOption('columnDefs', buildColumnDefs());
      gridApi.refreshCells({ force: true });
      showToast('Đã cập nhật cột "' + name + '" → biến {{' + slugVar(name) + '}}', 'success');
      // Refresh the open modal so the variable token updates
      if (fromVarModal) showVariableMappingModal();
      else if (fromManageModal) showManageColumnsModal();
    } catch (err) {
      showToast('Lỗi cập nhật cột: ' + err.message, 'error');
    }
  }

  async function _deleteColumn(colId, colName) {
    const confirmed = await showConfirm('Xoa cot', `Xoa cot "${colName}"? Tat ca du lieu trong cot se bi mat.`);
    if (!confirmed) return;
    try {
      const result = await apiSilent(`/api/data/columns/${colId}`, { method: 'DELETE' });
      const snapshot = result.data;
      customColumns = customColumns.filter(c => c.id !== colId);
      gridApi.setGridOption('columnDefs', buildColumnDefs());
      if (snapshot) pushUndo({ type: 'deleteColumn', snapshot });
      showToast('Da xoa cot "' + colName + '"', 'success');
      // Reopen the manager if there are still columns, else close
      if (customColumns.length > 0) showManageColumnsModal();
      else closeModal();
    } catch (err) {
      showToast('Loi xoa cot: ' + err.message, 'error');
    }
  }

  // ============================================
  // Undo / Redo
  // ============================================
  function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }

  async function undo() {
    if (undoStack.length === 0) {
      showToast('Khong co thao tac de hoan tac', 'info');
      return;
    }
    const action = undoStack.pop();
    isUndoRedoInProgress = true;
    try {
      await applyUndoAction(action);
      redoStack.push(action);
      showToast('Da hoan tac', 'success');
    } catch (err) {
      undoStack.push(action);
      showToast('Loi hoan tac: ' + err.message, 'error');
    } finally {
      isUndoRedoInProgress = false;
    }
  }

  async function redo() {
    if (redoStack.length === 0) {
      showToast('Khong co thao tac de tien toi', 'info');
      return;
    }
    const action = redoStack.pop();
    isUndoRedoInProgress = true;
    try {
      await applyRedoAction(action);
      undoStack.push(action);
      showToast('Da tien toi', 'success');
    } catch (err) {
      redoStack.push(action);
      showToast('Loi tien toi: ' + err.message, 'error');
    } finally {
      isUndoRedoInProgress = false;
    }
  }

  async function applyUndoAction(action) {
    switch (action.type) {
      case 'cellEdit': {
        const node = gridApi.getRowNode(String(action.rowId));
        if (node) {
          node.setDataValue(action.field, action.oldValue);
          if (action.field.startsWith('custom_')) {
            const colId = parseInt(action.field.replace('custom_', ''));
            await apiSilent('/api/data/custom-data', { method: 'PUT', body: { post_id: action.rowId, column_id: colId, value: action.oldValue || '' } });
          } else {
            await apiSilent(`/api/data/${action.rowId}`, { method: 'PUT', body: { [action.field]: action.oldValue } });
          }
        }
        break;
      }
      case 'addRow': {
        await apiSilent('/api/data/bulk', { method: 'DELETE', body: { ids: [action.rowId] } });
        const node = gridApi.getRowNode(String(action.rowId));
        if (node) gridApi.applyTransaction({ remove: [node.data] });
        updateFooter();
        break;
      }
      case 'deleteRows': {
        await apiSilent('/api/data/restore', { method: 'POST', body: { rows: action.rows } });
        gridApi.applyTransaction({ add: action.rows });
        updateFooter();
        break;
      }
      case 'clearCells':
      case 'setCells': {
        for (const cell of action.cells) {
          const node = gridApi.getRowNode(String(cell.rowId));
          if (node) node.setDataValue(cell.field, cell.oldValue);
          if (cell.field.startsWith('custom_')) {
            const colId = parseInt(cell.field.replace('custom_', ''));
            await apiSilent('/api/data/custom-data', { method: 'PUT', body: { post_id: cell.rowId, column_id: colId, value: cell.oldValue || '' } });
          } else {
            await apiSilent(`/api/data/${cell.rowId}`, { method: 'PUT', body: { [cell.field]: cell.oldValue } });
          }
        }
        break;
      }
      case 'deleteColumn': {
        await apiSilent('/api/data/columns/restore', { method: 'POST', body: { snapshot: action.snapshot } });
        customColumns.push(action.snapshot.column);
        gridApi.setGridOption('columnDefs', buildColumnDefs());
        await load();
        break;
      }
    }
  }

  async function applyRedoAction(action) {
    switch (action.type) {
      case 'cellEdit': {
        const node = gridApi.getRowNode(String(action.rowId));
        if (node) {
          node.setDataValue(action.field, action.newValue);
          if (action.field.startsWith('custom_')) {
            const colId = parseInt(action.field.replace('custom_', ''));
            await apiSilent('/api/data/custom-data', { method: 'PUT', body: { post_id: action.rowId, column_id: colId, value: action.newValue || '' } });
          } else {
            await apiSilent(`/api/data/${action.rowId}`, { method: 'PUT', body: { [action.field]: action.newValue } });
          }
        }
        break;
      }
      case 'addRow': {
        const result = await apiSilent('/api/data', { method: 'POST', body: { content: '', status: 'pending' } });
        if (result.success) {
          action.rowId = result.data.id;
          gridApi.applyTransaction({ add: [result.data] });
          updateFooter();
        }
        break;
      }
      case 'deleteRows': {
        const ids = action.rows.map(r => r.id);
        await apiSilent('/api/data/bulk', { method: 'DELETE', body: { ids } });
        const removeData = [];
        for (const id of ids) {
          const node = gridApi.getRowNode(String(id));
          if (node) removeData.push(node.data);
        }
        if (removeData.length) gridApi.applyTransaction({ remove: removeData });
        updateFooter();
        break;
      }
      case 'clearCells':
      case 'setCells': {
        for (const cell of action.cells) {
          const newVal = action.type === 'setCells' ? cell.newValue : '';
          const node = gridApi.getRowNode(String(cell.rowId));
          if (node) node.setDataValue(cell.field, newVal);
          if (cell.field.startsWith('custom_')) {
            const colId = parseInt(cell.field.replace('custom_', ''));
            await apiSilent('/api/data/custom-data', { method: 'PUT', body: { post_id: cell.rowId, column_id: colId, value: newVal || '' } });
          } else {
            await apiSilent(`/api/data/${cell.rowId}`, { method: 'PUT', body: { [cell.field]: newVal } });
          }
        }
        break;
      }
      case 'deleteColumn': {
        await apiSilent(`/api/data/columns/${action.snapshot.column.id}`, { method: 'DELETE' });
        customColumns = customColumns.filter(c => c.id !== action.snapshot.column.id);
        gridApi.setGridOption('columnDefs', buildColumnDefs());
        break;
      }
    }
  }

  // ============================================
  // Save Data (manual save all)
  // ============================================
  async function saveData() {
    if (!gridApi) return;
    const updates = [];
    const customUpdates = [];
    gridApi.forEachNode(node => {
      if (!node.data || !node.data.id) return;
      updates.push({
        id: node.data.id,
        content: node.data.content || '',
        image_path: sanitizeMediaValue(node.data.image_path),
        link: node.data.link || '',
        target: node.data.target || '',
        product_id: node.data.product_id || '',
        status: node.data.status || 'pending',
        note: node.data.note || '',
      });
      for (const col of customColumns) {
        const field = `custom_${col.id}`;
        const value = node.data[field];
        if (value !== undefined) {
          customUpdates.push({ post_id: node.data.id, column_id: col.id, value: value || '' });
        }
      }
    });
    if (updates.length === 0) {
      showToast('Khong co du lieu de luu', 'info');
      return;
    }
    try {
      await apiSilent('/api/data/bulk', { method: 'PUT', body: { updates } });
      for (const cu of customUpdates) {
        await apiSilent('/api/data/custom-data', { method: 'PUT', body: cu });
      }
      showToast('Da luu tat ca du lieu', 'success');
    } catch (err) {
      showToast('Loi luu du lieu: ' + err.message, 'error');
    }
  }

  // ============================================
  // Delete Column Modal (separate from manage)
  // ============================================
  function showDeleteColumnModal() {
    if (!customUnlocked) { requireCustomAccess(showDeleteColumnModal); return; }
    if (customColumns.length === 0) {
      showToast('Chưa có cột tùy chỉnh nào để xóa', 'info');
      return;
    }
    const typeLabels = { text: 'Van ban', file: 'File', number: 'So', select: 'Select' };
    const listHtml = customColumns.map(col => `
      <div class="schedule-item" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:600;">${escapeHtml(col.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">${typeLabels[col.col_type] || col.col_type}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:var(--error);" onclick="DataManager._deleteColumn(${col.id}, '${escapeHtml(col.name)}')">Xoa</button>
      </div>
    `).join('');
    showModal('Xoa cot tuy chinh', `<div class="schedule-list">${listHtml}</div>`,
      `<button class="btn btn-secondary" onclick="closeModal()">Dong</button>`
    );
  }

  // ============================================
  // Variable Mapping Modal
  // ============================================
  function showVariableMappingModal() {
    if (!customUnlocked) { requireCustomAccess(showVariableMappingModal); return; }

    // Cột mặc định — giờ đổi được cả tên hiển thị lẫn biến
    const fixedRows = BUILTIN_FIELDS
      .filter(f => !f.platform || f.platform === App.currentPlatform)
      .map(f => {
      const label = fieldLabel(f.field, f.label);
      const varKey = fieldVar(f.field);
      const variable = `{{${varKey}}}`;
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border-color);">
            <input type="text" class="form-input" id="fldname-${f.field}" value="${escapeHtml(label)}" style="height:32px;padding:4px 8px;width:100%;min-width:0;">
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border-color);">
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" class="form-input" id="fldkey-${f.field}" value="${escapeHtml(varKey)}" placeholder="${f.field}" style="height:32px;padding:4px 8px;flex:1;min-width:0;font-family:monospace;">
              <button class="btn btn-primary btn-sm" onclick="DataManager._saveBuiltinVar('${f.field}')" title="Lưu">💾</button>
              <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${variable}');showToast('Đã copy ${variable}','success')" title="Copy biến">📋</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Custom columns — name and variable are INDEPENDENT (runner uses the variable)
    const customRows = customColumns.map(col => {
      const key = col.var_key || slugVar(col.name);
      const variable = `{{${key}}}`;
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border-color);">
            <input type="text" class="form-input" id="varname-${col.id}" value="${escapeHtml(col.name)}" style="height:32px;padding:4px 8px;width:100%;min-width:0;">
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border-color);">
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" class="form-input" id="varkey-${col.id}" value="${escapeHtml(key)}" placeholder="ten_bien" style="height:32px;padding:4px 8px;flex:1;min-width:0;font-family:monospace;">
              <button class="btn btn-primary btn-sm" onclick="DataManager._saveCustomVar(${col.id})" title="Lưu">💾</button>
              <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${variable}');showToast('Đã copy ${variable}','success')" title="Copy biến">📋</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    const bodyHtml = `
      <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
        <b style="color:var(--text-secondary);">Tên cột</b> và <b style="color:var(--text-secondary);">Biến</b> có thể khác nhau. Khi chạy, hệ thống dùng <b style="color:var(--accent);">Biến</b> (không dùng tên cột). Sửa xong bấm 💾.
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="background:var(--bg-input);">
            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border-color);width:42%;">Tên cột (hiển thị)</th>
            <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border-color);">Biến (khi chạy)</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="2" style="padding:8px 12px;font-size:12px;color:var(--accent);font-weight:600;background:var(--bg-input);">Cột mặc định — đổi tên hiển thị & biến tự do</td></tr>
          ${fixedRows}
          ${customColumns.length > 0 ? `<tr><td colspan="2" style="padding:8px 12px;font-size:12px;color:var(--accent);font-weight:600;background:var(--bg-input);">Cột tùy chỉnh — tên & biến sửa riêng</td></tr>` : ''}
          ${customRows}
        </tbody>
      </table>
    `;
    showModal('Biến dữ liệu', bodyHtml,
      `<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>`
    );
  }

  // Save custom column name + variable key (independent) from the Variable modal
  async function _saveCustomVar(colId) {
    const nameEl = document.getElementById('varname-' + colId);
    const keyEl = document.getElementById('varkey-' + colId);
    const name = nameEl ? nameEl.value.trim() : '';
    let var_key = keyEl ? slugVar(keyEl.value) : '';
    if (!name) { showToast('Tên cột không được để trống', 'warning'); return; }
    if (!var_key) var_key = slugVar(name);
    try {
      const result = await apiSilent(`/api/data/columns/${colId}`, { method: 'PUT', body: { name, var_key } });
      const saved = result.data || {};
      const col = customColumns.find(c => c.id === colId);
      if (col) { col.name = saved.name || name; col.var_key = saved.var_key || var_key; }
      gridApi.setGridOption('columnDefs', buildColumnDefs());
      gridApi.refreshCells({ force: true });
      showToast('Đã lưu: tên "' + (saved.name || name) + '", biến {{' + (saved.var_key || var_key) + '}}', 'success');
      showVariableMappingModal();
    } catch (err) {
      showToast('Lỗi lưu biến: ' + err.message, 'error');
    }
  }

  // Save built-in field override (tên hiển thị + biến) vào settings
  async function _saveBuiltinVar(field) {
    const nameEl = document.getElementById('fldname-' + field);
    const keyEl = document.getElementById('fldkey-' + field);
    const label = nameEl ? nameEl.value.trim() : '';
    let varKey = keyEl ? slugVar(keyEl.value) : '';
    if (!label) { showToast('Tên cột không được để trống', 'warning'); return; }
    if (!varKey) varKey = field;
    fieldOverrides[field] = { label, var: varKey };
    try {
      await apiSilent('/api/settings', {
        method: 'PUT',
        body: { field_overrides: JSON.stringify(fieldOverrides) },
      });
      if (gridApi) {
        gridApi.setGridOption('columnDefs', buildColumnDefs());
        gridApi.refreshCells({ force: true });
      }
      showToast('Đã lưu: tên "' + label + '", biến {{' + varKey + '}}', 'success');
      showVariableMappingModal();
    } catch (err) {
      showToast('Lỗi lưu biến: ' + err.message, 'error');
    }
  }

  // ============================================
  // Fill Down Selection
  // ============================================
  async function fillDownSelection() {
    if (!gridApi) return;

    // If range is active, fill top row's cells down through range column by column
    if (rangeState.active) {
      const allCols = getEditableColIds();
      const minRow = Math.min(rangeState.startRowIdx, rangeState.endRowIdx);
      const maxRow = Math.max(rangeState.startRowIdx, rangeState.endRowIdx);
      const sIdx = allCols.indexOf(rangeState.startColId);
      const eIdx = allCols.indexOf(rangeState.endColId !== null ? rangeState.endColId : rangeState.startColId);
      if (sIdx < 0 || minRow === maxRow) {
        showToast('Chon vung it nhat 2 hang de fill xuong', 'warning');
        return;
      }
      const minCol = Math.min(sIdx, eIdx < 0 ? sIdx : eIdx);
      const maxCol = Math.max(sIdx, eIdx < 0 ? sIdx : eIdx);
      const undoCells = [];
      for (let c = minCol; c <= maxCol; c++) {
        const colId = allCols[c];
        const sourceNode = gridApi.getDisplayedRowAtIndex(minRow);
        if (!sourceNode || !sourceNode.data) continue;
        const sourceValue = sourceNode.data[colId] || '';
        for (let r = minRow + 1; r <= maxRow; r++) {
          const node = gridApi.getDisplayedRowAtIndex(r);
          if (!node || !node.data) continue;
          undoCells.push({ rowId: node.data.id, field: colId, oldValue: node.data[colId] || '' });
          node.setDataValue(colId, sourceValue);
        }
      }
      if (undoCells.length > 0) pushUndo({ type: 'clearCells', cells: undoCells });
      showToast('Da fill du lieu xuong ' + (maxRow - minRow) + ' hang', 'success');
      return;
    }

    // Fallback: focused cell + selected rows
    const focusedCell = gridApi.getFocusedCell();
    if (!focusedCell) {
      showToast('Chon vung keo hoac chon hang + cot truoc khi fill', 'warning');
      return;
    }
    const field = focusedCell.column.getColId();
    if (!field || field === 'checkbox' || field === 'drag' || field === '0') {
      showToast('Khong the fill cot nay', 'warning');
      return;
    }

    const selectedRows = gridApi.getSelectedRows();
    if (selectedRows.length < 2) {
      showToast('Chon it nhat 2 hang de fill xuong', 'warning');
      return;
    }

    const sortedNodes = [];
    gridApi.forEachNodeAfterFilterAndSort(node => {
      if (selectedRows.some(r => r.id === node.data.id)) sortedNodes.push(node);
    });

    if (sortedNodes.length < 2) return;

    const sourceValue = sortedNodes[0].data[field] || '';
    for (let i = 1; i < sortedNodes.length; i++) {
      sortedNodes[i].setDataValue(field, sourceValue);
    }
    showToast('Da fill du lieu xuong', 'success');
  }

  // ============================================
  // Import / Export Excel
  // ============================================
  function importExcel() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      if (!input.files || input.files.length === 0) return;
      const formData = new FormData();
      formData.append('file', input.files[0]);
      try {
        showToast('Đang đọc file...', 'info');
        const result = await apiUpload('/api/data/import-excel', formData);
        if (result.success) showImportPreviewModal(result.data.sheets);
      } catch (err) {
        showToast('Lỗi đọc file: ' + err.message, 'error');
      }
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  function showImportPreviewModal(sheets) {
    if (!sheets || sheets.length === 0) { showToast('File không có dữ liệu', 'warning'); return; }
    window._importSheets = sheets;
    window._selectedImportSheet = 0;

    const tabsHtml = sheets.map((sheet, i) =>
      `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'} btn-sm import-sheet-tab" data-index="${i}" onclick="DataManager._selectImportTab(${i})">
        ${escapeHtml(sheet.name)} (${sheet.totalRows} hàng)
      </button>`
    ).join('');

    const bodyHtml = `
      <div style="margin-bottom:14px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">Chọn sheet:</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;" id="import-sheet-tabs">${tabsHtml}</div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Xem trước (5 hàng đầu):</div>
      <div id="import-preview-table" style="overflow-x:auto;max-height:300px;overflow-y:auto;border:1px solid var(--border-color);border-radius:var(--radius-sm);">
        ${buildPreviewTable(sheets[0])}
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--text-secondary);">
        📌 Cột tự động map: Nội dung → content, Hình ảnh → image_path${App.currentPlatform === 'tiktok' ? ', ID_Sản Phẩm → product_id' : ''}, Link → link, Nhóm/Trang → target
      </div>
    `;

    showModal('Import từ Excel', bodyHtml,
      `<button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
       <button class="btn btn-primary" onclick="DataManager._confirmImport()">📥 Import</button>`
    );
  }

  function buildPreviewTable(sheet) {
    if (!sheet || !sheet.preview || sheet.preview.length === 0) {
      return '<div style="padding:20px;text-align:center;color:var(--text-muted);">Sheet trống</div>';
    }
    const cols = sheet.columns;
    const header = cols.map(c => `<th class="preview-th">${escapeHtml(c)}</th>`).join('');
    const rows = sheet.preview.map(row => {
      const cells = cols.map(c => `<td class="preview-td" title="${escapeHtml(String(row[c]||''))}">${escapeHtml(String(row[c]||''))}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table class="preview-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function _selectImportTab(index) {
    const sheets = window._importSheets;
    if (!sheets || !sheets[index]) return;
    window._selectedImportSheet = index;
    document.querySelectorAll('.import-sheet-tab').forEach((tab, i) => {
      tab.className = `btn ${i === index ? 'btn-primary' : 'btn-secondary'} btn-sm import-sheet-tab`;
    });
    const el = document.getElementById('import-preview-table');
    if (el) el.innerHTML = buildPreviewTable(sheets[index]);
  }

  async function _confirmImport() {
    const sheets = window._importSheets;
    const idx = window._selectedImportSheet || 0;
    if (!sheets || !sheets[idx] || sheets[idx].data.length === 0) {
      showToast('Không có dữ liệu', 'warning'); return;
    }
    closeModal();
    try {
      showToast(`Đang import ${sheets[idx].totalRows} hàng...`, 'info');
      const result = await apiSilent('/api/data/import-sheet', { method: 'POST', body: { rows: sheets[idx].data } });
      if (result.success) {
        showToast(`Import thành công ${result.data.imported} hàng`, 'success');
        await load();
      }
    } catch (err) {
      showToast('Lỗi import: ' + err.message, 'error');
    }
    delete window._importSheets;
    delete window._selectedImportSheet;
  }

  function exportExcel() {
    // Phải kèm nền tảng đang xem, nếu không máy chủ mặc định trả dữ liệu Facebook
    // dù đang đứng ở tab TikTok/YouTube.
    window.open(platformApiUrl('/api/data/export-excel'), '_blank');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Public API
  // ============================================
  return {
    load,
    addRow,
    deleteSelected,
    importExcel,
    exportExcel,
    showAddColumnModal,
    showDeleteColumnModal,
    showManageColumnsModal,
    showVariableMappingModal,
    showProfilePicker,
    fillDownSelection,
    undo,
    redo,
    saveData,
    _confirmAddColumn,
    _deleteColumn,
    _renameColumn,
    _saveCustomVar,
    _saveBuiltinVar,
    _selectImportTab,
    _confirmImport,
    _verifyCustomPassword,
    _switchSyncTab,
    _previewColumnSync,
    _executeColumnSync,
    _saveAutoSyncRules,
    _undoSyncRun,
  };
})();
