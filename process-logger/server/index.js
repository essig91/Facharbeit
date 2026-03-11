'use strict';
/*
  server/index.js
  Main Express bootstrap for process-logger
  - mounts API routers under /api/opcua
  - ensures the readValue router (opcua-read.js) is mounted so frontend calls to /api/opcua/readValue work
  - starts OPC UA subscription-based logger (opcua-logger.js)
*/

const express = require('express');
const path = require('path');
require('dotenv').config();

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

// Settings API (GET/PUT /api/settings)
const settingsApi = require('./settings');
app.use('/api/settings', settingsApi);

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

// OPC UA Logger laden
const opcuaLogger = require('./opcua-logger');

const server = app.listen(PORT, () => {
  console.log(`process-logger listening on http://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  opcuaLogger.stopAll().finally(() => {
    server.close(() => process.exit(0));
  });
});

// OPC UA Logger starten (nach Server-Start, damit API-Routen bereits verfügbar sind)
server.once('listening', () => {
  opcuaLogger.startAll().catch((err) => {
    console.error('opcua-logger: Startfehler:', err && err.message ? err.message : err);
  });
});

// Logger global verfügbar machen (für Routen-Trigger nach Logpoint-Änderungen)
global.__opcuaLogger = opcuaLogger;