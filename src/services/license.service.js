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
let pendingPairing = null;

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

async function licenseFetch(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- verify token offline (RS256) ----------
function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function verifySignedClaims(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
    if (header.alg !== 'RS256' || header.typ !== 'JWT') return null;
    const signingInput = parts[0] + '.' + parts[1];
    const sig = b64urlToBuf(parts[2]);
    const pub = fs.readFileSync(PUBLIC_KEY_PATH);
    const ok = crypto.createVerify('RSA-SHA256').update(signingInput).verify(pub, sig);
    if (!ok) return null;
    const claims = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (claims.product !== config.LICENSE_PRODUCT) return null;
    return claims;
  } catch {
    return null;
  }
}

function verifyTokenOffline(token) {
  const claims = verifySignedClaims(token);
  if (!claims) return null;
  if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
  if (!claims.hwid || claims.hwid !== getHwid()) return null;
  return claims;
}

function rememberClaims(claims) {
  if (!claims) return;
  setSetting('license_plan_cache', claims.plan || '');
  setSetting('license_expires_at_cache', claims.license_expires_at || '');
}

function clearOnlineInvalidState() {
  setSetting('license_last_status', '');
  setSetting('license_last_reason', '');
}

function invalidState(status, reason) {
  return {
    activated: true,
    valid: false,
    status,
    reason,
    plan: getSetting('license_plan_cache') || undefined,
    expires_at: getSetting('license_expires_at_cache') || undefined,
    platforms: [],
  };
}

function expiredState(reason = 'License đã hết hạn') {
  return invalidState('expired', reason);
}

// ---------- state ----------
function getState() {
  const key = getSetting('license_key');
  const token = getSetting('license_token');
  if (!key && !token) {
    return {
      activated: false,
      valid: false,
      status: 'not_activated',
      reason: 'Chưa kích hoạt',
      platforms: [],
    };
  }

  const signedClaims = verifySignedClaims(token);
  if (signedClaims?.hwid && signedClaims.hwid !== getHwid()) {
    return invalidState('wrong_machine', 'License thuộc máy khác');
  }
  if (
    signedClaims?.license_expires_at
    && new Date(signedClaims.license_expires_at).getTime() <= Date.now()
  ) {
    rememberClaims(signedClaims);
    return expiredState();
  }

  const claims = verifyTokenOffline(token);
  if (!claims) {
    const lastStatus = getSetting('license_last_status');
    const lastReason = getSetting('license_last_reason');
    if (lastStatus === 'expired') return expiredState(lastReason || undefined);
    if (lastStatus) return invalidState(lastStatus, lastReason || 'License không hợp lệ');
    return {
      activated: true,
      valid: false,
      status: signedClaims || key ? 'online_required' : 'invalid',
      reason: signedClaims || key
        ? 'Cần kết nối mạng để xác thực lại license'
        : 'License không hợp lệ',
      platforms: [],
    };
  }
  const hwid = getHwid();
  if (claims.hwid !== hwid)
    return invalidState('wrong_machine', 'License thuộc máy khác');
  if (claims.license_expires_at && new Date(claims.license_expires_at).getTime() <= Date.now())
    return expiredState();
  rememberClaims(claims);
  return {
    activated: true,
    valid: true,
    status: 'active',
    key: claims.key,
    email: claims.email || claims.customer_email || undefined,
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

function assertPlatform(platform) {
  const state = getState();
  if (!state.valid) {
    const error = new Error(state.reason || 'License không hợp lệ');
    error.code = 'LICENSE_INVALID';
    throw error;
  }
  const wanted = String(platform || '').trim().toLowerCase();
  const allowed = state.platforms || [];
  if (!allowed.includes('*') && !allowed.map((item) => String(item).toLowerCase()).includes(wanted)) {
    const error = new Error(`Gói license không hỗ trợ nền tảng ${wanted || 'này'}`);
    error.code = 'PLATFORM_NOT_LICENSED';
    throw error;
  }
  return state;
}

// ---------- activate / verify online ----------
async function activate(key) {
  const hwid = getHwid();
  const res = await licenseFetch(config.LICENSE_API_URL + '/api/license/activate', {
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
  clearOnlineInvalidState();
  rememberClaims(verifySignedClaims(data.token));
  return getState();
}

// Luồng chính: khách đã dán mã máy trên web, tool tự nhận license theo HWID của mình.
// Server chỉ trả license đã gắn đúng máy này nên không lấy được key của người khác.
async function claimByHwid() {
  const hwid = getHwid();
  const res = await licenseFetch(config.LICENSE_API_URL + '/api/license/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hwid, product: config.LICENSE_PRODUCT }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Chưa lấy được license cho máy này');
  setSetting('license_key', data.key);
  setSetting('license_token', data.token);
  clearOnlineInvalidState();
  rememberClaims(verifySignedClaims(data.token));
  return getState();
}

function publicPairing(pairing = pendingPairing) {
  if (!pairing) return null;
  return {
    pair_id: pairing.pairId,
    authorize_url: pairing.authorizeUrl,
    expires_at: pairing.expiresAt,
    poll_interval: pairing.pollInterval,
  };
}

function validateAuthorizeUrl(value) {
  const target = new URL(String(value || ''));
  const licenseOrigin = new URL(config.LICENSE_API_URL).origin;
  if (target.origin !== licenseOrigin || target.pathname !== '/activate') {
    throw new Error('Liên kết kích hoạt không hợp lệ');
  }
  return target.toString();
}

async function startPairing() {
  const hwid = getHwid();
  const res = await licenseFetch(config.LICENSE_API_URL + '/api/license/pair-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hwid, product: config.LICENSE_PRODUCT }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.pair_id || !data.device_secret) {
    throw new Error(data.detail || data.error || 'Không tạo được liên kết kích hoạt');
  }

  pendingPairing = {
    pairId: String(data.pair_id),
    deviceSecret: String(data.device_secret),
    authorizeUrl: validateAuthorizeUrl(data.authorize_url),
    expiresAt: String(data.expires_at || ''),
    pollInterval: Math.max(2, Number(data.poll_interval) || 2),
  };
  return publicPairing();
}

async function pollPairing() {
  const current = pendingPairing;
  if (!current) {
    return { status: 'none', reason: 'Chưa có phiên kích hoạt' };
  }
  if (!current.expiresAt || new Date(current.expiresAt).getTime() <= Date.now()) {
    pendingPairing = null;
    return { status: 'expired', reason: 'Phiên kích hoạt đã hết hạn' };
  }

  const res = await licenseFetch(config.LICENSE_API_URL + '/api/license/pair-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pair_id: current.pairId,
      device_secret: current.deviceSecret,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 410 || data.status === 'expired') {
    pendingPairing = null;
    return { status: 'expired', reason: data.error || 'Phiên kích hoạt đã hết hạn' };
  }
  if (!res.ok) throw new Error(data.detail || data.error || 'Chưa kiểm tra được phiên kích hoạt');
  if (data.status !== 'activated') {
    return {
      status: data.status || 'pending',
      expires_at: current.expiresAt,
      poll_interval: current.pollInterval,
    };
  }

  const claims = verifySignedClaims(data.token);
  if (
    !claims
    || claims.hwid !== getHwid()
    || claims.product !== config.LICENSE_PRODUCT
    || claims.key !== data.key
  ) {
    throw new Error('License trả về không khớp với máy này');
  }
  setSetting('license_key', data.key);
  setSetting('license_token', data.token);
  clearOnlineInvalidState();
  rememberClaims(claims);
  pendingPairing = null;
  return { status: 'activated', ...getState() };
}

function classifyOnlineFailure(data = {}) {
  const message = String(data.error || data.reason || data.message || '').trim();
  if (/hết hạn|het han|expired/i.test(message)) {
    return { status: 'expired', reason: 'License đã hết hạn' };
  }
  if (/thu hồi|thu hoi|revoked|khóa|khoa|blocked/i.test(message)) {
    return { status: 'revoked', reason: 'License đã bị thu hồi' };
  }
  if (/máy khác|may khac|machine|hwid/i.test(message)) {
    return { status: 'wrong_machine', reason: 'License thuộc máy khác' };
  }
  return { status: 'invalid', reason: message || 'License không hợp lệ' };
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
    const res = await licenseFetch(config.LICENSE_API_URL + '/api/license/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, hwid, product: config.LICENSE_PRODUCT }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.valid && data.token) {
      setSetting('license_token', data.token);
      clearOnlineInvalidState();
      rememberClaims(verifySignedClaims(data.token));
    } else if (data.valid === false || res.status === 403 || res.status === 404) {
      const failure = classifyOnlineFailure(data);
      setSetting('license_last_status', failure.status);
      setSetting('license_last_reason', failure.reason);
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
    const token = getSetting('license_token');
    const res = await licenseFetch(
      config.LICENSE_API_URL + '/api/orders?hwid=' + encodeURIComponent(hwid) +
        '&product=' + encodeURIComponent(config.LICENSE_PRODUCT),
      { headers: { Authorization: `Bearer ${token || ''}` } }
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
  startPairing,
  pollPairing,
  publicPairing,
  verifyOnline,
  verifySignedClaims,
  verifyTokenOffline,
  getState,
  isValid,
  getAllowedPlatforms,
  assertPlatform,
  getOrders,
  webUrl: () => config.LICENSE_API_URL,
};
