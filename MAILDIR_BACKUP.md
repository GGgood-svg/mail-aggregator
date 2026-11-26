# Maildir 加密备份和恢复演练

该工具备份独立的 Maildir 目录，包括邮件文件和目录内的 `dovecot-uidlist`、`dovecot-keywords` 等控制文件。应用现有的账号／设置备份仍需单独执行；两份备份应来自相同的维护时段，并分别妥善保管。

## 前提

- 使用 **GNU tar、GnuPG、Node.js 22.12 或更高版本**。Alpine 可按发行版方式安装 `tar` 和 `gnupg`。
- 源必须是文件系统的稳定快照，或确认所有 Dovecot、imapsync 和其他写入者均已停止写入的 Maildir。工具不会停止服务，也无法替用户证明快照一致。
- 若 Dovecot 将控制文件、索引或 INBOX 配置在 Maildir 目录之外，本工具不会包含那些外部路径，需要另外备份。详见 [Dovecot Maildir 控制文件说明](https://doc.dovecot.org/2.3/configuration_manual/mail_location/Maildir/)。
- 口令文件应由执行用户拥有，权限为 `0600` 或更严格，至少包含 16 字节的一行口令，并保存在 Maildir 和备份文件之外。丢失口令后无法解密备份。
- 备份目录必须已存在，且支持同一目录内的硬链接。新备份先写为临时文件，解密、完整性和目录结构检查通过后才发布。

例如，以受控权限准备随机口令文件：

```sh
install -d -m 700 /root/mail-aggregator-backups
umask 077
head -c 32 /dev/urandom | base64 > /root/maildir-backup.key
chmod 600 /root/maildir-backup.key
```

将口令文件另行安全备份，不要与加密归档放在同一处。

## 创建与验证

下面的源路径必须替换为实际的稳定快照路径。`--stable-source` 表示操作者确认上述前提；它本身不会冻结文件系统。

```sh
node /opt/mail-aggregator/server/cli-maildir-backup.js create \
  /mnt/mail-snapshot/Maildir /root/mail-aggregator-backups /root/maildir-backup.key \
  --stable-source
```

输出是标准 `tar.gz.gpg` 文件路径以及条目数和解压后字节数。创建时使用 GnuPG 对压缩流进行 AES-256 对称加密，并立即解密验证；失败不会发布正式归档。可随时再次验证：

```sh
node /opt/mail-aggregator/server/cli-maildir-backup.js verify \
  /root/mail-aggregator-backups/maildir-EXAMPLE.tar.gz.gpg /root/maildir-backup.key
```

默认不删除旧备份。只有显式增加 `--keep 7` 时，才在新备份验证成功后保留最新 7 个由本工具命名的归档并删除更早的同类归档；其他文件不会参与清理。请先确认备份目录及保留策略适合实际情况。

备份目录使用 `.maildir-backup.lock` 防止多个任务同时备份和清理。若进程异常退出留下锁，先确认对应进程已停止，再由管理员手动移除该锁；程序不会自动抢占未知状态的锁。

## 隔离恢复演练

演练父目录必须存在，不能位于任何 Maildir 内。工具会创建新的 `maildir-rehearsal-*` 私有目录，先完成解密及安全检查，再将邮件还原到其中的 `Maildir`；不会覆盖已有目录或修改运行中的邮箱。演练需要额外的磁盘空间，过程中会在该私有目录中暂存解密后的压缩包，完成或失败时删除该临时压缩包。

```sh
install -d -m 700 /root/maildir-rehearsals
node /opt/mail-aggregator/server/cli-maildir-backup.js rehearse \
  /root/mail-aggregator-backups/maildir-EXAMPLE.tar.gz.gpg /root/maildir-rehearsals /root/maildir-backup.key
```

检查输出目录中的邮件、目录和控制文件，并在独立测试 Dovecot 中验证。若将内容导入生产邮箱，需另行评估目标用户、权限、UID 和停机安排；此命令不执行生产恢复。

校验器只接受普通文件和目录，拒绝符号链接、硬链接、设备文件、路径穿越、重复路径及不受支持的归档扩展；最多 100 万个条目、解压后 1 TiB。源目录中若存在不支持的条目，创建会失败，不会静默产生未经验证的正式备份。

解压体积限制覆盖整个 tar 流，包括条目头、PAX 元数据和结束后的填充。输出中的 `bytes` 为普通文件内容总字节数，`expandedBytes` 为整个解压流的字节数。


## 应用状态与 Maildir 配对、按账号隔离演练

在同一维护时段停止 Web 服务并准备稳定的 Maildir 快照。下面的例子适用于安装器的默认数据目录，以及使用 Maildir++ 目录布局的单个本地 Dovecot 邮箱。把快照标识、路径和本地用户名改成实际值。父目录应在加密存储中，由执行用户持有并设为 `0700`。**应用备份仍包含明文凭据**；Maildir 归档是加密的，口令文件另行保管。

```sh
sudo env MAIL_AGG_DATA_DIR=/var/lib/mail-aggregator \
  node /opt/mail-aggregator/server/cli-backup-pair.js create \
  /mnt/mail-snapshot/Maildir /root/mail-aggregator-backups /root/maildir-backup.key \
  --stable-source --mailbox-user mailuser --snapshot-id maintenance-snapshot-01
```

命令核对 Web 服务未占用应用数据，再捕获 SQLite 与凭据。只有应用归档和加密邮件归档都通过验证，才发布包含 `backup-set.json` 的完整目录。清单将两个摘要和实际扫描到的邮箱目录绑定到同一个备份组。请完整保留该目录及其原名。快照与应用状态一致仍依赖操作者正确选择维护时段；命令不会代替存储快照或冻结 Dovecot 写入。

先用 `verify` 查看配对、账号目录范围和归档中的邮件文件数。需要对照当前配置时，将子命令换成 `plan` 并设置 `MAIL_AGG_DATA_DIR`；它只比较账号范围和重名，不写入当前配置。

```sh
sudo node /opt/mail-aggregator/server/cli-backup-pair.js verify \
  /root/mail-aggregator-backups/backup-set-替换为实际标识 /root/maildir-backup.key
```

`rehearse-account` 将已覆盖的一个账号目录解包至新的私有演练目录。命令不会导入账号、凭据或邮件到正在使用的服务。校验整组归档时，其他账号的邮件不会写入演练目录。`rehearsal.json` 记录本地解包时间、Maildir 文件时间范围及后续检查项；该时间范围不是邮件头中的发件时间。用于恢复演练时，应另起一个隔离 Dovecot，核对文件所有者、UID、旗标及样本邮件；本地解包耗时不代表服务恢复时间。旧的平铺账号、目录缺失、其他用户的 Maildir 或大小写冲突会标为不可单独演练。

```sh
sudo install -d -m 700 /root/mail-aggregator-rehearsals
sudo node /opt/mail-aggregator/server/cli-backup-pair.js rehearse-account \
  /root/mail-aggregator-backups/backup-set-替换为实际标识 /root/mail-aggregator-rehearsals \
  /root/maildir-backup.key 7
```
