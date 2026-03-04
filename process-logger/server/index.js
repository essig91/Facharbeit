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

// test-push router (push measurement samples to writer)
const testPushRouter = require('../routes/test-push');
app.use('/api/opcua', testPushRouter);

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

  // Initialize writer-manager after server is ready to accept HTTP requests
  const writerManager = require('../lib/writer-manager');
  writerManager.initFromServer({
    port: PORT,
    dataDir: path.join(process.cwd(), 'data', 'measurements')
  })
    .then(() => {
      console.log('writer-manager initialized');

      // --- Start logpoint scheduler integration (Polling) ---
      // Requires: lib/logpoint-scheduler.js and lib/logpoint-store.js
      try {
        const createScheduler = require('../lib/logpoint-scheduler');
        const logpointStore = require('../lib/logpoint-store');
        const http = require('http');

        function createLocalReadValueCaller(port) {
          return async function readValue(connectionId, nodeId) {
            const postData = JSON.stringify({ connectionId: String(connectionId), nodeId: String(nodeId) });
            const opts = {
              hostname: '127.0.0.1',
              port: Number(port || process.env.PORT || 3000),
              path: '/api/opcua/readValue',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
              },
              timeout: 8000
            };
            return new Promise((resolve, reject) => {
              const req = http.request(opts, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                  try {
                    const json = JSON.parse(data || '{}');
                    if (res.statusCode >= 400) return reject(new Error('readValue HTTP ' + res.statusCode + ' ' + (json && json.error ? json.error : '')));
                    resolve(json);
                  } catch (e) { reject(e); }
                });
              });
              req.on('error', reject);
              req.on('timeout', () => { req.destroy(new Error('timeout')); });
              req.write(postData);
              req.end();
            });
          };
        }

        const localPort = PORT;
        const readValue = createLocalReadValueCaller(localPort);

        const scheduler = createScheduler({
          getLogpoints: async () => {
            // logpoint-store exports list()
            return logpointStore.list();
          },
          readValue,
          writerManager
        });

        // Start scheduler (reload config every 60s)
        scheduler.start(60000).catch(err => console.error('logpoint-scheduler start failed', err));

        // store scheduler for graceful shutdown
        if (!app.locals) app.locals = {};
        app.locals.logpointScheduler = scheduler;

        console.log('logpoint-scheduler started');
      } catch (e) {
        console.error('Failed to start logpoint-scheduler:', e && e.message ? e.message : e);
      }
      // --- End scheduler integration ---
    })
    .catch(err => console.warn('writer-manager init error', err));
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down...');
  try {
    if (app.locals && app.locals.logpointScheduler) {
      try { await app.locals.logpointScheduler.stop(); } catch (e) { console.warn('Error stopping scheduler', e); }
    }
  } catch (e) {
    console.warn('Error during scheduler shutdown', e);
  }
  try {
    const writerManager = require('../lib/writer-manager');
    await writerManager.closeAll();
  } catch (e) {
    console.error('Error closing writers', e);
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
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// init DB direkt beim Start
try {
  dbObj = initDb(dbPath);
  console.log('Database initialized at', dbPath);
} catch (err) {
  console.error('Failed to initialize DB:', err);
  // Falls DB nicht initialisiert werden kann, Prozess beeenden
  process.exit(1);
}

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