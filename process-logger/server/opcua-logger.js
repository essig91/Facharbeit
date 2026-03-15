'use strict';
/**
 * server/opcua-logger.js
 *
 * Subscription-based OPC UA logger.
 * - Liest Logpoints aus logpoints.db
 * - Gruppiert nach connectionId
 * - Erstellt je Connection eine OPC UA ClientSubscription
 * - Schreibt empfangene Werte in data/measurements/<connectionId>.db
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
const measurementStore = require('../lib/measurement-store');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'opcua-connections.json');
const SETTINGS_FILE_PRIMARY = path.resolve('/opt/process-logger/data/settings.json');
const SETTINGS_FILE_FALLBACK = path.join(__dirname, '..', 'data', 'settings.json');

const RECONNECT_DELAY_MS = 30_000;
const PUBLISHING_INTERVAL_MS = 500;
const SNAPSHOT_TICK_MS = 1000;
const DEFAULT_CHANGE_THRESHOLD = 0.1;
const PRUNE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_UNCHANGED_HEARTBEAT_MS = 5 * 60 * 1000;
const SETTINGS_REFRESH_MS = 10_000;

let settingsCacheTs = 0;
let cachedUnchangedHeartbeatMs = DEFAULT_MAX_UNCHANGED_HEARTBEAT_MS;

const SIEMENS_DATE_EPOCH_UTC_MS = Date.UTC(1990, 0, 1);

function formatDurationMs(msValue) {
  const totalMs = Number(msValue);
  if (!Number.isFinite(totalMs)) return String(msValue);

  const abs = Math.abs(totalMs);
  const sign = totalMs < 0 ? '-' : '';

  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;

  if (abs % 3600000 === 0) {
    return `${sign}${abs / 3600000}h`;
  }
  if (abs % 60000 === 0) {
    return `${sign}${abs / 60000}m`;
  }
  if (abs % 1000 === 0) {
    return `${sign}${abs / 1000}s`;
  }

  return `${sign}${(abs / 1000).toFixed(3).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')}s`;
}

function formatSiemensDate(daysSince1990) {
  const days = Number(daysSince1990);
  if (!Number.isFinite(days)) return String(daysSince1990);

  const ts = SIEMENS_DATE_EPOCH_UTC_MS + Math.round(days) * 24 * 60 * 60 * 1000;
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Formatiert einen Rohwert gemäß der Logpoint-Konfiguration.
 *
 * Regeln:
 *  - null/undefined  → null (kein Wert)
 *  - isAlarm=true    → String-Darstellung ohne Rundung (Alarm-Zustand)
 *  - dataType Boolean → String-Darstellung ohne Rundung
 *  - Numerischer Wert → auf lp.decimals Nachkommastellen gerundet
 *  - Alles andere    → String-Darstellung unverändert
 *
 * @param {object} lp          Logpoint-Konfiguration
 * @param {*}      rawValue    Rohwert vom OPC UA Server
 * @returns {string|null}
 */
function formatValue(lp, rawValue) {
  if (rawValue === null || rawValue === undefined) return null;

  const dt = (lp.dataType || '').toLowerCase();

  // Alarm-Logpoints und boolesche Typen: keine Rundung
  if (lp.isAlarm || dt === 'boolean') {
    return String(rawValue);
  }

  // Time-Werte (ms) lesbar ausgeben, z. B. 500ms, 30s, 5m
  if (dt === 'time') {
    return formatDurationMs(rawValue);
  }

  // Date-Werte als YYYY-MM-DD (S7 DATE: Tage seit 1990-01-01)
  if (dt === 'date') {
    return formatSiemensDate(rawValue);
  }

  // Numerischer Wert: auf konfigurierte Dezimalstellen runden
  const num = Number(rawValue);
  if (!isNaN(num)) {
    if (dt === 'real') {
      const decimals = (lp.decimals !== undefined && lp.decimals !== null)
        ? Number(lp.decimals)
        : 2;
      return num.toFixed(Number.isFinite(decimals) ? decimals : 2);
    }

    const decimals = (lp.decimals !== undefined && lp.decimals !== null)
      ? Number(lp.decimals)
      : 2;
    return String(num.toFixed(Number.isFinite(decimals) ? decimals : 2));
  }

  // Nicht-numerisch (z. B. String, Datum): unverändert als String speichern
  return String(rawValue);
}

// connectionId -> { client, session, subscription }
const active = new Map();
const reconnectTimers = new Map();

function clearSnapshotTimer(state) {
  if (state && state.snapshotTimer) {
    clearInterval(state.snapshotTimer);
    state.snapshotTimer = null;
  }
}

function normalizeThreshold(lp) {
  const n = Number(lp && lp.changeThreshold);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CHANGE_THRESHOLD;
  return n;
}

function isNumericValue(v) {
  return Number.isFinite(Number(v));
}

function isThresholdRelevantDataType(lp) {
  const dt = String((lp && lp.dataType) || '').toLowerCase();
  if (!dt) return true;
  if (dt === 'boolean' || dt === 'string' || dt === 'date') return false;
  return true;
}

function hasMeaningfulChange(lp, prevRaw, nextRaw) {
  if (prevRaw === undefined) return true;
  if (prevRaw === null || nextRaw === null || prevRaw === undefined || nextRaw === undefined) {
    return prevRaw !== nextRaw;
  }

  if (isNumericValue(prevRaw) && isNumericValue(nextRaw) && isThresholdRelevantDataType(lp)) {
    const delta = Math.abs(Number(nextRaw) - Number(prevRaw));
    const thr = normalizeThreshold(lp);
    return delta >= thr;
  }

  return String(prevRaw) !== String(nextRaw);
}

function readSettingsFromDisk() {
  const candidates = [SETTINGS_FILE_PRIMARY, SETTINGS_FILE_FALLBACK];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const txt = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(txt) || {};
    } catch (_) {
      // Ignore and try next candidate.
    }
  }
  return {};
}

function getMaxUnchangedHeartbeatMs() {
  const now = Date.now();
  if (now - settingsCacheTs < SETTINGS_REFRESH_MS) return cachedUnchangedHeartbeatMs;

  const settings = readSettingsFromDisk();
  const rawMinutes = Number(settings && settings.logger && settings.logger.unchangedHeartbeatMinutes);
  if (Number.isFinite(rawMinutes)) {
    const clampedMinutes = Math.max(1, Math.min(1440, rawMinutes));
    cachedUnchangedHeartbeatMs = clampedMinutes * 60 * 1000;
  } else {
    cachedUnchangedHeartbeatMs = DEFAULT_MAX_UNCHANGED_HEARTBEAT_MS;
  }
  settingsCacheTs = now;
  return cachedUnchangedHeartbeatMs;
}

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
    TimestampsToReturn,
    DataChangeFilter,
    DataChangeTrigger,
    DeadbandType
  } = opcua;

  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 1, initialDelay: 1000, maxDelay: 5000 }
  });

  let session = null;
  let subscription = null;
  const snapshotsByLogpoint = new Map();

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
      const lpId = Number(lp.id);
      if (!Number.isInteger(lpId) || lpId <= 0) continue;
      const cycleMs = Math.max(1000, Number(lp.samplingIntervalMs) || 1000);
      snapshotsByLogpoint.set(lpId, {
        lpId,
        lp,
        nodeId: String(lp.nodeId || ''),
        rawValue: undefined,
        lastStoredRaw: undefined,
        value: undefined,
        lastWriteTs: 0,
        cycleMs,
        lastPruneTs: 0
      });

      const monitoredItem = ClientMonitoredItem.create(
        subscription,
        { nodeId: lp.nodeId, attributeId: AttributeIds.Value },
        {
          samplingInterval: lp.samplingIntervalMs || 1000,
          discardOldest: true,
          queueSize: 10,
          filter: new DataChangeFilter({
            trigger: DataChangeTrigger.StatusValueTimestamp,
            deadbandType: DeadbandType.None,
            deadbandValue: 0
          })
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
          // Wert gemäß Logpoint-Konfiguration formatieren (Dezimalstellen, Alarm, Datentyp)
          const value = formatValue(lp, raw);

          const snap = snapshotsByLogpoint.get(lpId);
          const changedEnough = !snap || hasMeaningfulChange(lp, snap.lastStoredRaw, raw);

          if (changedEnough) {
            measurementStore.insert(connectionId, lp.id, ts, value);
            if (snap) {
              // Fuer die Snapshot-Taktung auf lokale Zeit gehen,
              // damit grobe sourceTimestamp-Aufloesung keine Doppelpunkte erzeugt.
              snap.lastWriteTs = Date.now();
              snap.lastStoredRaw = raw;
            }
          }

          if (snap) {
            snap.rawValue = raw;
            snap.value = value;
          }
        } catch (e) {
          console.error(`opcua-logger: insert Fehler für Logpoint ${lp.id} (${lp.nodeId}):`, e.message);
        }
      });

      monitoredItem.on('err', (err) => {
        console.warn(`opcua-logger: MonitoredItem Fehler für ${lp.nodeId}:`, String(err));
      });
    }

    const state = { client, session, subscription, snapshotsByLogpoint, snapshotTimer: null };
    state.snapshotTimer = setInterval(() => {
      const now = Date.now();
      for (const snap of snapshotsByLogpoint.values()) {
        if (snap.value === undefined) continue;
        if (now - snap.lastWriteTs < snap.cycleMs) continue;
        try {
          const thresholdDominates = isThresholdRelevantDataType(snap.lp) && isNumericValue(snap.rawValue);
          const changedEnough = hasMeaningfulChange(snap.lp, snap.lastStoredRaw, snap.rawValue);
          const staleEnough = (now - snap.lastWriteTs) >= getMaxUnchangedHeartbeatMs();

          if (!thresholdDominates || changedEnough || staleEnough) {
            measurementStore.insert(connectionId, snap.lpId, now, snap.value);
            snap.lastWriteTs = now;
            snap.lastStoredRaw = snap.rawValue;
          }

          // Intervall bleibt konstant; nur redundante Zwischenpunkte bei unverändertem Wert werden entfernt.
          if (now - snap.lastPruneTs >= PRUNE_INTERVAL_MS) {
            measurementStore.pruneUnchangedCurrentMonth(connectionId, snap.lpId);
            snap.lastPruneTs = now;
          }
        } catch (e) {
          console.error(`opcua-logger: Snapshot-Insert Fehler für Logpoint ${snap.lpId} (${snap.nodeId}):`, e.message);
        }
      }
    }, SNAPSHOT_TICK_MS);

    active.set(connectionId, state);
    console.log(`opcua-logger: ${logpoints.length} Logpoints abonniert für connectionId=${connectionId}`);

    // Bei Session-Verlust automatisch neu verbinden
    session.on('session_closed', () => {
      console.warn(`opcua-logger: Session geschlossen für connectionId=${connectionId}, plane Neuverbindung`);
      const current = active.get(connectionId);
      clearSnapshotTimer(current);
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
    clearSnapshotTimer(state);
    try { if (state.subscription) await state.subscription.terminate(); } catch (_) {}
    try { if (state.session) await state.session.close(); } catch (_) {}
    try { if (state.client) await state.client.disconnect(); } catch (_) {}
  }
  active.clear();

  // Messwert-DBs schließen
  measurementStore.closeAll();
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

function getRuntimeSnapshot() {
  const activeConnections = [];
  for (const [connectionId, state] of active.entries()) {
    activeConnections.push({
      connectionId: String(connectionId),
      connected: true,
      reconnectScheduled: false,
      monitoredLogpoints: Number(state && state.snapshotsByLogpoint && state.snapshotsByLogpoint.size) || 0
    });
  }

  const reconnectingConnections = [];
  for (const connectionId of reconnectTimers.keys()) {
    reconnectingConnections.push(String(connectionId));
  }

  return {
    activeConnections,
    reconnectingConnections,
    activeCount: activeConnections.length,
    reconnectingCount: reconnectingConnections.length,
    hasOpcUa: !!opcua
  };
}

module.exports = { startAll, stopAll, restartAll, getRuntimeSnapshot };
