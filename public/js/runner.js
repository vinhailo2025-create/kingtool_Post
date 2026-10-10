/**
 * Global realtime runner log with platform/project filtering.
 */
const Runner = {
  pollTimer: null,
  statuses: {},
  logEntries: [],
  projectFilter: 'all',

  get isRunning() {
    return Object.values(this.statuses).some(status => status?.isRunning);
  },

  set isRunning(value) {
    if (!value) return;
    const platform = App.currentPlatform || 'facebook';
    this.statuses[platform] = { ...(this.statuses[platform] || {}), isRunning: true };
  },

  async load() {
    try {
      const history = await api('/api/runner/logs?platform=all&limit=300');
      const liveEntries = this.logEntries.filter(entry => !entry.id);
      this.logEntries = [...(history.data || []), ...liveEntries].slice(-500);
    } catch (_) {}
    await this.fetchStatus();
    this.render();
  },

  setProjectFilter(platform) {
    this.projectFilter = App.platforms.includes(platform) ? platform : 'all';
    this.render();
  },

  filteredEntries() {
    if (this.projectFilter === 'all') return this.logEntries;
    return this.logEntries.filter(entry => (entry.platform || 'facebook') === this.projectFilter);
  },

  selectedStatuses() {
    if (this.projectFilter === 'all') return Object.values(this.statuses);
    return [this.statuses[this.projectFilter]].filter(Boolean);
  },

  aggregateProgress() {
    return this.selectedStatuses().reduce((total, status) => {
      const progress = status?.progress || {};
      total.total += Number(progress.total || 0);
      total.completed += Number(progress.completed || 0);
      total.errors += Number(progress.errors || 0);
      return total;
    }, { total: 0, completed: 0, errors: 0 });
  },

  render() {
    const container = document.getElementById('page-runner');
    if (!container) return;
    const entries = this.filteredEntries().slice(-300);
    const selectedRunning = this.selectedStatuses().some(status => status?.isRunning);
    const progress = this.aggregateProgress();
    const done = progress.completed + progress.errors;
    const percent = progress.total ? Math.round(done / progress.total * 100) : 0;
    // commentQueue là counts toàn cục (không theo nền tảng) nên đọc từ status bất kỳ.
    const commentCounts = (Object.values(this.statuses).find(s => s?.commentQueue)?.commentQueue?.counts) || {};
    const commentPending = Number(commentCounts.waiting || 0)
      + Number(commentCounts.waiting_approval || 0)
      + Number(commentCounts.approval_checking || 0)
      + Number(commentCounts.running || 0);
    const commentStopped = Number(commentCounts.stopped || 0);
    const filterOptions = [
      '<option value="all">Tất cả dự án</option>',
      ...App.platforms.map(platform =>
        `<option value="${platform}" ${this.projectFilter === platform ? 'selected' : ''}>${App.platformLabel(platform)}</option>`
      ),
    ].join('');
    const statusChips = App.platforms.map(platform => {
      const running = !!this.statuses[platform]?.isRunning;
      return `<button type="button" class="runner-project-status ${running ? 'is-running' : ''} ${this.projectFilter === platform ? 'active' : ''}"
                      onclick="Runner.setProjectFilter('${platform}')">
        <span></span>${App.platformLabel(platform)}
      </button>`;
    }).join('');
    const logRows = entries.map(entry => {
      const platform = entry.platform || 'facebook';
      const time = entry.time ? new Date(entry.time).toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }) : '';
      const messageClass = entry.type && entry.type !== 'info' ? ` ${entry.type}` : '';
      return `
        <div class="log-entry global-log-entry">
          <span class="log-time">${time}</span>
          <span class="log-profile">[${this.escapeHtml(entry.profile || 'Hệ thống')}]</span>
          <span class="log-message${messageClass}">${this.escapeHtml(entry.message || '')}</span>
          <span class="project-chip project-${platform}">${this.escapeHtml(App.platformLabel(platform))}</span>
        </div>`;
    }).join('') || `
      <div class="empty-state compact-empty">
        <div class="empty-icon">≡</div>
        <div class="empty-text">Chưa có log chạy</div>
      </div>`;

    container.innerHTML = `
      <div class="lux-panel runner-status-panel" data-tour-id="runner-log">
        <div class="lux-panel-title global-page-tools">
          <div class="lux-title">Log chạy</div>
          <div>
            <select class="form-select project-filter-select" onchange="Runner.setProjectFilter(this.value)">
              ${filterOptions}
            </select>
            <span class="badge ${selectedRunning ? 'badge-running' : 'badge-closed'}">${selectedRunning ? 'Đang chạy' : 'Đang nghỉ'}</span>
            <button class="btn btn-secondary btn-sm" onclick="Runner.clearLog()">Xóa log</button>
            <button class="btn btn-danger btn-sm" onclick="Runner.stopRunner()" ${selectedRunning ? '' : 'disabled'}>Dừng</button>
            ${commentPending > 0 ? `
              <button class="btn btn-warning btn-sm" onclick="Runner.stopComments(false)">Dừng bình luận</button>
              <button class="btn btn-danger btn-sm" onclick="Runner.stopComments(true)">Hủy chờ</button>
            ` : ''}
            ${commentStopped > 0 ? `
              <button class="btn btn-secondary btn-sm" onclick="Runner.resumeComments()">Chạy tiếp bình luận</button>
            ` : ''}
          </div>
        </div>
        <div class="runner-project-strip">${statusChips}</div>
        <div class="runner-log-summary">
          <div>
            <span class="text-sm text-muted">Tiến trình</span>
            <span class="text-sm font-semibold">${done} / ${progress.total} (${percent}%)</span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>
        </div>
        <div class="runner-log runner-log-full" id="runner-log">${logRows}</div>
      </div>`;
    const logContainer = document.getElementById('runner-log');
    if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
  },

  onLogMessage(data) {
    data.platform = data.platform || 'facebook';
    if (data.event !== 'progress' || data.message) {
      this.logEntries.push(data);
      if (this.logEntries.length > 500) this.logEntries.splice(0, this.logEntries.length - 500);
    }

    if ((data.event === 'post_saved' || data.event === 'post_state')
        && data.platform === App.currentPlatform
        && typeof DataManager !== 'undefined'
        && DataManager.applyPostResult) {
      DataManager.applyPostResult(data);
    }
    if (data.event === 'runner_stopped') this.fetchStatus();
    if (App.currentPage === 'runner') this.render();
  },

  async fetchStatus() {
    try {
      const response = await api('/api/runner/status?platform=all');
      this.statuses = response.data || {};
      if (this.isRunning) this.startPolling();
      else this.stopPolling();
      if (App.currentPage === 'runner') this.render();
    } catch (_) {}
  },

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.fetchStatus(), 2000);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async pollStatus() {
    await this.fetchStatus();
  },

  async stopRunner() {
    const platform = this.projectFilter === 'all' ? 'all' : this.projectFilter;
    try {
      await api(`/api/runner/stop?platform=${platform}`, { method: 'POST' });
      showToast(platform === 'all' ? 'Đang dừng tất cả tác vụ' : `Đang dừng ${App.platformLabel(platform)}`, 'info');
      await this.fetchStatus();
    } catch (_) {}
  },

  async stopComments(cancel) {
    const platform = this.projectFilter === 'all' ? 'all' : this.projectFilter;
    if (cancel && !confirm('Hủy toàn bộ bình luận đang chờ? Không thể hoàn tác.')) return;
    try {
      await api(`/api/runner/comments/stop?platform=${platform}`, { method: 'POST', body: { cancel: !!cancel } });
      showToast(cancel ? 'Đã hủy bình luận đang chờ' : 'Đã dừng bình luận', 'info');
      await this.fetchStatus();
    } catch (_) {}
  },

  async resumeComments() {
    const platform = this.projectFilter === 'all' ? 'all' : this.projectFilter;
    try {
      await api(`/api/runner/comments/resume?platform=${platform}`, { method: 'POST', body: {} });
      showToast('Đang chạy tiếp bình luận', 'info');
      await this.fetchStatus();
    } catch (_) {}
  },

  clearLog() {
    if (this.projectFilter === 'all') {
      this.logEntries = [];
    } else {
      this.logEntries = this.logEntries.filter(entry =>
        (entry.platform || 'facebook') !== this.projectFilter
      );
    }
    this.render();
  },

  renderLogStatus() {
    this.render();
  },

  _updateButtons() {
    if (App.currentPage === 'runner') this.render();
  },

  _updateProgress() {
    if (App.currentPage === 'runner') this.render();
  },

  _appendLogEntry(data, remember = true) {
    if (remember) this.logEntries.push(data);
    if (App.currentPage === 'runner') this.render();
  },

  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  },

  _escapeHtml(value) {
    return this.escapeHtml(value);
  },
};
