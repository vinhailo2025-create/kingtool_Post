/**
 * Browser Service - Chrome Profile Management
 * Manages Chrome profiles with proxy support via puppeteer-core
 */

const db = require('../database/init');
const config = require('../../config');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const BrowserProviderService = require('./browser-provider.service');
const BrowserWindowNameService = require('./browser-window-name.service');
const { normalizePlatform } = require('../platforms/platform.utils');

// Active browser instances: id -> { browser, page }
const activeBrowsers = new Map();
// Automation owners currently using a physical Chrome profile.
const automationLeases = new Map();
// Reserve a tile before an asynchronous provider launch completes. Without
// this, concurrent launches all see the same activeBrowsers.size and overlap.
const windowSlots = new Map();
let cachedHostWorkArea = null;

function waitMs(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function hostWorkArea() {
  if (cachedHostWorkArea) return cachedHostWorkArea;
  if (process.platform === 'win32') {
    try {
      const command = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$r=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea;',
        'Write-Output "$($r.X),$($r.Y),$($r.Width),$($r.Height)"',
      ].join(' ');
      const output = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', command,
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      const values = output.match(/-?\d+/g)?.slice(-4).map(Number);
      if (values?.length === 4 && values[2] >= 640 && values[3] >= 360) {
        cachedHostWorkArea = {
          left: values[0], top: values[1], width: values[2], height: values[3],
        };
        return cachedHostWorkArea;
      }
    } catch (_) {}
  }
  cachedHostWorkArea = { left: 0, top: 0, width: 1920, height: 1040 };
  return cachedHostWorkArea;
}

function profilePath(row) {
  return row.external_user_data_dir || path.join(config.CHROME_PROFILES_DIR, row.profile_dir);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function withoutWindowOverrides(args) {
  return (args || []).filter(value => !/^(?:--window-size=|--window-position=|--start-maximized$|--start-fullscreen$|--kiosk$)/i
    .test(String(value || '').trim()));
}

function safeProfileDir(provider, providerProfileId) {
  const key = String(providerProfileId || Date.now()).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 100);
  return `external-${provider}-${key}`;
}

const BrowserService = {
  /**
   * Get all browser profiles
   */
  getAll(platform = 'facebook') {
    platform = normalizePlatform(platform);
    const rows = db.prepare(`
      SELECT b.*, bp.session_valid AS platform_session_valid,
             bp.last_session_check AS platform_last_session_check
      FROM browsers b
      INNER JOIN browser_platforms bp ON bp.browser_id = b.id
      WHERE bp.platform = ? AND bp.enabled = 1
      ORDER BY b.id DESC
    `).all(platform);
    // Attach live status from activeBrowsers map
    return rows.map(row => ({
      ...row,
      session_valid: row.platform_session_valid,
      last_session_check: row.platform_last_session_check,
      platform,
      profile_path: profilePath(row),
      provider: BrowserProviderService.normalizeProvider(row.provider),
      status: activeBrowsers.has(row.id) ? 'open' : 'closed',
    }));
  },

  /**
   * Get a single profile by ID
   */
  getById(id, platform = null) {
    const normalized = platform ? normalizePlatform(platform) : null;
    const row = normalized
      ? db.prepare(`
          SELECT b.*, bp.session_valid AS platform_session_valid,
                 bp.last_session_check AS platform_last_session_check
          FROM browsers b
          INNER JOIN browser_platforms bp ON bp.browser_id = b.id
          WHERE b.id = ? AND bp.platform = ? AND bp.enabled = 1
        `).get(id, normalized)
      : db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      ...(normalized ? {
        session_valid: row.platform_session_valid,
        last_session_check: row.platform_last_session_check,
        platform: normalized,
      } : {}),
      profile_path: profilePath(row),
      provider: BrowserProviderService.normalizeProvider(row.provider),
      status: activeBrowsers.has(row.id) ? 'open' : 'closed',
    };
  },

  /**
   * Create a new browser profile
   */
  create({ name, proxy_type = 'none', proxy_host, proxy_port, proxy_user, proxy_pass, note }, platform = 'facebook') {
    platform = normalizePlatform(platform);
    if (!name || !name.trim()) {
      throw new Error('Tên profile không được để trống');
    }

    // Generate unique profile directory slug
    const slug = name.trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      || 'profile';
    const timestamp = Date.now();
    const profile_dir = `${slug}-${timestamp}`;

    // Create the chrome profile directory
    const profilePath = path.join(config.CHROME_PROFILES_DIR, profile_dir);
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    const stmt = db.prepare(`
      INSERT INTO browsers (name, profile_dir, proxy_type, proxy_host, proxy_port, proxy_user, proxy_pass, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      name.trim(),
      profile_dir,
      proxy_type || 'none',
      proxy_host || null,
      proxy_port ? parseInt(proxy_port) : null,
      proxy_user || null,
      proxy_pass || null,
      note || null
    );

    db.prepare(`
      INSERT OR IGNORE INTO browser_platforms (browser_id, platform)
      VALUES (?, ?)
    `).run(result.lastInsertRowid, platform);

    return this.getById(result.lastInsertRowid, platform);
  },

  /** Import or refresh profiles discovered from an external provider. */
  importProfiles(items, platforms = ['facebook']) {
    const targetPlatforms = [...new Set((platforms || []).map(platform => normalizePlatform(platform)))];
    if (!targetPlatforms.length) targetPlatforms.push('facebook');
    const find = db.prepare('SELECT * FROM browsers WHERE provider = ? AND provider_profile_id = ?');
    const insert = db.prepare(`
      INSERT INTO browsers (
        name, profile_dir, proxy_type, note, provider, provider_profile_id,
        connection_mode, external_user_data_dir, external_executable_path,
        external_launch_args, external_extension_path, provider_endpoint, provider_metadata
      ) VALUES (?, ?, 'none', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = db.prepare(`
      UPDATE browsers SET name = ?, note = ?, connection_mode = ?,
        external_user_data_dir = ?, external_executable_path = ?,
        external_launch_args = ?, external_extension_path = ?,
        provider_endpoint = ?, provider_metadata = ?
      WHERE id = ?
    `);
    const link = db.prepare('INSERT OR IGNORE INTO browser_platforms (browser_id, platform) VALUES (?, ?)');
    let created = 0;
    let updated = 0;
    let linked = 0;
    const ids = [];

    db.transaction(() => {
      for (const raw of items || []) {
        const provider = BrowserProviderService.normalizeProvider(raw.provider);
        if (provider === 'chrome') continue;
        const providerId = String(raw.provider_profile_id || '').trim();
        if (!providerId) continue;
        const existing = find.get(provider, providerId);
        const serializedArgs = JSON.stringify(Array.isArray(raw.launch_args) ? raw.launch_args : parseJsonArray(raw.launch_args));
        let metadata = raw.metadata || {};
        if (provider === 'gpm' && existing) {
          const oldMetadata = parseJsonObject(existing.provider_metadata);
          if (oldMetadata.independent_launch && !metadata.independent_launch) {
            metadata = { ...metadata, independent_launch: oldMetadata.independent_launch };
          }
        }
        const serializedMetadata = JSON.stringify(metadata);
        const values = [
          String(raw.name || `${provider} · ${providerId}`).trim(),
          raw.note || `Profile từ ${BrowserProviderService.PROVIDERS[provider].label}`,
          raw.connection_mode || BrowserProviderService.PROVIDERS[provider].mode,
          raw.user_data_dir || '', raw.executable_path || '', serializedArgs,
          raw.extension_path || '', raw.endpoint || '', serializedMetadata,
        ];
        let id;
        if (existing) {
          update.run(...values, existing.id);
          id = Number(existing.id);
          updated++;
        } else {
          const result = insert.run(
            values[0], safeProfileDir(provider, providerId), values[1], provider, providerId,
            ...values.slice(2)
          );
          id = Number(result.lastInsertRowid);
          created++;
        }
        ids.push(id);
        for (const platform of targetPlatforms) linked += link.run(id, platform).changes;
      }
    })();

    return { created, updated, linked, ids, platforms: targetPlatforms };
  },

  /** Refresh display names from each provider's authoritative metadata. */
  async refreshProviderNames(provider = null) {
    let providers = provider
      ? [BrowserProviderService.normalizeProvider(provider)]
      : db.prepare("SELECT DISTINCT provider FROM browsers WHERE provider IS NOT NULL AND provider <> 'chrome'")
          .all().map(row => BrowserProviderService.normalizeProvider(row.provider));
    providers = [...new Set(providers.filter(item => item !== 'chrome'))];
    const update = db.prepare('UPDATE browsers SET name = ? WHERE provider = ? AND provider_profile_id = ? AND name <> ?');
    let changed = 0;
    let matched = 0;
    let unmatched = 0;
    const errors = [];

    const results = await Promise.allSettled(providers.map(async providerId => ({
      provider: providerId,
      profiles: await BrowserProviderService.discover(providerId, {}),
    })));
    db.transaction(() => {
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result.status === 'rejected') {
          errors.push({ provider: providers[index], message: result.reason?.message || 'Không đọc được tên profile' });
          continue;
        }
        const discoveredIds = new Set(result.value.profiles.map(item => String(item.provider_profile_id)));
        const importedRows = db.prepare('SELECT provider_profile_id FROM browsers WHERE provider = ?')
          .all(result.value.provider);
        unmatched += importedRows.filter(row => !discoveredIds.has(String(row.provider_profile_id))).length;
        for (const item of result.value.profiles) {
          const name = String(item.name || '').trim();
          if (!name) continue;
          const existing = db.prepare('SELECT id FROM browsers WHERE provider = ? AND provider_profile_id = ?')
            .get(result.value.provider, String(item.provider_profile_id));
          if (!existing) continue;
          matched++;
          changed += update.run(name, result.value.provider, String(item.provider_profile_id), name).changes;
        }
      }
    })();
    return { changed, matched, unmatched, providers, errors };
  },

  /**
   * Update an existing browser profile
   */
  update(id, data) {
    const existing = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!existing) {
      throw new Error('Profile không tồn tại');
    }

    const fields = [];
    const values = [];

    const allowedFields = [
      'name', 'proxy_type', 'proxy_host', 'proxy_port', 'proxy_user', 'proxy_pass', 'note',
      'external_user_data_dir', 'external_executable_path', 'external_launch_args',
      'external_extension_path', 'provider_endpoint', 'connection_mode',
    ];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        if (field === 'proxy_port') {
          values.push(data[field] ? parseInt(data[field]) : null);
        } else {
          values.push(data[field] || null);
        }
      }
    }

    if (fields.length === 0) {
      return this.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE browsers SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    return this.getById(id);
  },

  /**
   * Link existing physical profiles to another platform.
   */
  syncProfiles(profileIds, targetPlatform) {
    const platform = normalizePlatform(targetPlatform);
    const ids = [...new Set((profileIds || []).map(Number).filter(Number.isInteger))];
    const exists = db.prepare('SELECT id FROM browsers WHERE id = ?');
    const link = db.prepare(`
      INSERT OR IGNORE INTO browser_platforms (browser_id, platform)
      VALUES (?, ?)
    `);
    let linked = 0;

    db.transaction(() => {
      for (const id of ids) {
        if (!exists.get(id)) continue;
        linked += link.run(id, platform).changes;
      }
    })();

    return { linked, platform, profiles: this.getAll(platform) };
  },

  /**
   * Remove only the platform link. Delete the physical profile when no link remains.
   */
  async unlinkPlatform(id, platform = 'facebook') {
    platform = normalizePlatform(platform);
    if (!this.getById(id, platform)) {
      throw new Error('Profile không tồn tại trong nền tảng này');
    }

    const count = db.prepare(
      'SELECT COUNT(*) AS count FROM browser_platforms WHERE browser_id = ? AND enabled = 1'
    ).get(id).count;

    if (count > 1) {
      db.prepare('DELETE FROM browser_platforms WHERE browser_id = ? AND platform = ?').run(id, platform);
      return { deletedPhysicalProfile: false };
    }

    await this.delete(id);
    return { deletedPhysicalProfile: true };
  },

  /**
   * Delete a browser profile (DB + directory)
   */
  async delete(id) {
    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!profile) {
      throw new Error('Profile không tồn tại');
    }

    // Close browser if open
    if (activeBrowsers.has(id)) {
      await this.close(id);
    }

    // External profiles belong to their provider. Only native Chrome data is
    // removed when the last platform link is deleted.
    if (BrowserProviderService.normalizeProvider(profile.provider) === 'chrome') {
      const localProfilePath = path.join(config.CHROME_PROFILES_DIR, profile.profile_dir);
      if (fs.existsSync(localProfilePath)) {
        fs.rmSync(localProfilePath, { recursive: true, force: true });
      }
    }

    db.prepare('DELETE FROM browser_platforms WHERE browser_id = ?').run(id);
    db.prepare('DELETE FROM browsers WHERE id = ?').run(id);
    automationLeases.delete(id);
    return true;
  },

  /**
   * Launch Chrome with the given profile
   */
  async launch(id) {
    if (activeBrowsers.has(id)) {
      return { success: true, reused: true, message: 'Trình duyệt đang mở' };
    }

    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!profile) {
      throw new Error('Profile không tồn tại');
    }

    const provider = BrowserProviderService.normalizeProvider(profile.provider);
    const displayNameSync = BrowserProviderService.syncBrowserDisplayName(profile);
    const windowLayout = this._getWindowLayout(id);
    const windowArgs = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-size=${windowLayout.width},${windowLayout.height}`,
      `--window-position=${windowLayout.left},${windowLayout.top}`,
    ];
    let proxyServer = null;
    let browser;
    let providerOwned = false;
    let startedByTool = false;
    let processId = null;
    let independent = false;
    let searchNameSync = null;

    if (BrowserProviderService.usesProviderApi(profile)) {
      const session = await BrowserProviderService.start(profile, windowLayout);
      if (!session?.endpoint) throw new Error('Nhà cung cấp không trả về địa chỉ CDP');
      const connectOptions = /^wss?:\/\//i.test(session.endpoint)
        ? { browserWSEndpoint: session.endpoint }
        : { browserURL: session.endpoint };
      browser = await puppeteer.connect({ ...connectOptions, defaultViewport: null, ignoreHTTPSErrors: true });
      providerOwned = !!session.providerOwned;
      startedByTool = !!session.startedByTool;
      processId = Number(session.processId) || null;
      independent = !!session.independent;
    } else {
      const chromePath = provider === 'chrome' ? await this.findChromePath() : profile.external_executable_path;
      if (!chromePath || !fs.existsSync(chromePath)) {
        throw new Error(`Không tìm thấy file chạy ${BrowserProviderService.PROVIDERS[provider].label}. Hãy nhập lại profile.`);
      }
      const userDataDir = profilePath(profile);
      if (!userDataDir || !fs.existsSync(userDataDir)) {
        throw new Error('Không tìm thấy thư mục dữ liệu gốc của profile');
      }
      // Show the profile name (not the "Orbita"/"GemLogin" brand) in the search box.
      if (provider === 'gologin' || provider === 'gemlogin') {
        searchNameSync = await BrowserProviderService.syncSearchEngineName(userDataDir, profile.name);
      }
      // Provider profiles sometimes persist maximized/fullscreen flags. Remove
      // only window geometry flags, then apply our real outer-window tile.
      // Orbita treats startup window geometry as the monitor's maximum bounds.
      // That makes its maximize button expand only to the tile. Let GoLogin
      // initialize against the real monitor and tile it natively after startup.
      const startupWindowArgs = provider === 'gologin' ? [] : windowArgs;
      let args = [...withoutWindowOverrides(parseJsonArray(profile.external_launch_args)), ...startupWindowArgs];
      if (provider === 'gologin') {
        // Orbita otherwise inherits Windows DPI (1.5 on this machine), making
        // the page and browser chrome 150% larger than the allocated tile.
        // GemLogin already ships this override; apply the same neutral scale
        // to GoLogin so the whole resizable browser fits its layout cell.
        args = args.filter(value => !/^--force-device-scale-factor=/i.test(String(value || '')));
        args.push('--force-device-scale-factor=1');
      }
      // With ignoreDefaultArgs=true Puppeteer does not apply its userDataDir
      // option and silently creates a temporary blank profile. Put the
      // provider-owned directory on Chromium's command line explicitly.
      if (provider !== 'chrome') {
        args = BrowserProviderService.ensureUserDataDirArg(args, userDataDir);
      }

      // Anti-detect profiles keep their provider proxy/fingerprint settings.
      if (provider === 'chrome' && profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host && profile.proxy_port) {
        if (profile.proxy_user && profile.proxy_pass) {
          const proxyChain = require('proxy-chain');
          const proxyProtocol = profile.proxy_type === 'socks5' ? 'socks5' : 'http';
          const oldProxyUrl = `${proxyProtocol}://${profile.proxy_user}:${profile.proxy_pass}@${profile.proxy_host}:${profile.proxy_port}`;
          proxyServer = await proxyChain.anonymizeProxy(oldProxyUrl);
          args.push(`--proxy-server=${proxyServer}`);
        } else {
          const proxyAddr = `${profile.proxy_host}:${profile.proxy_port}`;
          args.push(profile.proxy_type === 'socks5' ? `--proxy-server=socks5://${proxyAddr}` : `--proxy-server=${proxyAddr}`);
        }
      }

      browser = await puppeteer.launch({
        executablePath: chromePath,
        userDataDir,
        headless: false,
        defaultViewport: null,
        args,
        // Provider Chromium must keep its own fingerprint/extension flags.
        // Native Chrome retains the established Super Post - King defaults.
        ignoreDefaultArgs: provider === 'chrome' ? ['--enable-automation'] : true,
      });
      processId = Number(browser.process()?.pid) || null;
    }

    // Get or create the main page
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    const workArea = this._getHostWorkArea();
    const fittedLayout = this._getWindowLayout(id, workArea);
    if (provider !== 'gologin') await this._applyWindowBounds(page, fittedLayout);
    const windowName = await BrowserWindowNameService.bind(browser, profile.name);

    // Store the active browser instance
    activeBrowsers.set(id, {
      browser, page, proxyServer, provider, providerOwned, startedByTool, processId, independent,
    });

    // Provider browsers may restore their previous bounds just after startup.
    // Apply the layout again after those restore hooks settle so a manual Open
    // uses exactly the same geometry as an automation launch.
    await waitMs(provider === 'gologin' ? 800 : 250);
    await this.refitWindow(id);

    // Update DB status
    db.prepare("UPDATE browsers SET status = 'open' WHERE id = ?").run(id);

    // Listen for browser disconnect
    browser.on('disconnected', () => {
      this._handleDisconnect(id);
    });

    return {
      success: true,
      message: 'Đã mở trình duyệt',
      displayNameSync,
      searchNameSync,
      windowName,
      independent,
    };
  },

  /**
   * Handle browser disconnection (user closed Chrome or crash)
   */
  _handleDisconnect(id) {
    const instance = activeBrowsers.get(id);
    if (instance && instance.proxyServer) {
      const proxyChain = require('proxy-chain');
      proxyChain.closeAnonymizedProxy(instance.proxyServer, true).catch(() => {});
    }
    activeBrowsers.delete(id);
    automationLeases.delete(id);
    windowSlots.delete(id);
    try {
      db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);
    } catch (e) {
      // DB might be closed during shutdown
    }
  },

  /**
   * Close a Chrome browser instance
   */
  async close(id) {
    const instance = activeBrowsers.get(id);
    if (!instance) {
      // Not tracked as active, just update DB
      db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);
      return { success: true, message: 'Trình duyệt đã đóng' };
    }

    try {
      // Close proxy-chain anonymized proxy if exists
      if (instance.proxyServer) {
        const proxyChain = require('proxy-chain');
        await proxyChain.closeAnonymizedProxy(instance.proxyServer, true).catch(() => {});
      }
      // Attached provider sessions are disconnected, not force-closed. When
      // Super Post - King started one through GPM/GenLogin, ask that provider to
      // stop it after releasing the CDP connection.
      activeBrowsers.delete(id);
      if (instance.providerOwned) {
        instance.browser.disconnect();
        if (instance.startedByTool) {
          const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
          if (profile) await BrowserProviderService.stop(profile).catch(() => {});
        }
      } else {
        await instance.browser.close();
      }
    } catch (e) {
      // Browser may already be closed
    }

    activeBrowsers.delete(id);
    automationLeases.delete(id);
    windowSlots.delete(id);
    db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);

    return { success: true, message: 'Đã đóng trình duyệt' };
  },

  /**
   * Get status of a browser: isOpen and sessionValid
   */
  async getStatus(id, platform = 'facebook') {
    platform = normalizePlatform(platform);
    const profile = this.getById(id, platform);
    if (!profile) {
      throw new Error('Profile không tồn tại');
    }

    const isOpen = activeBrowsers.has(id);
    let sessionValid = false;

    if (isOpen) {
      try {
        const instance = activeBrowsers.get(id);
        const pages = await instance.browser.pages();
        const page = pages[0] || instance.page;

        const sessionConfig = {
          facebook: {
            urls: ['https://www.facebook.com'],
            names: new Set(['c_user']),
          },
          tiktok: {
            urls: ['https://www.tiktok.com'],
            names: new Set(['sessionid', 'sessionid_ss', 'sid_tt']),
          },
          youtube: {
            urls: ['https://www.youtube.com', 'https://studio.youtube.com', 'https://accounts.google.com'],
            names: new Set(['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID', 'SID', '__Secure-1PSID', '__Secure-3PSID']),
          },
          threads: {
            urls: ['https://www.threads.com', 'https://www.instagram.com'],
            names: new Set(['sessionid', 'ds_user_id']),
          },
          instagram: {
            urls: ['https://www.instagram.com'],
            names: new Set(['sessionid', 'ds_user_id']),
          },
          x: {
            urls: ['https://x.com', 'https://twitter.com'],
            names: new Set(['auth_token', 'twid', 'ct0']),
          },
        }[platform];
        const cookies = await page.cookies(...sessionConfig.urls);
        const sessionNames = sessionConfig.names;
        sessionValid = cookies.some(cookie => sessionNames.has(cookie.name));
      } catch (e) {
        sessionValid = false;
      }

      db.prepare(`
        UPDATE browser_platforms
        SET session_valid = ?, last_session_check = CURRENT_TIMESTAMP
        WHERE browser_id = ? AND platform = ?
      `).run(sessionValid ? 1 : 0, id, platform);
    } else {
      sessionValid = !!profile.session_valid;
    }

    return {
      isOpen,
      sessionValid,
      status: isOpen ? 'open' : 'closed',
    };
  },

  /**
   * Keep a shared browser open while one or more automation workers use it.
   */
  async acquire(id) {
    const count = automationLeases.get(id) || 0;
    automationLeases.set(id, count + 1);
    try {
      await this.launch(id);
      return this.getInstance(id);
    } catch (error) {
      if (count === 0) automationLeases.delete(id);
      else automationLeases.set(id, count);
      throw error;
    }
  },

  async release(id) {
    const count = automationLeases.get(id) || 0;
    if (count <= 1) {
      automationLeases.delete(id);
      await this.close(id);
      return 0;
    }
    automationLeases.set(id, count - 1);
    return count - 1;
  },

  getLeaseCount(id) {
    return automationLeases.get(id) || 0;
  },

  /**
   * Get list of currently active (open) browser IDs
   */
  getActiveBrowsers() {
    return Array.from(activeBrowsers.keys());
  },

  /**
   * Get a browser instance for the runner to use
   */
  getInstance(id) {
    return activeBrowsers.get(id) || null;
  },

  async refitWindow(id) {
    const instance = activeBrowsers.get(Number(id));
    if (!instance) return null;
    const workArea = this._getHostWorkArea();
    const layout = this._getWindowLayout(Number(id), workArea);
    if (instance.provider === 'gologin' && instance.processId) {
      this._applyNativeWindowBounds(instance.processId, layout);
    } else {
      const pages = await instance.browser.pages().catch(() => []);
      const page = pages[0] || instance.page;
      if (page) await this._applyWindowBounds(page, layout);
    }
    return layout;
  },

  /**
   * Restore and tile a native Chromium window without changing its monitor
   * maximize bounds. GoLogin/Orbita locks those bounds when CDP geometry or
   * startup --window-size is used, so Windows APIs are required here.
   */
  _applyNativeWindowBounds(processId, layout) {
    if (process.platform !== 'win32' || !Number.isInteger(Number(processId))) return false;
    const values = ['left', 'top', 'width', 'height'].map(key => Math.trunc(Number(layout[key])));
    if (!values.every(Number.isFinite) || values[2] < 100 || values[3] < 100) return false;
    const [left, top, width, height] = values;
    const nativeType = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class CovergemNativeWindow {',
      '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow);',
      '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd,IntPtr after,int x,int y,int w,int h,uint flags);',
      '}',
    ].join(' ');
    const script = [
      `Add-Type -TypeDefinition '${nativeType}';`,
      `$p=Get-Process -Id ${Number(processId)} -ErrorAction Stop;`,
      '$h=$p.MainWindowHandle;',
      'for($i=0;$i -lt 20 -and $h -eq 0;$i++){Start-Sleep -Milliseconds 100;$p.Refresh();$h=$p.MainWindowHandle}',
      'if($h -eq 0){exit 2};',
      '[CovergemNativeWindow]::ShowWindowAsync($h,9)|Out-Null;',
      'Start-Sleep -Milliseconds 50;',
      `[CovergemNativeWindow]::SetWindowPos($h,[IntPtr]::Zero,${left},${top},${width},${height},0x0040)|Out-Null;`,
    ].join(' ');
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5000,
      });
      return true;
    } catch (_) {
      return false;
    }
  },

  _getWindowLayout(id = null, workArea = null) {
    const rowsSetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_layout_rows'").get();
    const columnsSetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_layout_columns'").get();
    const ratioSetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_window_ratio'").get();
    const legacySetting = db.prepare("SELECT value FROM settings WHERE key = 'browser_per_screen'").get();
    const legacyCount = Math.min(Math.max(parseInt(legacySetting?.value || '1', 10) || 1, 1), 12);
    const defaultColumns = legacyCount === 1 ? 1 : Math.min(legacyCount, 4);
    const defaultRows = legacyCount === 1 ? 1 : Math.max(2, Math.ceil(legacyCount / defaultColumns));
    const rows = Math.min(Math.max(parseInt(rowsSetting?.value || defaultRows, 10) || defaultRows, 1), 4);
    const cols = Math.min(Math.max(parseInt(columnsSetting?.value || defaultColumns, 10) || defaultColumns, 1), 6);
    const ratio = Math.min(Math.max(Number(ratioSetting?.value || '1') || 1, 0.25), 1);
    const perScreen = rows * cols;
    workArea = workArea || hostWorkArea();
    const screenLeft = Number(workArea.left) || 0;
    const screenTop = Number(workArea.top) || 0;
    const screenWidth = Math.max(640, Number(workArea.width) || 1920);
    const screenHeight = Math.max(360, Number(workArea.height) || 1040);
    let index = id != null ? windowSlots.get(id) : null;
    if (index == null) {
      const used = new Set(windowSlots.values());
      index = Array.from({ length: perScreen }, (_, value) => value).find(value => !used.has(value));
      if (index == null) index = windowSlots.size % perScreen;
      if (id != null) windowSlots.set(id, index);
    }
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cellWidth = Math.floor(screenWidth / cols);
    const cellHeight = Math.floor(screenHeight / rows);
    const width = Math.min(cellWidth, Math.max(240, Math.floor(cellWidth * ratio)));
    const height = Math.min(cellHeight, Math.max(180, Math.floor(cellHeight * ratio)));
    return {
      width,
      height,
      left: screenLeft + col * cellWidth + Math.floor((cellWidth - width) / 2),
      top: screenTop + row * cellHeight + Math.floor((cellHeight - height) / 2),
    };
  },

  async _getPageWorkArea(page) {
    return page.evaluate(() => ({
      left: Number(screen.availLeft) || 0,
      top: Number(screen.availTop) || 0,
      width: Number(screen.availWidth) || Number(screen.width) || 1920,
      height: Number(screen.availHeight) || Number(screen.height) || 1040,
    })).catch(() => ({ left: 0, top: 0, width: 1920, height: 1040 }));
  },

  _getHostWorkArea() {
    return { ...hostWorkArea() };
  },

  /**
   * Resize/move the native browser window using real outer-window bounds.
   */
  async _applyWindowBounds(page, layout) {
    try {
      const session = page.createCDPSession
        ? await page.createCDPSession()
        : await page.target().createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' },
      }).catch(() => {});
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: layout.left,
          top: layout.top,
          width: layout.width,
          height: layout.height,
        },
      });
      await session.detach().catch(() => {});
      return true;
    } catch (_) {
      return page.evaluate(bounds => {
        window.moveTo(bounds.left, bounds.top);
        window.resizeTo(bounds.width, bounds.height);
        return outerWidth > 0 && outerHeight > 0;
      }, layout).catch(() => false);
    }
  },

  /**
   * Find Chrome executable path
   */
  async findChromePath() {
    // First check the settings table
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'chrome_path'").get();
    if (setting && setting.value && setting.value.trim()) {
      const customPath = setting.value.trim();
      if (fs.existsSync(customPath)) {
        return customPath;
      }
    }

    // Auto-detect from common Windows paths
    for (const chromePath of config.CHROME_PATHS) {
      if (chromePath && fs.existsSync(chromePath)) {
        return chromePath;
      }
    }

    return null;
  },
};

module.exports = BrowserService;
