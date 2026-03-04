/**
 * routes/opcua-read.js
 *
 * POST /api/opcua/readValue
 * Body: { connectionId, nodeId }
 *
 * Uses the shared session manager to reuse OPC-UA sessions across requests.
 */

const express = require('express');
const router = express.Router();
const { globalReadValue } = require('../server/opcua-session-manager');

router.post('/readValue', async (req, res) => {
  const body = req.body || {};
  const { connectionId, nodeId } = body;
  if (!connectionId || !nodeId) return res.status(400).json({ error: 'connectionId and nodeId required' });

  try {
    const result = await globalReadValue(connectionId, nodeId);
    return res.json(result);
  } catch (err) {
    console.error('readValue error', err);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

module.exports = router;