#!/bin/sh
# Disposable CI-only Dovecot instance. Never points at an existing mailbox.
set -eu

command -v dovecot >/dev/null
privileged() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi
}
if [ "$(id -u)" -eq 0 ]; then
  test_user=${MAIL_TEST_IMAP_RUN_USER:-nobody}
  mail_uid=$(id -u "$test_user")
  mail_gid=$(id -g "$test_user")
  [ "$mail_uid" -gt 0 ] || { echo 'The disposable Maildir must use a non-root UID.' >&2; exit 1; }
else
  command -v sudo >/dev/null
  mail_uid=$(id -u)
  mail_gid=$(id -g)
fi
fixture=$(mktemp -d /tmp/mail-aggregator-dovecot.XXXXXXXX)
case "$fixture" in /tmp/mail-aggregator-dovecot.*) ;; *) echo 'Unexpected fixture path' >&2; exit 1;; esac
launcher=''
cleanup() {
  if [ -f "$fixture/run/master.pid" ]; then privileged kill "$(cat "$fixture/run/master.pid")" 2>/dev/null || true
  elif [ -n "$launcher" ]; then kill "$launcher" 2>/dev/null || true; fi
  if [ -n "$launcher" ]; then wait "$launcher" 2>/dev/null || true; fi
  privileged rm -rf -- "$fixture"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
chmod 755 "$fixture"
mkdir "$fixture/run" "$fixture/state" "$fixture/mail"
privileged chown "$mail_uid:$mail_gid" "$fixture/mail"
port=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
printf 'fixture:{PLAIN}synthetic-ci-password\n' > "$fixture/users"
chmod 644 "$fixture/users"
dovecot_version=$(dovecot --version)
case "$dovecot_version" in
  2.4.*) cat > "$fixture/dovecot.conf" <<EOF
dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0
base_dir = $fixture/run
state_dir = $fixture/state
log_path = $fixture/dovecot.log
instance_name = mail-aggregator-test
listen = 127.0.0.1
protocols {
  imap = yes
}
ssl = no
auth_allow_cleartext = yes
auth_mechanisms = plain
mail_home = $fixture
mail_driver = maildir
mail_path = $fixture/mail
first_valid_uid = 1
passdb passwd-file {
  passwd_file_path = $fixture/users
}
userdb static {
  fields {
    uid = $mail_uid
    gid = $mail_gid
  }
}
service imap-login {
  inet_listener imap {
    port = $port
  }
  inet_listener imaps {
    port = 0
  }
}
EOF
  ;;
  2.3.*) cat > "$fixture/dovecot.conf" <<EOF
base_dir = $fixture/run
state_dir = $fixture/state
log_path = $fixture/dovecot.log
instance_name = mail-aggregator-test
listen = 127.0.0.1
protocols = imap
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain
mail_location = maildir:$fixture/mail
first_valid_uid = 1
passdb {
  driver = passwd-file
  args = scheme=PLAIN $fixture/users
}
userdb {
  driver = static
  args = uid=$mail_uid gid=$mail_gid home=$fixture
}
namespace inbox {
  inbox = yes
}
service imap-login {
  inet_listener imap {
    address = 127.0.0.1
    port = $port
  }
}
EOF
  ;;
  *) echo 'This fixture requires Dovecot 2.3 or 2.4.' >&2; exit 1 ;;
esac
privileged dovecot -c "$fixture/dovecot.conf" -F > "$fixture/launcher.log" 2>&1 &
launcher=$!
ready=0
for attempt in $(seq 1 60); do
  if node -e "const n=require('net').connect(Number(process.argv[1]),'127.0.0.1');n.on('connect',()=>{n.destroy();process.exit(0)});n.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),500)" "$port"; then ready=1; break; fi
  if ! kill -0 "$launcher" 2>/dev/null; then break; fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  cat "$fixture/launcher.log" >&2 || true
  privileged cat "$fixture/dovecot.log" >&2 2>/dev/null || true
  exit 1
fi
export MAIL_TEST_IMAP_ALLOW_WRITE=synthetic-only
export MAIL_TEST_IMAP_USER=fixture
export MAIL_TEST_IMAP_PASSWORD=synthetic-ci-password
export MAIL_TEST_IMAP_PORT="$port"
npm run test:dovecot
