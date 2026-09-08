const express = require('express');
const PlaylistService = require('../services/support-playlist.service');

const router = express.Router();

router.get('/youtube-playlist', async (req, res) => {
  try {
    const data = await PlaylistService.getPlaylist();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

module.exports = router;
