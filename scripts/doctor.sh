#!/bin/sh
# mail-aggregator 依赖诊断脚本 - 只检查,不做任何修改
# 用法: ./scripts/doctor.sh

ISSUES=0
CONFIG_FILE="/etc/mail-aggregator/config"
DOVECOT_USER="mailuser"; DOVECOT_HOST="127.0.0.1"; DOVECOT_PORT="143"; WEB_PORT="8080"; WEB_LANGUAGE="zh-CN"
MAIL_AGG_BIND_HOST="127.0.0.1"; MAIL_AGG_TRUST_PROXY="false"; MAIL_AGG_COOKIE_SECURE="auto"; MAIL_AGG_REQUIRE_HTTPS="false"
if [ -r "$CONFIG_FILE" ]; then . "$CONFIG_FILE"; fi

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; ISSUES=$((ISSUES + 1)); }
info() { echo "  ℹ️  $1"; }

echo "=== 系统 ==="
if [ -f /etc/alpine-release ]; then
  pass "Alpine $(cat /etc/alpine-release)"
else
  info "不是 Alpine Linux(或者无法读取 /etc/alpine-release),本项目主要针对 Alpine 测试过,其它发行版未必完全兼容"
fi
echo "  Kernel: $(uname -r)"
echo "  架构: $(uname -m)"

echo ""
echo "=== Node.js ==="
if command -v node >/dev/null 2>&1; then
  pass "已安装,版本 $(node --version)"
else
  fail "未安装"
fi

echo ""
echo "=== npm ==="
if command -v npm >/dev/null 2>&1; then
  pass "已安装,版本 $(npm --version)"
else
  fail "未安装"
fi

echo ""
echo "=== SQLite ==="
if command -v sqlite3 >/dev/null 2>&1; then
  pass "已安装,版本 $(sqlite3 --version | cut -d' ' -f1)"
else
  info "命令行 sqlite3 未安装(不是必需的,better-sqlite3 是 Node 原生模块自带的,这里只是顺手检查一下方便你手动查库)"
fi

echo ""
echo "=== imapsync ==="
if command -v imapsync >/dev/null 2>&1; then
  VERSION=$(imapsync --version 2>&1 | head -1)
  pass "已安装,$VERSION"
else
  fail "未安装(Alpine下: apk add imapsync,需要先启用community仓库)"
fi

echo ""
echo "=== Dovecot ==="
if command -v dovecot >/dev/null 2>&1; then
  pass "已安装,$(dovecot --version 2>&1 | head -1)"
else
  fail "未安装。本项目默认不会帮你装Dovecot,请先按你自己的方式配置好"
fi

echo ""
echo "=== Dovecot IMAP 监听 ($DOVECOT_HOST:$DOVECOT_PORT) ==="
if command -v nc >/dev/null 2>&1; then
  if nc -z -w2 "$DOVECOT_HOST" "$DOVECOT_PORT" 2>/dev/null; then
    pass "可以连接"
  else
    fail "连不上,确认Dovecot是否已启动、监听地址端口是否正确"
  fi
elif command -v node >/dev/null 2>&1; then
  RESULT=$(node -e "
    const net = require('net');
    const s = new net.Socket();
    s.setTimeout(2000);
    s.once('connect', () => { console.log('ok'); s.destroy(); });
    s.once('timeout', () => { console.log('fail'); s.destroy(); });
    s.once('error', () => console.log('fail'));
    s.connect(Number(process.argv[2]), process.argv[1]);
  " "$DOVECOT_HOST" "$DOVECOT_PORT" 2>/dev/null)
  if [ "$RESULT" = "ok" ]; then
    pass "可以连接"
  else
    fail "连不上,确认Dovecot是否已启动、监听地址端口是否正确"
  fi
else
  info "没有 nc 也没有 node,跳过这项检查"
fi

echo ""
echo "=== $DOVECOT_USER 本地用户 ==="
if id "$DOVECOT_USER" >/dev/null 2>&1; then
  pass "存在"
else
  fail "不存在"
fi

echo ""
echo "=== Maildir ==="
if [ -d "/home/$DOVECOT_USER/Maildir" ]; then
  MAIL_HOME="/home/$DOVECOT_USER"
  MAILDIR="$MAIL_HOME/Maildir"
  pass "存在: $MAILDIR"
  HOME_MODE=$(stat -c '%a' "$MAIL_HOME" 2>/dev/null || echo unknown)
  MAILDIR_MODE=$(stat -c '%a' "$MAILDIR" 2>/dev/null || echo unknown)
  if [ "$HOME_MODE" = "700" ] && [ "$MAILDIR_MODE" = "700" ]; then
    pass "邮箱主目录和 Maildir 权限为 700"
  else
    fail "邮箱目录权限过宽(home=$HOME_MODE, Maildir=$MAILDIR_MODE；应为700)"
  fi
  if find "$MAILDIR" -type f -perm /077 -print -quit 2>/dev/null | grep -q .; then
    fail "发现同机其他用户可读取或修改的邮件文件(应为600)"
  else
    pass "邮件文件未向同机其他用户开放"
  fi
  if find "$MAILDIR" -mindepth 1 -type d -perm /077 -print -quit 2>/dev/null | grep -q .; then
    fail "发现同机其他用户可遍历的 Maildir 子目录(应为700)"
  else
    pass "Maildir 子目录未向同机其他用户开放"
  fi
else
  fail "/home/$DOVECOT_USER/Maildir 不存在"
fi

echo ""; echo "=== Mail Aggregator 配置 ==="
pass "Dovecot 用户: $DOVECOT_USER"
pass "Dovecot 地址: $DOVECOT_HOST:$DOVECOT_PORT"
pass "Web 端口: $WEB_PORT"
pass "语言: $WEB_LANGUAGE"
case "$MAIL_AGG_BIND_HOST" in
  localhost|127.*|::1)
    if [ "$MAIL_AGG_REQUIRE_HTTPS" = "true" ]; then pass "Web 仅回环监听，并强制通过 HTTPS 反向代理访问"; else pass "Web 仅本机监听"; fi
    ;;
  *)
    if [ "$MAIL_AGG_TRUST_PROXY" != "false" ]; then
      fail "Web 对外监听时启用了可信代理，客户端可能伪造转发协议头；请改为回环监听"
    else
      info "Web 对外提供 HTTP，仅适合可信局域网；公网请改用 HTTPS 反向代理"
    fi
    ;;
esac
if [ "$MAIL_AGG_REQUIRE_HTTPS" = "true" ] && { [ "$MAIL_AGG_TRUST_PROXY" = "false" ] || [ "$MAIL_AGG_COOKIE_SECURE" != "true" ]; }; then
  fail "强制 HTTPS 需要 MAIL_AGG_TRUST_PROXY 非 false 且 MAIL_AGG_COOKIE_SECURE=true"
fi

echo ""
echo "=== Web root helper 可见性 ==="
for HELPER in /usr/local/sbin/mail-aggregator-dovecot-helper /usr/local/sbin/mail-aggregator-uninstall-helper; do
  if [ ! -f "$HELPER" ]; then
    fail "未安装: $HELPER"
  elif [ "$(id -u)" -eq 0 ] && id mailadmin >/dev/null 2>&1 && command -v su >/dev/null 2>&1; then
    if su -s /bin/sh -c "test -e '$HELPER'" mailadmin; then
      pass "mailadmin 可以识别: $HELPER"
    else
      fail "mailadmin 看不到 $HELPER；检查父目录权限，通常执行 chmod go+x /usr/local/sbin 后重启服务"
    fi
  else
    info "已安装: $HELPER（需要 root 运行 doctor 才能模拟 mailadmin 可见性）"
  fi
done

echo ""
echo "============================================================"
if [ "$ISSUES" -eq 0 ]; then
  echo "系统可以运行 Mail Aggregator"
else
  echo "存在 $ISSUES 项问题,请先解决上面标 ❌ 的项目再继续"
fi
echo "============================================================"

exit $ISSUES
