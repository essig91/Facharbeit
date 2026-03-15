'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_STORE = path.resolve('/opt/process-logger/data/users.json');
const SESSION_COOKIE = 'process_logger_sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,32}$/;

const ROLE_LEVELS = Object.freeze({
  Trend: 1,
  Beobachten: 2,
  Bediener: 3,
  Administrator: 4,
  Systemadministrator: 5
});

const ROLE_NAMES = Object.keys(ROLE_LEVELS);
const sessions = new Map();

function nowMs() { return Date.now(); }

function ensureStoreDir() {
  const dir = path.dirname(USERS_STORE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeRoles(roles) {
  if (!Array.isArray(roles)) return [];
  const out = [];
  for (const r of roles) {
    const s = String(r || '').trim();
    if (!ROLE_LEVELS[s]) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function highestRoleLevel(roles) {
  const list = normalizeRoles(roles);
  let max = 0;
  for (const role of list) {
    const lvl = Number(ROLE_LEVELS[role] || 0);
    if (lvl > max) max = lvl;
  }
  return max;
}

function hasRoleAtLeast(roles, minRole) {
  const min = Number(ROLE_LEVELS[minRole] || 0);
  if (!min) return false;
  return highestRoleLevel(roles) >= min;
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password || ''), salt, 64);
  return { saltHex: salt.toString('hex'), hashHex: hash.toString('hex') };
}

function verifyPassword(password, saltHex, expectedHashHex) {
  if (!saltHex || !expectedHashHex) return false;
  const got = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 64);
  const exp = Buffer.from(expectedHashHex, 'hex');
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}

function userPasswordExpired(user) {
  if (!user) return false;
  const days = Number(user.passwordMaxAgeDays || 0);
  if (!Number.isFinite(days) || days <= 0) return false;
  const changedAt = Number(user.passwordChangedAt || 0);
  if (!Number.isFinite(changedAt) || changedAt <= 0) return false;
  return nowMs() > (changedAt + (days * 24 * 60 * 60 * 1000));
}

function parseCookies(req) {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  const out = {};
  if (!raw) return out;
  const parts = raw.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx <= 0) continue;
    const k = decodeURIComponent(p.slice(0, idx).trim());
    const v = decodeURIComponent(p.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}

function setSessionCookie(res, token) {
  const val = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
  res.setHeader('Set-Cookie', val);
}

function clearSessionCookie(res) {
  const val = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  res.setHeader('Set-Cookie', val);
}

function loadStore() {
  ensureStoreDir();
  try {
    const txt = fs.readFileSync(USERS_STORE, 'utf8');
    const data = JSON.parse(txt);
    if (!data || !Array.isArray(data.users)) return { users: [] };
    return data;
  } catch (_) {
    return { users: [] };
  }
}

function saveStore(store) {
  ensureStoreDir();
  fs.writeFileSync(USERS_STORE, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o640 });
}

function makeUser(username, password, roles, opts = {}) {
  const pwd = String(password || '');
  const hashed = pwd ? hashPassword(pwd) : { saltHex: '', hashHex: '' };
  return {
    username: String(username),
    roles: normalizeRoles(roles),
    passwordSalt: hashed.saltHex,
    passwordHash: hashed.hashHex,
    passwordChangedAt: pwd ? nowMs() : 0,
    passwordMaxAgeDays: Number.isFinite(Number(opts.passwordMaxAgeDays)) ? Number(opts.passwordMaxAgeDays) : 90,
    sessionTimeoutMinutes: Number.isFinite(Number(opts.sessionTimeoutMinutes)) ? Math.max(0, Math.floor(Number(opts.sessionTimeoutMinutes))) : 30,
    canDelete: opts.canDelete !== false,
    rolesLocked: opts.rolesLocked === true,
    passwordLocked: opts.passwordLocked === true,
    enabled: opts.enabled !== false
  };
}

function ensureDefaults() {
  const store = loadStore();
  const users = Array.isArray(store.users) ? store.users : [];

  function byName(name) {
    return users.find((u) => String(u.username || '').toLowerCase() === String(name || '').toLowerCase());
  }

  let changed = false;

  if (!byName('Anonym')) {
    users.push(makeUser('Anonym', '', [], {
      passwordMaxAgeDays: 0,
      sessionTimeoutMinutes: 0,
      canDelete: false,
      rolesLocked: false,
      passwordLocked: true,
      enabled: true
    }));
    changed = true;
  }

  if (!byName('Admin')) {
    users.push(makeUser('Admin', 'Admin', ['Administrator'], {
      passwordMaxAgeDays: 90,
      canDelete: true,
      rolesLocked: false,
      passwordLocked: false,
      enabled: true
    }));
    changed = true;
  }

  if (!byName('sys')) {
    users.push(makeUser('sys', 'Nk22525%', ['Systemadministrator'], {
      passwordMaxAgeDays: 0,
      canDelete: false,
      rolesLocked: true,
      passwordLocked: false,
      enabled: true
    }));
    changed = true;
  }

  const anonym = byName('Anonym');
  if (anonym) {
    const before = JSON.stringify(anonym);
    anonym.canDelete = false;
    anonym.rolesLocked = false;
    anonym.passwordLocked = true;
    anonym.passwordSalt = '';
    anonym.passwordHash = '';
    anonym.passwordChangedAt = 0;
    anonym.sessionTimeoutMinutes = 0;
    if (!Array.isArray(anonym.roles)) anonym.roles = [];
    if (JSON.stringify(anonym) !== before) changed = true;
  }

  const sys = byName('sys');
  if (sys) {
    const before = JSON.stringify(sys);
    sys.canDelete = false;
    sys.rolesLocked = true;
    sys.roles = ['Systemadministrator'];
    if (JSON.stringify(sys) !== before) changed = true;
  }

  store.users = users;
  if (changed) saveStore(store);
  return store;
}

function sanitizeUser(user) {
  return {
    username: String(user.username || ''),
    roles: normalizeRoles(user.roles),
    roleLevel: highestRoleLevel(user.roles),
    passwordMaxAgeDays: Number(user.passwordMaxAgeDays || 0),
    passwordExpired: userPasswordExpired(user),
    canDelete: user.canDelete !== false,
    rolesLocked: user.rolesLocked === true,
    passwordLocked: user.passwordLocked === true,
    sessionTimeoutMinutes: Number.isFinite(Number(user.sessionTimeoutMinutes)) ? Math.max(0, Number(user.sessionTimeoutMinutes)) : 30,
    enabled: user.enabled !== false
  };
}

function getUserByName(store, username) {
  const key = String(username || '').toLowerCase();
  return (store.users || []).find((u) => String(u.username || '').toLowerCase() === key) || null;
}

function allowedPagesByRoles(roles) {
  const level = highestRoleLevel(roles);
  const set = new Set(['index.html']);
  if (level >= ROLE_LEVELS.Beobachten) {
    set.add('data-archive.html');
    set.add('disturbance-logs.html');
  }
  if (level >= ROLE_LEVELS.Administrator) {
    set.add('system-settings.html');
    set.add('logpoints-config.html');
    set.add('opcua-config.html');
    set.add('usermanagement.html');
  }
  if (level >= ROLE_LEVELS.Systemadministrator) {
    set.add('devtools.html');
  }
  return Array.from(set.values());
}

function canAccessPage(pageName, roles) {
  const page = String(pageName || '').toLowerCase();
  if (!page || page === 'index.html') return true;
  return allowedPagesByRoles(roles).map((x) => String(x).toLowerCase()).includes(page);
}

function getAuthFromRequest(req) {
  const store = ensureDefaults();
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  const now = nowMs();

  if (sid) {
    const sess = sessions.get(sid);
    if (sess && Number(sess.expiresAt || 0) > now) {
      const user = getUserByName(store, sess.username);
      if (user && user.enabled !== false) {
        sess.expiresAt = now + (sess.timeoutMs || SESSION_TTL_MS);
        return { user, sid, anonymous: false };
      }
    }
    sessions.delete(sid);
  }

  const anonym = getUserByName(store, 'Anonym') || makeUser('Anonym', '', [], { passwordMaxAgeDays: 0, canDelete: false, passwordLocked: true });
  return { user: anonym, sid: null, anonymous: true };
}

function attachAuth(req, _res, next) {
  const auth = getAuthFromRequest(req);
  const u = auth.user;
  req.auth = {
    username: String(u.username || 'Anonym'),
    roles: normalizeRoles(u.roles),
    roleLevel: highestRoleLevel(u.roles),
    passwordExpired: userPasswordExpired(u),
    anonymous: !!auth.anonymous,
    sid: auth.sid || null,
    user: u
  };
  next();
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ ok: false, error: 'Nicht angemeldet.' });
    if (!hasRoleAtLeast(req.auth.roles, minRole)) {
      return res.status(403).json({ ok: false, error: 'Keine Berechtigung.' });
    }
    next();
  };
}

function requirePageAccess(req, res, next) {
  if (String(req.method || '').toUpperCase() !== 'GET') return next();
  const p = String(req.path || '').trim();
  if (!p.endsWith('.html')) return next();
  const page = p.split('/').pop();
  if (page.startsWith('_') || page.startsWith('partial')) return next();
  const roles = (req.auth && req.auth.roles) || [];

  // Datenarchiv:
  // - Vollseite nur ab Beobachten (Level 2)
  // - Embedded Trend (embedTrend=1) bereits ab Trend (Level 1)
  if (String(page).toLowerCase() === 'data-archive.html') {
    const level = highestRoleLevel(roles);
    const embedTrend = String((req.query && req.query.embedTrend) || '') === '1';
    if (embedTrend && level >= ROLE_LEVELS.Trend) return next();
    if (!embedTrend && level >= ROLE_LEVELS.Beobachten) return next();
    return res.status(403).type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>403</title></head><body><h1>403</h1><p>Keine Berechtigung für diese Seite.</p></body></html>');
  }

  if (canAccessPage(page, roles)) return next();
  return res.status(403).type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>403</title></head><body><h1>403</h1><p>Keine Berechtigung für diese Seite.</p></body></html>');
}

function createRouter() {
  const router = express.Router();

  router.get('/roles', (_req, res) => {
    const roles = ROLE_NAMES.map((name) => ({ name, level: ROLE_LEVELS[name] }));
    res.json({ ok: true, roles });
  });

  router.get('/me', (req, res) => {
    const auth = req.auth || getAuthFromRequest(req);
    const user = auth.user || makeUser('Anonym', '', [], { passwordMaxAgeDays: 0 });
    const clean = sanitizeUser(user);
    res.json({ ok: true, user: clean, anonymous: !!auth.anonymous, allowedPages: allowedPagesByRoles(clean.roles) });
  });

  router.post('/login', express.json(), (req, res) => {
    const store = ensureDefaults();
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');

    if (!username) return res.status(400).json({ ok: false, error: 'Benutzername fehlt.' });

    const user = getUserByName(store, username);
    if (!user || user.enabled === false) {
      return res.status(401).json({ ok: false, error: 'Benutzer oder Passwort ist falsch.' });
    }

    const isAnonym = String(user.username || '').toLowerCase() === 'anonym';
    if (!isAnonym) {
      if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
        return res.status(401).json({ ok: false, error: 'Benutzer oder Passwort ist falsch.' });
      }
      if (userPasswordExpired(user)) {
        return res.status(403).json({ ok: false, error: 'Passwort ist abgelaufen. Bitte Administrator kontaktieren.' });
      }
    }

    const sid = randomToken();
    const timeoutMs = user.sessionTimeoutMinutes > 0 ? user.sessionTimeoutMinutes * 60 * 1000 : SESSION_TTL_MS;
    sessions.set(sid, { username: user.username, createdAt: nowMs(), expiresAt: nowMs() + timeoutMs, timeoutMs });
    setSessionCookie(res, sid);
    return res.json({ ok: true, user: sanitizeUser(user), allowedPages: allowedPagesByRoles(user.roles) });
  });

  router.post('/logout', (req, res) => {
    const cookies = parseCookies(req);
    const sid = cookies[SESSION_COOKIE];
    if (sid) sessions.delete(sid);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/users', requireRole('Administrator'), (_req, res) => {
    const store = ensureDefaults();
    const users = (store.users || []).map(sanitizeUser);
    res.json({ ok: true, users });
  });

  router.post('/users', requireRole('Administrator'), express.json(), (req, res) => {
    const store = ensureDefaults();
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const roles = normalizeRoles(body.roles || []).slice(0, 1);
    const maxAge = Number(body.passwordMaxAgeDays);

    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ ok: false, error: 'Ungueltiger Benutzername (2-32 Zeichen, A-Z, a-z, 0-9, _ . -).' });
    }
    if (getUserByName(store, username)) {
      return res.status(409).json({ ok: false, error: 'Benutzer existiert bereits.' });
    }
    if (String(username).toLowerCase() === 'anonym') {
      return res.status(400).json({ ok: false, error: 'Benutzername Anonym ist reserviert.' });
    }

    const u = makeUser(username, password, roles, {
      passwordMaxAgeDays: Number.isFinite(maxAge) ? Math.max(0, Math.floor(maxAge)) : 90,
      canDelete: true,
      rolesLocked: false,
      passwordLocked: false,
      enabled: true
    });

    store.users.push(u);
    saveStore(store);
    res.status(201).json({ ok: true, user: sanitizeUser(u) });
  });

  router.put('/users/:username', requireRole('Administrator'), express.json(), (req, res) => {
    const store = ensureDefaults();
    const targetName = String(req.params.username || '').trim();
    const body = req.body || {};
    const user = getUserByName(store, targetName);
    if (!user) return res.status(404).json({ ok: false, error: 'Benutzer nicht gefunden.' });

    const isSys = String(user.username).toLowerCase() === 'sys';
    const isAnonym = String(user.username).toLowerCase() === 'anonym';

    if (body.roles !== undefined) {
      if (user.rolesLocked || isSys) {
        return res.status(400).json({ ok: false, error: 'Rollen fuer diesen Benutzer sind gesperrt.' });
      }
      user.roles = normalizeRoles(body.roles).slice(0, 1);
    }

    if (body.passwordMaxAgeDays !== undefined) {
      const n = Number(body.passwordMaxAgeDays);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, error: 'passwordMaxAgeDays muss >= 0 sein.' });
      }
      user.passwordMaxAgeDays = Math.floor(n);
    }

    if (body.sessionTimeoutMinutes !== undefined) {
      const n = Number(body.sessionTimeoutMinutes);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, error: 'sessionTimeoutMinutes muss >= 0 sein.' });
      }
      user.sessionTimeoutMinutes = Math.floor(n);
    }

    if (body.enabled !== undefined) {
      const requestedEnabled = !!body.enabled;
      if ((isSys || isAnonym) && !requestedEnabled) {
        return res.status(400).json({ ok: false, error: 'Dieser Benutzer kann nicht deaktiviert werden.' });
      }
      if (!isSys && !isAnonym) {
        user.enabled = requestedEnabled;
      }
    }

    if (body.password !== undefined) {
      if (user.passwordLocked || isAnonym) {
        return res.status(400).json({ ok: false, error: 'Passwort fuer diesen Benutzer ist gesperrt.' });
      }
      const pwd = String(body.password || '');
      if (!pwd) {
        user.passwordSalt = '';
        user.passwordHash = '';
        user.passwordChangedAt = 0;
      } else {
        const h = hashPassword(pwd);
        user.passwordSalt = h.saltHex;
        user.passwordHash = h.hashHex;
        user.passwordChangedAt = nowMs();
      }
    }

    saveStore(store);
    res.json({ ok: true, user: sanitizeUser(user) });
  });

  router.delete('/users/:username', requireRole('Administrator'), (req, res) => {
    const store = ensureDefaults();
    const targetName = String(req.params.username || '').trim();
    const idx = (store.users || []).findIndex((u) => String(u.username || '').toLowerCase() === targetName.toLowerCase());
    if (idx < 0) return res.status(404).json({ ok: false, error: 'Benutzer nicht gefunden.' });

    const user = store.users[idx];
    const uname = String(user.username || '').toLowerCase();
    if (uname === 'sys' || uname === 'anonym' || user.canDelete === false) {
      return res.status(400).json({ ok: false, error: 'Dieser Benutzer kann nicht geloescht werden.' });
    }

    store.users.splice(idx, 1);
    saveStore(store);
    res.json({ ok: true });
  });

  return router;
}

ensureDefaults();

module.exports = {
  ROLE_LEVELS,
  ROLE_NAMES,
  normalizeRoles,
  highestRoleLevel,
  hasRoleAtLeast,
  allowedPagesByRoles,
  canAccessPage,
  attachAuth,
  requireRole,
  requirePageAccess,
  createRouter
};
