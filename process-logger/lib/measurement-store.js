'use strict';
/**
 * lib/measurement-store.js
 *
 * Verwaltung der Messwert-Datenbanken in data/measurements/.
 * Für jede connectionId wird pro Monat eine eigene SQLite-DB angelegt:
 *   <dataDir>/measurements/<connectionId>-YYYY-MM.db
 *
 * Rückwärtskompatibilität:
 * - Alte Einzel-DBs (<connectionId>.db) werden bei Queries weiterhin mitgelesen,
 *   falls vorhanden.
 *
 * API:
 *   insert(connectionId, logpointId, ts, value)
 *   query(connectionId, logpointId, fromTs, toTs, limit)
 *   queryAll(connectionId, fromTs, toTs, limit)
 *   closeAll()
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.PROCESS_LOGGER_DATA_DIR || '/opt/process-logger/data';
const measurementsDir = path.join(dataDir, 'measurements');
const SETTINGS_PATH = path.join(dataDir, 'settings.json');
const DEFAULT_PRUNE_ANCHOR_MS = 10 * 60 * 1000;

let pruneAnchorCache = { ms: DEFAULT_PRUNE_ANCHOR_MS, at: 0 };

function getPruneAnchorMs() {
  const now = Date.now();
  if (now - pruneAnchorCache.at < 10_000) return pruneAnchorCache.ms;

  let out = DEFAULT_PRUNE_ANCHOR_MS;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const minutes = Number(parsed && parsed.logger && parsed.logger.pruneAnchorMinutes);
    if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) {
      out = Math.round(minutes * 60 * 1000);
    }
  } catch (_) {
    // keep default when settings are missing or invalid
  }

  pruneAnchorCache = { ms: out, at: now };
  return out;
}

// Geöffnete DB-Instanzen je DB-Pfad
const openDbs = new Map();

function ensureMeasurementsDir() {
  if (!fs.existsSync(measurementsDir)) {
    fs.mkdirSync(measurementsDir, { recursive: true, mode: 0o700 });
  }
}

function monthKeyFromTs(ts) {
  const d = new Date(Number(ts) || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function buildMonthlyDbPath(connectionId, monthKey) {
  return path.join(measurementsDir, `${connectionId}-${monthKey}.db`);
}

function buildLegacyDbPath(connectionId) {
  return path.join(measurementsDir, `${connectionId}.db`);
}

function openDbAtPath(dbPath, createIfMissing) {
  if (!createIfMissing && !fs.existsSync(dbPath)) return null;
  if (openDbs.has(dbPath)) return openDbs.get(dbPath);

  ensureMeasurementsDir();
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logpoint_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_measurements_logpoint_ts ON measurements(logpoint_id, ts);
  `);

  openDbs.set(dbPath, db);
  return db;
}

function openDbForInsert(connectionId, ts) {
  const monthKey = monthKeyFromTs(ts);
  const dbPath = buildMonthlyDbPath(connectionId, monthKey);
  return openDbAtPath(dbPath, true);
}

function listMonthKeysInRange(fromTs, toTs) {
  const start = new Date(Number(fromTs));
  const end = new Date(Number(toTs));
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];

  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const out = [];

  while (cur <= last) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    out.push(`${y}-${m}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

function openDbCandidatesForQuery(connectionId, fromTs, toTs) {
  const dbs = [];
  const seen = new Set();

  const monthKeys = listMonthKeysInRange(fromTs, toTs);
  for (const mk of monthKeys) {
    const monthlyPath = buildMonthlyDbPath(connectionId, mk);
    if (seen.has(monthlyPath)) continue;
    seen.add(monthlyPath);
    const monthlyDb = openDbAtPath(monthlyPath, false);
    if (monthlyDb) dbs.push(monthlyDb);
  }

  // Legacy Einzel-DB optional mitlesen
  const legacyPath = buildLegacyDbPath(connectionId);
  if (!seen.has(legacyPath)) {
    const legacyDb = openDbAtPath(legacyPath, false);
    if (legacyDb) dbs.push(legacyDb);
  }

  return dbs;
}

function openAllDbCandidatesForConnection(connectionId) {
  const cid = String(connectionId || '');
  if (!cid) return [];

  const dbs = [];
  const seen = new Set();

  if (fs.existsSync(measurementsDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(measurementsDir, { withFileTypes: true });
    } catch (_) {
      entries = [];
    }

    for (const ent of entries) {
      if (!ent || !ent.isFile()) continue;
      if (!/\.db$/i.test(ent.name)) continue;
      if (/\.db-(wal|shm)$/i.test(ent.name)) continue;
      if (!(ent.name === `${cid}.db` || ent.name.startsWith(`${cid}-`))) continue;

      const dbPath = path.join(measurementsDir, ent.name);
      if (seen.has(dbPath)) continue;
      seen.add(dbPath);

      const db = openDbAtPath(dbPath, false);
      if (db) dbs.push(db);
    }
  }

  const legacyPath = buildLegacyDbPath(cid);
  if (!seen.has(legacyPath)) {
    const legacyDb = openDbAtPath(legacyPath, false);
    if (legacyDb) dbs.push(legacyDb);
  }

  return dbs;
}

function uniqueRowsByIdentity(rowsAsc) {
  const seen = new Set();
  const out = [];
  for (const row of rowsAsc) {
    const key = `${row.logpoint_id || ''}|${row.ts}|${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function sampleRowsAcrossRange(rowsAsc, target) {
  if (!Array.isArray(rowsAsc)) return [];
  const n = rowsAsc.length;
  if (n <= target) return rowsAsc.slice();
  if (target <= 1) return [rowsAsc[n - 1]];
  if (target <= 2) return [rowsAsc[0], rowsAsc[n - 1]];

  const middle = rowsAsc.slice(1, n - 1);
  const pairBuckets = Math.max(1, Math.floor((target - 2) / 2));
  const bucketSize = middle.length / pairBuckets;
  const picked = [rowsAsc[0]];

  for (let i = 0; i < pairBuckets; i++) {
    const start = Math.floor(i * bucketSize);
    const rawEnd = Math.floor((i + 1) * bucketSize);
    const end = Math.max(start + 1, Math.min(middle.length, rawEnd));
    const bucket = middle.slice(start, end);
    if (!bucket.length) continue;

    const numeric = [];
    for (let b = 0; b < bucket.length; b++) {
      const num = Number(bucket[b].value);
      if (Number.isFinite(num)) numeric.push({ idx: b, value: num });
    }

    if (numeric.length >= 2) {
      let minIdx = numeric[0].idx;
      let maxIdx = numeric[0].idx;
      let minVal = numeric[0].value;
      let maxVal = numeric[0].value;
      for (const cand of numeric) {
        if (cand.value < minVal) {
          minVal = cand.value;
          minIdx = cand.idx;
        }
        if (cand.value > maxVal) {
          maxVal = cand.value;
          maxIdx = cand.idx;
        }
      }

      if (minIdx === maxIdx) {
        picked.push(bucket[minIdx]);
      } else {
        const firstIdx = Math.min(minIdx, maxIdx);
        const secondIdx = Math.max(minIdx, maxIdx);
        picked.push(bucket[firstIdx], bucket[secondIdx]);
      }
    } else {
      picked.push(bucket[0]);
      if (bucket.length > 1) picked.push(bucket[bucket.length - 1]);
    }
  }

  picked.push(rowsAsc[n - 1]);
  let out = uniqueRowsByIdentity(picked.sort((a, b) => Number(a.ts) - Number(b.ts)));

  if (out.length > target) {
    const keep = [out[0]];
    const inner = out.slice(1, out.length - 1);
    const wantedInner = Math.max(0, target - 2);
    if (wantedInner > 0 && inner.length > 0) {
      const step = inner.length / wantedInner;
      for (let i = 0; i < wantedInner; i++) {
        const idx = Math.min(inner.length - 1, Math.floor(i * step));
        keep.push(inner[idx]);
      }
    }
    keep.push(out[out.length - 1]);
    out = uniqueRowsByIdentity(keep.sort((a, b) => Number(a.ts) - Number(b.ts)));
  }

  return out;
}

module.exports = {
  /**
   * Einen Messwert einfügen.
   * @param {string} connectionId
   * @param {number|string} logpointId
   * @param {number} ts  Unix-Millisekunden
   * @param {*}      value
   */
  insert(connectionId, logpointId, ts, value) {
    const db = openDbForInsert(String(connectionId), ts);
    const numericLogpointId = Number(logpointId);
    if (!Number.isInteger(numericLogpointId) || numericLogpointId <= 0) {
      throw new Error(`invalid logpoint_id: ${logpointId}`);
    }
    const valStr = (value === null || value === undefined) ? null : String(value);
    db.prepare(
      'INSERT INTO measurements(logpoint_id, ts, value) VALUES (?, ?, ?)'
    ).run(numericLogpointId, ts, valStr);
  },

  /**
   * Messwerte für einen Logpoint abfragen.
   * @param {string} connectionId
  * @param {number|string} logpointId
   * @param {number} fromTs
   * @param {number} toTs
   * @param {number} limit
   * @returns {Array}
   */
  query(connectionId, logpointId, fromTs, toTs, limit) {
    const lim = Number(limit) || 1000;
    const numericLogpointId = Number(logpointId);
    if (!Number.isInteger(numericLogpointId) || numericLogpointId <= 0) return [];
    const dbs = openDbCandidatesForQuery(String(connectionId), fromTs, toTs);
    if (dbs.length === 0) return [];

    const rows = [];
    for (const db of dbs) {
      const part = db.prepare(
        'SELECT id, logpoint_id, ts, value FROM measurements WHERE logpoint_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC'
      ).all(numericLogpointId, fromTs, toTs);
      for (const row of part) {
        rows.push(row);
      }
    }

    const asc = rows.sort((a, b) => Number(a.ts) - Number(b.ts));
    const sampledAsc = sampleRowsAcrossRange(asc, lim);
    return sampledAsc.sort((a, b) => Number(b.ts) - Number(a.ts));
  },

  /**
   * Anzahl Messwerte für einen Logpoint im Zeitraum zählen.
   * @param {string} connectionId
   * @param {number|string} logpointId
   * @param {number} fromTs
   * @param {number} toTs
   * @returns {number}
   */
  count(connectionId, logpointId, fromTs, toTs) {
    const numericLogpointId = Number(logpointId);
    if (!Number.isInteger(numericLogpointId) || numericLogpointId <= 0) return 0;
    const dbs = openDbCandidatesForQuery(String(connectionId), fromTs, toTs);
    if (dbs.length === 0) return 0;

    let total = 0;
    for (const db of dbs) {
      const row = db.prepare(
        'SELECT COUNT(*) AS c FROM measurements WHERE logpoint_id = ? AND ts BETWEEN ? AND ?'
      ).get(numericLogpointId, fromTs, toTs);
      total += Number((row && row.c) || 0);
    }
    return total;
  },

  /**
   * Gesamtanzahl Messwerte für eine Connection (über alle DB-Dateien/Monate).
   * @param {string} connectionId
   * @returns {number}
   */
  countConnectionTotal(connectionId) {
    const dbs = openAllDbCandidatesForConnection(String(connectionId));
    if (dbs.length === 0) return 0;

    let total = 0;
    for (const db of dbs) {
      const row = db.prepare('SELECT COUNT(*) AS c FROM measurements').get();
      total += Number((row && row.c) || 0);
    }
    return total;
  },

  /**
   * Alle Messwerte einer Connection abfragen (alle Logpoints).
   * @param {string} connectionId
   * @param {number} fromTs
   * @param {number} toTs
   * @param {number} limit
   * @returns {Array}
   */
  queryAll(connectionId, fromTs, toTs, limit) {
    const lim = Number(limit) || 1000;
    const dbs = openDbCandidatesForQuery(String(connectionId), fromTs, toTs);
    if (dbs.length === 0) return [];

    const rows = [];
    for (const db of dbs) {
      const part = db.prepare(
        'SELECT id, logpoint_id, ts, value FROM measurements WHERE ts BETWEEN ? AND ? ORDER BY ts ASC'
      ).all(fromTs, toTs);
      for (const row of part) {
        rows.push(row);
      }
    }

    const asc = rows.sort((a, b) => Number(a.ts) - Number(b.ts));
    const sampledAsc = sampleRowsAcrossRange(asc, lim);
    return sampledAsc.sort((a, b) => Number(b.ts) - Number(a.ts));
  },

  /**
   * Entfernt redundante Zwischenpunkte bei konstanten Werten für den aktuellen Monat.
    * Auch innerhalb der letzten 24h wird verdichtet.
    * Dabei bleiben pro Bucket immer Eckpunkte erhalten (erste/letzte Messung).
   *
    * Beispiel (älter als 24h, 10-Minuten-Bucket):
    * - Innerhalb eines Buckets werden nur redundante Mittelwerte entfernt.
    * - Über Bucket-Grenzen bleibt mindestens ein Eckpunkt erhalten.
   *
   * @param {string} connectionId
   * @param {number|string} logpointId
   * @returns {number} Anzahl gelöschter Zeilen
   */
  pruneUnchangedCurrentMonth(connectionId, logpointId) {
    const numericLogpointId = Number(logpointId);
    if (!Number.isInteger(numericLogpointId) || numericLogpointId <= 0) return 0;

    const db = openDbForInsert(String(connectionId), Date.now());
    const pruneAnchorMs = getPruneAnchorMs();
    const info = db.prepare(`
      WITH seq AS (
        SELECT
          id,
          ts,
          value,
          CAST(ts / ? AS INTEGER) AS bucket,
          ROW_NUMBER() OVER (PARTITION BY logpoint_id, CAST(ts / ? AS INTEGER) ORDER BY ts, id) AS rn_asc,
          ROW_NUMBER() OVER (PARTITION BY logpoint_id, CAST(ts / ? AS INTEGER) ORDER BY ts DESC, id DESC) AS rn_desc,
          LAG(ts) OVER (PARTITION BY logpoint_id ORDER BY ts, id) AS prev_ts,
          LEAD(ts) OVER (PARTITION BY logpoint_id ORDER BY ts, id) AS next_ts,
          LAG(value) OVER (PARTITION BY logpoint_id ORDER BY ts, id) AS prev_value,
          LEAD(value) OVER (PARTITION BY logpoint_id ORDER BY ts, id) AS next_value
        FROM measurements
        WHERE logpoint_id = ?
      )
      DELETE FROM measurements
      WHERE id IN (
        SELECT id
        FROM seq
        WHERE bucket = CAST(prev_ts / ? AS INTEGER)
          AND bucket = CAST(next_ts / ? AS INTEGER)
          AND prev_ts IS NOT NULL
          AND next_ts IS NOT NULL
          AND rn_asc > 1
          AND rn_desc > 1
          AND value IS prev_value
          AND value IS next_value
      )
    `).run(pruneAnchorMs, pruneAnchorMs, pruneAnchorMs, numericLogpointId, pruneAnchorMs, pruneAnchorMs);

    return Number(info && info.changes ? info.changes : 0);
  },

  /**
   * Alle geöffneten Datenbank-Verbindungen schließen.
   */
  closeAll() {
    for (const [dbPath, db] of openDbs.entries()) {
      try { db.close(); } catch (e) { /* ignore */ }
      openDbs.delete(dbPath);
    }
  }
};
