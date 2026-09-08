const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-google-sheets-'));
process.env.COVERGEMAUTO_DATA_DIR = testRoot;

const config = require('../config');
const db = require('../src/database/init');
const DataService = require('../src/services/data.service');
const GoogleSheetsService = require('../src/services/google-sheets.service');

let originalFetch;
let sheetValues = [];
let batchRequests = [];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installGoogleMock() {
  originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'test-access-token', expires_in: 3600 });
    }
    if (value.includes('?fields=properties.title,sheets.properties')) {
      return jsonResponse({
        properties: { title: 'Super Post Test' },
        sheets: [{ properties: { sheetId: 101, title: 'Facebook' } }],
      });
    }
    if (value.includes('/values/')) {
      if ((options.method || 'GET') === 'PUT') {
        const body = JSON.parse(options.body);
        sheetValues = body.values;
        return jsonResponse({ updatedRows: sheetValues.length });
      }
      return jsonResponse({ values: sheetValues });
    }
    if (value.endsWith(':batchUpdate')) {
      const body = JSON.parse(options.body || '{}');
      batchRequests.push(...(body.requests || []));
      const deleteIndexes = (body.requests || [])
        .map(request => request.deleteDimension?.range?.startIndex)
        .filter(Number.isInteger)
        .sort((a, b) => b - a);
      for (const index of deleteIndexes) sheetValues.splice(index, 1);
      return jsonResponse({ replies: [] });
    }
    return jsonResponse({ error: { message: `Unexpected URL: ${value}` } }, 404);
  };
}

test.before(async () => {
  await db.waitReady();
  installGoogleMock();
});

test.after(() => {
  global.fetch = originalFetch;
  try { db.close(); } catch (error) {}
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('lưu JSON Service Account dạng mã hóa và kiểm tra kết nối thành công', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const credentials = {
    type: 'service_account',
    project_id: 'super-post-test',
    private_key: privateKey,
    client_email: 'sync-test@super-post-test.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const spreadsheetUrl = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';

  const saved = GoogleSheetsService.saveConfig({
    credentialsJson: JSON.stringify(credentials),
    credentialFileName: 'sync-test.json',
    spreadsheetUrl,
    autoEnabled: false,
    autoInterval: 15,
    autoDirection: 'push',
  });

  assert.equal(saved.hasCredentials, true);
  assert.equal(saved.clientEmail, credentials.client_email);
  assert.equal(saved.spreadsheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(Object.hasOwn(saved, 'privateKey'), false);

  const encrypted = fs.readFileSync(config.GOOGLE_SHEETS_SECRETS_PATH, 'utf8');
  assert.equal(encrypted.includes(credentials.private_key), false);
  assert.equal(encrypted.includes(credentials.client_email), false);

  const connected = await GoogleSheetsService.testConnection();
  assert.equal(connected.connected, true);
  assert.equal(connected.spreadsheetTitle, 'Super Post Test');
});

test('thêm, cập nhật, lấy về và xóa hàng đã chọn mà không xóa dữ liệu tool', async () => {
  const post = DataService.create({
    content: 'Nội dung ban đầu',
    image_path: 'C:\\media\\one.mp4',
    status: 'pending',
  }, 'facebook');
  DataService.ensurePlatformDefaultColumns('facebook');
  const profileColumn = DataService.getCustomColumns('facebook')
    .find(column => column.var_key === 'name_profile');
  assert.ok(profileColumn);
  DataService.setCustomData(post.id, profileColumn.id, 'super-1', 'facebook');

  const pushed = await GoogleSheetsService.pushPlatform('facebook', {
    selectedIds: [post.id],
    restoreSuppressed: true,
  });
  assert.equal(pushed.added, 1);
  assert.equal(sheetValues.length, 2);

  const headers = sheetValues[0];
  const contentIndex = headers.indexOf('Nội dung');
  const syncIndex = headers.indexOf(GoogleSheetsService.SYNC_ID_HEADER);
  assert.ok(contentIndex >= 0);
  assert.ok(syncIndex >= 0);
  assert.equal(sheetValues[1][contentIndex], 'Nội dung ban đầu');
  assert.ok(sheetValues[1][syncIndex]);

  sheetValues[1][contentIndex] = 'Nội dung sửa trên Sheet';
  const pulled = await GoogleSheetsService.pullPlatform('facebook');
  assert.equal(pulled.updated, 1);
  assert.equal(
    DataService.getAll('facebook').find(row => row.id === post.id).content,
    'Nội dung sửa trên Sheet'
  );

  const deleted = await GoogleSheetsService.deleteSelectedFromSheet('facebook', [post.id]);
  assert.equal(deleted.deleted, 1);
  assert.equal(sheetValues.length, 1);
  assert.equal(
    DataService.getAll('facebook').find(row => row.id === post.id).content,
    'Nội dung sửa trên Sheet'
  );

  await GoogleSheetsService.pushPlatform('facebook');
  assert.equal(sheetValues.length, 1, 'auto push must not restore a manually deleted Sheet row');

  await GoogleSheetsService.pushPlatform('facebook', {
    selectedIds: [post.id],
    restoreSuppressed: true,
  });
  assert.equal(sheetValues.length, 2, 'manual add/update restores the selected row');
  assert.ok(batchRequests.some(request => request.deleteDimension));
});

test('parse link, chu kỳ và hướng đồng bộ được kiểm tra chặt chẽ', () => {
  assert.equal(
    GoogleSheetsService.parseSpreadsheetId('https://docs.google.com/spreadsheets/d/abcDEF_12345678901234567890/edit'),
    'abcDEF_12345678901234567890'
  );
  assert.throws(
    () => GoogleSheetsService.saveConfig({
      spreadsheetUrl: 'bad-link',
      autoEnabled: true,
      autoInterval: 2,
      autoDirection: 'push',
    }),
    /không hợp lệ|Chu kỳ/
  );
});
