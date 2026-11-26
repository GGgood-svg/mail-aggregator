#!/bin/sh
# Derive an untagged community repository from an active main on this release.
# Empty output means community is already configured; status 2 means no safe edit.
alpine_community_candidate() {
    [ -f "$1" ] && [ -r "$1" ] && [ ! -L "$1" ] || return 2
    LC_ALL=C awk -v version="$2" '
        BEGIN {
            if (version !~ /^[0-9]+([.][0-9]+)+$/) { invalid=1; exit }
            split(version, v, /[.]/)
            branch="v" v[1] "." v[2]
        }
        {
            sub(/\r$/, "")
            if ($1 !~ /^https?:\/\/[^\/?#]+\/[^?#]+$/ || (NF > 1 && $2 !~ /^#/)) next
            url=$1
            sub(/\/+$/, "", url)
            n=split(url, parts, "/")
            if (n < 5 || parts[n] !~ /^(main|community|testing)$/) next
            if (parts[n-1] != branch) {
                if (parts[n-1] ~ /^(v[0-9]+[.][0-9]+|edge)$/) other_branch=1
                next
            }
            if (parts[n] == "community") existing=1
            if (parts[n] == "main" && !length(main)) main=url
        }
        END {
            if (invalid) exit 2
            if (existing) exit 0
            if (other_branch || !length(main)) exit 2
            sub(/main$/, "community", main)
            print main
        }
    ' "$1"
}

alpine_enable_community() (
    repositories=$1
    expected=$2
    version=$3
    [ -f "$repositories" ] && [ ! -L "$repositories" ] || return 1
    staged=$(mktemp "$repositories.mail-aggregator.tmp.XXXXXXXX") || return 1
    trap 'rm -f -- "$staged"' EXIT
    trap 'exit 1' HUP INT TERM
    cp -p "$repositories" "$staged" || return 1
    candidate=$(alpine_community_candidate "$staged" "$version") || return 1
    [ -n "$candidate" ] && [ "$candidate" = "$expected" ] || return 1
    backup=$(mktemp "$repositories.mail-aggregator.bak.XXXXXXXX") || return 1
    cp -p "$staged" "$backup" || return 1
    printf '\n%s\n' "$candidate" >> "$staged" || return 1
    echo '正在检查当前 Alpine 镜像的 community 软件源…'
    if ! apk --repositories-file "$staged" update; then
        echo '无法更新索引，没有修改软件源配置。请检查当前镜像和网络连接。' >&2
        return 1
    fi
    # Do not replace the configuration if it changed while fetching the indexes.
    [ ! -L "$repositories" ] && cmp -s "$backup" "$repositories" || return 1
    mv -f -T "$staged" "$repositories" || return 1
    printf '已补齐同镜像、同版本的 Alpine community 软件源。原配置备份：%s\n' "$backup"
)
