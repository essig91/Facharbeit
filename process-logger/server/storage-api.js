'use strict';

const express = require('express');
const router = express.Router();

const storageMonitor = require('./storage-monitor');

router.get('/storage-status', (_req, res) => {
  try {
    const snapshot = storageMonitor.getStatusSnapshot();
    if (!snapshot) return res.status(503).json({ ok: false, error: 'storage monitor not ready' });
    return res.json(snapshot);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

router.post('/storage-status/refresh', (_req, res) => {
  try {
    const snapshot = storageMonitor.runNow();
    return res.json(snapshot || { ok: false });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

module.exports = router;
