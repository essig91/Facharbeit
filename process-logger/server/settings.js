const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const STORE = path.resolve('/opt/process-logger/data/settings.json');

function loadSettings() {
  try {
    const raw = fs.readFileSync(STORE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveSettings(obj) {
  const dir = path.dirname(STORE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  fs.writeFileSync(STORE, JSON.stringify(obj, null, 2), { mode: 0o640 });
}

router.get('/', (req, res) => {
  try {
    const s = loadSettings();
    res.json(s && Object.keys(s).length ? s : {});
  } catch (e) {
    console.error('GET /api/settings err', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

router.put('/', express.json(), (req, res) => {
  try {
    const body = req.body || {};
    saveSettings(body);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/settings err', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

module.exports = router;