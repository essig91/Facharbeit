#!/bin/sh
# Setze eth0 (oder anderes Interface) auf statische IPv4 mit NetworkManager (nmcli)
# Usage:
#   sudo ./set-eth0-static.sh 192.168.0.150/24 192.168.0.1 "8.8.8.8 1.1.1.1"
set -eu

IFACE="${IFACE:-eth0}"
CONN_NAME="${CONN_NAME:-eth0-static}"

IP="${1:-}"
GATEWAY="${2:-}"
DNS="${3:-8.8.8.8 1.1.1.1}"

if [ -z "$IP" ] || [ -z "$GATEWAY" ]; then
  echo "Usage: sudo $0 <IP/CIDR> <GATEWAY> [DNS_LIST]"
  exit 1
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "nmcli nicht gefunden. NetworkManager scheint nicht installiert."
  exit 2
fi

EXISTING_CONN=$(nmcli -t -f NAME,DEVICE connection show | awk -F: -v iface="$IFACE" '$2==iface {print $1; exit}')

if [ -n "$EXISTING_CONN" ]; then
  echo "Modifiziere vorhandene Connection '$EXISTING_CONN' für Interface $IFACE ..."
  nmcli connection modify "$EXISTING_CONN" \
    ipv4.addresses "$IP" \
    ipv4.gateway "$GATEWAY" \
    ipv4.dns "$DNS" \
    ipv4.method manual \
    autoconnect yes
  nmcli connection up "$EXISTING_CONN" || nmcli connection reload "$EXISTING_CONN"
  USED_CONN="$EXISTING_CONN"
else
  echo "Erstelle neue Connection '$CONN_NAME' für Interface $IFACE ..."
  nmcli connection add type ethernet ifname "$IFACE" con-name "$CONN_NAME" \
    ipv4.addresses "$IP" \
    ipv4.gateway "$GATEWAY" \
    ipv4.dns "$DNS" \
    ipv4.method manual \
    autoconnect yes
  nmcli connection up "$CONN_NAME"
  USED_CONN="$CONN_NAME"
fi

echo "Fertig. Aktuelle Adresse für $IFACE:"
ip addr show dev "$IFACE"
echo
echo "Aktive NM-Connection '$USED_CONN':"
nmcli -g ipv4.addresses,ipv4.gateway,ipv4.dns connection show "$USED_CONN"
exit 0
