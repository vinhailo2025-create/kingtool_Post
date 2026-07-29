/**
 * Browser Service - Chrome Profile Management
 * Manages Chrome profiles with proxy support via puppeteer-core
 */

const db = require('../database/init');
const config = require('../../config');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

// Active browser instances: id -> { browser, page }
const activeBrowsers = new Map();

const BrowserService = {
  /**
   * Get all browser profiles
   */
  getAll() {
    const rows = db.prepare('SELECT * FROM browsers ORDER BY id DESC').all();
    // Attach live status from activeBrowsers map
    return rows.map(row => ({
      ...row,
      profile_path: path.join(config.CHROME_PROFILES_DIR, row.profile_dir),
      status: activeBrowsers.has(row.id) ? 'open' : row.status,
    }));
  },

  /**
   * Get a single profile by ID
   */
  getById(id) {
    const row = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      profile_path: path.join(config.CHROME_PROFILES_DIR, row.profile_dir),
      status: activeBrowsers.has(row.id) ? 'open' : row.status,
    };
  },

  /**
   * Create a new browser profile
   */
  create({ name, proxy_type = 'none', proxy_host, proxy_port, proxy_user, proxy_pass, note }) {
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

    return this.getById(result.lastInsertRowid);
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

    const allowedFields = ['name', 'proxy_type', 'proxy_host', 'proxy_port', 'proxy_user', 'proxy_pass', 'note'];

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

    // Remove chrome profile directory
    const profilePath = path.join(config.CHROME_PROFILES_DIR, profile.profile_dir);
    if (fs.existsSync(profilePath)) {
      fs.rmSync(profilePath, { recursive: true, force: true });
    }

    db.prepare('DELETE FROM browsers WHERE id = ?').run(id);
    return true;
  },

  /**
   * Launch Chrome with the given profile
   */
  async launch(id) {
    if (activeBrowsers.has(id)) {
      throw new Error('Trình duyệt đã được mở');
    }

    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
    if (!profile) {
      throw new Error('Profile không tồn tại');
    }

    // Determine Chrome executable path
    const chromePath = await this.findChromePath();
    if (!chromePath) {
      throw new Error('Không tìm thấy Chrome. Vui lòng cài đặt đường dẫn Chrome trong Cài đặt.');
    }

    const userDataDir = path.join(config.CHROME_PROFILES_DIR, profile.profile_dir);

    // Build launch arguments
    const windowLayout = this._getWindowLayout();
    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-size=${windowLayout.width},${windowLayout.height}`,
      `--window-position=${windowLayout.left},${windowLayout.top}`,
    ];

    let proxyServer = null;

    // Handle proxy configuration
    if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host && profile.proxy_port) {
      if (profile.proxy_user && profile.proxy_pass) {
        // Use proxy-chain for authenticated proxies
        const proxyChain = require('proxy-chain');
        const proxyProtocol = profile.proxy_type === 'socks5' ? 'socks5' : 'http';
        const oldProxyUrl = `${proxyProtocol}://${profile.proxy_user}:${profile.proxy_pass}@${profile.proxy_host}:${profile.proxy_port}`;
        proxyServer = await proxyChain.anonymizeProxy(oldProxyUrl);
        args.push(`--proxy-server=${proxyServer}`);
      } else {
        // Direct proxy without authentication
        const proxyAddr = `${profile.proxy_host}:${profile.proxy_port}`;
        if (profile.proxy_type === 'socks5') {
          args.push(`--proxy-server=socks5://${proxyAddr}`);
        } else {
          args.push(`--proxy-server=${proxyAddr}`);
        }
      }
    }

    // Launch browser
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      userDataDir: userDataDir,
      headless: false,
      defaultViewport: null,
      args: args,
      ignoreDefaultArgs: ['--enable-automation'],
    });

    // Get or create the main page
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Store the active browser instance
    activeBrowsers.set(id, { browser, page, proxyServer });

    // Update DB status
    db.prepare("UPDATE browsers SET status = 'open' WHERE id = ?").run(id);

    // Listen for browser disconnect
    browser.on('disconnected', () => {
      this._handleDisconnect(id);
    });

    return { success: true, message: 'Đã mở trình duyệt' };
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
      await instance.browser.close();
    } catch (e) {
      // Browser may already be closed
    }

    activeBrowsers.delete(id);
    db.prepare("UPDATE browsers SET status = 'closed' WHERE id = ?").run(id);

    return { success: true, message: 'Đã đóng trình duyệt' };
  },

  /**
   * Get status of a browser: isOpen and sessionValid
   */
  async getStatus(id) {
    const profile = db.prepare('SELECT * FROM browsers WHERE id = ?').get(id);
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

        // Check Facebook session by looking for c_user cookie
        const cookies = await page.cookies('https://www.facebook.com');
        const cUserCookie = cookies.find(c => c.name === 'c_user');
        sessionValid = !!cUserCookie;
      } catch (e) {
        sessionValid = false;
      }

      // Update DB
      db.prepare('UPDATE browsers SET session_valid = ? WHERE id = ?').run(sessionValid ? 1 : 0, id);
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

  _getWindowLayout() {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'browser_per_screen'").get();
    const perScreen = Math.min(Math.max(parseInt(setting?.value || '1', 10) || 1, 1), 12);
    const screenWidth = 1920;
    const screenHeight = 1040;
    const cols = Math.ceil(Math.sqrt(perScreen));
    const rows = Math.ceil(perScreen / cols);
    const index = activeBrowsers.size % perScreen;
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      width: Math.floor(screenWidth / cols),
      height: Math.floor(screenHeight / rows),
      left: col * Math.floor(screenWidth / cols),
      top: row * Math.floor(screenHeight / rows),
    };
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
