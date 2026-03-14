'use strict';

const express = require('express');
const { execFile } = require('child_process');

const router = express.Router();
const MAX_COMMAND_LENGTH = 500;
const EXEC_TIMEOUT_MS = 20000;
const MAX_STDOUT_BYTES = 200 * 1024;

function roleLevel(req) {
  const roles = (req && req.auth && Array.isArray(req.auth.roles)) ? req.auth.roles : [];
  if (roles.includes('Systemadministrator')) return 5;
  if (roles.includes('Administrator')) return 4;
  if (roles.includes('Bediener')) return 3;
  if (roles.includes('Beobachten')) return 2;
  if (roles.includes('Trend')) return 1;
  return 0;
}

router.post('/exec', (req, res) => {
  if (roleLevel(req) < 5) {
    return res.status(403).json({ ok: false, error: 'Keine Berechtigung.' });
  }
  const command = String((req.body && req.body.command) || '').trim();

  if (!command) {
    return res.status(400).json({ ok: false, error: 'Kein Befehl angegeben.' });
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    return res.status(400).json({ ok: false, error: 'Befehl ist zu lang.' });
  }

  const file = 'bash';
  const args = ['-lc', command];
  const execOptions = {
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: MAX_STDOUT_BYTES,
    windowsHide: true
  };

  execFile(file, args, execOptions, (err, stdout, stderr) => {
    const out = String(stdout || '');
    const errOut = String(stderr || '');

    if (err) {
      const message = err && err.message ? String(err.message) : 'Ausfuehrung fehlgeschlagen.';

      return res.status(200).json({
        ok: false,
        error: message,
        stdout: out,
        stderr: errOut,
        exitCode: typeof err.code === 'number' ? err.code : null
      });
    }

    return res.json({
      ok: true,
      stdout: out,
      stderr: errOut,
      exitCode: 0
    });
  });
});

module.exports = router;
