/**
 * Super Post - King - Post Config Module
 * Tab "Cấu hình": tự động bình luận sau khi đăng bài.
 */

const PostConfig = {
  settings: {},

  async load() {
    const container = document.getElementById('page-postcfg');
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Đang tải cấu hình...</div></div>';

    try {
      const res = await api('/api/settings');
      this.settings = res.data || {};
    } catch (err) {
      this.settings = {};
    }

    this.render();
  },

  render() {
    const container = document.getElementById('page-postcfg');
    const s = this.settings;
    const enabled = s.auto_comment_enabled === '1';
    const unit = s.comment_delay_unit === 'min' ? 'min' : 'sec';

    container.innerHTML = `
      <div class="settings-section">
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
            <label class="form-label">Thời gian chờ trước khi mở bài & bình luận</label>
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

          <div class="text-sm text-muted" style="margin-top:4px;">
            Bình luận lấy theo <b>từng hàng</b>: nội dung từ <code>comment</code>, một ảnh/video tùy chọn từ
            <code>comment_media</code>. Có thể dùng text-only, media-only hoặc cả hai; nếu cùng trống thì bỏ qua.
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

  async save() {
    const min = document.getElementById('cmt-delay-min');
    const max = document.getElementById('cmt-delay-max');
    if (!min || !max) return;

    const dMin = parseFloat(min.value);
    const dMax = parseFloat(max.value);
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
    };

    try {
      await api('/api/settings', { method: 'PUT', body: settings });
      this.settings = { ...this.settings, ...settings };
      showToast('Đã lưu cấu hình bình luận', 'success');
    } catch (err) {
      // Error already shown by api()
    }
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
};
