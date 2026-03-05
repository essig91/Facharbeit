'use strict';
/**
 * server/opcua-logger.js
 *
 * Subscription-based OPC UA logger.
 * - Liest Logpoints aus logpoints.db
 * - Gruppiert nach connectionId
 * - Erstellt je Connection eine OPC UA ClientSubscription
 * - Schreibt empfangene Werte in die measurements-Tabelle in logpoints.db
 *
 * API:
 *   startAll()    – startet alle Subscriptions (einmalig beim Server-Start)
 *   stopAll()     – beendet alle Subscriptions (beim Server-Stop)
 *   restartAll()  – stopAll + startAll (z. B. nach Logpoint-Änderungen)
 */

const path = require('path');
const fs = require('fs');

let opcua;
try {
  opcua = require('node-opcua');
} catch (e) {
  console.warn('opcua-logger: node-opcua nicht verfügbar, Logging deaktiviert');
}

const store = require('../lib/logpoint-store');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'opcua-connections.json');

const RECONNECT_DELAY_MS = 30_000;
const PUBLISHING_INTERVAL_MS = 500;

// connectionId -> { client, session, subscription }
const active = new Map();
const reconnectTimers = new Map();

function readConnectionsConfig() {
  try {
    const txt = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(txt).connections || [];
  } catch (e) {
    console.warn('opcua-logger: Verbindungskonfiguration nicht lesbar:', e.message);
    return [];
  }
}

async function connectAndSubscribe(conn, logpoints) {
  if (!opcua) return;

  const connectionId = String(conn.id);
  const {
    OPCUAClient,
    ClientSubscription,
    ClientMonitoredItem,
    AttributeIds,
    TimestampsToReturn
  } = opcua;

  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 1, initialDelay: 1000, maxDelay: 5000 }
  });

  let session = null;
  let subscription = null;

  try {
    console.log(`opcua-logger: verbinde mit ${conn.endpoint} (connectionId=${connectionId})`);
    await client.connect(conn.endpoint);

    const userIdentity = (conn.authentication && conn.authentication.username)
      ? { userName: conn.authentication.username, password: conn.authentication.password }
      : null;

    session = await client.createSession(userIdentity);
    console.log(`opcua-logger: Session bereit für connectionId=${connectionId}`);

    subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: PUBLISHING_INTERVAL_MS,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 1
    });

    // Warte bis Subscription gestartet ist (max. 5s)
    await new Promise((resolve) => {
      subscription.once('started', resolve);
      setTimeout(resolve, 5000);
    });

    console.log(`opcua-logger: Subscription gestartet für connectionId=${connectionId}`);

    for (const lp of logpoints) {
      const monitoredItem = ClientMonitoredItem.create(
        subscription,
        { nodeId: lp.nodeId, attributeId: AttributeIds.Value },
        {
          samplingInterval: lp.samplingIntervalMs || 1000,
          discardOldest: true,
          queueSize: 10
        },
        TimestampsToReturn.Source
      );

      monitoredItem.on('changed', (dataValue) => {
        try {
          // sourceTimestamp ist der vom OPC UA Server gemeldete Zeitstempel;
          // fehlt er (ältere Server), verwenden wir die lokale Zeit als Fallback.
          const ts = (dataValue.sourceTimestamp)
            ? dataValue.sourceTimestamp.getTime()
            : Date.now();
          const raw = (dataValue.value && dataValue.value.value !== undefined)
            ? dataValue.value.value
            : null;
          const value = (raw === null || raw === undefined) ? null : String(raw);
          const quality = dataValue.statusCode ? dataValue.statusCode.toString() : 'Good';
          store.insertMeasurement(lp.id, ts, value, quality);
        } catch (e) {
          console.error(`opcua-logger: insertMeasurement Fehler für Logpoint ${lp.id} (${lp.nodeId}):`, e.message);
        }
      });

      monitoredItem.on('err', (err) => {
        console.warn(`opcua-logger: MonitoredItem Fehler für ${lp.nodeId}:`, String(err));
      });
    }

    active.set(connectionId, { client, session, subscription });
    console.log(`opcua-logger: ${logpoints.length} Logpoints abonniert für connectionId=${connectionId}`);

    // Bei Session-Verlust automatisch neu verbinden
    session.on('session_closed', () => {
      console.warn(`opcua-logger: Session geschlossen für connectionId=${connectionId}, plane Neuverbindung`);
      active.delete(connectionId);
      scheduleReconnect(conn, logpoints);
    });

  } catch (err) {
    console.error(`opcua-logger: Verbindungsfehler für connectionId=${connectionId}:`, err.message);
    try { if (subscription) await subscription.terminate(); } catch (_) {}
    try { if (session) await session.close(); } catch (_) {}
    try { await client.disconnect(); } catch (_) {}
    scheduleReconnect(conn, logpoints);
  }
}

function scheduleReconnect(conn, logpoints) {
  const connectionId = String(conn.id);
  if (reconnectTimers.has(connectionId)) return; // bereits geplant
  console.log(`opcua-logger: Neuverbindung für connectionId=${connectionId} in ${RECONNECT_DELAY_MS / 1000}s`);
  const t = setTimeout(() => {
    reconnectTimers.delete(connectionId);
    if (!active.has(connectionId)) {
      connectAndSubscribe(conn, logpoints).catch((e) => {
        console.error('opcua-logger: Neuverbindung fehlgeschlagen für', connectionId, e.message);
        scheduleReconnect(conn, logpoints);
      });
    }
  }, RECONNECT_DELAY_MS);
  reconnectTimers.set(connectionId, t);
}

async function stopAll() {
  // Alle Reconnect-Timer abbrechen
  for (const t of reconnectTimers.values()) clearTimeout(t);
  reconnectTimers.clear();

  // Alle aktiven Verbindungen beenden
  for (const [cid, state] of active.entries()) {
    console.log(`opcua-logger: stoppe connectionId=${cid}`);
    try { if (state.subscription) await state.subscription.terminate(); } catch (_) {}
    try { if (state.session) await state.session.close(); } catch (_) {}
    try { if (state.client) await state.client.disconnect(); } catch (_) {}
  }
  active.clear();
}

async function startAll() {
  if (!opcua) {
    console.warn('opcua-logger: node-opcua nicht verfügbar, Logging übersprungen');
    return;
  }

  const connections = readConnectionsConfig();
  const allLogpoints = store.list();

  if (allLogpoints.length === 0) {
    console.log('opcua-logger: Keine Logpoints konfiguriert');
    return;
  }

  // Logpoints nach connectionId gruppieren
  const byConn = new Map();
  for (const lp of allLogpoints) {
    if (!lp.connectionId) continue;
    const cid = String(lp.connectionId);
    if (!byConn.has(cid)) byConn.set(cid, []);
    byConn.get(cid).push(lp);
  }

  for (const conn of connections) {
    const cid = String(conn.id);
    const lps = byConn.get(cid) || [];
    if (lps.length === 0) {
      console.log(`opcua-logger: Keine Logpoints für connectionId=${cid}, übersprungen`);
      continue;
    }
    // Nicht await – jede Connection startet unabhängig
    connectAndSubscribe(conn, lps).catch((e) => {
      console.error(`opcua-logger: Startfehler für connectionId=${cid}:`, e.message);
    });
  }
}

async function restartAll() {
  console.log('opcua-logger: Neustart aller Subscriptions');
  await stopAll();
  await startAll();
}

module.exports = { startAll, stopAll, restartAll };
