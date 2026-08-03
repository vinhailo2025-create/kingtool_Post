/**
 * License gate (phía giao diện tool)
 * - Lấy trạng thái license; nếu chưa hợp lệ → hiện overlay kích hoạt (HWID + nhập key)
 * - Nếu hợp lệ → hiện badge nhỏ trạng thái
 */
(function () {
  const WEB_URL = 'https://covergem-license.vercel.app';

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

  function showOverlay(state) {
    if (document.getElementById('license-overlay')) return;
    const hwid = state.hwid || '';
    const reason = state.reason || 'Vui lòng kích hoạt để sử dụng.';
    const overlay = el(`
      <div id="license-overlay" style="position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.85);
        display:flex;align-items:center;justify-content:center;font-family:system-ui,Segoe UI,Arial">
        <div style="background:#fff;border-radius:16px;max-width:460px;width:92%;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.4)">
          <h2 style="margin:0 0 6px;font-size:20px;color:#0f172a">Kích hoạt KingTool</h2>
          <p style="margin:0 0 16px;color:#dc2626;font-size:14px">${reason}</p>

          <label style="font-size:13px;color:#475569;font-weight:600">Mã máy (HWID)</label>
          <div style="display:flex;gap:8px;margin:6px 0 16px">
            <input id="lic-hwid" readonly value="${hwid}"
              style="flex:1;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-family:monospace;font-size:12px;background:#f8fafc">
            <button id="lic-copy" style="padding:10px 14px;border:0;border-radius:8px;background:#334155;color:#fff;cursor:pointer">Chép</button>
          </div>

          <label style="font-size:13px;color:#475569;font-weight:600">Nhập key kích hoạt</label>
          <input id="lic-key" placeholder="KT-XXXX-XXXX-XXXX"
            style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin:6px 0 8px;font-family:monospace;text-transform:uppercase">
          <p id="lic-err" style="color:#dc2626;font-size:13px;min-height:18px;margin:0 0 8px"></p>

          <button id="lic-activate" style="width:100%;padding:12px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer">
            Kích hoạt
          </button>

          <div style="margin-top:16px;text-align:center;font-size:13px;color:#64748b">
            Chưa có key?
            <a href="${WEB_URL}/trial" target="_blank" style="color:#2563eb;font-weight:600">Dùng thử 7 ngày</a>
            &nbsp;·&nbsp;
            <a href="${WEB_URL}/pricing" target="_blank" style="color:#2563eb;font-weight:600">Mua gói</a>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(overlay);

    overlay.querySelector('#lic-copy').onclick = () => {
      const inp = overlay.querySelector('#lic-hwid');
      inp.select();
      navigator.clipboard?.writeText(inp.value);
      overlay.querySelector('#lic-copy').textContent = 'Đã chép';
    };

    const errEl = overlay.querySelector('#lic-err');
    const btn = overlay.querySelector('#lic-activate');
    btn.onclick = async () => {
      const key = overlay.querySelector('#lic-key').value.trim();
      if (!key) return (errEl.textContent = 'Vui lòng nhập key');
      btn.disabled = true;
      btn.textContent = 'Đang kích hoạt...';
      errEl.textContent = '';
      const r = await api('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (r.ok) {
        location.reload();
      } else {
        errEl.textContent = r.error || 'Kích hoạt thất bại';
        btn.disabled = false;
        btn.textContent = 'Kích hoạt';
      }
    };
  }

  function showBadge(state) {
    const exp = state.expires_at
      ? new Date(state.expires_at).toLocaleDateString('vi-VN')
      : 'Trọn đời';
    const badge = el(`
      <div style="position:fixed;bottom:10px;right:12px;z-index:9998;background:#ecfdf5;border:1px solid #a7f3d0;
        color:#047857;border-radius:999px;padding:4px 12px;font-size:12px;font-family:system-ui">
        ✓ ${state.plan || 'Đã kích hoạt'} · HSD: ${exp}
      </div>`);
    document.body.appendChild(badge);
  }

  async function init() {
    try {
      const r = await api('/api/license/status');
      const state = r.data || {};
      if (state.valid) showBadge(state);
      else showOverlay(state);
    } catch {
      // Nếu không lấy được trạng thái, vẫn hiện overlay để an toàn
      showOverlay({ reason: 'Không kiểm tra được license.' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
