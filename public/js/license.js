/**
 * License gate:
 * - Kích hoạt chính bằng liên kết ghép thiết bị một lần.
 * - Tool giữ device secret, trình duyệt chỉ nhận request id.
 * - Key thủ công vẫn được giữ như đường hỗ trợ tương thích.
 */
(function () {
  let WEB_URL = '';
  let pairTimer = null;

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data: data.data || data, error: data.error };
  }

  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
  }

  function stopPairPolling() {
    if (pairTimer) clearTimeout(pairTimer);
    pairTimer = null;
  }

  async function openExternalUrl(url) {
    const nativeOpen = window.pywebview?.api?.open_external_url;
    if (nativeOpen) {
      const result = await nativeOpen(url);
      if (result?.success) return true;
    }
    return Boolean(window.open(url, '_blank', 'noopener,noreferrer'));
  }

  function pairStatus(overlay, type, title, detail) {
    const box = overlay.querySelector('#lic-pair-status');
    if (!box) return;
    box.className = `license-pair-state is-${type}`;
    box.hidden = false;
    box.innerHTML = `
      <span class="license-pair-state-icon" aria-hidden="true"></span>
      <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail || '')}</small></span>
    `;
  }

  function resetPairButton(overlay, label = 'Kích hoạt bằng tài khoản') {
    const button = overlay.querySelector('#lic-pair-start');
    if (!button) return;
    button.disabled = false;
    button.innerHTML = `<span>${escapeHtml(label)}</span><b aria-hidden="true">→</b>`;
  }

  async function pollPairing(overlay, delaySeconds = 2) {
    stopPairPolling();
    pairTimer = setTimeout(async () => {
      const result = await api('/api/license/pair/status', { method: 'POST' });
      if (result.ok && result.data?.status === 'activated' && result.data?.valid) {
        pairStatus(overlay, 'success', 'Đã kích hoạt', 'Đang mở khóa Super Post King...');
        setTimeout(() => location.reload(), 650);
        return;
      }
      if (result.ok && result.data?.status === 'pending') {
        pairStatus(overlay, 'waiting', 'Đang chờ xác nhận trên website', 'Tool sẽ tự mở khóa, bạn không cần quay lại bấm thêm.');
        pollPairing(overlay, result.data.poll_interval || delaySeconds);
        return;
      }
      if (result.ok && ['expired', 'none'].includes(result.data?.status)) {
        pairStatus(overlay, 'expired', 'Phiên kích hoạt đã hết hạn', 'Bấm tạo liên kết mới để tiếp tục.');
        resetPairButton(overlay, 'Tạo liên kết mới');
        return;
      }
      pairStatus(
        overlay,
        'error',
        'Chưa kiểm tra được trạng thái',
        result.error || result.data?.reason || 'Kiểm tra kết nối mạng rồi thử lại.'
      );
      resetPairButton(overlay, 'Thử lại');
    }, Math.max(2, Number(delaySeconds) || 2) * 1000);
  }

  async function startPairing(overlay) {
    const button = overlay.querySelector('#lic-pair-start');
    const fallback = overlay.querySelector('#lic-pair-open');
    const nativeOpen = window.pywebview?.api?.open_external_url;
    const popup = nativeOpen ? null : window.open('', '_blank');
    button.disabled = true;
    button.innerHTML = '<span>Đang tạo liên kết...</span>';
    if (fallback) fallback.hidden = true;
    pairStatus(overlay, 'loading', 'Đang chuẩn bị phiên kích hoạt', 'Liên kết chỉ dùng một lần và tự hết hạn sau 10 phút.');

    const result = await api('/api/license/pair/start', { method: 'POST' });
    if (!result.ok || !result.data?.authorize_url) {
      try { popup?.close(); } catch {}
      pairStatus(overlay, 'error', 'Không tạo được liên kết', result.error || 'Vui lòng kiểm tra mạng và thử lại.');
      resetPairButton(overlay, 'Thử tạo lại');
      return;
    }

    const authorizeUrl = result.data.authorize_url;
    if (fallback) {
      fallback.href = authorizeUrl;
      fallback.hidden = false;
    }
    try {
      if (nativeOpen) {
        const opened = await nativeOpen(authorizeUrl);
        if (!opened?.success) throw new Error(opened?.error || 'Không mở được trình duyệt');
      } else if (popup) {
        popup.location.href = authorizeUrl;
      } else {
        window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
    }

    button.innerHTML = '<span>Đã mở trang kích hoạt</span><b aria-hidden="true">✓</b>';
    pairStatus(overlay, 'waiting', 'Đang chờ xác nhận trên website', 'Đăng nhập, chọn license và bấm xác nhận. Tool sẽ tự nhận kết quả.');
    pollPairing(overlay, result.data.poll_interval || 2);
  }

  function actionMarkup(state) {
    const reason = state.reason || 'Vui lòng kích hoạt để sử dụng.';
    const isExpired = state.status === 'expired' || /hết hạn/i.test(reason);
    const isOnlineRequired = state.status === 'online_required';
    if (isExpired) {
      return `
        <div class="license-gate-note is-warning">
          <strong>Gói sử dụng đã kết thúc</strong>
          <span>Gia hạn trên website để tiếp tục dùng đúng máy hiện tại.</span>
        </div>
        <button class="license-gate-primary" id="lic-upgrade" data-url="${escapeHtml(WEB_URL)}/customer" type="button">
          <span>Nâng cấp / Gia hạn</span><b aria-hidden="true">→</b>
        </button>
        <button class="license-gate-secondary" id="lic-refresh" type="button">Tôi đã gia hạn — Kiểm tra lại</button>
        <p class="license-gate-error" id="lic-err" aria-live="polite"></p>`;
    }
    if (isOnlineRequired) {
      return `
        <div class="license-gate-note is-info">
          <strong>Cần kết nối lại máy chủ</strong>
          <span>Kiểm tra Internet rồi xác thực license hiện tại.</span>
        </div>
        <button class="license-gate-primary" id="lic-refresh" type="button">
          <span>Thử xác thực lại</span><b aria-hidden="true">↻</b>
        </button>
        <p class="license-gate-error" id="lic-err" aria-live="polite"></p>`;
    }
    return `
      <button class="license-gate-primary" id="lic-pair-start" type="button">
        <span>Kích hoạt bằng tài khoản</span><b aria-hidden="true">→</b>
      </button>
      <button class="license-gate-secondary" id="lic-upgrade" data-url="${escapeHtml(WEB_URL)}/superpost" type="button">
        Chưa có license — Xem gói / Nâng cấp
      </button>
      <a class="license-gate-open" id="lic-pair-open" href="#" target="_blank" rel="noopener noreferrer" hidden>
        Trang chưa mở? Bấm để mở lại ↗
      </a>
      <div class="license-pair-state" id="lic-pair-status" hidden aria-live="polite"></div>
      <p class="license-gate-error" id="lic-err" aria-live="polite"></p>
      <details class="license-gate-details">
        <summary>Tôi có sẵn license key</summary>
        <div class="license-key-row">
          <input id="lic-key" placeholder="KT-XXXX-XXXX-XXXX" autocomplete="off">
          <button id="lic-activate" type="button">Kích hoạt</button>
        </div>
      </details>`;
  }

  function showOverlay(state) {
    if (document.getElementById('license-overlay')) return;
    const reason = state.reason || 'Vui lòng kích hoạt để sử dụng.';
    const isExpired = state.status === 'expired' || /hết hạn/i.test(reason);
    const isOnlineRequired = state.status === 'online_required';
    const eyebrow = isExpired ? 'Gia hạn sử dụng' : isOnlineRequired ? 'Xác thực trực tuyến' : 'Kết nối tài khoản';
    const title = isExpired
      ? 'License đã hết hạn'
      : isOnlineRequired
        ? 'Xác thực license'
        : 'Kích hoạt Super Post King';
    const description = isExpired
      ? 'Dữ liệu và cấu hình trên máy vẫn được giữ nguyên.'
      : isOnlineRequired
        ? 'Quá trình này chỉ mất vài giây.'
        : 'Đăng nhập trên website, chọn license và xác nhận. Tool sẽ tự mở khóa.';

    const overlay = el(`
      <div id="license-overlay" class="license-gate">
        <div class="license-gate-glow is-left" aria-hidden="true"></div>
        <div class="license-gate-glow is-right" aria-hidden="true"></div>
        <section class="license-gate-card" role="dialog" aria-modal="true" aria-labelledby="license-gate-title">
          <div class="license-gate-brand">
            <img src="/assets/branding/super-post-king-logo.png" alt="" width="42" height="42">
            <span><strong>Super Post King</strong><small>King Automation AI</small></span>
          </div>
          <div class="license-gate-copy">
            <span class="license-gate-eyebrow">${eyebrow}</span>
            <h1 id="license-gate-title">${title}</h1>
            <p>${description}</p>
          </div>
          <div class="license-gate-actions">
            ${actionMarkup(state)}
          </div>
          <div class="license-gate-trust">
            <span><i>✓</i> Liên kết dùng một lần</span>
            <span><i>✓</i> Tự hết hạn sau 10 phút</span>
          </div>
          <details class="license-gate-technical">
            <summary>Thông tin kỹ thuật</summary>
            <div>
              <input id="lic-hwid" readonly value="${escapeHtml(state.hwid || '')}">
              <button id="lic-copy" type="button">Chép mã máy</button>
            </div>
          </details>
        </section>
      </div>
    `);
    document.body.appendChild(overlay);

    overlay.querySelector('#lic-copy').onclick = () => {
      const input = overlay.querySelector('#lic-hwid');
      input.select();
      navigator.clipboard?.writeText(input.value);
      overlay.querySelector('#lic-copy').textContent = 'Đã chép';
    };

    const pairButton = overlay.querySelector('#lic-pair-start');
    if (pairButton) pairButton.onclick = () => startPairing(overlay);
    const upgradeButton = overlay.querySelector('#lic-upgrade');
    if (upgradeButton) {
      upgradeButton.onclick = () => openExternalUrl(upgradeButton.dataset.url);
    }

    const errEl = overlay.querySelector('#lic-err');
    const keyButton = overlay.querySelector('#lic-activate');
    if (keyButton) {
      keyButton.onclick = async () => {
        const key = overlay.querySelector('#lic-key').value.trim();
        if (!key) {
          errEl.textContent = 'Vui lòng nhập license key.';
          return;
        }
        keyButton.disabled = true;
        keyButton.textContent = 'Đang kích hoạt...';
        errEl.textContent = '';
        const result = await api('/api/license/activate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (result.ok && result.data?.valid) location.reload();
        else {
          errEl.textContent = result.error || result.data?.reason || 'Kích hoạt thất bại.';
          keyButton.disabled = false;
          keyButton.textContent = 'Kích hoạt';
        }
      };
    }

    const refreshButton = overlay.querySelector('#lic-refresh');
    if (refreshButton) {
      refreshButton.onclick = async () => {
        refreshButton.disabled = true;
        refreshButton.textContent = 'Đang kiểm tra...';
        errEl.textContent = '';
        const result = await api('/api/license/refresh', { method: 'POST' });
        if (result.ok && result.data?.valid) {
          location.reload();
          return;
        }
        errEl.textContent = result.error || result.data?.reason || 'Chưa xác thực được license.';
        refreshButton.disabled = false;
        refreshButton.textContent = isExpired ? 'Tôi đã gia hạn — Kiểm tra lại' : 'Thử xác thực lại';
      };
    }
  }

  function showBadge(state) {
    const container = document.getElementById('sidebar-license-status');
    if (!container) return;
    const exp = state.expires_at ? new Date(state.expires_at).toLocaleDateString('vi-VN') : 'Trọn đời';
    const labels = { trial: 'Dùng thử', '3m': 'Gói 3 tháng', '1y': 'Gói 1 năm', lifetime: 'Gói trọn đời' };
    const plan = labels[state.plan] || state.plan || 'Đã kích hoạt';
    container.classList.remove('is-invalid');
    container.classList.add('is-valid');
    container.innerHTML = `
      <span class="status-dot online"></span>
      <span class="sidebar-license-copy">
        <small>Thông tin license</small>
        <strong title="${escapeHtml(plan)} · ${escapeHtml(exp)}">${escapeHtml(plan)} · ${escapeHtml(exp)}</strong>
      </span>`;
  }

  function showInvalidStatus(state) {
    const container = document.getElementById('sidebar-license-status');
    if (!container) return;
    const labels = {
      expired: 'Đã hết hạn',
      online_required: 'Cần xác thực',
      wrong_machine: 'Sai máy',
      revoked: 'Đã thu hồi',
      invalid: 'Không hợp lệ',
    };
    container.classList.remove('is-valid');
    container.classList.add('is-invalid');
    container.innerHTML = `
      <span class="status-dot offline"></span>
      <span class="sidebar-license-copy">
        <small>Thông tin license</small>
        <strong>${labels[state.status] || 'Chưa kích hoạt'}</strong>
      </span>`;
  }

  async function init() {
    try {
      const result = await api('/api/license/status');
      let state = result.data || {};
      WEB_URL = state.web_url || WEB_URL;
      if (state.activated && !state.valid) {
        const refreshed = await api('/api/license/refresh', { method: 'POST' });
        if (refreshed.ok && refreshed.data) state = { ...state, ...refreshed.data };
      }
      if (state.valid) showBadge(state);
      else {
        showInvalidStatus(state);
        showOverlay(state);
      }
    } catch {
      showInvalidStatus({});
      showOverlay({ reason: 'Không kiểm tra được license.' });
    }
  }

  window.addEventListener('beforeunload', stopPairPolling);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
