#!/bin/sh
# Shared support matrix for command-line and browser installations.
install_platform_supported() {
    LC_ALL=C awk -v distro="$1" -v version="$2" 'BEGIN {
        if (version !~ /^[0-9]+([.][0-9]+)*$/) exit 1
        parts = split(version, v, /[.]/)
        if (distro == "alpine") exit !(parts >= 2 && v[1] == 3 && v[2] >= 21)
        if (distro == "debian") exit !(v[1] == 12 || v[1] == 13)
        if (distro == "ubuntu") exit !(parts >= 2 && (((v[1] == 22 || v[1] == 24) && v[2] == 4) || (v[1] >= 25 && v[1] <= 29)))
        exit 1
    }'
}

install_platform_load() {
    ID= VERSION_ID= PRETTY_NAME= PLATFORM_ERROR=
    [ -r /etc/os-release ] || { PLATFORM_ERROR=os_release; return 1; }
    . /etc/os-release
    case "$ID" in alpine|debian|ubuntu) ;; *) PLATFORM_ERROR=distro; return 1;; esac
    install_platform_supported "$ID" "$VERSION_ID" || { PLATFORM_ERROR=distro_version; return 1; }
    . "$1/scripts/platforms/$ID.sh" || return 1
    if [ "$PACKAGE_MANAGER" = apt ] && [ "${INSTALL_APT_MINIMAL:-0}" = 1 ]; then
        platform_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; }
    fi
}

node_version_supported() {
    "${1:-node}" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' >/dev/null 2>&1
}

apt_node_candidate_supported() {
    apt_version=$(LC_ALL=C apt-cache policy nodejs | awk '$1 == "Candidate:" { print $2; exit }')
    LC_ALL=C awk -v version="${apt_version#*:}" 'BEGIN {
        if (version !~ /^[0-9]+[.][0-9]+([.]|$)/) exit 1
        split(version, v, /[.]/)
        exit !(v[1] > 22 || (v[1] == 22 && v[2] >= 12))
    }'
}

platform_resolves() {
    case "$PACKAGE_MANAGER" in
        apk) apk add --simulate "$@" >/dev/null ;;
        apt)
            if [ "${INSTALL_APT_MINIMAL:-0}" = 1 ]; then set -- --no-install-recommends "$@"; fi
            apt-get -s install "$@" >/dev/null
            ;;
        *) return 1 ;;
    esac
}
