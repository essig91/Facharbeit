// Testscript: initialisiert die DB, fügt einen Testwert ein und liest ihn wieder aus

const path = require('path');
const { init } = require('./db');

const dbPath = path.join(__dirname, '..', 'data', 'database.db');

console.log('Opening DB at', dbPath);
const db = init(dbPath);

try {
  const tagId = 'testTag';
  const nodeId = `ns=1;s=${tagId}`;
  const dataType = 'Double';
  const ts = Date.now();
  const value = Math.round(Math.random() * 1000) / 10; // zufälliger Testwert

  console.log('Inserting tag (wenn noch nicht vorhanden)...');
  db.insertTag(tagId, nodeId, dataType);

  console.log('Inserting measurement...');
  db.insertMeasurement(tagId, ts, value);

  console.log('Querying recent measurements for tag:', tagId);
  const rows = db.queryMeasurements(tagId, ts - 60_000, ts + 60_000, 10);
  console.log('Rows:', rows);
} catch (err) {
  console.error('DB Test Error:', err);
} finally {
  console.log('Closing DB');
  db.close();
}