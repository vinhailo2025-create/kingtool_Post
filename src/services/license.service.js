/**
 * License Service (phía tool)
 * - Sinh HWID ổn định cho máy
 * - Kích hoạt key với license server
 * - Verify online (định kỳ) + verify offline bằng public key nhúng sẵn (RS256)
 * - Cung cấp trạng thái + danh sách nền tảng được phép cho phần còn lại của tool
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const config = require('../../config');
const db = require('../database/init');

const PUBLIC_KEY_PATH = path.join(__dirname, '..', 'license', 'public.pem');

// ---------- settings helpers ----------
function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? '' : String(value));
}

// ---------- HWID ----------
function machineGuid() {
  try {
    const out = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: 'utf8', windowsHide: true }
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
function primaryMac() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') return ni.mac;
    }
  }
  return '';
}
function getHwid() {
  const cached = getSetting('hwid_cache');
  if (cached) return cached;
  const raw = [machineGuid(), primaryMac(), os.hostname()].join('|');
  const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  const hwid = 'HW-' + hash.slice(0, 32);
  try {
    setSetting('hwid_cache', hwid);
  } catch {}
  return hwid;
}

// ---------- verify token offline (RS256) ----------
function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function verifyTokenOffline(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const signingInput = parts[0] + '.' + parts[1];
    const sig = b64urlToBuf(parts[2]);
    const pub = fs.readFileSync(PUBLIC_KEY_PATH);
    const ok = crypto.createVerify('RSA-SHA256').update(signingInput).verify(pub, sig);
    if (!ok) return null;
    const claims = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ---------- state ----------
function getState() {
  const token = getSetting('license_token');
  if (!token) return { activated: false, valid: false, reason: 'Chưa kích hoạt', platforms: [] };
  const claims = verifyTokenOffline(token);
  if (!claims)
    return {
      activated: true,
      valid: false,
      reason: 'Cần kết nối mạng để xác thực lại license',
      platforms: [],
    };
  const hwid = getHwid();
  if (claims.hwid && claims.hwid !== hwid)
    return { activated: true, valid: false, reason: 'Key thuộc máy khác', platforms: [] };
  if (claims.license_expires_at && new Date(claims.license_expires_at).getTime() < Date.now())
    return { activated: true, valid: false, reason: 'Key đã hết hạn', platforms: [] };
  return {
    activated: true,
    valid: true,
    key: claims.key,
    plan: claims.plan,
    platforms: Array.isArray(claims.platforms) ? claims.platforms : [],
    expires_at: claims.license_expires_at,
  };
}

function isValid() {
  return getState().valid;
}
function getAllowedPlatforms() {
  return getState().platforms || [];
}

// ---------- activate / verify online ----------
async function activate(key) {
  const hwid = getHwid();
  const res = await fetch(config.LICENSE_API_URL + '/api/license/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: String(key || '').trim(),
      hwid,
      product: config.LICENSE_PRODUCT,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Kích hoạt thất bại');
  setSetting('license_key', data.key);
  setSetting('license_token', data.token);
  return getState();
}

// Luồng chính: khách đã dán mã máy trên web, tool tự nhận license theo HWID của mình.
// Server chỉ trả license đã gắn đúng máy này nên không lấy được key của người khác.
async function claimByHwid() {
  const hwid = getHwid();
  const res = await fetch(config.LICENSE_API_URL + '/api/license/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hwid, product: config.LICENSE_PRODUCT }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Chưa lấy được license cho máy này');
  setSetting('license_key', data.key);
  setSetting('license_token', data.token);
  return getState();
}

async function verifyOnline() {
  const key = getSetting('license_key');
  // Chưa có key: thử nhận license đã gắn sẵn cho máy này (khách vừa dán mã máy trên web)
  if (!key) {
    try {
      return await claimByHwid();
    } catch {
      return getState();
    }
  }
  const hwid = getHwid();
  try {
    const res = await fetch(config.LICENSE_API_URL + '/api/license/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, hwid, product: config.LICENSE_PRODUCT }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.valid && data.token) {
      setSetting('license_token', data.token);
    } else if (res.status === 403 || res.status === 404) {
      // Bị thu hồi / hết hạn / không tồn tại → xoá token để khoá tool
      setSetting('license_token', '');
    }
  } catch {
    // Mất mạng — giữ token cũ, dựa vào verify offline (grace period tới khi token exp)
  }
  return getState();
}

// ---------- lịch sử đơn hàng của máy ----------
async function getOrders() {
  try {
    const hwid = getHwid();
    const res = await fetch(
      config.LICENSE_API_URL + '/api/orders?hwid=' + encodeURIComponent(hwid)
    );
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.orders) ? data.orders : [];
  } catch {
    return [];
  }
}

module.exports = {
  getHwid,
  activate,
  claimByHwid,
  verifyOnline,
  verifyTokenOffline,
  getState,
  isValid,
  getAllowedPlatforms,
  getOrders,
  webUrl: () => config.LICENSE_API_URL,
};
