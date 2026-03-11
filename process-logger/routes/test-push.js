'use strict';
/**
 * POST /api/opcua/test-push
 * Body: { connectionId, logpoint_id, ts, value, status, serverTimestamp }
 * Pushes a sample to the MeasurementWriter for the given connection.
 */

const express = require('express');
const writerManager = require('../lib/writer-manager');

const router = express.Router();

router.post('/test-push', (req, res) => {
  const body = req.body || {};
  const { connectionId, logpoint_id, ts, value, status, serverTimestamp } = body;

  if (!connectionId) {
    return res.status(400).json({ error: 'connectionId is required' });
  }

  // Ensure a writer exists for this connection
  let writer = writerManager.getWriter(connectionId);
  if (!writer) {
    writer = writerManager.createForConnection({ id: connectionId });
  }

  try {
    writer.push({ logpoint_id, ts: ts || Date.now(), value, status, serverTimestamp });
    return res.json({ ok: true });
  } catch (e) {
    console.error('test-push error:', e);
    return res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
