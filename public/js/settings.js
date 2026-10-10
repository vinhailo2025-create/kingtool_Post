/**
 * Super Post - King - Settings Module
 */

const Settings = {
  settings: {},
  aiSettings: null,
  aiProvider: 'gemini',
  googleSheetsSettings: null,
  telegramSettings: null,
  agentMcpStatus: null,
  cloudMcpStatus: null,
  agentMcpRefreshTimer: null,
  googleCredentialsJson: '',
  googleCredentialFileName: '',
  openSections: new Set(),
  pendingSection: null,
  activeTask: 'settings',
  supportLinks: {
    youtube: 'https://www.youtube.com/playlist?list=PLaySyj8jDkR0',
    youtubeEmbed: '',
    docs: 'https://docs.google.com/document/d/1kA0YEV95hENNFmtjDou4eLXimrnva1fqutZLumGXKWU/edit?usp=sharing',
  },
  guideVideos: [
    { id: 'upamGjVXw20', title: 'SUPER POST KING', duration: '1:56' },
    { id: 'fUcg35vnkiM', title: 'Kết Nối Trình Duyệt SUPER POST: Chrome Mới Hoặc Profile Anti-Detect', duration: '1:12' },
    { id: '52qwczXhMTk', title: 'SUPER POST - HƯỚNG DẪN SỬ DỤNG', duration: '14:58' },
    { id: 'pt-ca5lC6c8', title: 'Demo SUPER POST: Hướng dẫn thao tác đăng bài', duration: '3:33' },
    { id: 'sLfQlYXBSH8', title: 'Cấu Hình Bài Đăng SUPER POST: Số Lượng, Chống Bot, Delay Và Nhãn AI', duration: '1:51' },
    { id: 'rZn8LLue-60', title: 'SUPER POST: Tự Động Bình Luận Facebook Sau Khi Đăng Bài', duration: '1:29' },
    { id: 'Rs8co9l2_JE', title: 'SUPER POST AI: Viết Lại Nội Dung Hàng Loạt Và Tạo Ảnh Tự Động', duration: '1:37' },
    { id: '_k8Qfi84jzQ', title: 'Cài Đặt SUPER POST: API, Đường Dẫn, Delay Và Đồng Bộ Google Sheets', duration: '2:19' },
    { id: 'K_T6kXNsfbk', title: 'SUPER POST Agent: Điều Khiển Đăng Bài Facebook Bằng Điện Thoại', duration: '12:27' },
    { id: 'KYZHGpq1Wx4', title: 'Super Post King: Hướng Dẫn Cài Đặt Và Kích Hoạt Tool Từ A-Z', duration: '3:04' },
    { id: 'nvUP9iyUGO8', title: 'SUPER POST: Đồng Bộ Dữ Liệu Đăng Bài Giữa Nhiều Nền Tảng', duration: '2:47' },
    { id: 'CFvgqxltG58', title: 'Tạo key, license và kích hoạt tool', duration: '2:15' },
  ],

  /**
   * Load all settings and render the page
   */
  async load() {
    const container = document.getElementById('page-settings');
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Đang tải cài đặt...</div></div>';
    this.activeTask = 'settings';
    this.openSections = new Set(this.pendingSection ? [this.pendingSection] : []);

    try {
      const [settingsRes, aiRes, googleSheetsRes, telegramRes, agentMcpRes, cloudMcpRes, playlistRes] = await Promise.all([
        api('/api/settings'),
        api('/api/ai/settings'),
        api('/api/google-sheets/settings').catch(() => ({ data: null })),
        api('/api/telegram/settings').catch(() => ({ data: null })),
        apiSilent('/api/settings/agent-mcp/status').catch(() => ({ data: null })),
        apiSilent('/api/settings/cloud-mcp/status').catch(() => ({ data: null })),
        apiSilent('/api/support/youtube-playlist').catch(() => null),
      ]);

      this.settings = settingsRes.data || {};
      this.aiSettings = aiRes.data || null;
      this.aiProvider = this.aiSettings?.activeProvider || 'gemini';
      this.googleSheetsSettings = googleSheetsRes.data || null;
      this.telegramSettings = telegramRes.data || null;
      this.agentMcpStatus = agentMcpRes.data || null;
      this.cloudMcpStatus = cloudMcpRes.data || null;
      this.applyGuidePlaylist(playlistRes);
    } catch (err) {
      this.settings = {};
      this.aiSettings = null;
      this.aiProvider = 'gemini';
      this.googleSheetsSettings = null;
      this.telegramSettings = null;
      this.agentMcpStatus = null;
      this.cloudMcpStatus = null;
    }

    this.render();
  },

  /**
   * Render the full settings page
   */
  render() {
    const container = document.getElementById('page-settings');
    const s = this.settings;
    const interactionEnabled = s.interaction_delay_enabled !== '0';
    const interactionSummary = interactionEnabled
      ? `Đang bật · random ${this.msToSeconds(s.interaction_delay_min_ms, 0.8)}–${this.msToSeconds(s.interaction_delay_max_ms, 2.2)} giây giữa mỗi thao tác`
      : 'Đang tắt · thao tác đăng bài dùng tốc độ gốc';
    const generalOpen = this.openSections.has('general');

    container.innerHTML = `
      ${this.renderTaskSwitch()}
      <div class="settings-task-view" id="settings-task-settings"
           role="tabpanel" aria-labelledby="settings-task-tab-settings">
      ${this.renderAccordion(
        'ai',
        'AI nội dung & tạo ảnh',
        'Kết nối dùng chung mọi nền tảng',
        this.renderAiSettings(),
        '✦',
        'ai-settings-accordion'
      )}

      ${this.renderAccordion(
        'agent-mcp',
        'Agent & MCP',
        'Cài đặt một nút và nhận trạng thái job theo thời gian thực',
        this.renderAgentMcpSettings(),
        '◆',
        'agent-mcp-accordion'
      )}

      <section class="settings-accordion settings-section${generalOpen ? ' is-open' : ''}"
               id="settings-general-section" data-settings-section="general">
        ${this.renderAccordionTrigger('general', '⚙', 'Cài đặt chung', 'Trình duyệt, tốc độ và thao tác đăng bài')}
        <div class="settings-accordion-panel" id="settings-panel-general"
             role="region" aria-labelledby="settings-trigger-general"${generalOpen ? '' : ' hidden'}>
          <div class="settings-accordion-content">
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
            <label class="form-label">Bố cục và tốc độ mở trình duyệt</label>
            <div style="display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));gap:14px 20px;max-width:760px;">
              <label class="auto-field">Số hàng cửa sổ
                <input type="number" class="form-input" id="setting-browser-layout-rows"
                       value="${s.browser_layout_rows || '2'}" min="1" max="4">
                <span class="text-sm text-muted">Row</span>
              </label>
              <label class="auto-field">Số cột cửa sổ
                <input type="number" class="form-input" id="setting-browser-layout-columns"
                       value="${s.browser_layout_columns || '4'}" min="1" max="6">
                <span class="text-sm text-muted">Column</span>
              </label>
              <label class="auto-field">Tỉ lệ cửa sổ
                <input type="number" class="form-input" id="setting-browser-window-ratio"
                       value="${s.browser_window_ratio || '1'}" min="0.25" max="1" step="0.05">
                <span class="text-sm text-muted">1 = phủ đầy ô bố cục</span>
              </label>
              <label class="auto-field">Thời gian mở giữa các hồ sơ (ms)
                <input type="number" class="form-input" id="setting-profile-open-delay-ms"
                       value="${s.profile_open_delay_ms || '0'}" min="0" max="600000" step="100">
                <span class="text-sm text-muted">1000ms = 1 giây</span>
              </label>
              <label class="auto-field">Số lần thử mở lại khi lỗi
                <input type="number" class="form-input" id="setting-browser-launch-retry-count"
                       value="${s.browser_launch_retry_count || '0'}" min="0" max="10">
                <span class="text-sm text-muted">0 = không thử lại</span>
              </label>
            </div>
          </div>

          <div class="form-group mb-16">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
              <span class="toggle">
                <input type="checkbox" id="setting-hidden-run-enabled"
                       ${s.hidden_run_enabled === '1' ? 'checked' : ''}>
                <span class="toggle-slider"></span>
              </span>
              <span class="form-label" style="margin:0;">Chế độ chạy ẩn (dời cửa sổ Chrome ra ngoài màn hình khi chạy tự động)</span>
            </label>
            <span class="text-sm text-muted">Chỉ áp dụng cho Chrome quản lý khi đăng tự động. Không ảnh hưởng đăng nhập/mở thủ công và trình duyệt Anti-detect.</span>
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

          <div class="compact-config-row settings-interaction-row mb-16">
            <div>
              <strong>Tốc độ thao tác đăng bài</strong>
              <span>${this.escapeHtml(interactionSummary)}</span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm"
                    onclick="Settings.showInteractionDelayModal()">Cài đặt</button>
          </div>

          <button class="btn btn-primary" onclick="Settings.saveSettings()">
            💾 Lưu cài đặt
          </button>
            </div>
          </div>
        </div>
      </section>

      ${this.renderAccordion(
        'telegram',
        'Thông báo Telegram',
        'Nhận trạng thái quan trọng ngay khi hoàn tất',
        this.renderTelegramSettings(),
        '✈',
        'telegram-accordion'
      )}

      ${this.renderAccordion(
        'google-sheets',
        'Đồng bộ Google Sheets',
        'Kết nối, đồng bộ thủ công và tự động',
        this.renderGoogleSheetsSettings(),
        '☁',
        'google-sheets-accordion'
      )}

      ${this.renderAccordion(
        'guide',
        'Hướng dẫn sử dụng',
        'Video, tài liệu và cập nhật phiên bản',
        this.renderGuideSettings(),
        '?',
        'settings-guide-accordion'
      )}
      </div>
      <div class="settings-task-view" id="settings-task-account"
           role="tabpanel" aria-labelledby="settings-task-tab-account" hidden></div>
    `;

    this.revealPendingSection();
  },

  renderTaskSwitch() {
    return `
      <div class="settings-task-switch" role="tablist" aria-label="Khu vực cài đặt">
        <button type="button" class="settings-task-tab is-active"
                id="settings-task-tab-settings" role="tab" aria-selected="true"
                aria-controls="settings-task-settings"
                onclick="Settings.selectTask('settings')">
          <span aria-hidden="true">⚙</span>
          <strong>Cài đặt</strong>
        </button>
        <button type="button" class="settings-task-tab"
                id="settings-task-tab-account" role="tab" aria-selected="false"
                aria-controls="settings-task-account"
                onclick="Settings.selectTask('account')">
          <span aria-hidden="true">▣</span>
          <strong>Thanh toán</strong>
        </button>
      </div>
    `;
  },

  selectTask(task) {
    if (!['settings', 'account'].includes(task)) return;
    this.activeTask = task;
    document.querySelectorAll('.settings-task-tab').forEach(button => {
      const active = button.id === `settings-task-tab-${task}`;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });

    const settingsView = document.getElementById('settings-task-settings');
    const accountView = document.getElementById('settings-task-account');
    if (settingsView) settingsView.hidden = task !== 'settings';
    if (accountView) accountView.hidden = task !== 'account';
    if (task === 'account' && accountView) Account.load('settings-task-account');
  },

  renderAccordion(id, title, summary, content, icon, extraClass = '') {
    const open = this.openSections.has(id);
    return `
      <section class="settings-accordion settings-section ${extraClass}${open ? ' is-open' : ''}"
               id="settings-${id}-section" data-settings-section="${id}">
        ${this.renderAccordionTrigger(id, icon, title, summary)}
        <div class="settings-accordion-panel" id="settings-panel-${id}"
             role="region" aria-labelledby="settings-trigger-${id}"${open ? '' : ' hidden'}>
          <div class="settings-accordion-content">${content}</div>
        </div>
      </section>
    `;
  },

  renderAccordionTrigger(id, icon, title, summary) {
    const open = this.openSections.has(id);
    return `
      <button type="button" class="settings-accordion-trigger"
              id="settings-trigger-${id}" aria-expanded="${open}"
              aria-controls="settings-panel-${id}"
              onclick="Settings.toggleSection('${id}')">
        <span class="settings-accordion-icon" aria-hidden="true">${icon}</span>
        <span class="settings-accordion-label">
          <strong>${title}</strong>
          <small>${summary}</small>
        </span>
        <span class="settings-accordion-chevron" aria-hidden="true"></span>
      </button>
    `;
  },

  renderAgentMcpSettings() {
    const value = this.agentMcpStatus || {};
    const cloud = this.cloudMcpStatus;
    if (!value && !cloud) {
      return `
        <div class="agent-mcp-card" id="agent-mcp-card">
          <div class="agent-mcp-empty">Không đọc được trạng thái Agent & MCP.</div>
          <button type="button" class="btn btn-secondary btn-sm"
                  onclick="Settings.refreshAgentMcpStatus()">Thử lại</button>
        </div>
      `;
    }

    const realtime = value.realtime || {};
    const actionLabel = value.installed
      ? (value.update_available ? 'Cập nhật Agent Kit' : 'Sửa kết nối MCP')
      : 'Cài kết nối AI';
    const version = value.installed_version || value.bundled_version || 'chưa cài';

    return `
      <div class="agent-mcp-card" id="agent-mcp-card">
        <div class="agent-mcp-head cloud-mcp-head">
          <div>
            <span class="agent-mcp-eyebrow">
              <span class="status-dot ${cloud?.connected ? 'online' : 'offline'}"></span>
              Cloud MCP ${cloud?.connected ? 'đang trực tuyến' : 'chưa kết nối'}
            </span>
            <strong>Kết nối Claude &amp; ChatGPT</strong>
            <small>${cloud?.connected
              ? `Thiết bị ${this.escapeHtml(cloud.device_id || '')}`
              : this.escapeHtml(cloud?.last_error || 'Tool sẽ tự kết nối khi license hợp lệ')}</small>
          </div>
          <div class="agent-mcp-actions">
            <button type="button" class="btn ${cloud?.connected ? 'btn-secondary' : 'btn-primary'} btn-sm"
                    onclick="Settings.toggleCloudMcp(this, ${cloud?.connected ? 'false' : 'true'})">
              ${cloud?.connected ? 'Ngắt kết nối' : 'Kết nối ngay'}
            </button>
          </div>
        </div>

        <div class="agent-mcp-head">
          <div>
            <span class="agent-mcp-eyebrow">
              <span class="status-dot ${realtime.realtime ? 'online' : 'offline'}"></span>
              Realtime ${realtime.realtime ? 'đang hoạt động' : 'không hoạt động'}
            </span>
            <strong>Super Post Agent Kit</strong>
            <small>Phiên bản ${this.escapeHtml(version)}</small>
          </div>
          <div class="agent-mcp-actions">
            <button type="button" class="btn btn-secondary btn-sm"
                    onclick="Settings.refreshAgentMcpStatus()">Kiểm tra</button>
            <button type="button" class="btn btn-primary btn-sm"
                    onclick="Settings.installAgentKit(this)">${actionLabel}</button>
          </div>
        </div>

        <div class="agent-mcp-install-note">
          MCP local có tên <strong>super-post-king-local</strong>. Nếu Claude có thêm mục
          “Super post king” yêu cầu xác thực, đó là Cloud MCP và không phải kết nối local này.
          Sau khi cài, hãy thoát hẳn Claude khỏi khay hệ thống rồi mở lại.
          Thống kê hoạt động được theo dõi tại Dashboard.
        </div>
      </div>
    `;
  },

  async refreshAgentMcpStatus(options = {}) {
    try {
      const [response, cloud] = await Promise.all([
        apiSilent('/api/settings/agent-mcp/status'),
        apiSilent('/api/settings/cloud-mcp/status').catch(() => ({ data: null })),
      ]);
      this.agentMcpStatus = response.data || null;
      this.cloudMcpStatus = cloud.data || null;
      const current = document.getElementById('agent-mcp-card');
      if (current) current.outerHTML = this.renderAgentMcpSettings();
      if (!options.silent) showToast('Đã kiểm tra Agent & MCP', 'success');
    } catch (error) {
      if (!options.silent) showToast(error.message, 'error');
    }
  },

  async installAgentKit(button) {
    if (button) {
      button.disabled = true;
      button.textContent = 'Đang cài đặt...';
    }
    try {
      const response = await api('/api/settings/agent-mcp/install', { method: 'POST' });
      this.agentMcpStatus = response.data || null;
      const current = document.getElementById('agent-mcp-card');
      if (current) current.outerHTML = this.renderAgentMcpSettings();
      showToast(
        'Đã cài MCP local. Hãy thoát hẳn Claude khỏi khay hệ thống rồi mở lại.',
        'success',
        8000
      );
    } catch (_) {
      if (button) {
        button.disabled = false;
        button.textContent = 'Thử lại';
      }
    }
  },

  async toggleCloudMcp(button, connect) {
    if (button) {
      button.disabled = true;
      button.textContent = connect ? 'Đang kết nối...' : 'Đang ngắt...';
    }
    try {
      await api(`/api/settings/cloud-mcp/${connect ? 'connect' : 'disconnect'}`, { method: 'POST' });
      await new Promise(resolve => setTimeout(resolve, connect ? 1200 : 100));
      await this.refreshAgentMcpStatus({ silent: true });
      showToast(connect ? 'Đang kết nối Cloud MCP' : 'Đã ngắt Cloud MCP', 'success');
    } catch (error) {
      showToast(error.message, 'error');
      if (button) button.disabled = false;
    }
  },

  onAgentEvent() {
    clearTimeout(this.agentMcpRefreshTimer);
    this.agentMcpRefreshTimer = setTimeout(() => {
      this.refreshAgentMcpStatus({ silent: true });
    }, 250);
  },

  toggleSection(id, forceOpen = null) {
    const section = document.querySelector(`[data-settings-section="${id}"]`);
    const trigger = document.getElementById(`settings-trigger-${id}`);
    const panel = document.getElementById(`settings-panel-${id}`);
    if (!section || !trigger || !panel) return;

    const shouldOpen = forceOpen === null ? !this.openSections.has(id) : Boolean(forceOpen);
    if (shouldOpen) this.openSections.add(id);
    else this.openSections.delete(id);
    section.classList.toggle('is-open', shouldOpen);
    trigger.setAttribute('aria-expanded', String(shouldOpen));
    panel.hidden = !shouldOpen;
  },

  openGuideSection() {
    this.pendingSection = 'guide';
    App.navigateTo('settings');
  },

  revealPendingSection() {
    const sectionId = this.pendingSection;
    if (!sectionId) return;
    this.pendingSection = null;
    requestAnimationFrame(() => {
      this.toggleSection(sectionId, true);
      const section = document.getElementById(`settings-${sectionId}-section`);
      const trigger = document.getElementById(`settings-trigger-${sectionId}`);
      section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      trigger?.focus({ preventScroll: true });
    });
  },

  applyGuidePlaylist(response) {
    const latestVideos = response?.data?.videos;
    if (!Array.isArray(latestVideos) || latestVideos.length === 0) return;
    const normalizedVideos = latestVideos
      .filter(video => /^[A-Za-z0-9_-]{11}$/.test(video.id || ''))
      .slice(0, 100)
      .map(video => ({
        id: video.id,
        title: String(video.title || 'Video hướng dẫn'),
        duration: String(video.duration || ''),
      }));
    if (!normalizedVideos.length) return;
    this.guideVideos = normalizedVideos;
    this.supportLinks.youtubeEmbed = this.youtubeEmbedUrl(normalizedVideos[0].id, 1);
  },

  youtubeEmbedUrl(videoId, index = 1, autoplay = false) {
    const origin = window.location.origin;
    const params = new URLSearchParams({
      list: 'PLaySyj8jDkR0',
      index: String(index),
      rel: '0',
      playsinline: '1',
      enablejsapi: '1',
      origin,
      widget_referrer: `${origin}/`,
    });
    if (autoplay) params.set('autoplay', '1');
    return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
  },

  youtubeVideoUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}&list=PLaySyj8jDkR0`;
  },

  renderGuideSettings() {
    const firstVideoId = this.guideVideos[0]?.id || 'upamGjVXw20';
    const firstEmbedUrl = this.supportLinks.youtubeEmbed || this.youtubeEmbedUrl(firstVideoId, 1);
    const videoItems = this.guideVideos.map((video, index) => `
      <button class="account-playlist-item${index === 0 ? ' is-active' : ''}"
              type="button"
              data-guide-video="${video.id}"
              aria-current="${index === 0 ? 'true' : 'false'}"
              onclick="Settings.selectGuideVideo('${video.id}', ${index + 1}, this)">
        <span class="account-playlist-thumb">
          <img src="https://i.ytimg.com/vi/${video.id}/mqdefault.jpg"
               alt="" loading="lazy" referrerpolicy="no-referrer">
          <span class="account-playlist-number">${String(index + 1).padStart(2, '0')}</span>
          ${video.duration ? `<small>${this.escapeHtml(video.duration)}</small>` : ''}
        </span>
        <span class="account-playlist-copy">
          <strong>${this.escapeHtml(video.title)}</strong>
          <span>${index === 0 ? 'Đang phát' : `Video ${index + 1}`}</span>
        </span>
        <span class="account-playlist-play" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m9 7 8 5-8 5z"/></svg>
        </span>
      </button>
    `).join('');

    return `
      <div class="settings-guide-stack">
        <section class="account-update-card" aria-labelledby="settings-update-title">
          <div class="account-update-orbit" aria-hidden="true"></div>
          <div class="account-update-content">
            <div class="account-update-eyebrow">
              <span class="account-update-pulse" aria-hidden="true"></span>
              Kênh cập nhật chính thức
            </div>
            <h2 id="settings-update-title">Cập nhật phiên bản mới</h2>
            <p>Tool tự kiểm tra bản phát hành chính thức và chỉ hiện thông báo nhỏ khi có bản mới. Dữ liệu, profile và license trên máy vẫn được giữ nguyên.</p>
            <div class="account-update-steps">
              <div class="account-update-step">
                <span>01</span>
                <div><strong>Tự kiểm tra</strong><small>Kiểm tra khi mở tool và lặp lại mỗi 6 giờ.</small></div>
              </div>
              <div class="account-update-step">
                <span>02</span>
                <div><strong>Bạn chủ động chọn</strong><small>Có thể cập nhật ngay hoặc bấm Để sau, không bị ép nâng cấp.</small></div>
              </div>
              <div class="account-update-step">
                <span>03</span>
                <div><strong>Tự tải &amp; cài</strong><small>Tool tải, cài bản mới rồi tự mở lại.</small></div>
              </div>
            </div>
          </div>
          <div class="account-update-action">
            <div class="account-update-version">Trạng thái phiên bản</div>
            <button class="account-update-button" type="button" onclick="Updater.openSettingsUpdate(this)">
              <span>Kiểm tra bản mới</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6"/>
              </svg>
            </button>
            <small>Bạn vẫn có thể tiếp tục sử dụng tool và cập nhật sau.</small>
          </div>
        </section>

        <section class="account-guide-card" aria-labelledby="settings-guide-title">
          <div class="account-guide-heading">
            <span class="account-guide-kicker">Playlist hướng dẫn</span>
            <h2 id="settings-guide-title">Xem thao tác trực tiếp trên tool</h2>
            <p>Chọn video trong danh sách để xem ngay, không cần rời khỏi tool.</p>
          </div>
          <div class="account-guide-viewer">
            <section class="account-video-panel" aria-labelledby="settings-video-panel-title">
              <div class="account-video-heading">
                <div>
                  <small>Video đang phát</small>
                  <strong id="settings-video-panel-title">${this.escapeHtml(this.guideVideos[0]?.title || 'SUPER POST KING')}</strong>
                </div>
                <span aria-hidden="true">▶</span>
              </div>
              <div class="account-video-frame">
                <iframe
                  id="settings-guide-player"
                  src="${firstEmbedUrl}"
                  title="Playlist hướng dẫn sử dụng Super Post"
                  loading="eager"
                  referrerpolicy="origin-when-cross-origin"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowfullscreen></iframe>
                <a class="account-video-fallback" id="settings-guide-external"
                   href="${this.youtubeVideoUrl(firstVideoId)}"
                   target="_blank" rel="noopener noreferrer">
                  Mở trên YouTube <span aria-hidden="true">↗</span>
                </a>
              </div>
            </section>
            <aside class="account-playlist" aria-label="Danh sách video hướng dẫn">
              <div class="account-playlist-heading">
                <div>
                  <small>Học nhanh cùng King Tool AI</small>
                  <strong>Danh sách video</strong>
                </div>
                <span>${this.guideVideos.length} bài</span>
              </div>
              <div class="account-playlist-list">${videoItems}</div>
            </aside>
          </div>
          <a class="account-guide-open" href="${this.supportLinks.youtube}" target="_blank" rel="noopener noreferrer">
            Xem toàn bộ playlist trên YouTube <span aria-hidden="true">↗</span>
          </a>
        </section>

        <div class="account-support-row">
          <a class="account-support-card account-support-docs"
             href="${this.supportLinks.docs}" target="_blank" rel="noopener noreferrer">
            <span class="account-support-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7zM14 3v5h5M10 12h5M10 16h5"/></svg>
            </span>
            <span class="account-support-copy">
              <small>Tài liệu đầy đủ</small>
              <strong>Hướng dẫn Google Docs</strong>
              <span>Tra cứu nhanh từng bước, lưu ý và cách xử lý lỗi thường gặp.</span>
            </span>
            <span class="account-support-arrow" aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    `;
  },

  selectGuideVideo(videoId, index, button) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    const player = document.getElementById('settings-guide-player');
    if (!player) return;

    player.src = this.youtubeEmbedUrl(videoId, index, true);
    const externalLink = document.getElementById('settings-guide-external');
    if (externalLink) externalLink.href = this.youtubeVideoUrl(videoId);
    const videoTitle = document.getElementById('settings-video-panel-title');
    const selectedVideo = this.guideVideos.find(video => video.id === videoId);
    if (videoTitle && selectedVideo) videoTitle.textContent = selectedVideo.title;
    document.querySelectorAll('#settings-guide-section .account-playlist-item').forEach(item => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-current', active ? 'true' : 'false');
      const label = item.querySelector('.account-playlist-copy > span');
      if (label) {
        const itemIndex = this.guideVideos.findIndex(video => video.id === item.dataset.guideVideo);
        label.textContent = active ? 'Đang phát' : `Video ${itemIndex + 1}`;
      }
    });
  },

  msToSeconds(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed / 1000 : fallback;
  },

  showInteractionDelayModal() {
    const s = this.settings;
    const body = `
      <div class="config-popup-heading">
        <div>
          <strong>Tốc độ thao tác đăng bài</strong>
          <span>Dùng chung cho Facebook, TikTok, YouTube, Threads, Instagram, X và Zalo Video</span>
        </div>
        <label class="toggle">
          <input type="checkbox" id="interaction-delay-enabled"
                 ${s.interaction_delay_enabled !== '0' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="config-popup-block">
        <div class="config-popup-label">Chế độ</div>
        <div class="config-preset-row interaction-preset-row">
          <button type="button" data-interaction-preset="fast"
                  onclick="Settings.applyInteractionPreset('fast')">Nhanh</button>
          <button type="button" data-interaction-preset="balanced"
                  onclick="Settings.applyInteractionPreset('balanced')">Cân bằng</button>
          <button type="button" data-interaction-preset="slow"
                  onclick="Settings.applyInteractionPreset('slow')">Chậm</button>
          <button type="button" data-interaction-preset="custom"
                  onclick="Settings.applyInteractionPreset('custom')">Tùy chỉnh</button>
        </div>
      </div>
      <input type="hidden" id="interaction-delay-preset"
             value="${this.escapeHtml(s.interaction_delay_preset || 'balanced')}">
      <div class="config-range-grid interaction-config-grid">
        ${this.interactionRangeFields(
          'Delay giữa mỗi thao tác',
          'interaction-action',
          this.msToSeconds(s.interaction_delay_min_ms, 0.8),
          this.msToSeconds(s.interaction_delay_max_ms, 2.2),
          'giây',
          0.1
        )}
        ${this.interactionRangeFields(
          'Delay nhập từng ký tự',
          'interaction-typing',
          s.interaction_typing_min_ms || 20,
          s.interaction_typing_max_ms || 80,
          'ms',
          1
        )}
        ${this.interactionRangeFields(
          'Delay sau khi tải media',
          'interaction-media',
          this.msToSeconds(s.interaction_media_min_ms, 1),
          this.msToSeconds(s.interaction_media_max_ms, 3),
          'giây',
          0.1
        )}
        ${this.interactionRangeFields(
          'Delay trước nút Đăng',
          'interaction-publish',
          this.msToSeconds(s.interaction_before_publish_min_ms, 2),
          this.msToSeconds(s.interaction_before_publish_max_ms, 5),
          'giây',
          0.1
        )}
      </div>
      <div class="config-safe-note">
        Delay chỉ áp dụng cho click, nhập chữ, tải media và nút Đăng. Các bước lưu trạng thái,
        cập nhật link và xác minh thành công không bị làm chậm.
      </div>
    `;
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="Settings.saveInteractionDelay()">Lưu</button>
    `;
    showModal('Tốc độ thao tác đăng bài', body, footer);
    this.applyInteractionPreset(s.interaction_delay_preset || 'balanced', false);
  },

  interactionRangeFields(label, prefix, min, max, unit, step) {
    return `
      <label class="config-range-field">${this.escapeHtml(label)}
        <span>
          <input type="number" class="form-input" id="${prefix}-min"
                 value="${this.escapeHtml(min)}" min="0" step="${step}">
          <b>–</b>
          <input type="number" class="form-input" id="${prefix}-max"
                 value="${this.escapeHtml(max)}" min="0" step="${step}">
          <i>${this.escapeHtml(unit)}</i>
        </span>
      </label>
    `;
  },

  applyInteractionPreset(preset, updateValues = true) {
    const presets = {
      fast: { action: [0.3, 0.9], typing: [10, 35], media: [0.5, 1.5], publish: [1, 2.5] },
      balanced: { action: [0.8, 2.2], typing: [20, 80], media: [1, 3], publish: [2, 5] },
      slow: { action: [1.5, 3.5], typing: [50, 130], media: [2, 5], publish: [4, 8] },
    };
    const selected = ['fast', 'balanced', 'slow', 'custom'].includes(preset)
      ? preset
      : 'balanced';
    const hidden = document.getElementById('interaction-delay-preset');
    if (hidden) hidden.value = selected;
    document.querySelectorAll('[data-interaction-preset]').forEach(button =>
      button.classList.toggle('active', button.dataset.interactionPreset === selected)
    );
    if (!updateValues || selected === 'custom') return;
    const values = presets[selected];
    for (const [prefix, range] of Object.entries({
      'interaction-action': values.action,
      'interaction-typing': values.typing,
      'interaction-media': values.media,
      'interaction-publish': values.publish,
    })) {
      document.getElementById(`${prefix}-min`).value = range[0];
      document.getElementById(`${prefix}-max`).value = range[1];
    }
  },

  _interactionRange(prefix, multiplier, maxAllowed) {
    const min = Number(document.getElementById(`${prefix}-min`)?.value);
    const max = Number(document.getElementById(`${prefix}-max`)?.value);
    if (!Number.isFinite(min) || !Number.isFinite(max)
      || min < 0 || max < min || max * multiplier > maxAllowed) {
      throw new Error(`Khoảng ${prefix.replace('interaction-', '')} không hợp lệ`);
    }
    return [String(Math.round(min * multiplier)), String(Math.round(max * multiplier))];
  },

  async saveInteractionDelay() {
    try {
      const action = this._interactionRange('interaction-action', 1000, 15000);
      const typing = this._interactionRange('interaction-typing', 1, 1000);
      const media = this._interactionRange('interaction-media', 1000, 30000);
      const publish = this._interactionRange('interaction-publish', 1000, 30000);
      const settings = {
        interaction_delay_enabled: document.getElementById('interaction-delay-enabled')?.checked ? '1' : '0',
        interaction_delay_preset: document.getElementById('interaction-delay-preset')?.value || 'custom',
        interaction_delay_min_ms: action[0],
        interaction_delay_max_ms: action[1],
        interaction_typing_min_ms: typing[0],
        interaction_typing_max_ms: typing[1],
        interaction_media_min_ms: media[0],
        interaction_media_max_ms: media[1],
        interaction_before_publish_min_ms: publish[0],
        interaction_before_publish_max_ms: publish[1],
      };
      await api('/api/settings', { method: 'PUT', body: settings });
      this.settings = { ...this.settings, ...settings };
      closeModal();
      this.render();
      showToast('Đã lưu tốc độ thao tác đăng bài', 'success');
    } catch (error) {
      showToast(error.message, 'warning');
    }
  },

  renderTelegramSettings() {
    const value = this.telegramSettings || {
      enabled: false,
      statuses: ['success', 'error'],
      template: '🔔 {{status}}\n\nNền tảng: {{platform}}\nProfile: {{profile}}\nHàng dữ liệu: {{row}}\nThời gian: {{time}}\n\n{{detail}}',
      hasToken: false,
      connected: false,
      chats: [],
      bot: null,
      controlEnabled: false,
      controlAiEnabled: true,
    };
    const statuses = Array.isArray(value.statuses) ? value.statuses : ['success', 'error'];
    const options = [
      ['success', '✅', 'Thành công'],
      ['error', '❌', 'Lỗi'],
      ['running', '🔄', 'Đang chạy'],
      ['pending', '⏳', 'Đang chờ'],
      ['waiting_approval', '🕒', 'Chờ duyệt'],
      ['skipped', '⏭️', 'Bỏ qua'],
      ['blocked', '🚫', 'Bị chặn'],
    ];
    const chatOptions = (value.chats || []).map(chat => `
      <label class="telegram-chat-option">
        <input type="checkbox" value="${this.escapeHtml(chat.id)}" ${value.chatIds?.includes(chat.id) || value.chatIds?.includes(Number(chat.id)) ? 'checked' : ''}>
        <span>${this.escapeHtml(chat.title || `Chat ${chat.id}`)}</span>
      </label>
    `).join('');
    const connectionLabel = value.connected
      ? `Đã kết nối${value.bot?.username ? ` · @${this.escapeHtml(value.bot.username)}` : ''}`
      : value.waitingForStart ? 'Mở bot và bấm Start để nhận chat' : 'Chưa kết nối';
    return `
      <div class="telegram-settings-card">
        <div class="telegram-settings-head">
          <div>
            <strong>Thông báo Telegram</strong>
            <small>Chỉ gửi khi trạng thái đã được lưu</small>
          </div>
          <label class="toggle" title="Bật hoặc tắt thông báo">
            <input type="checkbox" id="telegram-enabled" ${value.enabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="telegram-token-row">
          <input type="password" class="form-input" id="telegram-token"
                 placeholder="${value.tokenHint ? `Đã lưu ${this.escapeHtml(value.tokenHint)}` : 'Bot Token'}"
                 autocomplete="off">
          <button type="button" class="btn btn-primary btn-sm" onclick="Settings.connectTelegram()">Kết nối</button>
        </div>
        <div class="telegram-connection-state ${value.connected ? 'is-connected' : ''}">
          <span class="telegram-state-dot"></span>
          <span>${connectionLabel}</span>
          ${value.bot?.username ? `<a href="https://t.me/${encodeURIComponent(value.bot.username)}" target="_blank" rel="noopener noreferrer">Mở bot</a>` : ''}
          ${value.hasToken ? '<button type="button" class="btn btn-ghost btn-sm" onclick="Settings.disconnectTelegram()">Ngắt</button>' : ''}
        </div>
        ${value.chats?.length > 1 ? `
          <div class="telegram-chat-list">
            <span class="telegram-subtitle">Chat nhận thông báo</span>
            ${chatOptions}
          </div>
        ` : ''}
        <div class="telegram-status-heading">
          <span>Trạng thái</span>
          <div>
            <button type="button" class="btn btn-ghost btn-sm" onclick="Settings.selectTelegramStatuses(true)">Tất cả</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="Settings.selectTelegramStatuses(false)">Bỏ chọn</button>
          </div>
        </div>
        <div class="telegram-status-list">
          ${options.map(([key, icon, label]) => `
            <label class="telegram-status-option">
              <input type="checkbox" name="telegram-status" value="${key}" ${statuses.includes(key) ? 'checked' : ''}>
              <span class="telegram-status-icon">${icon}</span><span>${label}</span>
            </label>
          `).join('')}
        </div>
        <div class="telegram-template-row">
          <div>
            <span class="telegram-subtitle">Mẫu thông báo</span>
            <small>${this.escapeHtml((value.template || '').split(/\r?\n/)[0] || 'Mẫu mặc định')}</small>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="Settings.showTelegramTemplateModal()">Chỉnh mẫu</button>
        </div>
        <div class="telegram-actions">
          <button type="button" class="btn btn-secondary btn-sm" onclick="Settings.testTelegram()">Gửi thử</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="Settings.saveTelegramSettings()">Lưu</button>
          <span id="telegram-save-status" class="telegram-save-status"></span>
        </div>
        <div class="telegram-control-box">
          <div class="telegram-control-head">
            <div>
              <strong>Điều khiển tool</strong>
              <small>Dùng cùng bot này</small>
            </div>
            <label class="toggle">
              <input type="checkbox" id="telegram-control-enabled" ${value.controlEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <label class="telegram-ai-control">
            <input type="checkbox" id="telegram-control-ai-enabled" ${value.controlAiEnabled !== false ? 'checked' : ''}>
            <span>Cho phép AI hiểu câu lệnh tự nhiên</span>
          </label>
          <div class="telegram-control-actions">
            <button type="button" class="btn btn-ghost btn-sm" onclick="Settings.sendTelegramMenu()">Mở menu Telegram</button>
            <span>Đăng bài · Báo cáo · Trạng thái</span>
          </div>
        </div>
      </div>
    `;
  },

  selectTelegramStatuses(selectAll) {
    document.querySelectorAll('input[name="telegram-status"]').forEach(input => { input.checked = Boolean(selectAll); });
  },

  async connectTelegram() {
    const token = document.getElementById('telegram-token')?.value.trim();
    if (!token && this.telegramSettings?.hasToken) {
      await this.refreshTelegramStatus();
      return;
    }
    if (!token) {
      showToast('Hãy nhập Bot Token Telegram', 'warning');
      return;
    }
    try {
      const result = await api('/api/telegram/connect', { method: 'POST', body: { token } });
      this.telegramSettings = result.data;
      showToast('Đã kết nối bot. Mở bot và bấm Start để nhận chat.', 'success');
      this.render();
      this.pendingSection = 'telegram';
      requestAnimationFrame(() => this.toggleSection('telegram', true));
    } catch (error) {}
  },

  async refreshTelegramStatus() {
    try {
      const result = await api('/api/telegram/status');
      this.telegramSettings = result.data;
      this.render();
      this.pendingSection = 'telegram';
      requestAnimationFrame(() => this.toggleSection('telegram', true));
    } catch (error) {}
  },

  async saveTelegramSettings(options = {}) {
    const statuses = [...document.querySelectorAll('input[name="telegram-status"]:checked')].map(input => input.value);
    if (!statuses.length) {
      showToast('Chọn ít nhất một trạng thái', 'warning');
      return null;
    }
    const chatInputs = [...document.querySelectorAll('.telegram-chat-option input')];
    const chatIds = chatInputs.length
      ? chatInputs.filter(input => input.checked).map(input => Number(input.value)).filter(Number.isFinite)
      : undefined;
    try {
      const result = await api('/api/telegram/settings', {
        method: 'PUT',
        body: {
          enabled: Boolean(document.getElementById('telegram-enabled')?.checked),
          statuses,
          template: this.telegramSettings?.template,
          ...(chatIds ? { chatIds } : {}),
          controlEnabled: Boolean(document.getElementById('telegram-control-enabled')?.checked),
          controlAiEnabled: Boolean(document.getElementById('telegram-control-ai-enabled')?.checked),
        },
      });
      this.telegramSettings = result.data;
      if (!options.silent) {
        showToast('Đã lưu thông báo Telegram', 'success');
        this.render();
        this.pendingSection = 'telegram';
        requestAnimationFrame(() => this.toggleSection('telegram', true));
      }
      return result.data;
    } catch (error) {
      return null;
    }
  },

  async disconnectTelegram() {
    if (!confirm('Ngắt kết nối Telegram trên máy này?')) return;
    try {
      const result = await api('/api/telegram/disconnect', { method: 'POST' });
      this.telegramSettings = result.data;
      showToast('Đã ngắt Telegram', 'success');
      this.render();
    } catch (error) {}
  },

  async testTelegram() {
    const saved = await this.saveTelegramSettings({ silent: true });
    if (!saved) return;
    try {
      await api('/api/telegram/test', { method: 'POST' });
      showToast('Đã gửi thông báo thử', 'success');
    } catch (error) {}
  },

  async sendTelegramMenu() {
    try {
      await api('/api/telegram/menu', { method: 'POST' });
      showToast('Đã gửi menu điều khiển vào Telegram', 'success');
    } catch (error) {}
  },

  showTelegramTemplateModal() {
    const template = this.telegramSettings?.template || '🔔 {{status}}\n\nNền tảng: {{platform}}\nProfile: {{profile}}\nHàng dữ liệu: {{row}}\nThời gian: {{time}}\n\n{{detail}}';
    const variables = ['status', 'status_icon', 'platform', 'profile', 'row', 'time', 'link', 'error', 'content', 'detail'];
    const body = `
      <div class="telegram-template-editor">
        <div class="telegram-template-block">
          <div class="telegram-template-label">
            <span>Nội dung thông báo</span>
            <small>Tự bỏ qua dòng không có dữ liệu</small>
          </div>
          <textarea id="telegram-template-input" class="form-input" rows="7" wrap="soft">${this.escapeHtml(template)}</textarea>
        </div>
        <div class="telegram-template-block telegram-template-variables">
          <div class="telegram-template-label"><span>Chèn thông tin</span></div>
          <div class="telegram-variable-chips">
            ${variables.map(variable => `<button type="button" class="telegram-variable-chip" onclick="Settings.insertTelegramVariable('${variable}')">{{${variable}}}</button>`).join('')}
          </div>
        </div>
        <div class="telegram-template-block telegram-template-preview">
          <div class="telegram-template-label"><span>Xem trước</span><i></i></div>
          <pre id="telegram-template-preview">${this.escapeHtml(this.previewTelegramTemplate(template))}</pre>
        </div>
      </div>
    `;
    const footer = `
      <button class="btn btn-ghost" onclick="Settings.resetTelegramTemplate()">Mặc định</button>
      <span style="flex:1"></span>
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="Settings.applyTelegramTemplate()">Áp dụng</button>
    `;
    showModal('Mẫu thông báo Telegram', body, footer);
    document.getElementById('modal')?.classList.add('telegram-template-modal');
    const input = document.getElementById('telegram-template-input');
    input?.addEventListener('input', () => {
      const preview = document.getElementById('telegram-template-preview');
      if (preview) preview.textContent = this.previewTelegramTemplate(input.value);
    });
  },

  previewTelegramTemplate(template) {
    return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => ({
      status: 'Thành công',
      platform: 'Facebook',
      profile: 'super-1',
      row: '1',
      time: new Date().toLocaleString('vi-VN'),
      link: 'https://example.com/post',
      error: 'Nội dung mẫu',
      content: 'Nội dung mẫu',
      detail: 'https://example.com/post',
    }[key.toLowerCase()] || ''));
  },

  insertTelegramVariable(variable) {
    const input = document.getElementById('telegram-template-input');
    if (!input) return;
    const token = `{{${variable}}}`;
    const start = input.selectionStart || input.value.length;
    input.value = `${input.value.slice(0, start)}${token}${input.value.slice(input.selectionEnd || start)}`;
    input.focus();
    input.selectionStart = input.selectionEnd = start + token.length;
    document.getElementById('telegram-template-preview').textContent = this.previewTelegramTemplate(input.value);
  },

  resetTelegramTemplate() {
    const input = document.getElementById('telegram-template-input');
    if (!input) return;
    input.value = '🔔 {{status}}\n\nNền tảng: {{platform}}\nProfile: {{profile}}\nHàng dữ liệu: {{row}}\nThời gian: {{time}}\n\n{{detail}}';
    input.dispatchEvent(new Event('input'));
  },

  applyTelegramTemplate() {
    const template = document.getElementById('telegram-template-input')?.value.trim();
    if (!template) {
      showToast('Mẫu thông báo không được để trống', 'warning');
      return;
    }
    this.telegramSettings = { ...(this.telegramSettings || {}), template };
    closeModal();
    this.render();
    this.pendingSection = 'telegram';
    requestAnimationFrame(() => this.toggleSection('telegram', true));
    showToast('Đã cập nhật mẫu thông báo', 'success');
  },

  renderGoogleSheetsSettings() {
    const value = this.googleSheetsSettings || {
      hasCredentials: false,
      clientEmail: '',
      projectId: '',
      credentialFileName: '',
      spreadsheetUrl: '',
      autoEnabled: false,
      autoInterval: 15,
      autoDirection: 'push',
      lastResult: null,
    };
    const connected = value.hasCredentials && value.spreadsheetId;
    const statusText = connected ? 'Đã cấu hình' : 'Chưa kết nối';
    const lastResult = value.lastResult;
    const lastResultText = lastResult
      ? `${lastResult.success ? 'Thành công' : 'Có lỗi'} · ${formatDate(lastResult.at)}${lastResult.error ? ` · ${this.escapeHtml(lastResult.error)}` : ''}`
      : 'Chưa đồng bộ lần nào';

    return `
      <div class="settings-section google-sheets-section">
        <div class="card google-sheets-card google-sheets-compact">
          <div class="google-sheets-compact-head">
            <div>
              <h3><span>☁</span> Đồng bộ Google Sheets</h3>
              <p>Dữ liệu mỗi nền tảng được đồng bộ vào một tab riêng.</p>
            </div>
            <span class="google-sheets-state ${connected ? 'is-connected' : ''}">
              <i></i>${statusText}
            </span>
          </div>

          <div class="google-sheets-compact-grid">
            <section class="google-sheets-compact-panel google-sheets-connection-panel">
              <div class="google-sheets-panel-head">
                <div>
                  <strong>Kết nối</strong>
                  <span>JSON quyền và Google Sheet dùng chung</span>
                </div>
              </div>

              <input type="file" id="google-sheets-json-file" accept=".json,application/json"
                     hidden onchange="Settings.handleGoogleCredentialsFile(event)">
              <div class="google-sheets-connection-row">
                <button type="button" class="google-sheets-file-button"
                        onclick="document.getElementById('google-sheets-json-file').click()">
                  <span>＋</span>
                  <div>
                    <strong>${value.hasCredentials ? 'Thay JSON' : 'Chọn JSON'}</strong>
                    <small id="google-sheets-file-name">${this.escapeHtml(value.credentialFileName || 'Chưa chọn file')}</small>
                  </div>
                </button>
                <div class="google-sheets-account" id="google-sheets-account">
                  <span>Email chia sẻ Sheet</span>
                  <code>${this.escapeHtml(value.clientEmail || 'Hiện sau khi chọn JSON')}</code>
                </div>
              </div>

              <label class="google-sheets-link-field" for="google-sheets-url">
                <span>Link hoặc ID Google Sheets</span>
                <input type="text" class="form-input" id="google-sheets-url"
                       value="${this.escapeHtml(value.spreadsheetUrl || value.spreadsheetId || '')}"
                       placeholder="https://docs.google.com/spreadsheets/d/.../edit">
              </label>

              <div class="google-sheets-actions">
                <button type="button" class="btn btn-primary btn-sm"
                        onclick="Settings.saveGoogleSheetsSettings()">Lưu</button>
                <button type="button" class="btn btn-secondary btn-sm" id="google-sheets-test-btn"
                        onclick="Settings.testGoogleSheetsConnection()">Kiểm tra</button>
                ${value.hasCredentials ? `
                  <button type="button" class="btn btn-ghost btn-sm google-sheets-disconnect"
                          onclick="Settings.removeGoogleSheetsCredentials()">Ngắt JSON</button>
                ` : ''}
                <span class="google-sheets-test-status" id="google-sheets-test-status">Chưa kiểm tra</span>
              </div>
              <p class="google-sheets-compact-note">Chia sẻ Sheet cho email Service Account với quyền <b>Editor</b>.</p>
            </section>

            <section class="google-sheets-compact-panel google-sheets-sync-panel">
              <div class="google-sheets-panel-head">
                <div>
                  <strong>Đồng bộ</strong>
                  <span>Tự động hoặc chạy thủ công toàn bộ dữ liệu</span>
                </div>
                <label class="google-sheets-auto-toggle">
                  <span>Tự động</span>
                  <span class="toggle">
                    <input type="checkbox" id="google-sheets-auto-enabled" ${value.autoEnabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                  </span>
                </label>
              </div>

              <div class="google-sheets-sync-row">
                <label>
                  <span>Chu kỳ</span>
                  <select class="form-select" id="google-sheets-auto-interval">
                    ${[1, 5, 15, 30, 60].map(minutes => `
                      <option value="${minutes}" ${Number(value.autoInterval) === minutes ? 'selected' : ''}>
                        ${minutes} phút
                      </option>
                    `).join('')}
                  </select>
                </label>
                <label>
                  <span>Hướng tự động</span>
                  <select class="form-select" id="google-sheets-auto-direction">
                    <option value="push" ${value.autoDirection === 'push' ? 'selected' : ''}>Tool → Sheet</option>
                    <option value="pull" ${value.autoDirection === 'pull' ? 'selected' : ''}>Sheet → Tool</option>
                    <option value="two_way" ${value.autoDirection === 'two_way' ? 'selected' : ''}>Hai chiều</option>
                  </select>
                </label>
              </div>

              <div class="google-sheets-manual-buttons">
                <button type="button" class="btn btn-secondary btn-sm"
                        onclick="Settings.syncAllGoogleSheets('push')">Đẩy lên</button>
                <button type="button" class="btn btn-secondary btn-sm"
                        onclick="Settings.syncAllGoogleSheets('pull')">Lấy về</button>
                <button type="button" class="btn btn-secondary btn-sm"
                        onclick="Settings.syncAllGoogleSheets('two_way')">Hai chiều</button>
              </div>

              <div class="google-sheets-last-result">
                <span>Lần gần nhất</span>
                <strong id="google-sheets-last-result">${lastResultText}</strong>
              </div>
              <p class="google-sheets-compact-note">Tự động không xóa dữ liệu. Xóa hàng Sheet tại nút <b>☁ Sheet</b> trên bảng.</p>
            </section>
          </div>
        </div>
      </div>
    `;
  },

  renderAiSettings() {
    const settings = this.aiSettings || {
      activeProvider: 'gemini',
      providers: {
        gemini: { model: 'gemini-2.5-flash', baseUrl: '', hasApiKey: false, apiKeyHint: '' },
        openai: { model: 'gpt-4.1-mini', baseUrl: '', hasApiKey: false, apiKeyHint: '' },
        '9router': { model: '', baseUrl: 'http://127.0.0.1:20128/v1', hasApiKey: false, apiKeyHint: '' },
        kira: {
          model: 'kira-3.5-flash',
          imageModel: 'kira-3.0-image',
          aspectRatio: '1:1',
          baseUrl: 'https://kiraai.vn/api/v1',
          hasApiKey: false,
          apiKeyHint: '',
        },
        chatgpt: { model: 'Tự động theo ChatGPT', configured: true, authMode: 'chatgpt' },
      },
    };
    const providers = [
      { id: 'gemini', name: 'Gemini', mark: '✦', desc: 'Google AI' },
      { id: 'openai', name: 'OpenAI', mark: '◎', desc: 'OpenAI API' },
      { id: '9router', name: '9Router', mark: '↗', desc: 'OpenAI-compatible' },
      { id: 'kira', name: 'Kira AI', mark: '◆', desc: 'Text & Image API' },
      { id: 'chatgpt', name: 'ChatGPT', mark: '◉', desc: 'Tài khoản trong app' },
    ];
    const kiraTextModels = [
      'kira-mini-1.0',
      'kira-3.5-pro',
      'kira-3.5-flash',
      'kira-2.5-pro',
      'kira-2.5-flash',
    ];
    const kiraImageModels = ['kira-3.0-image', 'kira-2.0-image'];
    const selected = providers.some(item => item.id === this.aiProvider)
      ? this.aiProvider
      : 'gemini';
    this.aiProvider = selected;

    const tabs = providers.map(item => {
      const value = settings.providers?.[item.id] || {};
      const configured = item.id === 'chatgpt' ? value.configured !== false : value.hasApiKey;
      return `
        <button type="button" class="ai-provider-card ${selected === item.id ? 'active' : ''}"
                data-ai-provider="${item.id}" onclick="Settings.selectAiProvider('${item.id}')">
          <span class="ai-provider-mark">${item.mark}</span>
          <span class="ai-provider-copy">
            <b>${item.name}</b>
            <small>${item.desc}</small>
          </span>
          <span class="ai-provider-dot ${configured ? 'configured' : ''}"
                title="${item.id === 'chatgpt' ? 'Dùng phiên đăng nhập ChatGPT trên máy' : (value.hasApiKey ? 'Đã lưu API key' : 'Chưa cấu hình')}"></span>
        </button>
      `;
    }).join('');

    const panels = providers.map(item => {
      const value = settings.providers?.[item.id] || {};
      if (item.id === 'chatgpt') {
        return `
          <div class="ai-provider-panel ${selected === item.id ? 'active' : ''}" data-ai-panel="${item.id}">
            <div class="ai-chatgpt-local-card">
              <div>
                <strong>ChatGPT trong app OpenAI</strong>
                <p>Không cần API key. Tool dùng Codex CLI đã đăng nhập bằng ChatGPT và tự chọn model phù hợp.</p>
              </div>
              <span class="ai-local-model">${this.escapeHtml(value.model || 'Tự động theo ChatGPT')}</span>
            </div>
            <div class="form-group ai-cli-path-field">
              <label class="form-label" for="ai-codex-path-chatgpt">Đường dẫn Codex CLI</label>
              <div class="ai-cli-path-row">
                <input type="text" class="form-input" id="ai-codex-path-chatgpt"
                       value="${this.escapeHtml(value.cliPath || '')}"
                       placeholder="Để trống để tự dò từ PATH, hoặc nhập C:\\...\\codex.exe / codex.cmd">
                <button type="button" class="btn btn-secondary btn-sm" onclick="Settings.detectCodexPath()">
                  Tự động tìm
                </button>
                <button type="button" class="btn btn-ghost btn-sm" onclick="Settings.openCodexConfig()">
                  Mở .codex
                </button>
              </div>
              <span class="ai-field-note">Có thể nhập đường dẫn file hoặc thư mục chứa Codex. Mỗi máy được lưu riêng.</span>
              <details class="ai-codex-reference">
                <summary>Đường dẫn thủ công trong thư mục .codex</summary>
                <div><span>Thư mục mặc định</span><code>%USERPROFILE%\\.codex\\</code></div>
                <div><span>Cấu hình chung</span><code>%USERPROFILE%\\.codex\\config.toml</code></div>
                <div><span>Thông tin xác thực</span><code>%USERPROFILE%\\.codex\\auth.json</code></div>
                <div><span>Lịch sử lệnh</span><code>%USERPROFILE%\\.codex\\history.jsonl</code></div>
                <div><span>Phiên làm việc</span><code>%USERPROFILE%\\.codex\\sessions\\YYYY\\MM\\DD\\rollout-*.jsonl</code></div>
                <p>Không chia sẻ hoặc chỉnh sửa <code>auth.json</code>; tệp này có thể chứa thông tin đăng nhập.</p>
              </details>
            </div>
            <div class="ai-config-actions">
              <button type="button" class="btn btn-secondary btn-sm"
                      id="ai-test-btn-${item.id}" onclick="Settings.testAiConnection('${item.id}')">
                Kiểm tra đăng nhập
              </button>
              <span class="ai-connection-status" id="ai-test-status-${item.id}">Chưa kiểm tra</span>
            </div>
          </div>
        `;
      }
      const hint = value.hasApiKey
        ? `Đã lưu API key ••••${this.escapeHtml(value.apiKeyHint || '')}`
        : 'Nhập API key';
      const modelField = item.id === 'kira' ? `
        <div class="form-group">
          <label class="form-label" for="ai-model-${item.id}">Model text</label>
          <select class="form-select" id="ai-model-${item.id}">
            ${kiraTextModels.map(model => `
              <option value="${model}" ${value.model === model ? 'selected' : ''}>${model}</option>
            `).join('')}
          </select>
          <span class="ai-field-note">Dùng để viết lại nội dung trong bảng dữ liệu.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="ai-image-model-${item.id}">Model tạo ảnh</label>
          <select class="form-select" id="ai-image-model-${item.id}">
            ${kiraImageModels.map(model => `
              <option value="${model}" ${value.imageModel === model ? 'selected' : ''}>${model}</option>
            `).join('')}
          </select>
          <span class="ai-field-note">Dùng cho nút Ảnh AI và tự cập nhật Media.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="ai-aspect-ratio-${item.id}">Tỷ lệ ảnh mặc định</label>
          <select class="form-select" id="ai-aspect-ratio-${item.id}">
            ${['1:1', '16:9', '9:16', '4:3', '3:4'].map(ratio => `
              <option value="${ratio}" ${value.aspectRatio === ratio ? 'selected' : ''}>${ratio}</option>
            `).join('')}
          </select>
          <span class="ai-field-note">Có thể đổi lại trong Cài đặt trước mỗi đợt tạo ảnh.</span>
        </div>
      ` : `
        <div class="form-group">
          <label class="form-label" for="ai-model-${item.id}">Model</label>
          <input type="text" class="form-input" id="ai-model-${item.id}"
                 value="${this.escapeHtml(value.model || '')}"
                 placeholder="${item.id === '9router' ? 'Ví dụ: cc/claude-opus-4-6' : 'Tên model'}">
          <span class="ai-field-note">Model được dùng cho mọi nền tảng.</span>
        </div>
      `;
      const baseUrl = item.id === '9router' ? `
        <div class="form-group">
          <label class="form-label" for="ai-base-url-${item.id}">Base URL</label>
          <input type="text" class="form-input" id="ai-base-url-${item.id}"
                 value="${this.escapeHtml(value.baseUrl || 'http://127.0.0.1:20128/v1')}"
                 placeholder="http://127.0.0.1:20128/v1">
          <span class="ai-field-note">9Router mặc định chạy tại cổng 20128; tool chỉ gọi API ở backend.</span>
        </div>
      ` : '';
      return `
        <div class="ai-provider-panel ${selected === item.id ? 'active' : ''}" data-ai-panel="${item.id}">
          <div class="ai-config-grid">
            <div class="form-group">
              <label class="form-label" for="ai-api-key-${item.id}">API key</label>
              <div class="ai-secret-field">
                <input type="password" class="form-input" id="ai-api-key-${item.id}"
                       autocomplete="off" placeholder="${hint}">
                <button type="button" class="ai-secret-toggle"
                        onclick="Settings.toggleAiKey('${item.id}')" title="Hiện hoặc ẩn API key">◉</button>
              </div>
              <span class="ai-field-note">Để trống nếu muốn giữ nguyên key đã lưu.</span>
            </div>
            ${modelField}
            ${baseUrl}
          </div>
          <div class="ai-config-actions">
            <button type="button" class="btn btn-secondary btn-sm"
                    id="ai-test-btn-${item.id}" onclick="Settings.testAiConnection('${item.id}')">
              Kiểm tra kết nối
            </button>
            <span class="ai-connection-status" id="ai-test-status-${item.id}">Chưa kiểm tra</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="settings-section ai-settings-section">
        <div class="settings-section-title ai-settings-title">
          <span>AI nội dung & tạo ảnh</span>
          <span class="ai-global-badge">Dùng chung mọi nền tảng</span>
        </div>
        <div class="card ai-settings-card">
          <div class="ai-settings-intro">
            <div>
              <h3>Kết nối một lần, sử dụng ở mọi bảng dữ liệu</h3>
              <p>Viết lại nội dung và tạo ảnh bằng Kira API, hoặc dùng trực tiếp tài khoản ChatGPT trong app.</p>
            </div>
            <div class="ai-lock-note">API key được lưu mã hóa</div>
          </div>
          <div class="ai-provider-grid">${tabs}</div>
          <div class="ai-provider-panels">${panels}</div>
          <div class="ai-settings-footer">
            <span>ChatGPT không cần API key; Kira hỗ trợ riêng model text, model ảnh và tỷ lệ ảnh.</span>
            <button type="button" class="btn btn-primary" onclick="Settings.saveAiSettings()">
              Lưu cấu hình AI
            </button>
          </div>
        </div>
      </div>
    `;
  },

  selectAiProvider(provider) {
    this.aiProvider = provider;
    document.querySelectorAll('.ai-provider-card').forEach(element => {
      element.classList.toggle('active', element.dataset.aiProvider === provider);
    });
    document.querySelectorAll('.ai-provider-panel').forEach(element => {
      element.classList.toggle('active', element.dataset.aiPanel === provider);
    });
  },

  toggleAiKey(provider) {
    const input = document.getElementById(`ai-api-key-${provider}`);
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  },

  collectAiProviders() {
    const providers = {};
    for (const provider of ['gemini', 'openai', '9router', 'kira']) {
      const apiKey = document.getElementById(`ai-api-key-${provider}`)?.value.trim() || '';
      const model = document.getElementById(`ai-model-${provider}`)?.value.trim() || '';
      const current = this.aiSettings?.providers?.[provider] || {};
      providers[provider] = {
        model,
        baseUrl: provider === '9router'
          ? (document.getElementById(`ai-base-url-${provider}`)?.value.trim() || '')
          : current.baseUrl,
      };
      if (provider === 'kira') {
        providers[provider].imageModel =
          document.getElementById('ai-image-model-kira')?.value.trim() || '';
        providers[provider].aspectRatio =
          document.getElementById('ai-aspect-ratio-kira')?.value || '1:1';
      }
      if (apiKey) providers[provider].apiKey = apiKey;
    }
    providers.chatgpt = {
      cliPath: document.getElementById('ai-codex-path-chatgpt')?.value.trim() || '',
    };
    return providers;
  },

  async saveAiSettings({ quiet = false } = {}) {
    try {
      const result = await api('/api/ai/settings', {
        method: 'PUT',
        body: { providers: this.collectAiProviders() },
      });
      this.aiSettings = result.data;
      for (const provider of ['gemini', 'openai', '9router', 'kira']) {
        const input = document.getElementById(`ai-api-key-${provider}`);
        const value = this.aiSettings?.providers?.[provider];
        if (input) {
          input.value = '';
          input.placeholder = value?.hasApiKey
            ? `Đã lưu API key ••••${value.apiKeyHint || ''}`
            : 'Nhập API key';
        }
        const dot = document.querySelector(`[data-ai-provider="${provider}"] .ai-provider-dot`);
        if (dot) dot.classList.toggle('configured', Boolean(value?.hasApiKey));
      }
      if (!quiet) showToast('Đã lưu cấu hình AI dùng chung', 'success');
      return true;
    } catch (_) {
      return false;
    }
  },

  async testAiConnection(provider) {
    const status = document.getElementById(`ai-test-status-${provider}`);
    const button = document.getElementById(`ai-test-btn-${provider}`);
    const providers = this.collectAiProviders();
    if (status) {
      status.className = 'ai-connection-status checking';
      status.textContent = 'Đang kiểm tra...';
    }
    if (button) button.disabled = true;
    try {
      const result = await api('/api/ai/test', {
        method: 'POST',
        body: { provider, ...(providers[provider] || {}) },
      });
      if (status) {
        status.className = 'ai-connection-status success';
        status.textContent = `Kết nối thành công · ${result.data.model}`;
      }
      const labels = {
        '9router': '9Router',
        openai: 'OpenAI',
        gemini: 'Gemini',
        kira: 'Kira AI',
        chatgpt: 'ChatGPT',
      };
      showToast(`${labels[provider] || provider} kết nối thành công`, 'success');
    } catch (error) {
      if (status) {
        status.className = 'ai-connection-status error';
        status.textContent = String(error.message || 'Kết nối thất bại').slice(0, 140);
      }
    } finally {
      if (button) button.disabled = false;
    }
  },

  async detectCodexPath() {
    const input = document.getElementById('ai-codex-path-chatgpt');
    const status = document.getElementById('ai-test-status-chatgpt');
    const preferred = input?.value.trim() || '';
    if (status) {
      status.className = 'ai-connection-status checking';
      status.textContent = 'Đang tự động tìm Codex...';
    }
    try {
      const query = preferred ? `?cliPath=${encodeURIComponent(preferred)}` : '';
      const result = await apiSilent(`/api/ai/chatgpt/detect${query}`);
      if (!result.data.found) throw new Error(result.data.message);
      if (input) input.value = result.data.executable;
      await this.saveAiSettings({ quiet: true });
      if (status) {
        status.className = result.data.ready ? 'ai-connection-status success' : 'ai-connection-status checking';
        status.textContent = result.data.ready
          ? `Đã tìm thấy và đăng nhập · ${result.data.version}`
          : `Đã tìm thấy: ${result.data.executable}`;
      }
      showToast(`Đã tự động lấy đường dẫn Codex: ${result.data.executable}`, 'success', 5000);
    } catch (error) {
      if (status) {
        status.className = 'ai-connection-status error';
        status.textContent = String(error.message || 'Không tìm thấy Codex CLI').slice(0, 160);
      }
    }
  },

  async openCodexConfig() {
    try {
      const result = await apiSilent('/api/ai/chatgpt/open-config', { method: 'POST' });
      showToast(`Đã mở thư mục ${result.data.codexHome}`, 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
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

  async handleGoogleCredentialsFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('JSON phải có client_email và private_key của Service Account.');
      }
      this.googleCredentialsJson = text;
      this.googleCredentialFileName = file.name;
      const name = document.getElementById('google-sheets-file-name');
      const account = document.getElementById('google-sheets-account');
      if (name) name.textContent = file.name;
      if (account) {
        account.innerHTML = `<span>Email chia sẻ Sheet</span><code>${this.escapeHtml(parsed.client_email)}</code>`;
      }
      showToast('Đã đọc file JSON quyền. Hãy lưu cấu hình.', 'success');
    } catch (error) {
      this.googleCredentialsJson = '';
      this.googleCredentialFileName = '';
      event.target.value = '';
      showToast(error.message || 'Không đọc được file JSON quyền', 'error');
    }
  },

  async saveGoogleSheetsSettings(options = {}) {
    const urlInput = document.getElementById('google-sheets-url');
    if (!urlInput) return null;
    const payload = {
      spreadsheetUrl: urlInput.value.trim(),
      autoEnabled: Boolean(document.getElementById('google-sheets-auto-enabled')?.checked),
      autoInterval: Number(document.getElementById('google-sheets-auto-interval')?.value || 15),
      autoDirection: document.getElementById('google-sheets-auto-direction')?.value || 'push',
    };
    if (this.googleCredentialsJson) {
      payload.credentialsJson = this.googleCredentialsJson;
      payload.credentialFileName = this.googleCredentialFileName || 'service-account.json';
    }

    try {
      const result = await api('/api/google-sheets/settings', {
        method: 'PUT',
        body: payload,
      });
      this.googleSheetsSettings = result.data || null;
      this.googleCredentialsJson = '';
      this.googleCredentialFileName = '';
      if (!options.silent) {
        showToast('Đã lưu cấu hình Google Sheets', 'success');
        this.render();
      }
      return result.data;
    } catch (error) {
      return null;
    }
  },

  async testGoogleSheetsConnection() {
    const saved = await this.saveGoogleSheetsSettings({ silent: true });
    if (!saved) return;
    const button = document.getElementById('google-sheets-test-btn');
    const status = document.getElementById('google-sheets-test-status');
    if (button) button.disabled = true;
    if (status) {
      status.className = 'google-sheets-test-status is-loading';
      status.textContent = 'Đang kiểm tra...';
    }
    try {
      const result = await api('/api/google-sheets/test', { method: 'POST' });
      if (status) {
        status.className = 'google-sheets-test-status is-success';
        status.textContent = `Kết nối thành công · ${result.data.spreadsheetTitle || 'Google Sheets'}`;
      }
      showToast('Kết nối Google Sheets thành công', 'success');
    } catch (error) {
      if (status) {
        status.className = 'google-sheets-test-status is-error';
        status.textContent = error.message || 'Kết nối thất bại';
      }
    } finally {
      if (button) button.disabled = false;
    }
  },

  async removeGoogleSheetsCredentials() {
    if (!confirm('Ngắt JSON quyền Google Sheets trên máy này? Dữ liệu trên Sheet không bị xóa.')) return;
    try {
      const result = await api('/api/google-sheets/credentials', { method: 'DELETE' });
      this.googleSheetsSettings = result.data || null;
      this.googleCredentialsJson = '';
      this.googleCredentialFileName = '';
      showToast('Đã ngắt JSON quyền Google Sheets', 'success');
      this.render();
    } catch (error) {}
  },

  async syncAllGoogleSheets(action) {
    if (!this.googleSheetsSettings?.hasCredentials || !this.googleSheetsSettings?.spreadsheetId) {
      showToast('Hãy lưu JSON quyền và link Google Sheets trước', 'warning');
      return;
    }
    const labels = {
      push: 'đẩy toàn bộ dữ liệu lên Google Sheets',
      pull: 'lấy toàn bộ dữ liệu Google Sheets về tool',
      two_way: 'đồng bộ hai chiều toàn bộ dữ liệu',
    };
    if (action !== 'push' && !confirm(`Xác nhận ${labels[action]}?`)) return;
    try {
      showToast(`Đang ${labels[action]}...`, 'info');
      const result = await api('/api/google-sheets/sync-all', {
        method: 'POST',
        body: { action },
      });
      const total = (result.data || []).reduce((sum, item) => (
        sum + Number(item.total || item.pushed?.total || item.pulled?.total || 0)
      ), 0);
      showToast(`Đồng bộ Google Sheets thành công · ${total} hàng`, 'success');
      const settings = await api('/api/google-sheets/settings');
      this.googleSheetsSettings = settings.data || this.googleSheetsSettings;
      this.render();
    } catch (error) {}
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
      browser_layout_rows: document.getElementById('setting-browser-layout-rows').value || '2',
      browser_layout_columns: document.getElementById('setting-browser-layout-columns').value || '4',
      browser_window_ratio: document.getElementById('setting-browser-window-ratio').value || '1',
      profile_open_delay_ms: document.getElementById('setting-profile-open-delay-ms').value || '0',
      browser_launch_retry_count: document.getElementById('setting-browser-launch-retry-count').value || '0',
      hidden_run_enabled: document.getElementById('setting-hidden-run-enabled')?.checked ? '1' : '0',
    };

    // Validate concurrency
    const concurrency = parseInt(settings.max_concurrency);
    if (isNaN(concurrency) || concurrency < 1 || concurrency > 10) {
      showToast('Giới hạn Chrome đồng thời phải từ 1-10', 'warning');
      return;
    }

    const layoutRows = parseInt(settings.browser_layout_rows, 10);
    const layoutColumns = parseInt(settings.browser_layout_columns, 10);
    const windowRatio = Number(settings.browser_window_ratio);
    const openDelayMs = parseInt(settings.profile_open_delay_ms, 10);
    const retryCount = parseInt(settings.browser_launch_retry_count, 10);
    if (!Number.isInteger(layoutRows) || layoutRows < 1 || layoutRows > 4
      || !Number.isInteger(layoutColumns) || layoutColumns < 1 || layoutColumns > 6) {
      showToast('Bố cục cửa sổ: hàng 1-4, cột 1-6', 'warning');
      return;
    }
    if (!Number.isFinite(windowRatio) || windowRatio < 0.25 || windowRatio > 1) {
      showToast('Tỉ lệ cửa sổ phải từ 0.25 đến 1', 'warning');
      return;
    }
    if (!Number.isInteger(openDelayMs) || openDelayMs < 0 || openDelayMs > 600000) {
      showToast('Thời gian mở hồ sơ phải từ 0 đến 600000ms', 'warning');
      return;
    }
    if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 10) {
      showToast('Số lần thử lại phải từ 0 đến 10', 'warning');
      return;
    }
    settings.browser_per_screen = String(layoutRows * layoutColumns);

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
      this.settings = { ...this.settings, ...settings };
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
