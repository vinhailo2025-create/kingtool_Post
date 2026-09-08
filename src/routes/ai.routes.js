const express = require('express');
const router = express.Router();
const AiContentService = require('../services/ai-content.service');
const ChatGptLocalService = require('../services/chatgpt-local.service');
const { normalizePlatform } = require('../platforms/platform.utils');

function platformOf(req) {
  return normalizePlatform(req.query.platform || req.body?.platform);
}

router.get('/chatgpt/detect', async (req, res) => {
  try {
    const data = await ChatGptLocalService.detectInstallation(req.query.cliPath);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/chatgpt/open-config', (req, res) => {
  try {
    const data = ChatGptLocalService.openConfigDirectory();
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/settings', (req, res) => {
  try {
    res.json({ success: true, data: AiContentService.getSettings(platformOf(req)) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/settings', (req, res) => {
  try {
    const data = AiContentService.saveSettings(req.body || {}, platformOf(req));
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    const provider = req.body?.provider;
    const result = await AiContentService.testConnection(provider, {
      apiKey: req.body?.apiKey,
      model: req.body?.model,
      imageModel: req.body?.imageModel,
      aspectRatio: req.body?.aspectRatio,
      baseUrl: req.body?.baseUrl,
      cliPath: req.body?.cliPath,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/rewrite', async (req, res) => {
  try {
    const result = await AiContentService.rewritePosts({
      platform: platformOf(req),
      provider: req.body?.provider,
      prompt: req.body?.prompt,
      postIds: req.body?.postIds,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/images', async (req, res) => {
  try {
    const result = await AiContentService.startImageJob({
      platform: platformOf(req),
      provider: req.body?.provider,
      prompt: req.body?.prompt,
      postIds: req.body?.postIds,
      overwrite: req.body?.overwrite,
      useReference: req.body?.useReference,
    });
    res.status(202).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/images/:jobId', (req, res) => {
  try {
    res.json({ success: true, data: AiContentService.getImageJob(req.params.jobId) });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

module.exports = router;
