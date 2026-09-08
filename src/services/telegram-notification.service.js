const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const db = require('../database/init');

const TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_STATUSES = ['success', 'error'];
const STATUS_OPTIONS = [
  { value: 'success', label: 'Thành công', icon: '✅' },
  { value: 'error', label: 'Lỗi', icon: '❌' },
  { value: 'running', label: 'Đang chạy', icon: '🔄' },
  { value: 'pending', label: 'Đang chờ', icon: '⏳' },
  { value: 'waiting_approval', label: 'Chờ duyệt', icon: '🕒' },
  { value: 'skipped', label: 'Bỏ qua', icon: '⏭️' },
  { value: 'blocked', label: 'Bị chặn', icon: '🚫' },
];
const DEFAULT_TEMPLATE = [
  '🔔 {{status}}',
  '',
  'Nền tảng: {{platform}}',
  'Profile: {{profile}}',
  'Hàng dữ liệu: {{row}}',
  'Thời gian: {{time}}',
  '',
  '{{detail}}',
].join('\n');
const BOT_COMMANDS = Object.freeze([
  { command: 'start', description: 'Mở menu và reset thao tác đang làm' },
  { command: 'reset', description: 'Xóa thao tác hiện tại và về menu đầu' },
  { command: 'post', description: 'Bắt đầu luồng đăng bài' },
  { command: 'status', description: 'Xem tác vụ đang chạy' },
  { command: 'report', description: 'Xem tổng kết đăng bài hôm nay' },
  { command: 'help', description: 'Xem hướng dẫn lệnh' },
]);

let fetchImpl = (...args) => fetch(...args);
let pollTimer = null;
let polling = false;

function settingValue(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null ? String(row.value) : fallback;
}

function setSettings(values) {
  const statement = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(entries => entries.forEach(([key, value]) => statement.run(key, String(value ?? ''))))(Object.entries(values));
}

function secretPaths() {
  return { data: config.TELEGRAM_SECRETS_PATH, key: config.TELEGRAM_SECRETS_KEY_PATH };
}

function readKey() {
  const paths = secretPaths();
  fs.mkdirSync(path.dirname(paths.key), { recursive: true });
  if (!fs.existsSync(paths.key)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(paths.key, key, { mode: 0o600 });
    return key;
  }
  const key = fs.readFileSync(paths.key);
  if (key.length !== 32) throw new Error('Khóa bảo vệ Telegram không hợp lệ.');
  return key;
}

function readSecrets() {
  const paths = secretPaths();
  if (!fs.existsSync(paths.data)) return {};
  try {
    const payload = JSON.parse(fs.readFileSync(paths.data, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', readKey(), Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]).toString('utf8'));
  } catch (_) {
    throw new Error('Không đọc được cấu hình Telegram đã lưu. Hãy kết nối lại bot.');
  }
}

function writeSecrets(secrets) {
  const paths = secretPaths();
  fs.mkdirSync(path.dirname(paths.data), { recursive: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', readKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
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

function normalizeStatuses(statuses) {
  const values = Array.isArray(statuses) ? statuses : String(statuses || '').split(',');
  const valid = new Set(STATUS_OPTIONS.map(item => item.value));
  const normalized = [...new Set(values.map(value => String(value || '').trim()).filter(value => valid.has(value)))];
  return normalized.length ? normalized : DEFAULT_STATUSES.slice();
}

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  const aliases = {
    'thành công': 'success',
    'thanh cong': 'success',
    'lỗi': 'error',
    'loi': 'error',
    'đang chạy': 'running',
    'dang chay': 'running',
    'đang chờ': 'pending',
    'dang cho': 'pending',
    waiting: 'pending',
    queued: 'pending',
    approval_checking: 'waiting_approval',
    'chờ duyệt': 'waiting_approval',
    'cho duyet': 'waiting_approval',
    'bỏ qua': 'skipped',
    'bo qua': 'skipped',
    'bị chặn': 'blocked',
    'bi chan': 'blocked',
  };
  return aliases[value] || value;
}

function statusMeta(status) {
  return STATUS_OPTIONS.find(item => item.value === normalizeStatus(status)) || {
    value: normalizeStatus(status),
    label: String(status || 'Cập nhật'),
    icon: '🔔',
  };
}

function maskToken(token) {
  const value = String(token || '');
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

async function telegramRequest(token, method, body = {}, timeoutMs = 10000) {
  if (!token) throw new Error('Chưa nhập Bot Token Telegram.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.description || `Telegram ${method} thất bại`);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function settings() {
  return {
    enabled: settingValue('telegram_enabled', '0') === '1',
    statuses: normalizeStatuses(settingValue('telegram_statuses', DEFAULT_STATUSES.join(','))),
    template: settingValue('telegram_template', DEFAULT_TEMPLATE) || DEFAULT_TEMPLATE,
    controlEnabled: settingValue('telegram_control_enabled', '0') === '1',
    controlAiEnabled: settingValue('telegram_control_ai_enabled', '1') !== '0',
  };
}

function publicState() {
  const secret = readSecrets();
  const configState = settings();
  return {
    ...configState,
    tokenHint: maskToken(secret.token),
    hasToken: Boolean(secret.token),
    connected: Array.isArray(secret.chatIds) && secret.chatIds.length > 0,
    chatIds: (secret.chatIds || []).map(Number),
    chats: (secret.chats || []).map(chat => ({
      id: chat.id,
      title: chat.title || chat.username || `Chat ${chat.id}`,
      type: chat.type,
    })),
    bot: secret.bot ? { id: secret.bot.id, username: secret.bot.username, firstName: secret.bot.first_name } : null,
    waitingForStart: Boolean(secret.token) && !(secret.chatIds || []).length,
  };
}

async function discoverChats() {
  const secret = readSecrets();
  if (!secret.token) return [];
  const updates = await telegramRequest(secret.token, 'getUpdates', {
    offset: Number(secret.offset || 0),
    limit: 100,
    timeout: 0,
    allowed_updates: ['message', 'channel_post', 'callback_query', 'my_chat_member'],
  }, 12000);
  if (!Array.isArray(updates) || updates.length === 0) return secret.chats || [];
  const chats = [...(secret.chats || [])];
  const previousChatIds = new Set((secret.chatIds || []).map(String));
  let addedChat = false;
  let offset = Number(secret.offset || 0);
  for (const update of updates) {
    offset = Math.max(offset, Number(update.update_id || 0) + 1);
    const message = update.message || update.channel_post;
    const text = String(message?.text || '').trim();
    if (!message?.chat || !/^\/start(?:@\S+)?(?:\s|$)/i.test(text)) continue;
    const chat = message.chat;
    if (!chats.some(item => String(item.id) === String(chat.id))) {
      chats.push({
        id: chat.id,
        type: chat.type,
        title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || `Chat ${chat.id}`,
        username: chat.username || '',
      });
      addedChat = true;
    }
  }
  secret.offset = offset;
  secret.chats = chats.slice(-20);
  secret.chatIds = chats.map(chat => chat.id);
  writeSecrets(secret);
  if (addedChat) {
    await Promise.allSettled(chats.filter(chat => !previousChatIds.has(String(chat.id))).map(chat => telegramRequest(
      secret.token,
      'sendMessage',
      { chat_id: chat.id, text: '✅ Kết nối thành công với Super Post - King!\nTool sẽ gửi trạng thái theo lựa chọn của bạn.' },
      8000
    )));
  }
  try {
    const ControlService = require('./telegram-control.service');
    for (const update of updates) {
      const updateChatId = update.callback_query?.message?.chat?.id
        || update.message?.chat?.id
        || update.channel_post?.chat?.id;
      if (updateChatId != null && secret.chatIds.map(String).includes(String(updateChatId))) {
        await ControlService.handleUpdate(update);
      }
    }
  } catch (_) {}
  return chats;
}

function renderTemplate(template, values) {
  const source = String(template || DEFAULT_TEMPLATE);
  const output = source.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => (
    values[key.toLowerCase()] == null ? '' : String(values[key.toLowerCase()])
  ));
  return output.split(/\r?\n/).filter((line, index, lines) => (
    line.trim() || (index > 0 && lines[index - 1].trim() && lines[index + 1]?.trim())
  )).join('\n').trim();
}

function detailFor(input, status) {
  const details = [];
  if (input.detail) details.push(input.detail);
  if (input.error) details.push(`Lỗi: ${input.error}`);
  if (input.link) details.push(input.link);
  if (!details.length && status === 'success' && input.content) details.push(input.content);
  return details.join('\n');
}

async function registerCommands(token) {
  if (!token) return false;
  try {
    await telegramRequest(token, 'setMyCommands', { commands: BOT_COMMANDS });
    return true;
  } catch (_) {
    return false;
  }
}

async function connect(token) {
  const cleanToken = String(token || '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(cleanToken)) {
    throw new Error('Bot Token Telegram không đúng định dạng.');
  }
  const bot = await telegramRequest(cleanToken, 'getMe');
  await registerCommands(cleanToken);
  const previous = readSecrets();
  writeSecrets({
    ...previous,
    token: cleanToken,
    bot,
    offset: 0,
    chatIds: previous.token === cleanToken ? (previous.chatIds || []) : [],
    chats: previous.token === cleanToken ? (previous.chats || []) : [],
  });
  startPolling();
  return publicState();
}

async function disconnect() {
  const previous = readSecrets();
  delete previous.token;
  delete previous.bot;
  delete previous.chatIds;
  delete previous.chats;
  delete previous.offset;
  writeSecrets(previous);
  return publicState();
}

async function saveSettings(input = {}) {
  const values = {};
  if (input.enabled !== undefined) values.telegram_enabled = input.enabled ? '1' : '0';
  if (input.statuses !== undefined) values.telegram_statuses = normalizeStatuses(input.statuses).join(',');
  if (input.template !== undefined) {
    const template = String(input.template || '').trim();
    values.telegram_template = template || DEFAULT_TEMPLATE;
  }
  if (input.controlEnabled !== undefined) values.telegram_control_enabled = input.controlEnabled ? '1' : '0';
  if (input.controlAiEnabled !== undefined) values.telegram_control_ai_enabled = input.controlAiEnabled ? '1' : '0';
  if (Object.keys(values).length) setSettings(values);
  if (input.chatIds !== undefined) {
    const secret = readSecrets();
    const valid = (Array.isArray(input.chatIds) ? input.chatIds : []).map(Number).filter(Number.isFinite);
    secret.chatIds = valid;
    writeSecrets(secret);
  }
  return publicState();
}

async function pollNow() {
  try {
    return await discoverChats();
  } catch (_) {
    return [];
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!polling) {
      polling = true;
      pollNow().finally(() => { polling = false; });
    }
  }, 4000);
  pollTimer.unref?.();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function sendMessage(text) {
  const secret = readSecrets();
  const chatIds = [...new Set((secret.chatIds || []).map(Number).filter(Number.isFinite))];
  if (!secret.token || !chatIds.length) return { sent: 0, skipped: 'not_connected' };
  let sent = 0;
  for (const chatId of chatIds) {
    try {
      await telegramRequest(secret.token, 'sendMessage', { chat_id: chatId, text: String(text).slice(0, 4096) });
      sent += 1;
    } catch (_) {}
  }
  return { sent };
}

async function sendBotRequest(method, body = {}, timeoutMs = 10000) {
  const secret = readSecrets();
  if (!secret.token) throw new Error('Telegram chưa được kết nối.');
  return telegramRequest(secret.token, method, body, timeoutMs);
}

function internalState() {
  const secret = readSecrets();
  return { token: secret.token || '', chatIds: [...(secret.chatIds || [])], chats: [...(secret.chats || [])] };
}

async function test(message = '🔔 Thông báo thử từ Super Post - King') {
  const result = await sendMessage(message);
  if (!result.sent) throw new Error('Hãy mở bot và bấm Start trước khi gửi thử.');
  return result;
}

async function notifyStatusChange(input = {}) {
  try {
    const state = settings();
    const status = normalizeStatus(input.status);
    if (!state.enabled || !state.statuses.includes(status)) return { sent: 0, skipped: 'status_not_selected' };
    const meta = statusMeta(status);
    const timestamp = input.time || new Date().toLocaleString('vi-VN');
    const values = {
      status: meta.label,
      status_icon: meta.icon,
      platform: input.platform || '',
      profile: input.profile || input.profileName || '',
      row: input.row || input.postId || '',
      time: timestamp,
      link: input.link || '',
      error: input.error || '',
      content: input.content || '',
      detail: detailFor(input, status),
    };
    const text = renderTemplate(state.template, values);
    const dedupeKey = input.eventKey || `${values.platform}:${values.row}:${status}:${input.updatedAt || timestamp}`;
    const secret = readSecrets();
    if (secret.lastEvent === dedupeKey) return { sent: 0, skipped: 'duplicate' };
    const result = await sendMessage(text);
    if (result.sent > 0) {
      secret.lastEvent = dedupeKey;
      writeSecrets(secret);
    }
    return result;
  } catch (_) {
    return { sent: 0, skipped: 'notification_error' };
  }
}

function init() {
  const token = readSecrets().token;
  if (token) {
    registerCommands(token).catch(() => {});
    startPolling();
  }
}

function __setFetch(fn) { fetchImpl = fn; }
function __resetFetch() { fetchImpl = (...args) => fetch(...args); }

module.exports = {
  DEFAULT_TEMPLATE,
  DEFAULT_STATUSES,
  BOT_COMMANDS,
  STATUS_OPTIONS,
  settings,
  publicState,
  connect,
  disconnect,
  saveSettings,
  pollNow,
  startPolling,
  stopPolling,
  sendMessage,
  test,
  notifyStatusChange,
  init,
  renderTemplate,
  normalizeStatuses,
  __setFetch,
  __resetFetch,
  sendBotRequest,
  internalState,
};
