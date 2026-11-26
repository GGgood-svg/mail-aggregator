#!/bin/sh
# Bootstrap a temporary HTTPS wizard from a verified, extracted source archive.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin
export PATH
umask 077
ulimit -c 0

usage() {
    printf '%s\n' 'Usage: sh scripts/install-web.sh                # 自动检测局域网 IPv4' \
        '       sh scripts/install-web.sh --check        # 只检查系统、安装状态、地址和 Node.js' \
        '       sh scripts/install-web.sh --listen PRIVATE_LAN_IPV4'
}
case "${1:-}" in -h|--help) usage; exit 0;; esac
case "$#:${1:-}" in 0:|1:--check|2:--listen) ;; *) usage >&2; exit 2;; esac
mode=${1:-auto}
INSTALL_APT_MINIMAL=1
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
. "$root/scripts/lib/install-platform.sh"
. "$root/scripts/lib/web-install-host.sh"

web_install_platform "$root" || { web_install_platform_error >&2; exit 1; }
printf '检测到系统：%s %s，%s，%s。\n' "$ID" "$VERSION_ID" "$(uname -m)" "$SERVICE_MANAGER"
if ! existing=$(web_install_fresh_host); then
    printf '检测到已有应用或 Dovecot、用户或数据（%s），网页版不会接管现有系统。\n' "$existing" >&2
    exit 1
fi

if ! addresses=$(web_install_lan_addresses); then exit 1; fi
if [ -z "$addresses" ]; then
    echo '没有找到可用的私有局域网 IPv4。请用 ip -4 addr 检查网卡是否已启用并取得局域网地址，再重新运行。' >&2
    exit 1
fi

community=
repo_state=ready
if [ "$PACKAGE_MANAGER" = apk ]; then
    . "$root/scripts/lib/alpine-repositories.sh"
    repositories=/etc/apk/repositories
    if ! community=$(alpine_community_candidate "$repositories" "$VERSION_ID"); then
        repo_state=custom
    elif [ -n "$community" ]; then
        repo_state=missing
    fi
fi

node_hint() {
    if [ "$PACKAGE_MANAGER" = apk ]; then
        echo '需要 /usr/bin/node 的 Node.js 22.12 或更新版本及 npm。检查本机 Alpine 分支的 main 和 community 仓库，勿混用其他分支。' >&2
    else
        echo '需要 /usr/bin/node 的 Node.js 22.12 或更新版本及可用的系统 npm。如果已配置的软件源版本过低，请先从可信来源准备系统 Node.js 和 npm。仅当前登录账号可见的 nvm 版本无法供服务使用。' >&2
    fi
}
if [ "$mode" = --check ]; then
    echo '未检测到已有 Mail Aggregator 或 Dovecot。'
    echo '可用的局域网 IPv4：'
    web_install_list_lan "$addresses"
    case "$repo_state" in
        missing) echo 'Alpine community 尚未启用；启动向导时会校验同版本的 community 并备份软件源配置。' ;;
        custom) echo '未找到可自动配对的 Alpine 软件源；启动向导时将沿用当前配置。' ;;
    esac
    if node_version_supported /usr/bin/node && command -v npm >/dev/null 2>&1; then
        printf '系统 Node.js：%s；已找到 npm。\n' "$(/usr/bin/node --version)"
    elif [ "$PACKAGE_MANAGER" = apt ] && ! node_version_supported /usr/bin/node && ! apt_node_candidate_supported; then
        node_hint
        echo '如果软件包索引尚未更新，可先执行 apt-get update，再重新检查。' >&2
        exit 1
    else
        echo '系统 Node.js 或 npm 待准备；启动向导时将从已配置的软件源解析所需软件包。'
    fi
    exit 0
fi

address=$(web_install_select_lan "$addresses" "$mode" "${2:-}") || exit $?
printf '向导将使用局域网地址：%s。\n' "$address"

refresh_indexes() {
    [ "$indexes_refreshed" -eq 0 ] || return 0
    platform_update || { echo '[MAI-101] 无法更新本机软件包索引，请检查网络和当前系统的软件源。' >&2; exit 1; }
    indexes_refreshed=1
}
bootstrap_packages() {
    refresh_indexes
    printf '准备网页版安装所需工具：%s\n' "$*"
    if ! platform_resolves "$@" || ! platform_install "$@"; then
        if [ "$PACKAGE_MANAGER" = apk ]; then
            echo '[MAI-102] 无法安装依赖；请检查镜像可用性，以及 main 和 community 是否都属于当前 Alpine 分支。' >&2
        else
            echo '[MAI-102] 无法从已配置的软件源安装依赖；请检查上方的软件包错误。' >&2
        fi
        exit 1
    fi
}
indexes_refreshed=0
case "$repo_state" in
    missing)
        alpine_enable_community "$repositories" "$community" "$VERSION_ID" || {
            echo '[MAI-101] 未能自动启用 community；请检查软件源和文件权限后重新运行。' >&2
            exit 1
        }
        indexes_refreshed=1
        ;;
    custom) echo '沿用当前 Alpine 软件源；安装器不会自动改动这份配置。' ;;
esac
if ! node_version_supported /usr/bin/node; then
    refresh_indexes
    if [ "$PACKAGE_MANAGER" = apt ] && ! apt_node_candidate_supported; then
        node_hint
        exit 1
    fi
    bootstrap_packages nodejs
fi
node_version_supported /usr/bin/node || { node_hint; exit 1; }
set --
command -v npm >/dev/null 2>&1 || set -- "$@" npm
[ -x /usr/bin/openssl ] || set -- "$@" openssl
if ! command -v flock >/dev/null 2>&1; then
    case "$PACKAGE_MANAGER" in apk) set -- "$@" flock;; apt) set -- "$@" util-linux;; esac
fi
if [ "$#" -ne 0 ]; then bootstrap_packages "$@"; fi
command -v npm >/dev/null 2>&1 || { node_hint; exit 1; }
install -d -m 0700 -o root -g root /run/mail-aggregator-web-install
[ -f /run/mail-aggregator-web-install/launcher.lock ] || : >> /run/mail-aggregator-web-install/launcher.lock
exec 9</run/mail-aggregator-web-install/launcher.lock
flock -n 9 || { echo '已有网页版安装在运行。' >&2; exit 1; }
# Hold the launcher lock in this shell. Do not pass it to the HTTPS process.
(exec 9<&-; exec env -i PATH="$PATH" HOME=/root /usr/bin/node "$root/scripts/install-web/runner.js" "$address")
