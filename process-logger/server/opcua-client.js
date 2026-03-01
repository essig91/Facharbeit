/**
 * Einfacher OPC UA Client
 * - konfigurierbar über OPCUA_ENDPOINT und OPCUA_USER / OPCUA_PASSWORD
 * - verbindet, erstellt Session, beendet Session und Verbindung sauber
 *
 * Nutzung:
 * OPCUA_ENDPOINT=opc.tcp://192.168.0.10:4840 node server/opcua-client.js
 * oder ohne env: node server/opcua-client.js
 */

'use strict';

const { OPCUAClient, MessageSecurityMode, SecurityPolicy, UserTokenType } = require('node-opcua');
require('dotenv').config();

// Konfiguration: Endpoint aus Umgebungsvariablen oder Default
const endpointUrl = process.env.OPCUA_ENDPOINT || 'opc.tcp://127.0.0.1:4840';
const username = process.env.OPCUA_USER || null;
const password = process.env.OPCUA_PASSWORD || null;

// Erzeuge einen OPC UA Client mit einfacher Reconnect‑Strategie
const client = OPCUAClient.create({
  applicationName: 'process-logger-opcua-client',
  connectionStrategy: {
    initialDelay: 1000,
    maxRetry: 10
  },
  securityMode: MessageSecurityMode.None,         // für Development: keine Message‑Security
  securityPolicy: SecurityPolicy.None,            // für Development
  endpointMustExist: false                      // toleranter bei Endpoint Beschreibung
});

let theSession = null;
let theSubscription = null;

async function connectAndCreateSession() {
  console.log('OPC UA: connecting to', endpointUrl);
  try {
    // Verbindung zum Server aufbauen
    await client.connect(endpointUrl);
    console.log('OPC UA: connected');

    // Session erstellen (anonym oder mit Benutzer)
    if (username && password) {
      console.log('OPC UA: creating session (username/password)');
      theSession = await client.createSession({ userName: username, password: password });
    } else {
      console.log('OPC UA: creating anonymous session');
      theSession = await client.createSession();
    }
    console.log('OPC UA: session created (sessionId:', theSession.sessionId.toString(), ')');

    // Hier könntest du z.B. browsen, lesen, schreiben oder Subscription anlegen.
    // Für den ersten Schritt belassen wir es bei einer kurzen Pause.
    console.log('OPC UA: keeping session for 5s (testing) ...');
    await new Promise((r) => setTimeout(r, 5000));

    // Sauber schließen
    await theSession.close();
    console.log('OPC UA: session closed');

    await client.disconnect();
    console.log('OPC UA: disconnected');
  } catch (err) {
    console.error('OPC UA: error', err);
    try {
      if (theSession) {
        await theSession.delete();
        theSession = null;
      }
    } catch (e) {
      // ignore
    }
    try {
      await client.disconnect();
    } catch (e) {
      // ignore
    }
    process.exit(1);
  }
}

// Signal‑Handling damit der Client sauber auf SIGINT/SIGTERM reagiert
process.once('SIGINT', async () => {
  console.log('Received SIGINT, shutting down OPC UA client...');
  try { if (theSession) await theSession.close(); } catch (e) {}
  try { await client.disconnect(); } catch (e) {}
  process.exit(0);
});
process.once('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down OPC UA client...');
  try { if (theSession) await theSession.close(); } catch (e) {}
  try { await client.disconnect(); } catch (e) {}
  process.exit(0);
});

// Falls du dieses Script direkt startest:
if (require.main === module) {
  connectAndCreateSession().then(() => {
    console.log('OPC UA client finished.');
    // Exit normal; in real service würde man verbunden bleiben
    process.exit(0);
  });
}

// Export für Integration in index.js (falls du es später dort starten willst)
module.exports = { connectAndCreateSession, client };