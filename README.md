# Mail Aggregator

[English](./README.en.md) | 简体中文

[![CI](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml/badge.svg)](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

轻量级、自托管的邮件聚合器：通过 `imapsync` 将多个 IMAP 邮箱同步到本机 Dovecot，并提供账号管理、同步任务、运维和邮件浏览界面。

> 项目状态：Public Beta。Alpine Linux 3.21.7 + Node.js 22 + Dovecot 2.3.21.1 + imapsync 2.290 是当前完整验收环境。Debian/Ubuntu 已提供安装适配，但尚未完成同等级真机验收。

## 功能

- 聚合 QQ、163、Gmail、自定义 IMAP 邮箱
- 管理员创建用户，按用户隔离邮箱账号、同步任务、日志和 Web 邮件目录
- Gmail 应用专用密码，以及 Gmail / Microsoft 365 OAuth2
- 手动、定时、批量同步；排队、停止、取消、重试和日志查看
- 按来源账号隔离目标文件夹，支持文件夹、时间和大小过滤
- 可选镜像目标端删除，带严格的防误删限制
- 登录后浏览本机邮件；主动打开正文后标为本地已读，支持手动标为已读／未读，自动预览不改变状态
- HTML 邮件安全渲染、CID 内嵌图片和远程图片按需加载
- 健康检查、失败通知、安全备份、预检、恢复和恢复前快照
- 简体中文、English、日本語、한국어、Español、Français、Deutsch

## 工作方式

```text
多个远端 IMAP 邮箱
        │
        ▼
    imapsync 队列 ──► 本机 Dovecot / Maildir
        │                      │
        └── 日志与状态          └── Web 邮件浏览
                  \            /
                   Mail Aggregator
```

Mail Aggregator 管理同步，不取代 Dovecot。邮件本体保存在 Maildir；应用数据库保存账号配置、任务状态和设置；邮箱密码、授权码和 OAuth 令牌单独保存在权限受限的密钥文件中。

## 快速安装

全新 Alpine 机器以 `root` 执行：

```sh
cd /root/mail-aggregator
chmod +x scripts/*.sh scripts/lib/*.sh scripts/platforms/*.sh
./scripts/install.sh --quick
```

`--quick` 会安装并初始化 Dovecot、Maildir、imapsync 和 Mail Aggregator。希望选择本地邮箱用户、端口、语言和初始密码时使用：

```sh
./scripts/install.sh --custom
```

未指定本地 Dovecot 初始密码时，安装器会生成 32 位随机密码并在安装结束时显示一次，请立即保存。

自动化安装示例：

```sh
./scripts/install.sh --full \
  --dovecot-user mailuser \
  --default-dovecot-password 'change-this-password' \
  --dovecot-host 127.0.0.1 \
  --dovecot-port 143 \
  --web-port 8080 \
  --language zh-CN
```

命令行密码可能进入 shell history；人工安装优先使用 `--custom` 的隐藏输入。安装完成后运行：

```sh
./scripts/doctor.sh
rc-service dovecot status
rc-service mail-aggregator status
```

新安装默认只监听本机，可先执行 `ssh -L 8080:127.0.0.1:8080 root@服务器地址`，再通过 `http://127.0.0.1:8080` 创建管理员。明确仅在可信局域网验收时可给安装命令增加 `--lan-http`，随后访问 `http://服务器地址:8080`；公网部署必须使用 HTTPS 反向代理。

## 多用户与权限

首次创建的账号是主管理员。管理员可在“用户管理”中创建普通用户或其他管理员；系统不开放公开注册。普通用户只能查看和操作自己创建的邮箱账号、同步任务、日志及邮件目录，不能访问全局设置、OAuth 客户端密钥、备份恢复、服务控制或卸载功能。

新建邮箱的显示名称由用户填写，但实际 Dovecot 顶层目录由服务器按用户和账号编号分配，不能伪造成 `INBOX` 或其他用户的目录。旧版本已有账号会自动归属首次创建的管理员，已有邮件目录不会在升级时移动。因为旧版 `flat` 模式的邮件已经混入公共根目录，首次管理员会保留旧目录读取能力；其他用户只能读取系统分配给自己的隔离目录。

### 已有 Dovecot

不传 `--quick`、`--custom`、`--full` 时，安装器只安装应用，并复用已有 Dovecot：

```sh
./scripts/install.sh
```

先确认本地 IMAP 服务、用户和 Maildir 已配置，再用 `./scripts/doctor.sh` 检查。安装器不会在这种模式下重建现有 Dovecot 配置。

## 添加邮箱

| 服务商 | 推荐认证 | 说明 |
| --- | --- | --- |
| QQ 邮箱 | 授权码 | 不是 QQ 登录密码 |
| 163 邮箱 | 客户端授权密码 | 在网易邮箱设置中开启 IMAP 并生成 |
| Gmail | 应用专用密码 | 最简单；Google 账号需先开启两步验证 |
| Gmail | OAuth2 | 适合不使用应用专用密码的部署，需要 OAuth 客户端和 HTTPS 回调 |
| Outlook / Microsoft 365 | OAuth2 | 需要 Microsoft Entra 应用注册和 HTTPS 回调 |
| 其他邮箱 | 自定义 IMAP | 填写主机、端口、SSL 和服务商提供的凭据 |

“添加账号”页面会显示对应服务商的官方设置入口。连接测试成功后再执行首次同步。

### OAuth2 为什么需要 HTTPS

Google 和 Microsoft 会在授权后把浏览器重定向回 Mail Aggregator。公网回调地址需要稳定域名和 HTTPS，例如：

```text
https://mail.example.com/api/oauth/callback/google
https://mail.example.com/api/oauth/callback/microsoft
```

应用专用密码/授权码走普通 IMAP 登录，不需要 OAuth 回调，因此可信内网测试时可直接使用服务器 IP。

## HTTPS 反向代理

登录密码在数据库中只保存 bcrypt 哈希，邮箱凭据存放于权限受限的文件中；但这些“静态存储保护”不能加密 HTTP 网络流量。通过 HTTP 登录时，密码和会话 Cookie 仍可能被同网段窃听，中间人还可替换网页脚本。因此项目不会用前端 RSA/AES 包装制造“HTTP 已安全”的假象，公网或不可信网络必须使用 HTTPS。

生产环境建议让 Mail Aggregator 只监听本机，并由 Caddy、Nginx 或其他反向代理终止 TLS。运行配置位于 `/etc/mail-aggregator/config`：

```sh
MAIL_AGG_BIND_HOST=127.0.0.1
MAIL_AGG_TRUST_PROXY=loopback
MAIL_AGG_COOKIE_SECURE=true
MAIL_AGG_REQUIRE_HTTPS=true
```

新安装默认只监听 `127.0.0.1`。明确只在可信局域网使用时可运行 `./scripts/install.sh --full --lan-http`；已有 HTTPS 反向代理时使用 `./scripts/install.sh --full --https-proxy`。默认本机模式可通过 SSH 端口转发临时访问：

```sh
ssh -L 8080:127.0.0.1:8080 root@服务器IP
```

反向代理应转发 `Host`、`X-Forwarded-Proto` 和客户端地址。修改配置后重启服务：

```sh
rc-service mail-aggregator restart
```

## 数据与备份

默认位置：

| 内容 | 路径 |
| --- | --- |
| 程序 | `/opt/mail-aggregator` |
| 应用数据 | `/var/lib/mail-aggregator` |
| 运行配置 | `/etc/mail-aggregator/config` |
| 本机邮件 | `/home/<dovecot-user>/Maildir` |

创建带清单和 SHA-256 校验的备份：

```sh
sudo ./scripts/backup.sh
```

只读预检：

```sh
./scripts/verify-backup.sh backup.tar.gz backup.tar.gz.sha256
```

恢复：

```sh
sudo ./scripts/restore.sh backup.tar.gz backup.tar.gz.sha256
```

备份包含账号配置和明文可恢复凭据，必须加密、离线保存，不能上传到 Issue 或公开仓库。备份不包含 Maildir。

## 卸载边界

```sh
sudo ./scripts/uninstall.sh
```

该脚本卸载应用，并交互询问是否删除应用数据和程序目录；不会删除 Dovecot、imapsync 或 Maildir。Web 设置页另有明确区分的“程序卸载”和“彻底卸载”模式，彻底卸载会删除 Dovecot、本地邮箱用户及其 Maildir，操作不可撤销。

## 开发与测试

需要 Node.js 20 或 22：

```sh
npm ci
npm test
```

自动化测试不连接真实远端邮箱，但会覆盖数据库约束、同步队列、进程终止、凭据路径、OAuth 协议、备份恢复、HTTP 安全、多语言和邮件渲染。正式发布前还应在 Alpine 真机完成安装、Dovecot 登录、真实同步、Web 邮件浏览及 OAuth 验收，详见 [TESTING.md](./TESTING.md)。

## 安全设计摘要

- 密码和令牌通过权限 `600` 的文件传递，不进入 URL 或 imapsync 进程参数
- 状态变更接口需要登录和 CSRF 校验
- 账号、任务、日志和邮件目录均在服务端校验用户归属；管理员功能另有角色校验
- 登录限速、持久会话、安全响应头和可配置 Secure Cookie
- Web 展示用户内容前转义；邮件 HTML 经白名单清洗
- 远程邮件图片默认不加载，避免打开邮件时自动泄露 IP 和跟踪信息
- Dovecot 改密由最小权限 helper 执行，失败会回滚
- 备份恢复先做路径、类型、大小、清单、哈希和 SQLite 完整性预检

安全问题请按 [SECURITY.md](./SECURITY.md) 使用 GitHub 私密漏洞报告，不要在公开 Issue 中粘贴凭据、令牌、Cookie、真实服务器地址或未脱敏日志。

## 已知限制

- Web 邮件支持本地已读／未读切换，不支持发送、回复、移动、删除和附件下载
- 首次复制保留源邮件标记；后续同步使用 `--noresyncflags` 保留本地标记，不再从源邮箱刷新已有邮件的已读、星标等状态。Web 操作不回写源邮箱。
- 账号角标表示收件箱未读数；各文件夹单独显示自己的未读数，避免 Gmail 标签重复计数。
- 所有来源默认共用一个本地 Dovecot 服务账号，但新建邮箱使用不可伪造的账号级目录，并由 Web API 强制执行用户访问范围
- Gmail / Microsoft OAuth 最终效果依赖各自控制台配置、租户策略和真实授权验收
- Debian/Ubuntu 安装层尚未完成与 Alpine 同等级的真机测试
- 项目仍处于 Public Beta，升级或恢复前应先创建并验证备份

## 参与贡献

提交问题或代码前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## License

[MIT](./LICENSE)
