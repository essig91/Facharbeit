'use strict';
/**
 * routes/opcua-logpoints.js
 *
 * API für Logpoints (SQLite-only via ../lib/logpoint-store.js)
 * plus readValue-Handler (versucht global handler, ansonsten eigene OPC UA read mit Namespace-URI-Auflösung).
 *
 * Endpunkte:
 *  - GET  /api/opcua/logpoints?connectionId=...
 *  - POST /api/opcua/logpoints
 *  - POST /api/opcua/logpoints/bulk
 *  - PUT  /api/opcua/logpoints/:id
 *  - DELETE /api/opcua/logpoints/:id
 *  - POST /api/opcua/readValue
 */

const express = require('express');
const router = express.Router();

const store = require('../lib/logpoint-store');

// node-opcua (optional)
let nodeOpcUaAvailable = true;
let opcua;
try {
  opcua = require('node-opcua');
} catch (e) {
  nodeOpcUaAvailable = false;
  // not fatal; readValue will try global handler first and otherwise return 501
}

/* Helper: safety wrapper für sync/async store calls */
function safeCall(fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') return res;
    return Promise.resolve(res);
  } catch (e) {
    return Promise.reject(e);
  }
}

/* Helper: Logger-Neustart nach Logpoint-Konfigurationsänderungen */
function triggerLoggerRestart() {
  if (typeof global.__opcuaLogger === 'object' && typeof global.__opcuaLogger.restartAll === 'function') {
    global.__opcuaLogger.restartAll().catch((e) => {
      console.error('triggerLoggerRestart Fehler:', e && e.message ? e.message : e);
    });
  }
}

/* GET /api/opcua/logpoints */
router.get('/logpoints', async (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    const all = await safeCall(() => (connectionId ? store.list({ connectionId }) : store.list()));
    return res.json(all || []);
  } catch (err) {
    console.error('GET /logpoints error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* POST /api/opcua/logpoints */
router.post('/logpoints', async (req, res) => {
  try {
    const obj = req.body || {};
    const created = await safeCall(() => store.create(obj));
    triggerLoggerRestart();
    return res.status(201).json(created);
  } catch (err) {
    console.error('POST /logpoints error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* POST /api/opcua/logpoints/bulk */
router.post('/logpoints/bulk', async (req, res) => {
  try {
    const arr = Array.isArray(req.body) ? req.body : (req.body && req.body.items) || [];
    if (!Array.isArray(arr) || arr.length === 0) {
      return res.status(400).json({ error: 'expected non-empty array in body' });
    }
    const result = await safeCall(() => store.bulkCreate(arr));
    if (Array.isArray(result)) {
      return res.json({ count: result.length, items: result });
    }
    return res.json({ count: result && result.count ? result.count : arr.length });
  } catch (err) {
    console.error('POST /logpoints/bulk error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* PUT /api/opcua/logpoints/:id */
router.put('/logpoints/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const patch = req.body || {};
    const updated = await safeCall(() => store.update(id, patch));
    if (!updated) return res.status(404).json({ error: 'not found' });
    triggerLoggerRestart();
    return res.json(updated);
  } catch (err) {
    console.error('PUT /logpoints/:id error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* DELETE /api/opcua/logpoints/:id */
router.delete('/logpoints/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const removed = await safeCall(() => store.remove(id));
    if (!removed) return res.status(404).json({ error: 'not found' });
    triggerLoggerRestart();
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /logpoints/:id error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* GET /api/opcua/logpoints/:id/measurements */
const DEFAULT_QUERY_WINDOW_MS = 60 * 60 * 1000; // 1 Stunde
const DEFAULT_MEASUREMENT_LIMIT = 1000;

router.get('/logpoints/:id/measurements', (req, res) => {
  try {
    const id = req.params.id;
    const fromTs = req.query.from ? Number(req.query.from) : (Date.now() - DEFAULT_QUERY_WINDOW_MS);
    const toTs = req.query.to ? Number(req.query.to) : Date.now();
    const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_MEASUREMENT_LIMIT;
    const rows = store.queryMeasurements(id, fromTs, toTs, limit);
    return res.json(rows);
  } catch (err) {
    console.error('GET /logpoints/:id/measurements error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* POST /api/opcua/logger/restart – startet alle OPC UA Subscriptions neu */
router.post('/logger/restart', async (req, res) => {
  try {
    if (typeof global.__opcuaLogger === 'object' && typeof global.__opcuaLogger.restartAll === 'function') {
      await global.__opcuaLogger.restartAll();
      return res.json({ ok: true });
    }
    return res.status(503).json({ error: 'Logger nicht verfügbar' });
  } catch (err) {
    console.error('POST /logger/restart error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* -----------------------------
   Helper: resolve namespace URI -> index (uses session.read on i=2255)
   ----------------------------- */

async function resolveNamespaceUriIfNeeded(session, nodeId) {
  // matches "nsu=URI;i=123" or "URI;i=123"
  const s = String(nodeId || '');
  const m1 = s.match(/^\s*nsu=(.+);i=(\d+)\s*$/i);
  const m2 = s.match(/^\s*(https?:\/\/[^;]+);i=(\d+)\s*$/i);
  const match = m1 || m2;
  if (!match) return nodeId;

  const nsUri = match[1];
  const identifier = Number(match[2]);

  try {
    const AttributeIds = opcua.AttributeIds || require('node-opcua').AttributeIds;
    // read NamespaceArray (i=2255)
    const nsRead = await session.read({ nodeId: 'i=2255', attributeId: AttributeIds.Value });
    const nsArray = (nsRead && nsRead.value && nsRead.value.value) ? nsRead.value.value : null;
    if (!Array.isArray(nsArray)) return nodeId;

    const idx = nsArray.indexOf(nsUri);
    if (idx >= 0) {
      return `ns=${idx};i=${identifier}`;
    }
    return nodeId;
  } catch (e) {
    // if resolution fails for any reason, return original nodeId
    return nodeId;
  }
}

/* Helper: fetch local connections config from this server
   (calls the local /api/opcua/connections endpoint). */
const http = require('http');
const https = require('https');
const { URL } = require('url');

function fetchLocalConnections() {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const opts = {
      hostname: '127.0.0.1',
      port: port,
      path: '/api/opcua/connections',
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data || '[]');
          resolve(Array.isArray(json) ? json : []);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', (e) => {
      resolve([]); // return empty on error
    });
    req.end();
  });
}

/* -----------------------------
   POST /api/opcua/readValue
   - First tries a global handler: global.__processLoggerReadValue(connectionId, nodeId)
   - If not present, and node-opcua is available, will:
     * lookup connection info via local /api/opcua/connections
     * create an OPC UA client/session to that endpoint
     * attempt namespace-uri resolution if nodeId contains a URI form
     * read attribute Value and return { nodeId, value, dataType? }
   - If node-opcua not available and no global handler, returns 501.
   ----------------------------- */

router.post('/readValue', async (req, res) => {
  try {
    const { connectionId, nodeId: rawNodeId } = req.body || {};
    if (!connectionId || !rawNodeId) {
      return res.status(400).json({ error: 'connectionId and nodeId required' });
    }

    // 1) prefer a global delegating handler if available (allows shared/persistent sessions)
    if (typeof global.__processLoggerReadValue === 'function') {
      try {
        const out = await Promise.resolve(global.__processLoggerReadValue(connectionId, rawNodeId));
        return res.json(out);
      } catch (e) {
        // continue to fallback if global handler failed
        console.warn('global.__processLoggerReadValue failed:', e && e.message ? e.message : e);
      }
    }

    // 2) if node-opcua not installed, bail out
    if (!nodeOpcUaAvailable) {
      return res.status(501).json({ error: 'readValue handler not implemented in this deployment (node-opcua missing)' });
    }

    // 3) get connection config from local server (best-effort)
    const conns = await fetchLocalConnections();
    const conn = conns.find(c => String(c.id) === String(connectionId) || String(c.endpoint) === String(connectionId));
    if (!conn || !conn.endpoint) {
      return res.status(404).json({ error: 'connection config not found for connectionId' });
    }

    // 4) build OPC UA client and session
    const {
      OPCUAClient,
      AttributeIds,
      ClientSession,
      // MessageSecurityMode, SecurityPolicy
    } = opcua;

    const client = OPCUAClient.create({
      endpoint_must_exist: false,
      connectionStrategy: {
        maxRetry: 0
      },
      // keep the default timeouts; tune if you see timeouts
    });

    let session;
    try {
      const endpointUrl = conn.endpoint;

      await client.connect(endpointUrl);

      // identity: if authentication provided in connection config
      let userIdentity = null;
      if (conn.authentication && conn.authentication.username) {
        userIdentity = {
          type: opcua.UserTokenType.UserName,
          userName: conn.authentication.username,
          password: conn.authentication.password || ''
        };
      } else {
        userIdentity = null; // anonymous
      }

      session = await client.createSession(userIdentity);

      // 5) attempt namespace-uri resolution if needed
      let nodeId = rawNodeId;
      try {
        nodeId = await resolveNamespaceUriIfNeeded(session, rawNodeId);
      } catch (e) {
        // ignore resolution failure, will try original nodeId
        nodeId = rawNodeId;
      }

      // 6) do the read
      const dataValue = await session.read({ nodeId: nodeId, attributeId: AttributeIds.Value });
      // dataValue may be a Variant container: { value: { value: X, dataType: ... }, statusCode, sourceTimestamp }
      let ret = { nodeId };

      if (dataValue && dataValue.statusCode && dataValue.statusCode.name && dataValue.statusCode.name !== 'Good') {
        // no value
        ret.value = null;
        ret.statusCode = String(dataValue.statusCode ? dataValue.statusCode.toString() : '');
      } else {
        // attempt to extract actual value
        try {
          ret.value = (dataValue && dataValue.value) ? dataValue.value.value : null;
          // include dataType if available (as string or numeric)
          if (dataValue && dataValue.value && dataValue.value.dataType !== undefined) {
            ret.dataType = String(dataValue.value.dataType ? dataValue.value.dataType.toString() : '');
          }
          if (dataValue && dataValue.serverTimestamp) ret.serverTimestamp = dataValue.serverTimestamp;
        } catch (e) {
          ret.value = null;
        }
      }

      // cleanup
      try { await session.close(); } catch (e) {}
      try { await client.disconnect(); } catch (e) {}

      return res.json(ret);
    } catch (err) {
      try { if (session) await session.close(); } catch (e) {}
      try { await client.disconnect(); } catch (e) {}
      console.error('readValue OPC UA error', err);
      return res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  } catch (err) {
    console.error('POST /readValue error', err);
    return res.status(500).json({ error: String(err) });
  }
});

module.exports = router;