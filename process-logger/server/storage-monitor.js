'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const measurementStore = require('../lib/measurement-store');

const DATA_DIR = process.env.PROCESS_LOGGER_DATA_DIR || '/opt/process-logger/data';
const MEASUREMENTS_DIR = path.join(DATA_DIR, 'measurements');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_PROCESS_DATA_CAPACITY_PCT = 40;
const MIN_PROCESS_DATA_CAPACITY_PCT = 20;
const MAX_PROCESS_DATA_CAPACITY_PCT = 80;
const DEFAULT_DELETE_TRIGGER_PCT = 90;
const MIN_DELETE_TRIGGER_PCT = 20;
const MAX_DELETE_TRIGGER_PCT = 90;
const DEFAULT_DELETE_GRANULARITY = 'monthly';
const CHECK_INTERVAL_MS = 60_000;
const ETA_HISTORY_WINDOW_MS = 6 * 60 * 60_000;

let timer = null;
let running = false;
let lastStatus = null;
let growthSamples = [];

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeDeleteGranularity(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'daily' || v === 'weekly' || v === 'monthly') return v;
  return DEFAULT_DELETE_GRANULARITY;
}

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function getRetentionConfig() {
  const settings = readSettings();
  const logger = settings && settings.logger ? settings.logger : {};
  const processDataCapacityPercent = clampNumber(
    logger.processDataCapacityPercent,
    MIN_PROCESS_DATA_CAPACITY_PCT,
    MAX_PROCESS_DATA_CAPACITY_PCT,
    DEFAULT_PROCESS_DATA_CAPACITY_PCT
  );
  const deleteTriggerPercent = clampNumber(
    logger.processDataDeleteThresholdPercent,
    MIN_DELETE_TRIGGER_PCT,
    MAX_DELETE_TRIGGER_PCT,
    DEFAULT_DELETE_TRIGGER_PCT
  );
  const deleteGranularity = normalizeDeleteGranularity(logger.processDataDeleteInterval);
  return {
    processDataCapacityPercent,
    deleteTriggerPercent,
    deleteGranularity
  };
}

function getFsCapacityBytes(targetPath) {
  if (typeof fs.statfsSync === 'function') {
    const st = fs.statfsSync(targetPath);
    const bsize = Number(st.bsize || st.frsize || 0);
    const blocks = Number(st.blocks || 0);
    const bfree = Number(st.bfree || 0);
    const totalBytes = bsize * blocks;
    const freeBytes = bsize * bfree;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return { totalBytes, freeBytes, usedBytes };
  }

  const out = execFileSync('df', ['-kP', targetPath], { encoding: 'utf8' });
  const lines = String(out || '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('df output parsing failed');
  const cols = lines[lines.length - 1].trim().split(/\s+/);
  if (cols.length < 6) throw new Error('df output malformed');
  const totalKb = Number(cols[1] || 0);
  const usedKb = Number(cols[2] || 0);
  const availKb = Number(cols[3] || 0);
  return {
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    freeBytes: availKb * 1024
  };
}

function safeStatSize(absPath) {
  try {
    const st = fs.statSync(absPath);
    return Number(st.size || 0);
  } catch (_) {
    return 0;
  }
}

function getProcessDataSizeBytes() {
  if (!fs.existsSync(MEASUREMENTS_DIR)) return 0;
  const stack = [MEASUREMENTS_DIR];
  let total = 0;

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        total += safeStatSize(abs);
      }
    }
  }

  return total;
}

function floorUtc(ts, granularity) {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return null;

  if (granularity === 'daily') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (granularity === 'weekly') {
    const day = d.getUTCDay();
    const mondayOffset = (day + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset);
  }

  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function addUtcWindow(startTs, granularity) {
  const d = new Date(Number(startTs));
  if (!Number.isFinite(d.getTime())) return null;

  if (granularity === 'daily') return Number(startTs) + 24 * 60 * 60_000;
  if (granularity === 'weekly') return Number(startTs) + 7 * 24 * 60 * 60_000;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function listMeasurementDbFiles() {
  if (!fs.existsSync(MEASUREMENTS_DIR)) return [];
  const entries = fs.readdirSync(MEASUREMENTS_DIR, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.db$/i.test(ent.name)) continue;
    if (/\.db-(wal|shm)$/i.test(ent.name)) continue;
    files.push(path.join(MEASUREMENTS_DIR, ent.name));
  }
  return files;
}

function dbRangeInfo(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS cnt FROM measurements').get();
    const count = Number((row && row.cnt) || 0);
    if (!(count > 0)) return null;
    return {
      dbPath,
      minTs: Number(row.minTs),
      maxTs: Number(row.maxTs),
      count
    };
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

function maybeDeleteEmptyDb(dbPath) {
  let db;
  try {
    db = new Database(dbPath);
    const row = db.prepare('SELECT COUNT(*) AS c FROM measurements').get();
    const c = Number((row && row.c) || 0);
    if (c > 0) return { deleted: false, bytesFreed: 0 };
  } catch (_) {
    return { deleted: false, bytesFreed: 0 };
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }

  let bytesFreed = 0;
  const extra = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const p of extra) {
    const size = safeStatSize(p);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      bytesFreed += size;
    } catch (_) {}
  }
  return { deleted: bytesFreed > 0, bytesFreed };
}

function pruneOldestDataChunk(granularity) {
  const dbFiles = listMeasurementDbFiles();
  if (!dbFiles.length) {
    return { deleted: false, bytesFreed: 0, filesDeleted: 0, rowsDeleted: 0, reason: 'no-db-files', chunk: null };
  }

  const infos = [];
  for (const dbPath of dbFiles) {
    const info = dbRangeInfo(dbPath);
    if (info) infos.push(info);
  }

  if (!infos.length) {
    return { deleted: false, bytesFreed: 0, filesDeleted: 0, rowsDeleted: 0, reason: 'no-rows', chunk: null };
  }

  let oldest = infos[0];
  for (const info of infos) {
    if (info.minTs < oldest.minTs) oldest = info;
  }

  const chunkStart = floorUtc(oldest.minTs, granularity);
  const chunkEnd = addUtcWindow(chunkStart, granularity);
  if (!Number.isFinite(chunkStart) || !Number.isFinite(chunkEnd) || !(chunkEnd > chunkStart)) {
    return { deleted: false, bytesFreed: 0, filesDeleted: 0, rowsDeleted: 0, reason: 'invalid-chunk', chunk: null };
  }

  let rowsDeleted = 0;
  let bytesFreed = 0;
  let filesDeleted = 0;

  try { measurementStore.closeAll(); } catch (_) {}

  for (const dbPath of dbFiles) {
    const beforeSize = safeStatSize(dbPath) + safeStatSize(`${dbPath}-wal`) + safeStatSize(`${dbPath}-shm`);
    let db;
    try {
      db = new Database(dbPath);
      const info = db.prepare('DELETE FROM measurements WHERE ts >= ? AND ts < ?').run(chunkStart, chunkEnd);
      rowsDeleted += Number((info && info.changes) || 0);
      if ((info && info.changes) > 0) {
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
        try { db.exec('VACUUM'); } catch (_) {}
      }
    } catch (_) {
      // continue with other files
    } finally {
      try { if (db) db.close(); } catch (_) {}
    }

    const emptied = maybeDeleteEmptyDb(dbPath);
    if (emptied.deleted) {
      filesDeleted += 1;
      bytesFreed += Number(emptied.bytesFreed) || 0;
      continue;
    }

    const afterSize = safeStatSize(dbPath) + safeStatSize(`${dbPath}-wal`) + safeStatSize(`${dbPath}-shm`);
    if (beforeSize > afterSize) bytesFreed += (beforeSize - afterSize);
  }

  return {
    deleted: rowsDeleted > 0 || filesDeleted > 0,
    bytesFreed,
    filesDeleted,
    rowsDeleted,
    reason: (rowsDeleted > 0 || filesDeleted > 0) ? 'deleted' : 'no-matching-rows',
    chunk: {
      granularity,
      startTs: chunkStart,
      endTs: chunkEnd
    }
  };
}

function formatDeletedChunkLabel(chunk) {
  if (!chunk || !Number.isFinite(chunk.startTs) || !Number.isFinite(chunk.endTs)) return '';
  const start = new Date(chunk.startTs).toISOString();
  const end = new Date(chunk.endTs).toISOString();
  return `${chunk.granularity}:${start}..${end}`;
}

function pushGrowthSample(ts, bytes) {
  growthSamples.push({ ts: Number(ts), bytes: Number(bytes) });
  const minTs = Number(ts) - ETA_HISTORY_WINDOW_MS;
  growthSamples = growthSamples.filter((s) => s && Number(s.ts) >= minTs);
}

function estimateMsUntilTrigger(triggerBytes, currentBytes) {
  if (currentBytes >= triggerBytes) return 0;
  if (growthSamples.length < 2) return null;

  const first = growthSamples[0];
  const last = growthSamples[growthSamples.length - 1];
  if (!first || !last) return null;

  const dt = Number(last.ts) - Number(first.ts);
  const db = Number(last.bytes) - Number(first.bytes);
  if (!(dt > 0) || !(db > 0)) return null;

  const bytesPerMs = db / dt;
  if (!(bytesPerMs > 0)) return null;

  const remain = Math.max(0, Number(triggerBytes) - Number(currentBytes));
  return remain / bytesPerMs;
}

function buildStatusPayload(extra) {
  const fsStats = getFsCapacityBytes(DATA_DIR);
  const processDataBytes = getProcessDataSizeBytes();
  const cfg = getRetentionConfig();

  const allowedBytes = Math.max(0, Math.floor(fsStats.totalBytes * (cfg.processDataCapacityPercent / 100)));
  const triggerBytes = Math.max(0, Math.floor(allowedBytes * (cfg.deleteTriggerPercent / 100)));
  const processDataUsagePctOfAllowance = allowedBytes > 0 ? (processDataBytes / allowedBytes) * 100 : 0;

  const now = Date.now();
  pushGrowthSample(now, processDataBytes);
  const etaMs = estimateMsUntilTrigger(triggerBytes, processDataBytes);

  return {
    timestamp: now,
    filesystem: {
      totalBytes: fsStats.totalBytes,
      usedBytes: fsStats.usedBytes,
      freeBytes: fsStats.freeBytes,
      usedPercent: fsStats.totalBytes > 0 ? (fsStats.usedBytes / fsStats.totalBytes) * 100 : 0
    },
    processData: {
      bytes: processDataBytes,
      capacityPercent: cfg.processDataCapacityPercent,
      allowedBytes,
      deleteTriggerPercent: cfg.deleteTriggerPercent,
      deleteTriggerBytes: triggerBytes,
      deleteGranularity: cfg.deleteGranularity,
      usagePercentOfAllowance: processDataUsagePctOfAllowance,
      estimatedMsUntilDelete: etaMs,
      estimatedAt: etaMs === null ? null : now + Math.max(0, etaMs)
    },
    deletion: Object.assign({
      active: false,
      deletedMonths: [],
      deletedChunks: [],
      bytesFreed: 0,
      filesDeleted: 0,
      rowsDeleted: 0,
      reason: ''
    }, extra || {})
  };
}

function enforceDeletionIfNeeded(status) {
  const out = {
    active: false,
    deletedMonths: [],
    deletedChunks: [],
    bytesFreed: 0,
    filesDeleted: 0,
    rowsDeleted: 0,
    reason: ''
  };

  let current = Number(status && status.processData && status.processData.bytes) || 0;
  const trigger = Number(status && status.processData && status.processData.deleteTriggerBytes) || 0;
  const granularity = normalizeDeleteGranularity(status && status.processData && status.processData.deleteGranularity);
  if (!(trigger > 0) || current < trigger) {
    return out;
  }

  out.active = true;
  let guard = 0;
  while (current >= trigger && guard < 500) {
    guard += 1;
    const res = pruneOldestDataChunk(granularity);
    if (!res.deleted) {
      out.reason = res.reason || 'nothing-left';
      break;
    }

    const label = formatDeletedChunkLabel(res.chunk);
    if (label) out.deletedChunks.push(label);
    out.bytesFreed += Number(res.bytesFreed) || 0;
    out.filesDeleted += Number(res.filesDeleted) || 0;
    out.rowsDeleted += Number(res.rowsDeleted) || 0;
    current = getProcessDataSizeBytes();
  }

  if (!out.reason) out.reason = current >= trigger ? 'threshold-still-above' : 'threshold-reached';
  return out;
}

function runCycle() {
  if (running) return;
  running = true;
  try {
    const pre = buildStatusPayload();
    const deletion = enforceDeletionIfNeeded(pre);
    if (deletion.active && deletion.deletedMonths.length) {
      lastStatus = buildStatusPayload(deletion);
    } else {
      lastStatus = Object.assign(pre, { deletion });
    }
  } catch (err) {
    lastStatus = {
      timestamp: Date.now(),
      error: String((err && err.message) || err)
    };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  runCycle();
  timer = setInterval(runCycle, CHECK_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getStatusSnapshot() {
  if (!lastStatus) runCycle();
  return lastStatus;
}

function runNow() {
  runCycle();
  return getStatusSnapshot();
}

module.exports = {
  start,
  stop,
  runNow,
  getStatusSnapshot
};
