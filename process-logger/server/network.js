const express = require('express');
const { execFile, exec } = require('child_process');
const path = require('path');
const router = express.Router();

const SCRIPT = '/usr/local/bin/apply-network.sh';

// NOTE: Ensure you mount an auth middleware before these routes in your app
// e.g. app.use('/api/network', authMiddleware, require('./api/network'))

router.post('/apply', async (req, res) => {
  try {
    const { iface='eth0', ip, subnet, gateway } = req.body || {};
    if (!ip || !subnet) return res.status(400).json({ error: 'Missing ip or subnet' });

    // basic validation (server-side)
    const ipv4re = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
    if (!ipv4re.test(ip) && ip.indexOf(':') === -1) {
      return res.status(400).json({ error: 'Invalid IP format' });
    }

    // execute script via sudo (sudoers must allow it)
    const args = [SCRIPT, iface, ip, subnet];
    if (gateway) args.push(gateway);

    // We call via sudo to ensure root privileges
    execFile('sudo', args, { timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('apply-network err', err, stderr);
        return res.status(500).json({ error: stderr || err.message || String(err) });
      }
      res.json({ ok: true, out: stdout ? stdout.trim() : '' });
    });
  } catch (e) {
    console.error('apply-network catch', e);
    res.status(500).json({ error: String(e) });
  }
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