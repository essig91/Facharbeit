/**
 * Minimaler Express-Router für OPC UA Verbindungs-Konfigurationen
 * - CRUD: GET/POST/PUT/DELETE /api/opcua/connections
 * - Discovery: POST /api/opcua/discover  { endpoint }
 * - Trust: POST /api/opcua/trust { serverCertificateBase64, name }
 *
 * Hinweise:
 * - Speichert configs in ../config/opcua-connections.json
 * - Legt trusted server-certs als PEM in /var/lib/process-logger/pki/trusted/certs an
 * - Logger-Service (user 'logger') muss Leserechte für config und Schreibrechte für PKI-Ordner haben
 */
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { OPCUAClient } = require('node-opcua');

const router = express.Router();

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'opcua-connections.json');
const PKI_TRUSTED = path.join('/var/lib/process-logger', 'pki', 'trusted', 'certs');

async function ensureConfigFile() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    try {
      await fs.access(CONFIG_FILE);
    } catch {
      // lege leere Struktur an, wenn fehlt
      await fs.writeFile(CONFIG_FILE, JSON.stringify({ connections: [] }, null, 2), 'utf8');
    }
  } catch (err) {
    throw new Error('Cannot prepare config file: ' + err.message);
  }
}

async function readConfig() {
  await ensureConfigFile();
  const txt = await fs.readFile(CONFIG_FILE, 'utf8');
  return JSON.parse(txt);
}

async function writeConfig(cfg) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// List all connections
router.get('/connections', async (req, res) => {
  try {
    const cfg = await readConfig();
    res.json(cfg.connections || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a connection
router.post('/connections', async (req, res) => {
  try {
    const body = req.body || {};
    // einfache Validierung
    if (!body.endpoint) return res.status(400).json({ error: 'endpoint required' });
    const cfg = await readConfig();
    const id = Date.now().toString();
    const entry = Object.assign({
      id,
      name: body.name || id,
      endpoint: body.endpoint,
      securityPolicy: body.securityPolicy || 'None',
      securityMode: body.securityMode || 'None',
      authentication: body.authentication || { type: 'anonymous' },
      requestedSessionTimeout: body.requestedSessionTimeout || 60000,
      connectionStrategy: body.connectionStrategy || { maxRetry: 10, initialDelay: 1000, maxDelay: 10000 },
      nodeIdsToMonitor: body.nodeIdsToMonitor || []
    }, body);
    cfg.connections.push(entry);
    await writeConfig(cfg);
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update connection
router.put('/connections/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const cfg = await readConfig();
    const idx = (cfg.connections || []).findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    cfg.connections[idx] = Object.assign(cfg.connections[idx], req.body);
    await writeConfig(cfg);
    res.json(cfg.connections[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete connection
router.delete('/connections/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const cfg = await readConfig();
    cfg.connections = (cfg.connections || []).filter(c => c.id !== id);
    await writeConfig(cfg);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
 * Discovery: POST /api/opcua/discover
 * Body: { endpoint: 'opc.tcp://192.168.0.50:4840' }
 * Returns: endpoints array (serverCertificate base64 included if present)
 */
router.post('/discover', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

  const client = OPCUAClient.create({ endpointMustExist: false });
  try {
    await client.connect(endpoint);
    const endpoints = await client.getEndpoints();
    // Map serverCertificate Buffer to base64 string (if present)
    const mapped = endpoints.map(e => {
      return {
        endpointUrl: e.endpointUrl,
        securityPolicyUri: e.securityPolicyUri,
        securityMode: e.securityMode && e.securityMode.toString ? e.securityMode.toString() : e.securityMode,
        serverCertificate: e.serverCertificate ? Buffer.from(e.serverCertificate).toString('base64') : null
      };
    });
    await client.disconnect();
    res.json({ endpoints: mapped });
  } catch (err) {
    try { await client.disconnect(); } catch (e) {}
    res.status(500).json({ error: err.message || String(err) });
  }
});

/*
 * Trust a server certificate
 * Body: { serverCertificateBase64: '...', name: 'sps-floor1-1.pem' }
 * Writes PEM file into PKI_TRUSTED
 */
router.post('/trust', async (req, res) => {
  const { serverCertificateBase64, name } = req.body || {};
  if (!serverCertificateBase64) return res.status(400).json({ error: 'serverCertificateBase64 required' });
  const fname = name && typeof name === 'string' ? name : `server-${Date.now()}.pem`;

  try {
    await fs.mkdir(PKI_TRUSTED, { recursive: true });
    // Convert base64 DER to PEM format (64-char lines)
    const der = serverCertificateBase64.replace(/\s+/g, '');
    const pemBody = der.match(/.{1,64}/g).join('\n');
    const pem = `-----BEGIN CERTIFICATE-----\n${pemBody}\n-----END CERTIFICATE-----\n`;
    const dst = path.join(PKI_TRUSTED, fname);
    await fs.writeFile(dst, pem, { mode: 0o644 });
    res.json({ ok: true, path: dst });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;