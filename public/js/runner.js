/**
 * Runner Module - Task Execution UI
 * Provides configuration panel, realtime log display, and progress tracking.
 */

const Runner = {
  profiles: [],
  pollTimer: null,
  isRunning: false,
  logEntries: [],

  /**
   * Load the runner page - fetch profiles and render UI
   */
  async load() {
    try {
      const res = await api('/api/browsers');
      this.profiles = res.data || [];
    } catch (e) {
      this.profiles = [];
    }

    this.renderLogStatus();

    // Check current status
    await this.fetchStatus();
  },

  renderLogStatus() {
    const container = document.getElementById('page-runner');
    if (!container) return;

    const entries = this.logEntries.length ? this.logEntries.slice(-120).map(data => {
      const timeStr = data.time ? new Date(data.time).toLocaleTimeString('vi-VN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }) : '';
      const profile = data.profile || 'Hệ thống';
      const messageClass = data.type && data.type !== 'info' ? ` ${data.type}` : '';
      return `
        <div class="log-entry">
          <span class="log-time">${timeStr}</span>
          <span class="log-profile">[${this._escapeHtml(profile)}]</span>
          <span class="log-message${messageClass}">${this._escapeHtml(data.message || '')}</span>
        </div>
      `;
    }).join('') : `
      <div class="text-muted text-sm" style="text-align:center;padding:40px 0">
        Chưa có log chạy. Khi bấm Tự động hoá ở tab Trình duyệt, trạng thái sẽ hiện tại đây.
      </div>
    `;

    container.innerHTML = `
      <div class="lux-panel runner-status-panel">
        <div class="lux-panel-title">
          <div>
            <div class="lux-title">Log trạng thái chạy</div>
            <div class="lux-subtitle">Theo dõi phiên chạy tự động hoá theo thời gian thực.</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="badge ${this.isRunning ? 'badge-running' : 'badge-closed'}" id="runner-live-status">${this.isRunning ? 'Đang chạy' : 'Đang nghỉ'}</span>
            <button class="btn btn-secondary btn-sm" onclick="Runner.clearLog()">Xóa log</button>
            <button class="btn btn-danger btn-sm" id="runner-stop-btn" onclick="Runner.stopRunner()" ${this.isRunning ? '' : 'disabled'}>Dừng</button>
          </div>
        </div>
        <div class="runner-log-summary">
          <div>
            <span class="text-sm text-muted">Tiến trình</span>
            <span class="text-sm font-semibold" id="runner-progress-text">0 / 0 (0%)</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" id="runner-progress-fill" style="width:0%"></div>
          </div>
        </div>
        <div class="runner-log runner-log-full" id="runner-log">${entries}</div>
      </div>
    `;
  },

  /**
   * Render the full runner layout
   */
  render() {
    const container = document.getElementById('page-runner');

    const profileChecklistHtml = this.profiles.length > 0
      ? this.profiles.map(p => `
        <label class="profile-check-item">
          <input type="checkbox" value="${p.id}" class="runner-profile-cb">
          <span style="flex:1">${this._escapeHtml(p.name)}</span>
          ${p.status === 'open'
            ? '<span class="badge badge-open">🟢 Mở</span>'
            : '<span class="badge badge-closed">🔴 Đóng</span>'
          }
        </label>
      `).join('')
      : '<div class="text-muted text-sm" style="padding:12px">Chưa có profile nào. Thêm profile trong tab Trình duyệt.</div>';

    container.innerHTML = `
      <div class="runner-layout">
        <!-- Left: Configuration -->
        <div class="runner-config">
          <div class="card">
            <div class="card-header">
              <h3 class="card-title">⚙️ Cấu hình chạy</h3>
              <div style="display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" onclick="Runner.selectAllProfiles()">Chọn tất cả</button>
                <button class="btn btn-ghost btn-sm" onclick="Runner.deselectAllProfiles()">Bỏ chọn</button>
              </div>
            </div>

            <!-- Profile Checklist -->
            <div class="form-group mb-16">
              <label class="form-label">Chọn Profile</label>
              <div class="profile-checklist" id="runner-profile-list">
                ${profileChecklistHtml}
              </div>
            </div>

            <!-- Concurrency -->
            <div class="form-group mb-16">
              <label class="form-label">Số profile chạy đồng thời</label>
              <input type="number" class="form-input" id="runner-concurrency" value="2" min="1" max="10" style="width:100px">
            </div>

            <!-- Delay between posts -->
            <div class="form-group mb-16">
              <label class="form-label">Delay giữa các bài (giây)</label>
              <div class="form-row">
                <div class="form-group">
                  <input type="number" class="form-input" id="runner-delay-min" value="30" min="0" placeholder="Min">
                  <span class="text-muted text-sm">Tối thiểu</span>
                </div>
                <div class="form-group">
                  <input type="number" class="form-input" id="runner-delay-max" value="90" min="0" placeholder="Max">
                  <span class="text-muted text-sm">Tối đa</span>
                </div>
              </div>
            </div>

            <!-- Delay between profiles -->
            <div class="form-group mb-16">
              <label class="form-label">Delay giữa các profile (giây)</label>
              <div class="form-row">
                <div class="form-group">
                  <input type="number" class="form-input" id="runner-profile-delay-min" value="10" min="0" placeholder="Min">
                  <span class="text-muted text-sm">Tối thiểu</span>
                </div>
                <div class="form-group">
                  <input type="number" class="form-input" id="runner-profile-delay-max" value="30" min="0" placeholder="Max">
                  <span class="text-muted text-sm">Tối đa</span>
                </div>
              </div>
            </div>

            <!-- Data Selection -->
            <div class="form-group mb-16">
              <label class="form-label">Chọn dữ liệu</label>
              <div style="display:flex;flex-direction:column;gap:8px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--text-secondary);font-size:13px">
                  <input type="radio" name="runner-data-mode" value="all" checked style="accent-color:var(--accent)">
                  Tất cả dữ liệu
                </label>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--text-secondary);font-size:13px">
                  <input type="radio" name="runner-data-mode" value="selected" style="accent-color:var(--accent)">
                  Chỉ dữ liệu đã chọn (trong tab Dữ liệu)
                </label>
              </div>
            </div>

            <!-- Action Buttons -->
            <div style="display:flex;gap:12px;margin-top:8px">
              <button class="btn btn-success btn-lg" id="runner-start-btn" onclick="Runner.startRunner()" style="flex:1">
                ▶️ Bắt đầu chạy
              </button>
              <button class="btn btn-danger btn-lg" id="runner-stop-btn" onclick="Runner.stopRunner()" disabled style="flex:1">
                ⏹ Dừng
              </button>
            </div>
          </div>
        </div>

        <!-- Right: Log Panel -->
        <div class="runner-log-container">
          <div class="card" style="display:flex;flex-direction:column;height:100%">
            <div class="card-header">
              <h3 class="card-title">📋 Nhật ký chạy</h3>
              <button class="btn btn-ghost btn-sm" onclick="Runner.clearLog()">🗑 Xóa log</button>
            </div>

            <!-- Progress -->
            <div style="margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px">
                <span class="text-sm text-muted">Tiến trình</span>
                <span class="text-sm font-semibold" id="runner-progress-text">0 / 0 (0%)</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" id="runner-progress-fill" style="width:0%"></div>
              </div>
            </div>

            <!-- Log Container -->
            <div class="runner-log" id="runner-log">
              <div class="text-muted text-sm" style="text-align:center;padding:40px 0">
                Nhật ký sẽ hiển thị tại đây khi bạn bắt đầu chạy tác vụ...
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Select all profile checkboxes
   */
  selectAllProfiles() {
    document.querySelectorAll('.runner-profile-cb').forEach(cb => cb.checked = true);
  },

  /**
   * Deselect all profile checkboxes
   */
  deselectAllProfiles() {
    document.querySelectorAll('.runner-profile-cb').forEach(cb => cb.checked = false);
  },

  /**
   * Start the runner
   */
  async startRunner() {
    // Collect selected profiles
    const selectedProfiles = [];
    document.querySelectorAll('.runner-profile-cb:checked').forEach(cb => {
      selectedProfiles.push(Number(cb.value));
    });

    if (selectedProfiles.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 profile.', 'warning');
      return;
    }

    // Collect data selection
    const dataMode = document.querySelector('input[name="runner-data-mode"]:checked')?.value || 'all';
    let dataIds = 'all';

    if (dataMode === 'selected') {
      // Try to get selected rows from DataManager
      if (typeof DataManager !== 'undefined' && DataManager.gridApi) {
        const selectedRows = DataManager.gridApi.getSelectedRows();
        if (selectedRows.length === 0) {
          showToast('Không có dữ liệu nào được chọn trong tab Dữ liệu. Vui lòng chọn hoặc dùng "Tất cả dữ liệu".', 'warning');
          return;
        }
        dataIds = selectedRows.map(r => r.id);
      } else {
        showToast('Không thể lấy dữ liệu đã chọn. Vui lòng chọn "Tất cả dữ liệu".', 'warning');
        return;
      }
    }

    // Collect config
    const config = {
      profileIds: selectedProfiles,
      dataIds: dataIds,
      concurrency: Number(document.getElementById('runner-concurrency').value) || 2,
      delayMin: Number(document.getElementById('runner-delay-min').value) || 30,
      delayMax: Number(document.getElementById('runner-delay-max').value) || 90,
      profileDelayMin: Number(document.getElementById('runner-profile-delay-min').value) || 10,
      profileDelayMax: Number(document.getElementById('runner-profile-delay-max').value) || 30
    };

    try {
      // Clear log before starting
      this.clearLog();

      await api('/api/runner/start', { method: 'POST', body: config });
      showToast('Runner đã bắt đầu chạy!', 'success');

      this.isRunning = true;
      this._updateButtons(true);
      this.startPolling();

    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Stop the runner
   */
  async stopRunner() {
    try {
      await api('/api/runner/stop', { method: 'POST' });
      showToast('Đang dừng runner...', 'info');
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Handle incoming WebSocket log message
   * Called from app.js WebSocket handler
   */
  onLogMessage(data) {
    // Update progress if available
    if (data.progress) {
      this._updateProgress(data.progress);
    }

    // Handle runner stopped event
    if (data.event === 'runner_stopped') {
      this.isRunning = false;
      this._updateButtons(false);
      this.stopPolling();
      if (data.progress) {
        this._updateProgress(data.progress);
      }
      return;
    }

    // Skip pure progress events (no visible message)
    if (data.event === 'progress' && !data.message) {
      return;
    }

    // Append log entry
    this._appendLogEntry(data);
  },

  /**
   * Append a log entry to the log container
   */
  _appendLogEntry(data) {
    this.logEntries.push(data);

    const logContainer = document.getElementById('runner-log');
    if (!logContainer) return;

    // Clear placeholder text if first entry
    if (this.logEntries.length === 1) {
      logContainer.innerHTML = '';
    }

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const timeStr = data.time ? new Date(data.time).toLocaleTimeString('vi-VN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) : '';

    const profileHtml = data.profile
      ? `<span class="log-profile">[${this._escapeHtml(data.profile)}]</span>`
      : '<span class="log-profile">[Hệ thống]</span>';

    const messageClass = data.type && data.type !== 'info' ? ` ${data.type}` : '';

    entry.innerHTML = `
      <span class="log-time">${timeStr}</span>
      ${profileHtml}
      <span class="log-message${messageClass}">${this._escapeHtml(data.message)}</span>
    `;

    logContainer.appendChild(entry);

    // Auto-scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;
  },

  /**
   * Update progress bar
   */
  _updateProgress(progress) {
    const { total = 0, completed = 0, errors = 0 } = progress;
    const done = completed + errors;
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;

    const progressText = document.getElementById('runner-progress-text');
    const progressFill = document.getElementById('runner-progress-fill');

    if (progressText) {
      progressText.textContent = `${done} / ${total} (${percent}%) - ✅ ${completed} | ❌ ${errors}`;
    }
    if (progressFill) {
      progressFill.style.width = `${percent}%`;
    }
  },

  /**
   * Update button states
   */
  _updateButtons(running) {
    const startBtn = document.getElementById('runner-start-btn');
    const stopBtn = document.getElementById('runner-stop-btn');
    const liveStatus = document.getElementById('runner-live-status');

    if (startBtn) {
      startBtn.disabled = running;
      startBtn.textContent = running ? '⏳ Đang chạy...' : '▶️ Bắt đầu chạy';
    }
    if (stopBtn) {
      stopBtn.disabled = !running;
    }
    if (liveStatus) {
      liveStatus.textContent = running ? 'Đang chạy' : 'Đang nghỉ';
      liveStatus.className = `badge ${running ? 'badge-running' : 'badge-closed'}`;
    }
  },

  /**
   * Fetch current status from server
   */
  async fetchStatus() {
    try {
      const res = await api('/api/runner/status');
      const status = res.data;

      if (status) {
        this.isRunning = status.isRunning;
        this._updateButtons(status.isRunning);
        this._updateProgress(status.progress);

        if (status.isRunning) {
          this.startPolling();
        }
      }
    } catch (e) {
      // Silently fail
    }
  },

  /**
   * Start polling status every 2 seconds
   */
  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.pollStatus(), 2000);
  },

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  /**
   * Poll status from server
   */
  async pollStatus() {
    try {
      const res = await api('/api/runner/status');
      const status = res.data;

      if (status) {
        this._updateProgress(status.progress);

        if (!status.isRunning && this.isRunning) {
          // Runner just stopped
          this.isRunning = false;
          this._updateButtons(false);
          this.stopPolling();
          showToast('Runner đã hoàn tất!', 'success');
        }
      }
    } catch (e) {
      // Silently fail
    }
  },

  /**
   * Clear the log container
   */
  clearLog() {
    this.logEntries = [];
    const logContainer = document.getElementById('runner-log');
    if (logContainer) {
      logContainer.innerHTML = '<div class="text-muted text-sm" style="text-align:center;padding:40px 0">Nhật ký sẽ hiển thị tại đây khi bạn bắt đầu chạy tác vụ...</div>';
    }

    // Reset progress bar
    this._updateProgress({ total: 0, completed: 0, errors: 0 });
  },

  /**
   * Escape HTML to prevent XSS
   */
  _escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};
