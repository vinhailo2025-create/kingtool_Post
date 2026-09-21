/**
 * Super Post - King - Account / Thanh toán Module
 * Hiển thị trạng thái license, thời hạn còn lại, nền tảng được cấp, lịch sử đơn.
 */
const Account = {
  status: null,
  orders: [],
  _timer: null,
  _pairTimer: null,
  containerId: 'settings-task-account',

  planLabels: {
    trial: 'Dùng thử 7 ngày',
    '3m': 'Gói 3 tháng',
    '1y': 'Gói 1 năm',
    lifetime: 'Gói trọn đời',
  },

  async load(containerId = 'settings-task-account') {
    this.containerId = containerId;
    const container = document.getElementById(this.containerId);
    if (!container) return;
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Đang tải thông tin license...</div></div>';
    try {
      const [statusRes, ordersRes] = await Promise.all([
        apiSilent('/api/license/status'),
        apiSilent('/api/license/orders').catch(() => ({ data: [] })),
      ]);
      this.status = statusRes.data || {};
      this.orders = ordersRes.data || [];
    } catch (err) {
      this.status = { activated: false, valid: false, reason: 'Không lấy được trạng thái license' };
      this.orders = [];
    }
    this.render();
  },

  async refresh() {
    try {
      const res = await api('/api/license/refresh', { method: 'POST' });
      this.status = res.data || this.status;
      showToast('Đã làm mới trạng thái license', 'success');
    } catch (err) {}
    this.load(this.containerId);
  },

  webUrl() {
    return String((this.status && this.status.web_url) || 'https://www.kingautomationai.com').replace(/\/+$/, '');
  },

  // Trả về { text, danger } cho thời hạn còn lại
  remaining(expiresAt) {
    if (!expiresAt) return { text: 'Trọn đời', danger: false };
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return { text: 'Đã hết hạn', danger: true };
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    return { text: `Còn ${days} ngày ${hours} giờ`, danger: days < 7 };
  },

  statusBadge(s) {
    if (!s.activated) return '<span class="badge badge-closed">Chưa kích hoạt</span>';
    if (!s.valid) return `<span class="badge badge-error">${this.esc(s.reason || 'Không hợp lệ')}</span>`;
    const rem = this.remaining(s.expires_at);
    if (rem.danger && s.expires_at) return '<span class="badge badge-pending">Sắp hết hạn</span>';
    return '<span class="badge badge-success">Đang hoạt động</span>';
  },

  render() {
    const container = document.getElementById(this.containerId);
    if (!container) return;
    const s = this.status || {};
    const rem = this.remaining(s.expires_at);

    container.innerHTML = `
      ${this.renderRenewNotice()}
      <div class="settings-section">
        <div class="settings-section-title">💳 Gói &amp; License</div>
        <div class="card">
          ${
            s.email
              ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;display:flex;align-items:center;gap:6px">
                   <span aria-hidden="true">✉️</span><span style="font-family:monospace">${this.esc(s.email)}</span>
                 </div>`
              : ''
          }
          ${
            s.valid
              ? `<div class="account-grid">
                   <div><div class="acc-label">Gói hiện tại</div><div class="acc-value">${this.planLabels[s.plan] || s.plan || '—'}</div></div>
                   <div><div class="acc-label">Trạng thái</div><div class="acc-value">${this.statusBadge(s)}</div></div>
                   <div><div class="acc-label">Ngày hết hạn</div><div class="acc-value">${s.expires_at ? formatDate(s.expires_at) : 'Trọn đời'}</div></div>
                   <div><div class="acc-label">Thời hạn còn lại</div><div class="acc-value" id="acc-remaining" style="${rem.danger ? 'color:var(--error);font-weight:700' : ''}">${rem.text}</div></div>
                 </div>
                  <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:16px">
                    <button class="btn btn-secondary" onclick="Account.refresh()">Kiểm tra trạng thái mới</button>
                    <button class="btn btn-primary" onclick="Account.buyMore()">Nâng cấp / Gia hạn</button>
                  </div>`
              : `<div style="margin-bottom:14px">
                   <div class="acc-label">Trạng thái</div>
                   <div class="acc-value">${this.statusBadge(s)}</div>
                 </div>
                 ${this.renderActivateBox()}`
          }

          <div class="form-group" style="margin-top:16px">
            <label class="form-label">Mã máy (HWID)</label>
            <div style="display:flex;gap:8px">
              <input type="text" class="form-input" id="acc-hwid" value="${this.esc(s.hwid || '')}" readonly style="flex:1;font-family:monospace;font-size:12px">
              <button class="btn btn-secondary btn-sm" onclick="Account.copyHwid()">📋 Chép</button>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">🧾 Lịch sử đơn hàng</div>
        <div class="card">
          ${this.renderOrders()}
        </div>
      </div>
    `;

    this.startCountdown();
  },

  renderActivateBox() {
    return `
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;line-height:1.6">
        Mở trang kích hoạt, đăng nhập và chọn license. Tool sẽ tự nhận kết quả, không cần chép mã máy.
      </div>
      <button class="btn btn-primary" id="acc-pair-start" style="width:100%" onclick="Account.startPairing()">
        Kích hoạt bằng tài khoản
      </button>
      <button class="btn btn-secondary" style="width:100%;margin-top:8px" onclick="Account.openWeb('/superpost')">
        Chưa có license — Xem gói / Nâng cấp
      </button>
      <div id="acc-pair-status" style="font-size:12px;color:var(--text-secondary);margin-top:9px" aria-live="polite"></div>
      <details style="margin-top:12px">
        <summary style="font-size:13px;color:var(--text-secondary);cursor:pointer">Tôi có sẵn license key</summary>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input type="text" class="form-input" id="acc-key" placeholder="KT-XXXX-XXXX-XXXX" style="flex:1;font-family:monospace;text-transform:uppercase">
          <button class="btn btn-secondary btn-sm" onclick="Account.activate()">Kích hoạt</button>
        </div>
      </details>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:12px">
        Chưa có license?
        <a href="#" onclick="Account.openWeb('/customer');return false" style="color:var(--accent);font-weight:600">Mở trang tài khoản</a>
      </div>`;
  },

  // Banner nhắc gia hạn — khách mở tool hàng ngày nên đây là điểm chạm hiệu quả nhất
  renderRenewNotice() {
    const st = this.status || {};
    if (!st.valid || !st.expires_at) return '';
    const days = Math.ceil((new Date(st.expires_at).getTime() - Date.now()) / 86400000);
    if (days > 7) return '';
    const label = days < 0 ? 'License đã hết hạn' : `License còn ${days} ngày`;
    return `
      <div class="card" style="border:1px solid var(--warning,#f59e0b);background:rgba(245,158,11,.08);
        display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px">
        <div>
          <div style="font-weight:700">${label}</div>
          <div style="font-size:13px;color:var(--text-secondary)">Gia hạn để tiếp tục sử dụng, giữ nguyên máy đã kích hoạt.</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="Account.openWeb('/customer')">Gia hạn</button>
      </div>`;
  },

  renderOrders() {
    if (!this.orders || this.orders.length === 0) {
      return '<div class="empty-state"><div class="empty-icon">🧾</div><div class="empty-text">Chưa có đơn hàng</div></div>';
    }
    const rows = this.orders
      .map(
        (o) => `<tr>
          <td style="font-family:monospace">${this.esc(o.code)}</td>
          <td>${this.planLabels[o.plan] || o.plan}</td>
          <td>${Number(o.amount || 0).toLocaleString('vi-VN')}₫</td>
          <td>${this.orderStatusBadge(o.status)}</td>
          <td style="font-family:monospace">${o.license_key ? this.esc(o.license_key) : '—'}</td>
          <td>${formatDate(o.created_at)}</td>
        </tr>`
      )
      .join('');
    return `<div style="overflow-x:auto"><table class="lux-table" style="width:100%">
      <thead><tr><th>Mã</th><th>Gói</th><th>Số tiền</th><th>Trạng thái</th><th>Key</th><th>Ngày</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  },

  orderStatusBadge(st) {
    if (st === 'paid') return '<span class="badge badge-success">Đã thanh toán</span>';
    if (st === 'expired') return '<span class="badge badge-error">Hết hạn</span>';
    return '<span class="badge badge-pending">Chờ thanh toán</span>';
  },

  startCountdown() {
    if (this._timer) clearInterval(this._timer);
    const s = this.status || {};
    if (!s.valid || !s.expires_at) return;
    this._timer = setInterval(() => {
      const el = document.getElementById('acc-remaining');
      if (!el) {
        clearInterval(this._timer);
        return;
      }
      const rem = this.remaining(s.expires_at);
      el.textContent = rem.text;
      el.style.cssText = rem.danger ? 'color:var(--error);font-weight:700' : '';
    }, 60000);
  },

  async activate() {
    const key = (document.getElementById('acc-key').value || '').trim();
    if (!key) return showToast('Vui lòng nhập key', 'error');
    try {
      await api('/api/license/activate', { method: 'POST', body: { key } });
      showToast('Kích hoạt thành công', 'success');
      this.load(this.containerId);
    } catch (err) {}
  },

  async claim() {
    try {
      await api('/api/license/claim', { method: 'POST' });
      showToast('Đã lấy license cho máy này', 'success');
      this.load(this.containerId);
    } catch (err) {}
  },

  async startPairing() {
    const button = document.getElementById('acc-pair-start');
    const status = document.getElementById('acc-pair-status');
    const nativeOpen = window.pywebview?.api?.open_external_url;
    const popup = nativeOpen ? null : window.open('', '_blank');
    if (button) {
      button.disabled = true;
      button.textContent = 'Đang tạo liên kết...';
    }
    if (status) status.textContent = 'Đang chuẩn bị phiên kích hoạt an toàn...';
    try {
      const response = await apiSilent('/api/license/pair/start', { method: 'POST' });
      const pairing = response.data || {};
      if (!pairing.authorize_url) throw new Error('Không tạo được liên kết kích hoạt');
      if (nativeOpen) {
        const opened = await nativeOpen(pairing.authorize_url);
        if (!opened?.success) throw new Error(opened?.error || 'Không mở được trình duyệt');
      } else if (popup) {
        popup.location.href = pairing.authorize_url;
      } else {
        window.open(pairing.authorize_url, '_blank', 'noopener,noreferrer');
      }
      if (button) button.textContent = 'Đã mở trang kích hoạt';
      if (status) status.textContent = 'Đang chờ bạn xác nhận trên website...';
      this.pollPairing(Number(pairing.poll_interval) || 2);
    } catch (error) {
      try { popup?.close(); } catch {}
      if (button) {
        button.disabled = false;
        button.textContent = 'Thử tạo lại';
      }
      if (status) status.textContent = error.message || 'Không tạo được liên kết kích hoạt';
    }
  },

  pollPairing(delaySeconds = 2) {
    if (this._pairTimer) clearTimeout(this._pairTimer);
    this._pairTimer = setTimeout(async () => {
      const button = document.getElementById('acc-pair-start');
      const status = document.getElementById('acc-pair-status');
      try {
        const response = await apiSilent('/api/license/pair/status', { method: 'POST' });
        const result = response.data || {};
        if (result.status === 'activated' && result.valid) {
          if (status) status.textContent = 'Kích hoạt thành công. Đang làm mới...';
          setTimeout(() => location.reload(), 500);
          return;
        }
        if (result.status === 'pending') {
          this.pollPairing(Number(result.poll_interval) || delaySeconds);
          return;
        }
        if (status) status.textContent = 'Phiên đã hết hạn. Hãy tạo liên kết mới.';
      } catch (error) {
        if (status) status.textContent = error.message || 'Chưa kiểm tra được trạng thái';
      }
      if (button) {
        button.disabled = false;
        button.textContent = 'Tạo liên kết mới';
      }
    }, Math.max(2, delaySeconds) * 1000);
  },

  buyMore() {
    this.openWeb('/customer');
  },

  async openWeb(path) {
    const safePath = String(path || '').startsWith('/') ? path : `/${path || ''}`;
    const url = this.webUrl() + safePath;
    const nativeOpen = window.pywebview?.api?.open_external_url;
    if (nativeOpen) {
      const result = await nativeOpen(url);
      if (result?.success) return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  copyHwid() {
    const inp = document.getElementById('acc-hwid');
    if (!inp) return;
    inp.select();
    try { navigator.clipboard.writeText(inp.value); } catch (e) {}
    showToast('Đã chép mã máy', 'success');
  },

  esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
};
