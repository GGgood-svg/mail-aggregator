#!/bin/sh
# mail-aggregator-dovecot-helper
#
# 这个脚本以root身份安装(/usr/local/sbin,mode 0700),mailadmin只能通过
# sudoers里严格限定的几条规则调用固定的子命令,不能执行任意shell。
#
# 子命令:
#   get-hash <username>        打印/etc/dovecot/users里该用户当前的密码哈希,不存在则打印NONE
#   set-password <username>    从stdin读一行新的密码哈希(调用方已经在Node那边生成好了,
#                               这个脚本从头到尾不接触明文密码),备份旧文件、写入新哈希、reload
#   restore-backup              把/etc/dovecot/users恢复成上一次set-password之前的备份,reload
#   reload                      单纯reload一次dovecot
#
# 所有子命令只做这一件事,不接受除了上面这几个固定子命令之外的任何操作,
# username参数会做严格的格式校验,拒绝任何不像合法Linux用户名的输入。

set -e

USERS_FILE="${MAIL_AGG_DOVECOT_USERS_FILE:-/etc/dovecot/users}"
BACKUP_FILE="${MAIL_AGG_DOVECOT_BACKUP_FILE:-/etc/dovecot/users.mail-aggregator-backup}"

# fix_users_permissions() 的唯一定义在这份文件里(install.sh --full 部署时
# 会把它和这个 helper 一起复制到 /usr/local/sbin),set-password/
# restore-backup 写完文件之后都必须调用它来设置权限,不能自己另外
# chown/chmod——v0.1.3.2 的回归就是这里自己维护了一份和 install.sh 不一致
# 的权限逻辑(无条件 root:root 600),把 install.sh 装机时设好的
# root:<Dovecot内部组> 640 又改了回去,导致Web改密码之后 Dovecot 认证读不到
# 这个文件。
PERMS_LIB="${MAIL_AGG_DOVECOT_PERMS_LIB:-/usr/local/sbin/mail-aggregator-dovecot-perms.sh}"
if [ ! -f "$PERMS_LIB" ]; then
  echo "ERROR: 找不到 $PERMS_LIB(fix_users_permissions 的定义),helper 和 install.sh 版本可能不匹配,请重新运行 ./scripts/install.sh --full 来修复" >&2
  exit 1
fi
# shellcheck source=lib/dovecot-perms.sh
. "$PERMS_LIB"

validate_username() {
  # 只允许字母开头,后面跟字母数字下划线短横线,长度1-32,和adduser默认规则一致
  case "$1" in
    "") echo "ERROR: empty username" >&2; exit 1 ;;
  esac
  echo "$1" | grep -Eq '^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$' || {
    echo "ERROR: invalid username format" >&2
    exit 1
  }
}

reload_dovecot() {
  if command -v doveadm >/dev/null 2>&1; then
    doveadm reload 2>/dev/null && return 0
  fi
  rc-service dovecot reload 2>/dev/null || rc-service dovecot restart
}

cmd_get_hash() {
  USERNAME="$1"
  validate_username "$USERNAME"
  if [ ! -f "$USERS_FILE" ]; then
    echo "NONE"
    return 0
  fi
  LINE=$(grep -E "^${USERNAME}:" "$USERS_FILE" || true)
  if [ -z "$LINE" ]; then
    echo "NONE"
    return 0
  fi
  # users文件格式: username:hash:uid:gid:home::: ,只要第二个字段
  echo "$LINE" | cut -d: -f2
}

cmd_set_password() {
  USERNAME="$1"
  validate_username "$USERNAME"

  NEW_HASH=$(head -n1)
  if [ -z "$NEW_HASH" ]; then
    echo "ERROR: no hash provided on stdin" >&2
    exit 1
  fi
  # 哈希本身不应该包含冒号或换行(避免破坏passwd-file的字段分隔),做个基本检查
  case "$NEW_HASH" in
    *:*) echo "ERROR: hash must not contain ':'" >&2; exit 1 ;;
  esac

  if [ ! -f "$USERS_FILE" ]; then
    echo "ERROR: $USERS_FILE does not exist, run install.sh --full first" >&2
    exit 1
  fi

  cp -p "$USERS_FILE" "$BACKUP_FILE"

  if grep -qE "^${USERNAME}:" "$USERS_FILE"; then
    # 保留原有的uid:gid:home等字段,只替换第二个字段(哈希)
    TMP_FILE="${USERS_FILE}.tmp.$$"
    awk -F: -v u="$USERNAME" -v h="$NEW_HASH" \
      'BEGIN{OFS=":"} $1==u {$2=h} {print}' "$USERS_FILE" > "$TMP_FILE"
    mv "$TMP_FILE" "$USERS_FILE"
  else
    echo "${USERNAME}:${NEW_HASH}::::::" >> "$USERS_FILE"
  fi
  fix_users_permissions "$USERS_FILE"

  if reload_dovecot; then
    echo "OK"
  else
    # set-password has already replaced USERS_FILE. Restore the exact backup
    # before reporting failure so the caller never observes a half-committed
    # password change.
    if cp -p "$BACKUP_FILE" "$USERS_FILE" \
      && fix_users_permissions "$USERS_FILE" \
      && reload_dovecot; then
      echo "ERROR: dovecot reload failed; previous users file restored" >&2
    else
      echo "ERROR: dovecot reload failed; rollback or rollback reload also failed, inspect $USERS_FILE and $BACKUP_FILE" >&2
    fi
    exit 1
  fi
}

cmd_restore_backup() {
  if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: no backup file found at $BACKUP_FILE" >&2
    exit 1
  fi
  cp -p "$BACKUP_FILE" "$USERS_FILE"
  fix_users_permissions "$USERS_FILE"
  if reload_dovecot; then
    echo "OK"
  else
    echo "ERROR: dovecot reload failed after restore" >&2
    exit 1
  fi
}

cmd_reload() {
  if reload_dovecot; then
    echo "OK"
  else
    echo "ERROR: dovecot reload failed" >&2
    exit 1
  fi
}

case "$1" in
  get-hash) shift; cmd_get_hash "$1" ;;
  set-password) shift; cmd_set_password "$1" ;;
  restore-backup) cmd_restore_backup ;;
  reload) cmd_reload ;;
  *)
    echo "ERROR: unknown subcommand '$1'" >&2
    echo "usage: $0 {get-hash <user>|set-password <user>|restore-backup|reload}" >&2
    exit 1
    ;;
esac
