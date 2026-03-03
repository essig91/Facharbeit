'use strict';
/**
 * lib/measurement-writer.js
 *
 * MeasurementWriter
 * - one writer instance per Connection
 * - writes raw samples into per-connection / per-month SQLite files:
 *     <dataDir>/<connectionId>/measurements-YYYYMM.db
 * - batching + transaction per-month for throughput
 * - WAL + recommended PRAGMAs applied on DB open
 *
 * Usage:
 *   const Writer = require('./lib/measurement-writer');
 *   const w = new Writer(connectionId, { dataDir: '/opt/process-logger/data/measurements', batchSize: 2000 });
 *   w.push({ logpoint_id: 'uuid-1', ts: Date.now(), value: 12.34, status: 'Good' });
 *   // on shutdown: await w.close();
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class MeasurementWriter {
  constructor(connectionId, opts = {}) {
    this.connectionId = String(connectionId);
    this.dataDir = opts.dataDir || path.join(process.cwd(), 'data', 'measurements');
    this.connDir = path.join(this.dataDir, this.connectionId);
    fs.mkdirSync(this.connDir, { recursive: true });

    this.batchSize = Number(opts.batchSize || 1000);
    this.flushIntervalMs = Number(opts.flushIntervalMs || 1000);
    this.pageSize = Number(opts.pageSize || 4096);

    this.buffer = [];
    this.dbs = new Map(); // month -> { db, insertStmt }
    this.flushTimer = null;
    this.closed = false;

    this._startFlushTimer();
  }

  // helper: YYYYMM for a timestamp (ms)
  _monthForTs(tsMs) {
    const d = new Date(Number(tsMs));
    const y = d.getUTCFullYear();
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    return `${y}${m}`;
  }

  _dbPathForMonth(month) {
    return path.join(this.connDir, `measurements-${month}.db`);
  }

  _ensureDbForMonth(month) {
    if (this.dbs.has(month)) return this.dbs.get(month);

    const p = this._dbPathForMonth(month);
    const needCreate = !fs.existsSync(p);
    const db = new Database(p, { timeout: 5000 });
    // PRAGMAs for performance & concurrency
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('cache_size = -20000');

    if (needCreate) {
      db.exec(`
        PRAGMA page_size = ${this.pageSize};
        CREATE TABLE IF NOT EXISTS measurements (
          logpoint_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          value REAL,
          status TEXT,
          serverTimestamp INTEGER,
          PRIMARY KEY (logpoint_id, ts)
        );
        CREATE INDEX IF NOT EXISTS idx_measurements_ts ON measurements(ts);
      `);
    }

    const insertStmt = db.prepare(
      'INSERT OR REPLACE INTO measurements (logpoint_id, ts, value, status, serverTimestamp) VALUES (?, ?, ?, ?, ?)'
    );

    const entry = { db, insertStmt };
    this.dbs.set(month, entry);
    return entry;
  }

  /**
   * Push a sample into buffer.
   * sample: { logpoint_id: string, ts: number (ms), value: number|null, status?: string, serverTimestamp?: number }
   */
  push(sample) {
    if (this.closed) throw new Error('Writer closed');
    if (!sample || !sample.logpoint_id || !sample.ts) {
      throw new Error('sample must include logpoint_id and ts');
    }
    this.buffer.push({
      logpoint_id: String(sample.logpoint_id),
      ts: Number(sample.ts),
      value: (sample.value === undefined || sample.value === null) ? null : Number(sample.value),
      status: sample.status || null,
      serverTimestamp: sample.serverTimestamp ? Number(sample.serverTimestamp) : null
    });
    if (this.buffer.length >= this.batchSize) this._flushBuffer();
  }

  // group buffer by month then insert per-month in a transaction
  _flushBuffer() {
    if (!this.buffer.length) return;
    // copy and clear buffer (so new pushes don't mix)
    const rows = this.buffer;
    this.buffer = [];

    // group by month
    const groups = new Map();
    for (const r of rows) {
      const m = this._monthForTs(r.ts);
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(r);
    }

    // for each month group, insert in a transaction
    for (const [month, items] of groups.entries()) {
      const { db, insertStmt } = this._ensureDbForMonth(month);
      const txn = db.transaction((rowsToWrite) => {
        for (const row of rowsToWrite) {
          insertStmt.run(row.logpoint_id, row.ts, row.value, row.status, row.serverTimestamp);
        }
      });
      try {
        txn(items);
      } catch (err) {
        // On error, log and drop the batch (avoids infinite retry on persistent errors)
        console.error(`[${this.connectionId}] Error inserting ${items.length} rows into ${month} DB (batch dropped):`, err);
      }
    }
  }

  _startFlushTimer() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      try { this._flushBuffer(); } catch (e) { console.error(`[${this.connectionId}] flush error`, e); }
    }, this.flushIntervalMs);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // flush remaining
    this._flushBuffer();
    // close DB handles
    for (const [month, entry] of this.dbs.entries()) {
      try { entry.db.close(); } catch (e) { console.warn(`[${this.connectionId}] error closing db for month`, month, e); }
    }
    this.dbs.clear();
  }
}

// convenience factory
function createWriter(connectionId, opts = {}) {
  return new MeasurementWriter(connectionId, opts);
}

module.exports = createWriter;
