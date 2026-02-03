#!/bin/sh

# Kommentierte Beispiel‑Aufrufe und Prüf‑/Git‑Befehle für set-eth0-static.sh

# --- 1) Einfacher Aufruf: IP + Gateway (DNS bleibt Standard aus dem Script) ---
# Setzt eth0 auf 192.168.0.150/24 mit Gateway 192.168.0.1
sudo ./set-eth0-static.sh 192.168.0.150/24 192.168.0.1

# --- 2) Aufruf mit mehreren DNS‑Servern (DNS-String in Anführungszeichen) ---
# Setzt IP + Gateway und nutzt Google + Cloudflare als DNS
sudo ./set-eth0-static.sh 192.168.0.150/24 192.168.0.1 "8.8.8.8 1.1.1.1"

# --- 3) Anderes Interface per Umgebungsvariable (z. B. eth1) ---
# Setzt Interface eth1 auf 10.0.0.42/24, Gateway 10.0.0.1, DNS 8.8.8.8
sudo IFACE=eth1 ./set-eth0-static.sh 10.0.0.42/24 10.0.0.1 "8.8.8.8"

# --- 4) Manuelle nmcli‑Alternativen (falls du nmcli direkt nutzen willst) ---
# Neue Connection anlegen (DHCP aus, statisch)
sudo nmcli connection add type ethernet ifname eth0 con-name eth0-static \
  ipv4.addresses 192.168.0.150/24 ipv4.gateway 192.168.0.1 \
  ipv4.dns "8.8.8.8 1.1.1.1" ipv4.method manual autoconnect yes

# Bestehende Connection (z. B. "eth0-dhcp") auf statisch umstellen
sudo nmcli connection modify "eth0-dhcp" ipv4.addresses 192.168.0.150/24 \
  ipv4.gateway 192.168.0.1 ipv4.dns "8.8.8.8 1.1.1.1" ipv4.method manual autoconnect yes
sudo nmcli connection up "eth0-dhcp"

# --- 5) Prüf‑ / Debug‑Befehle (nach Ausführung) ---
# Zeigt die gesetzten Adressen für eth0
ip addr show dev eth0

# Zeigt aktive NetworkManager‑Verbindungen
nmcli connection show --active

# Gerätestatus (connected/disconnected)
nmcli device status

# Logs (falls etwas schiefgeht)
sudo journalctl -u NetworkManager -n 200 --no-pager

# --- 6) Git‑Befehle: Datei zum Repo hinzufügen und pushen ---
# (im Repo‑Root ausführen)
# Datei erstellen/überschreiben:
# cat > commands_examples.sh <<'EOF'
# (Inhalt dieser Datei)
# EOF

# ausführbar machen (optional)
chmod +x commands_examples.sh

# commit & push
git add commands_examples.sh
git commit -m "Add commented example calls for set-eth0-static.sh"
git push origin main

# --- ENDE ---