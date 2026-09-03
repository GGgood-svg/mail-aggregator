#!/bin/sh
# Mail Aggregator installer
#
# 用法:
#   ./scripts/install.sh / --quick                快速安装
#   ./scripts/install.sh --custom                 自定义交互安装
#   ./scripts/install.sh --install-dovecot         Dovecot缺失时装一个全新的,但不自动配置
#   ./scripts/install.sh --full                    全新机器一步到位:Dovecot+mailuser+Maildir+
#                                                   密码认证+mail-aggregator,装完直接进网页操作。
#                                                   不显式指定密码时,自动生成随机初始密码。
#   ./scripts/install.sh --full --force-dovecot-init
#                                                   即使检测到已有Dovecot配置,也强制按--full的
#                                                   方式重新初始化(会覆盖/etc/dovecot/users)
#   ./scripts/install.sh --full --default-dovecot-password 'xxx'
#                                                   --full时指定mailuser的初始密码,不指定则随机生成
set -e

APP_USER="mailadmin"
APP_DIR="/opt/mail-aggregator"
DATA_DIR="/var/lib/mail-aggregator"
DOVECOT_USER="mailuser"
DOVECOT_HOST="127.0.0.1"
DOVECOT_PORT="143"
WEB_PORT="8080"
WEB_LANGUAGE="zh-CN"
MAIL_AGG_BIND_HOST="0.0.0.0"
MAIL_AGG_TRUST_PROXY="false"
MAIL_AGG_COOKIE_SECURE="auto"
CONFIG_DIR="/etc/mail-aggregator"
CONFIG_FILE="$CONFIG_DIR/config"
HELPER_INSTALL_PATH="/usr/local/sbin/mail-aggregator-dovecot-helper"
PERMS_LIB_INSTALL_PATH="/usr/local/sbin/mail-aggregator-dovecot-perms.sh"
UNINSTALL_HELPER_INSTALL_PATH="/usr/local/sbin/mail-aggregator-uninstall-helper"
INSTALL_DOVECOT=0
FULL=0
QUICK=0
CUSTOM=0
SHOW_CONFIG=0
CLEANUP_SOURCE=0
CLEANUP_ARCHIVE=""
FORCE_DOVECOT_INIT=0
DEFAULT_DOVECOT_PASSWORD=""

usage() {
  echo "Usage: $0 [--quick|--custom|--full] [--dovecot-user USER] [--default-dovecot-password PASSWORD] [--dovecot-host HOST] [--dovecot-port PORT] [--web-port PORT] [--language LOCALE] [--show-config] [--cleanup-source --cleanup-archive FILE]"
}
valid_user() { echo "$1" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' && ! echo " root daemon bin nobody " | grep -q " $1 "; }
valid_port() { case "$1" in ''|*[!0-9]*) return 1;; esac; [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null; }
valid_language() {
  case "$1" in zh-CN|en-US|ja-JP|ko-KR|es-ES|fr-FR|de-DE) return 0;; *) return 1;; esac
}
generate_initial_password() {
  # POSIX/BusyBox-compatible: 16 random bytes rendered as 32 lowercase hex
  # characters. The result is printed once at the end of a fresh full install.
  od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
}

load_existing_config() {
  if [ -r "$CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"
  fi
}

write_config() {
  umask 077
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" << EOF
# Mail Aggregator runtime configuration. Passwords are never stored here.
DOVECOT_USER=$DOVECOT_USER
DOVECOT_HOST=$DOVECOT_HOST
DOVECOT_PORT=$DOVECOT_PORT
WEB_PORT=$WEB_PORT
WEB_LANGUAGE=$WEB_LANGUAGE
MAIL_AGG_BIND_HOST=$MAIL_AGG_BIND_HOST
MAIL_AGG_TRUST_PROXY=$MAIL_AGG_TRUST_PROXY
MAIL_AGG_COOKIE_SECURE=$MAIL_AGG_COOKIE_SECURE
EOF
  chmod 600 "$CONFIG_FILE"
}

detect_platform() {
  [ -r /etc/os-release ] || fail_step "platform detection" "无法读取 /etc/os-release" "仅支持 Alpine、Debian 和 Ubuntu。"
  . /etc/os-release
  PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  case "$ID" in
    alpine|debian|ubuntu) . "$PROJECT_ROOT/scripts/platforms/$ID.sh" ;;
    *) fail_step "platform detection" "不支持的系统: $ID" "当前支持 Alpine 3.21+、Debian 12+、Ubuntu 22.04+。" ;;
  esac
  case "$ID:$VERSION_ID" in
    alpine:3.2[1-9]*|alpine:3.[3-9][0-9]*|debian:12*|debian:13*|ubuntu:22.04*|ubuntu:24.04*|ubuntu:2[5-9].*) ;;
    *) fail_step "platform detection" "当前系统版本不在支持矩阵中: ${PRETTY_NAME:-$ID}" "支持 Alpine 3.21+、Debian 12/13、Ubuntu 22.04+/24.04+。" ;;
  esac
  echo "OS: ${PRETTY_NAME:-$ID}"
  echo "Architecture: $(uname -m)"
  echo "Init: $SERVICE_MANAGER"
  echo "Package Manager: $PACKAGE_MANAGER"
}

service_enable() {
  if [ "$SERVICE_MANAGER" = "openrc" ]; then rc-update add "$1" default; else systemctl enable "$1"; fi
}
service_status() {
  if [ "$SERVICE_MANAGER" = "openrc" ]; then rc-service "$1" status; else systemctl is-active --quiet "$1"; fi
}
service_start() {
  if [ "$SERVICE_MANAGER" = "openrc" ]; then rc-service "$1" start; else systemctl start "$1"; fi
}
service_restart() {
  if [ "$SERVICE_MANAGER" = "openrc" ]; then rc-service "$1" restart; else systemctl restart "$1"; fi
}

load_existing_config
ARG_COUNT=$#
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1; FULL=1; INSTALL_DOVECOT=1 ;;
    --custom) CUSTOM=1; FULL=1; INSTALL_DOVECOT=1 ;;
    --install-dovecot) INSTALL_DOVECOT=1 ;;
    --full) FULL=1; INSTALL_DOVECOT=1 ;;
    --force-dovecot-init) FORCE_DOVECOT_INIT=1 ;;
    --default-dovecot-password)
      shift
      DEFAULT_DOVECOT_PASSWORD="$1"
      ;;
    --dovecot-user) shift; DOVECOT_USER="$1" ;;
    --dovecot-host) shift; DOVECOT_HOST="$1" ;;
    --dovecot-port) shift; DOVECOT_PORT="$1" ;;
    --web-port) shift; WEB_PORT="$1" ;;
    --language) shift; WEB_LANGUAGE="$1" ;;
    --show-config) SHOW_CONFIG=1 ;;
    --cleanup-source) CLEANUP_SOURCE=1 ;;
    --cleanup-archive) shift; CLEANUP_ARCHIVE="$1" ;;
    --help|-h) usage; exit 0 ;;
    *) fail_step "参数解析" "未知参数: $1" "运行 --help 查看支持的参数。" ;;
  esac
  shift
done
if [ "$ARG_COUNT" = "0" ]; then QUICK=1; FULL=1; INSTALL_DOVECOT=1; fi
if [ "$CUSTOM" = "1" ]; then
  printf '本地 Dovecot 用户名 [%s]: ' "$DOVECOT_USER"; read -r input; [ -n "$input" ] && DOVECOT_USER="$input"
  printf '本地 Dovecot 初始密码 [留空自动生成]: '; stty -echo; read -r input; stty echo; echo; [ -n "$input" ] && DEFAULT_DOVECOT_PASSWORD="$input"
  printf 'Dovecot 监听地址 [%s]: ' "$DOVECOT_HOST"; read -r input; [ -n "$input" ] && DOVECOT_HOST="$input"
  printf 'Dovecot IMAP 端口 [%s]: ' "$DOVECOT_PORT"; read -r input; [ -n "$input" ] && DOVECOT_PORT="$input"
  printf 'Web 管理端口 [%s]: ' "$WEB_PORT"; read -r input; [ -n "$input" ] && WEB_PORT="$input"
  printf 'Web 语言 (zh-CN/en-US/ja-JP/ko-KR/es-ES/fr-FR/de-DE) [%s]: ' "$WEB_LANGUAGE"; read -r input; [ -n "$input" ] && WEB_LANGUAGE="$input"
  echo "Dovecot: $DOVECOT_USER @ $DOVECOT_HOST:$DOVECOT_PORT; Web: $WEB_PORT; Language: $WEB_LANGUAGE"
  printf '确认安装？ [Y/n]: '; read -r input; [ "$input" = "n" ] || [ "$input" = "N" ] && exit 0
fi
valid_user "$DOVECOT_USER" || fail_step "参数校验" "Dovecot 用户名不合法: $DOVECOT_USER" "仅允许小写字母、数字、_、-，且不能使用系统保留账号。"
valid_port "$DOVECOT_PORT" || fail_step "参数校验" "Dovecot 端口不合法: $DOVECOT_PORT" "端口必须在 1-65535。"
valid_port "$WEB_PORT" || fail_step "参数校验" "Web 端口不合法: $WEB_PORT" "端口必须在 1-65535。"
valid_language "$WEB_LANGUAGE" || fail_step "参数校验" "语言不支持: $WEB_LANGUAGE" "支持 zh-CN、en-US、ja-JP、ko-KR、es-ES、fr-FR、de-DE。"
if [ "$SHOW_CONFIG" = "1" ]; then
  echo "Dovecot user: $DOVECOT_USER"; echo "Dovecot host: $DOVECOT_HOST"; echo "Dovecot port: $DOVECOT_PORT"; echo "Web port: $WEB_PORT"; echo "Language: $WEB_LANGUAGE"; exit 0
fi
detect_platform

# 任何一步失败都要:打印明确原因、给出恢复建议、返回非0、并且绝不能
# 继续走到最后打印"安装完成"。所有关键的、set -e本身报错信息不够
# 说明问题的步骤,都显式调用这个函数。
fail_step() {
  STEP="$1"; REASON="$2"; HINT="$3"
  echo "" >&2
  echo "[ERROR] 安装在 ${STEP} 失败:" >&2
  echo "  ${REASON}" >&2
  if [ -n "$HINT" ]; then
    echo "" >&2
    echo "  ${HINT}" >&2
  fi
  echo "" >&2
  exit 1
}

echo "==> 1/9 更新软件包索引"
if [ "$PLATFORM_ID" = "alpine" ] && ! grep -q "^[^#].*community" /etc/apk/repositories; then
  sed -i 's/^#\(.*community\)/\1/' /etc/apk/repositories
fi
platform_update

echo ""
echo "==> 2/9 依赖检测"
echo ""

check_and_report() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "  $2: ✅"
    return 0
  else
    echo "  $2: ❌"
    return 1
  fi
}

NODE_OK=0; check_and_report node "Node.js" && NODE_OK=1
NPM_OK=0; check_and_report npm "npm" && NPM_OK=1
SQLITE_OK=0; check_and_report sqlite3 "SQLite" && SQLITE_OK=1
IMAPSYNC_OK=0
if command -v imapsync >/dev/null 2>&1; then
  echo "  imapsync: ✅ $(imapsync --version 2>&1 | head -1)"
  IMAPSYNC_OK=1
else
  echo "  imapsync: ❌"
fi
DOVECOT_OK=0
if command -v dovecot >/dev/null 2>&1; then
  echo "  Dovecot: ✅ $(dovecot --version 2>&1 | head -1)"
  DOVECOT_OK=1
else
  echo "  Dovecot: ❌"
fi

echo ""
echo "==> 3/9 自动安装可以自动装的部分(Node.js/npm/SQLite/imapsync)"
TO_INSTALL=""
[ "$NODE_OK" = "0" ] && TO_INSTALL="$TO_INSTALL nodejs"
[ "$NPM_OK" = "0" ] && TO_INSTALL="$TO_INSTALL npm"
[ "$SQLITE_OK" = "0" ] && TO_INSTALL="$TO_INSTALL sqlite"
[ "$IMAPSYNC_OK" = "0" ] && TO_INSTALL="$TO_INSTALL imapsync"
if [ "$PLATFORM_ID" = "alpine" ]; then
  TO_INSTALL="$TO_INSTALL build-base python3 sqlite-dev"
else
  TO_INSTALL="$TO_INSTALL build-essential python3 libsqlite3-dev"
fi
if [ -n "$TO_INSTALL" ]; then
  echo "  将安装:$TO_INSTALL"
  platform_install $TO_INSTALL
else
  echo "  Node.js/npm/SQLite/imapsync 都已就绪,跳过"
fi

echo ""
echo "==> 4/9 Dovecot 软件包"
if [ "$DOVECOT_OK" = "1" ]; then
  echo "  已检测到 Dovecot"
elif [ "$INSTALL_DOVECOT" = "1" ]; then
  echo "  未检测到 Dovecot,安装一个全新的"
  if [ "$PLATFORM_ID" = "alpine" ]; then platform_install dovecot dovecot-openrc; else platform_install dovecot-imapd; fi
  DOVECOT_OK=1
else
  echo ""
  echo "  !! 未检测到 Dovecot,本脚本默认不会帮你安装/接管它。"
  echo "  请先配置好 Dovecot,然后重新运行本脚本;或者加 --install-dovecot / --full。"
  echo ""
  exit 1
fi

if [ "$FULL" = "1" ]; then
  DOVECOT_VERSION="$(dovecot --version 2>&1 | head -1)"
  case "$DOVECOT_VERSION" in
    2.3.*) echo "  Dovecot adapter: 2.3 (Supported)" ;;
    2.4.*) fail_step "Dovecot adapter" "检测到 Dovecot $DOVECOT_VERSION，需要 Major Migration" "2.4 配置不能直接使用 2.3 adapter；当前版本禁止自动初始化。" ;;
    *) fail_step "Dovecot adapter" "检测到未支持的 Dovecot 版本: $DOVECOT_VERSION" "当前只有 Dovecot 2.3 adapter，未知版本不会自动配置。" ;;
  esac
fi

DOVECOT_CONF="/etc/dovecot/dovecot.conf"
DOVECOT_CONFD="/etc/dovecot/conf.d"
DOVECOT_AUTH10="$DOVECOT_CONFD/10-auth.conf"
DOVECOT_PASSWDFILE_CONF="$DOVECOT_CONFD/auth-passwdfile.conf.ext"
DOVECOT_USERS_FILE="/etc/dovecot/users"
# BEGIN/END 而不是单行标记,方便在 --force-dovecot-init 时精确删掉
# 上一次追加的整段配置,不会变成配置块越叠越多份。
MARKER_BEGIN="# ==== BEGIN MAIL-AGGREGATOR-MANAGED (由 install.sh --full 生成,请不要手动编辑;重新生成用 --full --force-dovecot-init) ===="
MARKER_END="# ==== END MAIL-AGGREGATOR-MANAGED ===="
# passdb/userdb 单独用一套标记,写在 auth-passwdfile.conf.ext 里(而不是
# dovecot.conf),原因见下面 configure_passwdfile_auth() 的注释。
PW_MARKER_BEGIN="# ==== BEGIN MAIL-AGGREGATOR-MANAGED PASSWDFILE (由 install.sh --full 生成,请不要手动编辑;重新生成用 --full --force-dovecot-init) ===="
PW_MARKER_END="# ==== END MAIL-AGGREGATOR-MANAGED PASSWDFILE ===="
DOVECOT_FRESH_INIT_DONE=0
NEED_DOVECOT_INIT=0
INITIAL_DOVECOT_PASSWORD=""
INITIAL_PASSWORD_WAS_DEFAULT=0

# 把 dovecot.conf 里上一次由本项目追加的 BEGIN..END 配置块整段删掉(如果存在)。
# 只在确定要重新初始化时调用,不会被空调用误伤 apk 装包生成的默认配置。
strip_managed_dovecot_block() {
  if [ -f "$DOVECOT_CONF" ] && grep -qF "$MARKER_BEGIN" "$DOVECOT_CONF" 2>/dev/null; then
    TMP_CONF="${DOVECOT_CONF}.tmp.$$"
    awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
      $0==b {skip=1; next}
      $0==e {skip=0; next}
      skip==1 {next}
      {print}
    ' "$DOVECOT_CONF" > "$TMP_CONF" && mv "$TMP_CONF" "$DOVECOT_CONF"
  fi
}

# 同样的 BEGIN..END 整段删除逻辑,作用在 auth-passwdfile.conf.ext 上,
# 只删本项目自己上一次写的那一份 passdb/userdb。
strip_managed_passwdfile_block() {
  if [ -f "$DOVECOT_PASSWDFILE_CONF" ] && grep -qF "$PW_MARKER_BEGIN" "$DOVECOT_PASSWDFILE_CONF" 2>/dev/null; then
    TMP_PW="${DOVECOT_PASSWDFILE_CONF}.tmp.$$"
    awk -v b="$PW_MARKER_BEGIN" -v e="$PW_MARKER_END" '
      $0==b {skip=1; next}
      $0==e {skip=0; next}
      skip==1 {next}
      {print}
    ' "$DOVECOT_PASSWDFILE_CONF" > "$TMP_PW" && mv "$TMP_PW" "$DOVECOT_PASSWDFILE_CONF"
  fi
}

# 删掉指定文件里*不属于本项目标记*的顶层 passdb {..} / userdb {..} 块——
# 用来清掉 Alpine dovecot 包自带的默认 auth-passwdfile.conf.ext 里已经
# 写好的那一套(scheme=CRYPT,没有动态uid/gid),而不是在它旁边再叠一套。
# 只匹配顶层(不带缩进)、独占一行的 "passdb {" / "userdb {",按花括号
# 计数找到对应的收尾行,原样保留其它所有内容(注释、空行、不相关配置)。
strip_unmanaged_passdb_userdb_blocks() {
  TARGET="$1"
  [ -f "$TARGET" ] || return 0
  TMP="${TARGET}.tmp.$$"
  awk '
    BEGIN { depth = 0; skipping = 0 }
    {
      line = $0
      trimmed = line
      sub(/^[ \t]+/, "", trimmed)
      if (skipping == 0 && depth == 0 && (trimmed ~ /^passdb[ \t]*\{[ \t]*$/ || trimmed ~ /^userdb[ \t]*\{[ \t]*$/)) {
        skipping = 1
        depth = 1
        next
      }
      if (skipping == 1) {
        tmp = line
        n_open = gsub(/\{/, "{", tmp)
        tmp = line
        n_close = gsub(/\}/, "}", tmp)
        depth += n_open - n_close
        if (depth <= 0) { skipping = 0; depth = 0 }
        next
      }
      print line
    }
  ' "$TARGET" > "$TMP" && mv "$TMP" "$TARGET"
}

# 确保 10-auth.conf 里 auth-passwdfile.conf.ext 被 include——不假设它一定
# 已经存在或者一定被注释/取消注释成某个固定状态,兼容三种情况:已经启用
# (什么都不做)、被注释掉(取消注释)、完全没有这一行(追加一行)。不碰
# 这个文件里任何其它 include(比如 auth-system.conf.ext),避免影响非本
# 项目的认证方式。
ensure_passwdfile_included() {
  if [ ! -f "$DOVECOT_AUTH10" ]; then
    echo "  !! 未找到 $DOVECOT_AUTH10(非标准 Alpine dovecot 包布局),请手动确认 $DOVECOT_PASSWDFILE_CONF 已经被正确 include"
    return 0
  fi
  if grep -qE '^[ \t]*!include[ \t]+auth-passwdfile\.conf\.ext[ \t]*$' "$DOVECOT_AUTH10"; then
    return 0
  fi
  if grep -qE '^[ \t]*#[ \t]*!include[ \t]+auth-passwdfile\.conf\.ext[ \t]*$' "$DOVECOT_AUTH10"; then
    sed -i -E 's/^[ \t]*#[ \t]*(!include[ \t]+auth-passwdfile\.conf\.ext[ \t]*)$/\1/' "$DOVECOT_AUTH10"
    echo "  已在 $DOVECOT_AUTH10 中启用 !include auth-passwdfile.conf.ext"
    return 0
  fi
  echo "!include auth-passwdfile.conf.ext" >> "$DOVECOT_AUTH10"
  echo "  已在 $DOVECOT_AUTH10 末尾添加 !include auth-passwdfile.conf.ext"
}

# passdb/userdb 只在这一个函数里写,只写一次、只有一套。
# 真机上确认过 Alpine 默认的 Dovecot 包会通过 10-auth.conf 默认 include
# 一份已经写好 passdb/userdb 的 auth-passwdfile.conf.ext(scheme=CRYPT,
# userdb 没有 default_fields)。之前的做法是另外往 dovecot.conf 里追加
# 第二套(scheme=SHA512-CRYPT + 动态uid/gid),结果 doveconf -n 里出现
# 2份passdb+2份userdb,第一份没有default_fields的userdb在前面生效,
# uid/gid/home解析不出来,doveadm user 直接 "Auth USER lookup failed"。
# 现在改成复用同一个文件、精确替换成唯一一套,而不是新增一套。
configure_passwdfile_auth() {
  if [ -f "$DOVECOT_PASSWDFILE_CONF" ]; then
    strip_managed_passwdfile_block
    strip_unmanaged_passdb_userdb_blocks "$DOVECOT_PASSWDFILE_CONF"
  else
    printf '%s\n' "# Dovecot passwd-file 认证配置(mail-aggregator 自动创建)" > "$DOVECOT_PASSWDFILE_CONF"
  fi

  cat >> "$DOVECOT_PASSWDFILE_CONF" << PW_EOF

$PW_MARKER_BEGIN
passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u ${DOVECOT_USERS_FILE}
}
userdb {
  driver = passwd-file
  args = username_format=%u ${DOVECOT_USERS_FILE}
  default_fields = uid=${MAIL_UID} gid=${MAIL_GID} home=/home/%u
}
$PW_MARKER_END
PW_EOF
  echo "  已在 $DOVECOT_PASSWDFILE_CONF 中写入唯一一套 passdb/userdb (uid=${MAIL_UID} gid=${MAIL_GID})"

  ensure_passwdfile_included
}

if [ "$FULL" = "1" ]; then
  echo ""
  echo "==> 5/9 --full: 检查已有配置 + 创建 mailuser + Maildir"

  # 只认本项目自己在 dovecot.conf 里留下的 BEGIN 标记,不能把 apk 安装
  # dovecot/dovecot-openrc 包时自动生成的默认 dovecot.conf / users 文件
  # 当成"已经被 Mail Aggregator 初始化过"——这两者是完全不同的状态。
  ALREADY_CONFIGURED=0
  if [ -f "$DOVECOT_CONF" ] && grep -qF "$MARKER_BEGIN" "$DOVECOT_CONF" 2>/dev/null; then
    ALREADY_CONFIGURED=1
  fi

  # 光有配置标记还不够:还要看给 imapsync 用的本地密钥
  # (local-target.pass)是不是也已经写好了。如果标记存在但这个文件
  # 不存在,说明上一次安装大概率是在生成完 Dovecot 密码之后、写本地
  # 密钥之前的某一步(比如7/9的helper复制)失败退出了——这种情况下
  # 明文密码已经无法从哈希还原,与其卡住要求用户必须手动加
  # --force-dovecot-init,不如直接安全地重新生成一遍,反正Dovecot密码
  # 从来没有真正被使用过。
  SECRET_FILE="$DATA_DIR/secrets/local-target.pass"

  if [ "$ALREADY_CONFIGURED" = "1" ]; then
    if [ -f "$SECRET_FILE" ] && [ "$FORCE_DOVECOT_INIT" != "1" ]; then
      NEED_DOVECOT_INIT=0
      echo "  检测到 Dovecot 已经由 Mail Aggregator 完整初始化过(配置标记 + 本地密钥都存在),跳过重新初始化。"
      echo "  如果确实要重新初始化(会覆盖 /etc/dovecot/users 和已保存的本地密钥),加 --force-dovecot-init 重新运行。"
    elif [ "$FORCE_DOVECOT_INIT" = "1" ]; then
      NEED_DOVECOT_INIT=1
      echo "  检测到 --force-dovecot-init,将重新生成 mailuser 密码并重建 Mail Aggregator 管理的 Dovecot 配置块。"
    else
      NEED_DOVECOT_INIT=1
      echo "  检测到 Dovecot 配置标记已存在,但本地密钥/数据库设置尚未完成(上一次安装大概率中途失败了),将补完剩余的 Dovecot 初始化,不会要求你加 --force-dovecot-init。"
    fi
  else
    NEED_DOVECOT_INIT=1
    echo "  未检测到 Mail Aggregator 的 Dovecot 配置标记——即使 /etc/dovecot/ 下已经有 apk 装包生成的默认 dovecot.conf / users 文件,也不算已经初始化过,继续初始化。"
  fi

  if ! id "$DOVECOT_USER" >/dev/null 2>&1; then
    if [ "$PLATFORM_ID" = "alpine" ]; then
      adduser -D -h "/home/$DOVECOT_USER" "$DOVECOT_USER"
    else
      useradd --create-home --home-dir "/home/$DOVECOT_USER" --shell /usr/sbin/nologin "$DOVECOT_USER"
    fi
    echo "  已创建用户: $DOVECOT_USER"
  else
    echo "  用户 $DOVECOT_USER 已存在,不重新创建"
  fi
  # Maildir已存在的话不删除/不清空/不覆盖,只确保目录存在
  mkdir -p "/home/$DOVECOT_USER/Maildir"
  chown -R "$DOVECOT_USER:$DOVECOT_USER" "/home/$DOVECOT_USER"
  echo "  已确保 /home/$DOVECOT_USER/Maildir 存在(如果本来就有,内容不会被动)"

  if [ "$NEED_DOVECOT_INIT" = "1" ]; then
    if [ -n "$DEFAULT_DOVECOT_PASSWORD" ]; then
      INITIAL_DOVECOT_PASSWORD="$DEFAULT_DOVECOT_PASSWORD"
    else
      INITIAL_DOVECOT_PASSWORD="$(generate_initial_password)"
      [ "${#INITIAL_DOVECOT_PASSWORD}" -eq 32 ] \
        || fail_step "生成初始密码" "无法从 /dev/urandom 生成安全随机密码" "检查 /dev/urandom、od 和 tr 是否可用后重试。"
    fi
  fi
else
  echo ""
  echo "==> 5/9 跳过 Dovecot 自动初始化(没有加 --full)"
fi

echo ""
echo "==> 6/9 创建专用运行用户并部署项目"
if ! id "$APP_USER" >/dev/null 2>&1; then
  if [ "$PLATFORM_ID" = "alpine" ]; then
    adduser -D -h "$DATA_DIR" "$APP_USER"
  else
    useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
  fi
fi

mkdir -p "$APP_DIR"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cp -r "$PROJECT_ROOT"/server "$PROJECT_ROOT"/web "$PROJECT_ROOT"/config \
      "$PROJECT_ROOT"/package.json "$APP_DIR"/
[ -f "$PROJECT_ROOT/package-lock.json" ] && cp "$PROJECT_ROOT/package-lock.json" "$APP_DIR"/

# fix_users_permissions() 只在这一份文件里定义,install.sh 和 dovecot-helper.sh
# 都只调用它、不各自维护一份权限逻辑——v0.1.3.2 就是因为两边各写了一份、后写
# 的把先写的覆盖掉,导致Web改密码之后 Dovecot 内部账号读不了 /etc/dovecot/users。
# shellcheck source=lib/dovecot-perms.sh
. "$PROJECT_ROOT/scripts/lib/dovecot-perms.sh"

mkdir -p "$DATA_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR" "$DATA_DIR"
# Preserve v0.1.3 installations: if no v0.1.4 config exists but Dovecot was
# already managed, the Node database remains the source until an explicit
# migration/custom reconfiguration is performed. Fresh initializations get the
# new shared configuration file immediately.
if [ -f "$CONFIG_FILE" ] || { [ "$FULL" = "1" ] && [ "$NEED_DOVECOT_INIT" = "1" ]; }; then
  write_config
fi

cd "$APP_DIR"
su -s /bin/sh "$APP_USER" -c "npm install --omit=dev --no-audit --no-fund"

# --full 的密码哈希生成放到这里(而不是第5步),是因为它现在调用的是
# server/cli-dovecot-hash.js —— 这个脚本和Web修改密码用的是完全同一份
# server/doveadmHash.js 里的 generateDovecotHash() 函数,不是shell和Node
# 各自维护一份平行逻辑。这个文件要等项目部署到 APP_DIR 之后才存在,
# 所以必须放在"部署项目"这一步之后执行。
INITIAL_DOVECOT_HASH=""
if [ "$FULL" = "1" ] && [ "$NEED_DOVECOT_INIT" = "1" ]; then
  echo ""
  echo "==> 6b/9 生成密码哈希 + 写入 Dovecot 配置"

  # 真实的数字UID/GID,而不是直接把用户名字符串塞进uid=/gid=,
  # 避免passwd-file userdb对uid/gid字段的解析产生歧义
  MAIL_UID="$(id -u "$DOVECOT_USER")"
  MAIL_GID="$(id -g "$DOVECOT_USER")"

  # 密码通过stdin传给这个Node CLI,不经过命令行参数(ps不可见)。
  # doveadm以-O运行,生成哈希时不读取系统Dovecot配置;密码通过stdin发送两次,
  # 这是Dovecot官方文档给出的脚本用法。Web服务由非root的mailadmin运行时也
  # 使用同一路径,不会因/etc/dovecot目录权限而在读密码前提前退出。
  INITIAL_DOVECOT_HASH="$(printf '%s' "$INITIAL_DOVECOT_PASSWORD" | node "$APP_DIR/server/cli-dovecot-hash.js")"

  if [ -z "$INITIAL_DOVECOT_HASH" ]; then
    echo "  !! 无法生成密码哈希,中止 --full 流程"
    echo "  可以先只运行不带 --full 的安装,再手动配置 Dovecot"
    exit 1
  fi

  echo "${DOVECOT_USER}:${INITIAL_DOVECOT_HASH}::::::" > "$DOVECOT_USERS_FILE"

  # 权限统一交给 fix_users_permissions()(见 scripts/lib/dovecot-perms.sh)。
  # 不在这里重复写 chown/chmod 逻辑——dovecot-helper.sh 的 set-password/
  # restore-backup 之后也调用同一个函数,两边永远是同一套判断,不会再出现
  # 谁把谁的权限设置覆盖掉的问题。
  fix_users_permissions "$DOVECOT_USERS_FILE"

  # 先把上一次(如果有)由本项目追加的配置块整段删掉,再追加新的一份,
  # 避免每次--force-dovecot-init或者重复运行都在文件末尾多叠一份
  # service imap-login{} 之类,最终Dovecot只会认第一份生效但配置文件
  # 会越滚越长、排查故障时非常容易看错。
  # 注意:passdb/userdb 不在这个块里——见下面 configure_passwdfile_auth(),
  # 它们写在 auth-passwdfile.conf.ext,理由和历史bug记录在那个函数的注释里。
  strip_managed_dovecot_block

  cat >> "$DOVECOT_CONF" << DOVECOT_EOF

$MARKER_BEGIN
mail_location = maildir:~/Maildir
protocols = imap
disable_plaintext_auth = no

service imap-login {
  inet_listener imap {
    address = $DOVECOT_HOST
    port = $DOVECOT_PORT
  }
  inet_listener imaps {
    port = 0
  }
}
$MARKER_END
DOVECOT_EOF
  echo "  已追加基础配置到 $DOVECOT_CONF"

  configure_passwdfile_auth

  service_enable dovecot
  if service_status dovecot >/dev/null 2>&1; then
    service_restart dovecot
  else
    service_start dovecot
  fi
  echo "  Dovecot 已启动"

  DOVECOT_FRESH_INIT_DONE=1
elif [ "$FULL" = "1" ]; then
  echo ""
  echo "==> 6b/9 Dovecot 配置已完整存在,跳过重新生成密码/配置"
fi

echo ""
echo "==> 7/9 安装 OpenRC 服务 + 最小化 sudo 权限"
if [ "$SERVICE_MANAGER" = "openrc" ]; then
  cp "$PROJECT_ROOT/scripts/mail-aggregator.openrc" /etc/init.d/mail-aggregator \
    || fail_step "7/9" "无法安装 mail-aggregator 的 OpenRC 服务文件" "检查服务文件和 /etc/init.d 权限。"
  chmod +x /etc/init.d/mail-aggregator
else
  cp "$PROJECT_ROOT/scripts/services/systemd.service" /etc/systemd/system/mail-aggregator.service \
    || fail_step "7/9" "无法安装 systemd 服务文件" "检查 /etc/systemd/system 权限。"
  systemctl daemon-reload
fi
service_enable mail-aggregator

# Dovecot密码管理helper:root持有,mailadmin只能通过sudoers里严格限定的
# 固定子命令调用,不能执行任意shell。
mkdir -p /usr/local/sbin \
  || fail_step "7/9" "无法创建 /usr/local/sbin 目录" \
     "检查磁盘空间和权限后重新运行 ./scripts/install.sh --full"
# The Web service only invokes root-owned helpers through sudo, but it still
# needs search permission on the parent directory for the preflight existence
# check. Add only group/other search permission; existing read/write bits are
# preserved, so a private directory remains non-listable.
chmod go+x /usr/local/sbin \
  || fail_step "7/9" "mailadmin 无法访问 /usr/local/sbin 中的 helper" \
     "请执行 chmod 711 /usr/local/sbin 后重新运行安装器。helper 文件本身仍保持 root:root 0700。"
cp "$PROJECT_ROOT/scripts/dovecot-helper.sh" "$HELPER_INSTALL_PATH" \
  || fail_step "7/9" "无法安装 Dovecot helper 到 $HELPER_INSTALL_PATH" \
     "检查 $PROJECT_ROOT/scripts/dovecot-helper.sh 是否存在、/usr/local/sbin 是否可写,处理后重新运行 ./scripts/install.sh --full。此时 mailuser/Maildir/Dovecot 配置不会被重新初始化。"
chown root:root "$HELPER_INSTALL_PATH"
chmod 700 "$HELPER_INSTALL_PATH"

# dovecot-helper.sh 装到目标机器上之后是单独运行的(不再和 install.sh 在
# 同一个repo checkout里),它调用的 fix_users_permissions() 也要一起部署到
# 一个固定路径,而不是指望它能找到 $PROJECT_ROOT——helper 每次
# set-password/restore-backup 之后都会 source 这份文件来设置权限,和
# install.sh 初始化时用的是逐字节相同的一份逻辑。
cp "$PROJECT_ROOT/scripts/lib/dovecot-perms.sh" "$PERMS_LIB_INSTALL_PATH" \
  || fail_step "7/9" "无法安装 $PERMS_LIB_INSTALL_PATH" \
     "检查 $PROJECT_ROOT/scripts/lib/dovecot-perms.sh 是否存在、/usr/local/sbin 是否可写,处理后重新运行 ./scripts/install.sh --full。此时 mailuser/Maildir/Dovecot 配置不会被重新初始化。"
chown root:root "$PERMS_LIB_INSTALL_PATH"
chmod 644 "$PERMS_LIB_INSTALL_PATH"

cp "$PROJECT_ROOT/scripts/uninstall-helper.sh" "$UNINSTALL_HELPER_INSTALL_PATH" \
  || fail_step "7/9" "无法安装卸载 helper" "检查 $PROJECT_ROOT/scripts/uninstall-helper.sh 和 /usr/local/sbin 权限。"
chown root:root "$UNINSTALL_HELPER_INSTALL_PATH"
chmod 700 "$UNINSTALL_HELPER_INSTALL_PATH"

if ! command -v sudo >/dev/null 2>&1; then
  echo "  安装 sudo..."
   platform_install sudo || echo "  sudo 安装失败——「重启服务」和「修改Dovecot密码」这两个Web功能将不可用"
fi
if command -v sudo >/dev/null 2>&1; then
  mkdir -p /etc/sudoers.d \
    || fail_step "7/9" "无法创建 /etc/sudoers.d 目录" \
       "检查磁盘空间和权限后重新运行 ./scripts/install.sh --full"
  SUDOERS_FILE="/etc/sudoers.d/mail-aggregator"
  {
    if [ "$SERVICE_MANAGER" = "openrc" ]; then echo "${APP_USER} ALL=(root) NOPASSWD: /etc/init.d/mail-aggregator restart"; else echo "${APP_USER} ALL=(root) NOPASSWD: /bin/systemctl restart mail-aggregator"; fi
    echo "${APP_USER} ALL=(root) NOPASSWD: ${HELPER_INSTALL_PATH} get-hash *"
    echo "${APP_USER} ALL=(root) NOPASSWD: ${HELPER_INSTALL_PATH} set-password *"
    echo "${APP_USER} ALL=(root) NOPASSWD: ${HELPER_INSTALL_PATH} restore-backup"
    echo "${APP_USER} ALL=(root) NOPASSWD: ${HELPER_INSTALL_PATH} reload"
    echo "${APP_USER} ALL=(root) NOPASSWD: ${UNINSTALL_HELPER_INSTALL_PATH} remove-app"
    echo "${APP_USER} ALL=(root) NOPASSWD: ${UNINSTALL_HELPER_INSTALL_PATH} purge"
  } > "$SUDOERS_FILE"
  chmod 0440 "$SUDOERS_FILE"
  if command -v visudo >/dev/null 2>&1 && visudo -c -f "$SUDOERS_FILE" >/dev/null 2>&1; then
    echo "  已配置最小化sudo规则(重启服务 + Dovecot密码管理这几个固定命令)"
  elif command -v visudo >/dev/null 2>&1; then
    rm -f "$SUDOERS_FILE"
    fail_step "7/9" "sudoers 规则语法校验失败(visudo -c -f 未通过)" \
      "已删除生成的 $SUDOERS_FILE,不会留下一份语法错误的sudoers规则。请检查 APP_USER/HELPER_INSTALL_PATH 是否正常,处理后重新运行 ./scripts/install.sh --full——此时 mailuser/Maildir/Dovecot 配置/helper 都不会被重新初始化。"
  else
    echo "  已写入sudoers规则(未安装visudo,跳过语法校验): $SUDOERS_FILE"
  fi
fi

echo ""
echo "==> 8/9 初始化 mail-aggregator 的 Dovecot 管理状态"
if [ "$DOVECOT_FRESH_INIT_DONE" = "1" ]; then
  # local-target.pass 通过 server/credentials.js 的 saveGlobalLocalSecret()
  # 写入,复用和Web修改密码完全相同的原子写入逻辑(临时文件+fsync+rename),
  # 不在这里用shell自己再写一份非原子的 `printf > file`。
  # 密码通过stdin喂给这段Node脚本,不经过命令行参数。
  INIT_SCRIPT="$APP_DIR/.install-init.js"
  cat > "$INIT_SCRIPT" << 'NODE_EOF'
const { db } = require('./server/db');
const { saveGlobalLocalSecret } = require('./server/credentials');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const password = input.replace(/\r?\n+$/, '');
  saveGlobalLocalSecret(password);

  const upsert = db.prepare(
    "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  );
  upsert.run('dovecot_target_user', process.argv[2]);
  upsert.run('dovecot_user', process.argv[2]);
  upsert.run('dovecot_host', process.argv[4]);
  upsert.run('dovecot_port', process.argv[5]);
  upsert.run('web_port', process.argv[6]);
  upsert.run('web_language', process.argv[7]);
  upsert.run('dovecot_using_default_password', process.argv[8] === 'true' ? 'true' : 'false');
  upsert.run('dovecot_last_known_hash', process.argv[3]);
  console.log('Dovecot管理状态已初始化(local-target.pass已原子写入)');
});
NODE_EOF
  chown "$APP_USER:$APP_USER" "$INIT_SCRIPT"
  printf '%s' "$INITIAL_DOVECOT_PASSWORD" \
    | su -s /bin/sh "$APP_USER" -c "cd '$APP_DIR' && MAIL_AGG_DATA_DIR='$DATA_DIR' node '$INIT_SCRIPT' '$DOVECOT_USER' '$INITIAL_DOVECOT_HASH' '$DOVECOT_HOST' '$DOVECOT_PORT' '$WEB_PORT' '$WEB_LANGUAGE' '$([ "$INITIAL_PASSWORD_WAS_DEFAULT" = "1" ] && echo true || echo false)'"
  rm -f "$INIT_SCRIPT"
else
  echo "  跳过(没有加 --full,或者Dovecot配置已存在未重新初始化)"
fi

echo ""
echo "==> 9/9 启动服务 + 自动验证"

if [ "$FULL" = "1" ]; then
  if service_status mail-aggregator >/dev/null 2>&1; then
    service_restart mail-aggregator || echo "  ⚠️ mail-aggregator 重启失败"
  else
    service_start mail-aggregator || echo "  ⚠️ mail-aggregator 启动失败"
  fi
fi

echo ""
echo "  正在验证各组件状态(以下检查仅用于展示信息,不会修改任何东西):"
echo ""

verify_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "  $2 ✅"
  else
    echo "  $2 ❌"
  fi
}
verify_cmd node "Node.js"
verify_cmd npm "npm"
verify_cmd sqlite3 "SQLite"
verify_cmd imapsync "imapsync"
verify_cmd dovecot "Dovecot"

if id "$DOVECOT_USER" >/dev/null 2>&1; then
  echo "  mailuser($DOVECOT_USER) ✅"
else
  echo "  mailuser($DOVECOT_USER) ❌"
fi

if [ -d "/home/$DOVECOT_USER/Maildir" ]; then
  echo "  Maildir ✅"
else
  echo "  Maildir ❌"
fi

DOVECONF_SYNTAX_OK=0
if command -v doveconf >/dev/null 2>&1 && doveconf -n >/dev/null 2>&1; then
  echo "  Dovecot 配置语法(doveconf -n) ✅"
  DOVECONF_SYNTAX_OK=1
else
  echo "  Dovecot 配置语法(doveconf -n) ⚠️  未能确认,建议手动检查"
fi

if [ "$FULL" = "1" ]; then
  # --full 场景下,下面这几项不再是"仅展示、失败了也无所谓"的信息性检查——
  # 这是本项目自己管理 passdb/userdb 的地方,任何一项不达标都必须让整个
  # 安装失败退出,而不是打印⚠️之后照样打印"安装完成"。
  if [ "$DOVECONF_SYNTAX_OK" != "1" ]; then
    fail_step "9/9" "doveconf -n 语法检查未通过,无法继续校验 passdb/userdb" \
      "手动执行 doveconf -n 查看具体报错,修复后重新运行 ./scripts/install.sh --full --force-dovecot-init"
  fi

  # 真实bug:Alpine 默认的 auth-passwdfile.conf.ext 已经带一套 passdb/userdb,
  # 如果本项目又另外追加一套,doveconf -n 里就会出现2套,第一个没有
  # default_fields 的userdb在前面生效,uid/gid/home解析不出来,doveadm user
  # 直接失败。这里做真实检查,而不是假设 configure_passwdfile_auth() 一定
  # 生效对了。
  PASSDB_COUNT="$(doveconf -n 2>/dev/null | grep -c '^passdb {' || true)"
  USERDB_COUNT="$(doveconf -n 2>/dev/null | grep -c '^userdb {' || true)"
  if [ "$PASSDB_COUNT" != "1" ] || [ "$USERDB_COUNT" != "1" ]; then
    fail_step "9/9" "doveconf -n 中 passdb 数量=${PASSDB_COUNT}, userdb 数量=${USERDB_COUNT}(期望都是1)" \
      "很可能是 $DOVECOT_PASSWDFILE_CONF 或 $DOVECOT_AUTH10 里还有额外的 passdb/userdb(比如其它非本项目的 include)。用 doveconf -n | grep -A3 '^passdb {' 和 doveconf -n | grep -A4 '^userdb {' 定位后手动清理,再重新运行 ./scripts/install.sh --full --force-dovecot-init"
  fi
  echo "  passdb/userdb 数量检查(各1套) ✅"

  DOVEADM_USER_RC=0
  DOVEADM_USER_OUTPUT="$(doveadm user "$DOVECOT_USER" 2>&1)" || DOVEADM_USER_RC=$?
  if [ "$DOVEADM_USER_RC" != "0" ] || ! command -v doveadm >/dev/null 2>&1; then
    fail_step "9/9" "doveadm user $DOVECOT_USER 失败" \
      "输出: ${DOVEADM_USER_OUTPUT}
  这通常意味着passdb/userdb配置有问题(上面的数量检查已经通过,问题可能在具体字段/权限上),或者 $DOVECOT_USERS_FILE 里该用户的记录有问题。修复后重新运行 ./scripts/install.sh --full --force-dovecot-init"
  fi
  # 只要求 uid/gid/home——这三个是本项目 userdb 的 default_fields 实际写入的
  # 字段;"mail" 字段这里不强制要求出现,因为 mail_location 是在 dovecot.conf
  # 顶层配置的,不是 userdb 的字段,doveadm user 默认不会把它列出来,强行要求
  # 反而会在配置完全正确的情况下也报失败。
  if echo "$DOVEADM_USER_OUTPUT" | grep -qi 'uid' \
     && echo "$DOVEADM_USER_OUTPUT" | grep -qi 'gid' \
     && echo "$DOVEADM_USER_OUTPUT" | grep -qi 'home'; then
    echo "  Dovecot IMAP(doveadm user $DOVECOT_USER,含uid/gid/home) ✅"
  else
    fail_step "9/9" "doveadm user $DOVECOT_USER 成功返回,但输出里缺 uid/gid/home 字段" \
      "输出: ${DOVEADM_USER_OUTPUT}
  检查 $DOVECOT_PASSWDFILE_CONF 里 userdb 的 default_fields 是否正确写入"
  fi

  # 明文LOGIN测试只在这次真正生成过初始密码时才有意义(才知道当前密码是
  # 什么);跳过重新初始化的运行不知道现在的真实密码,不测。这一项失败
  # 只警告不中止安装——见 cli-imap-login-check.js 里的说明。
  if [ "$DOVECOT_FRESH_INIT_DONE" = "1" ]; then
    if command -v node >/dev/null 2>&1 \
       && printf '%s' "$INITIAL_DOVECOT_PASSWORD" | node "$APP_DIR/server/cli-imap-login-check.js" "$DOVECOT_HOST" "$DOVECOT_PORT" "$DOVECOT_USER" >/dev/null 2>&1; then
      echo "  IMAP 明文登录测试($DOVECOT_USER/初始密码,$DOVECOT_HOST:$DOVECOT_PORT) ✅"
    else
      echo "  IMAP 明文登录测试($DOVECOT_USER/初始密码,$DOVECOT_HOST:$DOVECOT_PORT) ⚠️  未通过,但 doveadm user 检查已通过;建议用邮件客户端手动验证一次登录"
    fi
  fi
else
  if command -v doveadm >/dev/null 2>&1 && doveadm user "$DOVECOT_USER" >/dev/null 2>&1; then
    echo "  Dovecot IMAP(doveadm user $DOVECOT_USER) ✅"
  else
    echo "  Dovecot IMAP(doveadm user $DOVECOT_USER) ⚠️  未能确认,建议手动检查"
  fi
fi

if service_status mail-aggregator >/dev/null 2>&1; then
  echo "  Mail Aggregator ✅"
else
  echo "  Mail Aggregator ⚠️  未确认为 started,可手动执行: rc-service mail-aggregator start"
fi

echo ""
echo "============================================================"

if [ "$CLEANUP_SOURCE" = "1" ]; then
  case "$PROJECT_ROOT" in
    ""|/|/opt|/var|/etc|/home) fail_step "cleanup" "拒绝删除不安全的源目录: $PROJECT_ROOT" "请只对上传解压得到的项目目录使用 --cleanup-source。" ;;
  esac
  echo "正在删除安装源目录: $PROJECT_ROOT"
  rm -rf "$PROJECT_ROOT"
  if [ -n "$CLEANUP_ARCHIVE" ]; then
    case "$CLEANUP_ARCHIVE" in
      /*) [ -f "$CLEANUP_ARCHIVE" ] && rm -f "$CLEANUP_ARCHIVE" || echo "  ⚠️ 压缩包不存在，跳过: $CLEANUP_ARCHIVE" ;;
      *) echo "  ⚠️ --cleanup-archive 必须使用绝对路径，跳过: $CLEANUP_ARCHIVE" ;;
    esac
  fi
  echo "安装源清理完成。"
fi
echo " Mail Aggregator 安装完成"
echo ""
echo " Dovecot: $DOVECOT_HOST:$DOVECOT_PORT"
echo " Web: http://<这台机器的IP>:$WEB_PORT"
echo " Language: $WEB_LANGUAGE"
echo ""
if [ "$DOVECOT_FRESH_INIT_DONE" = "1" ]; then
  echo " ------------------------------------------------------------"
  echo " Dovecot 初始化完成"
  echo " 用户:$DOVECOT_USER"
  echo " 初始密码:$INITIAL_DOVECOT_PASSWORD"
  echo ""
  echo " 请登录 Web 管理面板后修改密码。"
  echo " 这个密码只会打印这一次,不会写进任何日志文件。"
  echo " ------------------------------------------------------------"
  echo ""
fi
echo " 随时可以用下面这个命令重新检查依赖状态(不会修改任何东西):"
echo "   ./scripts/doctor.sh"
echo "============================================================"
