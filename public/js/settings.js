/**
 * CovergemAuto - Settings & Backup Module
 */

const Settings = {
  settings: {},
  backups: [],

  /**
   * Load settings and backup list, render the page
   */
  async load() {
    const container = document.getElementById('page-settings');
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Đang tải cài đặt...</div></div>';

    try {
      const [settingsRes, backupsRes] = await Promise.all([
        api('/api/settings'),
        api('/api/settings/backup/list'),
      ]);

      this.settings = settingsRes.data || {};
      this.backups = backupsRes.data || [];
    } catch (err) {
      this.settings = {};
      this.backups = [];
    }

    this.render();
  },

  /**
   * Render the full settings page
   */
  render() {
    const container = document.getElementById('page-settings');
    const s = this.settings;

    container.innerHTML = `
      <!-- Section 1: General Settings -->
      <div class="settings-section">
        <div class="settings-section-title">⚙️ Cài đặt chung</div>
        <div class="card">
          <div class="form-group mb-16">
            <label class="form-label">Đường dẫn Chrome</label>
            <div style="display: flex; gap: 8px;">
              <input type="text" class="form-input" id="setting-chrome-path"
                     value="${this.escapeHtml(s.chrome_path || '')}"
                     placeholder="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
                     style="flex: 1;">
              <button class="btn btn-secondary btn-sm" onclick="Settings.detectChrome()">
                🔍 Tự động phát hiện
              </button>
            </div>
          </div>

          <div class="form-group mb-16">
            <label class="form-label">Giới hạn Chrome đồng thời</label>
            <input type="number" class="form-input" id="setting-max-concurrency"
                   value="${s.max_concurrency || '5'}"
                   min="1" max="10" style="width: 120px;">
          </div>

          <div class="form-group mb-16">
            <label class="form-label">So trinh duyet tren 1 man hinh</label>
            <input type="number" class="form-input" id="setting-browser-per-screen"
                   value="${s.browser_per_screen || '1'}"
                   min="1" max="12" style="width: 120px;">
            <div class="text-sm text-muted" style="margin-top:6px;">1 trinh duyet mo lon. Chay nhieu trinh duyet se chia deu theo so nay.</div>
          </div>

          <div class="form-group mb-16">
            <label class="form-label">Delay mặc định giữa bài (giây)</label>
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="number" class="form-input" id="setting-delay-min"
                     value="${s.default_delay_min || '30'}"
                     min="0" style="width: 100px;">
              <span style="color: var(--text-muted);">~</span>
              <input type="number" class="form-input" id="setting-delay-max"
                     value="${s.default_delay_max || '90'}"
                     min="0" style="width: 100px;">
            </div>
          </div>

          <div class="form-group mb-16">
            <label class="form-label">Delay mặc định giữa profile (giây)</label>
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="number" class="form-input" id="setting-profile-delay-min"
                     value="${s.default_profile_delay_min || '10'}"
                     min="0" style="width: 100px;">
              <span style="color: var(--text-muted);">~</span>
              <input type="number" class="form-input" id="setting-profile-delay-max"
                     value="${s.default_profile_delay_max || '30'}"
                     min="0" style="width: 100px;">
            </div>
          </div>

          <div class="form-group mb-16" style="flex-direction: row; align-items: center; gap: 12px;">
            <label class="toggle">
              <input type="checkbox" id="setting-auto-backup" ${s.auto_backup === '1' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <label class="form-label" style="margin: 0; cursor: pointer;" for="setting-auto-backup">
              Auto backup
            </label>
          </div>

          <button class="btn btn-primary" onclick="Settings.saveSettings()">
            💾 Lưu cài đặt
          </button>
        </div>
      </div>

      <!-- Section 2: Backup & Restore -->
      <div class="settings-section">
        <div class="settings-section-title">💾 Backup & Restore</div>
        <div class="card">
          <div style="margin-bottom: 16px;">
            <button class="btn btn-primary" onclick="Settings.createBackup()">
              📦 Tạo Backup
            </button>
          </div>

          <div class="backup-list" id="backup-list">
            ${this.renderBackupList()}
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Render the backup list items
   */
  renderBackupList() {
    if (!this.backups || this.backups.length === 0) {
      return `
        <div class="empty-state" style="padding: 30px 20px;">
          <div class="empty-icon" style="font-size: 36px;">📭</div>
          <div class="empty-text">Chưa có backup nào</div>
        </div>
      `;
    }

    return this.backups.map(backup => `
      <div class="backup-item">
        <div>
          <div class="backup-name">📦 ${this.escapeHtml(backup.filename)}</div>
          <div class="backup-date">
            ${this.formatFileSize(backup.size)} · ${formatDate(backup.createdAt)}
          </div>
        </div>
        <div style="display: flex; gap: 6px; flex-shrink: 0;">
          <button class="btn btn-secondary btn-sm" onclick="Settings.restoreBackup('${this.escapeHtml(backup.filename)}')">
            ♻️ Khôi phục
          </button>
          <button class="btn btn-ghost btn-sm" style="color: var(--error);" onclick="Settings.deleteBackup('${this.escapeHtml(backup.filename)}')">
            🗑 Xóa
          </button>
        </div>
      </div>
    `).join('');
  },

  /**
   * Save general settings
   */
  async saveSettings() {
    const settings = {
      chrome_path: document.getElementById('setting-chrome-path').value.trim(),
      max_concurrency: document.getElementById('setting-max-concurrency').value || '5',
      default_delay_min: document.getElementById('setting-delay-min').value || '30',
      default_delay_max: document.getElementById('setting-delay-max').value || '90',
      default_profile_delay_min: document.getElementById('setting-profile-delay-min').value || '10',
      default_profile_delay_max: document.getElementById('setting-profile-delay-max').value || '30',
      browser_per_screen: document.getElementById('setting-browser-per-screen').value || '1',
      auto_backup: document.getElementById('setting-auto-backup').checked ? '1' : '0',
    };

    // Validate concurrency
    const concurrency = parseInt(settings.max_concurrency);
    if (isNaN(concurrency) || concurrency < 1 || concurrency > 10) {
      showToast('Giới hạn Chrome đồng thời phải từ 1-10', 'warning');
      return;
    }

    const browserPerScreen = parseInt(settings.browser_per_screen);
    if (isNaN(browserPerScreen) || browserPerScreen < 1 || browserPerScreen > 12) {
      showToast('So trinh duyet tren 1 man hinh phai tu 1-12', 'warning');
      return;
    }

    // Validate delays
    const delayMin = parseInt(settings.default_delay_min);
    const delayMax = parseInt(settings.default_delay_max);
    if (delayMin > delayMax) {
      showToast('Delay min không được lớn hơn delay max', 'warning');
      return;
    }

    const profileDelayMin = parseInt(settings.default_profile_delay_min);
    const profileDelayMax = parseInt(settings.default_profile_delay_max);
    if (profileDelayMin > profileDelayMax) {
      showToast('Delay profile min không được lớn hơn max', 'warning');
      return;
    }

    try {
      await api('/api/settings', {
        method: 'PUT',
        body: settings,
      });
      this.settings = settings;
      showToast('Đã lưu cài đặt thành công', 'success');
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Auto-detect Chrome path
   */
  async detectChrome() {
    const commonPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];

    // Just set the most common path - actual detection happens server-side
    const input = document.getElementById('setting-chrome-path');
    input.value = commonPaths[0];
    showToast('Đã điền đường dẫn Chrome mặc định. Nhấn Lưu để áp dụng.', 'info');
  },

  /**
   * Create a new backup
   */
  async createBackup() {
    try {
      showToast('Đang tạo backup...', 'info');
      const result = await api('/api/settings/backup/create', { method: 'POST' });
      showToast(`Đã tạo backup: ${result.data.filename}`, 'success');

      // Refresh backup list
      const backupsRes = await api('/api/settings/backup/list');
      this.backups = backupsRes.data || [];
      const listEl = document.getElementById('backup-list');
      if (listEl) {
        listEl.innerHTML = this.renderBackupList();
      }
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Restore from a backup
   * @param {string} filename
   */
  async restoreBackup(filename) {
    const confirmed = await showConfirm(
      'Xác nhận Khôi phục',
      'Khôi phục sẽ ghi đè dữ liệu hiện tại. Bạn chắc chắn?'
    );

    if (!confirmed) return;

    try {
      showToast('Đang khôi phục...', 'info');
      const result = await api(`/api/settings/backup/restore/${encodeURIComponent(filename)}`, {
        method: 'POST',
      });
      showToast(result.data.message, 'success', 5000);
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Delete a backup
   * @param {string} filename
   */
  async deleteBackup(filename) {
    const confirmed = await showConfirm(
      'Xóa Backup',
      `Bạn có chắc muốn xóa backup "${filename}"?`
    );

    if (!confirmed) return;

    try {
      await api(`/api/settings/backup/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      showToast('Đã xóa backup', 'success');

      // Refresh backup list
      const backupsRes = await api('/api/settings/backup/list');
      this.backups = backupsRes.data || [];
      const listEl = document.getElementById('backup-list');
      if (listEl) {
        listEl.innerHTML = this.renderBackupList();
      }
    } catch (err) {
      // Error already shown by api()
    }
  },

  /**
   * Format file size to human readable
   * @param {number} bytes
   * @returns {string}
   */
  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';

    if (bytes < 1024) {
      return bytes + ' B';
    } else if (bytes < 1024 * 1024) {
      return (bytes / 1024).toFixed(1) + ' KB';
    } else if (bytes < 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    } else {
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
  },

  /**
   * Escape HTML to prevent XSS
   * @param {string} str
   * @returns {string}
   */
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },
};
