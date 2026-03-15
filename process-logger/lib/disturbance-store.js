'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const logpointStore = require('./logpoint-store');
const measurementStore = require('./measurement-store');

let PDFDocument = null;
try {
  PDFDocument = require('pdfkit');
} catch (_) {
  PDFDocument = null;
}

const dataDir = process.env.PROCESS_LOGGER_DATA_DIR || '/opt/process-logger/data';
const dbPath = path.join(dataDir, 'disturbances.db');
const TREND_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf', '#8c564b'];
const connectionsConfigPath = path.join(__dirname, '..', 'config', 'opcua-connections.json');

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
}

function toIntId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(input, fallback) {
  try {
    return JSON.parse(String(input || ''));
  } catch (_) {
    return fallback;
  }
}

function normalizeBoolLike(v, fallback = true) {
  if (v === true || v === false) return v;
  const s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === 'wahr' || s === 'ein') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'falsch' || s === 'aus') return false;
  return !!fallback;
}

function isBooleanDataType(lp) {
  const dt = String((lp && lp.dataType) || '').toLowerCase();
  return dt === 'boolean' || dt.includes('bool');
}

function isNumericDataType(lp) {
  if (!lp) return false;
  if (isBooleanDataType(lp)) return false;
  const dt = String(lp.dataType || '').toLowerCase();
  if (!dt) return true;
  if (dt.includes('string') || dt === 'date' || dt === 'time') return false;
  return true;
}

function makeDefaultRule(logpointId, lp) {
  const boolMode = isBooleanDataType(lp);
  return {
    logpointId: Number(logpointId),
    enabled: false,
    mode: boolMode ? 'boolean' : 'numeric',
    boolAlarmValue: true,
    minEnabled: false,
    maxEnabled: false,
    minLimit: null,
    maxLimit: null,
    activationDelayMs: 0,
    trendWindowMs: 10 * 60_000,
    name: String((lp && (lp.displayName || lp.browseName)) || `Ereignis ${logpointId}`),
    causeTemplate: 'Ausgelöst durch {{ereignisname}} (Wert: {{wert}}).',
    hintsTemplate: 'Anlagezustand prüfen\nUrsache dokumentieren\nMaßnahmen einleiten',
    relatedLogpointIds: []
  };
}

function normalizeRelatedLogpointIds(input, ownLogpointId) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = toIntId(entry);
    if (!id) continue;
    if (id === ownLogpointId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeRuleInput(existing, lp, patch) {
  const base = Object.assign({}, existing || makeDefaultRule(lp.id, lp));
  const incoming = patch || {};
  const ownId = Number(lp.id);

  const boolMode = isBooleanDataType(lp);
  const numericMode = isNumericDataType(lp);
  let mode = String(incoming.mode || base.mode || (boolMode ? 'boolean' : 'numeric')).toLowerCase();
  if (!boolMode && mode === 'boolean') mode = 'numeric';
  if (!numericMode && mode === 'numeric') mode = 'boolean';

  const activationDelayMs = Math.max(0, Math.min(24 * 3600_000, Math.floor(Number(incoming.activationDelayMs ?? base.activationDelayMs ?? 0) || 0)));

  const minEnabled = normalizeBoolLike(incoming.minEnabled ?? base.minEnabled, false);
  const maxEnabled = normalizeBoolLike(incoming.maxEnabled ?? base.maxEnabled, false);

  const minLimitRaw = incoming.minLimit ?? base.minLimit;
  const maxLimitRaw = incoming.maxLimit ?? base.maxLimit;

  const minLimitNum = Number(minLimitRaw);
  const maxLimitNum = Number(maxLimitRaw);

  const minLimit = Number.isFinite(minLimitNum) ? minLimitNum : null;
  const maxLimit = Number.isFinite(maxLimitNum) ? maxLimitNum : null;

  const relatedIds = normalizeRelatedLogpointIds(incoming.relatedLogpointIds ?? base.relatedLogpointIds, ownId);

  return {
    logpointId: ownId,
    enabled: normalizeBoolLike(incoming.enabled ?? base.enabled, false),
    mode,
    boolAlarmValue: normalizeBoolLike(incoming.boolAlarmValue ?? base.boolAlarmValue, true),
    minEnabled,
    maxEnabled,
    minLimit,
    maxLimit,
    activationDelayMs,
    trendWindowMs: Math.max(60_000, Math.min(24 * 3600_000, Math.floor(Number(incoming.trendWindowMs ?? base.trendWindowMs ?? (10 * 60_000)) || (10 * 60_000)))),
    name: String(incoming.name ?? base.name ?? '').trim() || String(lp.displayName || lp.browseName || `Ereignis ${ownId}`),
    causeTemplate: String(incoming.causeTemplate ?? base.causeTemplate ?? '').trim() || 'Ausgelöst durch {{ereignisname}} (Wert: {{wert}}).',
    hintsTemplate: String(incoming.hintsTemplate ?? base.hintsTemplate ?? '').trim() || 'Anlagezustand prüfen\nUrsache dokumentieren\nMaßnahmen einleiten',
    relatedLogpointIds: relatedIds
  };
}

function openDb() {
  ensureDir();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS disturbance_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logpoint_id INTEGER NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'numeric',
      bool_alarm_value INTEGER NOT NULL DEFAULT 1,
      min_enabled INTEGER NOT NULL DEFAULT 0,
      max_enabled INTEGER NOT NULL DEFAULT 0,
      min_limit REAL,
      max_limit REAL,
      activation_delay_ms INTEGER NOT NULL DEFAULT 0,
      trend_window_ms INTEGER NOT NULL DEFAULT 600000,
      name TEXT,
      cause_template TEXT,
      hints_template TEXT,
      related_logpoint_ids TEXT,
      runtime_active INTEGER NOT NULL DEFAULT 0,
      runtime_active_since_ts INTEGER,
      runtime_last_event_id INTEGER,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS disturbance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      logpoint_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      triggered_ts INTEGER NOT NULL,
      resolved_ts INTEGER,
      trigger_value TEXT,
      resolved_value TEXT,
      protocol_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY(rule_id) REFERENCES disturbance_rules(id)
    );

    CREATE INDEX IF NOT EXISTS idx_disturbance_rules_logpoint ON disturbance_rules(logpoint_id);
    CREATE INDEX IF NOT EXISTS idx_disturbance_events_triggered_ts ON disturbance_events(triggered_ts);
    CREATE INDEX IF NOT EXISTS idx_disturbance_events_logpoint ON disturbance_events(logpoint_id);
  `);

  const cols = db.prepare('PRAGMA table_info(disturbance_rules)').all().map((r) => String(r.name || ''));
  if (!cols.includes('trend_window_ms')) {
    db.prepare('ALTER TABLE disturbance_rules ADD COLUMN trend_window_ms INTEGER NOT NULL DEFAULT 600000').run();
  }
  if (!cols.includes('hints_template')) {
    db.prepare("ALTER TABLE disturbance_rules ADD COLUMN hints_template TEXT").run();
  }

  return db;
}

const db = openDb();

function mapRuleRow(row) {
  if (!row) return null;
  const related = safeJsonParse(row.related_logpoint_ids, []);
  return {
    id: Number(row.id),
    logpointId: Number(row.logpoint_id),
    enabled: !!row.enabled,
    mode: String(row.mode || 'numeric'),
    boolAlarmValue: !!row.bool_alarm_value,
    minEnabled: !!row.min_enabled,
    maxEnabled: !!row.max_enabled,
    minLimit: row.min_limit === null || row.min_limit === undefined ? null : Number(row.min_limit),
    maxLimit: row.max_limit === null || row.max_limit === undefined ? null : Number(row.max_limit),
    activationDelayMs: Number(row.activation_delay_ms || 0),
    trendWindowMs: Math.max(60_000, Number(row.trend_window_ms || (10 * 60_000))),
    name: String(row.name || ''),
    causeTemplate: String(row.cause_template || ''),
    hintsTemplate: String(row.hints_template || ''),
    relatedLogpointIds: Array.isArray(related) ? related.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0) : [],
    runtimeActive: !!row.runtime_active,
    runtimeActiveSinceTs: Number.isFinite(Number(row.runtime_active_since_ts)) ? Number(row.runtime_active_since_ts) : null,
    runtimeLastEventId: Number.isFinite(Number(row.runtime_last_event_id)) ? Number(row.runtime_last_event_id) : null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function getAvailableAlarmLogpoints() {
  return (logpointStore.list() || []).filter((lp) => !!lp.isAlarm);
}

function getRuleByLogpointId(logpointId) {
  const id = toIntId(logpointId);
  if (!id) return null;
  const row = db.prepare('SELECT * FROM disturbance_rules WHERE logpoint_id = ? LIMIT 1').get(id);
  return mapRuleRow(row);
}

function listRules() {
  const rows = db.prepare('SELECT * FROM disturbance_rules ORDER BY updated_at DESC, id DESC').all();
  return rows.map(mapRuleRow);
}

function listRulesWithLogpointDetails() {
  const lps = logpointStore.list() || [];
  const byId = new Map(lps.map((lp) => [Number(lp.id), lp]));
  const alarmLogpoints = lps.filter((lp) => !!lp.isAlarm);

  return alarmLogpoints.map((lp) => {
    const r = getRuleByLogpointId(lp.id);
    const out = r || makeDefaultRule(lp.id, lp);
    return {
      rule: out,
      logpoint: lp,
      relatedChoices: lps
        .filter((cand) => Number(cand.id) !== Number(lp.id))
        .map((cand) => ({
          id: Number(cand.id),
          connectionId: String(cand.connectionId || ''),
          name: String(cand.displayName || cand.browseName || cand.nodeId || `Logpoint ${cand.id}`),
          dataType: String(cand.dataType || ''),
          unit: String(cand.unit || '')
        })),
      relatedConfigured: (out.relatedLogpointIds || []).map((rid) => {
        const rel = byId.get(Number(rid));
        return rel
          ? {
              id: Number(rel.id),
              connectionId: String(rel.connectionId || ''),
              name: String(rel.displayName || rel.browseName || rel.nodeId || `Logpoint ${rel.id}`),
              dataType: String(rel.dataType || ''),
              unit: String(rel.unit || '')
            }
          : { id: Number(rid), missing: true };
      })
    };
  });
}

function upsertRule(logpointId, patch) {
  const id = toIntId(logpointId);
  if (!id) throw new Error('ungültige logpointId');

  const lp = logpointStore.get(id);
  if (!lp) throw new Error('Logpoint nicht gefunden');
  if (!lp.isAlarm) throw new Error('Logpoint ist nicht als Ereignis markiert');

  const existing = getRuleByLogpointId(id);
  const normalized = normalizeRuleInput(existing, lp, patch);
  const now = nowIso();

  if (existing) {
    db.prepare(`
      UPDATE disturbance_rules
      SET enabled = @enabled,
          mode = @mode,
          bool_alarm_value = @boolAlarmValue,
          min_enabled = @minEnabled,
          max_enabled = @maxEnabled,
          min_limit = @minLimit,
          max_limit = @maxLimit,
          activation_delay_ms = @activationDelayMs,
          trend_window_ms = @trendWindowMs,
          name = @name,
          cause_template = @causeTemplate,
          hints_template = @hintsTemplate,
          related_logpoint_ids = @relatedLogpointIds,
          updated_at = @updatedAt
      WHERE logpoint_id = @logpointId
    `).run({
      logpointId: normalized.logpointId,
      enabled: normalized.enabled ? 1 : 0,
      mode: normalized.mode,
      boolAlarmValue: normalized.boolAlarmValue ? 1 : 0,
      minEnabled: normalized.minEnabled ? 1 : 0,
      maxEnabled: normalized.maxEnabled ? 1 : 0,
      minLimit: normalized.minLimit,
      maxLimit: normalized.maxLimit,
      activationDelayMs: normalized.activationDelayMs,
      trendWindowMs: normalized.trendWindowMs,
      name: normalized.name,
      causeTemplate: normalized.causeTemplate,
      hintsTemplate: normalized.hintsTemplate,
      relatedLogpointIds: JSON.stringify(normalized.relatedLogpointIds || []),
      updatedAt: now
    });
  } else {
    db.prepare(`
      INSERT INTO disturbance_rules (
        logpoint_id, enabled, mode, bool_alarm_value, min_enabled, max_enabled, min_limit, max_limit,
        activation_delay_ms, trend_window_ms, name, cause_template, hints_template, related_logpoint_ids,
        runtime_active, runtime_active_since_ts, runtime_last_event_id,
        created_at, updated_at
      ) VALUES (
        @logpointId, @enabled, @mode, @boolAlarmValue, @minEnabled, @maxEnabled, @minLimit, @maxLimit,
        @activationDelayMs, @trendWindowMs, @name, @causeTemplate, @hintsTemplate, @relatedLogpointIds,
        0, NULL, NULL,
        @createdAt, @updatedAt
      )
    `).run({
      logpointId: normalized.logpointId,
      enabled: normalized.enabled ? 1 : 0,
      mode: normalized.mode,
      boolAlarmValue: normalized.boolAlarmValue ? 1 : 0,
      minEnabled: normalized.minEnabled ? 1 : 0,
      maxEnabled: normalized.maxEnabled ? 1 : 0,
      minLimit: normalized.minLimit,
      maxLimit: normalized.maxLimit,
      activationDelayMs: normalized.activationDelayMs,
      trendWindowMs: normalized.trendWindowMs,
      name: normalized.name,
      causeTemplate: normalized.causeTemplate,
      hintsTemplate: normalized.hintsTemplate,
      relatedLogpointIds: JSON.stringify(normalized.relatedLogpointIds || []),
      createdAt: now,
      updatedAt: now
    });
  }

  return getRuleByLogpointId(id);
}

function replaceTemplate(input, vars) {
  const txt = String(input || '');
  return txt.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return '';
    const value = vars[key];
    if (value === null || value === undefined) return '';
    return String(value);
  });
}

function normalizeBooleanValue(raw) {
  if (raw === true || raw === false) return raw;
  const s = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'wahr' || s === 'ein' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'falsch' || s === 'aus' || s === 'off') return false;
  return null;
}

function evaluateCondition(rule, rawValue) {
  if (!rule || !rule.enabled) return { matched: false, reason: 'disabled' };

  if (rule.mode === 'boolean') {
    const b = normalizeBooleanValue(rawValue);
    if (b === null) return { matched: false, reason: 'non-boolean' };
    return {
      matched: b === !!rule.boolAlarmValue,
      reason: b === !!rule.boolAlarmValue ? 'boolean-match' : 'boolean-mismatch',
      normalizedValue: b
    };
  }

  const num = Number(rawValue);
  if (!Number.isFinite(num)) {
    return { matched: false, reason: 'non-numeric' };
  }

  let matchMin = false;
  let matchMax = false;

  if (rule.minEnabled && Number.isFinite(rule.minLimit)) {
    matchMin = num < Number(rule.minLimit);
  }
  if (rule.maxEnabled && Number.isFinite(rule.maxLimit)) {
    matchMax = num > Number(rule.maxLimit);
  }

  const matched = !!(matchMin || matchMax);
  return {
    matched,
    reason: matched ? 'numeric-limit' : 'numeric-ok',
    normalizedValue: num
  };
}

function getLatestValueForLogpoint(lp, refTs) {
  if (!lp) return null;
  const tsTo = Number(refTs) || Date.now();
  const tsFrom = tsTo - (24 * 3600_000);
  const rows = measurementStore.query(lp.connectionId, lp.id, tsFrom, tsTo, 1);
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      logpointId: Number(lp.id),
      name: String(lp.displayName || lp.browseName || lp.nodeId || `Logpoint ${lp.id}`),
      value: null,
      ts: null,
      unit: String(lp.unit || ''),
      connectionId: String(lp.connectionId || '')
    };
  }
  const r = rows[0];
  return {
    logpointId: Number(lp.id),
    name: String(lp.displayName || lp.browseName || lp.nodeId || `Logpoint ${lp.id}`),
    value: r.value,
    ts: Number(r.ts),
    unit: String(lp.unit || ''),
    connectionId: String(lp.connectionId || '')
  };
}

function getTrendSeriesForLogpoint(lp, fromTs, toTs, pointLimit = 800) {
  if (!lp) return null;
  const rows = measurementStore.query(lp.connectionId, lp.id, fromTs, toTs, Math.max(1, pointLimit * 3));
  const asc = (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const sampled = [];
  if (asc.length <= pointLimit) {
    sampled.push(...asc);
  } else {
    const step = asc.length / pointLimit;
    for (let i = 0; i < pointLimit; i++) {
      const idx = Math.min(asc.length - 1, Math.floor(i * step));
      sampled.push(asc[idx]);
    }
  }

  const normalizeTrendPointValue = (raw) => {
    if (raw === true) return 1;
    if (raw === false) return 0;
    const s = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
    if (s === 'true' || s === 'wahr' || s === 'on' || s === 'ein') return 1;
    if (s === 'false' || s === 'falsch' || s === 'off' || s === 'aus') return 0;
    if (s === '1') return 1;
    if (s === '0') return 0;
    const n = Number(String(raw).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  const points = sampled
    .map((r) => {
      const raw = r && r.value;
      const val = normalizeTrendPointValue(raw);
      return {
        ts: Number(r.ts),
        value: val,
        raw: raw === null || raw === undefined ? '' : String(raw)
      };
    })
    .filter((p) => Number.isFinite(p.ts));

  return {
    logpointId: Number(lp.id),
    name: String(lp.displayName || lp.browseName || lp.nodeId || `Logpoint ${lp.id}`),
    unit: String(lp.unit || ''),
    dataType: String(lp.dataType || ''),
    points
  };
}

function buildProtocolPayload(rule, alarmLogpoint, sample, opts = {}) {
  const allLogpoints = logpointStore.list() || [];
  const byId = new Map(allLogpoints.map((lp) => [Number(lp.id), lp]));

  const relatedValues = (rule.relatedLogpointIds || []).map((rid) => {
    const relLp = byId.get(Number(rid));
    if (!relLp) {
      return {
        logpointId: Number(rid),
        name: `Logpoint ${rid}`,
        value: null,
        ts: null,
        unit: '',
        missing: true
      };
    }
    return getLatestValueForLogpoint(relLp, sample.ts);
  });

  const valueWithUnit = (sample.formattedValue === null || sample.formattedValue === undefined)
    ? ''
    : String(sample.formattedValue);

  const vars = {
    ereignisname: rule.name,
    ereignisursache: rule.causeTemplate,
    stoerungsname: rule.name,
    stoerungsursache: rule.causeTemplate,
    wert: valueWithUnit,
    zeit: new Date(Number(sample.ts)).toLocaleString('de-DE'),
    logpoint: String(alarmLogpoint.displayName || alarmLogpoint.browseName || alarmLogpoint.nodeId || alarmLogpoint.id)
  };

  const causeText = replaceTemplate(rule.causeTemplate, vars);
  const hints = String(rule.hintsTemplate || '')
    .split(/\r?\n/)
    .map((x) => replaceTemplate(String(x || '').trim(), vars))
    .filter((x) => !!x);

  const windowMs = Math.max(60_000, Number(rule.trendWindowMs || (10 * 60_000)));
  const trendFromTs = Number(sample.ts) - windowMs;
  const trendToTs = Number(sample.ts);
  const trendSeries = [];

  // Der Auslöser muss immer Teil des Trends sein.
  const trendLogpointIds = [Number(alarmLogpoint.id), ...(rule.relatedLogpointIds || []).map((x) => Number(x))]
    .filter((x) => Number.isInteger(x) && x > 0)
    .filter((x, idx, arr) => arr.indexOf(x) === idx);

  for (const lpid of trendLogpointIds) {
    const relLp = byId.get(Number(lpid));
    if (!relLp) continue;
    const series = getTrendSeriesForLogpoint(relLp, trendFromTs, trendToTs, 700);
    if (series) trendSeries.push(series);
  }

  return {
    protocolVersion: 1,
    generatedAtTs: Date.now(),
    preview: !!opts.preview,
    disturbance: {
      logpointId: Number(alarmLogpoint.id),
      connectionId: String(alarmLogpoint.connectionId || ''),
      name: String(rule.name || alarmLogpoint.displayName || alarmLogpoint.browseName || `Ereignis ${alarmLogpoint.id}`),
      nodeId: String(alarmLogpoint.nodeId || ''),
      dataType: String(alarmLogpoint.dataType || ''),
      triggerTs: Number(sample.ts),
      triggerIso: new Date(Number(sample.ts)).toISOString(),
      triggerLocal: new Date(Number(sample.ts)).toLocaleString('de-DE'),
      triggerValue: valueWithUnit,
      triggerRawValue: sample.rawValue
    },
    cause: {
      text: causeText,
      ruleMode: String(rule.mode || ''),
      boolAlarmValue: !!rule.boolAlarmValue,
      minEnabled: !!rule.minEnabled,
      maxEnabled: !!rule.maxEnabled,
      minLimit: rule.minLimit,
      maxLimit: rule.maxLimit,
      activationDelayMs: Number(rule.activationDelayMs || 0)
    },
    relatedValues,
    trend: {
      fromTs: trendFromTs,
      toTs: trendToTs,
      windowMs,
      series: trendSeries
    },
    hints
  };
}

function createEvent(ruleRow, sample, protocol) {
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO disturbance_events (
      rule_id, logpoint_id, status, triggered_ts, trigger_value, protocol_json, created_at, updated_at
    ) VALUES (
      @ruleId, @logpointId, 'active', @triggeredTs, @triggerValue, @protocolJson, @createdAt, @updatedAt
    )
  `).run({
    ruleId: Number(ruleRow.id),
    logpointId: Number(ruleRow.logpointId),
    triggeredTs: Number(sample.ts),
    triggerValue: sample.formattedValue === null || sample.formattedValue === undefined ? null : String(sample.formattedValue),
    protocolJson: JSON.stringify(protocol),
    createdAt: now,
    updatedAt: now
  });

  const eventId = Number(info.lastInsertRowid);
  db.prepare(`
    UPDATE disturbance_rules
    SET runtime_active = 1,
        runtime_active_since_ts = @activeSinceTs,
        runtime_last_event_id = @lastEventId,
        updated_at = @updatedAt
    WHERE id = @ruleId
  `).run({
    activeSinceTs: Number(ruleRow.runtimeActiveSinceTs || sample.ts),
    lastEventId: eventId,
    updatedAt: now,
    ruleId: Number(ruleRow.id)
  });

  return eventId;
}

function resolveOpenEvent(ruleRow, sample) {
  const now = nowIso();
  const row = db.prepare(`
    SELECT id
    FROM disturbance_events
    WHERE rule_id = ? AND status = 'active'
    ORDER BY triggered_ts DESC, id DESC
    LIMIT 1
  `).get(Number(ruleRow.id));

  if (row && row.id) {
    db.prepare(`
      UPDATE disturbance_events
      SET status = 'resolved',
          resolved_ts = @resolvedTs,
          resolved_value = @resolvedValue,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id: Number(row.id),
      resolvedTs: Number(sample.ts),
      resolvedValue: sample.formattedValue === null || sample.formattedValue === undefined ? null : String(sample.formattedValue),
      updatedAt: now
    });
  }

  db.prepare(`
    UPDATE disturbance_rules
    SET runtime_active = 0,
        runtime_active_since_ts = NULL,
        updated_at = @updatedAt
    WHERE id = @ruleId
  `).run({
    ruleId: Number(ruleRow.id),
    updatedAt: now
  });
}

function processMeasurement(sampleInput) {
  const sample = {
    logpointId: toIntId(sampleInput && sampleInput.logpointId),
    ts: Number(sampleInput && sampleInput.ts),
    rawValue: sampleInput ? sampleInput.rawValue : null,
    formattedValue: sampleInput ? sampleInput.formattedValue : null
  };

  if (!sample.logpointId || !Number.isFinite(sample.ts)) {
    return { triggered: false, reason: 'invalid-sample' };
  }

  const lp = logpointStore.get(sample.logpointId);
  if (!lp || !lp.isAlarm) {
    return { triggered: false, reason: 'not-alarm-logpoint' };
  }

  const rule = getRuleByLogpointId(sample.logpointId);
  if (!rule || !rule.enabled) {
    return { triggered: false, reason: 'rule-disabled-or-missing' };
  }

  const evalResult = evaluateCondition(rule, sample.rawValue);
  const now = nowIso();

  if (!evalResult.matched) {
    if (rule.runtimeActive) {
      resolveOpenEvent(rule, sample);
      return { triggered: false, resolved: true, reason: evalResult.reason };
    }

    if (Number.isFinite(rule.runtimeActiveSinceTs) && rule.runtimeActiveSinceTs !== null) {
      db.prepare('UPDATE disturbance_rules SET runtime_active_since_ts = NULL, updated_at = ? WHERE id = ?').run(now, Number(rule.id));
    }
    return { triggered: false, reason: evalResult.reason };
  }

  if (rule.runtimeActive) {
    return { triggered: false, reason: 'already-active' };
  }

  let activeSince = Number(rule.runtimeActiveSinceTs);
  if (!Number.isFinite(activeSince)) {
    activeSince = Number(sample.ts);
    db.prepare('UPDATE disturbance_rules SET runtime_active_since_ts = ?, updated_at = ? WHERE id = ?').run(activeSince, now, Number(rule.id));
  }

  const delayMs = Math.max(0, Number(rule.activationDelayMs || 0));
  if ((Number(sample.ts) - activeSince) < delayMs) {
    return { triggered: false, reason: 'delay-not-reached', activeSinceTs: activeSince };
  }

  const protocol = buildProtocolPayload(rule, lp, sample, { preview: false });
  const eventId = createEvent(Object.assign({}, rule, { runtimeActiveSinceTs: activeSince }), sample, protocol);
  return { triggered: true, eventId, reason: 'triggered' };
}

function getPreviewForLogpoint(logpointId, overrideSample) {
  const id = toIntId(logpointId);
  if (!id) throw new Error('ungültige logpointId');

  const lp = logpointStore.get(id);
  if (!lp) throw new Error('Logpoint nicht gefunden');
  if (!lp.isAlarm) throw new Error('Logpoint ist nicht als Ereignis markiert');

  const rule = getRuleByLogpointId(id) || makeDefaultRule(id, lp);

  let sample = null;
  if (overrideSample && Number.isFinite(Number(overrideSample.ts))) {
    sample = {
      ts: Number(overrideSample.ts),
      rawValue: overrideSample.rawValue,
      formattedValue: overrideSample.formattedValue === undefined ? overrideSample.rawValue : overrideSample.formattedValue
    };
  } else {
    const rows = measurementStore.query(lp.connectionId, lp.id, Date.now() - (24 * 3600_000), Date.now(), 1);
    const latest = Array.isArray(rows) && rows.length ? rows[0] : null;
    sample = latest
      ? { ts: Number(latest.ts), rawValue: latest.value, formattedValue: latest.value }
      : { ts: Date.now(), rawValue: null, formattedValue: null };
  }

  return buildProtocolPayload(rule, lp, sample, { preview: true });
}

function mapEventRow(row) {
  if (!row) return null;
  let protocol = safeJsonParse(row.protocol_json, null);

  // Legacy-Protokolle ohne Trend/Hinweise beim Lesen anreichern.
  try {
    if (!protocol || !protocol.trend || !Array.isArray(protocol.hints)) {
      const lp = logpointStore.get(Number(row.logpoint_id));
      const rule = getRuleByLogpointId(Number(row.logpoint_id)) || (lp ? makeDefaultRule(lp.id, lp) : null);
      if (lp && rule) {
        const sample = {
          ts: Number(row.triggered_ts) || Date.now(),
          rawValue: row.trigger_value,
          formattedValue: row.trigger_value
        };
        const fallback = buildProtocolPayload(rule, lp, sample, { preview: false });
        const existing = protocol && typeof protocol === 'object' ? protocol : {};
        protocol = Object.assign({}, fallback, existing, {
          disturbance: Object.assign({}, fallback.disturbance || {}, existing.disturbance || {}),
          cause: Object.assign({}, fallback.cause || {}, existing.cause || {}),
          relatedValues: Array.isArray(existing.relatedValues) ? existing.relatedValues : fallback.relatedValues,
          trend: existing.trend || fallback.trend,
          hints: Array.isArray(existing.hints)
            ? existing.hints
            : (Array.isArray(existing.suggestions) ? existing.suggestions : fallback.hints)
        });
      }
    }
  } catch (_) {
    // Bei Anreicherungsfehlern Originalprotokoll unverändert zurückgeben.
  }

  return {
    id: Number(row.id),
    ruleId: Number(row.rule_id),
    logpointId: Number(row.logpoint_id),
    status: String(row.status || 'active'),
    triggeredTs: Number(row.triggered_ts),
    resolvedTs: Number.isFinite(Number(row.resolved_ts)) ? Number(row.resolved_ts) : null,
    triggerValue: row.trigger_value,
    resolvedValue: row.resolved_value,
    protocol,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

function listEvents(filters = {}) {
  const limit = Math.max(1, Math.min(500, Number(filters.limit) || 200));
  const fromTs = Number(filters.fromTs);
  const toTs = Number(filters.toTs);

  let sql = 'SELECT * FROM disturbance_events';
  const clauses = [];
  const params = {};

  if (Number.isFinite(fromTs)) {
    clauses.push('triggered_ts >= @fromTs');
    params.fromTs = fromTs;
  }
  if (Number.isFinite(toTs)) {
    clauses.push('triggered_ts <= @toTs');
    params.toTs = toTs;
  }
  if (filters.status && (filters.status === 'active' || filters.status === 'resolved')) {
    clauses.push('status = @status');
    params.status = filters.status;
  }

  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY triggered_ts DESC, id DESC LIMIT @limit';
  params.limit = limit;

  const rows = db.prepare(sql).all(params);
  return rows.map(mapEventRow);
}

function getEvent(eventId) {
  const id = toIntId(eventId);
  if (!id) return null;
  const row = db.prepare('SELECT * FROM disturbance_events WHERE id = ? LIMIT 1').get(id);
  return mapEventRow(row);
}

function normalizeTrendPointForPdf(point, dataType) {
  const dt = String(dataType || '').toLowerCase();
  const boolByType = /bool|boolean|bit/.test(dt);
  const raw = point && Object.prototype.hasOwnProperty.call(point, 'raw') ? point.raw : (point ? point.value : null);
  const rawStr = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();

  if (raw === true || rawStr === 'true' || rawStr === 'wahr' || rawStr === 'on' || rawStr === 'ein' || rawStr === '1') {
    return { ok: true, value: 1, isBoolean: true };
  }
  if (raw === false || rawStr === 'false' || rawStr === 'falsch' || rawStr === 'off' || rawStr === 'aus' || rawStr === '0') {
    return { ok: true, value: 0, isBoolean: true };
  }

  const n = Number(point && point.value);
  if (Number.isFinite(n)) {
    if (boolByType) return { ok: true, value: n >= 0.5 ? 1 : 0, isBoolean: true };
    return { ok: true, value: n, isBoolean: false };
  }

  if (boolByType) return { ok: false };
  const fallback = Number(String(raw).replace(',', '.'));
  if (Number.isFinite(fallback)) return { ok: true, value: fallback, isBoolean: false };
  return { ok: false };
}

function prepareTrendSeriesForPdf(trendSeries) {
  const input = Array.isArray(trendSeries) ? trendSeries : [];
  const prepared = [];
  for (const s of input) {
    const pts = (Array.isArray(s && s.points) ? s.points : [])
      .map((p) => {
        const ts = Number(p && p.ts);
        if (!Number.isFinite(ts)) return null;
        const norm = normalizeTrendPointForPdf(p, s && s.dataType);
        if (!norm.ok) return null;
        return { ts, value: norm.value, isBoolean: !!norm.isBoolean };
      })
      .filter((p) => !!p)
      .sort((a, b) => a.ts - b.ts);
    if (!pts.length) continue;
    prepared.push({
      logpointId: Number(s && s.logpointId),
      name: String((s && s.name) || `Logpoint ${s && s.logpointId}`),
      unit: String((s && s.unit) || ''),
      points: pts,
      isBooleanSeries: pts.every((p) => p.isBoolean)
    });
  }
  return prepared;
}

function getConnectionNameById(connectionId) {
  const cid = String(connectionId || '').trim();
  if (!cid) return '';
  try {
    const raw = fs.readFileSync(connectionsConfigPath, 'utf8');
    const parsed = safeJsonParse(raw, {});
    const list = Array.isArray(parsed && parsed.connections) ? parsed.connections : [];
    const match = list.find((c) => String(c && c.id) === cid || String(c && c.endpoint) === cid);
    return match ? String(match.name || match.endpoint || '') : '';
  } catch (_) {
    return '';
  }
}

function buildPdfTrendValueRows(preparedSeries) {
  const rows = [];
  for (let idx = 0; idx < (preparedSeries || []).length; idx++) {
    const s = preparedSeries[idx];
    const pts = Array.isArray(s.points) ? s.points : [];
    if (!pts.length) continue;
    const latest = pts[pts.length - 1];
    const minV = Math.min(...pts.map((p) => Number(p.value)).filter((v) => Number.isFinite(v)));
    const maxV = Math.max(...pts.map((p) => Number(p.value)).filter((v) => Number.isFinite(v)));
    rows.push({
      name: String(s.name || `Logpoint ${s.logpointId}`),
      unit: String(s.unit || ''),
      isBooleanSeries: !!s.isBooleanSeries,
      color: TREND_COLORS[idx % TREND_COLORS.length],
      latest,
      minV: Number.isFinite(minV) ? minV : null,
      maxV: Number.isFinite(maxV) ? maxV : null
    });
  }
  return rows;
}

function drawTrendChartPdf(doc, preparedSeries, opts) {
  const x = Number(opts && opts.x) || 42;
  const y = Number(opts && opts.y) || 42;
  const width = Number(opts && opts.width) || 500;
  const height = Number(opts && opts.height) || 190;

  doc.save();
  doc.roundedRect(x, y, width, height, 4).lineWidth(1).strokeColor('#d4dfef').fillAndStroke('#ffffff', '#d4dfef');

  if (!Array.isArray(preparedSeries) || !preparedSeries.length) {
    doc.fillColor('#6a7c97').fontSize(10).text('Keine Trenddaten im gewaehlten Zeitbereich vorhanden.', x + 10, y + (height / 2) - 6, { width: width - 20, align: 'center' });
    doc.restore();
    return 20;
  }

  const plotX = x + 10;
  const plotY = y + 10;
  const plotW = width - 20;
  const plotH = height - 20;

  const all = preparedSeries.flatMap((s) => s.points.map((p) => ({ ts: p.ts, v: p.value })));
  const dataMinTs = Math.min(...all.map((p) => p.ts));
  const dataMaxTs = Math.max(...all.map((p) => p.ts));
  let minTs = Number(opts && opts.rangeStartTs);
  let maxTs = Number(opts && opts.rangeEndTs);
  if (!Number.isFinite(minTs)) minTs = dataMinTs;
  if (!Number.isFinite(maxTs)) maxTs = dataMaxTs;
  if (!(maxTs > minTs)) {
    minTs = dataMinTs;
    maxTs = dataMaxTs;
  }
  const dt = Math.max(1, maxTs - minTs);
  const boolSeries = preparedSeries.filter((s) => s.isBooleanSeries);
  const numSeries = preparedSeries.filter((s) => !s.isBooleanSeries);

  const numericSeriesStats = new Map();
  const projectSeriesToWindow = (ptsIn) => {
    const pts = (Array.isArray(ptsIn) ? ptsIn : []).slice().sort((a, b) => a.ts - b.ts).filter((p) => p.ts >= minTs && p.ts <= maxTs);
    if (!pts.length) return [];
    const out = pts.slice();
    const first = out[0];
    const last = out[out.length - 1];
    if (first.ts > minTs) out.unshift({ ts: minTs, value: first.value, isBoolean: first.isBoolean });
    if (last.ts < maxTs) out.push({ ts: maxTs, value: last.value, isBoolean: last.isBoolean });
    if (out.length === 1 && maxTs > minTs) out.push({ ts: maxTs, value: out[0].value, isBoolean: out[0].isBoolean });
    return out;
  };

  const projectedByLp = new Map();
  for (const s of preparedSeries) {
    projectedByLp.set(String(s.logpointId), projectSeriesToWindow(s.points));
  }

  for (const s of numSeries) {
    const sPts = projectedByLp.get(String(s.logpointId)) || [];
    if (!sPts.length) continue;
    let sMin = Math.min(...sPts.map((p) => p.value));
    let sMax = Math.max(...sPts.map((p) => p.value));
    if (!(sMax > sMin)) {
      const bump = Math.max(1, Math.abs(sMax) * 0.02);
      sMin -= bump;
      sMax += bump;
    }
    numericSeriesStats.set(String(s.logpointId), { min: sMin, max: sMax, lpIds: [String(s.logpointId)] });
  }

  const axisDefs = [];
  const AXIS_MAG_RATIO_SPLIT = 80;
  const AXIS_SPAN_RATIO_SPLIT = 30;
  for (const [lpId, stat] of numericSeriesStats.entries()) {
    let target = null;
    for (const axis of axisDefs) {
      const axisMag = Math.max(Math.abs(axis.min), Math.abs(axis.max), 1e-9);
      const statMag = Math.max(Math.abs(stat.min), Math.abs(stat.max), 1e-9);
      const magRatio = Math.max(axisMag, statMag) / Math.min(axisMag, statMag);
      const axisSpan = Math.max(1e-9, axis.max - axis.min);
      const statSpan = Math.max(1e-9, stat.max - stat.min);
      const spanRatio = Math.max(axisSpan, statSpan) / Math.min(axisSpan, statSpan);
      const overlaps = !(stat.max < axis.min || stat.min > axis.max);
      const similarScale = (magRatio <= AXIS_MAG_RATIO_SPLIT) && (spanRatio <= AXIS_SPAN_RATIO_SPLIT);
      if ((overlaps && similarScale) || (!overlaps && magRatio <= AXIS_MAG_RATIO_SPLIT)) {
        target = axis;
        break;
      }
    }
    if (!target) axisDefs.push({ min: stat.min, max: stat.max, lpIds: [lpId] });
    else {
      target.min = Math.min(target.min, stat.min);
      target.max = Math.max(target.max, stat.max);
      target.lpIds.push(lpId);
    }
  }

  if (!axisDefs.length && numSeries.length) {
    const vals = numSeries.flatMap((s) => s.points.map((p) => p.value));
    axisDefs.push({ min: Math.min(...vals), max: Math.max(...vals), lpIds: [] });
  }

  axisDefs.sort((a, b) => {
    const ma = Math.max(Math.abs(a.min), Math.abs(a.max));
    const mb = Math.max(Math.abs(b.min), Math.abs(b.max));
    return mb - ma;
  });

  const axisByLp = new Map();
  axisDefs.forEach((axis, axisIdx) => {
    if (!(axis.max > axis.min)) {
      const bump = Math.max(1, Math.abs(axis.max) * 0.02);
      axis.min -= bump;
      axis.max += bump;
    }
    axis.lpIds.forEach((lpId) => axisByLp.set(String(lpId), axisIdx));
  });

  const axisSpacing = 22;
  const padL = 26 + Math.max(0, axisDefs.length - 1) * axisSpacing;
  const padR = 26;
  const padT = 8;
  const padB = 18;
  const innerW = Math.max(50, plotW - padL - padR);
  const innerH = Math.max(40, plotH - padT - padB);

  const mapX = (ts) => plotX + padL + ((ts - minTs) / dt) * innerW;
  const mapYNumeric = (v, lpId) => {
    const idx = axisByLp.get(String(lpId)) || 0;
    const axis = axisDefs[idx] || axisDefs[0] || { min: 0, max: 1 };
    const dv = Math.max(1e-9, axis.max - axis.min);
    return plotY + padT + (1 - ((v - axis.min) / dv)) * innerH;
  };
  const boolTrueY = plotY + padT + innerH * 0.50;
  const boolFalseY = plotY + padT + innerH;
  const mapYBool = (v) => (Number(v) >= 0.5 ? boolTrueY : boolFalseY);

  doc.lineWidth(0.8).strokeColor('#edf1f6');
  for (let i = 0; i <= 4; i++) {
    const gy = plotY + padT + (innerH / 4) * i;
    doc.moveTo(plotX + padL, gy).lineTo(plotX + padL + innerW, gy).stroke();
  }

  doc.lineWidth(0.9).strokeColor('#8fa0b8');
  doc.moveTo(plotX + padL, plotY + padT + innerH).lineTo(plotX + padL + innerW, plotY + padT + innerH).stroke();

  if (numSeries.length) {
    const formatAxis = (v) => {
      const av = Math.abs(v);
      if (av >= 100000 || (av > 0 && av < 0.01)) return v.toExponential(2);
      return v.toFixed(2);
    };
    for (let axisIdx = 0; axisIdx < axisDefs.length; axisIdx++) {
      const axis = axisDefs[axisIdx];
      const axisX = plotX + padL - axisIdx * axisSpacing;
      doc.moveTo(axisX, plotY + padT).lineTo(axisX, plotY + padT + innerH).stroke();
      doc.fillColor('#516075').fontSize(7)
        .text(formatAxis(axis.max), axisX - 24, plotY + padT - 2, { width: 22, align: 'right' })
        .text(formatAxis(axis.min), axisX - 24, plotY + padT + innerH - 4, { width: 22, align: 'right' });
    }
  }

  preparedSeries.forEach((s, idx) => {
    const pts = (projectedByLp.get(String(s.logpointId)) || []).slice().sort((a, b) => a.ts - b.ts);
    if (pts.length < 2) return;
    const c = TREND_COLORS[idx % TREND_COLORS.length];
    doc.lineWidth(1.4).strokeColor(c);

    if (s.isBooleanSeries) {
      let px = mapX(pts[0].ts);
      let py = mapYBool(pts[0].value);
      doc.moveTo(px, py);
      for (let i = 1; i < pts.length; i++) {
        const cx = mapX(pts[i].ts);
        const cyPrev = mapYBool(pts[i - 1].value);
        const cy = mapYBool(pts[i].value);
        doc.lineTo(cx, cyPrev);
        doc.lineTo(cx, cy);
      }
      doc.stroke();
    } else {
      doc.moveTo(mapX(pts[0].ts), mapYNumeric(pts[0].value, s.logpointId));
      for (let i = 1; i < pts.length; i++) {
        doc.lineTo(mapX(pts[i].ts), mapYNumeric(pts[i].value, s.logpointId));
      }
      doc.stroke();
    }
  });

  if (boolSeries.length) {
    const axisX = plotX + padL + innerW;
    doc.lineWidth(0.9).strokeColor('#9aa9bf')
      .moveTo(axisX, plotY + padT)
      .lineTo(axisX, plotY + padT + innerH)
      .stroke();
    doc.fillColor('#4f647f').fontSize(7)
      .text('1', axisX + 2, boolTrueY - 3, { width: 8 })
      .text('0', axisX + 2, boolFalseY - 3, { width: 8 });
  }

  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const r = i / ticks;
    const xt = plotX + padL + r * innerW;
    const ts = minTs + r * dt;
    doc.lineWidth(0.7).strokeColor('#8fa0b8')
      .moveTo(xt, plotY + padT + innerH)
      .lineTo(xt, plotY + padT + innerH + 3)
      .stroke();
    const txt = new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    doc.fillColor('#516075').fontSize(6).text(txt, xt - 24, plotY + padT + innerH + 4, { width: 48, align: 'center' });
  }

  let legendY = y + height + 6;
  let legendX = x + 2;
  preparedSeries.forEach((s, idx) => {
    const label = String(s.name || `Logpoint ${s.logpointId}`);
    const c = TREND_COLORS[idx % TREND_COLORS.length];
    const blockW = Math.min(170, 20 + label.length * 4.6);
    if (legendX + blockW > x + width) {
      legendX = x + 2;
      legendY += 11;
    }
    doc.lineWidth(2).strokeColor(c).moveTo(legendX, legendY + 4).lineTo(legendX + 10, legendY + 4).stroke();
    doc.fillColor('#2d3f57').fontSize(8).text(label, legendX + 13, legendY, { width: blockW - 13 });
    legendX += blockW;
  });

  doc.restore();
  const legendExtraBelowChart = Math.max(10, (legendY - (y + height)) + 12);
  return legendExtraBelowChart;
}

function buildPdfBufferForEvent(event) {
  if (!PDFDocument) {
    const err = new Error('PDF-Export nicht verfügbar. Bitte Abhängigkeit "pdfkit" installieren.');
    err.code = 'PDFKIT_MISSING';
    throw err;
  }
  if (!event || !event.protocol) throw new Error('Protokolldaten fehlen');

  const doc = new PDFDocument({ margin: 42, size: 'A4' });
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const p = event.protocol || {};
    const disturbance = p.disturbance || {};
    const cause = p.cause || {};
    const related = Array.isArray(p.relatedValues) ? p.relatedValues : [];
    const trend = p.trend || {};
    const trendSeries = Array.isArray(trend.series) ? trend.series : [];

    doc.rect(30, 30, 535, 770).lineWidth(1).stroke('#cfd9ea');
    doc.fontSize(20).fillColor('#163a63').text('Ereignisprotokoll', 42, 42);
    doc.moveTo(42, 68).lineTo(553, 68).lineWidth(1).stroke('#9fb2ce');
    doc.moveDown(0.6);

    doc.fillColor('#1f2a3a').fontSize(12).text(`Protokoll-ID: ${event.id}`);
    doc.text(`Status: ${event.status}`);
    doc.text(`Ereignis: ${disturbance.name || '-'}`);
    doc.text(`Logpoint-ID: ${disturbance.logpointId || '-'}`);
    const connName = getConnectionNameById(disturbance.connectionId);
    const connDisplay = disturbance.connectionId
      ? `${disturbance.connectionId}${connName ? ` (${connName})` : ''}`
      : '-';
    doc.text(`Verbindung: ${connDisplay}`);
    doc.text(`Zeitpunkt Auslösung: ${disturbance.triggerLocal || new Date(event.triggeredTs).toLocaleString('de-DE')}`);
    if (event.resolvedTs) {
      doc.text(`Zeitpunkt Rücksetzung: ${new Date(event.resolvedTs).toLocaleString('de-DE')}`);
    }
    doc.text(`Auslösewert: ${disturbance.triggerValue || event.triggerValue || '-'}`);

    doc.moveDown(0.7);
    doc.fontSize(13).text('Ereignisursache', { underline: true });
    doc.fontSize(11).text(String(cause.text || '-'));

    doc.moveDown(0.7);
    doc.fontSize(13).text('Zugeordnete Logpoints (Aktualwerte)', { underline: true });
    if (!related.length) {
      doc.fontSize(11).text('Keine zugeordneten Logpoints.');
    } else {
      for (const item of related) {
        const tsTxt = item.ts ? new Date(Number(item.ts)).toLocaleString('de-DE') : '-';
        const valTxt = item.value === null || item.value === undefined || item.value === ''
          ? '-'
          : String(item.value) + (item.unit ? ` ${item.unit}` : '');
        doc.fontSize(10).text(`- ${item.name || `Logpoint ${item.logpointId}`}: ${valTxt} (Zeit: ${tsTxt})`);
      }
    }

    doc.moveDown(0.7);
    doc.fontSize(13).text('Hinweise', { underline: true });
    const hints = Array.isArray(p.hints) ? p.hints : [];
    if (hints.length) {
      for (const s of hints) doc.fontSize(10).text(`- ${String(s)}`);
    } else {
      doc.fontSize(10).text('- Keine Hinweise hinterlegt.');
    }

    doc.moveDown(0.7);
    doc.fontSize(13).text('Trend (vor Ereigniseintritt)', { underline: true });
    const minTxt = trend.fromTs ? new Date(Number(trend.fromTs)).toLocaleString('de-DE') : '-';
    const maxTxt = trend.toTs ? new Date(Number(trend.toTs)).toLocaleString('de-DE') : '-';
    doc.fontSize(10).text(`Zeitraum: ${minTxt} bis ${maxTxt}`);

    const preparedTrend = prepareTrendSeriesForPdf(trendSeries);
    const chartBlockHeight = 230;
    if (doc.y + chartBlockHeight > (doc.page.height - doc.page.margins.bottom)) {
      doc.addPage();
      doc.rect(30, 30, 535, 770).lineWidth(1).stroke('#cfd9ea');
      doc.fontSize(13).fillColor('#1f2a3a').text('Trend (vor Ereigniseintritt)', 42, 42, { underline: true });
      doc.fontSize(10).text(`Zeitraum: ${minTxt} bis ${maxTxt}`);
    }

    const chartTop = doc.y + 6;
    const usedLegendHeight = drawTrendChartPdf(doc, preparedTrend, {
      x: 42,
      y: chartTop,
      width: 511,
      height: 170,
      rangeStartTs: Number(trend && trend.fromTs),
      rangeEndTs: Number(trend && trend.toTs)
    });

    const valueRows = buildPdfTrendValueRows(preparedTrend);
    let nextY = chartTop + 170 + usedLegendHeight + 2;

    if (valueRows.length) {
      const rowH = 14;
      const tableTopPadding = 6;
      const tableHeight = tableTopPadding + rowH * (1 + valueRows.length);
      if (nextY + tableHeight > (doc.page.height - doc.page.margins.bottom)) {
        doc.addPage();
        doc.rect(30, 30, 535, 770).lineWidth(1).stroke('#cfd9ea');
        nextY = 48;
      }

      const fmtNum = (v) => {
        if (!Number.isFinite(Number(v))) return '-';
        const n = Number(v);
        const av = Math.abs(n);
        if (av >= 100000 || (av > 0 && av < 0.01)) return n.toExponential(2);
        return n.toFixed(2);
      };

      const x0 = 42;
      const col = {
        lp: 150,
        cur: 96,
        min: 62,
        max: 62,
        ts: 141
      };

      doc.fillColor('#2d4568').fontSize(9);
      doc.rect(x0, nextY, 511, rowH).fill('#f4f8ff').stroke('#d7e2f2');
      doc.fillColor('#2d4568')
        .text('Logpoint', x0 + 4, nextY + 3, { width: col.lp - 8 })
        .text('Aktuell', x0 + col.lp + 4, nextY + 3, { width: col.cur - 8 })
        .text('Min', x0 + col.lp + col.cur + 4, nextY + 3, { width: col.min - 8 })
        .text('Max', x0 + col.lp + col.cur + col.min + 4, nextY + 3, { width: col.max - 8 })
        .text('Zeit', x0 + col.lp + col.cur + col.min + col.max + 4, nextY + 3, { width: col.ts - 8 });

      let rowY = nextY + rowH;
      for (const row of valueRows) {
        doc.rect(x0, rowY, 511, rowH).lineWidth(0.6).strokeColor('#e3ebf7').stroke();
        const latestTxt = row.isBooleanSeries
          ? (Number(row.latest && row.latest.value) >= 0.5 ? 'true' : 'false')
          : `${fmtNum(row.latest && row.latest.value)}${row.unit ? (' ' + row.unit) : ''}`;
        const minTxt = row.isBooleanSeries ? '-' : `${fmtNum(row.minV)}${row.unit ? (' ' + row.unit) : ''}`;
        const maxTxt = row.isBooleanSeries ? '-' : `${fmtNum(row.maxV)}${row.unit ? (' ' + row.unit) : ''}`;
        const tsTxt = row.latest && row.latest.ts ? new Date(Number(row.latest.ts)).toLocaleString('de-DE') : '-';

        const swY = rowY + (rowH / 2);
        doc.lineWidth(2).strokeColor(row.color || '#1f77b4').moveTo(x0 + 4, swY).lineTo(x0 + 14, swY).stroke();

        doc.fillColor('#1f2a3a').fontSize(8.5)
          .text(row.name, x0 + 17, rowY + 3, { width: col.lp - 21 })
          .text(latestTxt, x0 + col.lp + 4, rowY + 3, { width: col.cur - 8 })
          .text(minTxt, x0 + col.lp + col.cur + 4, rowY + 3, { width: col.min - 8 })
          .text(maxTxt, x0 + col.lp + col.cur + col.min + 4, rowY + 3, { width: col.max - 8 })
          .text(tsTxt, x0 + col.lp + col.cur + col.min + col.max + 4, rowY + 3, { width: col.ts - 8 });
        rowY += rowH;
      }
      nextY = rowY + 4;
    }

    doc.y = nextY;

    doc.end();
  });
}

module.exports = {
  getAvailableAlarmLogpoints,
  getRuleByLogpointId,
  listRules,
  listRulesWithLogpointDetails,
  upsertRule,
  processMeasurement,
  getPreviewForLogpoint,
  listEvents,
  getEvent,
  buildPdfBufferForEvent
};
