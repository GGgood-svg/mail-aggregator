#!/bin/sh
# 卸载 mail-aggregator (不会删除 Dovecot / imapsync / Maildir 数据)
set -e

APP_DIR="/opt/mail-aggregator"
DATA_DIR="/var/lib/mail-aggregator"

echo "停止并移除服务..."
rc-service mail-aggregator stop 2>/dev/null || true
rc-update del mail-aggregator default 2>/dev/null || true
rm -f /etc/init.d/mail-aggregator
rm -f /etc/sudoers.d/mail-aggregator
rm -f /usr/local/sbin/mail-aggregator-dovecot-helper
rm -f /usr/local/sbin/mail-aggregator-dovecot-perms.sh
rm -f /usr/local/sbin/mail-aggregator-uninstall-helper
rm -f /etc/systemd/system/mail-aggregator.service
systemctl daemon-reload 2>/dev/null || true

read -p "是否删除数据目录 ${DATA_DIR}(包含账号配置、授权码、同步日志)? [y/N] " ans
if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  rm -rf "$DATA_DIR"
  echo "已删除数据目录"
else
  echo "已保留数据目录: $DATA_DIR"
fi

read -p "是否删除程序目录 ${APP_DIR}? [y/N] " ans2
if [ "$ans2" = "y" ] || [ "$ans2" = "Y" ]; then
  rm -rf "$APP_DIR"
  echo "已删除程序目录"
fi

echo "卸载完成。Dovecot、imapsync 和本地 Maildir 中的邮件未被改动。"
echo "如果之前用 --full 生成过 /etc/dovecot/users、dovecot.conf 里的配置块,"
echo "以及 /etc/dovecot/conf.d/auth-passwdfile.conf.ext 里的 passdb/userdb,"
echo "这些也不会被这个脚本删除——那是 Dovecot 自己的密码认证配置,不属于"
echo "mail-aggregator 程序本身,需要的话请手动清理(标记为"
echo "'BEGIN/END MAIL-AGGREGATOR-MANAGED' 和 'BEGIN/END MAIL-AGGREGATOR-MANAGED PASSWDFILE'"
echo "的部分)。"
