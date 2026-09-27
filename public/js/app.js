/**
 * Super Post - King - Main App Logic
 * Navigation, Toast, Modal, Utilities
 */

// ============================================
// Navigation
// ============================================
const App = {
  currentPage: 'dashboard',
  currentPlatform: 'facebook',
  platforms: ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'],
  platformLabels: {
    facebook: 'Facebook',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    threads: 'Threads',
    instagram: 'Instagram',
    x: 'X',
    zalovideo: 'Zalo Video',
  },
  workspacePages: ['data', 'postcfg'],

  platformLabel(platform = this.currentPlatform) {
    return this.platformLabels[platform] || 'Facebook';
  },

  init() {
    this.initTheme();
    this.setupNavigation();
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.toolbar-group')) this.closeToolbarGroups();
    });
    this.navigateTo('dashboard');
  },

  toggleToolbarGroup(event, trigger) {
    event.stopPropagation();
    const group = trigger.closest('.toolbar-group');
    const wasOpen = group.classList.contains('open');
    this.closeToolbarGroups();
    if (!wasOpen) group.classList.add('open');
  },

  closeToolbarGroups() {
    document.querySelectorAll('.toolbar-group.open').forEach(g => g.classList.remove('open'));
  },

  // --- Theme (light default / dark) ---
  initTheme() {
    let theme = 'light';
    try { theme = localStorage.getItem('covergem-theme') || 'light'; } catch (e) {}
    this.setTheme(theme === 'dark' ? 'dark' : 'light');
  },

  setTheme(theme) {
    theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('covergem-theme', theme); } catch (e) {}
    document.querySelectorAll('#theme-toggle button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeVal === theme);
    });
    // AG Grid cần vẽ lại để cập nhật màu theme
    try {
      if (typeof DataManager !== 'undefined' && DataManager.refreshTheme) {
        DataManager.refreshTheme();
      }
    } catch (e) {}
  },

  setupNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        this.navigateTo(page, item.dataset.platform);
      });
    });
  },

  navigateTo(page, platform = null) {
    if (this.platforms.includes(platform)) {
      this.currentPlatform = platform;
    }
    this.currentPage = page;
    const isWorkspacePage = this.workspacePages.includes(page);

    // Update sidebar active state
    document.querySelectorAll('.nav-item').forEach(item => {
      const target = item.dataset.page;
      const isWorkspaceRoot = isWorkspacePage && target === 'data';
      const platformMatches = !item.dataset.platform || item.dataset.platform === this.currentPlatform;
      item.classList.toggle('active', platformMatches && (target === page || isWorkspaceRoot));
    });

    // Update workspace tabs
    const workspaceTabs = document.getElementById('workspace-tabs');
    if (workspaceTabs) {
      workspaceTabs.style.display = isWorkspacePage ? 'flex' : 'none';
      workspaceTabs.querySelectorAll('.workspace-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.page === page);
      });
    }

    // Update page visibility
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === `page-${page}`);
    });

    // Update header
    const titles = {
      dashboard: 'Dashboard',
      data: 'Quản lý Dữ liệu',
      browsers: 'Quản lý Trình duyệt',
      runner: 'Chạy Tác vụ',
      scheduler: 'Hẹn giờ Đăng bài',
      postcfg: 'Cấu hình đăng bài',
      settings: 'Cài đặt'
    };
    const workspaceTitles = {
      data: 'Bảng dữ liệu',
      browsers: 'Trình duyệt',
      runner: 'Log chạy',
      scheduler: 'Hẹn giờ',
      postcfg: 'Cấu hình',
    };
    const baseTitle = workspaceTitles[page] || titles[page] || page;
    document.getElementById('page-title').textContent = isWorkspacePage
      ? `${baseTitle} · ${this.platformLabel()}`
      : baseTitle;

    // Update page actions
    this.updatePageActions(page);

    // Trigger page load
    this.loadPage(page);
  },

  updatePageActions(page) {
    const container = document.getElementById('page-actions');
    container.innerHTML = '';

    switch (page) {
      case 'data':
        const dataView = (typeof DataManager !== 'undefined' && DataManager.getViewMode)
          ? DataManager.getViewMode() : 'post';
        container.innerHTML = `
          <div class="data-toolbar" data-tour-id="data-toolbar">
            <div class="workspace-tabs data-view-switch">
              <button type="button"
                      class="workspace-tab${dataView === 'post' ? ' active' : ''}"
                      data-view-mode="post"
                      aria-pressed="${dataView === 'post'}"
                      onclick="DataManager.setViewMode('post')">
                <span class="data-view-indicator"></span>Đăng bài
              </button>
              <button type="button"
                      class="workspace-tab${dataView === 'comment' ? ' active' : ''}"
                      data-view-mode="comment"
                      aria-pressed="${dataView === 'comment'}"
                      onclick="DataManager.setViewMode('comment')">
                <span class="data-view-indicator"></span>Bình luận
              </button>
            </div>
            <span class="toolbar-sep"></span>
            <div class="toolbar-group" data-tour-id="data-import">
              <button type="button" class="btn btn-secondary btn-sm toolbar-group-trigger" onclick="App.toggleToolbarGroup(event, this)">📁 Dữ liệu</button>
              <div class="toolbar-group-menu">
                <button class="btn btn-secondary btn-sm" onclick="DataManager.importExcel()">📥 Import Excel</button>
                <button class="btn btn-secondary btn-sm" onclick="DataManager.exportExcel()">📤 Export Excel</button>
                <button class="btn btn-secondary btn-sm google-sheet-quick-button" data-tour-id="data-sync"
                        onclick="DataManager.showGoogleSheetsSyncModal()">☁ Google Sheet</button>
              </div>
            </div>
            <div class="toolbar-group">
              <button type="button" class="btn btn-secondary btn-sm toolbar-group-trigger" onclick="App.toggleToolbarGroup(event, this)">☰ Hàng</button>
              <div class="toolbar-group-menu">
                <button class="btn btn-secondary btn-sm" onclick="DataManager.addRow()">➕ Thêm hàng</button>
                <button class="btn btn-secondary btn-sm" onclick="DataManager.deleteSelected()">🗑 Xóa hàng</button>
                <button class="btn btn-secondary btn-sm" onclick="DataManager.fillDownSelection()">↓ Fill xuống</button>
              </div>
            </div>
            <div class="toolbar-group">
              <button type="button" class="btn btn-secondary btn-sm toolbar-group-trigger" onclick="App.toggleToolbarGroup(event, this)">🗂 Cột</button>
              <div class="toolbar-group-menu">
                <button class="btn btn-secondary btn-sm" onclick="DataManager.showAddColumnModal()">➕ Thêm cột</button>
                <button class="btn btn-secondary btn-sm" onclick="DataManager.showDeleteColumnModal()">🗑 Xóa cột</button>
                <button class="btn btn-secondary btn-sm" onclick="DataManager.showVariableMappingModal()">🔤 Biến</button>
              </div>
            </div>
            <span class="toolbar-sep"></span>
            <button class="btn btn-secondary btn-sm" data-tour-id="data-profile-map"
                    onclick="DataManager.showProfilePicker()">👤 Gán profile</button>
            <button class="btn btn-secondary btn-sm" data-tour-id="data-target-map"
                    onclick="DataManager.mapManagedTargets()">${this.currentPlatform === 'youtube' ? 'Kênh' : 'Fanpage'}</button>
            <span class="toolbar-sep"></span>
            <button class="btn btn-secondary btn-sm btn-icon-sm" title="Hoàn tác" onclick="DataManager.undo()">↶</button>
            <button class="btn btn-secondary btn-sm btn-icon-sm" title="Tiến tới" onclick="DataManager.redo()">↷</button>
            <span class="toolbar-sep"></span>
            <button class="btn btn-primary btn-sm" onclick="DataManager.saveData()">💾 Lưu dữ liệu</button>
            <button class="btn btn-automation btn-sm" data-tour-id="data-automation"
                    onclick="Automation.show()">▶ Tự động hóa</button>
          </div>
        `;
        break;
      case 'browsers':
        // Browser actions live in the page hero to avoid duplicate controls.
        container.innerHTML = '';
        break;
      case 'scheduler':
        container.innerHTML = `
          <button class="btn btn-secondary btn-sm" onclick="Scheduler.load()">Làm mới</button>
        `;
        break;
      case 'runner':
        container.innerHTML = '';
        break;
      case 'postcfg':
        container.innerHTML = `
          <button class="btn btn-primary btn-sm" onclick="PostConfig.save()">💾 Lưu cấu hình</button>
        `;
        break;
      case 'settings':
        container.innerHTML = '';
        break;
    }
  },

  loadPage(page) {
    switch (page) {
      case 'dashboard': Dashboard.load(); break;
      case 'data': DataManager.load(); break;
      case 'browsers': BrowserManager.load(); break;
      case 'runner': Runner.load(); break;
      case 'scheduler': Scheduler.load(); break;
      case 'postcfg': PostConfig.load(); break;
      case 'settings': Settings.load(); break;
    }
  }
};

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================
// Modal
// ============================================
function showModal(title, bodyHtml, footerHtml = '') {
  document.getElementById('modal').classList.remove('modal-wide', 'telegram-template-modal');
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-footer').innerHTML = footerHtml;
  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

// Close modal on overlay click or close button
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});
document.getElementById('modal-close').addEventListener('click', closeModal);

// ============================================
// Confirm Dialog
// ============================================
function showConfirm(title, message) {
  return new Promise((resolve) => {
    showModal(title,
      `<p style="color: var(--text-secondary); font-size: 14px;">${message}</p>`,
      `<button class="btn btn-secondary" onclick="closeModal(); window._confirmResolve(false)">Hủy</button>
       <button class="btn btn-danger" onclick="closeModal(); window._confirmResolve(true)">Xác nhận</button>`
    );
    window._confirmResolve = resolve;
  });
}

// ============================================
// API Helper
// ============================================
function platformApiUrl(url) {
  const parsed = new URL(url, location.origin);
  const scoped = ['/api/data', '/api/browsers', '/api/runner', '/api/schedules', '/api/ai'];
  const globalPageScopes = {
    browsers: '/api/browsers',
    scheduler: '/api/schedules',
    runner: '/api/runner',
  };
  const globalPrefix = globalPageScopes[App.currentPage];
  if (globalPrefix && parsed.pathname.startsWith(globalPrefix)) {
    if (!parsed.searchParams.has('platform')) parsed.searchParams.set('platform', 'all');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  if (!App.workspacePages.includes(App.currentPage)) return url;
  const isSettingsRoot = parsed.pathname === '/api/settings';
  if (!isSettingsRoot && !scoped.some(prefix => parsed.pathname.startsWith(prefix))) return url;
  if (!parsed.searchParams.has('platform')) parsed.searchParams.set('platform', App.currentPlatform);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function api(url, options = {}) {
  try {
    const res = await fetch(platformApiUrl(url), {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Loi khong xac dinh');
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

async function apiSilent(url, options = {}) {
  const res = await fetch(platformApiUrl(url), {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Loi khong xac dinh');
  return data;
}

// Upload helper (for file uploads - no JSON content type)
async function apiUpload(url, formData) {
  try {
    formData.set('platform', App.currentPlatform);
    const res = await fetch(platformApiUrl(url), { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi không xác định');
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// ============================================
// Utility
// ============================================
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusBadge(status) {
  const map = {
    pending: '<span class="badge badge-pending">⏳ Chờ</span>',
    scheduled: '<span class="badge badge-pending">🕒 Hẹn giờ</span>',
    running: '<span class="badge badge-running">🔄 Đang chạy</span>',
    success: '<span class="badge badge-success">✅ Thành công</span>',
    error: '<span class="badge badge-error">❌ Lỗi</span>',
    closed: '<span class="badge badge-closed">🔴 Đã đóng</span>',
    open: '<span class="badge badge-open">🟢 Đang mở</span>',
    waiting: '<span class="badge badge-pending">⏳ Đang chờ</span>',
    completed: '<span class="badge badge-success">✅ Hoàn tất</span>',
  };
  return map[status] || `<span class="badge badge-closed">${status}</span>`;
}

// ============================================
// WebSocket for realtime logs
// ============================================
let ws = null;
let wsReconnectTimer = null;

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/logs`);

  ws.onopen = () => {
    console.log('WebSocket connected');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (typeof Runner !== 'undefined' && Runner.onLogMessage) {
        Runner.onLogMessage(data);
      }
      if (data.type === 'agent_event' && typeof Settings !== 'undefined' && Settings.onAgentEvent) {
        Settings.onAgentEvent(data);
      }
      if (data.type === 'agent_event' && typeof Dashboard !== 'undefined' && Dashboard.onAgentEvent) {
        Dashboard.onAgentEvent(data);
      }
    } catch (e) { /* ignore parse errors */ }
  };

  ws.onclose = () => {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

// ============================================
// Initialize
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  connectWebSocket();
  if (typeof Updater !== 'undefined') Updater.init();
});
