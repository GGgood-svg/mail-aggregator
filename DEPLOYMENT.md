# Mail Aggregator 完整部署教程

**从 GitHub 下载正式版，到首次同步、手工升级和备份恢复。** 主线使用已验收的 **Alpine Linux 3.24 x86_64、Node.js 24、OpenRC、Dovecot 2.4**。空机看第 2 节；已有 Dovecot 或旧版 Mail Aggregator 看第 5 节；Debian、Ubuntu 看第 6 节。

本文以 2026-11-27 已公开的 [v0.2.2 正式版](https://github.com/GGgood-svg/mail-aggregator/releases/tag/v0.2.2) 为准。服务器可以直接从 GitHub 下载源码，无需先下载到电脑再上传。**v0.2.2 采用手工安装**；面板「设置 → 应用更新」默认保持「仅检查」，渠道选「正式版」。

## 0. 先选安装路径

| 你的服务器状态 | 使用的入口 | 结果 |
| --- | --- | --- |
| 没有 Dovecot、没有 Mail Aggregator | 第 2.2 节下载后运行 `sh scripts/install-web.sh --check && sh scripts/install-web.sh` | 网页向导自动准备依赖，设置管理员、监听地址、端口和安全档位 |
| 不想打开临时网页向导 | 第 2.3 节运行 `sh scripts/install.sh --quick` 或 `--custom` | 终端完成安装，Web 首次打开时创建第一个主管理员 |
| 已有 Dovecot 或已装旧版 Mail Aggregator | 第 5 节运行 `sh scripts/install.sh --app-only` | 只更新应用，保留 Dovecot、凭据、账号和 Maildir |
| 需要恢复应用数据库 | 第 8 节的校验和恢复命令 | 先预检，确认后再停 Web；恢复后仍需手动启动并核对页面 |
| 需要删除应用 | 第 10 节的普通卸载或网页「彻底卸载」 | 默认保留 Dovecot；删除 Dovecot 必须另行勾选并输入确认词 |

安装器不把网页向导用于接管已有实例。看到「已有应用或 Dovecot」时停止当前向导，改走第 5 节。

## 1. 安装前准备

| 你需要准备 | 示例或要求 |
| --- | --- |
| Linux 服务器 | 推荐 Alpine 3.24 x86_64，能通过控制台或 SSH 进入 root shell。网页向导需要同一局域网内的浏览器。 |
| 网络 | 直接下载需要访问 `github.com` 和 `codeload.github.com`。安装依赖需要 Alpine 同分支软件仓库和 npm 注册表；缺少 imapsync 时可能还需访问其 GitHub 上游。同步需要连接来源邮箱的 IMAP 服务。 |
| 存储 | 给邮件、应用数据库、日志和备份预留空间与文件数量配额。预估时把首次全量同步、升级暂存和离线恢复演练的空间都算进去。 |
| 浏览器访问方式 | 可信局域网：直接访问服务器 IP；只需本机监听时用 SSH 转发。公网访问或 OAuth：准备域名和同机 HTTPS 反向代理。 |
| 邮箱凭据 | 先准备一个小邮箱的授权码、应用专用密码或 OAuth 授权。首次验证用可控的账号。 |

下文的「电脑」指你的电脑；「服务器」指 Linux 服务器。服务器命令以 **root** 执行，可用控制台登录，或在已有授权的 SSH 会话中用 `doas -s`、`sudo -i` 进入 root shell。`deploy`、`server.example.com` 和 `mail.example.com` 是示例，请替换为自己的 SSH 用户、服务器地址和公网域名。

## 2. 在空机上安装 Alpine 版

### 2.1 检查系统和仓库

在服务器上执行：

```sh
cat /etc/alpine-release
uname -m
cat /etc/apk/repositories
```

下面以 `3.24.x`、`x86_64` 为例。`/etc/apk/repositories` 应启用当前分支的 `main` 和 `community`。可使用同分支镜像；下面是 `v3.24` 的官方地址。用其他 Alpine 版本时不要照抄 `v3.24`，也不要混入 `edge`。同一镜像只开启 `main` 时，网页向导可在检查成功后备份源配置并尝试补齐同分支 `community`。

```text
https://dl-cdn.alpinelinux.org/alpine/v3.24/main
https://dl-cdn.alpinelinux.org/alpine/v3.24/community
```

```sh
apk update
apk policy nodejs npm dovecot
```

### 2.2 获取 v0.2.2 正式版源码（二选一）

**方式 A：服务器直接从 GitHub 下载（推荐）。** 在服务器的 root 终端复制整段。网址固定到 `v0.2.2` 标签，不需要 GitHub 登录，也不用装 Git。命令会创建一个独立目录，下载成功且解出安装脚本后才打印源码路径：

```sh
install_dir=$(mktemp -d /root/mail-aggregator-v022.XXXXXX) &&
  wget -O "$install_dir/source.tar.gz" \
    'https://github.com/GGgood-svg/mail-aggregator/archive/refs/tags/v0.2.2.tar.gz' &&
  tar -xzf "$install_dir/source.tar.gz" -C "$install_dir" &&
  cd "$install_dir/mail-aggregator-0.2.2" &&
  test -f scripts/install.sh && test -f scripts/install-web.sh && pwd
```

这是发布页里的 **Source code (tar.gz)**。发布附件 `mail-aggregator-alpine-3.24-x64-node24.tar.gz` 是带依赖的签名更新运行包，不含新装向导。源码包用于首次安装和手工升级，运行包只在满足平台、签名和 `from_versions` 条件时由更新器使用。

**方式 B：服务器无法直连下载时，由电脑上传。** 在能访问 GitHub 的电脑上，从 [v0.2.2 发布页](https://github.com/GGgood-svg/mail-aggregator/releases/tag/v0.2.2) 下载 **Source code (tar.gz)**。以下为 Windows PowerShell 示例；把浏览器下载的文件保存在「下载」目录，文件名若不同，先改为 `mail-aggregator-0.2.2.tar.gz`。记下第一条输出的 SHA-256，再把文件上传到 SSH 用户家目录：

```powershell
Set-Location (Join-Path $env:USERPROFILE 'Downloads')
$SourceArchive = 'mail-aggregator-0.2.2.tar.gz'
$DeploySsh = 'deploy@server.example.com'
if (-not (Test-Path -LiteralPath $SourceArchive)) { throw "找不到 $SourceArchive，请先从 v0.2.2 发布页下载 Source code (tar.gz)。" }
if ((Get-Item -LiteralPath $SourceArchive).Length -le 0) { throw "$SourceArchive 是空文件。" }
(Get-FileHash -LiteralPath $SourceArchive -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
scp $SourceArchive "${DeploySsh}:./"
```

回到服务器 root 终端。把 `/home/deploy` 换成上传用户实际的家目录（用 root 上传时是 `/root`），把 `expected` 换成电脑上输出的完整 SHA-256。校验通过才解包，打印的路径是后续安装和升级使用的源码目录：

```sh
archive=/home/deploy/mail-aggregator-0.2.2.tar.gz
expected='替换为电脑上显示的SHA256'
test -f "$archive" || { echo "找不到上传的归档: $archive" >&2; exit 1; }
install_dir=$(mktemp -d /root/mail-aggregator-v022.XXXXXX) &&
  cp "$archive" "$install_dir/source.tar.gz" &&
  printf '%s  %s\n' "$expected" "$install_dir/source.tar.gz" | sha256sum -c - &&
  tar -xzf "$install_dir/source.tar.gz" -C "$install_dir" &&
  cd "$install_dir/mail-aggregator-0.2.2" &&
  test -f scripts/install.sh && test -f scripts/install-web.sh && pwd
```

此校验确认服务器收到的文件与电脑下载的文件一致；请在电脑上使用官方发布页下载。上传源码后，服务器仍需能访问安装所用的软件源和依赖。

### 2.3 全新安装：网页向导或终端安装（二选一）

**推荐网页向导。** 完成第 2.2 节后，在同一个终端运行；重新连接时先 `cd` 到第 2.2 节打印的源码目录：

```sh
sh scripts/install-web.sh --check &&
  sh scripts/install-web.sh
```

1. 向导自动探测私有局域网 IPv4。只有一个时直接使用，多个时在终端选择，通常不需要 `--listen`。保持终端开启，用同一局域网的浏览器打开终端显示的 HTTPS 地址（默认端口 `8090`）。在浏览器中核对临时证书的 SHA-256 指纹，再进入页面。
2. 输入终端显示的**一次性安装口令**（15 分钟内有效），然后在向导设置 Web 管理员账号、密码、面板端口和语言，选定第 3.1 节的安全档位，再开始安装。
3. 安装完成后点「显示一次」保存单独生成的 `mailuser` Dovecot 密码，再打开邮件面板（默认 `http://服务器局域网IP:8080/`）。**直接用向导中设置的管理员账号和密码登录。** 一次性安装口令只用于向导，`mailuser` 密码只用于本机 IMAP。最后点「完成并关闭向导」。

**也可用终端安装。** 在同一源码目录运行以下命令；需要交互选择安全档位、自定义邮箱用户、端口、语言或本地 Dovecot 密码时用 `--custom` 代替 `--quick`。只希望通过 SSH 转发访问时，加 `--local-http`。

```sh
sh scripts/install.sh --quick
```

终端新装完成后，在邮件面板首设页创建主管理员；另行保存安装输出中的本地 Dovecot 初始密码。新装默认 Web 监听 `0.0.0.0:8080`，供可信局域网使用，本地 IMAP 默认监听 `127.0.0.1:143`。默认本地邮箱用户是 `mailuser`，邮件存放在 `/home/mailuser/Maildir`；Web 服务以 `mailadmin` 运行。

安装器使用系统 Node.js，最低 `22.12`；新装推荐 Node.js 24。Alpine 3.24 的仓库若缺少 imapsync，安装器会下载并验证固定的上游 `2.314`。依赖或下载失败时，按终端提示检查仓库分支和连通性。

服务器上检查启动结果：

```sh
node --version
dovecot --version
imapsync --version
rc-service dovecot status
rc-service mail-aggregator status
/opt/mail-aggregator/scripts/doctor.sh --json
```

先确认两个服务均已运行，再选下面一种方式访问。不要把后端 `8080` 或 `143` 直接暴露到公网。

## 3. 打开 Web 页面

### 3.1 可信局域网：直接访问

在同一局域网，用浏览器打开 `http://服务器局域网IP:8080/`；选了其他端口就按实际端口访问。安装完成后如果服务器 IP 变化，用新 IP 打开原端口即可，不需要重装。

**可信局域网**适合只在同一私有 IPv4 子网使用的机器。备份导出、已有快照下载、确认恢复和应用更新安装可以直接走局域网 HTTP，仍要求当前主管理员密码，已开启两步验证时还需新的验证码。恢复预检只检查归档；刚完成恢复后，该会话可以直接下载此次恢复生成的快照。HTTP 不加密，端口不要转发到公网。

**严格**保留 HTTPS 或本机访问的要求。无证书也可用下一节的 SSH 转发。选档不会改变监听地址，也不会关闭已有的强制 HTTPS 代理配置。终端安装可用 `--security-profile strict|trusted-lan` 指定其中一档；例如：

```sh
sh scripts/install.sh --quick --security-profile trusted-lan
```

已升级到支持安全档位的安装可由 root 编辑 `/etc/mail-aggregator/config`：增加或修改一行 `MAIL_AGG_SECURITY_PROFILE=trusted-lan`，改回 `strict` 即恢复严格档。Alpine 执行 `rc-service mail-aggregator restart`；Debian 或 Ubuntu 执行 `systemctl restart mail-aggregator`。未配置此项的旧安装保留严格规则。

### 3.2 用 SSH 转发访问本机地址

`--local-http` 和默认局域网监听均可用 SSH 本机转发，适合严格档操作或首次设置两步验证。**在电脑上**执行下列命令，保持终端打开。如果电脑的 `18080` 被占用，只换前一个端口和浏览器地址。

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18080:127.0.0.1:8080 deploy@server.example.com
```

在同一台电脑打开 [http://127.0.0.1:18080](http://127.0.0.1:18080)。看到首次设置页或登录页就说明链路已通。SSH 用户只需要能登录并被允许做端口转发。使用这条路径时不需要域名、证书或公网 Web 端口。

### 3.3 公网或 OAuth：同机 Caddy HTTPS 反代

全新安装先在可信局域网或通过第 3.2 节的 SSH 转发完成管理员设置，并确认能重新登录。使用网页向导时，管理员已由向导创建。

1. 将 `mail.example.com` 的 DNS 指向服务器公网 IP。有可用 IPv6 才配置 AAAA 记录。允许入站 TCP `80` 和 `443`，确保没有其他程序占用这两个端口。示例是 **Caddy 和应用位于同一台服务器**。
2. 在 Alpine 服务器安装 Caddy 和 OpenRC 服务：

   ```sh
   apk add caddy caddy-openrc curl
   vi /etc/caddy/Caddyfile
   ```

   新建下面站点；已有 Caddy 的机器把站点块加进现有文件。如果这是新装 Caddy，可替换软件包自带的示例内容；已有站点的配置应保留。

   ```caddyfile
   mail.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

3. 开启应用的 HTTPS 代理模式。已装好应用时，用 `vi /etc/mail-aggregator/config` 修改下列四项，保留其余配置。这四项也是安装器 `--https-proxy` 模式的值。

   ```sh
   MAIL_AGG_BIND_HOST=127.0.0.1
   MAIL_AGG_TRUST_PROXY=loopback
   MAIL_AGG_COOKIE_SECURE=true
   MAIL_AGG_REQUIRE_HTTPS=true
   ```

   Caddy 的 `reverse_proxy` 会保留原站点 `Host` 并传送原始协议和客户端地址。应用只信任来自本机的代理；如果代理与应用分开部署，不能直接照抄信任范围。 参见 [Caddy 官方反代示例](https://caddyserver.com/docs/quick-starts/reverse-proxy)和 [Alpine 软件包](https://pkgs.alpinelinux.org/package/v3.24/community/x86_64/caddy-openrc)。

4. 先验证代理配置；已有 Caddy 服务就 `reload`，首次启动就 `start`。如果应用上已有同步或备份任务，等它们结束后再重启应用。

   ```sh
   caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   rc-update add caddy default
   ```

   以下为首次启动命令。已有 Caddy 时将第一行换成 `rc-service caddy reload`。

   ```sh
   rc-service caddy start
   rc-service mail-aggregator restart
   curl -fsSL -o /dev/null -w '%{http_code}\n' https://mail.example.com/
   ```

   预期最终 HTTP 状态为 `200`。再从电脑浏览器打开 HTTPS 域名，确认没有证书告警、能登录且跳转不循环。启用强制 HTTPS 后，用这个域名访问；HTTP 版 SSH 转发不再作为日常登录入口。如果后端实际改用其他端口，Caddy 也要同步改。Web 端口以应用当前设置为准，部署层 `PORT` 可覆盖；单独改文件里的 `WEB_PORT` 不能确保运行端口变更。

## 4. 首次登录与同步

1. 在可信入口用向导设置的 **主管理员** 登录；若是终端全新安装，先按页面提示创建主管理员。建议在「个人安全 → 双重验证」开启 TOTP，将页面显示的 10 枚恢复码另存，并实际测试一次重新登录。日常巡检可以分配运维角色，主管理员权限留给配置、备份、更新等管理操作。
2. 在账号页添加一个小邮箱。来源账号认证参考下表；本地目标用第 2 节建立的 Dovecot 账号。保存时先取消勾选「启用该账号」，避免定时任务抢先开始；仍可以测试连接、查看影响和手动同步。保留默认的账号目录隔离、单路同步，关闭镜像删除。
3. 点「测试连接」，确认来源和本地目标都可连接。再查看**同步影响预演**，核对目录映射、拟创建与订阅的目录、跳过项、冲突和镜像提示。只查询某个目录或根目录一层时，结果只用于确认来源目录，不能代替完整影响预演。
4. 手动同步一次。等任务结束，在账号状态和任务历史核对结果，再在邮件页打开一封实际邮件并核对正文。确认没有非预期的目录或删除后，回到账号编辑页勾选「启用该账号」，让定时同步接管。

| 来源邮箱 | 推荐认证 | 准备工作 |
| --- | --- | --- |
| QQ 邮箱 | 邮箱授权码 | 在邮箱设置开启 IMAP，生成授权码。 |
| 163 邮箱 | 客户端授权密码 | 在网易邮箱开启 IMAP 服务，生成客户端授权密码。 |
| Gmail | 应用专用密码或 Google OAuth2 | 应用专用密码要求开启 Google 两步验证；账号策略也须允许。 |
| Outlook、Microsoft 365 | Microsoft OAuth2 | 在 Microsoft Entra 注册应用，按租户策略完成授权。 |
| 其他 | 自定义 IMAP | 按服务商填写 IMAP 主机、端口、TLS 和凭据。 |

使用 OAuth 时，在主管理员「设置」里的 Gmail 或 Microsoft OAuth2 对应区填公开基址，例如 `https://mail.example.com`，并在服务商控制台精确注册对应回调。将域名换成自己的；基址和回调的协议、域名、路径必须一致。

```text
https://mail.example.com/api/oauth/callback/google
https://mail.example.com/api/oauth/callback/microsoft
```

完成授权后，从连接测试到实际同步各做一次。授权码和应用专用密码不依赖 OAuth 回调，可以在 SSH 转发方式下使用。

## 5. 已有 Dovecot 或已装旧版：手工安装与升级

**用 `--app-only` 保留现有 Dovecot、用户、配置和 Maildir。** 不要在旧环境运行无参数安装、`--quick` 或 `--force-dovecot-init`。现有 Dovecot 2.3 可以保留；迁到 2.4 需要单独计划和验证。

1. 确认现有 IMAP 服务、用户和目录可用。使用默认用户时，可运行 `doveadm user mailuser`；自定义用户要替换名称。记录现有 Web 入口、运行配置、应用数据目录和 Dovecot 邮件位置。
2. 选维护时段，在账号页用「暂停定时同步」暂停相应账号（旧版按其界面暂停调度），并告知其他用户暂缓创建任务。等同步、连接测试、邮件规则和备份恢复任务结束。备份应用和邮件，检查能读取，再留一份服务器或数据卷快照。旧版若没有可用的已安装备份脚本，从旧版 Web 导出应用备份，另做整机或数据卷快照。
3. 按第 2.2 节从 GitHub 下载 v0.2.2 或上传已校验的源码包。留在第 2.2 节打印的源码目录，运行下面的升级命令；不启动全新安装向导。此前没有 Web、但已有 Dovecot 的服务器也用这一模式，随后在设置中填入现有本地邮箱密码并测试。

   ```sh
   sh scripts/install.sh --app-only
   ```

4. 浏览器登录，核对原来的账号、配置、同步历史和样本邮件，再测试一次来源连接和手动同步。确认进入页面后，才恢复定时任务。新装与升级的日常备份命令都使用 `/opt/mail-aggregator/scripts/` 里的版本。

手工切换中断或回退未完成时，保留 `/opt/mail-aggregator.previous` 和 `/opt/mail-aggregator.install-rollback`，先看 Web 日志与安装输出。修复导致失败的配置、权限或空间问题后，用**当次可信安装源码**恢复：

```sh
sh scripts/install.sh --recover-application
```

恢复后以能登录、能读取原有邮件、账号状态正确为验收。不要通过删除事务文件、直接覆盖运行中的数据库或强行启动服务跳过恢复。

## 6. Debian、Ubuntu：人工部署和更新

建议先在测试机跑完本节。生产优先使用已验收的 Alpine 组合；Debian、Ubuntu 可检查 GitHub 版本，但目前只走人工安装与升级。本节假定使用 systemd。

- 从发行版或可信软件源安装 **Node.js 22.12 以上**和 npm，确保 `/usr/bin/node` 是合格版本；systemd 服务直接使用它。确认已安装能运行的 imapsync；如果 `apt-cache policy imapsync` 没有可用版本，按发行版或上游的可信安装方法预装，再执行应用安装。
- 已有 Dovecot 时按第 5 节使用 `--app-only`。确认为全新测试机，且发行版提供兼容的 Dovecot 2.3 或 2.4 时，按第 2.2 节获取源码，再按第 2.3 节启动网页向导或用 `--quick` 安装。不要在这个平台运行 `apk`、`rc-service` 或启用签名更新器。
- 访问、邮箱配置和备份校验步骤相同。管理服务时使用以下命令；重启前先让运行中的任务结束。

```sh
/usr/bin/node --version
npm --version
imapsync --version
systemctl status mail-aggregator dovecot --no-pager
journalctl -u mail-aggregator -n 100 --no-pager
/opt/mail-aggregator/scripts/doctor.sh --json
```

## 7. 备份：应用状态和邮件正文都要保留

| 备份 | 包含 | 用途 |
| --- | --- | --- |
| 应用归档及 `.sha256` | 应用设置、账号、同步历史及可恢复的来源凭据；**不含 Maildir 邮件** | 应用数据恢复、人工升级前保护。必须放在受限的加密存储，不能公开。 |
| Maildir 加密归档 | 邮件文件、目录，以及 Maildir 内的 UID、旗标等控制文件 | 邮件数据恢复。口令独立保管。 |
| 配对备份或同维护时段的整机快照 | 关联应用状态与 Maildir；整机快照还可覆盖独立运行配置 | 迁移和灾难恢复。外置数据卷、外置 Dovecot 控制路径与代理配置要按实际情况一起备份。 |

### 7.1 创建并验证应用备份

在服务器上执行。示例目录应位于只有管理员有权访问的加密存储；如挂的是独立备份卷，先确认已挂载，别把归档写到系统盘。

```sh
install -d -m 0700 /root/mail-aggregator-backups
/opt/mail-aggregator/scripts/backup.sh /root/mail-aggregator-backups
```

下面把 `mail-aggregator-实际时间.tar.gz` 换成命令输出的真实文件名，文件和校验值一起保存。

```sh
archive=/root/mail-aggregator-backups/mail-aggregator-实际时间.tar.gz
/opt/mail-aggregator/scripts/verify-backup.sh "$archive" "$archive.sha256"
```

脚本通过 SQLite 备份接口取得一致数据，包含 WAL 中已提交的事务。不建议用 `cp` 复制正在运行的 `.db` 文件代替备份。离机保存、定期复验，尤其是升级前和账号发生变更后。不要把含凭据的归档放进 GitHub、聊天或工单。

### 7.2 创建并验证 Maildir 加密备份

需要 GNU tar、GnuPG。在 Alpine 执行 `apk add tar gnupg`。以下路径以默认安装和 root 为例；口令文件只在首次创建，保存在备份目录之外，另做安全备份。

```sh
install -d -m 0700 /root/mail-aggregator-backups
(
  umask 077
  set -C
  head -c 32 /dev/urandom | base64 > /root/maildir-backup.key
)
chmod 0600 /root/maildir-backup.key
```

先准备文件系统稳定快照。没有快照时，在维护时段确认 Web、Dovecot、imapsync 和任何其他进程都已停止写入，再使用实际 Maildir。`--stable-source` 是操作者对源已稳定的确认，它不会帮你暂停写入。示例路径 `/mnt/mail-snapshot/Maildir` 换成实际快照中的 Maildir。

```sh
node /opt/mail-aggregator/server/cli-maildir-backup.js create \
  /mnt/mail-snapshot/Maildir /root/mail-aggregator-backups /root/maildir-backup.key \
  --stable-source
```

```sh
mail_archive=/root/mail-aggregator-backups/maildir-实际时间.tar.gz.gpg
node /opt/mail-aggregator/server/cli-maildir-backup.js verify \
  "$mail_archive" /root/maildir-backup.key
```

### 7.3 创建和检查配对备份

适用于使用 Maildir++ 布局的单个本地 Dovecot 邮箱。选择同一维护时段：暂停新任务、等待现有任务结束，确认应用更新没有在切换，停止 Web，再准备稳定的邮件快照。示例使用默认数据目录和用户。如果不用快照而使用实际 `/home/mailuser/Maildir`，还须停止 Dovecot 和其他邮件写入者，保持到备份结束。

```sh
rc-service mail-aggregator stop
```

```sh
env MAIL_AGG_DATA_DIR=/var/lib/mail-aggregator \
  node /opt/mail-aggregator/server/cli-backup-pair.js create \
  /mnt/mail-snapshot/Maildir /root/mail-aggregator-backups /root/maildir-backup.key \
  --stable-source --mailbox-user mailuser --snapshot-id maintenance-snapshot-01
```

把下一段的备份组名换成实际输出。将包含 `backup-set.json` 的整个目录按原名保存，保持其中两个归档和清单齐全。

```sh
backup_set=/root/mail-aggregator-backups/backup-set-实际标识
node /opt/mail-aggregator/server/cli-backup-pair.js verify \
  "$backup_set" /root/maildir-backup.key
```

备份结束后，启动本次停下的服务，先 Dovecot、后 Web；没停 Dovecot 就不需要操作它。恢复调度前，确认应用和邮箱均可访问。

## 8. 恢复：从验证归档到恢复服务

### 8.1 只恢复应用数据

从正在恢复的服务器上运行**安装目录的**脚本；新机迁移时，先安装应用、创建新机主管理员并配置本地 Dovecot。备份当前状态并等待任务结束。确认没有升级事务待恢复。校验通过后才执行恢复并确认提示：

```sh
archive=/root/mail-aggregator-backups/mail-aggregator-实际时间.tar.gz
/opt/mail-aggregator/scripts/verify-backup.sh "$archive" "$archive.sha256" && \
  /opt/mail-aggregator/scripts/restore.sh "$archive" "$archive.sha256"
```

如果来源是第 7.3 节的配对备份，可选用下面这组命令代替上一组。配对校验会依据清单验证 `application.tar.gz`，不需要另造一个 `.sha256` 文件。

```sh
backup_set=/root/mail-aggregator-backups/backup-set-实际标识
node /opt/mail-aggregator/server/cli-backup-pair.js verify \
  "$backup_set" /root/maildir-backup.key && \
  /opt/mail-aggregator/scripts/restore.sh "$backup_set/application.tar.gz"
```

恢复脚本在停服前检查依赖和归档；成功后 Web 仍停着。保留本机当前主管理员、宿主部署配置和本地 Dovecot 密码；不会导入 Maildir，也不会把当前自动更新策略换成备份中的旧状态。确认脚本报告成功后再启动 Web：

```sh
rc-service mail-aggregator start
rc-service mail-aggregator status
```

Debian、Ubuntu 上用 `systemctl start mail-aggregator`。启动后登录，核对账号、凭据、同步历史和样本邮件，并确认备份页面可以列出和读取快照。若恢复被中断，先保留日志和暂存目录、检查恢复状态，避免重复覆盖故障现场。

### 8.2 邮件恢复演练

Maildir 加密归档可以解包到新建的独立目录。若使用配对备份，先校验整个备份组，再把下面的 `mail_archive` 指向组内的 `maildir.tar.gz.gpg`。需要额外的磁盘空间；解包不会把邮件导入生产邮箱。

```sh
install -d -m 0700 /root/maildir-rehearsals
mail_archive=/root/mail-aggregator-backups/maildir-实际时间.tar.gz.gpg
node /opt/mail-aggregator/server/cli-maildir-backup.js rehearse \
  "$mail_archive" /root/maildir-rehearsals /root/maildir-backup.key
```

配对备份可按账号演练。把 `7` 换成配对 `verify` 结果里已覆盖的账号编号；旧版平铺目录或未覆盖账号不能单独按此方式还原。

```sh
install -d -m 0700 /root/mail-aggregator-rehearsals
backup_set=/root/mail-aggregator-backups/backup-set-实际标识
node /opt/mail-aggregator/server/cli-backup-pair.js rehearse-account \
  "$backup_set" /root/mail-aggregator-rehearsals /root/maildir-backup.key 7
```

**整机恢复或换服务器**：先在独立环境恢复匹配的应用与邮件数据。演练阶段限制到生产来源邮箱的访问，避免已恢复的调度意外启动同步。检查 Dovecot 的用户、UID/GID、Maildir 实际路径及外置控制文件；把演练目录接到隔离 Dovecot 中，核对目录、UID、旗标和样本正文。正式切换时先保留原生产卷或快照，停止 Web、Dovecot 和其他写入者，按已演练的存储恢复方案落盘；先验证本地 IMAP，再验证 Web 管理员、来源凭据、签名更新状态和一轮手动同步，然后才恢复代理流量与调度。不要直接把演练解包结果覆盖正在使用的 Maildir。

## 9. GitHub 更新：先检查，满足条件后再启用安装

更新源固定为 [GGgood-svg/mail-aggregator 的 GitHub Releases](https://github.com/GGgood-svg/mail-aggregator/releases)。由主管理员进入「设置 → 应用更新」。**v0.2.2 的签名清单为 `manual`，面板不会安装这个版本。** 全新安装走第 2 节，已有实例升级走第 5 节。

| 设置 | 行为 |
| --- | --- |
| 关闭定时检查 | 停止定时检查，仍可手动点「检查更新」。 |
| 仅检查 | 默认每天检查正式版，并显示候选版本和发布说明。 |
| 自动安装 | 测试通过并开启本机安装能力后，在设定的维护时段内，任务空闲时安装适用的签名包。 |
| 正式版和预览版 | 一并检查 `beta`、`rc` 和正式版。同一版本的正式版排序高于它的预览版；切回正式版不降级。 |

GitHub 超时或限流时会保留上次结果，并显示本次检查失败。需要人工迁移的版本要按第 5 节升级。自动更新只换应用，Dovecot、imapsync、Maildir 不由这个入口更新。

### 9.1 后续版本满足条件时，再开启本机安装能力

此流程不适用于安装 v0.2.2。以后发布了明确支持从当前版本自动升级的签名包，再按此流程操作。本段限 **Alpine 3.24 x86_64、Node.js 24、OpenRC**。至少准备两个可信签名版本，在隔离服务器上演练一次真实升级、一次故障自动回退。确认发布页面候选适用于当前版本、平台与 Node ABI。验包信任从已验证的公钥开始；不要直接拿候选附件里随包提供的公钥作为信任来源。

1. 从官方 GitHub 仓库下载可信的 v0.2.2 或更高版本源码包。支持本机更新的服务器新装时会自动固定官方公钥；未固定公钥的 v0.2.0 或 v0.2.1 安装需要手动升级一次。
2. 在维护时段完成备份、等待任务结束，从可信源码目录运行。安装器把缺失的公钥固定在 `/etc/mail-aggregator/update-public.pem`，并打印它的指纹（见[应用更新说明](./APP_UPDATES.md)）。已有公钥会保留。

   ```sh
   sh ./scripts/install.sh --app-only
   ```

3. 仅在签名版本和隔离演练都准备好后，由服务器 root 开启本机能力：

   ```sh
   install -m 0644 -o root -g root /dev/null /etc/mail-aggregator/enable-app-updates
   rc-service mail-aggregator-updater restart
   rc-service mail-aggregator-updater status
   ```

4. 用 HTTPS、本机转发，或已选可信局域网档时从同一私有 IPv4 子网登录主管理员。通过局域网 HTTP 操作且已启用两步验证时，还要确认新的六位验证码。默认用正式版，选择「自动安装」，验证当前管理员密码，保存时区（例如 `Asia/Shanghai`）与维护时段（例如 `03:00–05:00`）。`23:00–01:00` 是跨午夜窗口。需要手动指定版本时，点「立即安装」并确认密码；请求提交后仍会等待任务空闲。

后台可提前下载、验签、解包与检查容量。应用繁忙时约 15 分钟再查一次，时段结束就顺延到下一个窗口。切换时会短暂重启 Web；到更新页查看候选版本、下次尝试、推迟原因和回退结果。校验失败直接停止安装。切换后新版未就绪时，执行器恢复旧程序和升级前数据库；同一个失败包不会循环安装。已开放写入的新版不会被自动用旧快照覆盖。

如需停用自动安装，在 Web 改回「仅检查」。若还要撤掉服务器上的所有安装能力，先确认没有正在切换的更新，再由 root 移除 `/etc/mail-aggregator/enable-app-updates` 并重启 `mail-aggregator-updater`，让页面只提供检查。

### 9.2 回退未完成时

先记录更新页面或日志中的结果。保留 `/opt/mail-aggregator.update-previous`、`/var/lib/mail-aggregator-updater/journal.json` 和同目录的 `rollback.db`。修复磁盘、权限、配置或服务问题后，才明确重试恢复；中间命令失败不要继续启动执行器。

```sh
rc-service mail-aggregator-updater stop && \
  node /usr/local/lib/mail-aggregator-updater/daemon.js --retry-recovery && \
  rc-service mail-aggregator-updater start
```

这个命令对应 **签名更新器** 的事务。手工 `install.sh` 的中断用第 5 节的 `--recover-application`。

### 9.3 仓库维护者：让正式自动更新可用

参照 [应用更新发布说明](https://github.com/GGgood-svg/mail-aggregator/blob/v0.2.2/APP_UPDATES.md) 配置受保护的 `app-release-signing` 环境和环境密钥 `APP_UPDATE_SIGNING_KEY_B64`。从默认分支历史中的受保护版本标签运行 **Signed application release**；标签、`package.json` 和依赖锁文件中的版本需一致。首次发布保留 `policy: manual`，用清单中 `from_versions` 指定的真实版本实测切换和回退，确认只改应用与可回退的数据库状态后，再为适用升级路径签发 `automatic` 包。官方公钥随可信源码包一起交付，并公开指纹。测试演练用的标签和密钥不能作为生产发行使用。

## 10. 运行维护与故障定位

Alpine 上从服务状态和日志查起；更新器的命令只在它已安装时运行。

```sh
rc-service mail-aggregator status
rc-service dovecot status
/opt/mail-aggregator/scripts/doctor.sh --json
tail -n 80 /var/log/mail-aggregator.log /var/log/mail-aggregator.err.log
```

```sh
rc-service mail-aggregator-updater status
tail -n 80 /var/log/mail-aggregator-updater.log
```

| 症状 | 先检查什么 |
| --- | --- |
| GitHub 源码下载失败 | 先确认服务器能访问 `github.com`、`codeload.github.com`；仍不通时，按第 2.2 节方式 B 上传已校验的源码包。 |
| 局域网打不开面板 | 使用服务器当前 IP 与实际面板端口，确认 Web 服务运行。只监听 `127.0.0.1` 的部署应走 SSH 转发或同机 HTTPS 代理。 |
| SSH 转发打不开 | SSH 会话是否仍开着、转发两端端口是否正确、Web 服务是否运行。 |
| HTTPS 打开是 `502` 或反复跳转 | Caddy 的目标端口、应用监听、本机代理信任、HTTPS 配置、DNS 与证书；查看 Caddy 和 Web 各自的日志。 |
| 测试来源成功，但没有本地邮件 | 目标 Dovecot 用户及密码、实际目录映射、同步任务历史、调度开关；分别核对本地 IMAP 和邮件页。 |
| 同步或更新被推迟 | 看账号和更新页的受阻原因与重试时间；核对应用、邮件、日志、备份各卷，既看空间也看 inode，确认独立卷有挂载且能写入。 |
| 页面显示 v0.2.2，但不能安装 | v0.2.2 只支持手工安装。按第 5 节升级，不需要打开本机自动安装开关。 |
| 旧任务或备份恢复尚未结束 | 保持服务和状态文件，检查任务详情及日志；等完成后再做切换、重启或卸载。 |

容量检查可在服务器运行：

```sh
df -h /var/lib/mail-aggregator /home/mailuser/Maildir /var/log
df -i /var/lib/mail-aggregator /home/mailuser/Maildir /var/log
```

自定义邮件、日志或备份卷时替换成实际路径。将数据库、Maildir 或日志挂在独立卷的部署，应在开机和维护后确认挂载；不要把回落到系统盘当作容量正常。首页「运维诊断」可导出脱敏信息，发给其他人前仍应检查是否包含你的路径和主机名。

普通卸载前先完成应用和邮件备份、等任务结束，然后以 root 运行安装目录的卸载脚本。询问是否删除应用数据时答 `N` 可保留它；此脚本保留 Dovecot、imapsync 和 Maildir。需要重装时同时保留可信源码包和配置。Web 的「彻底卸载」会额外删除确认由安装器创建的 Maildir，默认保留 Dovecot。若安装器记录了 Dovecot 的全新安装，并且配置和软件包预检均通过，可再勾选「同时卸载 Dovecot 软件和配置」，使用 `PURGE-DOVECOT` 确认。沿用已有 Dovecot 的 `--app-only` 安装不提供这个选项。这两种删除邮件的方式都不适合普通重装。

```sh
/opt/mail-aggregator/scripts/uninstall.sh
```

## 上线验收清单

- [ ] 按选定的局域网、SSH 或 HTTPS 入口打开页面；设备重启后应用和 Dovecot 能启动。公网不能直接访问后端 `8080` 或 `143`。
- [ ] 主管理员能重新登录；启用双重验证时，已单独保管恢复码。
- [ ] 测试邮箱两端连接成功，确认同步影响，实际同步一轮并打开邮件正文；任务历史与账号结果一致。
- [ ] 应用备份已校验，Maildir 已有独立的验证过的备份；至少完成一次隔离恢复演练。
- [ ] GitHub 检查能显示结果或明确报错。v0.2.2 保持「仅检查」，不启用面板自动安装。

v0.2.2 在隔离 Alpine 3.24.4 x86_64、Node.js 24、OpenRC 环境通过手工升级和正式运行包验收，复核了原有登录、账号、凭据及 Dovecot 邮件读取。详见[v0.2.2 发布页](https://github.com/GGgood-svg/mail-aggregator/releases/tag/v0.2.2)与[测试说明](https://github.com/GGgood-svg/mail-aggregator/blob/v0.2.2/TESTING.md)。公网代理和真实邮箱授权请在自己的环境另行验证。运维细节见正式版的[项目说明](https://github.com/GGgood-svg/mail-aggregator/blob/v0.2.2/README.md)、[Maildir 备份指南](https://github.com/GGgood-svg/mail-aggregator/blob/v0.2.2/MAILDIR_BACKUP.md)和[双重验证指南](https://github.com/GGgood-svg/mail-aggregator/blob/v0.2.2/TOTP_SECURITY.md)。
