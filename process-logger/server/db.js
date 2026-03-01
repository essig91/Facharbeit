// Einfaches DB‑Modul mit better-sqlite3
// Funktionen: init(dbPath) -> { insertTag, insertMeasurement, queryMeasurements, close }

// Module laden
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function init(dbPath) {
  // Stelle sicher, dass das Verzeichnis existiert
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Datenbank öffnen (Datei wird erstellt, falls sie fehlt)
  const db = new Database(dbPath);

  // Wichtige PRAGMA Einstellungen für bessere Schreib-/Lese‑Performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  // Tabellen anlegen, falls noch nicht vorhanden
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      nodeId TEXT NOT NULL,
      dataType TEXT
    );

    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      value REAL,
      FOREIGN KEY (tag_id) REFERENCES tags(id)
    );

    CREATE INDEX IF NOT EXISTS idx_measurements_tag_ts ON measurements(tag_id, ts);
  `);

  // Vorbereitete Statements für wiederholte Nutzung (schneller & sicherer)
  const insertTagStmt = db.prepare('INSERT OR IGNORE INTO tags(id, nodeId, dataType) VALUES (?, ?, ?)');
  const insertMeasurementStmt = db.prepare('INSERT INTO measurements(tag_id, ts, value) VALUES (?, ?, ?)');
  const selectMeasurementsStmt = db.prepare('SELECT id, tag_id, ts, value FROM measurements WHERE tag_id = ? AND ts BETWEEN ? AND ? ORDER BY ts LIMIT ?');

  return {
    insertTag: (id, nodeId, dataType) => insertTagStmt.run(id, nodeId, dataType),
    insertMeasurement: (tagId, ts, value) => insertMeasurementStmt.run(tagId, ts, value),
    queryMeasurements: (tagId, fromTs, toTs, limit = 1000) => selectMeasurementsStmt.all(tagId, fromTs, toTs, limit),
    close: () => db.close()
  };
}

module.exports = { init };