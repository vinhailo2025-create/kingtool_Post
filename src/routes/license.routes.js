/**
 * License Routes - /api/license (phía tool)
 * Cung cấp HWID + trạng thái + kích hoạt cho giao diện.
 */
const express = require('express');
const router = express.Router();
const LicenseService = require('../services/license.service');

// GET /api/license/status
router.get('/status', (req, res) => {
  try {
    const state = LicenseService.getState();
    res.json({
      success: true,
      data: { ...state, hwid: LicenseService.getHwid(), web_url: LicenseService.webUrl() },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/license/orders — lịch sử đơn hàng của máy
router.get('/orders', async (req, res) => {
  try {
    const orders = await LicenseService.getOrders();
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/license/activate { key }
router.post('/activate', async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || !String(key).trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập key' });
    }
    const state = await LicenseService.activate(key);
    if (!state.valid) {
      return res.status(400).json({ error: state.reason || 'Kích hoạt thất bại', data: state });
    }
    res.json({ success: true, data: { ...state, hwid: LicenseService.getHwid() } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/license/claim — lấy license đã được gắn sẵn cho máy này trên web
router.post('/claim', async (req, res) => {
  try {
    const state = await LicenseService.claimByHwid();
    if (!state.valid) {
      return res.status(400).json({ error: state.reason || 'Chưa lấy được license', data: state });
    }
    res.json({ success: true, data: { ...state, hwid: LicenseService.getHwid() } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/license/pair/start — tạo liên kết một lần, bí mật chỉ giữ trong tiến trình tool
router.post('/pair/start', async (req, res) => {
  try {
    const pairing = await LicenseService.startPairing();
    res.json({ success: true, data: pairing });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/license/pair/status — tool tự kiểm tra tới khi website xác nhận
router.post('/pair/status', async (req, res) => {
  try {
    const result = await LicenseService.pollPairing();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/license/refresh — verify lại với server
router.post('/refresh', async (req, res) => {
  try {
    const state = await LicenseService.verifyOnline();
    res.json({ success: true, data: { ...state, hwid: LicenseService.getHwid() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
