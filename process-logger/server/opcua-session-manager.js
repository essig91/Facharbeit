const { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy } = require('node-opcua');
const http = require('http');

function policyFromArg(p) {
  if (!p) return SecurityPolicy.None;
  const s = String(p);
  if (/none/i.test(s)) return SecurityPolicy.None;
  if (/basic256sha256/i.test(s)) return SecurityPolicy.Basic256Sha256;
  if (/basic256/i.test(s)) return SecurityPolicy.Basic256;
  if (/basic128/i.test(s)) return SecurityPolicy.Basic128Rsa15;
  return SecurityPolicy.None;
}

function fetchLocalConnections(port) {
  return new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1',
      port: (port || process.env.PORT || 3000),
      path: '/api/opcua/connections',
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { const json = JSON.parse(data || '[]'); resolve(Array.isArray(json) ? json : []); } catch (e) { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

const SESSIONS = new Map();
const DEFAULT_IDLE_MS = 5 * 60 * 1000; // 5 minutes
let pruneInterval = null;

async function ensureClientSession(conn) {
  // conn: { endpoint, authentication?, securityPolicy }
  const endpoint = conn.endpoint;
  if (!endpoint) throw new Error('no endpoint');

  let state = SESSIONS.get(endpoint);
  if (state && state.session) {
    state.lastUsed = Date.now();
    return state.session;
  }

  if (state && state.creating) {
    // wait for creation
    await state.creating;
    state = SESSIONS.get(endpoint);
    if (state && state.session) return state.session;
  }

  // create client & session
  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 0 },
    securityPolicy: policyFromArg(conn.securityPolicy)
  });

  const createPromise = (async () => {
    await client.connect(endpoint);
    const user = conn.authentication && conn.authentication.username ?
      { userName: conn.authentication.username, password: conn.authentication.password } : null;
    const session = await client.createSession(user);
    return { client, session };
  })();

  SESSIONS.set(endpoint, { creating: createPromise, lastUsed: Date.now() });
  try {
    const { client, session } = await createPromise;
    SESSIONS.set(endpoint, { client, session, lastUsed: Date.now() });
    return session;
  } catch (e) {
    // cleanup
    const cur = SESSIONS.get(endpoint);
    if (cur && cur.client) {
      try { await cur.client.disconnect(); } catch(_) {}
    }
    SESSIONS.delete(endpoint);
    throw e;
  }
}

async function readValueForConnection(conn, nodeId) {
  const session = await ensureClientSession(conn);
  try {
    const dataValue = await session.read({ nodeId, attributeId: AttributeIds.Value });
    const value = (dataValue && dataValue.value) ? dataValue.value.value : null;
    // update lastUsed
    const st = SESSIONS.get(conn.endpoint);
    if (st) st.lastUsed = Date.now();
    return { nodeId, value };
  } catch (e) {
    // Evict the broken session so the next caller gets a fresh one
    const st = SESSIONS.get(conn.endpoint);
    if (st) {
      try { if (st.session) await st.session.close(); } catch (_) {}
      try { if (st.client) await st.client.disconnect(); } catch (_) {}
    }
    SESSIONS.delete(conn.endpoint);
    throw e;
  }
}

function startPrune(intervalMs = 60*1000, idleMs = DEFAULT_IDLE_MS) {
  if (pruneInterval) return;
  pruneInterval = setInterval(async () => {
    const now = Date.now();
    for (const [endpoint, state] of Array.from(SESSIONS.entries())) {
      try {
        const last = state.lastUsed || 0;
        if (state.session && (now - last) > idleMs) {
          // close session and disconnect client
          try { await state.session.close(); } catch (_) {}
          try { await state.client.disconnect(); } catch (_) {}
          SESSIONS.delete(endpoint);
        }
      } catch (_) {
        SESSIONS.delete(endpoint);
      }
    }
  }, intervalMs);
}

async function closeAll() {
  if (pruneInterval) { clearInterval(pruneInterval); pruneInterval = null; }
  for (const [endpoint, state] of Array.from(SESSIONS.entries())) {
    try { if (state.session) await state.session.close(); } catch(_) {}
    try { if (state.client) await state.client.disconnect(); } catch(_) {}
    SESSIONS.delete(endpoint);
  }
}

async function globalReadValue(connectionIdOrEndpoint, nodeId) {
  // Try to resolve connectionId via local /api/opcua/connections
  const conns = await fetchLocalConnections();
  const conn = conns.find(c => String(c.id) === String(connectionIdOrEndpoint) || String(c.endpoint) === String(connectionIdOrEndpoint));
  const effective = conn ? conn : { endpoint: connectionIdOrEndpoint };
  return await readValueForConnection(effective, nodeId);
}

module.exports = {
  globalReadValue,
  startPrune,
  closeAll
};