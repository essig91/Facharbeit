'use strict';
/**
 * server/opcua-subscription-manager.js
 *
 * Verwaltet OPC UA Subscriptions für alle konfigurierten Logpoints.
 * Pro Verbindungs-Endpoint wird eine Subscription geöffnet; alle Logpoints
 * dieser Verbindung werden als MonitoredItems hinzugefügt.
 *
 * Beim Empfang von Wertänderungen werden die Messwerte direkt in die
 * Datenbank (database.db) geschrieben.
 */

const {
  OPCUAClient,
  AttributeIds,
  ClientSubscription,
  TimestampsToReturn,
  SecurityPolicy,
  MessageSecurityMode
} = require('node-opcua');
const http = require('http');
const logpointStore = require('../lib/logpoint-store');

function policyFromArg(p) {
  if (!p) return SecurityPolicy.None;
  const s = String(p);
  if (/none/i.test(s)) return SecurityPolicy.None;
  if (/basic256sha256/i.test(s)) return SecurityPolicy.Basic256Sha256;
  if (/basic256/i.test(s)) return SecurityPolicy.Basic256;
  if (/basic128/i.test(s)) return SecurityPolicy.Basic128Rsa15;
  return SecurityPolicy.None;
}

function fetchLocalConnections() {
  return new Promise((resolve) => {
    const port = process.env.PORT || 3000;
    const opts = {
      hostname: '127.0.0.1',
      port,
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
        } catch (_) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

// Map<endpoint, { client, session, subscription, monitoredItems: Map<logpointId, monitoredItem> }>
const SUBS = new Map();

const SYNC_INTERVAL_MS = 30_000; // re-sync every 30 s to pick up added/removed logpoints

let dbObj = null;
let syncTimer = null;

function coerceToNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

async function teardownEndpoint(endpoint) {
  const state = SUBS.get(endpoint);
  if (!state) return;
  SUBS.delete(endpoint);
  try { if (state.subscription) await state.subscription.terminate(); } catch (_) {}
  try { if (state.session) await state.session.close(); } catch (_) {}
  try { if (state.client) await state.client.disconnect(); } catch (_) {}
}

async function setupSubscriptionForEndpoint(conn, logpoints) {
  const endpoint = conn.endpoint;

  await teardownEndpoint(endpoint);

  if (!logpoints || logpoints.length === 0) return;

  const isNone = String(conn.securityPolicy || 'None').toLowerCase() === 'none';
  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 5, initialDelay: 1000, maxDelay: 30000 },
    securityPolicy: policyFromArg(conn.securityPolicy),
    securityMode: isNone ? MessageSecurityMode.None : MessageSecurityMode.SignAndEncrypt
  });

  try {
    await client.connect(endpoint);

    const user = conn.authentication && conn.authentication.username
      ? { userName: conn.authentication.username, password: conn.authentication.password || '' }
      : null;
    const session = await client.createSession(user);

    // Use the fastest requested sampling interval as the publishing interval
    const samplingIntervals = logpoints.map(lp => Math.max(Number(lp.samplingIntervalMs) || 1000, 100));
    const publishingInterval = Math.max(Math.min(...samplingIntervals), 100);

    const subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: publishingInterval,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 1
    });

    // Wait for the subscription to be fully started before adding items
    await new Promise((resolve) => {
      subscription.once('started', resolve);
      subscription.once('internal_error', resolve);
    });

    const monitoredItems = new Map();
    for (const lp of logpoints) {
      const samplingInterval = Math.max(Number(lp.samplingIntervalMs) || 1000, 100);
      try {
        const monitoredItem = await subscription.monitor(
          { nodeId: lp.nodeId, attributeId: AttributeIds.Value },
          { samplingInterval, queueSize: 1, discardOldest: true },
          TimestampsToReturn.Source
        );

        monitoredItem.on('changed', (dataValue) => {
          if (!dbObj) return;
          try {
            const raw = (dataValue && dataValue.value) ? dataValue.value.value : null;
            const v = coerceToNumber(raw);
            if (v === null) return;
            const ts = (dataValue.sourceTimestamp instanceof Date)
              ? dataValue.sourceTimestamp.getTime()
              : Date.now();
            dbObj.insertTag(lp.id, lp.nodeId, lp.dataType || '');
            dbObj.insertMeasurement(lp.id, ts, v);
          } catch (_) {}
        });

        monitoredItems.set(lp.id, monitoredItem);
      } catch (e) {
        console.warn(`subscription-manager: could not monitor ${lp.nodeId} on ${endpoint}: ${e && e.message}`);
      }
    }

    SUBS.set(endpoint, { client, session, subscription, monitoredItems });

    subscription.on('terminated', () => {
      console.warn(`subscription-manager: subscription terminated for ${endpoint}, will re-establish`);
      SUBS.delete(endpoint);
      // Re-establish after a short delay
      setTimeout(() => syncSubscriptions().catch(() => {}), 5000);
    });

    console.log(`subscription-manager: ${monitoredItems.size}/${logpoints.length} items monitored on ${endpoint}`);
  } catch (e) {
    console.error(`subscription-manager: failed to set up subscription for ${endpoint}:`, e && e.message ? e.message : e);
    try { await client.disconnect(); } catch (_) {}
  }
}

async function syncSubscriptions() {
  if (!dbObj) return;

  let allLogpoints = [];
  try { allLogpoints = logpointStore.list(); } catch (_) { return; }

  let conns = [];
  try { conns = await fetchLocalConnections(); } catch (_) {}

  // Group logpoints by connection endpoint
  const byEndpoint = new Map(); // endpoint -> { conn, logpoints[] }
  for (const lp of allLogpoints) {
    const conn = conns.find(c => String(c.id) === String(lp.connectionId));
    if (!conn || !conn.endpoint) continue;
    if (!byEndpoint.has(conn.endpoint)) {
      byEndpoint.set(conn.endpoint, { conn, logpoints: [] });
    }
    byEndpoint.get(conn.endpoint).logpoints.push(lp);
  }

  // Tear down subscriptions for endpoints no longer in use
  for (const endpoint of Array.from(SUBS.keys())) {
    if (!byEndpoint.has(endpoint)) {
      await teardownEndpoint(endpoint);
    }
  }

  // Set up or re-sync subscriptions for active endpoints
  for (const [endpoint, { conn, logpoints }] of byEndpoint) {
    const existing = SUBS.get(endpoint);
    if (!existing) {
      await setupSubscriptionForEndpoint(conn, logpoints);
    } else {
      // Re-build if the set of logpoints has changed
      const currentIds = new Set(existing.monitoredItems.keys());
      const desiredIds = new Set(logpoints.map(lp => lp.id));
      const needsRebuild = logpoints.some(lp => !currentIds.has(lp.id))
        || [...currentIds].some(id => !desiredIds.has(id));
      if (needsRebuild) {
        await setupSubscriptionForEndpoint(conn, logpoints);
      }
    }
  }
}

function start(db) {
  dbObj = db;
  // Delay the initial sync slightly so the HTTP server is ready
  setTimeout(() => syncSubscriptions().catch(e =>
    console.error('subscription-manager: initial sync error:', e && e.message ? e.message : e)
  ), 2000);
  // Re-sync every 30 s to pick up added/removed logpoints
  syncTimer = setInterval(() => syncSubscriptions().catch(() => {}), SYNC_INTERVAL_MS);
}

async function stop() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  for (const endpoint of Array.from(SUBS.keys())) {
    await teardownEndpoint(endpoint);
  }
}

module.exports = { start, stop };
