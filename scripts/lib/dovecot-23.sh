#!/bin/sh
# Standalone configuration for a new wizard install. No distro auth includes.
render_dovecot23() {
  cat <<EOF
$MARKER_BEGIN
# mail-aggregator-dovecot-adapter=2.3-standalone
protocols = imap
listen = $DOVECOT_LISTEN_HOST
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:~/Maildir
first_valid_uid = $MAIL_UID

passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u $DOVECOT_USERS_FILE
}
userdb {
  driver = passwd-file
  args = username_format=%u $DOVECOT_USERS_FILE
  default_fields = uid=$MAIL_UID gid=$MAIL_GID home=/home/%u
}

service imap-login {
  inet_listener imap {
    port = $DOVECOT_PORT
  }
  inet_listener imaps {
    port = 0
  }
}
$MARKER_END
EOF
}
