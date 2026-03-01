/**
 * routes/opcua-read.js
 *
 * POST /api/opcua/readValue
 * Body: { connectionId, nodeId }
 *
 * Resolves connectionId via local /api/opcua/connections when possible,
 * otherwise uses connectionId as endpoint URL. Reads AttributeIds.Value.
 */

const express = require('express');
const router = express.Router();
const { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy } = require('node-opcua');
const fetch = globalThis.fetch || (typeof require !== 'undefined' ? require('node-fetch') : undefined);

function policyFromArg(p) {
  if (!p) return SecurityPolicy.None;
  const s = String(p);
  if (/none/i.test(s)) return SecurityPolicy.None;
  if (/basic256sha256/i.test(s)) return SecurityPolicy.Basic256Sha256;
  if (/basic256/i.test(s)) return SecurityPolicy.Basic256;
  if (/basic128/i.test(s)) return SecurityPolicy.Basic128Rsa15;
  return SecurityPolicy.None;
}

router.post('/readValue', async (req, res) => {
  const body = req.body || {};
  const { connectionId, nodeId } = body;
  if (!connectionId || !nodeId) return res.status(400).json({ error: 'connectionId and nodeId required' });

  let conn = null;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/opcua/connections');
    if (r && r.ok) {
      const list = await r.json();
      conn = list.find(c => String(c.id) === String(connectionId) || String(c.endpoint) === String(connectionId));
    }
  } catch (e) { /* ignore */ }

  const endpoint = conn ? (conn.endpoint || connectionId) : connectionId;
  const username = conn && conn.authentication ? conn.authentication.username : undefined;
  const password = conn && conn.authentication ? conn.authentication.password : undefined;
  const securityPolicy = conn && conn.securityPolicy ? conn.securityPolicy : 'None';
  const isNone = String(securityPolicy || 'None').toLowerCase() === 'none';

  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityPolicy: policyFromArg(securityPolicy),
    securityMode: isNone ? MessageSecurityMode.None : MessageSecurityMode.SignAndEncrypt,
    connectionStrategy: { maxRetry: 0, initialDelay: 1000, maxDelay: 10000 }
  });

  let session;
  try {
    await client.connect(endpoint);
    session = await client.createSession(username ? { userName: username, password } : null);

    const dataValue = await session.read({ nodeId, attributeId: AttributeIds.Value });
    let value = undefined;
    if (dataValue && dataValue.value) value = dataValue.value.value; else value = null;

    await session.close();
    await client.disconnect();
    return res.json({ nodeId, value });
  } catch (err) {
    try { if (session) await session.close(); } catch(e) {}
    try { await client.disconnect(); } catch(e) {}
    console.error('readValue error', err);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

module.exports = router;