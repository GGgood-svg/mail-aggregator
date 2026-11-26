#!/bin/sh
# Stage, validate, and if necessary roll back a managed Dovecot config.
activate_dovecot_config() (
  set -eu
  renderer=$1
  umask 077
  staging=$(mktemp -d "${DOVECOT_CONF%/*}/.mail-aggregator-config.XXXXXXXX") || exit 1
  activated=0
  success=0
  prior_running=0
  if service_status dovecot >/dev/null 2>&1; then prior_running=1; fi
  cleanup_candidate() {
    if [ "$activated" -eq 1 ] && [ "$success" -ne 1 ]; then
      if [ "$prior_running" -ne 1 ]; then service_stop dovecot >/dev/null 2>&1 || true; fi
      if ! restore_candidate_file "$DOVECOT_CONF" "$staging/original.conf" ||
         ! restore_candidate_file "$DOVECOT_USERS_FILE" "$staging/original.users"; then
        echo "Dovecot 配置回退未完成，原文件保留于 $staging" >&2
        return
      fi
      if [ "$prior_running" -eq 1 ] && ! service_restart dovecot; then
        echo "已恢复原配置，Dovecot 重启失败，请检查服务日志。" >&2
      fi
    fi
    rm -rf -- "$staging"
  }
  restore_candidate_file() {
    if [ -f "$2" ]; then cp -p "$2" "$1"; else rm -f -- "$1"; fi
  }
  trap cleanup_candidate EXIT
  trap 'exit 1' HUP INT TERM
  for target in "$DOVECOT_CONF" "$DOVECOT_USERS_FILE"; do
    if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
      echo 'Dovecot 配置路径不是普通文件，停止初始化。' >&2
      exit 1
    fi
  done
  if [ -f "$DOVECOT_CONF" ]; then cp -p "$DOVECOT_CONF" "$staging/original.conf" || exit 1; fi
  if [ -f "$DOVECOT_USERS_FILE" ]; then cp -p "$DOVECOT_USERS_FILE" "$staging/original.users" || exit 1; fi

  "$renderer" > "$staging/candidate.conf" || exit 1
  doveconf -c "$staging/candidate.conf" -n >/dev/null || exit 1
  printf '%s:%s::::::\n' "$DOVECOT_USER" "$INITIAL_DOVECOT_HASH" > "$staging/candidate.users" || exit 1
  fix_users_permissions "$staging/candidate.users" "$staging/candidate.conf" || exit 1
  activated=1
  mv "$staging/candidate.users" "$DOVECOT_USERS_FILE" || exit 1
  mv "$staging/candidate.conf" "$DOVECOT_CONF" || exit 1
  if [ "$prior_running" -eq 1 ]; then service_restart dovecot || exit 1; else service_start dovecot || exit 1; fi

  printf '%s' "$INITIAL_DOVECOT_PASSWORD" | node "$APP_DIR/server/cli-imap-login-check.js" \
    "$DOVECOT_HOST" "$DOVECOT_PORT" "$DOVECOT_USER" || exit 1
  if [ "${WIZARD_FRESH:-0}" != 1 ]; then service_enable dovecot || exit 1; fi
  success=1
)
