# GitHub 应用更新 / GitHub application updates

## 管理员：检查、安装和维护时段

在主管理员的「设置 → 应用更新」选择策略。首次使用默认每天检查正式版。可关闭定时检查，或选择「正式版和预览版」以纳入 `beta`、`rc`。切回正式版不会降级。检查网络失败会保留上次结果并标明失败。Dovecot 和 imapsync 的检查仍在原来的系统信息页面。

「立即安装」提交页面上指定的版本。自动安装按所设时区和时段执行，建议 `03:00–05:00`。例如 `23:00–01:00` 会跨午夜。下载与验包可以提前进行。到切换时仍有同步、写邮件、规则任务或备份恢复，执行器会恢复接收任务，并在约 15 分钟后复查。超过时段就等下一次。手动请求可在「关闭定时检查」模式运行，任务空闲后开始安装。两种安装都只接受已签名且明确支持从当前版本升级的包。启用自动安装或提交立即安装须通过 HTTPS 或本机访问，并验证当前 Web 管理员密码。空间不足时更新会顺延。配置或就绪检查失败时，页面会显示原因及安装结果。

主管理员可读取 `GET /api/system/app-update`，提交 `POST /api/system/app-update/check`、`PUT /api/system/app-update/settings`、`POST /api/system/app-update/install`。写操作均要求 CSRF；立即安装返回 `202`，表示请求入队。

## 安装公钥与启用更新

安装功能首版只支持 **Alpine 3.24 x86_64、Node.js 24、OpenRC**。Debian、Ubuntu 和其他环境提供更新检查与发布说明。这里的应用包不更新 Dovecot、imapsync 或 Maildir。需要切换 Node、Dovecot、系统配置或做人工迁移的发布仍用手工流程。

1. 从官方 GitHub 仓库的可信版本标签取得 v0.2.1 或更高版本的源码包。终端安装和网页安装都随包固定官方 Ed25519 公钥；安装器会打印 SPKI SHA-256 指纹 `b50fa164d2e958748f0df1efbe273c68373a7054ee361b127464a6d545db2ae4`。已有公钥会保留。首次安装也可用 `--trust-update-key /path/to/trusted-update-public.pem` 显式固定另一个已核实的公钥。
2. v0.2.0 等已有安装在维护时段备份，确认所有任务结束，再用可信新版源码手动升级一次。保留源码包，便于需要时恢复。

```sh
sudo sh ./scripts/install.sh --app-only
```

3. 固定公钥后仍默认「仅检查」。在两个签名版本之间演练升级和故障回退后，由服务器管理员开启本机安装能力，再通过 Web 选择需要的更新模式。发布上线前保留默认的「仅检查」。以下标记是本机开关，不会随应用备份恢复，现有自动策略也不会被旧数据库覆盖。

```sh
sudo install -m 0644 -o root -g root /dev/null /etc/mail-aggregator/enable-app-updates
sudo rc-service mail-aggregator-updater restart
```

如需关闭本机安装能力，先确认页面没有正在切换的更新，再删除标记并重启执行器。固定的公钥位于 `/etc/mail-aggregator/update-public.pem`。轮换公钥需要系统管理员重新核对指纹，按受信的手工流程部署。

更新独立保存在 `/var/lib/mail-aggregator-updater/`；执行器位于 `/usr/local/lib/mail-aggregator-updater/`，日志为 `/var/log/mail-aggregator-updater.log`。程序由 root 管理，Web 与候选包的检查代码以 `mailadmin` 运行。卸载先确认两项服务都已停止。普通卸载可保留数据；Web 卸载继续遵循原来的两种删除范围。

## 故障恢复

切换前校验下载、空间和本机配置；切换时保存 SQLite 在线备份 API 生成的快照，其中包括 WAL 中已提交的数据。新版先在维护状态通过本机监听、版本和数据库检查。失败会恢复旧树与快照并验证旧服务。已提交的更新不会用旧快照覆盖新写入。同一个失败的版本需要新的版本标签才能重新进入自动流程。

自动回退失败时，保留 `/opt/mail-aggregator.update-previous`、`/var/lib/mail-aggregator-updater/journal.json` 和 `rollback.db`，并检查更新与 Web 日志。修复磁盘、权限或服务问题后，可由 root 明确重试恢复：

```sh
sudo rc-service mail-aggregator-updater stop
sudo node /usr/local/lib/mail-aggregator-updater/daemon.js --retry-recovery
sudo rc-service mail-aggregator-updater start
```

如果是 `install.sh` 手工升级中断，使用原可信源码（或同一版本的可信副本）：

```sh
sudo sh ./scripts/install.sh --recover-application
```

保留 `/opt/mail-aggregator.install-rollback` 和 `/opt/mail-aggregator.previous` 直到恢复成功。不要靠删除事务记录强行启动服务。数据库备份和恢复命令优先使用安装目录下的副本，例如 `sudo /opt/mail-aggregator/scripts/backup.sh /root/mail-aggregator-backups`。

## 发布维护者

在 GitHub 设置受保护的 `app-release-signing` 环境，限制默认分支、设置审批人和环境密钥 `APP_UPDATE_SIGNING_KEY_B64`（Ed25519 私钥 PEM 的 Base64）。用受保护的、不可重用的版本标签。标签必须在默认分支历史中，`package.json`、lockfile 和标签版本必须一致。正式版用 `v0.2.0`，预览版可用 `v0.2.0-beta`、`v0.2.0-beta.1`、`v0.2.0-rc` 或 `v0.2.0-rc.1`。引导版本的可信源码包包含公钥，同时在说明中发布指纹。

在默认分支手动运行 **Signed application release**。工作流从标签运行测试、在 Alpine 3.24 x86_64 版本环境编译依赖和打包，后续受保护作业校验产物后签发。`policy` 默认为 `manual`。只有保持宿主和数据文件格式兼容、并用来自 `from_versions` 的准确旧版本在真实 OpenRC 上完成成功切换与故障回退后，才选 `automatic`。SQLite 内的可回退迁移允许自动升级；修改凭据文件、Maildir、外部服务或宿主配置的迁移应标为 `manual`。发布后不要换包或重指标签；修复请发布新版本。

The **Settings → Application updates** panel checks stable releases daily by default. It can include previews and, after host opt-in on the supported Alpine profile, install a supported signed release when idle. The Web update API requires a primary administrator. Installation and automatic mode also require the current password and HTTPS or direct loopback. See the setup and recovery commands above. GitHub is the fixed release source. Debian and Ubuntu support version checks and manual upgrades.
