const express = require('express');
const { execFile } = require('child_process');
const router = express.Router();

function runFile(cmd, args = []) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

// POST /api/ntp { "server":"192.168.0.10", "applyNow": false }
router.post('/ntp', async (req, res) => {
  const { server, applyNow } = req.body || {};
  if (!server) return res.status(400).json({ ok: false, error: 'server required' });

  try {
    const args = ['/usr/local/sbin/set-chrony-server.sh', server];
    if (applyNow) args.push('makestep');
    await runFile('/usr/bin/sudo', args);
    return res.json({ ok: true });
  } catch (e) {
    // aussagekräftig loggen, damit wir den Fehler sehen
    console.error('ntp-api error:', JSON.stringify({
      errMessage: e.err && e.err.message,
      code: e.err && e.err.code,
      stdout: e.stdout && e.stdout.toString().slice(0,1000),
      stderr: e.stderr && e.stderr.toString().slice(0,1000)
    }, null, 2));
    // verständliche Fehlermeldung an Client
    const clientMsg = (e.stderr && e.stderr.toString()) || (e.err && e.err.message) || 'Interner Fehler';
    return res.status(500).json({ ok: false, error: clientMsg });
  }
});

module.exports = router;
