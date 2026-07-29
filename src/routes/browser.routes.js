/**
 * Browser Routes - Chrome Profile Management API
 */

const express = require('express');
const router = express.Router();
const BrowserService = require('../services/browser.service');

/**
 * GET / - List all browser profiles with status
 */
router.get('/', (req, res) => {
  try {
    const profiles = BrowserService.getAll();
    res.json({ success: true, data: profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST / - Create a new browser profile
 */
router.post('/', (req, res) => {
  try {
    const profile = BrowserService.create(req.body);
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /:id - Update a browser profile
 */
router.put('/:id', (req, res) => {
  try {
    const profile = BrowserService.update(parseInt(req.params.id), req.body);
    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /:id - Delete a browser profile (close Chrome first if open)
 */
router.delete('/:id', async (req, res) => {
  try {
    await BrowserService.delete(parseInt(req.params.id));
    res.json({ success: true, message: 'Đã xóa profile' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /:id/launch - Launch Chrome with this profile
 */
router.post('/:id/launch', async (req, res) => {
  try {
    const result = await BrowserService.launch(parseInt(req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /:id/close - Close Chrome for this profile
 */
router.post('/:id/close', async (req, res) => {
  try {
    const result = await BrowserService.close(parseInt(req.params.id));
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /:id/status - Get browser status and session validity
 */
router.get('/:id/status', async (req, res) => {
  try {
    const status = await BrowserService.getStatus(parseInt(req.params.id));
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
