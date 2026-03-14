const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const router = express.Router();
const LOGGER_SERVICE_NAME = process.env.LOGGER_SERVICE_NAME || 'process-logger.service';

function roleLevel(req) {
  const roles = (req && req.auth && Array.isArray(req.auth.roles)) ? req.auth.roles : [];
  if (roles.includes('Systemadministrator')) return 5;
  if (roles.includes('Administrator')) return 4;
  if (roles.includes('Bediener')) return 3;
  if (roles.includes('Beobachten')) return 2;
  if (roles.includes('Trend')) return 1;
  return 0;
}

function requireAdministrator(req, res, next) {
  if (roleLevel(req) < 4) return res.status(403).json({ ok: false, error: 'Keine Berechtigung.' });
  next();
}

function runFile(cmd, args = []) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

function isPermissionError(e) {
  const msg = String((e && e.stderr) || (e && e.err && e.err.message) || '').toLowerCase();
  return msg.includes('a password is required') || msg.includes('permission denied') || msg.includes('not permitted');
}

async function runPrivileged(cmd, args = []) {
  // 1) Try direct execution first (works if service already runs with needed privileges).
  try {
    return await runFile(cmd, args);
  } catch (directErr) {
    // 2) Fallback to non-interactive sudo. "-n" prevents password prompts.
    try {
      return await runFile('/usr/bin/sudo', ['-n', cmd, ...args]);
    } catch (sudoErr) {
      if (isPermissionError(sudoErr)) {
        const wrapped = new Error('Keine Berechtigung zum Ausführen ohne Passwort. Bitte sudoers für diesen Befehl konfigurieren.');
        wrapped.original = sudoErr;
        throw wrapped;
      }
      throw sudoErr;
    }
  }
}

async function setChronySyncEnabled(enabled) {
  const action = enabled ? 'online' : 'offline';
  await runPrivileged('/usr/bin/chronyc', [action]);
}

async function readChronySystemOffsetSeconds() {
  const out = await runPrivileged('/usr/bin/chronyc', ['tracking']);
  const txt = String((out && out.stdout) || '');
  // Example line: "System time     : 7261.462890625 seconds slow of NTP time"
  const m = txt.match(/System\s+time\s*:\s*([+-]?\d+(?:\.\d+)?)\s+seconds/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

async function autoCorrectLargeTimeDrift(forceStep) {
  const MAX_DRIFT_SECONDS = 5;
  if (forceStep) {
    await runPrivileged('/usr/bin/chronyc', ['-a', 'makestep']);
    return { stepped: true, reason: 'forced' };
  }

  const drift = await readChronySystemOffsetSeconds();
  if (drift !== null && drift >= MAX_DRIFT_SECONDS) {
    await runPrivileged('/usr/bin/chronyc', ['-a', 'makestep']);
    return { stepped: true, reason: 'drift', driftSeconds: drift };
  }

  return { stepped: false, driftSeconds: drift };
}

async function readChronySyncEnabled() {
  // chronyc activity reports whether sources are currently online/offline.
  const out = await runPrivileged('/usr/bin/chronyc', ['activity']);
  const txt = String((out && out.stdout) || '').toLowerCase();
  const mOnline = txt.match(/(\d+)\s+sources\s+online/);
  const mOffline = txt.match(/(\d+)\s+sources\s+offline/);
  const online = mOnline ? Number(mOnline[1]) : 0;
  const offline = mOffline ? Number(mOffline[1]) : 0;

  // If at least one source is online, synchronization is enabled.
  if (Number.isFinite(online) && online > 0) return true;
  if (Number.isFinite(offline) && offline > 0) return false;

  // Fallback: unknown state, prefer enabled to avoid false disabling in UI.
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseChronySources(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const rows = lines
    .map((line) => {
      const m = line.match(/^\s*[\^=#]([*+\-?x~])\s+(\S+)/);
      if (!m) return null;
      return {
        state: m[1],
        name: String(m[2] || '').trim().toLowerCase(),
        raw: line
      };
    })
    .filter(Boolean);
  return { rows };
}

async function resolveServerCandidates(serverHint) {
  const base = String(serverHint || '').trim().toLowerCase();
  const out = new Set();
  if (!base) return out;
  out.add(base);

  // If user entered an IPv4-looking value, validate octets and fail fast on invalid IPs.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(base)) {
    const octets = base.split('.').map((x) => Number(x));
    const valid = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
    if (!valid) return new Set();
    return out;
  }

  try {
    const res = await runFile('/usr/bin/getent', ['ahostsv4', base]);
    const ips = String((res && res.stdout) || '')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip));
    ips.forEach((ip) => out.add(String(ip).toLowerCase()));
  } catch (_) {
    // DNS resolution can fail for invalid hosts; verification will fail below.
  }

  return out;
}

async function verifyChronySourceUsable(serverHint) {
  const candidates = await resolveServerCandidates(serverHint);
  if (!candidates.size) {
    return { ok: false, error: 'NTP-Server ungültig.' };
  }
  const attempts = 4;

  for (let i = 0; i < attempts; i++) {
    const out = await runPrivileged('/usr/bin/chronyc', ['sources', '-v']);
    const txt = String((out && out.stdout) || '');
    const parsed = parseChronySources(txt);

    const matchingRows = parsed.rows.filter((row) => candidates.has(row.name));

    if (matchingRows.length > 0) {
      const hasUsable = matchingRows.some((r) => r.state !== '?' && r.state !== 'x' && r.state !== '~');
      if (hasUsable) return { ok: true };
    }

    if (i < attempts - 1) await sleep(500);
  }

  return { ok: false, error: 'NTP-Server nicht erreichbar oder ungültig. Bitte Serveradresse prüfen.' };
}

function readConfiguredNtpServerFromChronyConf() {
  try {
    const conf = fs.readFileSync('/etc/chrony/chrony.conf', 'utf8');
    const lines = String(conf || '').split(/\r?\n/);
    for (const line of lines) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const m = s.match(/^(server|pool)\s+(\S+)/i);
      if (m && m[2]) return String(m[2]).trim();
    }
  } catch (_) {
    // ignore and fallback below
  }
  return '';
}

function normalizeManualLocalDateTime(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const sec = m[6] || '00';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${sec}`;
}

function isLikelyTimezoneName(tz) {
  const s = String(tz || '').trim();
  if (!s) return false;
  if (s === 'UTC') return true;
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(s);
}

// POST /api/ntp { "server":"192.168.0.10", "applyNow": false, "syncEnabled": true }
router.post('/ntp', requireAdministrator, async (req, res) => {
  const { server, applyNow, syncEnabled } = req.body || {};
  if (!server) return res.status(400).json({ ok: false, error: 'server required' });

  try {
    const forceStep = !!applyNow;
    const shouldSync = (typeof syncEnabled === 'boolean') ? syncEnabled : true;

    await runPrivileged('/usr/local/sbin/set-chrony-server.sh', [server]);

    // Always verify the configured server once while online.
    await setChronySyncEnabled(true);
    const verify = await verifyChronySourceUsable(server);
    if (!verify.ok) {
      // Keep sync disabled when verification failed to avoid misleading active state.
      await setChronySyncEnabled(false);
      throw new Error(verify.error || 'NTP-Serverprüfung fehlgeschlagen.');
    }

    if (shouldSync) {
      const correction = await autoCorrectLargeTimeDrift(forceStep);
      return res.json({ ok: true, syncEnabled: true, correction, message: 'Übernommen, NTP Server verbunden.' });
    }

    await setChronySyncEnabled(false);
    return res.json({ ok: true, syncEnabled: false, correction: { stepped: false, reason: 'sync-disabled' }, message: 'Server geprüft und gespeichert (Sync aus).' });
  } catch (e) {
    // aussagekräftig loggen, damit wir den Fehler sehen
    console.error('ntp-api error:', JSON.stringify({
      errMessage: e.err && e.err.message,
      code: e.err && e.err.code,
      stdout: e.stdout && e.stdout.toString().slice(0,1000),
      stderr: e.stderr && e.stderr.toString().slice(0,1000)
    }, null, 2));
    // verständliche Fehlermeldung an Client
    const clientMsg = e && e.message
      ? String(e.message)
      : ((e.stderr && e.stderr.toString()) || (e.err && e.err.message) || 'Interner Fehler');
    return res.status(500).json({ ok: false, error: clientMsg });
  }
});

// POST /api/time/manual { "dateTimeLocal":"2026-03-11T15:40" }
router.post('/time/manual', requireAdministrator, async (req, res) => {
  const normalized = normalizeManualLocalDateTime(req.body && req.body.dateTimeLocal);
  if (!normalized) {
    return res.status(400).json({ ok: false, error: 'dateTimeLocal invalid' });
  }

  try {
    // Disable Chrony sync before setting manual time.
    await setChronySyncEnabled(false);
    await runPrivileged('/bin/date', ['-s', normalized]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('manual-time error:', JSON.stringify({
      errMessage: e.err && e.err.message,
      code: e.err && e.err.code,
      stdout: e.stdout && e.stdout.toString().slice(0, 1000),
      stderr: e.stderr && e.stderr.toString().slice(0, 1000)
    }, null, 2));
    const clientMsg = e && e.message
      ? String(e.message)
      : ((e.stderr && e.stderr.toString()) || (e.err && e.err.message) || 'Interner Fehler');
    return res.status(500).json({ ok: false, error: clientMsg });
  }
});

// POST /api/time/ntp-sync { "enabled": true|false }
router.post('/time/ntp-sync', requireAdministrator, async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  try {
    await setChronySyncEnabled(enabled);
    return res.json({ ok: true, ntpSyncEnabled: enabled });
  } catch (e) {
    const clientMsg = e && e.message
      ? String(e.message)
      : ((e.stderr && e.stderr.toString()) || (e.err && e.err.message) || 'Interner Fehler');
    return res.status(500).json({ ok: false, error: clientMsg });
  }
});

// POST /api/time/timezone { "timezone":"Europe/Berlin" }
router.post('/time/timezone', requireAdministrator, async (req, res) => {
  const timezone = String((req.body && req.body.timezone) || '').trim();
  if (!timezone || !isLikelyTimezoneName(timezone)) {
    return res.status(400).json({ ok: false, error: 'timezone invalid' });
  }

  try {
    await runPrivileged('/usr/bin/timedatectl', ['set-timezone', timezone]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('timezone error:', JSON.stringify({
      errMessage: e.err && e.err.message,
      code: e.err && e.err.code,
      stdout: e.stdout && e.stdout.toString().slice(0, 1000),
      stderr: e.stderr && e.stderr.toString().slice(0, 1000)
    }, null, 2));
    const clientMsg = e && e.message
      ? String(e.message)
      : ((e.stderr && e.stderr.toString()) || (e.err && e.err.message) || 'Interner Fehler');
    return res.status(500).json({ ok: false, error: clientMsg });
  }
});

// GET /api/time/status
router.get('/time/status', async (_req, res) => {
  try {
    const tz = await runFile('/usr/bin/timedatectl', ['show', '-p', 'Timezone', '--value']);
    const timezone = String((tz.stdout || '').trim() || 'UTC');
    const ntpSyncEnabled = await readChronySyncEnabled();
    const ntpServer = readConfiguredNtpServerFromChronyConf();
    const now = new Date();
    const systemTimeIso = now.toISOString();
    const systemTimeLocal = now.toLocaleString('de-DE', { timeZone: timezone });
    return res.json({ ok: true, timezone, systemTimeIso, systemTimeLocal, ntpSyncEnabled, ntpServer });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'time status failed' });
  }
});

// GET /api/time/timezones
router.get('/time/timezones', async (_req, res) => {
  try {
    const out = await runFile('/usr/bin/timedatectl', ['list-timezones']);
    const list = String(out.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return res.json({ ok: true, timezones: list });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'timezone list failed' });
  }
});

// POST /api/system/restart-logger
router.post('/system/restart-logger', requireAdministrator, async (_req, res) => {
  try {
    await runPrivileged('/bin/systemctl', ['restart', LOGGER_SERVICE_NAME]);
    return res.json({ ok: true, service: LOGGER_SERVICE_NAME });
  } catch (e) {
    const clientMsg = e && e.message
      ? String(e.message)
      : ((e.stderr && e.stderr.toString()) || (e.err && e.err.message) || 'Interner Fehler');
    return res.status(500).json({ ok: false, error: clientMsg });
  }
});

// POST /api/system/reboot
router.post('/system/reboot', requireAdministrator, async (_req, res) => {
  try {
    // "systemctl reboot" returns quickly and then the host restarts.
    await runPrivileged('/bin/systemctl', ['reboot']);
    return res.json({ ok: true });
  } catch (e) {
    const clientMsg = e && e.message
      ? String(e.message)
      : ((e.stderr && e.stderr.toString()) || (e.err && e.err.message) || 'Interner Fehler');
    return res.status(500).json({ ok: false, error: clientMsg });
  }
});

module.exports = router;
