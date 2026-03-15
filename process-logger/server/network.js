const express = require('express');
const { execFile, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const router = express.Router();

const SCRIPT = '/usr/local/bin/apply-network.sh';
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;
const CONFIRM_WINDOW_MS = 60 * 1000;
const PENDING_STORE_FILE = '/tmp/process-logger-network-pending.json';
const DEFAULT_RECOVERY_IP = '192.168.0.150';
const DEFAULT_RECOVERY_SUBNET = '/24';
const HEALTHCHECK_IFACE = 'eth0';
const HEALTHCHECK_INTERVAL_MS = 5000;
const HEALTHCHECK_PENDING_GRACE_MS = 5000;
const pendingByIface = new Map();
let healthCheckRunning = false;

// NOTE: Ensure you mount an auth middleware before these routes in your app
// e.g. app.use('/api/network', authMiddleware, require('./api/network'))

function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

function execPromise(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, opts, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

function isValidIpv4(ip) {
  if (!/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) return false;
  return ip.split('.').every((x) => {
    const n = Number(x);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runApplyNetwork({ iface = 'eth0', ip, subnet, gateway }) {
  const args = [SCRIPT, iface, ip, subnet];
  if (gateway) args.push(gateway);
  return execFilePromise('sudo', args, { timeout: APPLY_TIMEOUT_MS });
}

function buildDefaultRecoveryConfig(iface = 'eth0') {
  return {
    iface,
    ip: DEFAULT_RECOVERY_IP,
    subnet: DEFAULT_RECOVERY_SUBNET,
    gateway: null
  };
}

async function forceAssignDefaultIp(iface = 'eth0') {
  const cidr = `${DEFAULT_RECOVERY_IP}${DEFAULT_RECOVERY_SUBNET}`;
  try {
    await execFilePromise('sudo', ['ip', 'link', 'set', 'dev', iface, 'up'], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'addr', 'flush', 'dev', iface, 'scope', 'global'], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'addr', 'add', cidr, 'dev', iface], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'neigh', 'flush', 'dev', iface], { timeout: 5000 });
    await sleep(500);
    console.warn(`[forceAssignDefaultIp] Assigned fallback ${cidr} to ${iface}`);
  } catch (e) {
    console.error(`[forceAssignDefaultIp] Failed to assign fallback IP to ${iface}:`, e && e.err ? e.err.message : e);
    throw e;
  }
}

async function ensureUsableIpv4Config(iface = 'eth0') {
  const current = await getCurrentIpv4Config(iface).catch(() => null);
  if (current && current.ip && current.subnet) {
    return { config: current, recovered: false };
  }

  const fallback = buildDefaultRecoveryConfig(iface);
  try {
    // Try script-based recovery first
    await runApplyNetwork(fallback);
    // Extra hardening: always flush and re-assign to avoid stale config
    await execFilePromise('sudo', ['ip', 'link', 'set', 'dev', iface, 'up'], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'addr', 'flush', 'dev', iface, 'scope', 'global'], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'addr', 'add', `${fallback.ip}${fallback.subnet}`, 'dev', iface], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'neigh', 'flush', 'dev', iface], { timeout: 5000 });
    await sleep(500);
  } catch (_) {
    // Emergency path when script-based apply cannot recover interface state.
    await forceAssignDefaultIp(iface);
  }
  await sleep(800);

  const after = await getCurrentIpv4Config(iface).catch(() => null);
  if (after && after.ip && after.subnet) {
    return { config: after, recovered: true };
  }

  return {
    config: { ip: fallback.ip, subnet: fallback.subnet, gateway: fallback.gateway },
    recovered: true,
    assumed: true
  };
}

async function runBackgroundHealthCheck() {
  if (healthCheckRunning) return;
  healthCheckRunning = true;
  try {
    refreshPendingFromStore();
    const pending = pendingByIface.get(HEALTHCHECK_IFACE);
    if (pending) {
      const overdueMs = Date.now() - Number(pending.expiresAt || 0);
      if (overdueMs > HEALTHCHECK_PENDING_GRACE_MS) {
        await rollbackPending(pending, 'healthcheck-expired-pending');
      } else {
        // Do not interfere with an active confirm/rollback window.
        return;
      }
    }
    const result = await ensureUsableIpv4Config(HEALTHCHECK_IFACE);
    if (result && result.recovered) {
      console.warn(`network health-check recovered ${HEALTHCHECK_IFACE} to ${DEFAULT_RECOVERY_IP}${DEFAULT_RECOVERY_SUBNET}`);
    }
  } catch (e) {
    console.warn('network health-check failed', e && e.message ? e.message : e);
  } finally {
    healthCheckRunning = false;
  }
}

function startNetworkHealthCheckWatchdog() {
  setInterval(() => {
    runBackgroundHealthCheck().catch(() => {});
  }, HEALTHCHECK_INTERVAL_MS);
}

async function getCurrentIpv4Config(iface = 'eth0') {
  const addrOut = await execPromise(`nmcli -g IP4.ADDRESS device show ${iface}`, { timeout: 3000 });
  const gwOut = await execPromise(`nmcli -g IP4.GATEWAY device show ${iface}`, { timeout: 3000 });

  const entry = String(addrOut.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const gateway = String(gwOut.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => !!s && s !== '--') || null;

  const m = entry.match(/^([^/]+)(\/\d{1,2})$/);
  if (!m) return null;

  return {
    ip: m[1],
    subnet: m[2],
    gateway
  };
}

function normalizeGatewayValue(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s : null;
}

function sameNetworkConfig(a, b) {
  if (!a || !b) return false;
  const ipA = String(a.ip || '').trim();
  const ipB = String(b.ip || '').trim();
  const subnetA = String(a.subnet || '').trim();
  const subnetB = String(b.subnet || '').trim();
  const gwA = normalizeGatewayValue(a.gateway);
  const gwB = normalizeGatewayValue(b.gateway);
  return ipA === ipB && subnetA === subnetB && gwA === gwB;
}

function clearPending(iface) {
  const pending = pendingByIface.get(iface);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingByIface.delete(iface);
  persistPendingStore();
}

function persistPendingStore() {
  try {
    const obj = {};
    for (const [iface, p] of pendingByIface.entries()) {
      obj[iface] = {
        token: p.token,
        iface: p.iface,
        previous: p.previous,
        next: p.next,
        expiresAt: p.expiresAt,
        applying: !!p.applying
      };
    }
    fs.writeFileSync(PENDING_STORE_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.warn('persist pending store failed', e && e.message ? e.message : e);
  }
}

function schedulePendingTimeout(pending) {
  if (pending.timer) clearTimeout(pending.timer);
  const ms = Math.max(1, Number(pending.expiresAt || 0) - Date.now());
  pending.timer = setTimeout(() => {
    const live = pendingByIface.get(pending.iface);
    if (!live || live.token !== pending.token) return;
    rollbackPending(live, 'confirmation-timeout').catch(() => {});
  }, ms);
}

function loadPersistedPending() {
  try {
    if (!fs.existsSync(PENDING_STORE_FILE)) return;
    const raw = fs.readFileSync(PENDING_STORE_FILE, 'utf8');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;

    for (const iface of Object.keys(data)) {
      const entry = data[iface];
      if (!entry || typeof entry !== 'object') continue;
      if (!entry.token || !entry.iface || !entry.previous || !entry.next) continue;
      const expiresAt = Number(entry.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        const expiredPending = {
          token: String(entry.token),
          iface: String(entry.iface),
          previous: entry.previous,
          next: entry.next,
          expiresAt,
          applying: false,
          timer: null
        };
        rollbackPending(expiredPending, 'confirmation-timeout-recovered').catch(() => {});
        continue;
      }

      const pending = {
        token: String(entry.token),
        iface: String(entry.iface),
        previous: entry.previous,
        next: entry.next,
        expiresAt,
        applying: !!entry.applying,
        timer: null
      };
      pendingByIface.set(pending.iface, pending);
      schedulePendingTimeout(pending);
    }

    // Rewrite store to drop invalid/expired entries.
    persistPendingStore();
  } catch (e) {
    console.warn('load pending store failed', e && e.message ? e.message : e);
  }
}

function refreshPendingFromStore() {
  try {
    if (!fs.existsSync(PENDING_STORE_FILE)) return;
    const raw = fs.readFileSync(PENDING_STORE_FILE, 'utf8');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;

    let changed = false;
    for (const iface of Object.keys(data)) {
      const entry = data[iface];
      if (!entry || typeof entry !== 'object') continue;
      if (!entry.token || !entry.iface || !entry.previous || !entry.next) continue;

      const expiresAt = Number(entry.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        const existing = pendingByIface.get(String(entry.iface));
        if (existing && existing.token === String(entry.token)) {
          rollbackPending(existing, 'confirmation-timeout-recovered').catch(() => {});
        } else {
          const expiredPending = {
            token: String(entry.token),
            iface: String(entry.iface),
            previous: entry.previous,
            next: entry.next,
            expiresAt,
            applying: false,
            timer: null
          };
          rollbackPending(expiredPending, 'confirmation-timeout-recovered').catch(() => {});
        }
        changed = true;
        continue;
      }

      const ifaceKey = String(entry.iface);
      const token = String(entry.token);
      const existing = pendingByIface.get(ifaceKey);
      if (existing && existing.token === token) {
        existing.expiresAt = expiresAt;
        existing.previous = entry.previous;
        existing.next = entry.next;
        existing.applying = !!entry.applying;
        if (!existing.timer) schedulePendingTimeout(existing);
        continue;
      }

      const pending = {
        token,
        iface: ifaceKey,
        previous: entry.previous,
        next: entry.next,
        expiresAt,
        applying: !!entry.applying,
        timer: null
      };
      pendingByIface.set(ifaceKey, pending);
      schedulePendingTimeout(pending);
      changed = true;
    }

    if (changed) persistPendingStore();
  } catch (e) {
    console.warn('refresh pending store failed', e && e.message ? e.message : e);
  }
}

async function rollbackPending(pending, reason) {
  const target = (pending && pending.previous && pending.previous.ip && pending.previous.subnet)
    ? Object.assign({ iface: pending.iface }, pending.previous)
    : buildDefaultRecoveryConfig(pending && pending.iface ? pending.iface : 'eth0');
  try {
    // Always: set interface up, flush all IPs, assign only the target IP, flush ARP
    await execFilePromise('sudo', ['ip', 'link', 'set', 'dev', pending.iface, 'up'], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'addr', 'flush', 'dev', pending.iface, 'scope', 'global'], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'addr', 'add', `${target.ip}${target.subnet}`, 'dev', pending.iface], { timeout: 5000 });
    await execFilePromise('sudo', ['ip', 'neigh', 'flush', 'dev', pending.iface], { timeout: 5000 });
    await sleep(500);
    console.warn(`IP-Konfiguration für ${pending.iface} wurde zurückgesetzt (${reason})`);
  } catch (e) {
    console.error('Zurücksetzen der IP-Konfiguration fehlgeschlagen, setze Standard-IP', reason, e && e.err ? e.err.message : e);
    try {
      await forceAssignDefaultIp(pending.iface);
    } catch (e2) {
      console.error('Setzen der Standard-IP ebenfalls fehlgeschlagen', e2 && e2.err ? e2.err.message : e2);
    }
  } finally {
    clearPending(pending.iface);
  }
}

router.post('/apply', async (req, res) => {
  try {
    refreshPendingFromStore();
    const { iface='eth0', ip, subnet, gateway } = req.body || {};
    if (!ip || !subnet) return res.status(400).json({ error: 'Missing ip or subnet' });

    // basic validation (server-side)
    if (!isValidIpv4(ip) && ip.indexOf(':') === -1) {
      return res.status(400).json({ error: 'Invalid IP format' });
    }

    if (pendingByIface.has(iface)) {
      return res.status(409).json({
        error: 'Für dieses Interface wartet bereits eine unbestätigte IP-Änderung. Bitte erst bestätigen oder zurücksetzen.'
      });
    }

    const baseline = await ensureUsableIpv4Config(iface);
    const previous = baseline && baseline.config ? baseline.config : null;
    if (!previous || !previous.ip || !previous.subnet) {
      return res.status(500).json({ error: 'Aktuelle IP-Konfiguration konnte nicht wiederhergestellt werden.' });
    }

    const next = { iface, ip, subnet, gateway: gateway || null };
    if (sameNetworkConfig(previous, next)) {
      return res.json({
        ok: true,
        pending: false,
        unchanged: true,
        iface,
        recoveredBaseline: !!(baseline && baseline.recovered),
        message: 'Die gewünschte IP-Konfiguration ist bereits aktiv. Es wurde keine Änderung durchgeführt.',
        current: previous
      });
    }

    const token = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
    const expiresAt = Date.now() + CONFIRM_WINDOW_MS;
    const pending = {
      token,
      iface,
      previous,
      next,
      expiresAt,
      applying: true,
      timer: null
    };

    pendingByIface.set(iface, pending);
    persistPendingStore();

    try {
      // Always: set interface up, flush all IPs, assign only the new IP, flush ARP
      await execFilePromise('sudo', ['ip', 'link', 'set', 'dev', iface, 'up'], { timeout: 5000 });
      await execFilePromise('sudo', ['ip', 'addr', 'flush', 'dev', iface, 'scope', 'global'], { timeout: 5000 });
      await execFilePromise('sudo', ['ip', 'addr', 'add', `${ip}${subnet}`, 'dev', iface], { timeout: 5000 });
      await execFilePromise('sudo', ['ip', 'neigh', 'flush', 'dev', iface], { timeout: 5000 });
      await sleep(500);
    } catch (applyErr) {
      // Fehlerobjekt sauber serialisieren
      let msg = 'Unbekannter Fehler beim Anwenden der IP.';
      if (applyErr && applyErr.stderr) msg = String(applyErr.stderr).trim();
      else if (applyErr && applyErr.err && applyErr.err.message) msg = String(applyErr.err.message).trim();
      else if (applyErr && applyErr.stdout) msg = String(applyErr.stdout).trim();
      else if (typeof applyErr === 'string') msg = applyErr;
      else if (applyErr && typeof applyErr === 'object') msg = JSON.stringify(applyErr);
      try {
        const iface = String((req.body && req.body.iface) || 'eth0');
        clearPending(iface);
      } catch (_) {}
      console.error('apply-network error', applyErr);
      return res.status(500).json({ error: msg });
    }

    const live = pendingByIface.get(iface);
    if (live && live.token === token) {
      live.applying = false;
      const remainingMs = Math.max(0, Number(live.expiresAt || 0) - Date.now());
      if (remainingMs <= 0) {
        rollbackPending(live, 'confirmation-timeout').catch(() => {});
      } else {
        schedulePendingTimeout(live);
      }
      persistPendingStore();
    }

    const serverNowMs = Date.now();
    const remainingSec = Math.max(0, Math.ceil((expiresAt - serverNowMs) / 1000));

    return res.json({
      ok: true,
      pending: true,
      iface,
      token,
      expiresInSec: remainingSec,
      expiresAtMs: expiresAt,
      serverNowMs,
      applying: false,
      recoveredBaseline: !!(baseline && baseline.recovered),
      message: 'IP geändert. Bitte innerhalb von 60 Sekunden bestätigen, sonst wird automatisch zurückgesetzt.'
    });
  } catch (e) {
    try {
      const iface = String((req.body && req.body.iface) || 'eth0');
      clearPending(iface);
    } catch (_) {
      // Ignore cleanup failure.
    }
    let msg = 'Unbekannter Fehler.';
    if (e && e.stderr) msg = String(e.stderr).trim();
    else if (e && e.err && e.err.message) msg = String(e.err.message).trim();
    else if (e && e.stdout) msg = String(e.stdout).trim();
    else if (typeof e === 'string') msg = e;
    else if (e && typeof e === 'object') msg = JSON.stringify(e);
    console.error('apply-network catch', e);
    res.status(500).json({ error: msg });
  }
});

// POST /api/network/confirm { iface: 'eth0', token: '...' }
router.post('/confirm', async (req, res) => {
  try {
    refreshPendingFromStore();
    const iface = String((req.body && req.body.iface) || 'eth0');
    const token = String((req.body && req.body.token) || '').trim();
    const pending = pendingByIface.get(iface);
    if (!pending) return res.status(404).json({ error: 'Keine ausstehende IP-Änderung gefunden.' });
    if (!token || token !== pending.token) return res.status(400).json({ error: 'Ungültiges Bestätigungs-Token.' });
    clearPending(iface);
    return res.json({ ok: true, message: 'IP-Konfiguration bestätigt.' });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// POST /api/network/cancel { iface: 'eth0', token?: '...' }
router.post('/cancel', async (req, res) => {
  try {
    refreshPendingFromStore();
    const iface = String((req.body && req.body.iface) || 'eth0');
    const token = String((req.body && req.body.token) || '').trim();
    const pending = pendingByIface.get(iface);
    if (!pending) return res.status(404).json({ error: 'Keine ausstehende IP-Änderung gefunden.' });
    if (token && token !== pending.token) return res.status(400).json({ error: 'Ungültiges Bestätigungs-Token.' });

    try {
      await runApplyNetwork(pending.previous);
    } catch (_) {
      await runApplyNetwork(buildDefaultRecoveryConfig(iface));
    }
    clearPending(iface);
    return res.json({ ok: true, message: 'IP-Konfiguration wurde zurückgesetzt.' });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// GET /api/network/pending?iface=eth0
router.get('/pending', (req, res) => {
  refreshPendingFromStore();
  const iface = String((req.query.iface || 'eth0'));
  const pending = pendingByIface.get(iface);
  if (!pending) return res.json({ ok: true, pending: false, iface, serverNowMs: Date.now() });

  const now = Date.now();
  const remainingSec = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));
  return res.json({
    ok: true,
    pending: true,
    iface,
    token: pending.token,
    expiresInSec: remainingSec,
    expiresAtMs: pending.expiresAt,
    serverNowMs: now,
    applying: !!pending.applying,
    previous: pending.previous,
    next: pending.next
  });
});

// GET /api/network/status?iface=eth0
// Returns runtime info for the requested interface: { ok:true, iface, ips: [...], gateway: "..." }
router.get('/status', (req, res) => {
  const iface = String((req.query.iface || 'eth0'));

  // Query nmcli for IP4 addresses
  exec(`nmcli -g IP4.ADDRESS device show ${iface}`, { timeout: 3000 }, (errAddr, stdoutAddr) => {
    // parse lines like "192.168.0.151/24"
    const ips = (stdoutAddr || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    // Query nmcli for gateway
    exec(`nmcli -g IP4.GATEWAY device show ${iface}`, { timeout: 3000 }, (errGw, stdoutGw) => {
      let gw = null;
      if (stdoutGw) {
        const candidate = stdoutGw.split(/\r?\n/).map(s => s.trim()).find(Boolean);
        if (candidate && candidate !== '--') gw = candidate;
      }

      // Always return a stable JSON shape
      return res.json({ ok: true, iface, ips: ips || [], gateway: gw || null });
    });
  });
});

module.exports = router;

// Recover pending confirmation window after process restart.
loadPersistedPending();
startNetworkHealthCheckWatchdog();