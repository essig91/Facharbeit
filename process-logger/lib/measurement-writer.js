'use strict';
/**
 * MeasurementWriter
 * Writes measurement samples for a single OPC UA connection to a SQLite database.
 * Each connection gets its own DB file under dataDir/<connectionId>/measurements.db
 *
 * API:
 *  - constructor({ connectionId, dataDir, batchSize, flushIntervalMs })
 *  - push(sample)   sample: { logpoint_id, ts, value, status, serverTimestamp }
 *  - flush()        write buffered samples to DB
 *  - close()        flush and stop the interval timer
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class MeasurementWriter {
  constructor({ connectionId, dataDir, batchSize = 200, flushIntervalMs = 5000 } = {}) {
    if (!connectionId) throw new Error('MeasurementWriter: connectionId is required');
    if (!dataDir) throw new Error('MeasurementWriter: dataDir is required');

    this.connectionId = String(connectionId);
    this.dataDir = dataDir;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this._buffer = [];
    this._db = null;
    this._timer = null;

    this._open();
    this._startTimer();
  }

  _open() {
    const connDir = path.join(this.dataDir, this.connectionId);
    if (!fs.existsSync(connDir)) {
      fs.mkdirSync(connDir, { recursive: true });
    }
    const dbPath = path.join(connDir, 'measurements.db');
    this._db = new Database(dbPath);
    try { this._db.pragma('journal_mode = WAL'); } catch (e) {}
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS measurements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        logpoint_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        value TEXT,
        status TEXT,
        serverTimestamp INTEGER,
        insertedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meas_logpoint_ts ON measurements(logpoint_id, ts);
    `);
  }

  _startTimer() {
    if (this.flushIntervalMs > 0) {
      this._timer = setInterval(() => {
        try { this.flush(); } catch (e) {
          console.warn(`MeasurementWriter[${this.connectionId}] flush error:`, e && e.message);
        }
      }, this.flushIntervalMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  push(sample) {
    this._buffer.push(sample);
    if (this._buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  flush() {
    if (!this._buffer.length) return;
    const items = this._buffer.splice(0, this._buffer.length);
    const now = Date.now();
    const insert = this._db.prepare(
      'INSERT INTO measurements (logpoint_id, ts, value, status, serverTimestamp, insertedAt) VALUES (?,?,?,?,?,?)'
    );
    const insertMany = this._db.transaction((rows) => {
      for (const s of rows) {
        insert.run(
          String(s.logpoint_id || ''),
          Number(s.ts || now),
          s.value !== undefined && s.value !== null ? String(s.value) : null,
          s.status !== undefined ? String(s.status) : null,
          s.serverTimestamp ? Number(s.serverTimestamp) : null,
          now
        );
      }
    });
    insertMany(items);
  }

  close() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    try { this.flush(); } catch (e) {}
    try { if (this._db) this._db.close(); } catch (e) {}
    this._db = null;
  }
}

module.exports = MeasurementWriter;
