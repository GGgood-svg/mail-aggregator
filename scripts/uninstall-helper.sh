#!/bin/sh
# Root-owned. sudoers permits only the fixed queue modes and a validated receipt ID.
set -eu
[ "$(id -u)" -eq 0 ] || exit 3
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset NODE_OPTIONS NODE_PATH ENV BASH_ENV
umask 077

HELPER=/usr/local/sbin/mail-aggregator-uninstall-helper
RECEIPTS=/var/lib/mail-aggregator-operations/uninstall
APP_DIR=/opt/mail-aggregator
DATA_DIR=/var/lib/mail-aggregator
CONFIG_DIR=/etc/mail-aggregator
DOVECOT_TOOL=/usr/local/lib/mail-aggregator-maintenance-data/owned-dovecot.js

valid_id() { printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'; }
valid_mode() { case "$1" in remove-app|purge|purge-dovecot) return 0;; *) return 1;; esac; }
state_of() { sed -n 's/.*"state":"\([a-z_]*\)".*/\1/p' "$RECEIPTS/$1.json"; }
record() {
    # Fixed data only; no shell output or credentials in the receipt. Flush both
    # file and directory so a 202 has a durable counterpart on the host.
    /usr/bin/node -e '
      const fs = require("node:fs");
      const [dir, id, mode, state, code, maildir, dovecot, worker] = process.argv.slice(1);
      const name = dir + "/" + id + ".json";
      const tmp = name + "." + process.pid;
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const pid = Number(worker);
      let start = null;
      try { start = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19]; } catch (_) {}
      const data = { id, mode, state, code, maildir, dovecot, pid, bootId, start, updatedAt: new Date().toISOString() };
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        try { fs.writeFileSync(fd, JSON.stringify(data) + "\n"); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmp, name);
        const parent = fs.openSync(dir, "r");
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      } finally { fs.rmSync(tmp, { force: true }); }
    ' "$RECEIPTS" "$id" "$mode" "$1" "${2:-}" "${maildir:-retained}" "${dovecot:-retained}" "$$"
}

# The installer only records a Maildir that it created on a new local host.
# An older install, a changed path, and an externally managed server have no
# proof of ownership. Never remove shared Dovecot packages, users or config from this Maildir step.
remove_owned_maildir() (
    marker="$CONFIG_DIR/owned-maildir"
    [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(stat -c '%u:%a' "$marker")" = 0:600 ] || return 4
    IFS=' ' read -r user home_id mail_id extra < "$marker" || return 4
    [ -z "$extra" ] && printf '%s\n' "$user" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || return 4
    [ -d "/home/$user" ] && [ ! -L /home ] && [ ! -L "/home/$user" ] || return 4
    cd -P "/home/$user" || return 4
    [ "$(pwd -P)" = "/home/$user" ] && [ "$(stat -c '%u:%d:%i' .)" = "$home_id" ] || return 4
    [ -d Maildir ] && [ ! -L Maildir ] && [ "$(stat -c '%u:%d:%i' Maildir)" = "$mail_id" ] || return 4
    # Refuse mounted subdirectories, including bind mounts on the same device.
    if awk -v p="/home/$user/Maildir" '$5==p || index($5,p "/")==1 {found=1} END{exit !found}' /proc/self/mountinfo; then return 4; fi
    rm -rf -- Maildir && [ ! -e Maildir ]
)

case "${1:-}" in
  dovecot-eligible)
    [ "$#" -eq 1 ] || exit 2
    exec /usr/bin/node "$DOVECOT_TOOL" eligible
    ;;
  status)
    [ "$#" -eq 2 ] && valid_id "$2" || exit 2
    [ -f "$RECEIPTS/$2.json" ] || exit 44
    exec /usr/bin/node -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (["accepted", "running"].includes(data.state)) {
        let active = false;
        try {
          const stat = fs.readFileSync(`/proc/${data.pid}/stat`, "utf8").split(") ").at(-1).split(" ");
          active = stat[0] !== "Z" && stat[19] === data.start && data.bootId === fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        } catch (_) {}
        if (!active) { data.state = "interrupted"; data.code = "check_host"; }
      }
      delete data.pid; delete data.start; delete data.bootId;
      process.stdout.write(JSON.stringify(data) + "\n");
    ' "$RECEIPTS/$2.json"
    ;;
  commit)
    [ "$#" -eq 2 ] && valid_id "$2" || exit 2
    [ -f "$RECEIPTS/$2.json" ] && [ "$(state_of "$2")" = accepted ] || exit 44
    : > "$RECEIPTS/$2.ready"
    ;;
  queue)
    [ "$#" -eq 2 ] && valid_mode "$2" || exit 2
    mode=$2
    install -d -m 0700 -o root -g root /var/lib/mail-aggregator-operations "$RECEIPTS"
    id=$(cat /proc/sys/kernel/random/uuid)
    valid_id "$id" || exit 1
    if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1; then
        systemd-run --quiet --collect --unit="mail-aggregator-uninstall-$id" --property=Type=exec \
            "$HELPER" run "$id" "$mode" || { record failed host_start_failed; exit 1; }
    elif command -v rc-service >/dev/null 2>&1 && command -v start-stop-daemon >/dev/null 2>&1; then
        . /usr/local/lib/mail-aggregator-maintenance.sh
        prepare_mail_aggregator_maintenance
        start-stop-daemon --start --background --make-pidfile --pidfile "$MAINTENANCE_DIR/uninstall-$id.pid" \
            --exec /bin/sh -- "$HELPER" run "$id" "$mode" </dev/null >/dev/null 2>&1 || { record failed host_start_failed; exit 1; }
    else
        record failed host_unavailable
        exit 1
    fi
    i=0
    while [ ! -f "$RECEIPTS/$id.json" ] && [ "$i" -lt 40 ]; do sleep 0.1; i=$((i+1)); done
    # If the launch handshake timed out, record a cancellation marker. A slow
    # worker is forbidden from accepting it afterwards.
    if [ ! -f "$RECEIPTS/$id.json" ]; then
        : > "$RECEIPTS/$id.cancel"
        if [ ! -f "$RECEIPTS/$id.json" ]; then exit 1; fi
    fi
    exec /bin/sh "$HELPER" status "$id"
    ;;
  run)
    [ "$#" -eq 3 ] && valid_id "$2" && valid_mode "$3" || exit 2
    id=$2 mode=$3 maildir=retained dovecot=retained
    [ ! -e "$RECEIPTS/$id.cancel" ] || exit 1
    . /usr/local/lib/mail-aggregator-maintenance.sh
    prepare_mail_aggregator_maintenance
    exec 9<"$MAINTENANCE_LOCK"
    if ! flock -n 9; then record busy maintenance_busy; exit 0; fi
    if ! assert_mail_aggregator_unresolved_absent || [ -e "$DATA_DIR/.restore-journal.json" ]; then
        record busy recovery_pending
        exit 0
    fi
    # Reject unowned configuration without waiting for the package manager.
    # The full plan can exceed the Web handshake, so run it after the receipt.
    if [ "$mode" = purge-dovecot ] && ! /usr/bin/node "$DOVECOT_TOOL" eligible; then
        record failed dovecot_unverified
        exit 0
    fi
    phase=host_failed
    trap 'code=$?; if [ "$code" -ne 0 ]; then record failed "$phase" || :; fi; rm -f "/run/mail-aggregator-maintenance/uninstall-$id.pid" "$RECEIPTS/$id.ready" "$RECEIPTS/$id.cancel"' EXIT
    trap 'exit 1' HUP INT TERM
    record accepted
    # A failed launch, closed client connection or crashed Web process must
    # leave the installed service alone when no acceptance was sent.
    phase=acknowledgment_missing
    i=0
    while [ ! -f "$RECEIPTS/$id.ready" ] && [ "$i" -lt 60 ]; do
      [ ! -e "$RECEIPTS/$id.cancel" ] || exit 1
      sleep 0.1
      i=$((i+1))
    done
    [ -f "$RECEIPTS/$id.ready" ] && [ ! -e "$RECEIPTS/$id.cancel" ] || exit 1
    if [ "$mode" = purge-dovecot ]; then
        phase=dovecot_unverified
        record running checking_dovecot
        /usr/bin/node "$DOVECOT_TOOL" plan
    fi
    phase=stop_failed
    record running stopping
    stop_mail_aggregator_services 9<&-
    if [ "$mode" = purge-dovecot ]; then
        phase=dovecot_removal_failed
        dovecot=removal_started
        record running removing_dovecot
        /usr/bin/node "$DOVECOT_TOOL" remove 9<&-
        dovecot=removed
    fi
    phase=cleanup_failed
    record running cleaning
    if [ "$mode" != remove-app ]; then
        if remove_owned_maildir; then maildir=removed
        else
            case "$?" in 4) maildir=unproven;; *) exit 1;; esac
        fi
    fi
    remove_mail_aggregator_updater
    rm -f /etc/init.d/mail-aggregator /etc/systemd/system/mail-aggregator.service
    if [ -d /run/systemd/system ]; then systemctl daemon-reload 9<&-; fi
    rm -f /etc/sudoers.d/mail-aggregator /usr/local/sbin/mail-aggregator-dovecot-helper \
        /usr/local/sbin/mail-aggregator-dovecot-perms.sh /usr/local/lib/mail-aggregator-maintenance.sh \
        /var/log/mail-aggregator.log /var/log/mail-aggregator.err.log /var/log/mail-aggregator-updater.log
    rm -rf -- /usr/local/lib/mail-aggregator-maintenance-data "$APP_DIR" "$DATA_DIR" "$CONFIG_DIR"
    rm -f "$HELPER"
    record completed
    ;;
  *) exit 2;;
esac
