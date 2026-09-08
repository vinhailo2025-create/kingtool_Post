const Updater = {
  status: null,
  checkTimer: null,
  CHECK_INTERVAL_MS: 6 * 60 * 60 * 1000,
  REMIND_LATER_MS: 24 * 60 * 60 * 1000,

  init() {
    this.checkTimer = setTimeout(() => this.check(), 5000);
    setInterval(() => this.check(), this.CHECK_INTERVAL_MS);
  },

  async check(force = false) {
    try {
      const response = await apiSilent(`/api/update/check${force ? '?force=1' : ''}`);
      this.status = response.data || null;
      this.renderNotice();
    } catch (_) {
      // Update checks never interrupt normal tool usage.
    }
  },

  async openSettingsUpdate(button) {
    const label = button?.querySelector('span');
    const originalLabel = label?.textContent || '';
    if (button) button.disabled = true;
    if (label) label.textContent = 'Đang kiểm tra...';
    try {
      const response = await apiSilent('/api/update/check?force=1');
      this.status = response.data || null;
      this.renderNotice();
      if (this.status?.update_available) {
        this.showDetails();
        return;
      }
      const current = this.status?.current_version
        ? ` v${this.status.current_version}`
        : '';
      showToast(`Bạn đang dùng phiên bản mới nhất${current}`, 'success', 4500);
    } catch (error) {
      showToast(
        error?.message || 'Chưa thể kiểm tra bản mới. Vui lòng thử lại sau.',
        'error',
        5500
      );
    } finally {
      if (button) button.disabled = false;
      if (label) label.textContent = originalLabel || 'Kiểm tra bản mới';
    }
  },

  reminderKey(version) {
    return `super-post-update-remind:${version}`;
  },

  isSnoozed(version) {
    const until = Number(localStorage.getItem(this.reminderKey(version)) || 0);
    return until > Date.now();
  },

  renderNotice() {
    const notice = document.getElementById('app-update-notice');
    const version = document.getElementById('app-update-version');
    if (!notice) return;
    const available = Boolean(
      this.status?.update_available
      && !this.isSnoozed(this.status.latest_version)
    );
    notice.hidden = !available;
    if (version && available) version.textContent = `v${this.status.latest_version}`;
  },

  escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value || '');
    return div.innerHTML;
  },

  formatBytes(value) {
    const bytes = Number(value || 0);
    if (!bytes) return '';
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  },

  notesHtml() {
    const notes = String(this.status?.release_notes || '').trim();
    if (!notes) return '<p>Bản mới cải thiện độ ổn định và cập nhật các chức năng của Super Post King.</p>';
    return notes
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 8)
      .map(line => `<p>${this.escapeHtml(line.replace(/^[-*#\s]+/, ''))}</p>`)
      .join('');
  },

  showDetails() {
    if (!this.status?.update_available) return;
    const automaticReady = this.status.automatic_update_ready;
    const size = this.formatBytes(this.status.installer_bytes);
    showModal(
      `Super Post King v${this.status.latest_version}`,
      `<div class="app-update-dialog">
        <div class="app-update-dialog-version">
          <span>Phiên bản hiện tại</span>
          <strong>v${this.escapeHtml(this.status.current_version)} → v${this.escapeHtml(this.status.latest_version)}</strong>
          ${size ? `<small>Installer ${size}</small>` : ''}
        </div>
        <div class="app-update-notes">${this.notesHtml()}</div>
        <div class="app-update-safety">
          Dữ liệu, Profile trình duyệt, cấu hình và license được giữ nguyên khi cài đè.
        </div>
      </div>`,
      `<button class="btn btn-secondary" onclick="Updater.remindLater()">Để sau</button>
       ${automaticReady
        ? '<button class="btn btn-primary" id="app-update-install" onclick="Updater.install(this)">Cập nhật ngay</button>'
        : `<a class="btn btn-primary" href="${this.escapeHtml(this.status.drive_url)}" target="_blank" rel="noopener noreferrer">Tải bản dự phòng</a>`}`
    );
  },

  remindLater() {
    if (this.status?.latest_version) {
      localStorage.setItem(
        this.reminderKey(this.status.latest_version),
        String(Date.now() + this.REMIND_LATER_MS)
      );
    }
    this.renderNotice();
    closeModal();
  },

  async install(button) {
    if (!this.status?.automatic_update_ready) return;
    if (button) {
      button.disabled = true;
      button.textContent = 'Đang tải và kiểm tra...';
    }
    try {
      await apiSilent('/api/update/download', { method: 'POST' });
      if (!window.pywebview?.api?.install_update) {
        window.open(this.status.download_url, '_blank', 'noopener,noreferrer');
        showToast('Đã mở trang tải bản cập nhật', 'info', 5000);
        closeModal();
        return;
      }

      if (button) button.textContent = 'Đang cài đặt...';
      const result = await window.pywebview.api.install_update();
      if (!result?.success) throw new Error(result?.error || 'Không thể khởi động trình cập nhật.');
      document.getElementById('modal-body').innerHTML = `
        <div class="app-update-closing">
          <span class="app-update-spinner"></span>
          <strong>Đang đóng tool để cài bản mới</strong>
          <small>Super Post King sẽ tự mở lại sau khi cập nhật.</small>
        </div>`;
      document.getElementById('modal-footer').innerHTML = '';
    } catch (error) {
      showToast(error.message, 'error', 6000);
      if (button) {
        button.disabled = false;
        button.textContent = 'Thử lại';
      }
    }
  },
};
