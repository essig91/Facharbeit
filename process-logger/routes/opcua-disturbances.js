'use strict';

const express = require('express');
const router = express.Router();

const disturbanceStore = require('../lib/disturbance-store');

function roleLevel(req) {
  const roles = (req && req.auth && Array.isArray(req.auth.roles)) ? req.auth.roles : [];
  if (roles.includes('Systemadministrator')) return 5;
  if (roles.includes('Administrator')) return 4;
  if (roles.includes('Bediener')) return 3;
  if (roles.includes('Beobachten')) return 2;
  if (roles.includes('Trend')) return 1;
  return 0;
}

function requireBediener(req, res, next) {
  if (roleLevel(req) < 3) return res.status(403).json({ error: 'Keine Berechtigung.' });
  next();
}

function toSafeInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

router.get('/disturbances/logpoints', (req, res) => {
  try {
    const items = disturbanceStore.getAvailableAlarmLogpoints();
    res.json(items || []);
  } catch (err) {
    console.error('GET /disturbances/logpoints error', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

router.get('/disturbances/rules', (req, res) => {
  try {
    const items = disturbanceStore.listRulesWithLogpointDetails();
    res.json(items || []);
  } catch (err) {
    console.error('GET /disturbances/rules error', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

router.get('/disturbances/rules/:logpointId', (req, res) => {
  try {
    const logpointId = toSafeInt(req.params.logpointId);
    if (!logpointId) return res.status(400).json({ error: 'ungültige logpointId' });
    const item = disturbanceStore.getRuleByLogpointId(logpointId);
    if (!item) return res.status(404).json({ error: 'Regel nicht gefunden' });
    return res.json(item);
  } catch (err) {
    console.error('GET /disturbances/rules/:logpointId error', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

router.put('/disturbances/rules/:logpointId', requireBediener, (req, res) => {
  try {
    const logpointId = toSafeInt(req.params.logpointId);
    if (!logpointId) return res.status(400).json({ error: 'ungültige logpointId' });
    const payload = req.body || {};
    const out = disturbanceStore.upsertRule(logpointId, payload);
    return res.json(out);
  } catch (err) {
    console.error('PUT /disturbances/rules/:logpointId error', err);
    res.status(400).json({ error: String(err && err.message ? err.message : err) });
  }
});

router.post('/disturbances/rules/:logpointId/preview', (req, res) => {
  try {
    const logpointId = toSafeInt(req.params.logpointId);
    if (!logpointId) return res.status(400).json({ error: 'ungültige logpointId' });
    const payload = req.body || {};
    const preview = disturbanceStore.getPreviewForLogpoint(logpointId, {
      ts: payload.ts,
      rawValue: payload.rawValue,
      formattedValue: payload.formattedValue
    });
    return res.json(preview);
  } catch (err) {
    console.error('POST /disturbances/rules/:logpointId/preview error', err);
    res.status(400).json({ error: String(err && err.message ? err.message : err) });
  }
});

router.get('/disturbances/events', (req, res) => {
  try {
    const out = disturbanceStore.listEvents({
      limit: req.query.limit,
      fromTs: req.query.from,
      toTs: req.query.to,
      status: req.query.status
    });
    return res.json(out);
  } catch (err) {
    console.error('GET /disturbances/events error', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

router.get('/disturbances/events/:eventId', (req, res) => {
  try {
    const eventId = toSafeInt(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: 'ungültige eventId' });
    const out = disturbanceStore.getEvent(eventId);
    if (!out) return res.status(404).json({ error: 'Protokoll nicht gefunden' });
    return res.json(out);
  } catch (err) {
    console.error('GET /disturbances/events/:eventId error', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

router.get('/disturbances/events/:eventId/pdf', async (req, res) => {
  try {
    const eventId = toSafeInt(req.params.eventId);
    if (!eventId) return res.status(400).json({ error: 'ungültige eventId' });

    const event = disturbanceStore.getEvent(eventId);
    if (!event) return res.status(404).json({ error: 'Protokoll nicht gefunden' });

    const pdfBuffer = await disturbanceStore.buildPdfBufferForEvent(event);
    const fileName = `ereignisprotokoll-${eventId}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('GET /disturbances/events/:eventId/pdf error', err);
    const msg = String(err && err.message ? err.message : err);
    if (err && err.code === 'PDFKIT_MISSING') {
      return res.status(501).json({
        error: msg,
        hint: 'Bitte im Projektordner ausführen: npm install pdfkit'
      });
    }
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
