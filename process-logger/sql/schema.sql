PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS measurements (
  logpoint_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL,
  status TEXT,
  serverTimestamp INTEGER,
  PRIMARY KEY (logpoint_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_measurements_ts ON measurements(ts);
