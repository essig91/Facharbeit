'use strict';
/**
 * SQLite Store für Logpoints mit automatischer Spalten‑Prüfung/Anpassung
 * DB: /opt/process-logger/data/logpoints.db (oder PROCESS_LOGGER_DATA_DIR)
 *
 * API:
 *  - list(filter = {})
 *  - get(id)
 *  - create(obj)
 *  - bulkCreate(arr)
 *  - update(id, patch)
 *  - remove(id)
 *
 * Verhalten:
 *  - Erstellt DB + Tabelle falls nicht vorhanden.
 *  - Prüft beim Start missing columns (z. B. 'decimals', 'updatedAt') und ergänzt sie per ALTER TABLE.
 *  - Setzt updatedAt = createdAt für bestehende Zeilen, falls updatedAt fehlt.
 *  - Normalisiert dataType beim Erstellen / Bulk-Create / Update (Option 2: ersetzt dataType in DB)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

function genId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

const dataDir = process.env.PROCESS_LOGGER_DATA_DIR || '/opt/process-logger/data';
const dbPath = path.join(dataDir, 'logpoints.db');

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Normalize dataType string into a human-readable canonical form.
 * This implements Option 2: replace stored dataType with normalized form.
 *
 * Examples:
 *  - "i=3002" -> "UInt16"
 *  - "i=3008" -> "Date"
 *  - "i=3014" -> "String"
 *  - "Double"/"Float"/"Real" -> "Real"
 *  - integer builtins -> "Integer"
 *  - bytestring -> "ByteString"
 *  - fallback: original dt string
 *
 * If dt is falsy and exampleValue is provided, tries to infer from JS type.
 */
function normalizeDataType(dt, exampleValue) {
  if (!dt && exampleValue !== undefined && exampleValue !== null) {
    if (typeof exampleValue === 'string') return 'String';
    if (Number.isInteger(Number(exampleValue))) return 'Integer';
    if (typeof exampleValue === 'number') return 'Real';
    if (typeof exampleValue === 'boolean') return 'Boolean';
    if (Array.isArray(exampleValue)) return 'Array';
    return 'Variant';
  }
  if (!dt) return '';

  const s = String(dt).trim().toLowerCase();

  // explicit known mapping from your examples
  if (s === 'i=3002' || s === '3002') return 'UInt16';
  if (s === 'i=3008' || s === '3008') return 'Date';
  if (s === 'i=3014' || s === '3014') return 'String';

  // floats/doubles -> Real (unified name)
  if (/double|float|real|f32|f64|decimal/.test(s)) return 'Real';

  // time types
  if (s.includes('time') || s.includes('datetime') || s.includes('utc') || s.includes('timestamp') || s.includes('3006')) return 'Time';

  // integer types
  if (/\b(u?int|int|sbyte|byte|word|dword|u?int8|u?int16|u?int32|u?int64)\b/.test(s)) return 'Integer';

  // byte string / octet string
  if (s.includes('bytestring') || s.includes('byte string') || s.includes('octet')) return 'ByteString';

  // string heuristics
  if (s.includes('string') || s.includes('varchar') || s.includes('char')) return 'String';

  // fallback: return original dt (preserve what we don't understand)
  return dt;
}

/**
 * Prüft vorhandene Spalten und fügt fehlende Spalten per ALTER TABLE hinzu.
 * Diese Funktion ist idempotent (sichere Mehrfach-Ausführung).
 */
function ensureColumns(db) {
  try {
    const info = db.prepare("PRAGMA table_info(logpoints);").all();
    const colNames = info.map(c => c.name);
    // decimals
    if (!colNames.includes('decimals')) {
      try {
        db.prepare("ALTER TABLE logpoints ADD COLUMN decimals INTEGER DEFAULT 2;").run();
        console.info('logpoint-store: added column decimals');
      } catch (e) {
        console.warn('logpoint-store: could not add column decimals:', e && e.message);
      }
    }
    // updatedAt
    if (!colNames.includes('updatedAt')) {
      try {
        db.prepare("ALTER TABLE logpoints ADD COLUMN updatedAt TEXT;").run();
        console.info('logpoint-store: added column updatedAt');
        try {
          db.prepare("UPDATE logpoints SET updatedAt = createdAt WHERE updatedAt IS NULL;").run();
        } catch (e2) {
          console.warn('logpoint-store: could not initialize updatedAt values:', e2 && e2.message);
        }
      } catch (e) {
        console.warn('logpoint-store: could not add column updatedAt:', e && e.message);
      }
    }
    // In Zukunft: weitere Spalten prüfen
  } catch (e) {
    console.warn('logpoint-store: ensureColumns failed to read table info:', e && e.message);
  }
}

/**
 * Migrate existing rows to normalized dataType.
 * This is idempotent: will only update rows where normalized != stored.
 */
function migrateNormalizeDataTypes(db) {
  try {
    const rows = db.prepare('SELECT id, dataType FROM logpoints').all();
    const updates = [];
    for (const r of rows) {
      const normalized = normalizeDataType(r.dataType, undefined);
      if (normalized && String(normalized) !== String(r.dataType)) {
        updates.push({ id: r.id, dataType: normalized });
      }
    }
    if (updates.length === 0) return;
    const tx = db.transaction((items) => {
      const st = db.prepare('UPDATE logpoints SET dataType = @dataType, updatedAt = @updatedAt WHERE id = @id');
      const now = (new Date()).toISOString();
      for (const it of items) {
        st.run({ dataType: it.dataType, updatedAt: now, id: it.id });
      }
    });
    tx(updates);
    console.info(`logpoint-store: normalized dataType for ${updates.length} rows`);
  } catch (e) {
    console.warn('logpoint-store: migrateNormalizeDataTypes failed:', e && e.message);
  }
}

/* DB öffnen / Schema anlegen */
function openDb() {
  ensureDir();

  try { fs.chmodSync(dataDir, 0o700); } catch (e) {}

  const db = new Database(dbPath);
  try { db.pragma('journal_mode = WAL'); } catch (e) {}
  try { db.pragma('synchronous = NORMAL'); } catch (e) {}

  // Basis-Schema (enthält decimals und updatedAt). Wenn die Tabelle bereits existiert,
  // wird CREATE TABLE IF NOT EXISTS die bestehende Struktur nicht verändern.
  db.exec(`
    CREATE TABLE IF NOT EXISTS logpoints (
      id TEXT PRIMARY KEY,
      connectionId TEXT,
      nodeId TEXT,
      browseName TEXT,
      displayName TEXT,
      dataType TEXT,
      unit TEXT,
      samplingIntervalMs INTEGER,
      isAlarm INTEGER,
      decimals INTEGER DEFAULT 2,
      createdAt TEXT,
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logpoints_connectionId ON logpoints(connectionId);
    CREATE INDEX IF NOT EXISTS idx_logpoints_nodeId ON logpoints(nodeId);

    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logpoint_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value TEXT,
      quality TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_measurements_logpoint_ts ON measurements(logpoint_id, ts);
  `);

  // Ergänze fehlende Spalten bei älteren DBs (Migration helper)
  ensureColumns(db);

  // Migration: normalisiere vorhandene dataType-Werte (idempotent)
  try {
    migrateNormalizeDataTypes(db);
  } catch (e) {
    // already logged in migrate function
  }

  return db;
}

/* Map DB row -> JS Objekt mit typisierten Feldern */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    connectionId: row.connectionId,
    nodeId: row.nodeId,
    browseName: row.browseName,
    displayName: row.displayName,
    dataType: row.dataType,
    unit: row.unit,
    samplingIntervalMs: Number(row.samplingIntervalMs || 0),
    isAlarm: !!row.isAlarm,
    decimals: Number(row.decimals !== undefined ? row.decimals : 2),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

const db = openDb();

module.exports = {
  list(filter = {}) {
    let sql = 'SELECT * FROM logpoints';
    const params = {};
    if (filter && filter.connectionId) {
      sql += ' WHERE connectionId = @connectionId';
      params.connectionId = String(filter.connectionId);
    }
    sql += ' ORDER BY createdAt DESC';
    const stmt = db.prepare(sql);
    const rows = stmt.all(params);
    return rows.map(mapRow);
  },

  get(id) {
    if (!id) return null;
    const stmt = db.prepare('SELECT * FROM logpoints WHERE id = @id LIMIT 1');
    const row = stmt.get({ id: String(id) });
    return mapRow(row);
  },

  create(obj) {
    const now = (new Date()).toISOString();

    // Normalize dataType before storing
    const normalizedDt = normalizeDataType(obj.dataType, obj.exampleValue);

    const row = {
      id: obj.id || genId(),
      connectionId: obj.connectionId || null,
      nodeId: obj.nodeId || '',
      browseName: obj.browseName || '',
      displayName: obj.displayName || '',
      dataType: normalizedDt || (obj.dataType || ''),
      unit: obj.unit || '',
      samplingIntervalMs: Number(obj.samplingIntervalMs || 1000),
      isAlarm: obj.isAlarm ? 1 : 0,
      decimals: Number(obj.decimals !== undefined ? obj.decimals : 2),
      createdAt: obj.createdAt || now,
      updatedAt: now
    };
    const stmt = db.prepare(`INSERT OR REPLACE INTO logpoints
      (id, connectionId, nodeId, browseName, displayName, dataType, unit, samplingIntervalMs, isAlarm, decimals, createdAt, updatedAt)
      VALUES (@id,@connectionId,@nodeId,@browseName,@displayName,@dataType,@unit,@samplingIntervalMs,@isAlarm,@decimals,@createdAt,@updatedAt)
    `);
    stmt.run(row);
    return mapRow(row);
  },

  bulkCreate(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const now = (new Date()).toISOString();
    const insert = db.prepare(`INSERT OR REPLACE INTO logpoints
      (id, connectionId, nodeId, browseName, displayName, dataType, unit, samplingIntervalMs, isAlarm, decimals, createdAt, updatedAt)
      VALUES (@id,@connectionId,@nodeId,@browseName,@displayName,@dataType,@unit,@samplingIntervalMs,@isAlarm,@decimals,@createdAt,@updatedAt)
    `);
    const insertMany = db.transaction((items) => {
      for (const it of items) {
        const normalizedDt = normalizeDataType(it.dataType, it.exampleValue);
        const row = {
          id: it.id || genId(),
          connectionId: it.connectionId || null,
          nodeId: it.nodeId || '',
          browseName: it.browseName || '',
          displayName: it.displayName || '',
          dataType: normalizedDt || (it.dataType || ''),
          unit: it.unit || '',
          samplingIntervalMs: Number(it.samplingIntervalMs || 1000),
          isAlarm: it.isAlarm ? 1 : 0,
          decimals: Number(it.decimals !== undefined ? it.decimals : 2),
          createdAt: it.createdAt || now,
          updatedAt: now
        };
        insert.run(row);
      }
    });
    insertMany(arr);
    // Return inserted rows' ids (consistent with previous behavior)
    return arr.map(it => ({ id: it.id || genId() }));
  },

  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const fields = {};
    if (patch.unit !== undefined) fields.unit = String(patch.unit);
    if (patch.samplingIntervalMs !== undefined) fields.samplingIntervalMs = Number(patch.samplingIntervalMs);
    if (patch.isAlarm !== undefined) fields.isAlarm = patch.isAlarm ? 1 : 0;
    if (patch.displayName !== undefined) fields.displayName = String(patch.displayName);
    if (patch.browseName !== undefined) fields.browseName = String(patch.browseName);
    if (patch.dataType !== undefined) {
      // Normalize incoming dataType before saving
      fields.dataType = normalizeDataType(patch.dataType, patch.exampleValue);
    }
    if (patch.decimals !== undefined) fields.decimals = Number(patch.decimals);
    if (Object.keys(fields).length === 0) return this.get(id);

    fields.updatedAt = (new Date()).toISOString();
    const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
    const params = Object.assign({ id: String(id) }, fields);
    const sql = `UPDATE logpoints SET ${sets} WHERE id = @id`;
    db.prepare(sql).run(params);
    return this.get(id);
  },

  remove(id) {
    const stmt = db.prepare('DELETE FROM logpoints WHERE id = @id');
    const info = stmt.run({ id: String(id) });
    return info.changes > 0;
  },

  /* ---- Measurements ---- */

  insertMeasurement(logpointId, ts, value, quality) {
    const valStr = (value === null || value === undefined) ? null : String(value);
    const stmt = db.prepare(
      'INSERT INTO measurements(logpoint_id, ts, value, quality) VALUES (?, ?, ?, ?)'
    );
    stmt.run(logpointId, ts, valStr, quality || null);
  },

  queryMeasurements(logpointId, fromTs, toTs, limit) {
    const lim = Number(limit) || 1000;
    const stmt = db.prepare(
      'SELECT id, logpoint_id, ts, value, quality FROM measurements WHERE logpoint_id = ? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT ?'
    );
    return stmt.all(logpointId, fromTs, toTs, lim);
  },

  queryMeasurementsAll(fromTs, toTs, limit) {
    const lim = Number(limit) || 1000;
    const stmt = db.prepare(
      'SELECT id, logpoint_id, ts, value, quality FROM measurements WHERE ts BETWEEN ? AND ? ORDER BY ts LIMIT ?'
    );
    return stmt.all(fromTs, toTs, lim);
  }
};