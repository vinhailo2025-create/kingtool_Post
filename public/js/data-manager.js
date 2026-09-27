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
  let managedTargetState = null;
  let aiModalState = null;
  let aiImageModalState = null;
  const pendingAutoSync = new Map();
  const SYNC_BLOCKED_VARS = new Set(['status', 'link', 'link_fanpage', 'post_group', 'link_post', 'time_post', 'time_comment', 'comment_status']);
  const PLATFORM_META = {
    facebook: { label: 'Facebook', icon: '/assets/platforms/facebook.webp' },
    tiktok: { label: 'TikTok', icon: '/assets/platforms/tiktok.png' },
    youtube: { label: 'YouTube', icon: '/assets/platforms/youtube.webp' },
    threads: { label: 'Threads', icon: '/assets/platforms/threads.png' },
    instagram: { label: 'Instagram', icon: '/assets/platforms/instagram.png' },
    x: { label: 'X', icon: '/assets/platforms/x.png' },
    zalovideo: { label: 'Zalo Video', icon: '/assets/platforms/zalo-video.svg' },
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

  // Hai bảng dùng chung component lưới nhưng tải hai tập bản ghi độc lập.
  let viewMode = 'post';
  function viewStorageKey() {
    return `covergem-dataview-${(App && App.currentPlatform) || 'facebook'}`;
  }
  function syncViewModeFromStorage() {
    try {
      const saved = localStorage.getItem(viewStorageKey());
      viewMode = saved === 'comment' ? 'comment' : 'post';
    } catch (e) { viewMode = 'post'; }
  }
  function getViewMode() { return viewMode; }
  function dataModeValue() {
    return viewMode === 'comment' ? 'comment_link' : 'post';
  }
  function dataApiPath(path = '/api/data') {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}mode=${encodeURIComponent(dataModeValue())}`;
  }
  async function setViewMode(mode) {
    const next = mode === 'comment' ? 'comment' : 'post';
    const changed = viewMode !== next;
    viewMode = next;
    if (changed) {
      undoStack.length = 0;
      redoStack.length = 0;
    }
    try { localStorage.setItem(viewStorageKey(), next); } catch (e) {}
    if (typeof App !== 'undefined' && App.updatePageActions) App.updatePageActions('data');
    // View binh luan can it nhat 1 nhom binh luan de co cot nhap noi dung.
    if (next === 'comment' && commentSequences().length === 0) {
      try {
        const result = await apiSilent('/api/data/columns/comment-group', { method: 'POST' });
        if (result.success) {
          customColumns.push(...result.data.columns);
          if (gridApi) {
            gridApi.forEachNode(node => {
              if (!node.data) return;
              result.data.columns.forEach(column => { node.data[`custom_${column.id}`] = ''; });
            });
          }
        }
      } catch (e) {}
    }
    if (gridApi) {
      gridApi.setGridOption('columnDefs', buildColumnDefs());
      await load();
    }
  }

  // Rut gon noi dung dai ~15 tu, click 1 lan mo popup xem/sua toan bo.
  function truncatedTextRenderer(params) {
    const value = params.value == null ? '' : String(params.value);
    const span = document.createElement('span');
    span.className = 'cell-truncate';
    const words = value.split(/\s+/).filter(Boolean);
    span.textContent = words.length > 15 ? words.slice(0, 15).join(' ') + '…' : value;
    span.title = value;
    return span;
  }

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
  { field: 'product_id', label: 'ID Sản phẩm (tùy chọn)', platform: 'tiktok' },
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

  const COMMENT_FIELD_BASES = ['comment', 'comment_media', 'time_comment', 'comment_status'];
  const PROTECTED_CUSTOM_VARS = new Set([
    'name_profile', 'link_fanpage', 'link_post', 'time_post',
    'description', 'channel_name', 'playlist', 'privacy_status', 'thumbnail', 'keywords',
  ]);

  function commentVarKey(base, sequence) {
    return Number(sequence) === 1 ? base : `${base}_${sequence}`;
  }

  function parseCommentVarKey(varKey) {
    const key = String(varKey || '');
    for (const base of COMMENT_FIELD_BASES) {
      if (key === base) return { base, sequence: 1 };
      const match = key.match(new RegExp(`^${base}_(\\d+)$`));
      if (match && Number(match[1]) >= 2) return { base, sequence: Number(match[1]) };
    }
    return null;
  }

  function commentSequences() {
    const values = new Set();
    customColumns.forEach(column => {
      const parsed = parseCommentVarKey(column.var_key || slugVar(column.name));
      if (parsed) values.add(parsed.sequence);
    });
    return [...values].sort((a, b) => a - b);
  }

  function isProtectedCustomColumn(column) {
    const varKey = column && (column.var_key || slugVar(column.name));
    return PROTECTED_CUSTOM_VARS.has(varKey);
  }

  function isSystemWorkflowColumn(column) {
    const varKey = column && (column.var_key || slugVar(column.name));
    return PROTECTED_CUSTOM_VARS.has(varKey) || Boolean(parseCommentVarKey(varKey));
  }

  function isSyncBlockedVar(varKey) {
    const parsed = parseCommentVarKey(varKey);
    return SYNC_BLOCKED_VARS.has(varKey)
      || (parsed && ['time_comment', 'comment_status'].includes(parsed.base));
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
      if (varKey === 'content') {
        const aiButton = document.createElement('button');
        aiButton.type = 'button';
        aiButton.className = 'content-ai-header-button';
        aiButton.innerHTML = '<span aria-hidden="true">✦</span> AI';
        aiButton.title = 'Viết lại nội dung cho các hàng đã chọn';
        aiButton.setAttribute('aria-label', 'Viết lại nội dung bằng AI');
        aiButton.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          showAiRewriteModal();
        });
        root.appendChild(aiButton);
      }
      if (varKey === 'image_path') {
        const imageAiButton = document.createElement('button');
        imageAiButton.type = 'button';
        imageAiButton.className = 'content-ai-header-button';
        imageAiButton.innerHTML = '<span aria-hidden="true">✦</span> Ảnh AI';
        imageAiButton.title = 'Tạo ảnh bằng tài khoản ChatGPT cho các hàng đã chọn';
        imageAiButton.setAttribute('aria-label', 'Tạo ảnh bằng ChatGPT');
        imageAiButton.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          showAiImageModal();
        });
        root.appendChild(imageAiButton);
      }
      root.appendChild(syncButton);
      this.eGui = root;
    }

    getGui() { return this.eGui; }
    refresh() { return false; }
    destroy() { if (this.removeSortListener) this.removeSortListener(); }
  }

  function syncableColumn(def, varKey, colType = 'text') {
    if (!varKey || isSyncBlockedVar(varKey)) return def;
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
    if (opts.truncate) {
      def.autoHeight = false;
      def.wrapText = false;
      def.cellRenderer = truncatedTextRenderer;
      def.singleClickEdit = true;
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
      const postGroup = customColByVar('post_group');
      if (postGroup) cols.push(customColDef(postGroup, {
        label: 'Post_group', editable: true, isLink: true, minWidth: 220, flex: 1,
      }));
    }

    // Nội dung
    cols.push(syncableColumn({
      headerName: fieldLabel('content', 'Nội dung'), field: 'content',
      minWidth: 220, flex: 2, editable: true,
      cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true,
      cellEditorParams: { maxLength: 10000, rows: 10, cols: 60 },
      cellRenderer: truncatedTextRenderer, singleClickEdit: true, cellClass: 'cell-wrap',
    }, 'content', 'text'));

    // Media (image_path)
    cols.push(syncableColumn({
      headerName: 'Media', field: 'image_path',
      minWidth: 200, flex: 1, editable: true, autoHeight: true, wrapText: true,
      cellClass: 'cell-wrap', cellRenderer: imagePathRenderer,
      valueParser: params => sanitizeMediaValue(params.newValue),
      tooltipValueGetter: (p) => p.value || '',
    }, 'image_path', 'file'));

    if (App.currentPlatform === 'facebook') {
      const thumbnail = customColByVar('thumbnail');
      if (thumbnail) cols.push(customColDef(thumbnail, {
        label: 'Hình Thumbnail', minWidth: 210, flex: 1,
      }));
    }

    // Platform-owned posting fields remain isolated between data workspaces.
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

    if (App.currentPlatform === 'zalovideo') {
      const playlist = customColByVar('playlist');
      if (playlist) cols.push(customColDef(playlist, {
        label: 'Danh sách phát', minWidth: 180, flex: 1,
      }));
    }

    // TikTok product identifier
    if (App.currentPlatform === 'tiktok') {
      cols.push(syncableColumn({
      headerName: fieldLabel('product_id', 'ID Sản phẩm (tùy chọn)'), field: 'product_id',
      headerTooltip: 'Có thể để trống; TikTok vẫn đăng video bình thường',
        headerTooltip: 'Một ID hoặc nhiều ID ngăn cách bằng dấu phẩy, ví dụ: id1, id2',
        width: 180, minWidth: 150, maxWidth: 240, editable: true,
        autoHeight: true, wrapText: true, cellClass: 'cell-wrap',
      }, 'product_id', 'text'));
    }

    // Trạng thái
    cols.push({
      headerName: fieldLabel('status', 'Trạng thái'), field: 'status',
      width: 164, minWidth: 145, maxWidth: 190, editable: false,
      cellRenderer: statusCellRenderer,
    });

    // link_post (tự điền sau khi đăng)
    const lpc = customColByVar('link_post');
    if (lpc) cols.push(customColDef(lpc, { label: 'Link Post', editable: viewMode === 'comment', isLink: true, minWidth: 210, flex: 1 }));

    // time_post (tự điền thời gian đăng)
    const tpc = customColByVar('time_post');
    if (tpc) cols.push(customColDef(tpc, { label: 'Thời gian đăng', editable: false, width: 172 }));

    // Dữ liệu đầu vào và kết quả của hàng đợi bình luận bền vững.
    // Nhóm bình luận chỉ xuất hiện khi người dùng thêm cột Bình luận.
    for (const sequence of commentSequences()) {
      const content = customColByVar(commentVarKey('comment', sequence));
      if (content) cols.push(customColDef(content, {
        label: `Bình luận ${sequence}`, editable: true, minWidth: 220, flex: 2, largeText: true, truncate: true,
      }));

      const media = customColByVar(commentVarKey('comment_media', sequence));
      if (media) cols.push(customColDef(media, {
        label: `Media bình luận ${sequence}`, editable: true, minWidth: 200, flex: 1,
      }));

      const time = customColByVar(commentVarKey('time_comment', sequence));
      if (time) cols.push(customColDef(time, {
        label: `Thời gian bình luận ${sequence}`, editable: false, width: 172,
      }));

      const status = customColByVar(commentVarKey('comment_status', sequence));
      if (status) cols.push(customColDef(status, {
        label: `Trạng thái bình luận ${sequence}`, editable: false, width: 172,
        cellRenderer: commentStatusCellRenderer,
      }));
    }

    const renderedCustomIds = new Set(
      cols.map(column => column._customColId).filter(Boolean)
    );
    for (const column of customColumns) {
      if (!renderedCustomIds.has(column.id)) cols.push(customColDef(column));
    }

    // View "Bình luận": chi giu cot lien quan binh luan theo link (an content/media/target...).
    if (viewMode === 'comment') {
      return cols.filter(col => {
        if (col.colId === 'checkbox' || col.colId === 'rownum') return true;
        const cid = col._customColId;
        if (!cid) return false;
        const cc = customColumns.find(item => item.id === cid);
        if (!cc) return false;
        const vk = cc.var_key || slugVar(cc.name);
        if (vk === 'name_profile' || vk === 'link_post' || vk === 'link_fanpage') return true;
        return parseCommentVarKey(vk) !== null;
      });
    }

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
    browseBtn.type = 'button';
    browseBtn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 6.5h6l2 2h9v9a2 2 0 0 1-2 2h-15v-13Z"></path>
        <path d="M3.5 9.5h17"></path>
      </svg>
    `;
    browseBtn.title = 'Chọn Media từ máy';
    browseBtn.setAttribute('aria-label', 'Chọn Media từ máy');
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      browseFile(params, browseBtn);
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
      search: '',
    };
    showModal(
      `Chọn profile · ${App.platformLabel()}`,
      '<div class="profile-picker-loading"><span class="sync-loader"></span><div>Đang tải danh sách profile...</div></div>',
      '<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>'
    );
    document.getElementById('modal')?.classList.add('modal-wide');
    try {
      const res = await apiSilent('/api/browsers?platform=all');
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
      const textMatch = !needle || [
        profile.name,
        profile.note,
        profile.provider_profile_id,
        provider,
        ...(profile.groups || []).map(group => group.name),
      ]
        .some(value => String(value || '').toLowerCase().includes(needle));
      return providerMatch && textMatch;
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

  function managedTargetKey(value) {
    return String(value || '').trim().toLocaleLowerCase('vi');
  }

  function managedTargetCandidates(profileName) {
    const key = managedTargetKey(profileName);
    return (managedTargetState.targets || []).filter(item =>
      managedTargetKey(item.profile_name) === key
    );
  }

  async function mapManagedTargets() {
    if (!gridApi) return;
    const type = App.currentPlatform === 'youtube' ? 'youtube' : 'facebook';
    const targetVar = type === 'youtube' ? 'channel_name' : 'link_fanpage';
    const nameCol = getNameProfileColumn();
    const targetCol = customColByVar(targetVar);
    const rows = gridApi.getSelectedRows();
    if (!nameCol || !targetCol) return showToast(`Chưa có cột ${type === 'youtube' ? 'Tên kênh' : 'Link Fanpage'}`, 'warning');
    if (!rows.length) return showToast('Chọn ít nhất 1 hàng để map dữ liệu', 'warning');
    const response = await api(`/api/browsers/targets?type=${type}`);
    managedTargetState = {
      type,
      targetVar,
      targetCol,
      nameCol,
      rows,
      targets: Array.isArray(response.data) ? response.data : [],
      profiles: null,
      view: 'picker',
    };
    showModal(type === 'youtube' ? 'Chọn kênh YouTube' : 'Chọn Fanpage', '', '');
    document.getElementById('modal')?.classList.add('modal-wide');
    renderManagedTargets();
  }

  function renderManagedTargets() {
    if (!managedTargetState) return;
    if (managedTargetState.view === 'scan') return renderManagedTargetScan();
    if (managedTargetState.view === 'result') return renderManagedTargetResult();
    const { type, rows, nameCol } = managedTargetState;
    const noun = type === 'youtube' ? 'kênh YouTube' : 'Fanpage';
    const body = `
      <div class="managed-target-picker-intro">
        <strong>${rows.length} hàng đã chọn</strong>
        <span>Tool chỉ đưa ra ${noun} thuộc đúng profile.</span>
      </div>
      <div class="managed-target-picker-list">
        ${rows.map((row, index) => {
          const profileName = row[`custom_${nameCol.id}`] || '';
          const candidates = managedTargetCandidates(profileName);
          return `
          <label class="managed-target-picker-row">
            <span class="managed-target-picker-profile">${escapeHtml(profileName || 'Chưa có profile')}</span>
            <select class="form-select managed-target-choice" data-index="${index}">
              <option value="">${candidates.length ? 'Chọn dữ liệu' : 'Chưa tìm thấy'}</option>
              ${candidates.map(target => `
                <option value="${escapeHtml(type === 'youtube' ? (target.name || target.id) : (target.url || target.id))}" ${candidates.length === 1 ? 'selected' : ''}>
                  ${escapeHtml(target.name || target.url || target.id)}
                </option>
              `).join('')}
            </select>
          </label>`;
        }).join('')}
      </div>
    `;
    document.getElementById('modal-body').innerHTML = body;
    const saved = (managedTargetState.targets || []).length;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      ${saved ? `<button class="btn btn-secondary" onclick="DataManager.viewManagedTargetResult()">👁 Xem danh sách đã lưu (${saved})</button>` : ''}
      <button class="btn btn-secondary" onclick="DataManager.openManagedTargetScan()">🔄 Lấy danh sách</button>
      <button class="btn btn-primary" onclick="DataManager.applyManagedTargets()">Áp dụng</button>
    `;
  }

  function renderManagedTargetScan() {
    const { type, rows, nameCol, profiles } = managedTargetState;
    const noun = type === 'youtube' ? 'kênh YouTube' : 'Fanpage';
    const footerBack = '<button class="btn btn-secondary" onclick="DataManager.backToManagedTargetPicker()">← Quay lại</button>';
    if (!profiles) {
      document.getElementById('modal-body').innerHTML = '<div class="profile-picker-loading"><span class="sync-loader"></span><div>Đang tải danh sách profile...</div></div>';
      document.getElementById('modal-footer').innerHTML = footerBack;
      return;
    }
    const wanted = new Set(rows.map(row => managedTargetKey(row[`custom_${nameCol.id}`])).filter(Boolean));
    const list = profiles.length ? profiles.map(profile => {
      const checked = wanted.has(managedTargetKey(profile.name)) ? 'checked' : '';
      return `
        <label class="managed-target-profile">
          <input type="checkbox" class="managed-target-scan-check" value="${profile.id}" ${checked}>
          <span>${escapeHtml(profile.name || `Profile ${profile.id}`)}</span>
        </label>`;
    }).join('') : '<div class="managed-target-empty">Chưa có profile nào.</div>';
    document.getElementById('modal-body').innerHTML = `
      <div class="managed-target-picker-intro">
        <strong>Chọn profile để mở lấy ${noun}</strong>
        <span>Tool sẽ mở Chrome từng profile để quét ${noun} mới nhất.</span>
      </div>
      <div class="managed-target-profile-head">
        <span>Profile đúng với các hàng đang chọn được tích sẵn.</span>
        <button class="btn btn-link btn-sm" onclick="DataManager.toggleManagedTargetScan(true)">Chọn tất cả</button>
      </div>
      <div class="managed-target-profile-list">${list}</div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      ${footerBack}
      <button class="btn btn-primary" id="managed-target-scan-run" onclick="DataManager.runManagedTargetScan()">🔄 Mở &amp; lấy danh sách</button>
    `;
  }

  function renderManagedTargetResult() {
    const { type, targets } = managedTargetState;
    const noun = type === 'youtube' ? 'kênh YouTube' : 'Fanpage';
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) {
      document.getElementById('modal-body').innerHTML = `<div class="managed-target-empty">Chưa tìm thấy ${noun} nào.</div>`;
      document.getElementById('modal-footer').innerHTML = `
        <button class="btn btn-secondary" onclick="DataManager.openManagedTargetScan()">🔄 Lấy lại</button>
        <button class="btn btn-primary" onclick="DataManager.backToManagedTargetPicker()">Xong</button>`;
      return;
    }
    const rowsHtml = list.map((item, index) => {
      const id = String(item.id || '');
      return `
        <tr>
          <td class="mt-col-check"><input type="checkbox" class="managed-target-result-check" data-id="${escapeHtml(id)}"></td>
          <td class="mt-col-stt">${index + 1}</td>
          <td>${escapeHtml(item.name || id)}</td>
          <td>${escapeHtml(item.profile_name || '')}</td>
          <td class="mt-col-id">${escapeHtml(id)}</td>
          <td class="mt-col-copy"><button class="btn btn-ghost btn-sm" data-copy="${escapeHtml(id)}" onclick="DataManager.copyText(this.dataset.copy)" title="Copy ID">📋</button></td>
        </tr>`;
    }).join('');
    document.getElementById('modal-body').innerHTML = `
      <div class="managed-target-picker-intro">
        <strong>Tìm thấy ${list.length} ${noun}</strong>
        <span>Tích chọn rồi bấm "Copy đã chọn", hoặc bấm 📋 để copy từng ID.</span>
      </div>
      <div class="managed-target-result-wrap">
        <table class="managed-target-result-table">
          <thead>
            <tr>
              <th class="mt-col-check"><input type="checkbox" onclick="DataManager.toggleManagedTargetResult(this.checked)"></th>
              <th class="mt-col-stt">STT</th>
              <th>${noun}</th>
              <th>Tài khoản</th>
              <th class="mt-col-id">ID</th>
              <th class="mt-col-copy"></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
    document.getElementById('modal-footer').innerHTML = `
      <button class="btn btn-secondary" onclick="DataManager.openManagedTargetScan()">🔄 Lấy lại</button>
      <button class="btn btn-secondary" onclick="DataManager.copyManagedTargetsSelected()">📋 Copy đã chọn</button>
      <button class="btn btn-primary" onclick="DataManager.backToManagedTargetPicker()">Dùng để map</button>
    `;
  }

  function viewManagedTargetResult() {
    if (!managedTargetState) return;
    managedTargetState.view = 'result';
    renderManagedTargets();
  }

  function toggleManagedTargetResult(checked) {
    document.querySelectorAll('.managed-target-result-check').forEach(input => { input.checked = checked; });
  }

  async function copyText(value) {
    const text = String(value || '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Đã copy', 'success');
    } catch (err) {
      showToast('Trình duyệt chặn copy clipboard', 'error');
    }
  }

  function copyManagedTargetsSelected() {
    const ids = [...document.querySelectorAll('.managed-target-result-check:checked')].map(input => input.dataset.id).filter(Boolean);
    if (!ids.length) return showToast('Chọn ít nhất 1 dòng để copy', 'warning');
    copyText(ids.join('\n'));
  }

  async function openManagedTargetScan() {
    if (!managedTargetState) return;
    managedTargetState.view = 'scan';
    renderManagedTargets();
    if (!managedTargetState.profiles) {
      try {
        const res = await apiSilent('/api/browsers?platform=all');
        managedTargetState.profiles = res.data || [];
      } catch (err) {
        managedTargetState.profiles = [];
        showToast(err.message || 'Không tải được danh sách profile', 'warning');
      }
      if (managedTargetState && managedTargetState.view === 'scan') renderManagedTargets();
    }
  }

  function backToManagedTargetPicker() {
    if (!managedTargetState) return;
    managedTargetState.view = 'picker';
    renderManagedTargets();
  }

  function toggleManagedTargetScan(checked) {
    document.querySelectorAll('.managed-target-scan-check').forEach(input => { input.checked = checked; });
  }

  async function runManagedTargetScan() {
    if (!managedTargetState) return;
    const ids = [...document.querySelectorAll('.managed-target-scan-check:checked')].map(input => Number(input.value));
    if (!ids.length) return showToast('Chọn ít nhất 1 profile', 'warning');
    const btn = document.getElementById('managed-target-scan-run');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang mở & lấy...'; }
    try {
      const res = await api('/api/browsers/targets/scan', {
        method: 'POST',
        body: { type: managedTargetState.type, profileIds: ids },
      });
      const payload = res.data || {};
      managedTargetState.targets = Array.isArray(payload.data) ? payload.data : managedTargetState.targets;
      const ok = payload.results?.filter(item => item.success).length || 0;
      const total = payload.results?.length || ids.length;
      showToast(`Đã lấy danh sách ${ok}/${total} profile`, ok ? 'success' : 'warning');
      managedTargetState.view = 'result';
      renderManagedTargets();
    } catch (err) {
      showToast(err.message || 'Không lấy được danh sách', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '🔄 Mở &amp; lấy danh sách'; }
    }
  }

  function applyManagedTargets() {
    if (!managedTargetState) return;
    const choices = [...document.querySelectorAll('.managed-target-choice')];
    let applied = 0;
    choices.forEach(select => {
      const index = Number(select.dataset.index);
      const value = select.value || '';
      const row = managedTargetState.rows[index];
      if (!row || !value) return;
      const node = gridApi.getRowNode(String(row.id));
      if (node) {
        node.setDataValue(`custom_${managedTargetState.targetCol.id}`, value);
        applied++;
      }
    });
    managedTargetState = null;
    closeModal();
    showToast(`Đã map ${applied}/${choices.length} hàng`, applied === choices.length ? 'success' : 'warning');
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
      scheduled: { label: '🕒 Hẹn giờ', cls: 'badge-pending' },
      running: { label: '🔄 Đang chạy', cls: 'badge-running' },
      success: { label: '✅ Thành công', cls: 'badge-success' },
      error: { label: '❌ Lỗi', cls: 'badge-error' },
    };
    const currentValue = String(params.value || 'pending');
    const select = document.createElement('select');
    select.className = `status-select-cell ${statusMap[currentValue]?.cls || 'badge-closed'}`;
    select.title = 'Đổi trạng thái thủ công - thay đổi được lưu ngay';
    select.setAttribute('aria-label', 'Trạng thái');

    const values = Object.keys(statusMap);
    if (!values.includes(currentValue)) values.unshift(currentValue);
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = statusMap[value]?.label || value;
      option.selected = value === currentValue;
      option.disabled = ['blocked', 'scheduled', 'running'].includes(value) && value !== currentValue;
      select.appendChild(option);
    });

    // Keep the native dropdown responsive and outside the Excel-style range handler.
    for (const eventName of ['mousedown', 'click', 'keydown']) {
      select.addEventListener(eventName, event => event.stopPropagation());
    }
    select.addEventListener('change', () => {
      if (params.node) params.node.setDataValue('status', select.value);
    });
    return select;
  }

  function commentStatusCellRenderer(params) {
    const statusMap = {
      waiting_approval: { label: '⏳ Chờ duyệt / lấy link', cls: 'badge-pending' },
      approval_checking: { label: '🔎 Đang tìm bài', cls: 'badge-running' },
      blocked: { label: '🔒 Chưa đến lượt', cls: 'badge-closed' },
      waiting: { label: '⏳ Đang chờ', cls: 'badge-pending' },
      running: { label: '🔄 Đang chạy', cls: 'badge-running' },
      success: { label: '✅ Thành công', cls: 'badge-success' },
      error: { label: '❌ Lỗi', cls: 'badge-error' },
      skipped: { label: '⏭ Bỏ qua', cls: 'badge-closed' },
    };
    const currentValue = String(params.value || 'skipped');
    const select = document.createElement('select');
    select.className = `status-select-cell ${statusMap[currentValue]?.cls || 'badge-closed'}`;
    select.title = 'Có thể đổi trạng thái thủ công; chọn Đang chờ để chạy lại bình luận lỗi';
    select.setAttribute('aria-label', 'Trạng thái bình luận');
    const values = [...new Set([currentValue, 'waiting', 'success', 'error', 'skipped'])];
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = statusMap[value]?.label || value;
      option.selected = value === currentValue;
      select.appendChild(option);
    });
    for (const eventName of ['mousedown', 'click', 'keydown']) {
      select.addEventListener(eventName, event => event.stopPropagation());
    }
    select.addEventListener('change', () => {
      const field = params.colDef && params.colDef.field;
      if (params.node && field) params.node.setDataValue(field, select.value);
    });
    return select;
  }

  // ============================================
  // Grid Initialization
  // ============================================
  const GRID_LOCALE_VI = {
    filterOoo: 'Nhập nội dung cần lọc...',
    equals: 'Bằng',
    notEqual: 'Không bằng',
    blank: 'Để trống',
    notBlank: 'Không trống',
    empty: 'Chọn điều kiện',
    lessThan: 'Nhỏ hơn',
    greaterThan: 'Lớn hơn',
    lessThanOrEqual: 'Nhỏ hơn hoặc bằng',
    greaterThanOrEqual: 'Lớn hơn hoặc bằng',
    inRange: 'Trong khoảng',
    inRangeStart: 'Từ',
    inRangeEnd: 'Đến',
    contains: 'Có chứa',
    notContains: 'Không chứa',
    startsWith: 'Bắt đầu bằng',
    endsWith: 'Kết thúc bằng',
    andCondition: 'Và',
    orCondition: 'Hoặc',
    applyFilter: 'Áp dụng',
    resetFilter: 'Đặt lại',
    clearFilter: 'Xóa lọc',
    cancelFilter: 'Hủy',
    selectAll: 'Chọn tất cả',
    searchOoo: 'Tìm trong danh sách...',
    noMatches: 'Không có kết quả',
    loadingOoo: 'Đang tải...',
    columns: 'Cột',
    filters: 'Bộ lọc',
  };

  function initGrid() {
    const container = document.getElementById('page-data');
    if (!container) return;

    container.innerHTML = `
      <div id="data-grid-wrapper" data-tour-id="data-grid"
           style="display:flex;flex-direction:column;height:100%;">
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
      localeText: GRID_LOCALE_VI,
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
      await apiSilent(dataApiPath(`/api/data/${data.id}`), {
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
      await apiSilent(dataApiPath('/api/data/reorder'), { method: 'POST', body: { orderedIds } });
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
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates: Array.from(updates.values()) } });
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
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates: Array.from(updates.values()) } });
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
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates: Array.from(updates.values()) } });
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
  // Password gate is only used by the variable-mapping screen.
  // ============================================
  function requireCustomAccess(onSuccess) {
    if (customUnlocked) { onSuccess(); return; }
    const bodyHtml = `
      <div class="form-group">
        <label class="form-label">Nhập mật khẩu để mở phần Biến dữ liệu</label>
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
  async function browseFile(params, triggerButton = null) {
    const field = params.colDef.field;
    const id = params.data.id;
    if (triggerButton) {
      triggerButton.disabled = true;
      triggerButton.classList.add('is-loading');
      triggerButton.setAttribute('aria-busy', 'true');
    }
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
    } finally {
      if (triggerButton) {
        triggerButton.disabled = false;
        triggerButton.classList.remove('is-loading');
        triggerButton.removeAttribute('aria-busy');
      }
    }
  }

  // ============================================
  // Per-column cross-platform synchronization
  // ============================================

  async function loadSyncRules() {
    const sourcePlatform = App.currentPlatform;
    try {
      const result = await apiSilent(
        `/api/data/sync/rules?source_platform=${encodeURIComponent(sourcePlatform)}`
      );
      if (App.currentPlatform !== sourcePlatform) return;
      syncRules = result.success && Array.isArray(result.data) ? result.data : [];
    } catch (_) {
      if (App.currentPlatform === sourcePlatform) syncRules = [];
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
    if (!varKey || isSyncBlockedVar(varKey)) return;
    const sourcePlatform = App.currentPlatform;
    syncModalState = {
      sourcePlatform,
      varKey,
      label,
      colType,
      tab: 'manual',
      targets: [],
      lastPayload: null,
    };
    showModal('Đồng bộ cột', `
      <div class="sync-loading">
        <span class="sync-loader"></span>
        <div><strong>Đang kiểm tra cột tương ứng</strong><small>Hệ thống ghép cột theo biến {{${escapeHtml(varKey)}}}</small></div>
      </div>
    `, '<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>');
    document.getElementById('modal').classList.add('modal-wide');
    try {
      const result = await apiSilent(
        `/api/data/sync/targets?source_platform=${encodeURIComponent(sourcePlatform)}&source_var_key=${encodeURIComponent(varKey)}&create_missing=1`
      );
      if (
        !syncModalState
        || syncModalState.varKey !== varKey
        || syncModalState.sourcePlatform !== sourcePlatform
      ) return;
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

    const selectedPolicy = state.tab === 'auto' && firstRule
      ? firstRule.conflict_policy
      : 'overwrite';
    const commonOptions = `
      <div class="sync-options-grid">
        <label class="sync-option-field">
          <span>Xử lý dữ liệu đã có</span>
          <select id="sync-conflict-policy" class="form-select">
            <option value="overwrite" ${selectedPolicy === 'overwrite' ? 'selected' : ''}>Ghi đè dữ liệu hiện có</option>
            <option value="fill_empty" ${selectedPolicy === 'fill_empty' ? 'selected' : ''}>Chỉ điền ô trống</option>
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
        <span class="sync-source-platform"><img src="${platformInfo(state.sourcePlatform).icon}" alt=""></span>
        <div><small>Nguồn · ${platformInfo(state.sourcePlatform).label}</small><strong>${escapeHtml(state.label)}</strong><code>{{${escapeHtml(state.varKey)}}}</code></div>
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
      source_platform: syncModalState.sourcePlatform,
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
          source_platform: syncModalState.sourcePlatform,
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
    // View theo tung nen tang (doc lai khi doi tab platform)
    syncViewModeFromStorage();
    // Load field overrides (tên/biến cột mặc định) + custom columns first
    await loadFieldOverrides();
    await loadSyncRules();
    try {
      const colResult = await apiSilent('/api/data/columns');
      if (colResult.success) customColumns = colResult.data;
    } catch (e) { customColumns = []; }

    // Đảm bảo các cột hệ thống đăng bài tồn tại (cột bình luận chỉ có khi người dùng thêm)
    await ensureRequiredColumns();

    if (!gridInitialized) {
      initGrid();
    } else {
      gridApi.setGridOption('columnDefs', buildColumnDefs());
    }

    try {
      const result = await apiSilent(dataApiPath('/api/data'));
      if (result.success && gridApi) {
        gridApi.setGridOption('rowData', result.data);
        updateFooter();
      }
    } catch (err) {
      showToast('Lỗi tải dữ liệu: ' + err.message, 'error');
    }
  }

  function applyPostResult(data) {
    if (!gridApi || !data || !data.post_id) return;
    const node = gridApi.getRowNode(String(data.post_id));
    if (!node || !node.data) return;
    if (data.status !== undefined) node.setDataValue('status', data.status);
    if (data.note !== undefined) node.setDataValue('note', data.note || '');
    for (const [varKey, value] of [
      ['link_post', data.link_post],
      ['time_post', data.time_post],
    ]) {
      if (value === undefined) continue;
      const column = customColByVar(varKey);
      if (column) node.setDataValue(`custom_${column.id}`, value || '');
    }
    gridApi.refreshCells({ rowNodes: [node], force: true });
  }

  async function addRow() {
    try {
      const result = await apiSilent(dataApiPath('/api/data'), {
        method: 'POST',
        body: { content: '', status: 'pending', data_mode: dataModeValue() },
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
      const result = await apiSilent(dataApiPath('/api/data/bulk'), {
        method: 'DELETE',
        body: { ids },
      });
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
  // AI Content Rewrite
  // ============================================
  function aiProviderLabel(provider) {
    return {
      gemini: 'Gemini',
      openai: 'OpenAI',
      '9router': '9Router',
      kira: 'Kira AI',
      chatgpt: 'ChatGPT',
    }[provider] || provider;
  }

  function renderAiRewriteModal() {
    if (!aiModalState) return;
    const settings = aiModalState.settings;
    const providers = ['gemini', 'openai', '9router', 'kira', 'chatgpt'];
    const providerCards = providers.map(provider => {
      const value = settings.providers?.[provider] || {};
      const configured = provider === 'chatgpt'
        ? value.configured !== false
        : value.hasApiKey && value.model;
      return `
        <button type="button"
                class="ai-rewrite-provider ${aiModalState.provider === provider ? 'active' : ''} ${configured ? '' : 'not-configured'}"
                data-ai-rewrite-provider="${provider}"
                onclick="DataManager._selectAiRewriteProvider('${provider}')">
          <span class="ai-rewrite-provider-icon">${provider === 'gemini' ? '✦' : provider === 'openai' ? '◎' : provider === 'kira' ? '◆' : provider === 'chatgpt' ? '◉' : '↗'}</span>
          <span>
            <b>${aiProviderLabel(provider)}</b>
            <small>${configured ? escapeHtml(value.model) : 'Chưa cấu hình'}</small>
          </span>
          <i class="${configured ? 'ready' : ''}"></i>
        </button>
      `;
    }).join('');
    const providerConfig = settings.providers?.[aiModalState.provider] || {};

    showModal(
      'AI viết lại nội dung',
      `
        <div class="ai-rewrite-summary">
          <span class="ai-rewrite-count">${aiModalState.rows.length}</span>
          <div>
            <b>hàng đã chọn</b>
            <small>Chỉ cột Nội dung được thay đổi; hàng lỗi giữ nguyên.</small>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Chọn API</label>
          <div class="ai-rewrite-provider-grid">${providerCards}</div>
        </div>
        <div class="form-group">
          <div class="ai-prompt-label">
            <label class="form-label" for="ai-rewrite-prompt">Prompt viết lại nội dung</label>
            <button type="button" class="btn btn-ghost btn-sm" onclick="DataManager._resetAiPrompt()">
              Khôi phục mặc định
            </button>
          </div>
          <textarea class="form-textarea ai-rewrite-prompt" id="ai-rewrite-prompt"
                    maxlength="12000" rows="8"
                    placeholder="Nhập yêu cầu viết lại nội dung...">${escapeHtml(aiModalState.prompt)}</textarea>
          <div class="ai-prompt-meta">
            <span>Hỗ trợ <code>{{content}}</code> và <code>{{platform}}</code></span>
            <span>Prompt sẽ tự lưu khi chạy</span>
          </div>
        </div>
        <div class="ai-rewrite-status-box" id="ai-rewrite-status">
          ${(aiModalState.provider === 'chatgpt' ? providerConfig.configured !== false : providerConfig.hasApiKey)
            ? `Sẵn sàng dùng ${aiProviderLabel(aiModalState.provider)} · ${escapeHtml(providerConfig.model || '')}`
            : `${aiProviderLabel(aiModalState.provider)} chưa được cấu hình trong Cài đặt chung.`}
        </div>
      `,
      `
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Hủy</button>
        ${(aiModalState.provider === 'chatgpt' ? providerConfig.configured !== false : providerConfig.hasApiKey) ? '' : '<button type="button" class="btn btn-secondary" onclick="closeModal(); App.navigateTo(\'settings\')">Đi tới Cài đặt</button>'}
        <button type="button" class="btn btn-primary" id="ai-rewrite-run-btn"
                onclick="DataManager._confirmAiRewrite()"
                ${(aiModalState.provider === 'chatgpt' ? providerConfig.configured !== false : providerConfig.hasApiKey) ? '' : 'disabled'}>
          ✦ Viết lại nội dung
        </button>
      `
    );
    document.getElementById('modal')?.classList.add('modal-wide');
  }

  async function showAiRewriteModal() {
    if (!gridApi) return;
    const rows = gridApi.getSelectedRows().filter(row => row && row.id);
    if (!rows.length) {
      showToast('Hãy chọn ít nhất một hàng để viết lại bằng AI', 'warning');
      return;
    }
    try {
      const response = await apiSilent('/api/ai/settings');
      const settings = response.data || {};
      const configured = ['gemini', 'openai', '9router', 'kira', 'chatgpt'].filter(provider =>
        provider === 'chatgpt'
          ? settings.providers?.[provider]?.configured !== false
          : settings.providers?.[provider]?.hasApiKey && settings.providers?.[provider]?.model
      );
      let provider = settings.activeProvider || 'gemini';
      if (!configured.includes(provider) && configured.length) provider = configured[0];
      aiModalState = {
        rows: rows.map(row => ({ id: row.id, content: row.content || '' })),
        settings,
        provider,
        prompt: settings.prompt || settings.defaultPrompt || '',
      };
      renderAiRewriteModal();
    } catch (error) {
      showToast(`Không tải được cấu hình AI: ${error.message}`, 'error');
    }
  }

  function selectAiRewriteProvider(provider) {
    if (!aiModalState || !aiModalState.settings.providers?.[provider]) return;
    const prompt = document.getElementById('ai-rewrite-prompt')?.value;
    if (prompt != null) aiModalState.prompt = prompt;
    aiModalState.provider = provider;
    renderAiRewriteModal();
  }

  function resetAiPrompt() {
    if (!aiModalState) return;
    const input = document.getElementById('ai-rewrite-prompt');
    const value = aiModalState.settings.defaultPrompt || '';
    aiModalState.prompt = value;
    if (input) {
      input.value = value;
      input.focus();
    }
  }

  async function confirmAiRewrite() {
    if (!aiModalState) return;
    const promptInput = document.getElementById('ai-rewrite-prompt');
    const prompt = promptInput?.value.trim() || '';
    if (!prompt) {
      showToast('Prompt viết lại nội dung không được để trống', 'warning');
      promptInput?.focus();
      return;
    }
    const provider = aiModalState.provider;
    const providerConfig = aiModalState.settings.providers?.[provider];
    const providerReady = provider === 'chatgpt'
      ? providerConfig?.configured !== false
      : providerConfig?.hasApiKey;
    if (!providerReady) {
      showToast(`${aiProviderLabel(provider)} chưa được cấu hình`, 'warning');
      return;
    }
    const button = document.getElementById('ai-rewrite-run-btn');
    const status = document.getElementById('ai-rewrite-status');
    if (button) {
      button.disabled = true;
      button.textContent = 'Đang viết lại...';
    }
    if (status) {
      status.className = 'ai-rewrite-status-box running';
      status.innerHTML = `<span class="sync-loader"></span> Đang xử lý ${aiModalState.rows.length} hàng bằng ${aiProviderLabel(provider)}...`;
    }

    try {
      const response = await apiSilent('/api/ai/rewrite', {
        method: 'POST',
        body: {
          provider,
          prompt,
          postIds: aiModalState.rows.map(row => row.id),
        },
      });
      const result = response.data;
      const undoCells = [];
      isUndoRedoInProgress = true;
      try {
        for (const item of result.results || []) {
          if (!item.success) continue;
          const node = gridApi.getRowNode(String(item.id));
          if (!node) continue;
          undoCells.push({
            rowId: item.id,
            oldValue: item.oldContent,
            newValue: item.content,
          });
          node.data.content = item.content;
          gridApi.refreshCells({ rowNodes: [node], columns: ['content'], force: true });
        }
      } finally {
        isUndoRedoInProgress = false;
      }
      if (undoCells.length) pushUndo({ type: 'aiRewrite', cells: undoCells });
      aiModalState.prompt = prompt;
      aiModalState.settings.prompt = prompt;
      aiModalState.settings.activeProvider = provider;
      if (status) {
        status.className = `ai-rewrite-status-box ${result.failureCount ? 'partial' : 'success'}`;
        status.innerHTML = result.failureCount
          ? `Đã thay ${result.successCount}/${result.total} hàng. ${result.failureCount} hàng lỗi được giữ nguyên.`
          : `Đã viết lại thành công ${result.successCount} hàng và lưu trực tiếp vào bảng.`;
      }
      const errors = (result.results || []).filter(item => !item.success);
      if (errors.length && status) {
        status.innerHTML += `<div class="ai-rewrite-errors">${errors.slice(0, 5).map(item =>
          `#${item.id}: ${escapeHtml(item.error || 'Lỗi API')}`
        ).join('<br>')}</div>`;
      }
      const footer = document.getElementById('modal-footer');
      if (footer) {
        footer.innerHTML = '<button type="button" class="btn btn-primary" onclick="closeModal()">Hoàn tất</button>';
      }
      updateFooter();
      showToast(
        result.failureCount
          ? `AI đã thay ${result.successCount}/${result.total} hàng`
          : `AI đã viết lại ${result.successCount} hàng`,
        result.failureCount ? 'warning' : 'success'
      );
    } catch (error) {
      if (status) {
        status.className = 'ai-rewrite-status-box error';
        status.textContent = error.message;
      }
      if (button) {
        button.disabled = false;
        button.innerHTML = '✦ Viết lại nội dung';
      }
      showToast(`Viết lại nội dung thất bại: ${error.message}`, 'error');
    }
  }

  // ============================================
  // AI Image Generation
  // ============================================
  function renderAiImageModal() {
    if (!aiImageModalState) return;
    const existingCount = aiImageModalState.rows.filter(row => row.imagePath).length;
    const imageProviders = ['chatgpt', 'kira'];
    const providerCards = imageProviders.map(provider => {
      const value = aiImageModalState.settings.providers?.[provider] || {};
      const configured = provider === 'chatgpt'
        ? value.configured !== false
        : Boolean(value.hasApiKey && value.imageModel);
      return `
        <button type="button"
                class="ai-rewrite-provider ${aiImageModalState.provider === provider ? 'active' : ''} ${configured ? '' : 'not-configured'}"
                data-ai-image-provider="${provider}"
                onclick="DataManager._selectAiImageProvider('${provider}')">
          <span class="ai-rewrite-provider-icon">${provider === 'kira' ? '◆' : '◉'}</span>
          <span>
            <b>${aiProviderLabel(provider)}</b>
            <small>${configured ? escapeHtml(provider === 'kira' ? value.imageModel : 'ChatGPT Image') : 'Chưa cấu hình'}</small>
          </span>
          <i class="${configured ? 'ready' : ''}"></i>
        </button>
      `;
    }).join('');
    const providerConfig = aiImageModalState.settings.providers?.[aiImageModalState.provider] || {};
    const providerReady = aiImageModalState.provider === 'chatgpt'
      ? providerConfig.configured !== false
      : Boolean(providerConfig.hasApiKey && providerConfig.imageModel);
    const isKira = aiImageModalState.provider === 'kira';
    showModal(
      'Tạo ảnh bằng AI',
      `
        <div class="ai-rewrite-summary">
          <span class="ai-rewrite-count">${aiImageModalState.rows.length}</span>
          <div>
            <b>hàng đã chọn</b>
            <small>Ảnh thành công được lưu vào cột Media để đăng bài.</small>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Chọn dịch vụ tạo ảnh</label>
          <div class="ai-image-provider-grid">${providerCards}</div>
        </div>
        <div class="ai-chatgpt-local-card">
          <div>
            <strong>${isKira ? 'Kira AI Image API' : 'ChatGPT trong app OpenAI'}</strong>
            <p>${isKira
              ? `Model ${escapeHtml(providerConfig.imageModel || 'chưa cấu hình')} · tỷ lệ ${escapeHtml(providerConfig.aspectRatio || '1:1')}. Ảnh Base64 được lưu thành file và cập nhật Media.`
              : 'Dùng Codex CLI đã đăng nhập bằng ChatGPT, không cần API key và tự chọn model tạo ảnh.'}</p>
          </div>
          <span class="ai-local-model">${isKira ? 'Kira Image' : 'ChatGPT Image'}</span>
        </div>
        <div class="form-group">
          <div class="ai-prompt-label">
            <label class="form-label" for="ai-image-prompt">Prompt tạo ảnh</label>
            <button type="button" class="btn btn-ghost btn-sm" onclick="DataManager._resetAiImagePrompt()">
              Khôi phục mặc định
            </button>
          </div>
          <textarea class="form-textarea ai-rewrite-prompt" id="ai-image-prompt"
                    maxlength="12000" rows="8"
                    placeholder="Mô tả ảnh cần tạo...">${escapeHtml(aiImageModalState.prompt)}</textarea>
          <div class="ai-prompt-meta">
            <span>Hỗ trợ <code>{{content}}</code> và <code>{{platform}}</code></span>
            <span>Tối đa 20 hàng mỗi lượt</span>
          </div>
        </div>
        <div class="ai-image-options">
          <div class="ai-image-option-list">
            <label>
              <input type="checkbox" id="ai-image-reference"
                     ${aiImageModalState.useReference ? 'checked' : ''}>
              Dùng Media hiện tại làm ảnh tham chiếu
            </label>
            <label>
              <input type="checkbox" id="ai-image-overwrite" ${aiImageModalState.overwrite ? 'checked' : ''}>
              Ghi đè Media đã có (khi không dùng ảnh tham chiếu)
            </label>
          </div>
          <span>${existingCount ? `${existingCount} hàng đang có Media` : 'Tất cả hàng đang trống Media'}</span>
        </div>
        <div class="ai-reference-note">
          ${isKira
            ? 'Kira sẽ chuyển ảnh Media thành Base64, dùng model text phân tích ảnh cùng prompt, rồi chuyển prompt chi tiết sang model ảnh để tạo ảnh mới.'
            : 'Chế độ tham chiếu sẽ kết hợp ảnh trong Media với prompt để tạo ảnh mới. Chỉ sau khi ảnh mới hợp lệ, đường dẫn Media cũ mới được thay; hàng thiếu ảnh hoặc dùng video sẽ giữ nguyên.'}
        </div>
        <div class="ai-image-progress" id="ai-image-progress"><span></span></div>
        <div class="ai-rewrite-status-box" id="ai-image-status">
          ${providerReady
            ? `Sẵn sàng tạo ảnh bằng ${aiProviderLabel(aiImageModalState.provider)}. Hàng lỗi hoặc bị bỏ qua sẽ giữ nguyên Media cũ.`
            : `${aiProviderLabel(aiImageModalState.provider)} chưa được cấu hình trong Cài đặt chung.`}
        </div>
      `,
      `
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Đóng</button>
        <button type="button" class="btn btn-primary" id="ai-image-run-btn"
                onclick="DataManager._confirmAiImage()" ${providerReady ? '' : 'disabled'}>
          ✦ Tạo ảnh và cập nhật Media
        </button>
      `
    );
    document.getElementById('modal')?.classList.add('modal-wide');
  }

  async function showAiImageModal() {
    if (!gridApi) return;
    if (aiImageModalState?.jobId) {
      showToast('AI vẫn đang tạo ảnh. Hãy chờ job hiện tại hoàn tất.', 'info');
      return;
    }
    const rows = gridApi.getSelectedRows().filter(row => row && row.id);
    if (!rows.length) {
      showToast('Hãy chọn ít nhất một hàng để tạo ảnh bằng AI', 'warning');
      return;
    }
    if (rows.length > 20) {
      showToast('Mỗi lượt chỉ tạo ảnh tối đa 20 hàng', 'warning');
      return;
    }
    try {
      const response = await apiSilent('/api/ai/settings');
      const settings = response.data || {};
      const kiraReady = Boolean(settings.providers?.kira?.hasApiKey && settings.providers?.kira?.imageModel);
      let provider = settings.activeImageProvider || 'chatgpt';
      if (provider === 'kira' && !kiraReady) provider = 'chatgpt';
      aiImageModalState = {
        rows: rows.map(row => ({
          id: row.id,
          content: row.content || '',
          imagePath: row.image_path || '',
        })),
        prompt: settings.imagePrompt || settings.defaultImagePrompt || '',
        defaultPrompt: settings.defaultImagePrompt || '',
        settings,
        provider,
        overwrite: false,
        useReference: false,
        jobId: '',
        applied: new Map(),
      };
      renderAiImageModal();
    } catch (error) {
      showToast(`Không tải được cấu hình tạo ảnh: ${error.message}`, 'error');
    }
  }

  function selectAiImageProvider(provider) {
    if (!aiImageModalState || !['chatgpt', 'kira'].includes(provider)) return;
    const prompt = document.getElementById('ai-image-prompt')?.value;
    if (prompt != null) aiImageModalState.prompt = prompt;
    aiImageModalState.overwrite = Boolean(document.getElementById('ai-image-overwrite')?.checked);
    aiImageModalState.useReference = Boolean(document.getElementById('ai-image-reference')?.checked);
    aiImageModalState.provider = provider;
    renderAiImageModal();
  }

  function resetAiImagePrompt() {
    if (!aiImageModalState) return;
    const input = document.getElementById('ai-image-prompt');
    aiImageModalState.prompt = aiImageModalState.defaultPrompt || '';
    if (input) {
      input.value = aiImageModalState.prompt;
      input.focus();
    }
  }

  function applyAiImageResults(job) {
    if (!aiImageModalState || !gridApi) return;
    for (const item of job.results || []) {
      if (!item.success || aiImageModalState.applied.has(item.id)) continue;
      const node = gridApi.getRowNode(String(item.id));
      if (node) {
        node.data.image_path = item.imagePath;
        gridApi.refreshCells({ rowNodes: [node], columns: ['image_path'], force: true });
      }
      aiImageModalState.applied.set(item.id, {
        rowId: item.id,
        oldValue: item.oldImagePath || '',
        newValue: item.imagePath,
      });
    }
  }

  function updateAiImageProgress(job) {
    const progress = document.querySelector('#ai-image-progress > span');
    const status = document.getElementById('ai-image-status');
    const percent = job.total ? Math.round((job.completed / job.total) * 100) : 0;
    if (progress) progress.style.width = `${percent}%`;
    if (!status) return;
    status.className = 'ai-rewrite-status-box running';
    status.innerHTML = `<span class="sync-loader"></span> Đã xử lý ${job.completed}/${job.total} hàng · ${job.successCount} ảnh thành công`;
  }

  async function pollAiImageJob(jobId) {
    while (aiImageModalState?.jobId === jobId) {
      const response = await apiSilent(`/api/ai/images/${encodeURIComponent(jobId)}`);
      const job = response.data;
      applyAiImageResults(job);
      updateAiImageProgress(job);
      if (['completed', 'partial', 'failed'].includes(job.status)) {
        const cells = [...aiImageModalState.applied.values()];
        if (cells.length) pushUndo({ type: 'aiImage', cells });
        const status = document.getElementById('ai-image-status');
        if (status) {
          status.className = `ai-rewrite-status-box ${job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'partial'}`;
          status.innerHTML = `Hoàn tất: ${job.successCount} ảnh thành công`
            + `${job.skippedCount ? ` · ${job.skippedCount} bỏ qua` : ''}`
            + `${job.failureCount ? ` · ${job.failureCount} lỗi` : ''}`;
          const errors = (job.results || []).filter(item => !item.success);
          if (errors.length) {
            status.innerHTML += `<div class="ai-rewrite-errors">${errors.slice(0, 5).map(item =>
              `#${item.id}: ${escapeHtml(item.error || 'Không tạo được ảnh')}`
            ).join('<br>')}</div>`;
          }
        }
        const footer = document.getElementById('modal-footer');
        if (footer) footer.innerHTML = '<button type="button" class="btn btn-primary" onclick="closeModal()">Hoàn tất</button>';
        updateFooter();
        showToast(
          job.successCount
            ? `${aiProviderLabel(job.provider)} đã tạo ${job.successCount} ảnh và cập nhật Media`
            : 'Không có ảnh nào được tạo',
          job.successCount ? (job.failureCount || job.skippedCount ? 'warning' : 'success') : 'error'
        );
        aiImageModalState.jobId = '';
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async function confirmAiImage() {
    if (!aiImageModalState || aiImageModalState.jobId) return;
    const promptInput = document.getElementById('ai-image-prompt');
    const prompt = promptInput?.value.trim() || '';
    if (!prompt) {
      showToast('Prompt tạo ảnh không được để trống', 'warning');
      promptInput?.focus();
      return;
    }
    aiImageModalState.prompt = prompt;
    aiImageModalState.overwrite = Boolean(document.getElementById('ai-image-overwrite')?.checked);
    aiImageModalState.useReference = Boolean(document.getElementById('ai-image-reference')?.checked);
    const button = document.getElementById('ai-image-run-btn');
    const status = document.getElementById('ai-image-status');
    if (button) {
      button.disabled = true;
      button.textContent = `Đang kiểm tra ${aiProviderLabel(aiImageModalState.provider)}...`;
    }
    if (status) {
      status.className = 'ai-rewrite-status-box running';
      status.innerHTML = `<span class="sync-loader"></span> Đang kiểm tra ${aiProviderLabel(aiImageModalState.provider)}...`;
    }

    try {
      const response = await apiSilent('/api/ai/images', {
        method: 'POST',
        body: {
          provider: aiImageModalState.provider,
          prompt,
          overwrite: aiImageModalState.overwrite,
          useReference: aiImageModalState.useReference,
          postIds: aiImageModalState.rows.map(row => row.id),
        },
      });
      aiImageModalState.jobId = response.data.id;
      if (button) button.textContent = `${aiProviderLabel(aiImageModalState.provider)} đang tạo ảnh...`;
      await pollAiImageJob(response.data.id);
    } catch (error) {
      if (status) {
        status.className = 'ai-rewrite-status-box error';
        status.textContent = error.message;
      }
      if (button) {
        button.disabled = false;
        button.innerHTML = '✦ Tạo ảnh và cập nhật Media';
      }
      aiImageModalState.jobId = '';
      showToast(`Tạo ảnh thất bại: ${error.message}`, 'error');
    }
  }

  // ============================================
  // Add Custom Column
  // ============================================
  function showAddColumnModal() {
    const bodyHtml = `
      <div class="form-group">
        <label class="form-label">Loại cột</label>
        <select class="form-select" id="col-type" onchange="DataManager._toggleAddColumnType()">
          ${App.currentPlatform === 'facebook' && !customColByVar('post_group')
            ? '<option value="post_group_preset">Facebook Group (Post_group)</option>'
            : ''}
          <option value="text">📝 Văn bản (Text)</option>
          <option value="file">📁 Đường dẫn file (File Path)</option>
          <option value="number">🔢 Số (Number)</option>
          <option value="select">📋 Chọn (Select)</option>
          <option value="comment_group">💬 Bình luận (tự tạo 4 cột)</option>
        </select>
      </div>
      <div class="form-group" id="col-name-group">
        <label class="form-label">Tên cột</label>
        <input type="text" class="form-input" id="col-name" placeholder="Ví dụ: Hashtag, Ghi chú 2..." autofocus>
      </div>
      <div id="comment-group-preview" style="display:none;margin:4px 0 12px;padding:12px 14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:var(--radius-sm);font-size:12px;color:var(--text-secondary);line-height:1.8;">
        Hệ thống tự đếm số tiếp theo và tạo đủ:
        <b>Bình luận N</b> · <b>Media bình luận N</b> ·
        <b>Thời gian bình luận N</b> · <b>Trạng thái bình luận N</b>
      </div>
      <div id="post-group-preview" style="display:none;margin:4px 0 12px;padding:12px 14px;background:var(--bg-input);border:1px solid var(--border-color);border-radius:var(--radius-sm);font-size:12px;color:var(--text-secondary);line-height:1.8;">
        Tạo cột <b>Post_group</b> với biến chính xác <code>post_group</code>.
        Group là đích đăng; Link Fanpage chỉ là danh tính đăng bài.
      </div>
      <div style="margin-top:4px;padding:10px 14px;background:var(--bg-input);border-radius:var(--radius-sm);font-size:12px;color:var(--text-muted);">
        <div style="margin-bottom:4px;font-weight:600;color:var(--text-secondary);">Loại cột:</div>
        <div>📝 <b>Văn bản</b> — Nhập text tự do, tự xuống dòng</div>
        <div>📁 <b>File Path</b> — Đường dẫn file, có nút chọn file</div>
        <div>🔢 <b>Số</b> — Chỉ nhập số</div>
        <div>📋 <b>Select</b> — Chọn từ danh sách</div>
        <div>💬 <b>Bình luận</b> — Thêm trọn nhóm 4 cột theo số thứ tự</div>
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

  function _toggleAddColumnType() {
    const type = document.getElementById('col-type')?.value;
    const nameGroup = document.getElementById('col-name-group');
    const preview = document.getElementById('comment-group-preview');
    const groupPreview = document.getElementById('post-group-preview');
    const isPreset = type === 'comment_group' || type === 'post_group_preset';
    if (nameGroup) nameGroup.style.display = isPreset ? 'none' : '';
    if (preview) preview.style.display = type === 'comment_group' ? 'block' : 'none';
    if (groupPreview) groupPreview.style.display = type === 'post_group_preset' ? 'block' : 'none';
  }

  async function _confirmAddColumn() {
    const name = document.getElementById('col-name')?.value.trim() || '';
    const colType = document.getElementById('col-type').value;
    if (!['comment_group', 'post_group_preset'].includes(colType) && !name) {
      showToast('Vui lòng nhập tên cột', 'warning');
      return;
    }
    closeModal();
    try {
      const result = colType === 'comment_group'
        ? await apiSilent('/api/data/columns/comment-group', { method: 'POST' })
        : await apiSilent('/api/data/columns', {
          method: 'POST',
          body: colType === 'post_group_preset'
            ? { name: 'Post_group', col_type: 'text', var_key: 'post_group' }
            : { name, col_type: colType },
        });
      if (result.success) {
        const added = colType === 'comment_group' ? result.data.columns : [result.data];
        customColumns.push(...added);
        gridApi.setGridOption('columnDefs', buildColumnDefs());
        gridApi.forEachNode(node => {
          if (!node.data) return;
          added.forEach(column => { node.data[`custom_${column.id}`] = ''; });
        });
        gridApi.refreshCells({ force: true });
        showToast(
          colType === 'comment_group'
            ? `Đã thêm nhóm Bình luận ${result.data.sequence} gồm 4 cột`
            : `Đã thêm cột "${name}"`,
          'success'
        );
      }
    } catch (err) {
      showToast('Loi them cot: ' + err.message, 'error');
    }
  }

  // Column management intentionally exposes only add and delete.
  function showManageColumnsModal() {
    showDeleteColumnModal();
  }

  async function _deleteColumn(colId, colName) {
    const column = customColumns.find(item => item.id === colId);
    if (!column || isProtectedCustomColumn(column) || parseCommentVarKey(column.var_key || slugVar(column.name))) {
      showToast('Cột mặc định hoặc cột thuộc nhóm bình luận không thể xóa riêng', 'warning');
      return;
    }
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
      if (customColumns.some(item =>
        !isProtectedCustomColumn(item)
        && !parseCommentVarKey(item.var_key || slugVar(item.name))
      ) || commentSequences().length) showDeleteColumnModal();
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
            await apiSilent(dataApiPath(`/api/data/${action.rowId}`), { method: 'PUT', body: { [action.field]: action.oldValue } });
          }
        }
        break;
      }
      case 'addRow': {
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'DELETE', body: { ids: [action.rowId] } });
        const node = gridApi.getRowNode(String(action.rowId));
        if (node) gridApi.applyTransaction({ remove: [node.data] });
        updateFooter();
        break;
      }
      case 'deleteRows': {
        await apiSilent(dataApiPath('/api/data/restore'), { method: 'POST', body: { rows: action.rows } });
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
            await apiSilent(dataApiPath(`/api/data/${cell.rowId}`), { method: 'PUT', body: { [cell.field]: cell.oldValue } });
          }
        }
        break;
      }
      case 'aiRewrite': {
        const updates = action.cells.map(cell => ({ id: cell.rowId, content: cell.oldValue }));
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates } });
        for (const cell of action.cells) {
          const node = gridApi.getRowNode(String(cell.rowId));
          if (node) {
            node.data.content = cell.oldValue;
            gridApi.refreshCells({ rowNodes: [node], columns: ['content'], force: true });
          }
        }
        break;
      }
      case 'aiImage': {
        const updates = action.cells.map(cell => ({ id: cell.rowId, image_path: cell.oldValue }));
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates } });
        for (const cell of action.cells) {
          const node = gridApi.getRowNode(String(cell.rowId));
          if (node) {
            node.data.image_path = cell.oldValue;
            gridApi.refreshCells({ rowNodes: [node], columns: ['image_path'], force: true });
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
            await apiSilent(dataApiPath(`/api/data/${action.rowId}`), { method: 'PUT', body: { [action.field]: action.newValue } });
          }
        }
        break;
      }
      case 'addRow': {
        const result = await apiSilent(dataApiPath('/api/data'), {
          method: 'POST',
          body: { content: '', status: 'pending', data_mode: dataModeValue() },
        });
        if (result.success) {
          action.rowId = result.data.id;
          gridApi.applyTransaction({ add: [result.data] });
          updateFooter();
        }
        break;
      }
      case 'deleteRows': {
        const ids = action.rows.map(r => r.id);
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'DELETE', body: { ids } });
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
            await apiSilent(dataApiPath(`/api/data/${cell.rowId}`), { method: 'PUT', body: { [cell.field]: newVal } });
          }
        }
        break;
      }
      case 'aiRewrite': {
        const updates = action.cells.map(cell => ({ id: cell.rowId, content: cell.newValue }));
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates } });
        for (const cell of action.cells) {
          const node = gridApi.getRowNode(String(cell.rowId));
          if (node) {
            node.data.content = cell.newValue;
            gridApi.refreshCells({ rowNodes: [node], columns: ['content'], force: true });
          }
        }
        break;
      }
      case 'aiImage': {
        const updates = action.cells.map(cell => ({ id: cell.rowId, image_path: cell.newValue }));
        await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates } });
        for (const cell of action.cells) {
          const node = gridApi.getRowNode(String(cell.rowId));
          if (node) {
            node.data.image_path = cell.newValue;
            gridApi.refreshCells({ rowNodes: [node], columns: ['image_path'], force: true });
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
        const parsedCommentField = parseCommentVarKey(col.var_key || slugVar(col.name));
        if (parsedCommentField?.base === 'comment_status') continue;
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
      await apiSilent(dataApiPath('/api/data/bulk'), { method: 'PUT', body: { updates } });
      for (const cu of customUpdates) {
        await apiSilent('/api/data/custom-data', { method: 'PUT', body: cu });
      }
      showToast('Da luu tat ca du lieu', 'success');
    } catch (err) {
      showToast('Loi luu du lieu: ' + err.message, 'error');
    }
  }

  function showDeleteColumnModal() {
    const groups = commentSequences();
    const columns = customColumns.filter(column =>
      !isProtectedCustomColumn(column)
      && !parseCommentVarKey(column.var_key || slugVar(column.name))
    );
    if (!groups.length && !columns.length) {
      showToast('Chưa có cột người dùng hoặc nhóm bình luận có thể xóa', 'info');
      return;
    }

    const groupRows = groups.map(sequence => `
      <div class="schedule-item" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:650;">Nhóm Bình luận ${sequence}</div>
          <div style="font-size:12px;color:var(--text-muted);">4 cột · Nội dung, media, thời gian, trạng thái</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:var(--error);" onclick="DataManager._deleteCommentGroup(${sequence})">Xóa nhóm</button>
      </div>
    `).join('');
    const columnRows = columns.map(column => `
      <div class="schedule-item" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:650;">${escapeHtml(column.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">Cột người dùng</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:var(--error);" onclick="DataManager._deleteColumn(${column.id}, '${escapeHtml(column.name)}')">Xóa</button>
      </div>
    `).join('');
    const bodyHtml = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
        Cột mặc định được khóa và không thể sửa hoặc xóa. Nhóm bình luận luôn được xóa trọn 4 cột.
      </div>
      <div class="schedule-list">${groupRows}${columnRows}</div>
    `;
    showModal(
      'Xóa cột',
      bodyHtml,
      `<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>`
    );
  }

  async function _deleteCommentGroup(sequence) {
    const confirmed = await showConfirm(
      'Xóa nhóm bình luận',
      `Xóa cả 4 cột của Bình luận ${sequence}? Toàn bộ dữ liệu trong nhóm sẽ bị xóa.`
    );
    if (!confirmed) return;
    try {
      await apiSilent(`/api/data/columns/comment-group/${sequence}`, { method: 'DELETE' });
      customColumns = customColumns.filter(column => {
        const parsed = parseCommentVarKey(column.var_key || slugVar(column.name));
        return !parsed || parsed.sequence !== Number(sequence);
      });
      gridApi.setGridOption('columnDefs', buildColumnDefs());
      gridApi.refreshCells({ force: true });
      showToast(`Đã xóa nhóm Bình luận ${sequence}`, 'success');
      showDeleteColumnModal();
    } catch (err) {
      showToast('Không thể xóa nhóm bình luận: ' + err.message, 'error');
    }
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
            <input type="text" class="form-input" id="fldname-${f.field}" value="${escapeHtml(label)}" readonly title="Cột mặc định không thể đổi tên" style="height:32px;padding:4px 8px;width:100%;min-width:0;opacity:.75;">
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
      const locked = isSystemWorkflowColumn(col);
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border-color);">
            <input type="text" class="form-input" id="varname-${col.id}" value="${escapeHtml(col.name)}" ${locked ? 'readonly' : ''} style="height:32px;padding:4px 8px;width:100%;min-width:0;${locked ? 'opacity:.75;' : ''}">
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border-color);">
            <div style="display:flex;gap:6px;align-items:center;">
              <input type="text" class="form-input" id="varkey-${col.id}" value="${escapeHtml(key)}" placeholder="ten_bien" ${locked ? 'readonly' : ''} style="height:32px;padding:4px 8px;flex:1;min-width:0;font-family:monospace;${locked ? 'opacity:.75;' : ''}">
              ${locked ? '' : `<button class="btn btn-primary btn-sm" onclick="DataManager._saveCustomVar(${col.id})" title="Lưu">💾</button>`}
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
      const result = await apiSilent(dataApiPath('/api/data/import-sheet'), {
        method: 'POST',
        body: { rows: sheets[idx].data },
      });
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
    window.open(platformApiUrl(dataApiPath('/api/data/export-excel')), '_blank');
  }

  async function showGoogleSheetsSyncModal() {
    try {
      const settings = await api('/api/google-sheets/settings');
      if (!settings.data?.hasCredentials || !settings.data?.spreadsheetId) {
        showModal(
          'Google Sheets chưa được cấu hình',
          `<div class="google-sheet-empty">
             <span>☁</span>
             <strong>Kết nối Google Sheets trong Cài đặt chung</strong>
             <p>Chọn JSON Service Account, dán link Sheet và kiểm tra kết nối trước khi đồng bộ.</p>
           </div>`,
          `<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>
           <button class="btn btn-primary" onclick="closeModal();App.navigateTo('settings')">Mở Cài đặt</button>`
        );
        return;
      }
      const selectedRows = gridApi ? gridApi.getSelectedRows().filter(row => row && row.id) : [];
      const count = selectedRows.length;
      const label = App.platformLabel();
      const scopeText = count
        ? `${count} hàng đang chọn`
        : 'Toàn bộ hàng trong bảng hiện tại';
      showModal(
        `Đồng bộ Google Sheets · ${label}`,
        `<div class="google-sheet-sync-modal">
           <div class="google-sheet-sync-hero">
             <span>☁</span>
             <div>
               <small>PHẠM VI ĐỒNG BỘ</small>
               <strong>${scopeText}</strong>
               <p>Dữ liệu được ghi vào tab ${label}. Đồng bộ tự động không thực hiện xóa.</p>
             </div>
           </div>
           <div class="google-sheet-sync-options">
             <button type="button" onclick="DataManager._runGoogleSheetsSync('push')">
               <span class="is-add">＋</span>
               <div><strong>Thêm / Cập nhật</strong><small>${count ? 'Đẩy các hàng đã chọn lên Sheet' : 'Đẩy toàn bộ bảng lên Sheet'}</small></div>
             </button>
             <button type="button" onclick="DataManager._runGoogleSheetsSync('pull')">
               <span class="is-pull">↓</span>
               <div><strong>Lấy dữ liệu về Tool</strong><small>Nhận hàng mới và cập nhật từ tab ${label}</small></div>
             </button>
             <button type="button" class="is-delete-option" ${count ? '' : 'disabled'}
                     onclick="DataManager._runGoogleSheetsSync('delete')">
               <span>−</span>
               <div><strong>Xóa khỏi Google Sheets</strong><small>${count ? `Chỉ xóa ${count} hàng đã chọn, không xóa trong tool` : 'Hãy tích chọn hàng cần xóa trước'}</small></div>
             </button>
           </div>
         </div>`,
        '<button class="btn btn-secondary" onclick="closeModal()">Đóng</button>'
      );
    } catch (error) {}
  }

  async function runGoogleSheetsSync(action) {
    const selectedRows = gridApi ? gridApi.getSelectedRows().filter(row => row && row.id) : [];
    const ids = selectedRows.map(row => row.id);
    if (action === 'delete') {
      if (!ids.length) {
        showToast('Hãy chọn hàng cần xóa khỏi Google Sheets', 'warning');
        return;
      }
      if (!confirm(`Xóa ${ids.length} hàng đã chọn khỏi Google Sheets? Dữ liệu trong tool vẫn được giữ nguyên.`)) {
        return;
      }
    }
    closeModal();
    const actionLabels = {
      push: 'Đang thêm/cập nhật Google Sheets...',
      pull: 'Đang lấy dữ liệu từ Google Sheets...',
      delete: 'Đang xóa hàng đã chọn khỏi Google Sheets...',
    };
    try {
      showToast(actionLabels[action] || 'Đang đồng bộ Google Sheets...', 'info');
      const result = await api('/api/google-sheets/sync', {
        method: 'POST',
        body: {
          action,
          platform: App.currentPlatform,
          ids: action === 'pull' ? null : ids,
        },
      });
      const data = result.data || {};
      if (action === 'delete') {
        showToast(`Đã xóa ${data.deleted || 0} hàng khỏi Google Sheets`, 'success');
      } else {
        showToast(
          `Đồng bộ thành công · thêm ${data.added || 0}, cập nhật ${data.updated || 0}`,
          'success'
        );
      }
      if (action === 'pull') await load();
    } catch (error) {}
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
    get gridApi() { return gridApi; },
    load,
    getViewMode,
    setViewMode,
    applyPostResult,
    addRow,
    deleteSelected,
    importExcel,
    exportExcel,
    showGoogleSheetsSyncModal,
    showAddColumnModal,
    showDeleteColumnModal,
    showManageColumnsModal,
    showVariableMappingModal,
    showProfilePicker,
    mapManagedTargets,
    applyManagedTargets,
    openManagedTargetScan,
    backToManagedTargetPicker,
    toggleManagedTargetScan,
    runManagedTargetScan,
    viewManagedTargetResult,
    toggleManagedTargetResult,
    copyManagedTargetsSelected,
    copyText,
    showAiRewriteModal,
    showAiImageModal,
    fillDownSelection,
    undo,
    redo,
    saveData,
    _confirmAddColumn,
    _toggleAddColumnType,
    _deleteColumn,
    _deleteCommentGroup,
    _saveCustomVar,
    _saveBuiltinVar,
    _selectImportTab,
    _confirmImport,
    _runGoogleSheetsSync: runGoogleSheetsSync,
    _verifyCustomPassword,
    _switchSyncTab,
    _previewColumnSync,
    _executeColumnSync,
    _saveAutoSyncRules,
    _undoSyncRun,
    _selectAiRewriteProvider: selectAiRewriteProvider,
    _resetAiPrompt: resetAiPrompt,
    _confirmAiRewrite: confirmAiRewrite,
    _resetAiImagePrompt: resetAiImagePrompt,
    _selectAiImageProvider: selectAiImageProvider,
    _confirmAiImage: confirmAiImage,
  };
})();
