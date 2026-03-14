# Root Terminal Setup (ttyd)

Diese Anleitung startet einen separaten, vollwertigen Root-Terminal-Dienst.

## 1) Installation

Option A (ttyd, wenn Paket vorhanden):

```bash
sudo apt update
sudo apt install -y ttyd
```

Wenn der Fehler Unable to locate package ttyd erscheint, nutze Option B.

Option B (Fallback mit shellinabox, meist in Debian-Repos vorhanden):

```bash
sudo apt update
sudo apt install -y shellinabox
```

## 2) Systemd Service als root (ttyd)

Datei `/etc/systemd/system/process-logger-root-terminal.service`:

```ini
[Unit]
Description=Process Logger Root Terminal (ttyd)
After=network.target

[Service]
Type=simple
User=root
Group=root
ExecStart=/usr/bin/ttyd -p 7681 -c admin:change-me /bin/bash -l
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Dann aktivieren:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now process-logger-root-terminal.service
sudo systemctl status process-logger-root-terminal.service
```

## 2b) Alternative mit shellinabox (ohne extra Service-Datei)

Nach Installation startet shellinabox meist automatisch auf Port 4200.

Status pruefen:

```bash
sudo systemctl status shellinabox
```

Port anpassen (optional):

Datei /etc/default/shellinabox bearbeiten und dort SHELLINABOX_PORT setzen, danach:

```bash
sudo systemctl restart shellinabox
```

## 3) In der Web-UI nutzen

- Seite `root-terminal.html` oeffnen
- URL eintragen:
	- ttyd: http://<deine-ip>:7681
	- shellinabox: https://<deine-ip>:4200
- Verbinden oder in neuem Tab oeffnen

## Sicherheitshinweis

- Unbedingt starkes Passwort statt `change-me` setzen.
- Zugriff per Firewall nur aus dem lokalen Netz erlauben.
- Optional TLS/Reverse Proxy (z. B. Nginx) davor schalten.
