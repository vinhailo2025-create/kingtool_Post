const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { repairMojibake } = require('./src/services/text-encoding.utils');

function registerAgentEndpoint() {
  if (process.env.COVERGEMAUTO_DESKTOP !== '1') return;
  const endpoint = {
    service: 'super-post-king-agent-api',
    base_url: `http://127.0.0.1:${config.PORT}`,
    mode: 'desktop',
    node_path: process.execPath,
    server_pid: process.pid,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(config.AGENT_API_ENDPOINT_PATH, `${JSON.stringify(endpoint, null, 2)}\n`, 'utf8');
}

function unregisterAgentEndpoint() {
  if (process.env.COVERGEMAUTO_DESKTOP !== '1') return;
  try {
    const current = JSON.parse(fs.readFileSync(config.AGENT_API_ENDPOINT_PATH, 'utf8'));
    if (Number(current.server_pid) === process.pid) {
      fs.unlinkSync(config.AGENT_API_ENDPOINT_PATH);
    }
  } catch (_) {}
}

// Ensure directories exist
[config.CHROME_PROFILES_DIR, config.BACKUPS_DIR, config.UPLOADS_DIR, config.AI_GENERATED_IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Ban desktop vut stdout/stderr cua Node; ghi loi nghiem trong ra file de con dau vet.
// Mot exception lot khoi timer nen (scheduler, comment queue, tim link...) khong duoc
// lam chet ca server: log lai va tiep tuc chay.
const SERVER_LOG_PATH = path.join(config.DATA_ROOT, 'logs', 'server.log');
function appendServerLog(label, error) {
  try {
    fs.mkdirSync(path.dirname(SERVER_LOG_PATH), { recursive: true });
    const detail = error && error.stack ? error.stack : String(error);
    fs.appendFileSync(SERVER_LOG_PATH, `[${new Date().toISOString()}] ${label}: ${detail}\n`);
  } catch (_) {}
}
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  appendServerLog('uncaughtException', error);
});
process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason);
  appendServerLog('unhandledRejection', reason);
});

async function startServer() {
  // Initialize database (sql.js is async)
  const db = require('./src/database/init');
  await db.waitReady();
  try {
    const result = require('./src/services/browser.service').retireExistingChromeProfiles();
    if (result.retired) console.log(`Đã gỡ ${result.retired} liên kết Chrome có sẵn khỏi tool.`);
  } catch (error) {
    console.error('Chrome có sẵn cleanup error:', error.message);
  }

  // Create Express app
  const app = express();
  const server = http.createServer(app);

  // WebSocket server for realtime logs
  const wss = new WebSocketServer({ server, path: '/ws/logs' });
  const wsClients = new Set();

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  // Broadcast log to all connected clients
  function broadcastLog(data) {
    if (data && data.type === 'progress') {
      try {
        const platform = String(data.platform || '').toLowerCase();
        const params = platform ? [platform] : [];
        const rows = db.prepare(`
          SELECT job_id, batch_id, platform, profile_name, post_id
          FROM agent_jobs
          WHERE status = 'running'${platform ? ' AND platform = ?' : ''}
        `).all(...params);
        for (const row of rows) {
          AgentEventService.record('job.progress', {
            ...row,
            profile: row.profile_name,
            status: 'running',
            payload: { progress: data.progress || null },
          });
        }
      } catch (_) {}
    }
    const payload = {
      ...data,
      profile: data?.profile == null ? data?.profile : repairMojibake(data.profile),
      message: repairMojibake(data?.message),
    };
    const message = JSON.stringify(payload);
    wsClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }

  // Make broadcast available globally
  app.locals.broadcastLog = broadcastLog;
  app.locals.db = db;

  const AgentEventService = require('./src/services/agent-event.service');
  AgentEventService.init();
  const unsubscribeAgentEvents = AgentEventService.subscribe(event => {
    broadcastLog({
      ...event,
      type: 'agent_event',
      event: 'agent_realtime',
      agent_event_type: event.type,
    });
  });

  // Cho phép lịch hẹn giờ log realtime qua WebSocket (chạy nền không có broadcast từ request)
  try { require('./src/services/runner-manager.service').setDefaultBroadcast(broadcastLog); } catch (e) {}
  let CommentJobService = null;
  try {
    CommentJobService = require('./src/services/comment-job.service');
    CommentJobService.setDefaultBroadcast(broadcastLog);
    CommentJobService.init();
  } catch (e) {
    console.error('Comment queue init error:', e.message);
  }
  let PostLinkRecoveryService = null;
  try {
    PostLinkRecoveryService = require('./src/services/post-link-recovery.service');
    PostLinkRecoveryService.setDefaultBroadcast(broadcastLog);
    PostLinkRecoveryService.init();
  } catch (e) {
    console.error('Post link recovery queue init error:', e.message);
  }

  // Middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));
  // Never cache static assets — WebView2/Chromium otherwise serves stale JS/CSS
  app.use(express.static(config.PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }));

  // License (kích hoạt + trạng thái) — không chặn để giao diện có thể kích hoạt
  app.use('/api/license', require('./src/routes/license.routes'));

  // Verify license khi khởi động (không chặn khởi động nếu mất mạng)
  const LicenseService = require('./src/services/license.service');
  LicenseService.verifyOnline().catch(() => {});
  // Tự verify định kỳ (12h) để thu hồi/hết hạn có hiệu lực nhanh
  setInterval(() => LicenseService.verifyOnline().catch(() => {}), 12 * 60 * 60 * 1000);

  // Routes
  app.use('/api/data', require('./src/routes/data.routes'));
  app.use('/api/browsers', require('./src/routes/browser.routes'));
  app.use('/api/runner', require('./src/routes/runner.routes'));
  app.use('/api/schedules', require('./src/routes/scheduler.routes'));
  app.use('/api/stats', require('./src/routes/stats.routes'));
  app.use('/api/settings', require('./src/routes/settings.routes'));
  app.use('/api/update', require('./src/routes/update.routes'));
  app.use('/api/ai', require('./src/routes/ai.routes'));
  app.use('/api/support', require('./src/routes/support.routes'));
  app.use('/api/google-sheets', require('./src/routes/google-sheets.routes'));
  app.use('/api/telegram', require('./src/routes/telegram.routes'));
  const AgentAuthService = require('./src/services/agent-auth.service');
  AgentAuthService.ensureKey();
  const AgentJobService = require('./src/services/agent-job.service');
  AgentJobService.init();
  app.use('/api/agent/v1', require('./src/routes/agent.routes'));
  const CloudMcpService = require('./src/services/cloud-mcp.service');

  let GoogleSheetsService = null;
  try {
    GoogleSheetsService = require('./src/services/google-sheets.service');
    GoogleSheetsService.startAutoSync();
  } catch (e) {
    console.error('Google Sheets sync init error:', e.message);
  }
  try {
    require('./src/services/telegram-notification.service').init();
  } catch (e) {
    console.error('Telegram notification init error:', e.message);
  }

  // SPA fallback
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(config.PUBLIC_DIR, 'index.html'));
  });

  // Khôi phục các lịch hẹn giờ đang bật (để lịch tự chạy lại sau khi khởi động server)
  let SchedulerService = null;
  try {
    SchedulerService = require('./src/services/scheduler.service');
    SchedulerService.setDefaultBroadcast(broadcastLog);
    SchedulerService.initAllJobs();
  } catch (e) {
    console.error('Scheduler init error:', e.message);
  }

  // Start server
  // Desktop API is local-only. Binding to loopback prevents another device on the LAN
  // from reading profiles, uploads or automation endpoints.
  server.listen(config.PORT, '127.0.0.1', () => {
    registerAgentEndpoint();
    CloudMcpService.start();
    const AgentKitService = require('./src/services/agent-kit.service');
    AgentKitService.syncInstalled()
      .then(result => {
        if (result.synced) {
          console.log('Đã tự động đồng bộ Super Post Agent Kit sau khi cập nhật ứng dụng.');
        }
      })
      .catch(error => {
        console.error('Agent Kit auto-sync error:', error.message);
      });
    console.log(`\n  ⚡ Super Post - King đang chạy tại http://localhost:${config.PORT}\n`);

    // Auto open browser only in normal web mode. Desktop mode uses pywebview.
    if (process.env.AUTO_OPEN_BROWSER !== '0') {
      import('open').then(({ default: open }) => {
        open(`http://localhost:${config.PORT}`);
      }).catch(() => {});
    }
  });

  // Waiting jobs remain durable. A running comment is never re-sent
  // automatically because Facebook may already have accepted it.
  let shuttingDown = false;
  let parentWatchdog = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n  Đang tắt server...');
    if (parentWatchdog) clearInterval(parentWatchdog);
    try { if (SchedulerService) SchedulerService.stopAllJobs(); } catch (e) {}
    try { if (PostLinkRecoveryService) PostLinkRecoveryService.shutdown(); } catch (e) {}
    try { if (CommentJobService) CommentJobService.shutdown(); } catch (e) {}
    try { if (GoogleSheetsService) GoogleSheetsService.stopAutoSync(); } catch (e) {}
    try { AgentJobService.shutdown(); } catch (e) {}
    try { CloudMcpService.stop(); } catch (e) {}
    try { unsubscribeAgentEvents(); } catch (e) {}
    try { AgentEventService.stop(); } catch (e) {}
    unregisterAgentEndpoint();
    db.close();
    server.close();
    process.exit(0);
  };

  const desktopParentPid = Number(process.env.COVERGEMAUTO_PARENT_PID || 0);
  if (process.env.COVERGEMAUTO_DESKTOP === '1' && Number.isInteger(desktopParentPid) && desktopParentPid > 0) {
    parentWatchdog = setInterval(() => {
      try {
        process.kill(desktopParentPid, 0);
      } catch (error) {
        if (error && error.code === 'ESRCH') shutdown();
      }
    }, 2000);
    parentWatchdog.unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
