#!/bin/sh
# Source from the trusted installer, not from the running application's tree.
INSTALL_ROLLBACK=/opt/mail-aggregator.install-rollback
APP_PREVIOUS=/opt/mail-aggregator.previous
APP_FAILED=/opt/mail-aggregator.install-failed
MANUAL_GATE=/var/lib/mail-aggregator-updater/manual-gate
MANUAL_START=/run/mail-aggregator-maintenance/manual-start
INSTALL_FILES='/etc/mail-aggregator/config /etc/init.d/mail-aggregator /etc/systemd/system/mail-aggregator.service /etc/sudoers.d/mail-aggregator /usr/local/sbin/mail-aggregator-dovecot-helper /usr/local/sbin/mail-aggregator-dovecot-perms.sh /usr/local/sbin/mail-aggregator-uninstall-helper'

manual_update_guard() {
    assert_mail_aggregator_unresolved_absent ||
        fail_step 'upgrade' '有未完成的应用切换。' '手工安装请运行 install.sh --recover-application；自动更新请检查执行器日志。'
    if [ ! -d "$APP_DIR" ] && [ -d "$APP_PREVIOUS" ]; then mv "$APP_PREVIOUS" "$APP_DIR"; sync; fi
    if [ -d "$APP_PREVIOUS" ]; then
        fail_step 'upgrade' '仍有旧安装留下的 /opt/mail-aggregator.previous。' '请核对当前应用后手工归档该旧目录，再运行升级。'
    fi
}
manual_phase() {
    printf '%s\n' "$1" > "$INSTALL_ROLLBACK/.phase-new" && sync &&
        mv -f "$INSTALL_ROLLBACK/.phase-new" "$INSTALL_ROLLBACK/phase" && sync
}
manual_data() {
    action=$1; tree=$2
    su -s /bin/sh "$APP_USER" -c "/usr/bin/node /usr/local/lib/mail-aggregator-maintenance-data/data.js '$action' '$tree'"
}
manual_stop() {
    prior_pid=''
    if [ "$SERVICE_MANAGER" = openrc ] && [ -r /run/mail-aggregator.pid ]; then
        read -r prior_pid < /run/mail-aggregator.pid || return 1
        case "$prior_pid" in ''|*[!0-9]*|0|1) return 1;; esac
    fi
    if [ "$SERVICE_MANAGER" = openrc ] || service_status mail-aggregator >/dev/null 2>&1; then
        service_stop mail-aggregator || return 1
    fi
    if service_status mail-aggregator >/dev/null 2>&1; then return 1; fi
    if [ -n "$prior_pid" ] && kill -0 "$prior_pid" 2>/dev/null; then return 1; fi
    manual_data stopped "$1"
}
manual_start() {
    : > "$MANUAL_START" || return 1
    if [ "$SERVICE_MANAGER" = openrc ] && ! rc-service --ifcrashed mail-aggregator stop; then manual_rc=1
    elif service_status mail-aggregator >/dev/null 2>&1; then manual_rc=0
    elif service_start mail-aggregator; then manual_rc=0; else manual_rc=1; fi
    rm -f "$MANUAL_START"
    return "$manual_rc"
}
manual_update_prepare() {
    [ -d "$APP_DIR" ] || return 0
    install -d -m 0750 -o root -g "$APP_USER" /var/lib/mail-aggregator-updater
    prepare_mail_aggregator_maintenance
    mkdir -m 0700 "$INSTALL_ROLLBACK"
    trap 'manual_update_exit "$?"' EXIT
    trap 'exit 1' HUP INT TERM
    manual_phase draining
    if service_status mail-aggregator >/dev/null 2>&1; then
        printf '1\n' > "$INSTALL_ROLLBACK/was-running"
        if [ -S /run/mail-aggregator-update-app/control.sock ]; then
            : > "$MANUAL_GATE"
            node "$PROJECT_ROOT/scripts/updater/probe.js" idle || fail_step 'upgrade' '当前有任务或写入，升级已推迟。' '待作业完成后重试。'
        fi
    else
        printf '0\n' > "$INSTALL_ROLLBACK/was-running"
    fi
    for file in $INSTALL_FILES; do
        key=$(printf '%s' "$file" | tr '/' '_')
        if [ -f "$file" ]; then cp -p "$file" "$INSTALL_ROLLBACK/$key"; fi
    done
    : > "$MANUAL_GATE"
    manual_phase stopping
    manual_stop "$APP_STAGE" || fail_step 'upgrade' '无法确认旧版 Web 已退出。' '请核对服务日志。'
    if [ -f "$DATA_DIR/db/mail-aggregator.db" ]; then
        manual_data snapshot "$APP_STAGE" > "$INSTALL_ROLLBACK/db-pending"
        mv "$INSTALL_ROLLBACK/db-pending" "$INSTALL_ROLLBACK/database"
    fi
    manual_phase swapping
    mv "$APP_DIR" "$APP_PREVIOUS"
    sync
}
manual_update_complete() {
    [ -d "$INSTALL_ROLLBACK" ] || return 0
    manual_phase committed
    manual_update_recover
    trap - EXIT HUP INT TERM
}
manual_update_recover() {
    [ -d "$INSTALL_ROLLBACK" ] || { [ ! -e "$MANUAL_GATE" ]; return; }
    phase=$(cat "$INSTALL_ROLLBACK/phase" 2>/dev/null) || phase=draining
    cd / || return 1
    case "$phase" in
    committed)
        # The gate may already be gone and new writes may exist.
        rm -rf "$APP_PREVIOUS" || return 1
        ;;
    draining) ;;
    stopping|swapping)
        if [ "$phase" = swapping ]; then
            if [ -d "$APP_PREVIOUS" ]; then
                manual_stop "$APP_PREVIOUS" || return 1
                if [ -s "$INSTALL_ROLLBACK/database" ]; then
                    manual_data restore "$APP_PREVIOUS" < "$INSTALL_ROLLBACK/database" || return 1
                fi
                if [ -d "$APP_DIR" ]; then
                    rm -rf "$APP_FAILED" && mv "$APP_DIR" "$APP_FAILED" || return 1
                fi
                mv "$APP_PREVIOUS" "$APP_DIR" || return 1
                sync
            fi
            for file in $INSTALL_FILES; do
                key=$(printf '%s' "$file" | tr '/' '_')
                if [ -f "$INSTALL_ROLLBACK/$key" ]; then cp -p "$INSTALL_ROLLBACK/$key" "$file" || return 1
                else rm -f "$file" || return 1; fi
            done
            if [ "$SERVICE_MANAGER" = systemd ]; then systemctl daemon-reload || return 1; fi
        fi
        if [ "$(cat "$INSTALL_ROLLBACK/was-running")" = 1 ]; then
            manual_start || return 1
            if [ -f "$APP_DIR/server/update-gate.js" ]; then
                old_version=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).version)' "$APP_DIR/package.json") || return 1
                node "$PROJECT_ROOT/scripts/updater/probe.js" ready "$old_version" || return 1
            else
                # Legacy builds have no private readiness socket.
                old_port=$(manual_data port "$APP_DIR") || return 1
                old_bind=$( ([ ! -r /etc/mail-aggregator/config ] || . /etc/mail-aggregator/config; printf '%s' "${MAIL_AGG_BIND_HOST:-127.0.0.1}") )
                node "$PROJECT_ROOT/scripts/updater/probe.js" legacy-ready "$old_port" "$old_bind" || return 1
            fi
        fi
        ;;
    *) return 1 ;;
    esac
    rm -f "$MANUAL_GATE" "$MANUAL_START" || return 1
    sync
    rm -rf "$INSTALL_ROLLBACK" || return 1
    sync
}
manual_update_exit() {
    result=$1
    trap - EXIT HUP INT TERM
    if manual_update_recover; then
        echo '安装已停止；升级记录已处理。' >&2
    else
        echo '应用恢复或就绪检查未完成；已保留升级记录和快照。请运行 install.sh --recover-application。' >&2
    fi
    [ "$result" -ne 0 ] || result=1
    exit "$result"
}
