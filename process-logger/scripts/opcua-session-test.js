#!/usr/bin/env node
'use strict';

/**
 * Verwendung:
 *   node opcua-session-test.js <endpoint> [username] [password] [securityPolicy]
 *
 * Beispiel:
 *   node opcua-session-test.js opc.tcp://192.168.0.10:4840 datalog LogLog123 None
 *
 * Dieses Skript stellt eine OPC UA Verbindung her, erstellt eine Session (mit optionalen
 * Username/Password) und liest kurz den Server-Status-Knoten (i=2258). Ausgabe erfolgt
 * über stdout/stderr für die Anzeige in der Web-UI.
 */

const { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds } = require('node-opcua');

const endpoint = process.argv[2];
const username = process.argv[3];
const password = process.argv[4];
const securityPolicyArg = process.argv[5] || 'None';

if (!endpoint) {
  console.error('Fehler: endpoint fehlt');
  process.exit(2);
}

const isNone = String(securityPolicyArg).toLowerCase() === 'none';

// Client-Optionen: bei 'None' unverschlüsselt, sonst Basic256 + SignAndEncrypt
const clientOptions = {
  endpointMustExist: false,
  securityPolicy: isNone ? SecurityPolicy.None : SecurityPolicy.Basic256,
  securityMode: isNone ? MessageSecurityMode.None : MessageSecurityMode.SignAndEncrypt,
};

const client = OPCUAClient.create(clientOptions);

async function main() {
  try {
    console.log('verbinde mit', endpoint);
    await client.connect(endpoint);
    console.log('verbunden');

    const identity = username ? { userName: username, password: password } : null;
    const session = await client.createSession(identity);
    console.log('Session erstellt, id=', session.sessionId.toString());

    // Kurzer Leseversuch des bekannten Knotens Server Status (i=2258)
    try {
      const dataValue = await session.read({ nodeId: 'i=2258', attributeId: AttributeIds.Value });
      console.log('Lese i=2258, status=', dataValue.statusCode ? dataValue.statusCode.toString() : 'unbekannt', ' wert=', dataValue.value ? dataValue.value.value : '(kein wert)');
    } catch (readErr) {
      console.error('Lesefehler:', readErr && readErr.message ? readErr.message : readErr);
    }

    await session.close();
    await client.disconnect();
    console.log('Session geschlossen, getrennt -> OK');
    process.exit(0);
  } catch (err) {
    console.error('FEHLER', err && err.message ? err.message : err);
    try { await client.disconnect(); } catch (e) {}
    process.exit(1);
  }
}

main();