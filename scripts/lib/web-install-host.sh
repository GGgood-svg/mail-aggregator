#!/bin/sh
# The same fresh-host guard runs before bootstrap and under the maintenance lock.
web_install_platform() {
    PLATFORM_ERROR=
    [ "$(id -u)" = 0 ] || { PLATFORM_ERROR=root_required; return 1; }
    install_platform_load "$1" || return 1
    case "$(uname -m)" in x86_64|aarch64) ;; *) PLATFORM_ERROR=architecture; return 1;; esac
    case "$SERVICE_MANAGER" in
        openrc)
            [ -d /run/openrc ] && command -v rc-service >/dev/null 2>&1 &&
                command -v rc-update >/dev/null 2>&1 && rc-status --runlevel >/dev/null 2>&1 &&
                command -v apk >/dev/null 2>&1 || { PLATFORM_ERROR=openrc_inactive; return 1; }
            ;;
        systemd)
            [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 &&
                systemctl show --property=Version --value >/dev/null 2>&1 &&
                command -v apt-get >/dev/null 2>&1 || { PLATFORM_ERROR=systemd_inactive; return 1; }
            ;;
    esac
}

web_install_platform_error() {
    case "$PLATFORM_ERROR" in
        root_required) echo '请以 root 运行网页版安装。' ;;
        os_release) echo '无法读取 /etc/os-release，不能识别系统。' ;;
        distro|distro_version) printf '系统 %s %s 超出安装器支持范围：Alpine 3.21+（3.x）、Debian 12/13、Ubuntu 22.04/24.04 及本安装器支持的更新 Ubuntu 分支。\n' "${ID:-未知}" "${VERSION_ID:-未知}" ;;
        architecture) printf '当前架构 %s 不受支持；需要 x86_64 或 aarch64。\n' "$(uname -m)" ;;
        openrc_inactive) echo '未发现正在运行的 OpenRC 或找不到 apk；请在完整的 Alpine 系统上运行。' ;;
        systemd_inactive) echo '无法连接正在运行的 systemd 或找不到 apt-get；请在完整的 Debian/Ubuntu 系统上运行。' ;;
    esac
}

# Read the human-readable format shared by BusyBox ip and iproute2. The first
# field of each result is a unique private IPv4; the second is a display label.
web_install_lan_addresses() (
    if ! command -v ip >/dev/null 2>&1; then
        echo '缺少 ip 命令；请先从本系统的软件源安装 iproute2。' >&2
        return 1
    fi
    if ! links=$(LC_ALL=C ip -4 addr show); then
        echo '无法读取本机网络地址，请检查 ip -4 addr 的输出。' >&2
        return 1
    fi
    printf '%s\n' "$links" | LC_ALL=C awk '
        $1 ~ /^[0-9]+:$/ {
            iface = $2
            sub(/:$/, "", iface)
            gsub(/[^A-Za-z0-9_.@:-]/, "?", iface)
            flags = $0
            sub(/^[^<]*</, "", flags)
            sub(/>.*/, "", flags)
            if (flags !~ /(^|,)UP(,|$)/ || flags ~ /(^|,)LOOPBACK(,|$)/) iface = ""
            next
        }
        $1 == "inet" && iface != "" {
            for (i=3; i<NF; i++) if ($i == "scope" && $(i+1) == "host") next
            split($2, cidr, "/")
            addr = cidr[1]
            if (split(addr, a, /\./) != 4) next
            for (i=1; i<=4; i++) if (a[i] !~ /^(0|[1-9][0-9]*)$/ || a[i] > 255) next
            if ((a[1] == 10 || (a[1] == 172 && a[2] >= 16 && a[2] <= 31) || (a[1] == 192 && a[2] == 168)) && !seen[addr]++)
                print addr, iface
        }
    '
)

web_install_list_lan() {
    printf '%s\n' "$1" | awk '{ printf "  %d) %s (%s)\n", NR, $1, $2 }'
}

web_install_select_lan() (
    addresses=$1
    if [ "$2" = --listen ]; then
        while IFS=' ' read -r addr iface; do
            if [ "$3" = "$addr" ]; then printf '%s\n' "$addr"; return 0; fi
        done <<EOF
$addresses
EOF
        echo '指定的地址不是此服务器可用的私有局域网 IPv4。可用地址：' >&2
        web_install_list_lan "$addresses" >&2
        return 2
    fi
    case "$addresses" in
        *'
'*) ;;
        *) printf '%s\n' "${addresses%% *}"; return 0 ;;
    esac
    echo '检测到多个局域网 IPv4，请选择同一局域网的浏览器可以访问的地址：' >&2
    web_install_list_lan "$addresses" >&2
    if [ ! -t 0 ]; then
        echo '当前没有交互终端，请使用 --listen 指定上面列出的一个地址，或在交互终端重新运行。' >&2
        return 2
    fi
    printf '请输入地址编号：' >&2
    if IFS= read -r choice; then
        case "$choice" in
            ''|0*|*[!0-9]*) ;;
            *)
                if printf '%s\n' "$addresses" | awk -v choice="$choice" 'NR == choice {print $1; found=1} END {exit !found}'; then
                    return 0
                fi
                ;;
        esac
    fi
    echo '未选择有效的地址，请重新运行。' >&2
    return 2
)

web_install_fresh_host() {
    for entry in /opt/mail-aggregator /opt/mail-aggregator.* /var/lib/mail-aggregator /var/lib/mail-aggregator-updater \
        /etc/mail-aggregator /etc/init.d/mail-aggregator /etc/init.d/mail-aggregator-updater \
        /etc/systemd/system/mail-aggregator.service /etc/systemd/system/*/mail-aggregator.service /etc/sudoers.d/mail-aggregator \
        /run/systemd/system/mail-aggregator.service /usr/lib/systemd/system/mail-aggregator.service /lib/systemd/system/mail-aggregator.service \
        /usr/local/lib/mail-aggregator-maintenance.sh /usr/local/lib/mail-aggregator-updater \
        /usr/local/sbin/mail-aggregator-dovecot-helper /usr/local/sbin/mail-aggregator-uninstall-helper \
        /etc/runlevels/*/mail-aggregator /etc/runlevels/*/mail-aggregator-updater /run/mail-aggregator.pid \
        /run/mail-aggregator-update-app /var/log/mail-aggregator.log /var/log/mail-aggregator.err.log; do
        if [ -e "$entry" ] || [ -L "$entry" ]; then printf '%s\n' existing_app; return 1; fi
    done
    if id mailadmin >/dev/null 2>&1 || getent group mailadmin >/dev/null 2>&1 || ! web_install_unit_absent mail-aggregator; then printf '%s\n' existing_app; return 1; fi
    for entry in /etc/dovecot /etc/init.d/dovecot /etc/runlevels/*/dovecot /run/dovecot /var/lib/dovecot \
        /etc/systemd/system/dovecot.service /etc/systemd/system/*/dovecot.service /run/systemd/system/dovecot.service \
        /usr/lib/systemd/system/dovecot.service /lib/systemd/system/dovecot.service \
        /home/mailuser /var/mail/mailuser /var/spool/mail/mailuser; do
        if [ -e "$entry" ] || [ -L "$entry" ]; then printf '%s\n' existing_dovecot; return 1; fi
    done
    if command -v dovecot >/dev/null 2>&1 || id mailuser >/dev/null 2>&1 || getent group mailuser >/dev/null 2>&1 || ! web_install_unit_absent dovecot; then
        printf '%s\n' existing_dovecot; return 1
    fi
}

web_install_unit_absent() {
    [ "$SERVICE_MANAGER" = systemd ] || return 0
    unit_load=$(systemctl show --property=LoadState --value "$1.service" 2>/dev/null) || :
    [ "$unit_load" = not-found ]
}
