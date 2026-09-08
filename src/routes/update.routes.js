const express = require('express');
const UpdateService = require('../services/update.service');

const router = express.Router();

router.get('/check', async (req, res) => {
  try {
    const data = await UpdateService.check({ force: req.query.force === '1' });
    res.json({ success: true, data });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

router.post('/download', async (_req, res) => {
  try {
    const data = await UpdateService.download();
    res.json({ success: true, data });
  } catch (error) {
    res.status(409).json({ error: error.message });
  }
});

module.exports = router;
