#!/bin/sh
# A pin for the CLI dependency; prefer a working distribution package first.
# https://github.com/imapsync/imapsync/tree/imapsync-2.314
imapsync_dependencies() {
    case "$PACKAGE_MANAGER" in
        apk) printf '%s\n' 'perl perl-ntlm perl-cgi perl-crypt-openssl-rsa perl-data-uniqid perl-digest-hmac perl-digest-md5 perl-dist-checkconflicts perl-email-address perl-encode-imaputf7 perl-file-copy-recursive perl-file-tail perl-http-daemon perl-http-daemon-ssl perl-io-socket-inet6 perl-io-socket-ssl perl-io-tee perl-json-webtoken perl-libwww perl-mail-imapclient perl-module-implementation perl-net-dns perl-net-server perl-package-stash perl-package-stash-xs perl-parse-recdescent perl-proc-processtable perl-readonly perl-regexp-common perl-sys-meminfo perl-term-readkey perl-unicode-string perl-uri procps curl ca-certificates' ;;
        apt) printf '%s\n' 'perl libauthen-ntlm-perl libdigest-hmac-perl libencode-imaputf7-perl libfile-copy-recursive-perl libfile-tail-perl libio-socket-ssl-perl libio-tee-perl libmail-imapclient-perl libterm-readkey-perl libunicode-string-perl libreadonly-perl libsys-meminfo-perl libregexp-common-perl libproc-processtable-perl libwww-perl liblwp-protocol-https-perl procps curl ca-certificates' ;;
        *) return 1 ;;
    esac
}

install_pinned_imapsync() (
    commit=93654c6025ff7814f983ab74dd300f9bed9282d9
    digest=89faed96f7c389723ddd7e78a00421b90d5b85bf79407fcf1b11209f3d4d7416
    dependencies=$(imapsync_dependencies) || exit 1
    platform_resolves $dependencies && platform_install $dependencies || exit 1
    umask 077
    temporary=$(mktemp /usr/local/bin/.imapsync-2.314.XXXXXXXX) || exit 1
    trap 'rm -f -- "$temporary"' EXIT
    trap 'exit 1' HUP INT TERM
    curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 10 --max-time 60 \
        --output "$temporary" "https://raw.githubusercontent.com/imapsync/imapsync/$commit/imapsync" || exit 1
    printf '%s  %s\n' "$digest" "$temporary" | sha256sum -c - || exit 1
    [ "$(perl "$temporary" --noreleasecheck --version)" = 2.314 ] || exit 1
    chmod 755 "$temporary" || exit 1
    mv -T "$temporary" /usr/local/bin/imapsync || exit 1
)
