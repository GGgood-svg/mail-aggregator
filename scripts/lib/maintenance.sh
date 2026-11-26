#!/bin/sh
# Shared advisory lock. The directory and inode stay under root control;
# mailadmin can open the existing inode read-only for the Web restore route.
MAINTENANCE_DIR=/run/mail-aggregator-maintenance
MAINTENANCE_LOCK="$MAINTENANCE_DIR/lock"
prepare_mail_aggregator_maintenance() {
    if id mailadmin >/dev/null 2>&1; then
        install -d -m 0750 -o root -g mailadmin "$MAINTENANCE_DIR"
        [ -f "$MAINTENANCE_LOCK" ] || (umask 077; : >> "$MAINTENANCE_LOCK")
        chown root:mailadmin "$MAINTENANCE_LOCK"
        chmod 0640 "$MAINTENANCE_LOCK"
    else
        install -d -m 0700 -o root -g root "$MAINTENANCE_DIR"
        [ -f "$MAINTENANCE_LOCK" ] || (umask 077; : >> "$MAINTENANCE_LOCK")
    fi
}
lock_mail_aggregator_maintenance() {
    [ "${MAIL_AGG_MAINTENANCE_HELD:-}" != 1 ] || return 0
    [ "$(id -u)" -eq 0 ] || return 0
    if ! command -v flock >/dev/null 2>&1; then
        [ ! -e /opt/mail-aggregator ] || { echo '需要 flock 才能维护该安装。' >&2; exit 1; }
        return 0
    fi
    prepare_mail_aggregator_maintenance
    # Open the lock in the parent shell. This also works with Alpine's
    # BusyBox flock, which has neither --close nor --conflict-exit-code.
    MAIL_AGG_MAINTENANCE_HELD=1 exec /bin/sh -c '
        exec 9<"$1"
        flock -n 9 || { echo "另一项 Mail Aggregator 维护正在进行。" >&2; exit 73; }
        shift
        (exec 9<&-; exec "$@")
        result=$?
        exit "$result"
    ' sh "$MAINTENANCE_LOCK" "$@"
}
assert_mail_aggregator_unresolved_absent() {
    [ ! -e /var/lib/mail-aggregator-updater/journal.json ] && [ ! -e /var/lib/mail-aggregator-updater/manual-gate ] &&
        [ ! -e /opt/mail-aggregator.install-rollback ] || { echo '应用升级事务未结束，先完成升级恢复。' >&2; return 1; }
}
stop_mail_aggregator_services() {
    if command -v rc-service >/dev/null 2>&1; then
        for unit in mail-aggregator-updater mail-aggregator; do
            [ -e "/etc/init.d/$unit" ] || continue
            if rc-service "$unit" status >/dev/null 2>&1; then rc-service "$unit" stop || return 1; fi
            if rc-service "$unit" status >/dev/null 2>&1; then return 1; fi
            rc-update del "$unit" default 2>/dev/null || true
        done
        if [ -r /run/mail-aggregator.pid ]; then
            read -r old_pid < /run/mail-aggregator.pid || return 1
            case "$old_pid" in ''|*[!0-9]*|0|1) return 1;; esac
            if kill -0 "$old_pid" 2>/dev/null; then return 1; fi
        fi
    elif [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
        for unit in mail-aggregator-updater.service mail-aggregator.service; do
            load=$(systemctl show -p LoadState --value "$unit") || [ "$load" = not-found ] || return 1
            [ "$load" != not-found ] || continue
            systemctl stop "$unit" || return 1
            case "$(systemctl show -p ActiveState --value "$unit")" in inactive|failed) ;; *) return 1;; esac
            [ "$(systemctl show -p MainPID --value "$unit")" = 0 ] || return 1
            systemctl disable "$unit" || return 1
        done
    else
        return 1
    fi
}
remove_mail_aggregator_updater() {
    rm -f /etc/init.d/mail-aggregator-updater /etc/mail-aggregator/enable-app-updates
    rm -rf /usr/local/lib/mail-aggregator-updater /var/lib/mail-aggregator-updater \
        /opt/mail-aggregator.update-stage /opt/mail-aggregator.update-previous
}
