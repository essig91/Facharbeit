'use strict';
/*
  server/index.js
  Main Express bootstrap for process-logger
  - mounts API routers under /api/opcua
  - ensures the readValue router (opcua-read.js) is mounted so frontend calls to /api/opcua/readValue work
*/

const express = require('express');
const path = require('path');
require('dotenv').config();

// DB initialisieren
const { init: initDb } = require('./db'); // benutzt server/db.js
const sessionManager = require('./opcua-session-manager');
const logpointStore = require('../lib/logpoint-store');
const dbPath = path.join(__dirname, '..', 'data', 'database.db');
let dbObj = null; // wird nach init gesetzt

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Mount configuration & routers
const opcuaApi = require('./opcua-config-api');
app.use('/api/opcua', opcuaApi);

const opcuaTestRouter = require('../routes/opcua-test');
app.use('/api/opcua', opcuaTestRouter);

// mount opcua-read (ensures POST /api/opcua/readValue is handled by the dedicated read implementation)
try {
  const opcuaReadRouter = require('../routes/opcua-read');
  app.use('/api/opcua', opcuaReadRouter);
} catch (e) {
  // If the file doesn't exist or fails to load, log but continue. Mounting later routers may still provide readValue.
  console.error('Could not mount routes/opcua-read.js:', e && e.message ? e.message : e);
}

const opcuaBrowseRouter = require('../routes/opcua-browse');
app.use('/api/opcua', opcuaBrowseRouter);

// opcua-logpoints router (CRUD for logpoints)
const opcuaLogpointsRouter = require('../routes/opcua-logpoints');
app.use('/api/opcua', opcuaLogpointsRouter);

// Network API (apply network changes)
// NOTE: Make sure this route is protected by your auth middleware in production.
const networkApi = require('./network');
app.use('/api/network', networkApi);

// NTP-API einbinden (stellt POST /api/ntp bereit)
const ntpApi = require('./ntp-api');
app.use('/api', ntpApi);

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_s: Math.round(process.uptime()),
    ts: Date.now()
  });
});

// Serve static frontend (if any)
app.use(express.static(path.join(__dirname, '..', 'web')));

const server = app.listen(PORT, () => {
  console.log(`process-logger listening on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  // Stop logpoint scheduler timers
  for (const timer of logpointTimers.values()) clearInterval(timer);
  logpointTimers.clear();
  clearInterval(logpointSyncTimer);
  try {
    await sessionManager.closeAll();
  } catch (e) {
    console.error('Error closing OPC-UA sessions', e);
  }
  try {
    if (dbObj && typeof dbObj.close === 'function') {
      console.log('Closing DB...');
      dbObj.close();
    }
  } catch (e) {
    console.error('Error closing DB', e);
  }
  server.close(() => process.exit(0));
});

// init DB direkt beim Start
try {
  dbObj = initDb(dbPath);
  console.log('Database initialized at', dbPath);
} catch (err) {
  console.error('Failed to initialize DB:', err);
  // Falls DB nicht initialisiert werden kann, Prozess beeenden
  process.exit(1);
}

// Start OPC-UA session pruner (closes idle sessions after 5 min)
sessionManager.startPrune();

// --- Logpoint Polling Scheduler ---
// Per-logpoint timers: Map<logpointId, NodeJS.Timer>
const logpointTimers = new Map();
let logpointSyncTimer = null;

async function pollAndLog(lp) {
  if (!dbObj) return;
  try {
    const result = await sessionManager.globalReadValue(lp.connectionId, lp.nodeId);
    if (!result || result.value === undefined || result.value === null) return;
    let v = result.value;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    const numValue = Number(v);
    if (isNaN(numValue)) return;
    const ts = Date.now();
    dbObj.insertTag(lp.id, lp.nodeId, lp.dataType || '');
    dbObj.insertMeasurement(lp.id, ts, numValue);
  } catch (_) { /* silently ignore per-logpoint errors */ }
}

function syncLogpointTimers() {
  let logpoints = [];
  try { logpoints = logpointStore.list(); } catch (_) { return; }

  const existingIds = new Set(logpoints.map(lp => lp.id));
  // Remove timers for deleted logpoints
  for (const [id, timer] of logpointTimers) {
    if (!existingIds.has(id)) {
      clearInterval(timer);
      logpointTimers.delete(id);
    }
  }
  // Add timers for new logpoints
  for (const lp of logpoints) {
    if (!logpointTimers.has(lp.id)) {
      const intervalMs = Math.max(Number(lp.samplingIntervalMs) || 1000, 100);
      const timer = setInterval(() => pollAndLog(lp), intervalMs);
      logpointTimers.set(lp.id, timer);
    }
  }
}

// Initial sync, then re-sync every 30 s to pick up added/removed logpoints
syncLogpointTimers();
logpointSyncTimer = setInterval(syncLogpointTimers, 30_000);

// Einfacher Test‑API‑Endpoint: fügt eine Messung ein und liest sie wieder aus
app.post('/api/measurements/test', (req, res) => {
  if (!dbObj) return res.status(500).json({ ok: false, error: 'DB not initialized' });

  const tag = req.body && req.body.tag ? req.body.tag : 'testTag';
  const value = req.body && typeof req.body.value === 'number' ? req.body.value : Math.round(Math.random() * 1000) / 10;
  const ts = Date.now();

  try {
    // Falls Tag noch nicht existiert, wird es eingefügt (INSERT OR IGNORE)
    dbObj.insertTag(tag, `ns=1;s=${tag}`, 'Double');

    // Messung einfügen
    dbObj.insertMeasurement(tag, ts, value);

    return res.json({ ok: true, tag, ts, value });
  } catch (e) {
    console.error('measurements/test error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});