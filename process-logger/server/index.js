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