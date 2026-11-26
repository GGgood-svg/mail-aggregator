# Mail Aggregator

[English](./README.en.md) | 简体中文

[![CI](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml/badge.svg)](https://github.com/GGgood-svg/mail-aggregator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

轻量级、自托管的邮件聚合器：通过 `imapsync` 将多个 IMAP 邮箱同步到本机 Dovecot，并提供账号管理、同步任务、运维和邮件浏览界面。

> 项目状态为 Public Beta。新装目标为 Alpine Linux 3.24 x86_64、Node.js 24 和 Dovecot 2.4。Alpine 3.21 与 Dovecot 2.3 是历史验收环境。Debian、Ubuntu 和其他组合的验证范围见[发布清单](./TESTING.md)。

## 功能

- 聚合 QQ、163、Gmail、自定义 IMAP 邮箱
- 管理员创建用户，按用户隔离邮箱账号、同步任务、日志和 Web 邮件目录
- Gmail 应用专用密码，以及 Gmail / Microsoft 365 OAuth2
- 手动、定时、批量同步；排队、停止、取消、重试和日志查看
- 按来源账号隔离目标文件夹，支持文件夹、时间和大小过滤
- 可选镜像目标端删除，带严格的防误删限制
- 登录后浏览本机邮件；主动打开正文后标为本地已读，支持手动标为已读／未读，自动预览不改变状态
- 统一未读总览、本地星标、勾选批量标记已读／未读和星标
- [持久化邮件任务中心和整理规则](./MAIL_TASKS.md)：完整预览后手动应用，支持取消、确认进度和重新登录后继续
- HTML 邮件安全渲染、CID 内嵌图片和远程图片按需加载
- 当前文件夹或跨可访问文件夹组合搜索，支持发件人、收件人、主题、正文、大小、收取日期和已读状态
- 附件下载与原始 `.eml` 导出，支持中文文件名；下载不改变已读状态
- 健康检查、失败通知、安全备份、预检、恢复和恢复前快照
- 账号页显示同步受阻原因和复查时间；可暂停定时同步，分别只读测试来源和目标，预演同步影响
- [搜索接续](./MAIL_SEARCH_CONTINUATION.md)、个人标签、附件筛选和手机阅读导航；收取时间排序与会话分组覆盖当前显示的结果
- [应用与 Maildir 配对备份](./MAILDIR_BACKUP.md)、[只读运维与审计](./OPERATIONS.md)、[主管理员双重验证](./TOTP_SECURITY.md) 和 [GitHub 更新检查与签名安装](./APP_UPDATES.md)
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

### 获取正式版源码

从 [GitHub Releases](https://github.com/GGgood-svg/mail-aggregator/releases/latest) 选择版本并下载 **Source code (tar.gz)**。在服务器上直接下载、解压的可复制命令，以及电脑中转、已有实例升级、备份和恢复步骤，见[完整部署教程](./DEPLOYMENT.md)。用于签名更新的 Alpine 运行包不包含首次安装向导。

### 网页安装向导（全新 Linux 主机）

适用范围：**Alpine 3.21 及更新的 3.x（OpenRC）**、**Debian 12/13（systemd）**、**Ubuntu 22.04 / 24.04 / 26.04 及安装器识别的更新 Ubuntu 版本（systemd）**，架构为 `x86_64` 或 `aarch64`。软件源还需提供兼容的 Dovecot 2.3 或 2.4。优先使用仍在维护的发行版。

- Alpine：如果只启用了本机分支的 `main`，向导会检查同镜像、同分支的 `community`，成功后备份 `/etc/apk/repositories` 并补上这一项。已有同分支 `community` 或无法安全判断的自定义软件源会保留原样。`--check` 只报告，不改配置。
- Debian / Ubuntu：需要系统 npm 和 `/usr/bin/node` 的 **Node.js 22.12 或更新版本**。如果当前 apt 源没有合适版本，请先从可信来源准备系统 Node.js 和 npm；只给登录账号安装的 nvm 版本不能供服务使用。Ubuntu 的依赖可能需要发行版的 `universe` 源。

按上一步获取源码后，在解压出的源码目录以 `root` 运行：

```sh
sh scripts/install-web.sh
```

安装器每次启动都会检测当前的私有局域网 IPv4。只有一个地址时直接使用；有多个时，在终端按网卡名称和地址选择。无人值守且有多个地址时，可用 `sh scripts/install-web.sh --listen 私有局域网IPv4` 指定其中一个。`sh scripts/install-web.sh --check` 只检查系统、已有安装、可用地址和 Node.js，不安装软件。

1. 保持这个终端运行。在同一局域网的浏览器中打开终端打印的 `https://服务器地址:8090/`。证书是本次启动临时生成的；先在浏览器的证书详情核对 **SHA-256 指纹**，一致后才继续。无需把证书加入系统的信任列表。
2. 输入终端显示的单次安装口令（15 分钟内有效）。检查通过后，选择邮件面板端口和语言，填写你要使用的**网页管理员账号和密码**，点击「开始安装」。刷新或关闭浏览器不会中止安装；可用原浏览器回来查看。
3. 安装成功后，点击「显示一次」保存独立生成的 `mailuser` Dovecot 密码。打开邮件面板（默认 `http://服务器地址:8080/`），**直接用你在向导里设置的管理员账号和密码登录**。`mailuser` 密码用于本机 IMAP；安装口令只用于配对向导。
4. 点击「完成并关闭向导」结束；安装结束后即使没有点击，临时 HTTPS 向导也会在 5 分钟后关闭。

向导的证书和监听仅用于本次选定的地址。如果向导开着时服务器换了 IP，等正在进行的安装结束；若尚未安装，退出并重新运行向导，以终端的新地址、证书指纹和口令为准。按默认局域网方式安装后，IP 变化时用新 IP 打开原邮件面板端口（默认 8080）即可。正式面板使用 HTTP，如需公网访问，请另外配置 HTTPS 反向代理。向导会拒绝已有 Mail Aggregator、Dovecot、相关用户或数据的主机；升级和恢复仍使用对应的命令行流程。安装失败时保留已写的数据及终端显示的 root 专用步骤日志，不自动重试；向导会停止本次启动的服务并取消它们的开机启动。网页首次安装与 GitHub 自动安装更新的支持范围独立。

### 命令行安装

在全新的 Alpine 3.24 x86_64 机器上启用同一分支的 `main` 和 `community` 软件仓库，再从解压出的源码目录以 `root` 执行：

```sh
sh scripts/install.sh --quick
```

`--quick` 会安装并初始化 Dovecot、Maildir、imapsync 和 Mail Aggregator。希望选择本地邮箱用户、端口、语言和初始密码时使用：

```sh
./scripts/install.sh --custom
```

安装器优先复用可用的 imapsync 或从发行版源安装。软件源没有 imapsync 时，安装器从当前软件源安装 Perl 依赖，再下载并校验固定的上游 imapsync 2.314。已有 Dovecot 2.3 时，应用升级可采用 `--app-only`。Dovecot 2.3 到 2.4 的配置及存储升级需要按 [Dovecot 官方迁移文档](https://doc.dovecot.org/latest/installation/upgrade/2.3-to-2.4.html) 单独演练。

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

命令行全新安装的 Web 管理面板默认监听 `0.0.0.0:8080`。在同一个可信局域网内打开 `http://服务器局域网IP:8080`，创建第一个管理员。这个地址使用明文 HTTP；公网访问请使用 HTTPS 反向代理。

### 应用更新

主管理员可在「设置 → 应用更新」检查 GitHub Releases，默认每天检查正式版。Alpine 3.24 x86_64 / Node.js 24 / OpenRC 从 v0.2.1 起通过可信源码新装或手工升级会自动固定缺失的官方公钥；管理员另行启用本机安装后，可以设置维护时段或立即安装。详见[部署、更新与回退说明](./APP_UPDATES.md)。

主管理员可在「个人安全」开启双重验证。使用前请查看[恢复码与本机接管指引](./TOTP_SECURITY.md)。

## 多用户与权限

首次创建的账号是主管理员。主管理员可在“用户管理”中创建普通用户或日常管理员；系统不开放公开注册。普通用户只能查看和操作自己的邮箱账号、同步任务、日志及邮件目录。日常管理员可管理用户和查看系统状态，但全局设置、OAuth 客户端密钥、全量备份恢复、服务控制与卸载仅限主管理员。

主管理员和服务器 `root` 属于受信任的部署边界：主管理员导出的全量备份包含所有来源邮箱凭据，`root` 也能直接读取本机 Maildir。项目隔离的是普通用户和日常管理员的 Web 权限，不能在同一台主机上防御拥有 root 权限的人。

新建邮箱的显示名称由用户填写，但实际 Dovecot 顶层目录由服务器按用户和账号编号分配，不能伪造成 `INBOX` 或其他用户的目录。旧版本已有账号会自动归属首次创建的管理员，已有邮件目录不会在升级时移动。因为旧版 `flat` 模式的邮件已经混入公共根目录，首次管理员会保留旧目录读取能力；其他用户只能读取系统分配给自己的隔离目录。

### 已有 Dovecot

已有 Dovecot 时，使用明确的 `--app-only` 模式只安装应用并复用现有配置：

```sh
./scripts/install.sh --app-only
```

先确认本地 IMAP 服务、用户和 Maildir 已配置，再用 `./scripts/doctor.sh` 检查。安装器不会在这种模式下重建现有 Dovecot 配置。为保持快速安装的历史行为，无参数运行与 `--quick` 相同，均为完整安装。

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

升级会保留已有的 Web 监听和 HTTPS 设置。可以用 `--lan-http` 显式启用局域网 HTTP，用 `--local-http` 只监听 `127.0.0.1`，或用 `--https-proxy` 让本机反向代理提供 HTTPS。仅本机模式可通过 SSH 端口转发访问：

```sh
ssh -L 8080:127.0.0.1:8080 root@服务器IP
```

上面的 SSH 转发适用于本机 HTTP 模式。启用可信反向代理后，请通过配置好的 HTTPS 域名登录或执行密码确认；直连应用端口不具备代理提供的客户端地址。遇到 503 时检查代理的 `X-Forwarded-For` 和 HTTPS 配置。

反向代理应转发 `Host`、`X-Forwarded-Proto` 和客户端地址。修改配置后重启服务：

```sh
rc-service mail-aggregator restart
```

## 数据与备份

主管理员可在首页「运维诊断」下载脱敏 JSON。服务启动失败时，在服务器运行 `sudo /opt/mail-aggregator/scripts/doctor.sh --json`。遇到恢复状态需检查时，先保留快照和恢复现场，查看[恢复指引](./TESTING.md#11-恢复中断与离线诊断)。

默认位置：

| 内容 | 路径 |
| --- | --- |
| 程序 | `/opt/mail-aggregator` |
| 应用数据 | `/var/lib/mail-aggregator` |
| 运行配置 | `/etc/mail-aggregator/config` |
| 本机邮件 | `/home/<dovecot-user>/Maildir` |

创建带清单和 SHA-256 校验的备份：

```sh
sudo /opt/mail-aggregator/scripts/backup.sh
```

只读预检：

```sh
sudo /opt/mail-aggregator/scripts/verify-backup.sh backup.tar.gz backup.tar.gz.sha256
```

恢复：

```sh
sudo /opt/mail-aggregator/scripts/restore.sh backup.tar.gz backup.tar.gz.sha256
```

备份包含账号配置和明文可恢复凭据，必须加密、离线保存，不能上传到 Issue 或公开仓库。备份不包含 Maildir。

邮件本体可从稳定快照单独创建加密备份，并恢复到独立目录演练；使用前请阅读 [Maildir 加密备份说明](./MAILDIR_BACKUP.md)。

## 卸载边界

```sh
sudo ./scripts/uninstall.sh
```

该脚本卸载应用，并交互询问是否删除应用数据和程序目录；不会删除 Dovecot、imapsync 或 Maildir。Web 设置页另有明确区分的“程序卸载”和“彻底卸载”模式，彻底卸载会删除 Dovecot、本地邮箱用户及其 Maildir，操作不可撤销。

## 开发与测试

需要 Node.js 22.12 或更高版本：

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

安全问题请按 [SECURITY.md](./SECURITY.md) 优先使用 GitHub 私密漏洞报告；若仓库尚未开启该功能，只提交一个不含技术细节的公开联系请求。不要在公开 Issue 中粘贴凭据、令牌、Cookie、真实服务器地址或未脱敏日志。

## 已知限制

- Web 邮件支持搜索、附件下载、原始邮件导出及本地已读／未读、星标切换；不支持发送、回复、移动和删除
- 跨文件夹搜索按文件夹分批展示，每页检查最多 8 个文件夹，每个文件夹预览最多 5 封；同一封邮件在多个文件夹中会分别展示。结束日期包含当天；正文搜索依赖 Dovecot，未配置全文索引时可能较慢，不保证检索附件内容。
- 正文预览上限 10 MB，超过时仍可查看附件列表。单次下载上限 100 MB，每用户最多同时下载 2 个文件、全站最多 4 个；超过上限或中途失败不会保存为成功文件
- 首次复制保留源邮件标记；后续同步使用 `--noresyncflags` 保留本地标记，不再从源邮箱刷新已有邮件的已读、星标等状态。Web 操作不回写源邮箱。
- 统一未读按有未读邮件的文件夹分组，每组预览最多 5 封，可进入文件夹查看全部；同一邮件出现在多个文件夹时按文件夹分别计数。
- 账号角标表示收件箱未读数；各文件夹单独显示自己的未读数，避免 Gmail 标签重复计数。
- 所有来源默认共用一个本地 Dovecot 服务账号，但新建邮箱使用不可伪造的账号级目录，并由 Web API 强制执行用户访问范围
- Gmail / Microsoft OAuth 最终效果依赖各自控制台配置、租户策略和真实授权验收
- Debian/Ubuntu 安装层尚未完成与 Alpine 同等级的真机测试
- 项目仍处于 Public Beta，升级或恢复前应先创建并验证备份

## 参与贡献

提交问题或代码前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

后续阶段及验收目标见 [MAIL_ROADMAP.md](./MAIL_ROADMAP.md)。

## License

[MIT](./LICENSE)
