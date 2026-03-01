'use strict';
/**
 * SQLite-basierter Store für Logpoints
 * DB: /opt/process-logger/data/logpoints.db
 *
 * Exportierte API:
 *  - list(filter = {})
 *  - get(id)
 *  - create(obj)
 *  - bulkCreate(arr)
 *  - update(id, patch)
 *  - remove(id)
 *
 * Migration:
 *  - wenn /opt/process-logger/data/logpoints.json existiert, wird sie eingelesen,
 *    in die DB übernommen und als logpoints.json.bak gesichert.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
// Nutze eingebaute crypto.randomUUID() statt externem uuid (vermeidet ESM/require Probleme)
const crypto = require('crypto');

function genId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback (sehr selten bei modernen Node-Versionen)
  return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

const dataDir = '/opt/process-logger/data';
const jsonPath = path.join(dataDir, 'logpoints.json');
const dbPath = path.join(dataDir, 'logpoints.db');

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

// Öffnet DB, legt Schema an und führt ggf. Migration durch
function openDb() {
  ensureDir();

  // setze permisssions für Datenverzeichnis (nur owner)
  try { fs.chmodSync(dataDir, 0o700); } catch (e) {}

  const db = new Database(dbPath);
  // WAL für bessere Concurrency
  try { db.pragma('journal_mode = WAL'); } catch (e) {}

  // Erstelle Tabelle, falls nicht vorhanden
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
      createdAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logpoints_connectionId ON logpoints(connectionId);
    CREATE INDEX IF NOT EXISTS idx_logpoints_nodeId ON logpoints(nodeId);
  `);

  // Migration von JSON falls vorhanden
  try {
    if (fs.existsSync(jsonPath)) {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const arr = JSON.parse(raw || '[]');
      if (Array.isArray(arr) && arr.length > 0) {
        const insert = db.prepare(`INSERT OR IGNORE INTO logpoints
          (id, connectionId, nodeId, browseName, displayName, dataType, unit, samplingIntervalMs, isAlarm, createdAt)
          VALUES (@id,@connectionId,@nodeId,@browseName,@displayName,@dataType,@unit,@samplingIntervalMs,@isAlarm,@createdAt)
        `);
        const insertMany = db.transaction((items) => {
          for (const it of items) {
            const row = {
              id: it.id || genId(),
              connectionId: it.connectionId || null,
              nodeId: it.nodeId || '',
              browseName: it.browseName || '',
              displayName: it.displayName || '',
              dataType: it.dataType || '',
              unit: it.unit || '',
              samplingIntervalMs: Number(it.samplingIntervalMs || 1000),
              isAlarm: it.isAlarm ? 1 : 0,
              createdAt: it.createdAt || new Date().toISOString()
            };
            insert.run(row);
          }
        });
        insertMany(arr);
      }
      // sichere die JSON als Backup
      try { fs.renameSync(jsonPath, jsonPath + '.bak'); } catch (e) {}
    }
  } catch (e) {
    // bei Migration-Fehlern: loggen und weitermachen
    console.error('logpoint-store sqlite: Migration/Einlesen JSON fehlgeschlagen:', e && e.message);
  }

  // Setze DB-Datei Rechte
  try { fs.chmodSync(dbPath, 0o600); } catch (e) {}

  return db;
}

const db = openDb();

// Helper: wandelt DB-Row in Objekt mit korrekten Typen
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
    createdAt: row.createdAt
  };
}

module.exports = {
  list(filter = {}) {
    let sql = 'SELECT * FROM logpoints';
    const where = [];
    const params = {};
    for (const k of Object.keys(filter)) {
      // einfacher Gleichheitsfilter für bekannte Felder
      if (['id','connectionId','nodeId','browseName'].includes(k)) {
        where.push(`${k} = @${k}`);
        params[k] = String(filter[k]);
      }
      if (k === 'connectionId' && filter[k] === null) {
        // ignore
      }
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY createdAt DESC';
    const stmt = db.prepare(sql);
    const rows = stmt.all(params);
    return rows.map(mapRow);
  },

  get(id) {
    const stmt = db.prepare('SELECT * FROM logpoints WHERE id = ?');
    const row = stmt.get(String(id));
    return mapRow(row);
  },

  create(obj) {
    const now = new Date().toISOString();
    const row = {
      id: obj.id || genId(),
      connectionId: obj.connectionId || null,
      nodeId: obj.nodeId || '',
      browseName: obj.browseName || '',
      displayName: obj.displayName || '',
      dataType: obj.dataType || '',
      unit: obj.unit || '',
      samplingIntervalMs: Number(obj.samplingIntervalMs || 1000),
      isAlarm: obj.isAlarm ? 1 : 0,
      createdAt: obj.createdAt || now
    };
    const stmt = db.prepare(`INSERT OR REPLACE INTO logpoints
      (id, connectionId, nodeId, browseName, displayName, dataType, unit, samplingIntervalMs, isAlarm, createdAt)
      VALUES (@id,@connectionId,@nodeId,@browseName,@displayName,@dataType,@unit,@samplingIntervalMs,@isAlarm,@createdAt)
    `);
    stmt.run(row);
    return mapRow(row);
  },

  bulkCreate(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT OR REPLACE INTO logpoints
      (id, connectionId, nodeId, browseName, displayName, dataType, unit, samplingIntervalMs, isAlarm, createdAt)
      VALUES (@id,@connectionId,@nodeId,@browseName,@displayName,@dataType,@unit,@samplingIntervalMs,@isAlarm,@createdAt)
    `);
    const insertMany = db.transaction((items) => {
      const added = [];
      for (const it of items) {
        const row = {
          id: it.id || genId(),
          connectionId: it.connectionId || null,
          nodeId: it.nodeId || '',
          browseName: it.browseName || '',
          displayName: it.displayName || '',
          dataType: it.dataType || '',
          unit: it.unit || '',
          samplingIntervalMs: Number(it.samplingIntervalMs || 1000),
          isAlarm: it.isAlarm ? 1 : 0,
          createdAt: it.createdAt || now
        };
        insert.run(row);
        added.push(mapRow(row));
      }
      return added;
    });
    return insertMany(arr);
  },

  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    // nur erlaubte Felder updaten
    const fields = {};
    if (patch.unit !== undefined) fields.unit = String(patch.unit);
    if (patch.samplingIntervalMs !== undefined) fields.samplingIntervalMs = Number(patch.samplingIntervalMs);
    if (patch.isAlarm !== undefined) fields.isAlarm = patch.isAlarm ? 1 : 0;
    if (patch.displayName !== undefined) fields.displayName = String(patch.displayName);
    if (patch.browseName !== undefined) fields.browseName = String(patch.browseName);

    const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
    if (!sets) return cur;
    const params = Object.assign({ id: String(id) }, fields);
    const sql = `UPDATE logpoints SET ${sets} WHERE id = @id`;
    db.prepare(sql).run(params);
    return this.get(id);
  },

  remove(id) {
    const stmt = db.prepare('DELETE FROM logpoints WHERE id = ?');
    const info = stmt.run(String(id));
    return info.changes > 0;
  }
};