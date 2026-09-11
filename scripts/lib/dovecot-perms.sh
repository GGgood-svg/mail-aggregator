#!/bin/sh
# scripts/lib/dovecot-perms.sh
#
# 唯一负责设置 Dovecot passwd-file(/etc/dovecot/users)权限的地方。
#
# v0.1.3.2 的真实回归:install.sh --full 会根据 `doveconf default_internal_user`
# 把这个文件设成 root:<Dovecot内部组> 640,让 Dovecot 的认证/userdb 查找能读到
# 文件;但 dovecot-helper.sh 的 cmd_set_password()/cmd_restore_backup() 各自
# 维护了自己那一份旧逻辑(写完之后无条件 `chown root:root` + `chmod 600`),
# 结果:装完认证正常 → Web改一次密码 → 权限被改回 root:root 600 → Dovecot内部
# 账号如果不是root就读不了 → 下一次认证失败。
#
# 现在 install.sh 和 dovecot-helper.sh 都只调用这一个函数,不再各自维护一份
# 权限逻辑,不会再出现"两边各改各的、互相打架"的问题。
#
# 用法: fix_users_permissions <文件路径>
#
# 优先级(和 install.sh v0.1.3.2 的设计一致,没有变):
#   1. 能确定 Dovecot 内部认证账号(`doveconf default_internal_user`)以及它
#      所在的组:root:<组> 640 —— 内部账号能读,其它本地用户读不了
#   2. 确定不了(doveconf不存在、账号不存在、chgrp失败等任何一环出问题):
#      root:root 600 —— 保持最保守的权限,不猜、不冒险把文件开放给猜错的组
fix_users_permissions() {
  TARGET_FILE="$1"
  if [ -z "$TARGET_FILE" ] || [ ! -f "$TARGET_FILE" ]; then
    return 0
  fi

  chown root:root "$TARGET_FILE" 2>/dev/null || true

  DOVECOT_INTERNAL_USER=""
  if command -v doveconf >/dev/null 2>&1; then
    DOVECOT_INTERNAL_USER="$(doveconf default_internal_user 2>/dev/null | sed -n 's/^default_internal_user = //p')"
  fi

  DOVECOT_INTERNAL_GROUP=""
  if [ -n "$DOVECOT_INTERNAL_USER" ] && id "$DOVECOT_INTERNAL_USER" >/dev/null 2>&1; then
    DOVECOT_INTERNAL_GROUP="$(id -gn "$DOVECOT_INTERNAL_USER" 2>/dev/null)"
  fi

  if [ -n "$DOVECOT_INTERNAL_GROUP" ] && chgrp "$DOVECOT_INTERNAL_GROUP" "$TARGET_FILE" 2>/dev/null; then
    chmod 640 "$TARGET_FILE"
    echo "  已设置 $TARGET_FILE 权限: root:${DOVECOT_INTERNAL_GROUP} 640(Dovecot 内部账号 ${DOVECOT_INTERNAL_USER} 可读)"
  else
    chmod 600 "$TARGET_FILE"
    echo "  已设置 $TARGET_FILE 权限: root:root 600(未能确定 Dovecot 内部账号所在的组,保留最保守权限)"
  fi
}

# 收紧本项目管理的本地邮箱存储。Dovecot 以邮箱用户身份访问 Maildir，Web 服务
# 通过 IMAP 读取，因此没有理由允许同机其他系统用户遍历或读取邮件文件。
# 用法: secure_maildir_permissions <邮箱用户>
secure_maildir_permissions() {
  MAIL_OWNER="$1"
  [ -n "$MAIL_OWNER" ] || return 1
  id "$MAIL_OWNER" >/dev/null 2>&1 || return 1

  MAIL_HOME="/home/$MAIL_OWNER"
  MAIL_ROOT="$MAIL_HOME/Maildir"
  [ -d "$MAIL_ROOT" ] || return 1

  chown -R "$MAIL_OWNER:$MAIL_OWNER" "$MAIL_ROOT"
  chown "$MAIL_OWNER:$MAIL_OWNER" "$MAIL_HOME"
  chmod 700 "$MAIL_HOME" "$MAIL_ROOT"
  find "$MAIL_ROOT" -type d -exec chmod 700 {} \;
  find "$MAIL_ROOT" -type f -exec chmod 600 {} \;
  echo "  已收紧 $MAIL_ROOT 权限: 目录 700，邮件文件 600"
}
