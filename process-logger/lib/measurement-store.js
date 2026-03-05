'use strict';
/**
 * lib/measurement-store.js
 *
 * Verwaltung der Messwert-Datenbanken in data/measurements/.
 * Für jede connectionId wird eine eigene SQLite-DB angelegt:
 *   <dataDir>/measurements/<connectionId>.db
 *
 * API:
 *   insert(connectionId, logpointId, ts, value, quality)
 *   query(connectionId, logpointId, fromTs, toTs, limit)
 *   queryAll(connectionId, fromTs, toTs, limit)
 *   closeAll()
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.PROCESS_LOGGER_DATA_DIR || '/opt/process-logger/data';
const measurementsDir = path.join(dataDir, 'measurements');

// Geöffnete DB-Instanzen je connectionId
const openDbs = new Map();

function ensureMeasurementsDir() {
  if (!fs.existsSync(measurementsDir)) {
    fs.mkdirSync(measurementsDir, { recursive: true, mode: 0o700 });
  }
}

function openDb(connectionId) {
  if (openDbs.has(connectionId)) return openDbs.get(connectionId);

  ensureMeasurementsDir();

  const dbPath = path.join(measurementsDir, `${connectionId}.db`);
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logpoint_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value TEXT,
      quality TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_measurements_logpoint_ts ON measurements(logpoint_id, ts);
  `);

  openDbs.set(connectionId, db);
  return db;
}

module.exports = {
  /**
   * Einen Messwert einfügen.
   * @param {string} connectionId
   * @param {string} logpointId
   * @param {number} ts  Unix-Millisekunden
   * @param {*}      value
   * @param {string} quality
   */
  insert(connectionId, logpointId, ts, value, quality) {
    const db = openDb(String(connectionId));
    const valStr = (value === null || value === undefined) ? null : String(value);
    db.prepare(
      'INSERT INTO measurements(logpoint_id, ts, value, quality) VALUES (?, ?, ?, ?)'
    ).run(String(logpointId), ts, valStr, quality || null);
  },

  /**
   * Messwerte für einen Logpoint abfragen.
   * @param {string} connectionId
   * @param {string} logpointId
   * @param {number} fromTs
   * @param {number} toTs
   * @param {number} limit
   * @returns {Array}
   */
  query(connectionId, logpointId, fromTs, toTs, limit) {
    const db = openDb(String(connectionId));
    const lim = Number(limit) || 1000;
    return db.prepare(
      'SELECT id, logpoint_id, ts, value, quality FROM measurements WHERE logpoint_id = ? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT ?'
    ).all(String(logpointId), fromTs, toTs, lim);
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
    const db = openDb(String(connectionId));
    const lim = Number(limit) || 1000;
    return db.prepare(
      'SELECT id, logpoint_id, ts, value, quality FROM measurements WHERE ts BETWEEN ? AND ? ORDER BY ts LIMIT ?'
    ).all(fromTs, toTs, lim);
  },

  /**
   * Alle geöffneten Datenbank-Verbindungen schließen.
   */
  closeAll() {
    for (const [cid, db] of openDbs.entries()) {
      try { db.close(); } catch (e) { /* ignore */ }
      openDbs.delete(cid);
    }
  }
};
