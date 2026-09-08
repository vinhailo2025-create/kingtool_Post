const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const db = require('../database/init');
const DataService = require('./data.service');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SYNC_ID_HEADER = '_SPK_SYNC_ID';
const UPDATED_AT_HEADER = '_SPK_UPDATED_AT';
const PLATFORMS = ['facebook', 'tiktok', 'youtube', 'threads', 'instagram', 'x', 'zalovideo'];
const SHEET_NAMES = {
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  threads: 'Threads',
  instagram: 'Instagram',
  x: 'X',
  zalovideo: 'Zalo Video',
};
const VALID_INTERVALS = new Set([1, 5, 15, 30, 60]);
const VALID_DIRECTIONS = new Set(['push', 'pull', 'two_way']);

let tokenCache = null;
let autoTimer = null;
let autoRunning = false;

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null ? String(row.value) : fallback;
}

function setSettings(values) {
  const statement = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const save = db.transaction((entries) => {
    for (const [key, value] of entries) statement.run(key, String(value ?? ''));
  });
  save(Object.entries(values));
}

function secretPaths() {
  return {
    data: config.GOOGLE_SHEETS_SECRETS_PATH,
    key: config.GOOGLE_SHEETS_SECRETS_KEY_PATH,
  };
}

function readSecretKey() {
  const paths = secretPaths();
  fs.mkdirSync(path.dirname(paths.key), { recursive: true });
  if (!fs.existsSync(paths.key)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(paths.key, key, { mode: 0o600 });
    return key;
  }
  const key = fs.readFileSync(paths.key);
  if (key.length !== 32) throw new Error('Khóa bảo vệ Google Sheets không hợp lệ.');
  return key;
}

function readSecrets() {
  const paths = secretPaths();
  if (!fs.existsSync(paths.data)) return {};
  try {
    const payload = JSON.parse(fs.readFileSync(paths.data, 'utf8'));
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      readSecretKey(),
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8'));
  } catch (error) {
    throw new Error('Không đọc được JSON quyền Google Sheets. Hãy chọn và lưu lại file JSON.');
  }
}

function writeSecrets(secrets) {
  const paths = secretPaths();
  fs.mkdirSync(path.dirname(paths.data), { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', readSecretKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final(),
  ]);
  const payload = JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
  const tempPath = `${paths.data}.tmp`;
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  fs.renameSync(tempPath, paths.data);
}

function normalizeCredentials(input) {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error('File JSON quyền không đúng định dạng.');
    }
  }
  if (!value || typeof value !== 'object') throw new Error('Hãy chọn file JSON Service Account.');
  const clientEmail = String(value.client_email || '').trim();
  const privateKey = String(value.private_key || '').replace(/\\n/g, '\n').trim();
  if (!clientEmail || !privateKey) {
    throw new Error('JSON phải có client_email và private_key của Google Service Account.');
  }
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('private_key trong JSON Service Account không hợp lệ.');
  }
  const tokenUri = String(value.token_uri || GOOGLE_TOKEN_URL).trim();
  let tokenUrl;
  try {
    tokenUrl = new URL(tokenUri);
  } catch (error) {
    throw new Error('token_uri trong JSON Service Account không hợp lệ.');
  }
  if (tokenUrl.protocol !== 'https:' || !['oauth2.googleapis.com', 'www.googleapis.com'].includes(tokenUrl.hostname)) {
    throw new Error('JSON quyền phải sử dụng máy chủ xác thực chính thức của Google.');
  }
  return {
    type: 'service_account',
    project_id: String(value.project_id || '').trim(),
    private_key_id: String(value.private_key_id || '').trim(),
    private_key: `${privateKey}\n`,
    client_email: clientEmail,
    client_id: String(value.client_id || '').trim(),
    token_uri: tokenUri,
  };
}

function parseSpreadsheetId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const urlMatch = text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text;
  throw new Error('Link hoặc ID Google Sheets không hợp lệ.');
}

function encodeJwt(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: SHEETS_SCOPE,
    aud: credentials.token_uri || GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key)
    .toString('base64url');
  return `${unsigned}.${signature}`;
}

async function getAccessToken() {
  const credentials = readSecrets().credentials;
  if (!credentials) throw new Error('Chưa lưu JSON quyền Google Service Account.');
  if (tokenCache
      && tokenCache.clientEmail === credentials.client_email
      && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: encodeJwt(credentials),
  });
  const response = await fetch(credentials.token_uri || GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Không lấy được quyền truy cập Google Sheets.');
  }
  tokenCache = {
    clientEmail: credentials.client_email,
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

async function googleRequest(url, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || data.error_description || `Google Sheets phản hồi HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function spreadsheetId() {
  const id = getSetting('google_sheets_spreadsheet_id');
  if (!id) throw new Error('Chưa nhập link Google Sheets.');
  return id;
}

function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function columnName(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

async function metadata() {
  const id = spreadsheetId();
  return googleRequest(`${SHEETS_API}/${encodeURIComponent(id)}?fields=properties.title,sheets.properties`);
}

async function ensureSheet(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error('Nền tảng đồng bộ không hợp lệ.');
  const title = SHEET_NAMES[platform];
  const info = await metadata();
  const found = (info.sheets || []).find(sheet => sheet.properties?.title === title);
  if (found) return found.properties;

  const result = await googleRequest(`${SHEETS_API}/${encodeURIComponent(spreadsheetId())}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }],
    }),
  });
  return result.replies?.[0]?.addSheet?.properties || { title };
}

async function readValues(platform) {
  const properties = await ensureSheet(platform);
  const range = `${quoteSheetName(properties.title)}!A:ZZZ`;
  const result = await googleRequest(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId())}/values/${encodeURIComponent(range)}?majorDimension=ROWS`
  );
  const values = Array.isArray(result.values) ? result.values : [];
  const headers = (values[0] || []).map(value => String(value || '').trim());
  const rows = values.slice(1).map((valuesRow, index) => {
    const object = {};
    headers.forEach((header, columnIndex) => {
      if (header) object[header] = valuesRow[columnIndex] ?? '';
    });
    return { rowNumber: index + 2, object };
  });
  return { properties, headers, rows };
}

async function writeMatrix(properties, headers, rows) {
  const matrix = [
    headers,
    ...rows.map(row => headers.map(header => row.object?.[header] ?? '')),
  ];
  const endColumn = columnName(Math.max(0, headers.length - 1));
  const range = `${quoteSheetName(properties.title)}!A1:${endColumn}${matrix.length}`;
  await googleRequest(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId())}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values: matrix }) }
  );

  const technicalStart = headers.indexOf(SYNC_ID_HEADER);
  if (Number.isInteger(properties.sheetId) && technicalStart >= 0) {
    await googleRequest(`${SHEETS_API}/${encodeURIComponent(spreadsheetId())}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          updateDimensionProperties: {
            range: {
              sheetId: properties.sheetId,
              dimension: 'COLUMNS',
              startIndex: technicalStart,
              endIndex: headers.length,
            },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser',
          },
        }, {
          updateSheetProperties: {
            properties: { sheetId: properties.sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        }],
      }),
    });
  }
}

function ensureSyncKeys(platform) {
  const missing = db.prepare(
    "SELECT id FROM posts WHERE platform = ? AND (sync_key IS NULL OR sync_key = '')"
  ).all(platform);
  const update = db.prepare('UPDATE posts SET sync_key = ? WHERE id = ? AND platform = ?');
  const apply = db.transaction((rows) => {
    for (const row of rows) update.run(crypto.randomUUID(), row.id, platform);
  });
  apply(missing);
}

function localSnapshot(platform, selectedIds = null) {
  ensureSyncKeys(platform);
  const schema = DataService.getExportColumnSchema(platform);
  const allPosts = DataService.getAllWithCustomData(platform);
  const selected = Array.isArray(selectedIds) && selectedIds.length
    ? new Set(selectedIds.map(Number))
    : null;
  const posts = selected ? allPosts.filter(post => selected.has(Number(post.id))) : allPosts;
  const headers = schema.map(column => column.header);
  const rows = posts.map((post) => {
    const fullIndex = allPosts.findIndex(item => item.id === post.id);
    const object = {};
    schema.forEach((column) => {
      if (column.kind === 'rownum') object[column.header] = fullIndex + 1;
      else if (column.kind === 'builtin') object[column.header] = post[column.field] ?? '';
      else object[column.header] = post[`custom_${column.id}`] ?? '';
    });
    return {
      id: post.id,
      syncKey: post.sync_key,
      updatedAt: post.updated_at || new Date().toISOString(),
      object,
    };
  });
  return { schema, headers, rows };
}

function suppressedKeys(platform) {
  try {
    const value = JSON.parse(getSetting(`google_sheets_suppressed_${platform}`, '[]'));
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch (error) {
    return new Set();
  }
}

function saveSuppressedKeys(platform, values) {
  setSettings({ [`google_sheets_suppressed_${platform}`]: JSON.stringify([...values]) });
}

function mergedHeaders(localHeaders, sheetHeaders) {
  const wanted = new Set(localHeaders.map(header => header.toLowerCase()));
  const extras = sheetHeaders.filter((header) => {
    const value = String(header || '').trim();
    return value
      && value !== SYNC_ID_HEADER
      && value !== UPDATED_AT_HEADER
      && !wanted.has(value.toLowerCase());
  });
  return [...localHeaders, ...extras, SYNC_ID_HEADER, UPDATED_AT_HEADER];
}

function saveLastResult(action, result) {
  const payload = {
    action,
    success: true,
    at: new Date().toISOString(),
    result,
  };
  setSettings({ google_sheets_last_result: JSON.stringify(payload) });
  return payload;
}

async function pushPlatform(platform, options = {}) {
  const snapshot = localSnapshot(platform, options.selectedIds);
  const sheet = await readValues(platform);
  const headers = mergedHeaders(snapshot.headers, sheet.headers);
  const rows = sheet.rows.map(row => ({ ...row, object: { ...row.object } }));
  const bySyncKey = new Map(rows
    .filter(row => row.object[SYNC_ID_HEADER])
    .map(row => [String(row.object[SYNC_ID_HEADER]), row]));
  const suppressed = suppressedKeys(platform);
  let added = 0;
  let updated = 0;

  if (options.restoreSuppressed) {
    for (const row of snapshot.rows) suppressed.delete(String(row.syncKey));
    saveSuppressedKeys(platform, suppressed);
  }

  for (const local of snapshot.rows) {
    if (suppressed.has(String(local.syncKey))) continue;
    let target = bySyncKey.get(String(local.syncKey));
    if (!target) {
      target = { rowNumber: rows.length + 2, object: {} };
      rows.push(target);
      bySyncKey.set(String(local.syncKey), target);
      added += 1;
    } else {
      updated += 1;
    }
    for (const header of snapshot.headers) target.object[header] = local.object[header] ?? '';
    target.object[SYNC_ID_HEADER] = local.syncKey;
    target.object[UPDATED_AT_HEADER] = local.updatedAt;
  }

  await writeMatrix(sheet.properties, headers, rows);
  return { platform, added, updated, total: snapshot.rows.length };
}

function mapSheetRow(platform, headers, object) {
  const schema = DataService.getExportColumnSchema(platform);
  const byHeader = new Map(schema.map(column => [String(column.header).toLowerCase(), column]));
  const builtin = {};
  const custom = {};
  for (const header of headers) {
    const column = byHeader.get(String(header).toLowerCase());
    if (!column || column.kind === 'rownum') continue;
    const value = String(object[header] ?? '');
    if (column.kind === 'builtin') builtin[column.field] = value;
    else custom[column.id] = value;
  }
  return { builtin, custom };
}

async function pullPlatform(platform) {
  const sheet = await readValues(platform);
  if (!sheet.headers.length) return { platform, added: 0, updated: 0, total: 0 };
  let added = 0;
  let updated = 0;
  const touchedIds = [];

  for (const row of sheet.rows) {
    const mapped = mapSheetRow(platform, sheet.headers, row.object);
    const hasData = Object.values(mapped.builtin).some(value => String(value).trim())
      || Object.values(mapped.custom).some(value => String(value).trim());
    if (!hasData) continue;

    let syncKey = String(row.object[SYNC_ID_HEADER] || '').trim();
    let post = syncKey
      ? db.prepare('SELECT * FROM posts WHERE platform = ? AND sync_key = ?').get(platform, syncKey)
      : null;
    if (post) {
      DataService.update(post.id, mapped.builtin, platform);
      updated += 1;
    } else {
      post = DataService.create(mapped.builtin, platform);
      syncKey = syncKey || crypto.randomUUID();
      db.prepare('UPDATE posts SET sync_key = ? WHERE id = ? AND platform = ?')
        .run(syncKey, post.id, platform);
      added += 1;
    }
    for (const [columnId, value] of Object.entries(mapped.custom)) {
      DataService.setCustomData(post.id, Number(columnId), value, platform);
    }
    touchedIds.push(post.id);
  }

  if (touchedIds.length) {
    await pushPlatform(platform, { selectedIds: touchedIds });
  }
  return { platform, added, updated, total: touchedIds.length };
}

async function deleteSelectedFromSheet(platform, selectedIds) {
  const ids = Array.isArray(selectedIds) ? selectedIds.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) throw new Error('Hãy chọn ít nhất một hàng để xóa khỏi Google Sheets.');
  ensureSyncKeys(platform);
  const placeholders = ids.map(() => '?').join(',');
  const localRows = db.prepare(
    `SELECT id, sync_key FROM posts WHERE platform = ? AND id IN (${placeholders})`
  ).all(platform, ...ids);
  const keys = new Set(localRows.map(row => String(row.sync_key || '')).filter(Boolean));
  const sheet = await readValues(platform);
  const rowIndexes = sheet.rows
    .filter(row => keys.has(String(row.object[SYNC_ID_HEADER] || '')))
    .map(row => row.rowNumber - 1)
    .sort((a, b) => b - a);

  if (rowIndexes.length && Number.isInteger(sheet.properties.sheetId)) {
    await googleRequest(`${SHEETS_API}/${encodeURIComponent(spreadsheetId())}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: rowIndexes.map(index => ({
          deleteDimension: {
            range: {
              sheetId: sheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: index,
              endIndex: index + 1,
            },
          },
        })),
      }),
    });
  }
  const suppressed = suppressedKeys(platform);
  for (const key of keys) suppressed.add(key);
  saveSuppressedKeys(platform, suppressed);
  return { platform, deleted: rowIndexes.length, selected: ids.length };
}

async function runAction(action, platform, selectedIds = null) {
  if (!PLATFORMS.includes(platform)) throw new Error('Nền tảng đồng bộ không hợp lệ.');
  if (action === 'push') {
    return pushPlatform(platform, { selectedIds, restoreSuppressed: true });
  }
  if (action === 'pull') return pullPlatform(platform);
  if (action === 'two_way') {
    const pulled = await pullPlatform(platform);
    const pushed = await pushPlatform(platform);
    return { platform, pulled, pushed };
  }
  if (action === 'delete') return deleteSelectedFromSheet(platform, selectedIds);
  throw new Error('Thao tác đồng bộ không hợp lệ.');
}

async function sync(action, platform, selectedIds = null) {
  const result = await runAction(action, platform, selectedIds);
  saveLastResult(action, result);
  return result;
}

async function syncAll(action) {
  if (!VALID_DIRECTIONS.has(action)) throw new Error('Chế độ đồng bộ tự động không hợp lệ.');
  const results = [];
  for (const platform of PLATFORMS) {
    results.push(await runAction(action, platform));
  }
  saveLastResult(action, results);
  return results;
}

function getPublicSettings() {
  let secrets = {};
  try {
    secrets = readSecrets();
  } catch (error) {}
  let lastResult = null;
  try {
    lastResult = JSON.parse(getSetting('google_sheets_last_result', 'null'));
  } catch (error) {}
  return {
    hasCredentials: Boolean(secrets.credentials),
    clientEmail: secrets.credentials?.client_email || '',
    projectId: secrets.credentials?.project_id || '',
    credentialFileName: getSetting('google_sheets_credential_file_name'),
    spreadsheetId: getSetting('google_sheets_spreadsheet_id'),
    spreadsheetUrl: getSetting('google_sheets_spreadsheet_url'),
    autoEnabled: getSetting('google_sheets_auto_enabled', '0') === '1',
    autoInterval: Number(getSetting('google_sheets_auto_interval', '15')) || 15,
    autoDirection: getSetting('google_sheets_auto_direction', 'push'),
    lastResult,
  };
}

function saveConfig(input = {}) {
  const current = getPublicSettings();
  const values = {};
  if (input.credentialsJson) {
    const credentials = normalizeCredentials(input.credentialsJson);
    writeSecrets({ credentials });
    tokenCache = null;
    values.google_sheets_credential_file_name = String(input.credentialFileName || 'service-account.json');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'spreadsheetUrl')) {
    const url = String(input.spreadsheetUrl || '').trim();
    values.google_sheets_spreadsheet_url = url;
    values.google_sheets_spreadsheet_id = parseSpreadsheetId(url);
  }
  const interval = Number(input.autoInterval ?? current.autoInterval);
  const direction = String(input.autoDirection || current.autoDirection || 'push');
  if (!VALID_INTERVALS.has(interval)) throw new Error('Chu kỳ tự động phải là 1, 5, 15, 30 hoặc 60 phút.');
  if (!VALID_DIRECTIONS.has(direction)) throw new Error('Chế độ đồng bộ tự động không hợp lệ.');
  values.google_sheets_auto_enabled = input.autoEnabled ? '1' : '0';
  values.google_sheets_auto_interval = interval;
  values.google_sheets_auto_direction = direction;
  setSettings(values);
  return getPublicSettings();
}

function removeCredentials() {
  const paths = secretPaths();
  if (fs.existsSync(paths.data)) fs.unlinkSync(paths.data);
  tokenCache = null;
  setSettings({
    google_sheets_credential_file_name: '',
    google_sheets_auto_enabled: '0',
  });
  return getPublicSettings();
}

async function testConnection() {
  const info = await metadata();
  return {
    connected: true,
    spreadsheetTitle: info.properties?.title || '',
    sheetCount: Array.isArray(info.sheets) ? info.sheets.length : 0,
    clientEmail: getPublicSettings().clientEmail,
  };
}

async function autoTick() {
  if (autoRunning) return;
  const settings = getPublicSettings();
  if (!settings.autoEnabled || !settings.hasCredentials || !settings.spreadsheetId) return;
  const lastAt = Date.parse(settings.lastResult?.at || '') || 0;
  if (Date.now() - lastAt < settings.autoInterval * 60000) return;
  autoRunning = true;
  try {
    await syncAll(settings.autoDirection);
  } catch (error) {
    setSettings({
      google_sheets_last_result: JSON.stringify({
        action: settings.autoDirection,
        success: false,
        at: new Date().toISOString(),
        error: error.message,
      }),
    });
  } finally {
    autoRunning = false;
  }
}

function startAutoSync() {
  if (autoTimer) return;
  autoTimer = setInterval(() => autoTick().catch(() => {}), 30000);
  setTimeout(() => autoTick().catch(() => {}), 5000);
}

function stopAutoSync() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

module.exports = {
  PLATFORMS,
  SHEET_NAMES,
  SYNC_ID_HEADER,
  UPDATED_AT_HEADER,
  deleteSelectedFromSheet,
  getPublicSettings,
  normalizeCredentials,
  parseSpreadsheetId,
  pullPlatform,
  pushPlatform,
  removeCredentials,
  saveConfig,
  startAutoSync,
  stopAutoSync,
  sync,
  syncAll,
  testConnection,
  _test: {
    columnName,
    encodeJwt,
    mergedHeaders,
    readSecrets,
    writeSecrets,
  },
};
