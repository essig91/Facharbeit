/**
 * Route zum Ausführen des obenstehenden Test-Skripts.
 *
 * POST /api/opcua/test
 * Body: { endpoint, username, password, securityPolicy }
 *
 * Die Route startet das lokale Node-Skript und gibt stdout/stderr sowie Exit-Code zurück.
 * Timeout standardmäßig 20s.
 */

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

function runNodeScript(scriptPath, args = [], timeoutMs = 20000) {
  return new Promise((resolve) => {
    const proc = spawn('/usr/bin/node', [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code, signal) => {
      clearTimeout(to);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    proc.on('error', (err) => {
      clearTimeout(to);
      resolve({ code: 255, signal: null, stdout, stderr: err.message, timedOut });
    });
  });
}

router.post('/test', async (req, res) => {
  const { endpoint, username, password, securityPolicy } = req.body || {};

  if (!endpoint) {
    return res.status(400).json({ ok: false, error: 'endpoint fehlt' });
  }

  // Verwende das neue, permanente Skript im scripts-Verzeichnis
  const script = '/opt/process-logger/scripts/opcua-session-test.js';
  const args = [endpoint];
  if (username) args.push(username);
  if (password) args.push(password);
  if (securityPolicy) args.push(securityPolicy);

  try {
    const result = await runNodeScript(script, args, 20000);
    const ok = result.code === 0 && !result.timedOut;
    res.json({
      ok,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

module.exports = router;