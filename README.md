# Facharbeit

Enthält Hilfs‑Skripte zum Setzen einer statischen IPv4‑Adresse via NetworkManager.

Dateien
- scripts/set-eth0-static.sh — Script zum Anlegen/Modifizieren einer statischen NM‑Connection (siehe Usage im Script).
- scripts/commands_examples.sh — kommentierte Beispielaufrufe, Prüf‑ und Git‑Befehle.

Beispiele
- Einfacher Aufruf:
  sudo ./scripts/set-eth0-static.sh 192.168.0.150/24 192.168.0.1

- Mit mehreren DNS:
  sudo ./scripts/set-eth0-static.sh 192.168.0.150/24 192.168.0.1 "8.8.8.8 1.1.1.1"

Weitere Hinweise
- Anderes Interface per Umgebungsvariable: `sudo IFACE=eth1 ./scripts/set-eth0-static.sh ...`
- Prüfen nach Ausführung:
  - `ip addr show dev <IFACE>`
  - `nmcli connection show --active`

Lizenz / Hinweise
- Füge bei Bedarf eine Lizenzdatei (z. B. `LICENSE`) hinzu.
- Achte darauf, keine sensiblen Daten (Passwörter/Privat-IPs) ins Repo zu commiten.