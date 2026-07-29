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
    return def;
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
    if (npc) cols.push(customColDef(npc, { label: 'Tên Profile', editable: true, width: 150 }));

    // Nội dung
    cols.push({
      headerName: fieldLabel('content', 'Nội dung'), field: 'content',
      minWidth: 220, flex: 2, editable: true,
      cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true,
      cellEditorParams: { maxLength: 10000, rows: 10, cols: 60 },
      autoHeight: true, wrapText: true, cellClass: 'cell-wrap',
    });

    // Media (image_path)
    cols.push({
      headerName: 'Media', field: 'image_path',
      minWidth: 200, flex: 1, editable: true, autoHeight: true, wrapText: true,
      cellClass: 'cell-wrap', cellRenderer: imagePathRenderer,
      tooltipValueGetter: (p) => p.value || '',
    });

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

    const { data, colDef, newValue, oldValue } = event;
    if (newValue === oldValue) return;
    if (!data || !data.id) return;

    const field = colDef.field;
    if (!field || field === 'checkbox' || field === 'drag') return;

    pushUndo({ type: 'cellEdit', rowId: data.id, field, oldValue, newValue });

    if (field.startsWith('custom_')) {
      const colId = parseInt(field.replace('custom_', ''));
      try {
        await apiSilent('/api/data/custom-data', {
          method: 'PUT',
          body: { post_id: data.id, column_id: colId, value: newValue || '' },
        });
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
        body: { [field]: newValue },
      });
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
    syncRangeRowSelection();
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

  // Khi khoanh vùng, tự chọn (tít) luôn các hàng nằm trong vùng
  function syncRangeRowSelection() {
    if (!gridApi || !rangeState.active) return;
    const b = getRangeBounds();
    if (!b) return;
    gridApi.forEachNode((node) => {
      if (node.rowIndex == null) return;
      const inRange = node.rowIndex >= b.minRow && node.rowIndex <= b.maxRow;
      if (node.isSelected() !== inRange) node.setSelected(inRange);
    });
  }

  function onRangeMouseUp() {
    stopAutoScroll();
    if (!rangeState.isDragging) return;
    rangeState.isDragging = false;
    const gridDiv = document.getElementById('data-grid');
    if (gridDiv) gridDiv.classList.remove('range-dragging');
    if (rangeState.active) { syncRangeRowSelection(); updateRangeFooter(); }
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
  // Public Methods
  // ============================================

  // Tạo các cột hệ thống bắt buộc nếu chưa có
  async function ensureRequiredColumns() {
    const need = [
      { var_key: 'name_profile', name: 'name_profile' },
      { var_key: 'link_post', name: 'link_post' },
      { var_key: 'time_post', name: 'time_post' },
    ];
    let created = false;
    for (const n of need) {
      if (!customColByVar(n.var_key)) {
        try {
          await apiSilent('/api/data/columns', { method: 'POST', body: { name: n.name, col_type: 'text', var_key: n.var_key } });
          created = true;
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
    try {
      const colResult = await apiSilent('/api/data/columns');
      if (colResult.success) customColumns = colResult.data;
    } catch (e) { customColumns = []; }

    // Đảm bảo 3 cột hệ thống tồn tại: name_profile, link_post, time_post
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
            gridApi.startEditingCell({ rowIndex: rowNode.rowIndex, colKey: 'content' });
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
        image_path: node.data.image_path || '',
        link: node.data.link || '',
        target: node.data.target || '',
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
    const fixedRows = BUILTIN_FIELDS.map(f => {
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
        📌 Cột tự động map: Nội dung → content, Hình ảnh → image_path, Link → link, Nhóm/Trang → target
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
    window.open('/api/data/export-excel', '_blank');
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
  };
})();
