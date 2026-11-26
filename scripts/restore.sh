#!/bin/sh
# Inspect and stage as the service user before stopping the installed service.
set -eu
DATA_DIR="${MAIL_AGG_DATA_DIR:-/var/lib/mail-aggregator}"
BACKUP_FILE="${1:-}"
CHECKSUM_FILE="${2:-}"
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$(id -u)" -eq 0 ] || { echo '请使用 root 执行。' >&2; exit 1; }
[ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ] || {
  echo "用法: $0 /path/to/backup.tar.gz [backup.tar.gz.sha256]" >&2; exit 1;
}
. "$PROJECT_ROOT/scripts/lib/maintenance.sh"
lock_mail_aggregator_maintenance /bin/sh "$0" "$@"
assert_mail_aggregator_unresolved_absent
node -e 'new (require(process.argv[1]))(":memory:").close()' "$PROJECT_ROOT/node_modules/better-sqlite3" || {
  echo '请使用安装目录中的 scripts/restore.sh，依赖检查失败，服务没有停止。' >&2; exit 1;
}

STAGING=/var/lib/mail-aggregator-updater
install -d -m 0750 -o root -g mailadmin "$STAGING"
# A previous interrupted command must release the host lock first. Never
# remove staging while application recovery may still reference its input.
if [ ! -e "$DATA_DIR/.restore-journal.json" ] && [ ! -L "$DATA_DIR/.restore-journal.json" ]; then
  find "$STAGING" -maxdepth 1 -type d -user root -name 'cli-input.??????' -mtime +1 \
    -exec rm -rf -- {} \;
fi
node "$PROJECT_ROOT/server/cli-restore.js" check-input "$BACKUP_FILE" "$STAGING" "$CHECKSUM_FILE"
input=$(mktemp -d "$STAGING/cli-input.XXXXXX")
trap 'if [ -e "$DATA_DIR/.restore-journal.json" ] || [ -L "$DATA_DIR/.restore-journal.json" ]; then
        printf "恢复现场保留: %s\n" "$input" >&2
      else rm -rf -- "$input"; fi' EXIT
trap 'exit 1' HUP INT TERM
archive="$input/$(basename -- "$BACKUP_FILE")"
# Reserve metadata names and prevent a backup filename from colliding.
case "${archive##*/}" in work|prepared.json|checksum) echo '归档文件名无效。' >&2; exit 1;; esac
install -m 0440 -o root -g mailadmin -- "$BACKUP_FILE" "$archive"
checksum=''
if [ -n "$CHECKSUM_FILE" ]; then
  install -d -m 0750 -o root -g mailadmin "$input/checksum"
  checksum="$input/checksum/expected.sha256"
  install -m 0440 -o root -g mailadmin -- "$CHECKSUM_FILE" "$checksum"
fi
chgrp mailadmin "$input"
chmod 0750 "$input"
install -d -m 0700 -o mailadmin -g mailadmin "$input/work"
export MAIL_AGG_DATA_DIR="$DATA_DIR" MAIL_AGG_RESTORE_ROOT="$PROJECT_ROOT" MAIL_AGG_RESTORE_INPUT="$input"
export MAIL_AGG_RESTORE_ARCHIVE="$archive" MAIL_AGG_RESTORE_CHECKSUM="$checksum"
(umask 077; : > "$input/prepared.json")
chgrp mailadmin "$input/prepared.json"
chmod 0440 "$input/prepared.json"
su -s /bin/sh mailadmin -c 'exec node "$MAIL_AGG_RESTORE_ROOT/server/cli-restore.js" prepare "$MAIL_AGG_RESTORE_INPUT" "$MAIL_AGG_RESTORE_ARCHIVE" "$MAIL_AGG_RESTORE_CHECKSUM"' \
  > "$input/prepared.json"
node -e 'const d=require(process.argv[1]); console.log(`停服前预检通过：${d.database.accountCount} 个账号，SHA-256 ${d.verified.archiveSha256}`)' "$input/prepared.json"

echo '将恢复账号、设置、同步历史和远端邮箱凭据；当前管理员、本机部署设置、本地Dovecot密码和Maildir不会被修改。'
printf '确认恢复? [y/N] '
read -r answer || answer=''
[ "$answer" = y ] || [ "$answer" = Y ] || exit 0

was_running=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  manager=systemd
  if systemctl is-active --quiet mail-aggregator; then was_running=1; fi
  systemctl stop mail-aggregator
  [ "$(systemctl show -p MainPID --value mail-aggregator)" = 0 ] || exit 1
elif command -v rc-service >/dev/null 2>&1; then
  manager=openrc
  old_pid=''
  if [ -r /run/mail-aggregator.pid ]; then
    read -r old_pid < /run/mail-aggregator.pid || exit 1
    case "$old_pid" in ''|*[!0-9]*|0|1) exit 1;; esac
  fi
  if rc-service mail-aggregator status >/dev/null 2>&1; then
    was_running=1
    rc-service mail-aggregator stop
  fi
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then exit 1; fi
else
  echo '无法识别服务管理器，恢复已取消。' >&2
  exit 1
fi
if ! MAIL_AGG_CLI_RESTORE_STOPPED=1 su -s /bin/sh mailadmin -c 'exec node "$MAIL_AGG_RESTORE_ROOT/server/cli-restore.js" apply "$MAIL_AGG_RESTORE_INPUT"'; then
  if [ "$was_running" = 1 ] && [ ! -e "$DATA_DIR/.restore-journal.json" ] && [ ! -L "$DATA_DIR/.restore-journal.json" ]; then
    echo '恢复未完成；尝试恢复原服务。' >&2
    if [ "$manager" = openrc ]; then rc-service mail-aggregator start; else systemctl start mail-aggregator; fi
  fi
  exit 1
fi
echo '恢复完成。服务仍处于停止状态；检查输出和配置后手动启动 mail-aggregator。'
