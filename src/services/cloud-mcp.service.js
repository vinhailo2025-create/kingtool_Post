'use strict';

const os = require('os');
const config = require('../../config');
const db = require('../database/init');
const LicenseService = require('./license.service');
const {
  callTool,
  tools,
} = require('../../scripts/super-post-mcp-server');
const { normalizeCloudCommand } = require('./cloud-mcp-command');

const TOKEN_SETTING = 'cloud_mcp_device_token';
const DEVICE_ID_SETTING = 'cloud_mcp_device_id';
const ENABLED_SETTING = 'cloud_mcp_enabled';
const MAX_BACKOFF_MS = 60_000;

function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : '';
  } catch {
    return '';
  }
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? '' : String(value));
}

class CloudMcpService {
  constructor() {
    this.running = false;
    this.connected = false;
    this.processing = false;
    this.timer = null;
    this.backoffMs = 1500;
    this.lastSeenAt = '';
    this.lastError = '';
    this.currentCommand = null;
    this.forceReconnect = false;
    this.pendingCompletion = null;
  }

  endpoint(action) {
    return `${String(config.LICENSE_API_URL).replace(/\/$/, '')}/api/mcp-device?action=${encodeURIComponent(action)}`;
  }

  enabled() {
    return getSetting(ENABLED_SETTING) !== '0';
  }

  token() {
    return getSetting(TOKEN_SETTING);
  }

  deviceId() {
    return getSetting(DEVICE_ID_SETTING);
  }

  status() {
    const license = LicenseService.getState();
    return {
      enabled: this.enabled(),
      connected: this.connected,
      processing: this.processing,
      device_id: this.deviceId() || null,
      product: config.LICENSE_PRODUCT,
      app_version: config.APP_VERSION,
      last_seen_at: this.lastSeenAt || null,
      last_error: this.lastError || null,
      current_command: this.currentCommand,
      license_ready: license.valid === true,
      remote_mcp_url: `${String(config.LICENSE_API_URL).replace(/\/$/, '')}/mcp`,
    };
  }

  async request(action, body = {}, token = '') {
    const response = await fetch(this.endpoint(action), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const error = new Error(payload.message || payload.error || `Cloud MCP HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload.error || 'CLOUD_MCP_REQUEST_FAILED';
      throw error;
    }
    return payload.data;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(250);
  }

  stop() {
    this.running = false;
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  schedule(delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch(() => {});
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  async register() {
    const state = LicenseService.getState();
    if (!state.valid || !state.key) {
      const error = new Error(state.reason || 'License is not ready for Cloud MCP');
      error.code = 'LICENSE_NOT_READY';
      throw error;
    }
    const data = await this.request('register', {
      license_key: state.key,
      hwid: LicenseService.getHwid(),
      product: config.LICENSE_PRODUCT,
      device_name: os.hostname(),
      app_version: config.APP_VERSION,
      tools,
      force_reconnect: this.forceReconnect,
    });
    this.forceReconnect = false;
    setSetting(TOKEN_SETTING, data.device_token);
    setSetting(DEVICE_ID_SETTING, data.device_id);
    await this.request('heartbeat', {
      device_name: os.hostname(),
      app_version: config.APP_VERSION,
      tools,
    }, data.device_token);
    return data.device_token;
  }

  async ensureConnection() {
    let token = this.token();
    if (!token) token = await this.register();
    try {
      await this.request('heartbeat', {
        device_name: os.hostname(),
        app_version: config.APP_VERSION,
      }, token);
    } catch (error) {
      if (error.status !== 401) throw error;
      setSetting(TOKEN_SETTING, '');
      setSetting(DEVICE_ID_SETTING, '');
      token = await this.register();
    }
    this.connected = true;
    this.lastSeenAt = new Date().toISOString();
    this.lastError = '';
    this.backoffMs = 1500;
    return token;
  }

  async flushCompletion(token) {
    if (!this.pendingCompletion) return;
    if (!String(this.pendingCompletion.command_id || '').trim()) {
      this.pendingCompletion = null;
      return;
    }
    await this.request('complete', this.pendingCompletion, token);
    this.pendingCompletion = null;
  }

  async execute(command, token) {
    this.processing = true;
    this.currentCommand = {
      command_id: command.command_id,
      tool_name: command.tool_name,
      started_at: new Date().toISOString(),
    };
    let completion;
    try {
      const result = await callTool(command.tool_name, command.arguments || {});
      completion = {
        command_id: command.command_id,
        status: 'success',
        result,
      };
    } catch (error) {
      completion = {
        command_id: command.command_id,
        status: 'error',
        error_code: error.code || 'DESKTOP_COMMAND_FAILED',
        error_message: error.message || String(error),
      };
    }
    this.pendingCompletion = completion;
    try {
      await this.flushCompletion(token);
    } finally {
      this.processing = false;
      this.currentCommand = null;
    }
  }

  async tick() {
    if (!this.running) return;
    if (!this.enabled()) {
      this.connected = false;
      this.schedule(5000);
      return;
    }
    const license = LicenseService.getState();
    if (!license.valid) {
      this.connected = false;
      this.lastError = license.reason || 'License chua san sang';
      this.schedule(15_000);
      return;
    }

    try {
      const token = await this.ensureConnection();
      await this.flushCompletion(token);
      const command = normalizeCloudCommand(await this.request('poll', {}, token));
      this.lastSeenAt = new Date().toISOString();
      if (command) {
        await this.execute(command, token);
        this.schedule(50);
      } else {
        this.schedule(1200);
      }
    } catch (error) {
      this.connected = false;
      this.lastError = `${error.code ? `${error.code}: ` : ''}${error.message}`;
      if (error.status === 401) {
        setSetting(TOKEN_SETTING, '');
        setSetting(DEVICE_ID_SETTING, '');
      }
      const delay = this.backoffMs;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
      this.schedule(delay);
    }
  }

  async connectNow() {
    setSetting(ENABLED_SETTING, '1');
    setSetting(TOKEN_SETTING, '');
    setSetting(DEVICE_ID_SETTING, '');
    this.forceReconnect = true;
    this.lastError = '';
    this.pendingCompletion = null;
    this.currentCommand = null;
    this.processing = false;
    if (!this.running) this.start();
    this.schedule(0);
    return this.status();
  }

  async disconnect() {
    const token = this.token();
    if (token) {
      await this.request('disconnect', {}, token).catch(() => null);
    }
    setSetting(ENABLED_SETTING, '0');
    setSetting(TOKEN_SETTING, '');
    setSetting(DEVICE_ID_SETTING, '');
    this.connected = false;
    this.lastError = '';
    this.pendingCompletion = null;
    this.currentCommand = null;
    this.processing = false;
    return this.status();
  }
}

module.exports = new CloudMcpService();
