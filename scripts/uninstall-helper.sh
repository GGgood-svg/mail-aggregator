#!/bin/sh
# Root-only helper. The Web process may invoke only the two fixed modes allowed
# by sudoers: remove-app or purge. It never accepts paths or shell commands.
set -eu

MODE="${1:-}"
[ "$MODE" = "remove-app" ] || [ "$MODE" = "purge" ] || {
  echo "invalid uninstall mode" >&2
  exit 2
}
[ "$(id -u)" -eq 0 ] || exit 3

APP_DIR="/opt/mail-aggregator"
DATA_DIR="/var/lib/mail-aggregator"
CONFIG_DIR="/etc/mail-aggregator"
SERVICE_NAME="mail-aggregator"
HELPER_PATH="/usr/local/sbin/mail-aggregator-uninstall-helper"

DOVECOT_USER="mailuser"
if [ -r "$CONFIG_DIR/config" ]; then
  value="$(sed -n 's/^DOVECOT_USER=//p' "$CONFIG_DIR/config" | head -n 1)"
  if printf '%s' "$value" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$'; then
    DOVECOT_USER="$value"
  fi
fi

if command -v rc-service >/dev/null 2>&1; then
  rc-service "$SERVICE_NAME" stop 2>/dev/null || true
  rc-update del "$SERVICE_NAME" default 2>/dev/null || true
  if [ "$MODE" = "purge" ]; then
    rc-service dovecot stop 2>/dev/null || true
    rc-update del dovecot default 2>/dev/null || true
  fi
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  if [ "$MODE" = "purge" ]; then
    systemctl stop dovecot 2>/dev/null || true
    systemctl disable dovecot 2>/dev/null || true
  fi
  systemctl daemon-reload 2>/dev/null || true
fi

rm -f /etc/init.d/mail-aggregator
rm -f /etc/systemd/system/mail-aggregator.service
rm -f /etc/sudoers.d/mail-aggregator
rm -f /usr/local/sbin/mail-aggregator-dovecot-helper
rm -f /usr/local/sbin/mail-aggregator-dovecot-perms.sh
rm -f /var/log/mail-aggregator.log /var/log/mail-aggregator.err.log
rm -rf "$APP_DIR" "$DATA_DIR" "$CONFIG_DIR"

if [ "$MODE" = "purge" ]; then
  rm -rf "/home/$DOVECOT_USER"
  rm -rf /etc/dovecot
  userdel -r "$DOVECOT_USER" 2>/dev/null || deluser "$DOVECOT_USER" 2>/dev/null || true
  userdel -r mailadmin 2>/dev/null || deluser mailadmin 2>/dev/null || true
  if command -v apk >/dev/null 2>&1; then
    apk del dovecot dovecot-openrc imapsync 2>/dev/null || true
  elif command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y dovecot-core dovecot-imapd imapsync 2>/dev/null || true
    apt-get autoremove -y 2>/dev/null || true
  fi
fi

# The helper is deliberately the final target removed.
rm -f "$HELPER_PATH"
