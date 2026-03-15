'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const router = express.Router();

const storageMonitor = require('./storage-monitor');
const logpointStore = require('../lib/logpoint-store');
const measurementStore = require('../lib/measurement-store');
const disturbanceStore = require('../lib/disturbance-store');
const opcuaLogger = require('./opcua-logger');

const CONNECTIONS_CONFIG_PATH = path.join(__dirname, '..', 'config', 'opcua-connections.json');
const OPCUA_TEST_SCRIPT = '/opt/process-logger/scripts/opcua-session-test.js';
const OPCUA_TEST_NODE = fs.existsSync('/usr/bin/node') ? '/usr/bin/node' : (process.execPath || 'node');

function readConnectionsConfig() {
  try {
    const txt = fs.readFileSync(CONNECTIONS_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed && parsed.connections) ? parsed.connections : [];
  } catch (_) {
    return [];
  }
}

function mapConnectionStatusRow(conn, logpointsByConnection, runtimeByConnection, reconnectingSet) {
  const id = String((conn && conn.id) || '');
  const runtime = runtimeByConnection.get(id) || null;
  const logpointCount = Number(logpointsByConnection.get(id) || 0);
  const datapointsCount = (typeof measurementStore.countConnectionTotal === 'function')
    ? Number(measurementStore.countConnectionTotal(id) || 0)
    : 0;

  let status = 'offline';
  if (runtime && runtime.connected) status = 'online';
  else if (reconnectingSet.has(id)) status = 'reconnecting';

  const monitoredLogpoints = Number((runtime && runtime.monitoredLogpoints) || 0);
  let subscriptionDiagnostic = 'ok';
  if (!runtime && logpointCount > 0) subscriptionDiagnostic = 'runtime_missing_for_connection';
  else if (runtime && monitoredLogpoints === 0 && logpointCount > 0) subscriptionDiagnostic = 'runtime_zero_subscriptions';
  else if (runtime && monitoredLogpoints > 0) subscriptionDiagnostic = 'runtime_reports_subscriptions';

  return {
    id,
    name: String((conn && conn.name) || id),
    endpoint: String((conn && conn.endpoint) || ''),
    status,
    endpointReachable: null,
    monitoredLogpoints,
    logpointCount,
    datapointsCount,
    subscriptionDiagnostic
  };
}

function runNodeScript(scriptPath, args = [], timeoutMs = 4000) {
  return new Promise((resolve) => {
    const proc = spawn(OPCUA_TEST_NODE, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(to);
      resolve({ ok: code === 0 && !timedOut, code, timedOut });
    });

    proc.on('error', () => {
      clearTimeout(to);
      resolve({ ok: false, code: 255, timedOut });
    });
  });
}

async function testConnectionStatus(conn, timeoutMs = 4000) {
  const endpoint = String((conn && conn.endpoint) || '').trim();
  if (!endpoint) return false;

  const auth = (conn && conn.authentication && typeof conn.authentication === 'object')
    ? conn.authentication
    : {};
  const username = String(auth.username || '');
  const password = String(auth.password || '');
  const securityPolicy = String((conn && conn.securityPolicy) || 'None');

  const args = [endpoint];
  if (username) args.push(username);
  if (password) args.push(password);
  if (securityPolicy) args.push(securityPolicy);

  const result = await runNodeScript(OPCUA_TEST_SCRIPT, args, timeoutMs);
  return !!(result && result.ok);
}

async function mapConnectionStatusRowWithReachability(conn, logpointsByConnection, runtimeByConnection, reconnectingSet) {
  const base = mapConnectionStatusRow(conn, logpointsByConnection, runtimeByConnection, reconnectingSet);
  const reachable = await testConnectionStatus(conn, 4000);
  // Hauptstatus bleibt runtime-basiert; Reachability wird als Zusatzsignal geliefert.
  base.endpointReachable = !!reachable;
  return base;
}

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

router.get('/system-overview', (_req, res) => {
  try {
    const storage = storageMonitor.getStatusSnapshot() || null;
    const loggerRuntime = (typeof opcuaLogger.getRuntimeSnapshot === 'function')
      ? (opcuaLogger.getRuntimeSnapshot() || {})
      : {};

    const connections = readConnectionsConfig();
    const logpoints = Array.isArray(logpointStore.list()) ? logpointStore.list() : [];
    const recentEvents = disturbanceStore.listEvents({ limit: 8 }) || [];

    const logpointsByConnection = new Map();
    for (const lp of logpoints) {
      const cid = String((lp && lp.connectionId) || '');
      if (!cid) continue;
      logpointsByConnection.set(cid, Number(logpointsByConnection.get(cid) || 0) + 1);
    }

    const runtimeByConnection = new Map();
    const activeConnections = Array.isArray(loggerRuntime.activeConnections)
      ? loggerRuntime.activeConnections
      : [];
    for (const row of activeConnections) {
      const cid = String((row && row.connectionId) || '');
      if (!cid) continue;
      runtimeByConnection.set(cid, row);
    }

    const reconnectingSet = new Set(
      Array.isArray(loggerRuntime.reconnectingConnections)
        ? loggerRuntime.reconnectingConnections.map((x) => String(x || ''))
        : []
    );

    const mapWithProbe = async () => {
      const out = [];
      const queue = connections.slice();
      const concurrency = 2;

      const worker = async () => {
        while (queue.length) {
          const conn = queue.shift();
          const row = await mapConnectionStatusRowWithReachability(conn, logpointsByConnection, runtimeByConnection, reconnectingSet);
          out.push(row);
        }
      };

      const workers = [];
      for (let i = 0; i < concurrency; i++) workers.push(worker());
      await Promise.all(workers);
      return out;
    };

    return mapWithProbe().then((connectionStatus) => {
      const totals = {
        connections: connectionStatus.length,
        logpoints: logpoints.length,
        datapoints: connectionStatus.reduce((sum, row) => sum + Number(row.datapointsCount || 0), 0),
        activeConnections: connectionStatus.filter((row) => String(row.status || '').toLowerCase() === 'online').length,
        reconnectingConnections: connectionStatus.filter((row) => String(row.status || '').toLowerCase() === 'reconnecting').length
      };

      const loggerRuntimeSummary = {
        hasRuntimeSnapshot: typeof opcuaLogger.getRuntimeSnapshot === 'function',
        hasOpcUa: !!loggerRuntime.hasOpcUa,
        activeCount: Number(loggerRuntime.activeCount || 0),
        reconnectingCount: Number(loggerRuntime.reconnectingCount || 0),
        activeConnectionIds: Array.isArray(loggerRuntime.activeConnections)
          ? loggerRuntime.activeConnections.map((x) => String((x && x.connectionId) || ''))
          : []
      };

      return res.json({
        ok: true,
        timestamp: Date.now(),
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
        platform: process.platform,
        loggerRuntimeSummary,
        storage,
        totals,
        connections: connectionStatus,
        recentEvents
      });
    }).catch((err) => {
      return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

module.exports = router;
