#!/bin/sh
# Dovecot 2.4 fresh-install configuration. The 2.3 adapter stays separate.

render_dovecot24() {
  cat <<EOF
dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0
$MARKER_BEGIN
# mail-aggregator-dovecot-adapter=2.4
protocols {
  imap = yes
}
listen = $DOVECOT_LISTEN_HOST
ssl = no
auth_allow_cleartext = yes
auth_mechanisms = plain login
mail_home = /home/%{user}
mail_driver = maildir
mail_path = ~/Maildir
first_valid_uid = $MAIL_UID

passdb passwd-file {
  passwd_file_path = $DOVECOT_USERS_FILE
}
userdb static {
  fields {
    uid = $MAIL_UID
    gid = $MAIL_GID
  }
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
