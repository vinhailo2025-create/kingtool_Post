'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../../config');
const AgentEvents = require('./agent-event.service');

let activeInstall = null;
const SOURCE_APP_VERSION_FILE = '.source-app-version';
const MCP_SERVER_NAME = 'super-post-king-local';
const LEGACY_MCP_SERVER_NAME = 'super-post-king';

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function sourcePluginRoot() {
  const candidates = [
    path.join(config.ROOT_DIR, 'agent-kit', 'plugins', 'super-post-agent-kit'),
    path.join(
      config.ROOT_DIR,
      'packaging',
      'super-post-agent-kit-marketplace',
      'plugins',
      'super-post-agent-kit'
    ),
  ];
  return candidates.find(candidate => (
    fs.existsSync(path.join(candidate, '.codex-plugin', 'plugin.json'))
    && fs.existsSync(path.join(candidate, 'scripts', 'install-cross-agent.ps1'))
  )) || '';
}

function stableRoot() {
  return path.join(localAppData(), 'King Automation AI', 'Super Post Agent Kit');
}

function sourceAppVersionPath(root = stableRoot()) {
  return path.join(root, SOURCE_APP_VERSION_FILE);
}

function readSourceAppVersion(root = stableRoot()) {
  try {
    return fs.readFileSync(sourceAppVersionPath(root), 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function writeSourceAppVersion(root = stableRoot()) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(sourceAppVersionPath(root), `${config.APP_VERSION}\n`, 'utf8');
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; }
}

function manifestAt(root) {
  return readJson(path.join(root, '.codex-plugin', 'plugin.json'));
}

function normalizedPath(value) {
  return String(value || '')
    .replace(/\//g, '\\')
    .replace(/\\\\/g, '\\')
    .toLowerCase();
}

function commandTargetsStableRoot(entry, root) {
  if (!entry || typeof entry !== 'object') return false;
  const values = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  const expected = normalizedPath(root);
  return values.some(value => normalizedPath(value).startsWith(expected));
}

function claudeStatus(root) {
  const desktopPath = path.join(roamingAppData(), 'Claude', 'claude_desktop_config.json');
  const codePath = path.join(os.homedir(), '.claude.json');
  const desktop = readJson(desktopPath);
  const code = readJson(codePath);
  const desktopConfigured = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]
    .some(name => commandTargetsStableRoot(desktop?.mcpServers?.[name], root));
  const codeConfigured = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]
    .some(name => commandTargetsStableRoot(code?.mcpServers?.[name], root));
  return {
    id: 'claude',
    name: 'Claude',
    available: fs.existsSync(path.dirname(desktopPath)) || fs.existsSync(path.join(os.homedir(), '.claude')),
    configured: desktopConfigured || codeConfigured,
    details: {
      desktop: desktopConfigured,
      code: codeConfigured,
    },
  };
}

function codexStatus(root) {
  const codexRoot = path.join(os.homedir(), '.codex');
  const configPath = path.join(codexRoot, 'config.toml');
  let raw = '';
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (_) {}
  const section = raw.match(
    /\[mcp_servers\.(?:super-post-king-local|super-post-king)\]([\s\S]*?)(?=\r?\n\[|$)/
  );
  return {
    id: 'codex',
    name: 'Codex',
    available: fs.existsSync(codexRoot),
    configured: Boolean(section && normalizedPath(section[0]).includes(normalizedPath(root))),
  };
}

function openClawStatus(root) {
  const openClawRoot = path.join(os.homedir(), '.openclaw');
  const value = readJson(path.join(openClawRoot, 'openclaw.json'));
  return {
    id: 'openclaw',
    name: 'OpenClaw',
    available: fs.existsSync(openClawRoot),
    configured: [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]
      .some(name => commandTargetsStableRoot(value?.mcp?.servers?.[name], root)),
  };
}

function status() {
  const sourceRoot = sourcePluginRoot();
  const root = stableRoot();
  const bundled = sourceRoot ? manifestAt(sourceRoot) : null;
  const installed = manifestAt(root);
  const clients = [
    claudeStatus(root),
    codexStatus(root),
    openClawStatus(root),
  ];
  const availableClients = clients.filter(client => client.available);
  const eventStatus = AgentEvents.status();
  const installedVersion = String(installed?.version || '');
  const bundledVersion = String(bundled?.version || '');
  return {
    bundled: Boolean(sourceRoot),
    bundled_version: bundledVersion || null,
    installed: Boolean(installedVersion),
    installed_version: installedVersion || null,
    update_available: Boolean(
      bundledVersion && installedVersion && bundledVersion !== installedVersion
    ),
    needs_repair: !installedVersion || availableClients.some(client => !client.configured),
    clients,
    realtime: eventStatus,
  };
}

function runPowerShell(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Agent',
      'All',
      '-ReplaceExisting',
    ], {
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Cai dat Agent Kit qua thoi gian cho phep.'));
    }, 120000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(new Error(String(stderr || stdout || `PowerShell exited ${code}`).trim()));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function installOrRepair(options = {}) {
  if (activeInstall) return activeInstall;
  activeInstall = (async () => {
    const sourceRoot = sourcePluginRoot();
    if (!sourceRoot) {
      const error = new Error('Ban cai dat khong kem Super Post Agent Kit.');
      error.code = 'AGENT_KIT_NOT_BUNDLED';
      throw error;
    }
    const scriptPath = path.join(sourceRoot, 'scripts', 'install-cross-agent.ps1');
    const runInstaller = options.runInstaller || runPowerShell;
    await runInstaller(scriptPath);
    writeSourceAppVersion();
    return status();
  })();
  try {
    return await activeInstall;
  } finally {
    activeInstall = null;
  }
}

async function syncInstalled(options = {}) {
  const current = status();
  if (!current.installed) {
    return { ...current, synced: false, sync_reason: 'not-installed' };
  }
  if (!current.bundled) {
    return { ...current, synced: false, sync_reason: 'not-bundled' };
  }

  const sourceAppVersion = readSourceAppVersion();
  if (sourceAppVersion === String(config.APP_VERSION) && !current.update_available) {
    return { ...current, synced: false, sync_reason: 'current' };
  }

  const updated = await installOrRepair(options);
  return {
    ...updated,
    synced: true,
    sync_reason: current.update_available ? 'agent-kit-update' : 'app-update',
  };
}

module.exports = {
  status,
  installOrRepair,
  syncInstalled,
  _private: {
    sourcePluginRoot,
    stableRoot,
    sourceAppVersionPath,
    readSourceAppVersion,
    writeSourceAppVersion,
    commandTargetsStableRoot,
    normalizedPath,
    claudeStatus,
    codexStatus,
    openClawStatus,
  },
};
