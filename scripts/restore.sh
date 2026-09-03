#!/bin/sh
# Restore a manifest-verified backup created by backup.sh or the Web UI.
# Maildir is never touched. The current administrator, deployment settings and
# local Dovecot password are preserved.
set -eu

DATA_DIR="${MAIL_AGG_DATA_DIR:-/var/lib/mail-aggregator}"
BACKUP_FILE="${1:-}"
CHECKSUM_FILE="${2:-}"
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 执行。" >&2
  exit 1
fi
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "用法: $0 /path/to/mail-aggregator-YYYYMMDD-HHMMSS.tar.gz [backup.tar.gz.sha256]" >&2
  exit 1
fi

if [ -n "$CHECKSUM_FILE" ]; then
  "$PROJECT_ROOT/scripts/verify-backup.sh" "$BACKUP_FILE" "$CHECKSUM_FILE"
else
  "$PROJECT_ROOT/scripts/verify-backup.sh" "$BACKUP_FILE"
fi

echo "将恢复账号、设置、同步历史和远端邮箱凭据；当前管理员、本机部署设置、本地Dovecot密码和Maildir不会被修改。"
printf "确认恢复? [y/N] "
read -r answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || exit 0

if command -v rc-service >/dev/null 2>&1; then
  rc-service mail-aggregator stop \
    || { echo "无法停止 mail-aggregator，恢复已取消。" >&2; exit 1; }
elif command -v systemctl >/dev/null 2>&1; then
  systemctl stop mail-aggregator \
    || { echo "无法停止 mail-aggregator，恢复已取消。" >&2; exit 1; }
else
  echo "无法识别服务管理器，恢复已取消。" >&2
  exit 1
fi
if [ -n "$CHECKSUM_FILE" ]; then
  MAIL_AGG_DATA_DIR="$DATA_DIR" MAIL_AGG_CLI_RESTORE_STOPPED=1 node "$PROJECT_ROOT/server/cli-restore.js" "$BACKUP_FILE" "$CHECKSUM_FILE"
else
  MAIL_AGG_DATA_DIR="$DATA_DIR" MAIL_AGG_CLI_RESTORE_STOPPED=1 node "$PROJECT_ROOT/server/cli-restore.js" "$BACKUP_FILE"
fi

echo "恢复完成。服务仍处于停止状态；检查输出和配置后手动启动 mail-aggregator。"
