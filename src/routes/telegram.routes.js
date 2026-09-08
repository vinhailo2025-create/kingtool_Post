const express = require('express');
const TelegramNotificationService = require('../services/telegram-notification.service');
const TelegramControlService = require('../services/telegram-control.service');

const router = express.Router();

router.get('/settings', (req, res) => {
  try {
    res.json({ success: true, data: TelegramNotificationService.publicState() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const data = await TelegramNotificationService.saveSettings(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/connect', async (req, res) => {
  try {
    const data = await TelegramNotificationService.connect(req.body?.token);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    await TelegramNotificationService.pollNow();
    res.json({ success: true, data: TelegramNotificationService.publicState() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    const data = await TelegramNotificationService.test(req.body?.message);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/menu', async (req, res) => {
  try {
    const state = TelegramNotificationService.internalState();
    if (!state.chatIds.length) throw new Error('Chưa có chat Telegram đã bấm Start.');
    await Promise.all(state.chatIds.map(chatId => TelegramControlService.handleUpdate({
      message: { chat: { id: chatId }, text: '/start' },
    })));
    res.json({ success: true, data: { sent: state.chatIds.length } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    const data = await TelegramNotificationService.disconnect();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
