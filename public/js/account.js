/**
 * CovergemAuto - Account / Thanh toán Module
 * Hiển thị trạng thái license, thời hạn còn lại, nền tảng được cấp, lịch sử đơn.
 */
const Account = {
  status: null,
  orders: [],
  _timer: null,

  planLabels: {
    trial: 'Dùng thử 7 ngày',
    '3m': 'Gói 3 tháng',
    '1y': 'Gói 1 năm',
    lifetime: 'Gói trọn đời',
  },

  async load() {
    const container = document.getElementById('page-account');
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
    this.load();
  },

  webUrl() {
    return (this.status && this.status.web_url) || 'https://covergem-license.vercel.app';
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
    const container = document.getElementById('page-account');
    const s = this.status || {};
    const allowed = Array.isArray(s.platforms) ? s.platforms : [];
    const rem = this.remaining(s.expires_at);

    container.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">💳 Gói &amp; License</div>
        <div class="card">
          ${
            s.valid
              ? `<div class="account-grid">
                   <div><div class="acc-label">Gói hiện tại</div><div class="acc-value">${this.planLabels[s.plan] || s.plan || '—'}</div></div>
                   <div><div class="acc-label">Trạng thái</div><div class="acc-value">${this.statusBadge(s)}</div></div>
                   <div><div class="acc-label">Ngày hết hạn</div><div class="acc-value">${s.expires_at ? formatDate(s.expires_at) : 'Trọn đời'}</div></div>
                   <div><div class="acc-label">Thời hạn còn lại</div><div class="acc-value" id="acc-remaining" style="${rem.danger ? 'color:var(--error);font-weight:700' : ''}">${rem.text}</div></div>
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
        <div class="settings-section-title">🧩 Nền tảng</div>
        <div class="card">
          <div class="platform-grid">
            ${App.platforms.map((p) => this.renderPlatform(p, allowed.includes(p))).join('')}
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
      <div class="form-group">
        <label class="form-label">Nhập key kích hoạt</label>
        <div style="display:flex;gap:8px">
          <input type="text" class="form-input" id="acc-key" placeholder="KT-XXXX-XXXX-XXXX" style="flex:1;font-family:monospace;text-transform:uppercase">
          <button class="btn btn-primary btn-sm" onclick="Account.activate()">Kích hoạt</button>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text-secondary)">
        Chưa có key?
        <a href="#" onclick="Account.openWeb('/trial');return false" style="color:var(--accent);font-weight:600">Dùng thử 7 ngày</a>
        ·
        <a href="#" onclick="Account.openWeb('/pricing');return false" style="color:var(--accent);font-weight:600">Mua gói</a>
      </div>`;
  },

  renderPlatform(p, allowed) {
    const label = App.platformLabels[p] || p;
    if (allowed) {
      return `<div class="platform-chip platform-chip-on">✓ ${label}</div>`;
    }
    return `<div class="platform-chip platform-chip-off">
        <span>🔒 ${label}</span>
        <button class="btn btn-secondary btn-sm" onclick="Account.buyMore('${p}')">Mua thêm</button>
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
      this.load();
    } catch (err) {}
  },

  buyMore(platform) {
    const hwid = (this.status && this.status.hwid) || '';
    this.openWeb(`/pricing?hwid=${encodeURIComponent(hwid)}&platforms=${encodeURIComponent(platform)}`);
  },

  openWeb(path) {
    window.open(this.webUrl() + path, '_blank');
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
