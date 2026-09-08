const express = require('express');
const GoogleSheetsService = require('../services/google-sheets.service');

const router = express.Router();

function platformOf(req) {
  return String(req.query.platform || req.body?.platform || 'facebook').trim().toLowerCase();
}

router.get('/settings', (req, res) => {
  res.json({ success: true, data: GoogleSheetsService.getPublicSettings() });
});

router.put('/settings', (req, res) => {
  try {
    const data = GoogleSheetsService.saveConfig(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/credentials', (req, res) => {
  try {
    res.json({ success: true, data: GoogleSheetsService.removeCredentials() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    const data = await GoogleSheetsService.testConnection();
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const action = String(req.body?.action || 'push').trim().toLowerCase();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    const data = await GoogleSheetsService.sync(action, platformOf(req), ids);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/sync-all', async (req, res) => {
  try {
    const action = String(req.body?.action || 'push').trim().toLowerCase();
    const data = await GoogleSheetsService.syncAll(action);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
