'use strict';
/**
 * logpoint-scheduler.js
 * Polling scheduler: liest konfigurierte logpoints in ihrem Intervall
 * und schreibt die Samples via writerManager.
 *
 * Usage:
 *   const createScheduler = require('./lib/logpoint-scheduler');
 *   const scheduler = createScheduler({ getLogpoints, readValue, writerManager });
 *   await scheduler.start();
 *
 * - getLogpoints(): async -> returns Array of { id, connectionId, nodeId, samplingIntervalMs, enabled }
 * - readValue(connectionId, nodeId): async -> { value, status, serverTimestamp }
 * - writerManager: existing writer-manager singleton
 */

function createScheduler(opts = {}) {
  const getLogpoints = opts.getLogpoints;
  const readValue = opts.readValue;
  const writerManager = opts.writerManager;
  if (!getLogpoints || !readValue || !writerManager) {
    throw new Error('logpoint-scheduler requires getLogpoints, readValue and writerManager');
  }

  const jobs = new Map(); // logpointId -> { timer, running, lp }

  async function runOnce(lp) {
    const start = Date.now();
    try {
      const res = await readValue(lp.connectionId, lp.nodeId);
      const ts = Date.now();
      const sample = {
        logpoint_id: lp.id,
        ts: (res && res.serverTimestamp) ? Number(res.serverTimestamp) : ts,
        value: (res && res.value !== undefined) ? res.value : null,
        status: (res && res.status !== undefined) ? res.status : null,
        serverTimestamp: (res && res.serverTimestamp) ? Number(res.serverTimestamp) : null
      };

      let writer = writerManager.getWriter(lp.connectionId);
      if (!writer) writer = writerManager.createForConnection({ id: lp.connectionId });

      writer.push(sample);
      // For production we do not await flush here for throughput.
    } catch (err) {
      console.error(`logpoint-scheduler: read error for logpoint ${lp.id} (conn ${lp.connectionId}):`, err && err.message ? err.message : err);
    } finally {
      const dur = Date.now() - start;
      // optional metric: dur
    }
  }

  async function scheduleLp(lp) {
    if (!lp || !lp.id) return;
    if (jobs.has(lp.id)) return;
    const intervalMs = Math.max(100, Number(lp.samplingIntervalMs || 1000));
    const job = { timer: null, running: false, lp };
    job.timer = setInterval(() => {
      if (job.running) return;
      job.running = true;
      runOnce(lp).catch(()=>{}).finally(()=>{ job.running = false; });
    }, intervalMs);
    if (job.timer.unref) job.timer.unref();
    jobs.set(lp.id, job);
    console.log(`logpoint-scheduler: scheduled ${lp.id} every ${intervalMs}ms`);
  }

  function unscheduleLp(lpId) {
    const job = jobs.get(lpId);
    if (!job) return;
    try { clearInterval(job.timer); } catch (e) {}
    jobs.delete(lpId);
    console.log(`logpoint-scheduler: unscheduled ${lpId}`);
  }

  return {
    async start(pollConfigIntervalMs = 60000) {
      try {
        const lps = await getLogpoints();
        for (const lp of lps) {
          if (lp.enabled === 0 || lp.enabled === false) continue;
          await scheduleLp(lp);
        }
      } catch (e) {
        console.error('logpoint-scheduler: initial load error', e && e.message ? e.message : e);
      }

      // periodic config reload (adds/removes or updates intervals)
      this._configTimer = setInterval(async () => {
        try {
          const fresh = await getLogpoints();
          const freshMap = new Map(fresh.map(x => [String(x.id), x]));
          // remove missing
          for (const existingId of Array.from(jobs.keys())) {
            if (!freshMap.has(existingId)) unscheduleLp(existingId);
          }
          // add/update
          for (const lp of fresh) {
            const existing = jobs.get(String(lp.id));
            if (!existing) {
              if (lp.enabled === 0 || lp.enabled === false) continue;
              await scheduleLp(lp);
            } else {
              const oldInterval = Number(existing.lp.samplingIntervalMs || existing.lp.intervalMs || 0);
              const newInterval = Number(lp.samplingIntervalMs || lp.intervalMs || 0);
              if (oldInterval !== newInterval) {
                unscheduleLp(lp.id);
                if (!(lp.enabled === 0 || lp.enabled === false)) await scheduleLp(lp);
              }
            }
          }
        } catch (e) {
          console.error('logpoint-scheduler: config reload failed', e && e.message ? e.message : e);
        }
      }, pollConfigIntervalMs);
      if (this._configTimer.unref) this._configTimer.unref();
    },

    stop() {
      if (this._configTimer) {
        clearInterval(this._configTimer);
        this._configTimer = null;
      }
      for (const id of Array.from(jobs.keys())) unscheduleLp(id);
      console.log('logpoint-scheduler: stopped');
    }
  };
}

module.exports = createScheduler;