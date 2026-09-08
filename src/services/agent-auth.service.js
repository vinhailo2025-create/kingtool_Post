const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');

function validKey(value) {
  const key = String(value || '').trim();
  return /^[a-f0-9]{64}$/i.test(key) ? key : '';
}

function ensureKey() {
  const keyPath = config.AGENT_API_KEY_PATH;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    const existing = validKey(fs.readFileSync(keyPath, 'utf8'));
    if (existing) return existing;
  } catch (_) {}

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    const flag = fs.existsSync(keyPath) ? 'w' : 'wx';
    fs.writeFileSync(keyPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag });
    return generated;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = validKey(fs.readFileSync(keyPath, 'utf8'));
      if (existing) return existing;
    }
    throw error;
  }
}

function providedKey(req) {
  const authorization = String(req.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return String((bearer && bearer[1]) || req.headers['x-api-key'] || '').trim();
}

function equalKey(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function middleware(req, res, next) {
  try {
    if (!equalKey(providedKey(req), ensureKey())) {
      return res.status(401).json({
        success: false,
        error: 'Agent API key không hợp lệ.',
        code: 'AGENT_API_UNAUTHORIZED',
      });
    }
    next();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, code: 'AGENT_API_AUTH_ERROR' });
  }
}

module.exports = {
  ensureKey,
  middleware,
  keyPath: () => config.AGENT_API_KEY_PATH,
  _private: { equalKey, providedKey, validKey },
};
