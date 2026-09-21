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
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function roamingAppData() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function sourcePluginRoot() {
  const marketplaceRel = [
    'packaging',
    'super-post-agent-kit-marketplace',
    'plugins',
    'super-post-agent-kit',
  ];
  const candidates = [
    path.join(config.ROOT_DIR, 'agent-kit', 'plugins', 'super-post-agent-kit'),
    path.join(config.ROOT_DIR, ...marketplaceRel),
    // Trong app .app trên macOS, dữ liệu Agent Kit nằm ở Contents/Resources
    // (không để trong Contents/MacOS vì codesign hiểu nhầm .codex-plugin là bundle).
    path.join(config.ROOT_DIR, '..', 'Resources', ...marketplaceRel),
  ];
  return candidates.find(candidate => (
    fs.existsSync(path.join(candidate, '.codex-plugin', 'plugin.json'))
    && (
      fs.existsSync(path.join(candidate, 'scripts', 'install-cross-agent.ps1'))
      || fs.existsSync(path.join(candidate, 'scripts', 'start-mcp.sh'))
    )
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
  const str = String(value || '');
  if (process.platform === 'win32') {
    return str
      .replace(/\//g, '\\')
      .replace(/\\\\/g, '\\')
      .toLowerCase();
  }
  // POSIX (macOS/Linux): keep forward slashes, collapse duplicates, lowercase
  // so config comparisons stay consistent with how the mac installer writes paths.
  return str
    .replace(/\\/g, '/')
    .replace(/\/\//g, '/')
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

const MAC_SKILL_NAMES = ['post-face-super-post', 'super-post-profile-mapper'];

function installStamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(srcPath);
      try { fs.unlinkSync(destPath); } catch (_) {}
      fs.symlinkSync(link, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function writeJsonConfigMac(filePath, value, stamp) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, `${filePath}.backup-${stamp}`); } catch (_) {}
  }
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function linkSkillsMac(destRoot, pluginRoot, stamp) {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const skillName of MAC_SKILL_NAMES) {
    const source = path.join(pluginRoot, 'skills', skillName);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(destRoot, skillName);
    let existing = null;
    try { existing = fs.lstatSync(destination); } catch (_) {}
    if (existing) {
      if (existing.isSymbolicLink()) {
        let target = '';
        try { target = fs.readlinkSync(destination); } catch (_) {}
        if (path.resolve(destRoot, target) === path.resolve(source)) continue;
        try { fs.unlinkSync(destination); } catch (_) {}
      } else {
        fs.renameSync(destination, `${destination}.backup-${stamp}`);
      }
    }
    fs.symlinkSync(source, destination, 'dir');
  }
}

function installCodexMac(scriptPath, stamp) {
  const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexConfigPath), { recursive: true });
  let raw = '';
  if (fs.existsSync(codexConfigPath)) {
    try { fs.copyFileSync(codexConfigPath, `${codexConfigPath}.backup-${stamp}`); } catch (_) {}
    raw = fs.readFileSync(codexConfigPath, 'utf8');
  }
  const header = /^\[mcp_servers\.(?:super-post-king-local|super-post-king)(?:\.[^\]]+)?\]\s*$/;
  const kept = [];
  let skipping = false;
  for (const line of raw.split(/\r?\n/)) {
    if (header.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (/^\[/.test(line)) { skipping = false; } else { continue; }
    }
    kept.push(line);
  }
  const body = kept.join('\n').replace(/\s+$/, '');
  const esc = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const block = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    'command = "bash"',
    `args = ["${esc(scriptPath)}"]`,
    'startup_timeout_sec = 120',
    '',
  ].join('\n');
  fs.writeFileSync(codexConfigPath, body ? `${body}\n\n${block}` : block, 'utf8');
}

function performMacInstall(sourceRoot) {
  const stamp = installStamp();
  const pluginRoot = stableRoot();
  if (path.resolve(sourceRoot).toLowerCase() !== path.resolve(pluginRoot).toLowerCase()) {
    copyDirSync(sourceRoot, pluginRoot);
  }

  const scriptPath = path.join(pluginRoot, 'scripts', 'start-mcp.sh');
  try { fs.chmodSync(scriptPath, 0o755); } catch (_) {}
  const serverArgs = [scriptPath];
  const homedir = os.homedir();

  // Claude Desktop + Claude Code
  linkSkillsMac(path.join(homedir, '.claude', 'skills'), pluginRoot, stamp);
  const desktopConfigPath = path.join(roamingAppData(), 'Claude', 'claude_desktop_config.json');
  const desktopConfig = readJson(desktopConfigPath) || {};
  if (!desktopConfig.mcpServers || typeof desktopConfig.mcpServers !== 'object') {
    desktopConfig.mcpServers = {};
  }
  delete desktopConfig.mcpServers[LEGACY_MCP_SERVER_NAME];
  desktopConfig.mcpServers[MCP_SERVER_NAME] = { command: 'bash', args: serverArgs };
  writeJsonConfigMac(desktopConfigPath, desktopConfig, stamp);

  const codeConfigPath = path.join(homedir, '.claude.json');
  const codeConfig = readJson(codeConfigPath) || {};
  if (!codeConfig.mcpServers || typeof codeConfig.mcpServers !== 'object') {
    codeConfig.mcpServers = {};
  }
  delete codeConfig.mcpServers[LEGACY_MCP_SERVER_NAME];
  codeConfig.mcpServers[MCP_SERVER_NAME] = { type: 'stdio', command: 'bash', args: serverArgs };
  writeJsonConfigMac(codeConfigPath, codeConfig, stamp);

  // Codex
  linkSkillsMac(path.join(homedir, '.codex', 'skills'), pluginRoot, stamp);
  installCodexMac(scriptPath, stamp);

  // OpenClaw
  linkSkillsMac(path.join(homedir, '.openclaw', 'skills'), pluginRoot, stamp);
  const openClawConfigPath = path.join(homedir, '.openclaw', 'openclaw.json');
  const openClawConfig = readJson(openClawConfigPath) || {};
  if (!openClawConfig.mcp || typeof openClawConfig.mcp !== 'object') {
    openClawConfig.mcp = {};
  }
  if (!openClawConfig.mcp.servers || typeof openClawConfig.mcp.servers !== 'object') {
    openClawConfig.mcp.servers = {};
  }
  delete openClawConfig.mcp.servers[LEGACY_MCP_SERVER_NAME];
  openClawConfig.mcp.servers[MCP_SERVER_NAME] = { command: 'bash', args: serverArgs };
  writeJsonConfigMac(openClawConfigPath, openClawConfig, stamp);

  return { stdout: '', stderr: '' };
}

function runMacInstall(sourceRoot) {
  return Promise.resolve().then(() => performMacInstall(sourceRoot));
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
    const isMac = process.platform === 'darwin';
    const scriptPath = path.join(sourceRoot, 'scripts', 'install-cross-agent.ps1');
    const runInstaller = options.runInstaller || (isMac ? runMacInstall : runPowerShell);
    await runInstaller(isMac ? sourceRoot : scriptPath);
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
