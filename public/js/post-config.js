/**
 * Super Post - King - Post Config Module
 * Tab "Cấu hình": tự động bình luận sau khi đăng bài.
 */

const PostConfig = {
  settings: {},
  commentSequences: [1],

  async load() {
    const container = document.getElementById('page-postcfg');
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Đang tải cấu hình...</div></div>';

    try {
      const [settingsResult, columnsResult] = await Promise.all([
        api('/api/settings'),
        api('/api/data/columns'),
      ]);
      this.settings = settingsResult.data || {};
      const sequences = new Set([1]);
      for (const column of columnsResult.data || []) {
        const key = String(column.var_key || '');
        let match = key.match(/^comment_(\d+)$/);
        if (!match) match = key.match(/^comment_media_(\d+)$/);
        if (!match) match = key.match(/^time_comment_(\d+)$/);
        if (!match) match = key.match(/^comment_status_(\d+)$/);
        if (match && Number(match[1]) >= 2) sequences.add(Number(match[1]));
      }
      this.commentSequences = [...sequences].sort((a, b) => a - b);
    } catch (err) {
      this.settings = {};
      this.commentSequences = [1];
    }

    this.render();
  },

  render() {
    const container = document.getElementById('page-postcfg');
    const s = this.settings;
    const enabled = s.auto_comment_enabled === '1';
    const aiLabelEnabled = s.add_ai_label === '1';
    const antiBotEnabled = s.anti_bot_enabled === '1';
    const antiBotActions = `${s.anti_bot_action_min || '2'}–${s.anti_bot_action_max || '5'} thao tác`;
    const antiBotSummary = antiBotEnabled
      ? `Đang bật · ${s.anti_bot_extra_safe_enabled === '1' ? 'Rất an toàn + An toàn' : 'Rất an toàn'} · ${antiBotActions}`
      : `Đang tắt · ${antiBotActions}`;
    const unit = s.comment_delay_unit === 'min' ? 'min' : 'sec';
    let intervals = {};
    try { intervals = s.comment_intervals ? JSON.parse(s.comment_intervals) : {}; } catch (_) {}
    const intervalRows = this.commentSequences
      .filter(sequence => sequence >= 2)
      .map(sequence => {
        const interval = intervals[String(sequence)] || { min: 60, max: 120, unit: 'sec' };
        const intervalUnit = interval.unit === 'min' ? 'min' : 'sec';
        const previousSequence = this.previousCommentSequence(sequence);
        return `
          <div class="comment-interval-row" data-sequence="${sequence}">
            <div class="comment-interval-label">
              <b>Bình luận ${previousSequence}</b>
              <span>→</span>
              <b>Bình luận ${sequence}</b>
            </div>
            <input type="number" class="form-input" id="cmt-interval-${sequence}-min"
                   value="${this.escapeHtml(interval.min ?? 60)}" min="0" step="1" aria-label="Từ">
            <span class="comment-interval-separator">~</span>
            <input type="number" class="form-input" id="cmt-interval-${sequence}-max"
                   value="${this.escapeHtml(interval.max ?? 120)}" min="0" step="1" aria-label="Đến">
            <select class="form-select" id="cmt-interval-${sequence}-unit">
              <option value="sec" ${intervalUnit === 'sec' ? 'selected' : ''}>Giây</option>
              <option value="min" ${intervalUnit === 'min' ? 'selected' : ''}>Phút</option>
            </select>
          </div>
        `;
      }).join('');
    const hasAiLabel = ['facebook', 'zalovideo'].includes(App.currentPlatform);
    const aiInputId = App.currentPlatform === 'zalovideo'
      ? 'zalo-ai-label-enabled'
      : 'fb-ai-label-enabled';
    const aiPlatformLabel = App.currentPlatform === 'zalovideo' ? 'Zalo Video' : 'Facebook';
    const aiLabelSection = hasAiLabel ? `
      <div class="settings-section">
        <div class="settings-section-title">✨ Thêm nhãn AI</div>
        <div class="card">
          <div class="form-group" style="flex-direction: row; align-items: center; gap: 12px;">
            <label class="toggle">
              <input type="checkbox" id="${aiInputId}" ${aiLabelEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <label class="form-label" style="margin: 0; cursor: pointer;" for="${aiInputId}">
              Bật nhãn AI khi đăng ${aiPlatformLabel}
            </label>
          </div>
        </div>
      </div>
    ` : '';
    const textBgSection = App.currentPlatform === 'facebook' ? this.renderTextBackground(s) : '';
    const timeoutLabel = (key, fallbackMs) => {
      const raw = Number(s[key]);
      const ms = Number.isFinite(raw) && raw >= 0 ? raw : fallbackMs;
      if (ms === 0) return 'không giới hạn';
      const seconds = ms / 1000;
      if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} phút`;
      return `${seconds} giây`;
    };
    const antiBotTitle = App.currentPlatform === 'youtube'
      ? 'Chống BOT & tốc độ máy/mạng'
      : 'Thao tác chống BOT trước khi đăng';
    const antiBotDetail = App.currentPlatform === 'youtube'
      ? `${antiBotSummary} · Tải ${timeoutLabel('upload_timeout_ms', 900000)} · Xuất bản ${timeoutLabel('publish_timeout_ms', 180000)}`
      : antiBotSummary;

    container.innerHTML = `
      <div class="settings-section post-run-limit-section" data-tour-id="config-limit">
        <div class="settings-section-title">Giới hạn mỗi lượt đăng</div>
        <div class="card post-run-limit-card">
          <div>
            <strong>Bài/video mỗi profile mỗi lượt</strong>
            <span>Áp dụng cho Chạy ngay và Hẹn giờ; chỉ lấy hàng đang Chờ theo đúng thứ tự bảng.</span>
          </div>
          <label>
            <input type="number" class="form-input" id="post-run-limit"
                   value="${Math.max(0, Number(s.posts_per_profile_per_run) || 0)}"
                   min="0" max="1000">
            <small>0 = không giới hạn</small>
            <button type="button" class="btn btn-primary btn-sm" onclick="PostConfig.save()">Lưu</button>
          </label>
        </div>
      </div>
      <div class="settings-section anti-bot-config-section" data-tour-id="config-antibot">
        <div class="settings-section-title">${antiBotTitle}</div>
        <div class="card compact-config-row">
          <div>
            <strong>Random hành vi và tùy chỉnh thời gian chờ</strong>
            <span>${this.escapeHtml(antiBotDetail)}</span>
          </div>
          <button type="button" class="btn btn-secondary btn-sm"
                  onclick="PostConfig.showAntiBotModal()">Cài đặt</button>
        </div>
      </div>
      ${aiLabelSection}
      ${textBgSection}
      <div class="settings-section" data-tour-id="config-comments">
        <div class="settings-section-title">💬 Tự động bình luận sau khi đăng</div>
        <div class="card">
          <div class="form-group mb-16" style="flex-direction: row; align-items: center; gap: 12px;">
            <label class="toggle">
              <input type="checkbox" id="cmt-enabled" ${enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <label class="form-label" style="margin: 0; cursor: pointer;" for="cmt-enabled">
              Bật tự động bình luận vào bài vừa đăng
            </label>
          </div>

          <div class="form-group mb-16">
            <label class="form-label">Đăng bài thành công → Bình luận 1</label>
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="number" class="form-input" id="cmt-delay-min"
                     value="${this.escapeHtml(s.comment_delay_min || '30')}"
                     min="0" style="width: 100px;">
              <span style="color: var(--text-muted);">~</span>
              <input type="number" class="form-input" id="cmt-delay-max"
                     value="${this.escapeHtml(s.comment_delay_max || '60')}"
                     min="0" style="width: 100px;">
              <select class="form-select" id="cmt-delay-unit" style="width: 120px;">
                <option value="sec" ${unit === 'sec' ? 'selected' : ''}>Giây</option>
                <option value="min" ${unit === 'min' ? 'selected' : ''}>Phút</option>
              </select>
            </div>
            <div class="text-sm text-muted" style="margin-top:6px;">Tool chọn ngẫu nhiên một mốc trong khoảng min ~ max.</div>
          </div>

          <div class="form-group mb-16">
            <label class="form-label">Khoảng chờ giữa các bình luận</label>
            <div class="comment-interval-list">
              ${intervalRows || '<div class="text-sm text-muted">Thêm nhóm bình luận tại Dữ liệu → Thêm cột → Bình luận để cài khoảng chờ tiếp theo.</div>'}
            </div>
          </div>

          <div class="form-group mb-16" style="flex-direction:row;align-items:center;gap:12px;">
            <label class="toggle">
              <input type="checkbox" id="cmt-continue-error" ${s.comment_continue_on_error !== '0' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <label class="form-label" style="margin:0;cursor:pointer;" for="cmt-continue-error">
              Bình luận lỗi vẫn tiếp tục chạy bình luận sau
            </label>
          </div>

          <div class="text-sm text-muted" style="margin-top:4px;">
            Mỗi nhóm gồm nội dung, media, thời gian thực tế và trạng thái riêng. Có thể dùng text-only,
            media-only hoặc cả hai; nhóm trống sẽ được bỏ qua.
            Nội dung hỗ trợ biến <code>{{ten_bien}}</code>.
          </div>
          <div class="text-sm text-muted" style="margin-top:6px;">
            Lịch bình luận được lưu trong database. Khi tool tắt hoặc crash, các job chưa hoàn tất sẽ
            tự phục hồi và job quá hạn sẽ chạy ngay sau khi mở lại.
          </div>

          <div style="margin-top:16px;">
            <button class="btn btn-primary" onclick="PostConfig.save()">💾 Lưu cấu hình</button>
          </div>
        </div>
      </div>
    `;
  },

  showAntiBotModal() {
    const s = this.settings;
    const seconds = (key, fallback) => {
      const value = Number(s[key]);
      return Number.isFinite(value) ? value / 1000 : fallback;
    };
    const platformOptions = App.platforms
      .filter(platform => platform !== App.currentPlatform)
      .map(platform => `
        <label><input type="checkbox" class="anti-bot-copy-platform" value="${platform}">
          ${this.escapeHtml(App.platformLabel(platform))}</label>
      `).join('');
    const timeoutField = (label, id, key, fallbackMs, hint) => `
      <label class="config-single-field">${this.escapeHtml(label)}
        <span>
          <input type="number" class="form-input" id="${id}"
                 value="${this.escapeHtml(seconds(key, fallbackMs / 1000))}" min="0" step="1">
          <i>giây</i>
        </span>
        <small>${this.escapeHtml(hint)}</small>
      </label>
    `;
    const youtubeTimeoutBlock = App.currentPlatform === 'youtube' ? `
      <div class="config-popup-block">
        <div class="config-popup-label">Tốc độ máy & mạng YouTube</div>
        <div class="config-range-grid">
          ${timeoutField('Mở YouTube Studio', 'youtube-navigation-timeout', 'navigation_timeout_ms', 90000, 'Chờ trang Studio tải xong')}
          ${timeoutField('Mở trình biên tập', 'youtube-editor-timeout', 'editor_timeout_ms', 180000, 'Chờ tiêu đề, mô tả và nút Tiếp')}
          ${timeoutField('Tải và xử lý video', 'youtube-upload-timeout', 'upload_timeout_ms', 900000, 'Video dài hoặc mạng tải lên chậm')}
          ${timeoutField('Kiểm tra và xuất bản', 'youtube-publish-timeout', 'publish_timeout_ms', 180000, 'Gồm bước Vẫn xuất bản và chờ link')}
        </div>
        <div class="text-sm text-muted">
          Nhập số giây bất kỳ, không giới hạn mức tối đa. Đặt <b>0</b> để chờ không giới hạn.
        </div>
      </div>
    ` : '';
    const body = `
      <div class="config-popup-heading">
        <div>
          <strong>${App.currentPlatform === 'youtube' ? 'Chống BOT & tốc độ máy/mạng' : 'Thao tác chống BOT trước khi đăng'}</strong>
          <span>${this.escapeHtml(App.platformLabel())} · Mỗi lượt tạo một kế hoạch random mới</span>
        </div>
        <label class="toggle">
          <input type="checkbox" id="anti-bot-enabled" ${s.anti_bot_enabled === '1' ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      ${youtubeTimeoutBlock}
      <div class="config-popup-block">
        <div class="config-popup-label">Nhóm hành vi</div>
        <div class="config-option-row">
          <label class="config-check is-locked">
            <input type="checkbox" checked disabled>
            <span><b>Rất an toàn</b><small>Cuộn, hover, di chuột, dừng đọc, chờ tải</small></span>
          </label>
          <label class="config-check">
            <input type="checkbox" id="anti-bot-extra-safe"
                   ${s.anti_bot_extra_safe_enabled === '1' ? 'checked' : ''}>
            <span><b>Thêm hành vi an toàn</b><small>Mở rộng nội dung khi có thể</small></span>
          </label>
        </div>
      </div>
      <div class="config-popup-block">
        <div class="config-popup-label">Mức hoạt động</div>
        <div class="config-preset-row">
          <button type="button" data-anti-bot-preset="light"
                  onclick="PostConfig.applyAntiBotPreset('light')">Nhẹ</button>
          <button type="button" data-anti-bot-preset="balanced"
                  onclick="PostConfig.applyAntiBotPreset('balanced')">Vừa</button>
          <button type="button" data-anti-bot-preset="custom"
                  onclick="PostConfig.applyAntiBotPreset('custom')">Tùy chỉnh</button>
        </div>
      </div>
      <input type="hidden" id="anti-bot-preset" value="${this.escapeHtml(s.anti_bot_preset || 'balanced')}">
      <div class="config-range-grid">
        ${this.rangeFields('Số thao tác', 'anti-bot-action', s.anti_bot_action_min || 2, s.anti_bot_action_max || 5, 'lượt', 1)}
        ${this.rangeFields('Delay giữa thao tác', 'anti-bot-action-delay', seconds('anti_bot_action_delay_min_ms', 1), seconds('anti_bot_action_delay_max_ms', 5), 'giây', 0.1)}
        ${this.rangeFields('Nghỉ trước khi đăng', 'anti-bot-before-post', seconds('anti_bot_before_post_min_ms', 2), seconds('anti_bot_before_post_max_ms', 6), 'giây', 0.1)}
        <label class="config-single-field">Tổng thời gian tối đa
          <span><input type="number" class="form-input" id="anti-bot-max-total"
                       value="${seconds('anti_bot_max_total_ms', 35)}" min="3" max="180" step="1"><i>giây</i></span>
        </label>
      </div>
      <details class="config-advanced">
        <summary>Nâng cao</summary>
        <div class="config-range-grid">
          ${this.rangeFields('Chờ sau khi mở trang', 'anti-bot-open-delay', seconds('anti_bot_open_delay_min_ms', 3), seconds('anti_bot_open_delay_max_ms', 8), 'giây', 0.1)}
          ${this.rangeFields('Khoảng dừng đọc', 'anti-bot-read-delay', seconds('anti_bot_read_delay_min_ms', 2), seconds('anti_bot_read_delay_max_ms', 7), 'giây', 0.1)}
          <label class="config-single-field">Xác suất hành vi an toàn
            <span><input type="number" class="form-input" id="anti-bot-extra-probability"
                         value="${this.escapeHtml(s.anti_bot_extra_probability || '25')}" min="0" max="100"><i>%</i></span>
          </label>
          <label class="config-single-field">Khi bước chuẩn bị lỗi
            <select class="form-select" id="anti-bot-on-error">
              <option value="continue" ${s.anti_bot_on_error !== 'stop' ? 'selected' : ''}>Bỏ qua và đăng tiếp</option>
              <option value="stop" ${s.anti_bot_on_error === 'stop' ? 'selected' : ''}>Dừng profile</option>
            </select>
          </label>
        </div>
        <label class="config-inline-check">
          <input type="checkbox" id="anti-bot-full-each-post" ${s.anti_bot_full_each_post === '1' ? 'checked' : ''}>
          Thực hiện đầy đủ trước mỗi bài trong cùng profile
        </label>
        <details class="config-copy-targets">
          <summary>Sao chép sang nền tảng khác</summary>
          <div>${platformOptions}</div>
        </details>
      </details>
    `;
    const footer = `
      <button class="btn btn-secondary" onclick="closeModal()">Hủy</button>
      <button class="btn btn-primary" onclick="PostConfig.saveAntiBotSettings()">Lưu</button>
    `;
    showModal(
      App.currentPlatform === 'youtube'
        ? 'Chống BOT & tốc độ máy/mạng · YouTube'
        : `Chống BOT · ${App.platformLabel()}`,
      body,
      footer
    );
    this.applyAntiBotPreset(s.anti_bot_preset || 'balanced', false);
  },

  rangeFields(label, prefix, min, max, unit, step = 1) {
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

  applyAntiBotPreset(preset, updateValues = true) {
    const values = {
      light: {
        action: [1, 3], actionDelay: [1, 3], beforePost: [1, 3],
        openDelay: [2, 5], readDelay: [1, 4], maxTotal: 20,
      },
      balanced: {
        action: [2, 5], actionDelay: [1, 5], beforePost: [2, 6],
        openDelay: [3, 8], readDelay: [2, 7], maxTotal: 35,
      },
    };
    const selected = ['light', 'balanced', 'custom'].includes(preset) ? preset : 'balanced';
    const hidden = document.getElementById('anti-bot-preset');
    if (hidden) hidden.value = selected;
    document.querySelectorAll('[data-anti-bot-preset]').forEach(button =>
      button.classList.toggle('active', button.dataset.antiBotPreset === selected)
    );
    if (!updateValues || selected === 'custom') return;
    const value = values[selected];
    const setRange = (prefix, range) => {
      const min = document.getElementById(`${prefix}-min`);
      const max = document.getElementById(`${prefix}-max`);
      if (min) min.value = range[0];
      if (max) max.value = range[1];
    };
    setRange('anti-bot-action', value.action);
    setRange('anti-bot-action-delay', value.actionDelay);
    setRange('anti-bot-before-post', value.beforePost);
    setRange('anti-bot-open-delay', value.openDelay);
    setRange('anti-bot-read-delay', value.readDelay);
    const total = document.getElementById('anti-bot-max-total');
    if (total) total.value = value.maxTotal;
  },

  _antiBotRange(prefix, multiplier = 1) {
    const min = Number(document.getElementById(`${prefix}-min`)?.value);
    const max = Number(document.getElementById(`${prefix}-max`)?.value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      throw new Error(`Khoảng ${prefix.replace('anti-bot-', '')} không hợp lệ`);
    }
    return [String(Math.round(min * multiplier)), String(Math.round(max * multiplier))];
  },

  async saveAntiBotSettings() {
    try {
      const action = this._antiBotRange('anti-bot-action');
      const actionDelay = this._antiBotRange('anti-bot-action-delay', 1000);
      const beforePost = this._antiBotRange('anti-bot-before-post', 1000);
      const openDelay = this._antiBotRange('anti-bot-open-delay', 1000);
      const readDelay = this._antiBotRange('anti-bot-read-delay', 1000);
      const maxTotal = Number(document.getElementById('anti-bot-max-total')?.value);
      const extraProbability = Number(document.getElementById('anti-bot-extra-probability')?.value);
      if (!Number.isFinite(maxTotal) || maxTotal < 3 || maxTotal > 180) {
        throw new Error('Tổng thời gian tối đa phải từ 3 đến 180 giây');
      }
      if (!Number.isFinite(extraProbability) || extraProbability < 0 || extraProbability > 100) {
        throw new Error('Xác suất hành vi an toàn phải từ 0 đến 100%');
      }
      const youtubeTimeoutSettings = {};
      if (App.currentPlatform === 'youtube') {
        const timeoutFields = [
          ['youtube-navigation-timeout', 'navigation_timeout_ms', 'Mở YouTube Studio'],
          ['youtube-editor-timeout', 'editor_timeout_ms', 'Mở trình biên tập'],
          ['youtube-upload-timeout', 'upload_timeout_ms', 'Tải và xử lý video'],
          ['youtube-publish-timeout', 'publish_timeout_ms', 'Kiểm tra và xuất bản'],
        ];
        for (const [id, key, label] of timeoutFields) {
          const seconds = Number(document.getElementById(id)?.value);
          if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error(`${label} phải là số từ 0 trở lên`);
          }
          youtubeTimeoutSettings[key] = String(Math.round(seconds * 1000));
        }
      }
      const settings = {
        anti_bot_enabled: document.getElementById('anti-bot-enabled')?.checked ? '1' : '0',
        anti_bot_extra_safe_enabled: document.getElementById('anti-bot-extra-safe')?.checked ? '1' : '0',
        anti_bot_preset: document.getElementById('anti-bot-preset')?.value || 'custom',
        anti_bot_action_min: action[0],
        anti_bot_action_max: action[1],
        anti_bot_action_delay_min_ms: actionDelay[0],
        anti_bot_action_delay_max_ms: actionDelay[1],
        anti_bot_before_post_min_ms: beforePost[0],
        anti_bot_before_post_max_ms: beforePost[1],
        anti_bot_open_delay_min_ms: openDelay[0],
        anti_bot_open_delay_max_ms: openDelay[1],
        anti_bot_read_delay_min_ms: readDelay[0],
        anti_bot_read_delay_max_ms: readDelay[1],
        anti_bot_max_total_ms: String(Math.round(maxTotal * 1000)),
        anti_bot_extra_probability: String(Math.round(extraProbability)),
        anti_bot_full_each_post: document.getElementById('anti-bot-full-each-post')?.checked ? '1' : '0',
        anti_bot_on_error: document.getElementById('anti-bot-on-error')?.value === 'stop' ? 'stop' : 'continue',
        ...youtubeTimeoutSettings,
      };
      await api('/api/settings', { method: 'PUT', body: settings });
      const targets = [...document.querySelectorAll('.anti-bot-copy-platform:checked')]
        .map(input => input.value);
      for (const target of targets) {
        const response = await fetch(`/api/settings?platform=${encodeURIComponent(target)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `Không sao chép được sang ${App.platformLabel(target)}`);
        }
      }
      this.settings = { ...this.settings, ...settings };
      closeModal();
      this.render();
      showToast(
        targets.length
          ? `Đã lưu và sao chép sang ${targets.length} nền tảng`
          : 'Đã lưu thao tác chống BOT',
        'success'
      );
    } catch (error) {
      showToast(error.message, 'warning');
    }
  },

  async save() {
    const min = document.getElementById('cmt-delay-min');
    const max = document.getElementById('cmt-delay-max');
    if (!min || !max) return;

    const dMin = parseFloat(min.value);
    const dMax = parseFloat(max.value);
    const postLimit = parseInt(document.getElementById('post-run-limit')?.value, 10);
    if (!Number.isInteger(postLimit) || postLimit < 0 || postLimit > 1000) {
      showToast('Số bài/video mỗi lượt phải từ 0 đến 1000', 'warning');
      return;
    }
    if (isNaN(dMin) || isNaN(dMax) || dMin < 0 || dMax < 0) {
      showToast('Thời gian chờ không hợp lệ', 'warning');
      return;
    }
    if (dMin > dMax) {
      showToast('Thời gian chờ min không được lớn hơn max', 'warning');
      return;
    }

    const settings = {
      auto_comment_enabled: document.getElementById('cmt-enabled').checked ? '1' : '0',
      comment_delay_unit: document.getElementById('cmt-delay-unit').value === 'min' ? 'min' : 'sec',
      comment_delay_min: min.value || '0',
      comment_delay_max: max.value || '0',
      comment_continue_on_error: document.getElementById('cmt-continue-error')?.checked ? '1' : '0',
      posts_per_profile_per_run: String(postLimit),
    };
    const intervals = {};
    for (const sequence of this.commentSequences.filter(value => value >= 2)) {
      const intervalMin = document.getElementById(`cmt-interval-${sequence}-min`);
      const intervalMax = document.getElementById(`cmt-interval-${sequence}-max`);
      const intervalUnit = document.getElementById(`cmt-interval-${sequence}-unit`);
      const minValue = Number(intervalMin?.value);
      const maxValue = Number(intervalMax?.value);
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue < 0 || maxValue < minValue) {
        showToast(`Khoảng chờ Bình luận ${this.previousCommentSequence(sequence)} → ${sequence} không hợp lệ`, 'warning');
        return;
      }
      intervals[String(sequence)] = {
        min: minValue,
        max: maxValue,
        unit: intervalUnit?.value === 'min' ? 'min' : 'sec',
      };
    }
    settings.comment_intervals = JSON.stringify(intervals);
    if (['facebook', 'zalovideo'].includes(App.currentPlatform)) {
      const inputId = App.currentPlatform === 'zalovideo'
        ? 'zalo-ai-label-enabled'
        : 'fb-ai-label-enabled';
      settings.add_ai_label = document.getElementById(inputId)?.checked ? '1' : '0';
    }
    if (App.currentPlatform === 'facebook') {
      const mode = document.getElementById('fb-text-bg-mode')?.value;
      settings.text_background_mode = ['random', 'fixed'].includes(mode) ? mode : 'none';
      const picked = document.querySelector('input[name="fb-text-bg-index"]:checked')?.value;
      settings.text_background_index = String(Math.min(8, Math.max(1, parseInt(picked, 10) || 1)));
    }

    try {
      await api('/api/settings', { method: 'PUT', body: settings });
      this.settings = { ...this.settings, ...settings };
      showToast('Đã lưu cấu hình đăng bài', 'success');
    } catch (err) {
      // Error already shown by api()
    }
  },

  // Thu tu va mau xap xi theo hang phong nen cua Facebook ("phong nen 1..8").
  TEXT_BACKGROUNDS: [
    { index: 1, name: 'Tím thẫm', css: 'repeating-linear-gradient(135deg,#6a3fd6 0 6px,#8b5cf6 6px 12px)' },
    { index: 2, name: 'Đỏ', css: '#e4003b' },
    { index: 3, name: 'Đen', css: '#000000' },
    { index: 4, name: 'Tím', css: 'linear-gradient(135deg,#5b2be0,#c61ad9)' },
    { index: 5, name: 'Hồng tím', css: 'linear-gradient(135deg,#c21af4,#ff5ad6)' },
    { index: 6, name: 'Vàng cam', css: 'linear-gradient(135deg,#ffd23f,#ff7a00)' },
    { index: 7, name: 'Xám đậm', css: '#343a40' },
    { index: 8, name: 'Tím đêm', css: 'linear-gradient(135deg,#2b1055,#7597de)' },
  ],

  renderTextBackground(s) {
    const mode = ['random', 'fixed'].includes(s.text_background_mode) ? s.text_background_mode : 'none';
    const index = Math.min(8, Math.max(1, parseInt(s.text_background_index, 10) || 1));
    const chips = this.TEXT_BACKGROUNDS.map(item => `
      <label class="fb-text-bg-chip${item.index === index ? ' active' : ''}" title="Phông nền ${item.index}: ${item.name}">
        <input type="radio" name="fb-text-bg-index" value="${item.index}" ${item.index === index ? 'checked' : ''}>
        <span class="fb-text-bg-swatch" style="background:${item.css}"></span>
        <span class="fb-text-bg-name">${item.index}. ${item.name}</span>
      </label>
    `).join('');
    return `
      <div class="settings-section">
        <div class="settings-section-title">🎨 Phông nền bài chỉ chữ (Facebook)</div>
        <div class="card">
          <p class="form-hint" style="margin-top:0">
            Khi bài không có ảnh/video và đủ ngắn, Facebook hiện nút "Aa" để chọn màu nền.
            Chọn cách tool xử lý; luồng có media không thay đổi.
          </p>
          <div class="form-group">
            <label class="form-label" for="fb-text-bg-mode">Chế độ</label>
            <select class="form-select" id="fb-text-bg-mode" onchange="PostConfig.onTextBackgroundModeChange()">
              <option value="none" ${mode === 'none' ? 'selected' : ''}>Tắt - đăng chữ bình thường</option>
              <option value="random" ${mode === 'random' ? 'selected' : ''}>Ngẫu nhiên - mỗi bài một màu</option>
              <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Cố định - luôn dùng một màu</option>
            </select>
          </div>
          <div class="fb-text-bg-grid" id="fb-text-bg-grid" style="${mode === 'fixed' ? '' : 'display:none'}">
            ${chips}
          </div>
        </div>
      </div>
    `;
  },

  onTextBackgroundModeChange() {
    const mode = document.getElementById('fb-text-bg-mode')?.value;
    const grid = document.getElementById('fb-text-bg-grid');
    if (grid) grid.style.display = mode === 'fixed' ? '' : 'none';
  },

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  previousCommentSequence(sequence) {
    const index = this.commentSequences.indexOf(Number(sequence));
    return index > 0 ? this.commentSequences[index - 1] : 1;
  },
};
