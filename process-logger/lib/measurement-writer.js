'use strict';
/**
 * measurement-writer.js
 * Per-connection, per-month SQLite writer (measurements-YYYYMM.db)
 */

const fs = require('fs');
const path = require('path');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  // If better-sqlite3 not available, throw early so caller sees the error
  throw new Error('better-sqlite3 module is required by measurement-writer: ' + (e && e.message ? e.message : e));
}

class MeasurementWriter {
  constructor(connectionId, opts = {}) {
    this.connectionId = String(connectionId);
    this.dataDir = opts.dataDir || path.join(process.cwd(), 'data', 'measurements');
    this.connDir = path.join(this.dataDir, this.connectionId);
    fs.mkdirSync(this.connDir, { recursive: true });

    this.batchSize = Number(opts.batchSize || 2000);
    this.flushIntervalMs = Number(opts.flushIntervalMs || 1000);
    this.pageSize = Number(opts.pageSize || 4096);

    this._dbs = new Map(); // month -> { db, insertStmt }
    this._buffer = []; // buffered samples
    this._flushTimer = null;
    this._closed = false;

    this._startFlushTimer();
  }

  _monthForTs(tsMs) {
    const d = new Date(Number(tsMs));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}${m}`; // e.g. 202603
  }

  _dbPathForMonth(month) {
    return path.join(this.connDir, `measurements-${month}.db`);
  }

  _openDbForMonth(month) {
    if (this._dbs.has(month)) return this._dbs.get(month);

    const p = this._dbPathForMonth(month);
    const needCreate = !fs.existsSync(p);
    const db = new Database(p, { timeout: 5000 });

    // Performance PRAGMAs
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('temp_store = MEMORY');
    } catch (e) {
      console.warn('measurement-writer: pragma set failed', e && e.message ? e.message : e);
    }

    if (needCreate) {
      db.exec(`
        PRAGMA page_size = ${this.pageSize};
        CREATE TABLE IF NOT EXISTS measurements (
          logpoint_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          value REAL,
          status TEXT,
          serverTimestamp INTEGER,
          insertedAt INTEGER DEFAULT (strftime('%s','now')*1000),
          PRIMARY KEY (logpoint_id, ts)
        );
        CREATE INDEX IF NOT EXISTS idx_measurements_ts ON measurements(ts);
        CREATE INDEX IF NOT EXISTS idx_measurements_logpoint_ts ON measurements(logpoint_id, ts);
      `);
    }

    const insertStmt = db.prepare('INSERT OR REPLACE INTO measurements (logpoint_id, ts, value, status, serverTimestamp) VALUES (?, ?, ?, ?, ?)');
    const entry = { db, insertStmt };
    this._dbs.set(month, entry);
    return entry;
  }

  push(sample) {
    if (this._closed) throw new Error('Writer closed');
    if (!sample || !sample.logpoint_id || !sample.ts) {
      throw new Error('sample must include logpoint_id and ts');
    }
    this._buffer.push({
      logpoint_id: String(sample.logpoint_id),
      ts: Number(sample.ts),
      value: (sample.value === undefined) ? null : Number(sample.value),
      status: sample.status || null,
      serverTimestamp: sample.serverTimestamp ? Number(sample.serverTimestamp) : null
    });

    if (this._buffer.length >= this.batchSize) {
      this._flushBuffer();
    }
  }

  _startFlushTimer() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => this._flushBuffer(), this.flushIntervalMs);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  _flushBuffer() {
    if (!this._buffer.length) return;
    const rows = this._buffer;
    this._buffer = [];

    // group by month
    const groups = new Map();
    for (const r of rows) {
      const m = this._monthForTs(r.ts);
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(r);
    }

    // write per-month in transactions
    for (const [month, rs] of groups.entries()) {
      try {
        const { db, insertStmt } = this._openDbForMonth(month);
        const insertMany = db.transaction((items) => {
          for (const it of items) {
            insertStmt.run(it.logpoint_id, it.ts, it.value, it.status, it.serverTimestamp);
          }
        });
        insertMany(rs);
      } catch (e) {
        // log and drop this batch to avoid unbounded memory growth
        console.warn(`measurement-writer: write error for month ${month}:`, e && e.message ? e.message : e);
      }
    }
  }

  // Expose an async flush() for tests / synchronous endpoints.
  async flush() {
    this._flushBuffer();
    // better-sqlite3 runs synchronously; return resolved Promise for API uniformity
    return Promise.resolve();
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._flushBuffer();
    // close DBs
    for (const [m, { db }] of this._dbs.entries()) {
      try { db.close(); } catch (e) { console.warn('measurement-writer: close db error', e && e.message ? e.message : e); }
    }
    this._dbs.clear();
  }
}

module.exports = function createWriter(connectionId, opts) {
  return new MeasurementWriter(connectionId, opts);
};