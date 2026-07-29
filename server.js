const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Ensure directories exist
[config.CHROME_PROFILES_DIR, config.BACKUPS_DIR, config.UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

async function startServer() {
  // Initialize database (sql.js is async)
  const db = require('./src/database/init');
  await db.waitReady();

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
    const message = JSON.stringify(data);
    wsClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }

  // Make broadcast available globally
  app.locals.broadcastLog = broadcastLog;
  app.locals.db = db;

  // Cho phép lịch hẹn giờ log realtime qua WebSocket (chạy nền không có broadcast từ request)
  try { require('./src/services/runner.service').setDefaultBroadcast(broadcastLog); } catch (e) {}

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

  // Routes
  app.use('/api/data', require('./src/routes/data.routes'));
  app.use('/api/browsers', require('./src/routes/browser.routes'));
  app.use('/api/runner', require('./src/routes/runner.routes'));
  app.use('/api/schedules', require('./src/routes/scheduler.routes'));
  app.use('/api/stats', require('./src/routes/stats.routes'));
  app.use('/api/settings', require('./src/routes/settings.routes'));

  // SPA fallback
  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(config.PUBLIC_DIR, 'index.html'));
  });

  // Khôi phục các lịch hẹn giờ đang bật (để lịch tự chạy lại sau khi khởi động server)
  let SchedulerService = null;
  try {
    SchedulerService = require('./src/services/scheduler.service');
    SchedulerService.initAllJobs();
  } catch (e) {
    console.error('Scheduler init error:', e.message);
  }

  // Start server
  server.listen(config.PORT, () => {
    console.log(`\n  ⚡ CovergemAuto đang chạy tại http://localhost:${config.PORT}\n`);

    // Auto open browser only in normal web mode. Desktop mode uses pywebview.
    if (process.env.AUTO_OPEN_BROWSER !== '0') {
      import('open').then(({ default: open }) => {
        open(`http://localhost:${config.PORT}`);
      }).catch(() => {});
    }
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n  Đang tắt server...');
    try { if (SchedulerService) SchedulerService.stopAllJobs(); } catch (e) {}
    db.close();
    server.close();
    process.exit(0);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
