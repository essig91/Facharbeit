/**
 * routes/opcua-logpoints.js
 *
 * API für Logpoints (Datei-Backed) plus zusätzlicher readValue-Handler,
 * der einen einzelnen OPC UA Node (Attribute Value) direkt liest.
 *
 * Endpunkte:
 *  - GET  /api/opcua/logpoints?connectionId=...
 *  - POST /api/opcua/logpoints
 *  - POST /api/opcua/logpoints/bulk
 *  - PUT  /api/opcua/logpoints/:id
 *  - DELETE /api/opcua/logpoints/:id
 *  - POST /api/opcua/readValue    <-- NEU: { connectionId, nodeId } -> { nodeId, value }
 *
 * Storage: JSON-Datei unter /opt/process-logger/data/logpoints.json
 *
 * Hinweis: diese Datei ist "standalone" und benutzt node-fetch + node-opcua
 * für die readValue-Funktion. Stelle sicher, dass node-fetch und node-opcua
 * in node_modules vorhanden sind (sind normalerweise in deiner Installation).
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PROCESS_LOGGER_DATA_DIR || '/opt/process-logger/data';
const DATA_FILE = path.join(DATA_DIR, 'logpoints.json');

function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]), { mode: 0o640 });
  } catch (e) {
    console.error('ensureDataFile error', e);
    throw e;
  }
}

function readAll() {
  ensureDataFile();
  try {
    const txt = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(txt || '[]');
  } catch (e) {
    console.error('readAll logpoints error', e);
    return [];
  }
}

function writeAll(list) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error('writeAll logpoints error', e);
    throw e;
  }
}

function makeId() {
  return Date.now().toString(10) + Math.floor(Math.random() * 1000).toString(10);
}

/* GET /api/opcua/logpoints
   optional query: connectionId
*/
router.get('/logpoints', (req, res) => {
  try {
    const connectionId = req.query.connectionId;
    const all = readAll();
    if (connectionId) {
      const filtered = all.filter(lp => String(lp.connectionId) === String(connectionId));
      return res.json(filtered);
    }
    return res.json(all);
  } catch (err) {
    console.error('GET /logpoints error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* POST /api/opcua/logpoints
   Body: { connectionId, nodeId, browseName?, displayName?, dataType?, unit?, samplingIntervalMs?, isAlarm?, decimals? }
*/
router.post('/logpoints', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.connectionId || !body.nodeId) {
      return res.status(400).json({ error: 'connectionId and nodeId required' });
    }
    const all = readAll();
    const now = new Date().toISOString();
    const rec = {
      id: makeId(),
      connectionId: body.connectionId,
      nodeId: body.nodeId,
      browseName: body.browseName || '',
      displayName: body.displayName || '',
      dataType: body.dataType || '',
      unit: body.unit || '',
      samplingIntervalMs: Number(body.samplingIntervalMs) || 1000,
      isAlarm: !!body.isAlarm,
      decimals: Number(body.decimals) >= 0 ? Number(body.decimals) : 2,
      createdAt: now,
      updatedAt: now
    };
    all.push(rec);
    writeAll(all);
    return res.status(201).json(rec);
  } catch (err) {
    console.error('POST /logpoints error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* POST /api/opcua/logpoints/bulk
   Body: [ { connectionId, nodeId, browseName, displayName, dataType, unit, samplingIntervalMs, isAlarm, decimals }, ... ]
   Returns { count, errors: [{item, error}] }
*/
router.post('/logpoints/bulk', (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : null;
    if (!items) return res.status(400).json({ error: 'expected JSON array in request body' });

    const all = readAll();
    const now = new Date().toISOString();
    const result = { count: 0, errors: [] };

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.connectionId || !it.nodeId) {
        result.errors.push({ item: it && (it.nodeId || it.browseName) || `(index ${i})`, error: 'connectionId and nodeId required' });
        continue;
      }
      try {
        const rec = {
          id: makeId(),
          connectionId: it.connectionId,
          nodeId: it.nodeId,
          browseName: it.browseName || '',
          displayName: it.displayName || '',
          dataType: it.dataType || '',
          unit: it.unit || '',
          samplingIntervalMs: Number(it.samplingIntervalMs) || 1000,
          isAlarm: !!it.isAlarm,
          decimals: Number(it.decimals) >= 0 ? Number(it.decimals) : 2,
          createdAt: now,
          updatedAt: now
        };
        all.push(rec);
        result.count++;
      } catch (e2) {
        result.errors.push({ item: it && (it.nodeId || it.browseName) || `(index ${i})`, error: String(e2) });
      }
    }

    writeAll(all);

    return res.status(200).json(result);
  } catch (err) {
    console.error('POST /logpoints/bulk error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* PUT /api/opcua/logpoints/:id
   Body: patch fields (displayName, unit, samplingIntervalMs, isAlarm, dataType, decimals)
*/
router.put('/logpoints/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing id' });
    const patch = req.body || {};
    const all = readAll();
    const idx = all.findIndex(p => String(p.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const rec = all[idx];
    const allowed = ['displayName', 'unit', 'samplingIntervalMs', 'isAlarm', 'dataType', 'decimals'];
    allowed.forEach(k => {
      if (patch[k] !== undefined) {
        if (k === 'samplingIntervalMs' || k === 'decimals') {
          rec[k] = Number(patch[k]) || (k === 'decimals' ? 2 : 1000);
        } else if (k === 'isAlarm') {
          rec[k] = !!patch[k];
        } else {
          rec[k] = patch[k];
        }
      }
    });
    rec.updatedAt = new Date().toISOString();
    all[idx] = rec;
    writeAll(all);
    return res.json(rec);
  } catch (err) {
    console.error('PUT /logpoints/:id error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* DELETE /api/opcua/logpoints/:id */
router.delete('/logpoints/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing id' });
    const all = readAll();
    const idx = all.findIndex(p => String(p.id) === String(id));
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const removed = all.splice(idx, 1);
    writeAll(all);
    return res.json({ removed: removed[0] });
  } catch (err) {
    console.error('DELETE /logpoints/:id error', err);
    return res.status(500).json({ error: String(err) });
  }
});

/* ---------------------------------------------------------
   NEU: POST /api/opcua/readValue
   Body: { connectionId, nodeId }
   Liefert: { nodeId, value } oder { error: '...' }
   Implementierung: verbindet kurz mit dem OPC UA Server mittels node-opcua,
   liest AttributeIds.Value und gibt den Wert zurück.
   --------------------------------------------------------- */

let nodeOpcUaAvailable = true;
try {
  // optional require - falls node-opcua nicht installiert, fangen wir den Fehler ab
  var { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy } = require('node-opcua');
  var fetch = global.fetch || require('node-fetch');
} catch (e) {
  nodeOpcUaAvailable = false;
  console.error('node-opcua oder node-fetch nicht verfügbar:', e && e.message ? e.message : e);
}

function policyFromArg(p) {
  if (!p) return SecurityPolicy ? SecurityPolicy.None : null;
  const s = String(p);
  if (/none/i.test(s)) return SecurityPolicy.None;
  if (/basic256sha256/i.test(s)) return SecurityPolicy.Basic256Sha256;
  if (/basic256/i.test(s)) return SecurityPolicy.Basic256;
  if (/basic128/i.test(s)) return SecurityPolicy.Basic128Rsa15;
  return SecurityPolicy.None;
}

router.post('/readValue', async (req, res) => {
  if (!nodeOpcUaAvailable) return res.status(500).json({ error: 'node-opcua nicht verfügbar auf dem Server' });

  const body = req.body || {};
  const { connectionId, nodeId } = body;
  if (!connectionId || !nodeId) return res.status(400).json({ error: 'connectionId and nodeId required' });

  // Versuche, Connection-Metadaten lokal zu finden
  let conn = null;
  try {
    const r = await fetch('http://127.0.0.1:3000/api/opcua/connections');
    if (r && r.ok) {
      const list = await r.json();
      conn = list.find(c => String(c.id) === String(connectionId) || String(c.endpoint) === String(connectionId));
    }
  } catch (e) {
    // ignore - wir nutzen connectionId als endpoint fallback
  }

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
    let value = null;
    if (dataValue && dataValue.value) value = dataValue.value.value;

    try { await session.close(); } catch (e) { /* ignore */ }
    try { await client.disconnect(); } catch (e) { /* ignore */ }

    return res.json({ nodeId, value });
  } catch (err) {
    try { if (session) await session.close(); } catch (e) { /* ignore */ }
    try { await client.disconnect(); } catch (e) { /* ignore */ }
    console.error('POST /readValue error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

module.exports = router;