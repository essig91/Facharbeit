#!/usr/bin/env node
/**
 * opcua-connector.js
 * - Lädt /opt/process-logger/config/opcua-connections.json
 * - Für jede Connection: versuche Connect -> createSession -> optional Read first node -> close
 * - CLI: node opcua-connector.js --test-all
 *
 * Hinweise:
 * - Benötigt: npm install node-opcua fs-extra
 * - PKI/Trust: Wenn Security != None und Server-Zertifikat nicht vertraut ist, schlägt Connect fehl.
 * - Script gibt JSON-Resultate auf stdout aus (leicht parsebar).
 */

const fs = require('fs').promises;
const path = require('path');
const { OPCUAClient, MessageSecurityMode, SecurityPolicy } = require('node-opcua');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'opcua-connections.json');

// Helfer: Map Strings auf node-opcua Konstanten
function mapSecurityPolicy(name) {
  switch (name) {
    case 'Basic256Sha256': return SecurityPolicy.Basic256Sha256;
    case 'Basic256': return SecurityPolicy.Basic256;
    case 'Basic128Rsa15': return SecurityPolicy.Basic128Rsa15;
    case 'None': return SecurityPolicy.None;
    default: return SecurityPolicy.None;
  }
}
function mapSecurityMode(name) {
  switch (name) {
    case 'SignAndEncrypt': return MessageSecurityMode.SignAndEncrypt;
    case 'Sign': return MessageSecurityMode.Sign;
    case 'None': return MessageSecurityMode.None;
    default: return MessageSecurityMode.None;
  }
}

async function loadConfig() {
  const txt = await fs.readFile(CONFIG_FILE, 'utf8');
  const cfg = JSON.parse(txt);
  return cfg.connections || [];
}

async function testConnection(conn) {
  const result = {
    id: conn.id,
    name: conn.name || null,
    endpoint: conn.endpoint,
    success: false,
    error: null,
    read: null
  };

  // Minimal client options (no explicit certificate files here; node-opcua verwaltet PKI)
  const clientOptions = {
    endpointMustExist: false,
    securityPolicy: mapSecurityPolicy(conn.securityPolicy || 'None'),
    securityMode: mapSecurityMode(conn.securityMode || 'None'),
    connectionStrategy: {
      initialDelay: (conn.connectionStrategy && conn.connectionStrategy.initialDelay) || 1000,
      maxRetry: (conn.connectionStrategy && conn.connectionStrategy.maxRetry) || 3
    },
    requestedSessionTimeout: conn.requestedSessionTimeout || 60_000
  };

  const client = OPCUAClient.create(clientOptions);
  let session;
  try {
    // Connect
    await client.connect(conn.endpoint);
    // Build user identity
    let userIdentity = null;
    if (conn.authentication && conn.authentication.type === 'username') {
      userIdentity = { userName: conn.authentication.username, password: conn.authentication.password };
    } else if (conn.authentication && conn.authentication.type === 'certificate') {
      // certificate-based auth: Node-opcua expects client cert/key configured in options; if not present, this will likely fail.
      userIdentity = { type: 'X509' };
    } // anonymous -> null

    // Create session
    session = await client.createSession(userIdentity);
    result.success = true;

    // Optional: falls nodeIds konfiguriert sind, lese erste NodeId
    if (Array.isArray(conn.nodeIdsToMonitor) && conn.nodeIdsToMonitor.length > 0) {
      try {
        const nodeId = conn.nodeIdsToMonitor[0];
        const dataValue = await session.read({ nodeId, attributeId: 13 }); // Value attribute
        result.read = {
          nodeId,
          statusCode: dataValue.statusCode ? dataValue.statusCode.toString() : null,
          value: dataValue.value && dataValue.value.value !== undefined ? dataValue.value.value : null
        };
      } catch (readErr) {
        result.read = { error: readErr.message || String(readErr) };
      }
    }

    // Close session
    await session.close();
    await client.disconnect();
  } catch (err) {
    // Sammle aussagekräftige Fehlermeldung
    result.success = false;
    result.error = (err && err.message) ? err.message : String(err);
    try { if (session) await session.close(); } catch (e) {}
    try { await client.disconnect(); } catch (e) {}
  }
  return result;
}

async function testAll() {
  const conns = await loadConfig();
  const results = [];
  for (const c of conns) {
    process.stdout.write(`Testing ${c.id || c.name || c.endpoint} ... `);
    const r = await testConnection(c);
    results.push(r);
    process.stdout.write(r.success ? 'OK\n' : `FAIL (${r.error})\n`);
  }
  // Ausgabe als JSON (auch für weitere Verarbeitung)
  console.log(JSON.stringify({ timestamp: Date.now(), results }, null, 2));
  return results;
}

// CLI: --test-all or --test <id>
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--test-all' || argv[0] === undefined) {
    await testAll();
    process.exit(0);
  } else if (argv[0] === '--test' && argv[1]) {
    const conns = await loadConfig();
    const conn = conns.find(c => c.id === argv[1] || c.name === argv[1]);
    if (!conn) {
      console.error('Connection not found:', argv[1]);
      process.exit(2);
    }
    const r = await testConnection(conn);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.success ? 0 : 1);
  } else {
    console.log('Usage: node opcua-connector.js [--test-all] | [--test <id>]');
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error', err);
    process.exit(1);
  });
}
