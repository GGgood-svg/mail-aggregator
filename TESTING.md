# Mail Aggregator 测试与发布清单

本文是当前版本的验收入口。历史变更不在这里逐版本堆叠，已发布内容统一记录在 [CHANGELOG.md](./CHANGELOG.md)。

## 1. 自动化检查

运行环境支持 Node.js 22.12 以上，并应使用锁文件安装依赖。该下限用于确保邮件 HTML 清洗组件保持在已修复安全问题的版本。Node.js 22.12 的测试进程需要在 `NODE_OPTIONS` 中启用 `--experimental-sqlite`，应用仍由 `better-sqlite3` 访问数据库。

```sh
npm ci
npm test
```

发布基准环境的预期是全部测试通过，无跳过、失败或未处理异常。当前套件覆盖：

- SQLite 初始化、约束、迁移和任务状态
- 同步参数、输出解析、队列、超时、停止和进程退出
- 凭据文件、Dovecot 改密编排和失败回滚
- OAuth2 PKCE、state、令牌刷新和敏感字段隐藏
- HTTP 安全头、会话、CSRF、反向代理和 Cookie
- 多用户角色、账号/任务归属和邮件目录越权防护
- 日志读取、清理和路径限制
- 备份生成、校验、恢复、快照和失败回滚
- 多语言完整性和用户内容不被误翻译
- 只读邮件列表、正文清洗、CID 图片和远程图片隐私
- 密码 worker 池限额、超时和线程退出；并发登录限速、异步等待后的用户／密码／角色变化和状态锁冲突
- 异步容量探测合并、缓存过期、安全余量变化、超时和 inode 耗尽；同步准备的取消、关闭和迟到结果
- MIME 重复 CID 展开、正文与 Unicode 附件元数据字节预算；超限降级后正常邮件仍可解析
- 持久化邮件任务超过 50,000 封、批次确认、取消窗口、重启中断、手动继续、UIDVALIDITY 和权限撤销
- 规则完整预览、冻结 UID、四种标记动作、重复应用、过期／编辑／部分失败与范围上限
- 恢复上传独立名额、空闲与总期限、预检取消、压缩阶段短锁，以及恢复期间的退出登录与授权撤销

附加回归入口：

```sh
npm run test:maildir   # GNU tar 和 GnuPG；虚构邮件、错误口令、损坏归档和隔离恢复
npm run test:browser   # 需安装 Playwright 及 Chromium；仅使用虚构邮件
node scripts/benchmark-responsiveness.cjs  # 实际 worker 池／容量探测的虚构输入基准
sh tests/run-dovecot-ci.sh  # 一次性 Linux 虚拟机。支持 Dovecot 2.3/2.4 和 root 或无交互 sudo
```

浏览器依赖可在测试环境中用 `npm install --no-save --package-lock=false playwright@1.62.1` 和 `npx playwright install chromium` 安装。Dovecot 脚本启动独立的本机测试服务，使用临时测试账号和随机测试文件夹；不要对生产邮箱运行。也可手动准备隔离的本机 Dovecot，再设置 `MAIL_TEST_IMAP_ALLOW_WRITE=synthetic-only`、`MAIL_TEST_IMAP_USER`、`MAIL_TEST_IMAP_PASSWORD` 和 `MAIL_TEST_IMAP_PORT` 运行 `npm run test:dovecot`。该测试会创建并删除其随机命名的测试文件夹。

Linux 上额外执行：

```sh
for script in scripts/*.sh scripts/lib/*.sh scripts/platforms/*.sh scripts/mail-aggregator.openrc tests/run-dovecot-ci.sh; do
  sh -n "$script" || exit 1
done
npm run test:integration
npm audit --omit=dev --audit-level=high
```

真实应用冒烟还验证创建用户、登录、改密、旧会话失效，以及并发密码计算期间其他 HTTP 请求可以完成。上线前应在隔离 Linux 环境验证 sudo helper 的异步执行、超时终止、挂载点空间和 inode；本机的模拟 helper 不代表 Linux 部署已验收。响应性改造细节和本机观测见 [RESPONSIVENESS.md](./RESPONSIVENESS.md)。

## 2. 干净安装

在一次性 Alpine 3.24 x86_64 测试机上执行，启用同版本的 main 和 community 仓库。记录 `node --version`、`dovecot --version`、`imapsync --noreleasecheck --version` 和 `rc-status`。使用虚拟机快照保存初始化前的基线。

```sh
./scripts/install.sh --full
./scripts/doctor.sh
./scripts/doctor.sh --json
rc-service dovecot status
rc-service mail-aggregator status
```

验收：

- 安装器无未处理错误，可重复运行
- `doctor.sh` 全部通过
- Dovecot 和 Mail Aggregator 均为 started
- 未指定初始密码时生成 32 位随机十六进制密码，不再使用固定默认口令
- Web 端口可访问，可创建首个管理员并重新登录
- `/var/lib/mail-aggregator` 仅应用用户可访问
- 密钥文件权限为 `600`，目录权限不向其他用户开放
- `ps`、应用日志和浏览器网络响应中不出现邮箱密码或 OAuth 令牌

再测试 `--custom`，至少覆盖非默认 Web 端口、本地用户和界面语言。

保留一套仅含合成邮件的 Maildir、管理员和本地 IMAP 凭据。重复 `--full` 应保留 Dovecot 配置和密码文件字节。执行 `--app-only` 更新应用，并通过 OpenRC 重启两项服务，再登录 Web 和 IMAP。此前使用 Dovecot 2.3 的机器应单独保留原发行版和包版本进行兼容回归。

## 3. 账号与同步

至少准备两个无重要数据的测试邮箱。

### 密码/授权码账号

- QQ 或 163 授权码可以保存并连接测试
- Gmail 应用专用密码可以保存并连接测试
- 编辑账号时留空密码不会覆盖已保存凭据
- 错误凭据返回可理解的认证错误，页面和日志不泄露密码
- 首次同步成功，第二次同步只处理增量
- 连续点击同步不会为同一账号建立多个活动任务
- 多账号批量同步按队列执行
- 失败、中断、取消的任务可重试，原历史仍保留

### OAuth2 账号

OAuth 必须在真实 HTTPS 域名和测试用 OAuth 客户端上验收：

- Google / Microsoft 回调地址与控制台完全一致
- state 一次性使用且超时失效
- Client Secret、access token、refresh token 不由 API 回显
- 授权完成后 IMAP XOAUTH2 登录和同步成功
- access token 过期前能刷新，刷新后重连成功
- 撤销服务商授权后显示明确错误，并允许重新授权

旧 Alpine 基准使用 imapsync 2.290。安装器在 Alpine 3.24 缺少发行版软件包时使用经过校验的 2.314。用该版本的 `--help` 核对 `--oauthaccesstoken1` 和 `--oauthrefreshcmd1`，再用授权测试邮箱验收两家服务商的登录和刷新行为。

### 高级规则

- 文件夹包含/排除规则只影响选中的文件夹
- 最近天数和最大邮件大小边界正确
- 镜像删除只能用于账号隔离模式
- 镜像删除不能与时间/大小窗口同时启用
- 目标端删除不会删除源邮箱邮件
- 策略切换后旧目标邮件不会被程序静默删除

### 多用户隔离

- 管理员创建两个普通用户，各自添加至少一个邮箱
- 每个用户的账号列表、Dashboard、同步日志只出现自己的数据
- 手工把其他用户的账号 ID、任务 ID 或日志 ID 填入请求时返回 404
- 新账号只能使用隔离模式，实际 Dovecot 根目录使用系统生成的 `U<用户>-A<账号>` 名称
- 手工请求 `INBOX`、其他用户根目录及其子目录时返回 404
- 普通用户不能打开设置、系统信息、用户管理、备份恢复、服务控制和卸载
- 停用用户后其现有会话立即失效；用户本人修改密码后旧会话失效；管理员不能重置他人密码
- 旧版账号全部归属首次管理员，原 Maildir 路径和邮件数量不变

## 4. 只读邮件浏览

- 文件夹列表与 Dovecot 一致
- 消息按新到旧分页，翻页无重复或遗漏
- 翻页失败后重试仍请求原目标页；目录消失时清除旧列表和阅读区；旧 UIDVALIDITY 的迟到已读响应不覆盖新邮箱状态
- 自动预览不改变已读状态，用户主动打开邮件后标记为本地已读
- 纯文本、普通 HTML、表格邮件和移动端布局可读
- CID 内嵌图片显示正常
- 远程图片初始不发起请求，手动允许后才加载
- `<script>`、事件处理器、表单、iframe 和危险 URL 被移除
- 当前文件夹或跨可访问文件夹按发件人、收件人、主题、正文、大小、收取日期和已读状态组合搜索；结束日期含当天，清除筛选后恢复列表
- 跨文件夹搜索按文件夹分页，空页可继续、单个文件夹超时可重试，权限撤销时不会返回受限目录；搜索条件在 POST 请求体中
- 筛选后翻页继续保留筛选条件，空结果有提示；切换文件夹重新开始分页
- 中文、重复文件名、路径分隔符和控制字符附件下载安全；不能通过猜测 MIME 部分编号读取正文或其他用户目录
- 原始 EML 导出与原文逐字节一致，下载不改变已读标记；邮箱 UIDVALIDITY 改变后旧下载链接返回 409
- 超过 10 MB 的邮件仍可查看附件列表和导出；100 MB 下载上限、并发限制及取消下载释放资源均有效
- 邮件量较大、日期损坏或正文异常时单封错误不会拖垮整个列表

## 5. Dovecot 密码

在安装器管理的测试环境执行：

- 当前密码错误时拒绝修改
- 新密码不足 8 位或两次不一致时拒绝修改
- 成功修改后立即可通过真实 IMAP 登录
- `local-target.pass` 与 Dovecot 新密码保持一致
- 模拟 hash 生成失败、helper 写入失败、reload 失败和密钥落盘失败
- 每种失败都不应使 Web 服务崩溃，Dovecot 用户文件和本地密码应回滚
- helper 和 `/usr/local/sbin` 权限允许服务发现，但不允许服务用户直接修改
- sudoers 仅放行固定 helper 子命令，不能是 `NOPASSWD: ALL`

## 6. 备份与恢复

```sh
sudo ./scripts/backup.sh
./scripts/verify-backup.sh backup.tar.gz backup.tar.gz.sha256
```

- 校验文件可由 `sha256sum -c` 验证
- 备份不包含 Maildir、日志、缓存、session secret 和运行配置
- 备份包含的数据库与密钥文件均有清单、大小和 SHA-256
- 非法路径、链接、重复条目、超限压缩包、损坏数据库或错误哈希被拒绝
- 解压大小限制统计完整 tar 流，包括元数据和填充；源文件读错误和过量结束填充不能绕过校验
- 只读预检不修改当前数据
- 恢复前自动创建快照
- 恢复保留当前管理员、本机部署参数和本地 Dovecot 密码
- 恢复失败时数据库和密钥目录一起回滚
- 恢复完成后检查服务，再手动启动

备份内含可恢复的明文邮箱凭据，只能使用测试凭据做公开复现。

## 7. Web 与安全回归

- 未登录访问所有业务 API 均返回 401/403
- 没有或错误 CSRF token 的状态变更被拒绝
- 登录后 session id 发生变化；退出后旧 session 失效
- 连续登录失败触发限速，等待后可恢复
- API 响应禁止缓存并带预期安全响应头
- 严格档的远程 HTTP 不能导出备份；HTTPS 或 SSH 本机转发可用
- 可信局域网档仅允许同一私有 IPv4 子网直连 HTTP 执行敏感操作；其它子网、转发的 HTTP 被拒绝
- 可信局域网档启用两步验证后，下载备份或已有快照、确认恢复、安装更新须验证新验证码；登录用过的验证码和恢复码不能代用。验证器配对及恢复码仍只走保护连接
- 设置 `MAIL_AGG_COOKIE_SECURE=true` 后仅 HTTPS 会话可用
- 反代只信任明确配置的跳数或地址范围
- 账号名、用户名、邮件主题、发件人和日志内容不被 i18n 改写
- 七种语言可以切换，缺失翻译回退英文

## 8. 升级与卸载

- 升级前创建并验证备份
- 在保留数据目录的情况下重新运行安装器，账号与历史不丢失
- 旧数据库启动后迁移成功，活动任务修复逻辑有效
- 普通卸载保留 Dovecot、用户和 Maildir
- Web `REMOVE` 只删除程序和运行数据
- Web `PURGE` 只在明确二次确认后执行，并在一次性测试机验证删除边界

## 9. 发布前签字项

2026-11-16 第二轮计划执行记录见 [IMPLEMENTATION_TASKS_2026-11-16.md](./IMPLEMENTATION_TASKS_2026-11-16.md)，第一轮历史保留在 [IMPLEMENTATION_2026-11-16.md](./IMPLEMENTATION_2026-11-16.md)。本机结果与未执行的发布验收分开记录；以下清单仍是发布验收要求，未在目标环境验证的项目保持未勾选。

2026-11-16 的历史基线在 Node 22.23.4 和 Node 24.21.0 上各通过 308 项测试，并完成生产 better-sqlite3 冒烟和 Chromium 桌面／移动规则流程。此次 Alpine 验收的版本与结果见下文。

- [ ] `npm ci` 使用当前 `package-lock.json` 成功
- [ ] 自动化测试全绿
- [ ] Shell 语法检查通过
- [ ] `npm audit --omit=dev --audit-level=high` 无阻断项
- [ ] 敏感信息扫描无真实凭据、私钥、数据库、备份和服务器地址
- [ ] Alpine 干净安装、升级、普通卸载通过
- [ ] 真实密码/授权码同步通过
- [ ] Gmail 和 Microsoft OAuth 真机验收结论已记录
- [ ] Web 邮件桌面端、移动端和远程图片隐私通过
- [ ] 备份、预检、恢复和失败回滚通过
- [ ] README、CHANGELOG、版本号和发布标签一致

## 10. 本轮新增回归与复现

- `tests/async-security.test.js`：生产 Express 会话存储，真实管理员禁用接口、迟到 `set`／`touch`、OAuth 等待锁、一次性流程和拒绝迟到提交；还检查保存搜索的 CSRF、归属、容量与状态锁。
- `tests/mail-parser-pool.test.js`、`tests/bounded-process.test.js`：MIME 安全输出、队列、线程退出、取消、期限、输出量和子进程 `close`；`doveadm-hash.test.js` 与 `dovecot-password.test.js` 检查 stdin／超时／回滚确认。
- `tests/capacity-async.test.js`、`tests/sync-lifecycle.test.js`、`tests/health-capacity.test.js`：同目标合并、优先级、满队列／排队期限、失效缓存、未结束工作保留名额、15 秒未确认上限和实际存储状态。
- `tests/restore.test.js` 和原生冒烟：新备份按用户名恢复保存搜索、未知用户不混入主账号、旧备份保留偏好、非法和超额条目计数；浏览器验证保存、编辑范围、更新条件、删除、星标、缺失目录不回退及修复、迟到目录刷新。
- `tests/mail-tasks.test.js`：流式处理 50,005 封及另一个目录的 1 封、首次写入前捕获全部 UID 边界、两运行／八等待／每用户一个名额、取消与部分确认、重启／授权／UIDVALIDITY、保留策略和列表计数。预览覆盖 11 个目录、500 目录／50,000 匹配限制、四种动作、过期和修改失效、应用幂等、后面目录重建时前面不写，以及退出中的无效预览继续占用名额。
- `tests/mail-task-crash.test.js`：实际强杀三个子进程窗口（提交前、提交后、确认 checkpoint 前），磁盘 SQLite 与持久化模拟远端 flags 保留；启动后不自动写，手动继续先核实 pending，确认数和写命令不重复，新到 UID 不加入。
- `tests/restore-bounds.test.js`、`tests/restore-lifecycle.test.js`、`tests/backup.test.js`：真实本机 HTTP 上传与可控压缩 gate、上传期限和清理、预检取消、备份压缩时配置锁可用、恢复中撤销会话禁止提交。原生冒烟另验实际 tar／生产 SQLite 和规则按用户名恢复，不导入备份任务。
- `tests/mail-browser.integration.cjs`：实体目录退出保存搜索、跨目录结果保留已执行条件、统一未读只留未读筛选；规则编辑、完整预览、手动应用和任务中心，桌面 1440 px／移动 390 px 布局及页面错误。
- `tests/restore-crash.test.js` 在恢复日志发布、两次凭据目录换位、数据库提交、暂存区清理和两项锁记录移除后强制退出，核对重启时凭据、数据库和可重建缓存的一致性。
- `tests/mail-budget.test.js` 核对百万邮件的 IMAP4rev2 分页边界，以及含附件信息的最终 HTTP 回复。真实 Dovecot 测试验证持久化规则、冻结范围和进程中断后继续。

```sh
npm test
npm run test:integration
MAIL_TEST_NATIVE_SQLITE=1 node --test tests/restore-crash.test.js
npm run test:browser
node scripts/benchmark-mail-parser.cjs /tmp/parser-benchmark.json
# 在隔离 Linux 上执行：
npm run test:helper
sh tests/run-dovecot-ci.sh
npm run test:maildir
```

性能脚本使用合成邮件与真实正文路由，不访问实际邮箱，应该单独运行。4 MiB 本机目标是主线程最大间隔不超过 100 ms，轻量接口 p95 不超过 200 ms；不要把同机 HTTP 夹具结果当作生产时延承诺。

`test:helper` 在临时目录注入阻塞命令，核对超时和回退。完整安装验收还应通过实际 sudo 规则验证改密、失败回退、IMAP 登录及不同挂载点的容量结果。

## 11. 恢复中断与离线诊断

Web 服务和命令行恢复共用数据目录的 SQLite 进程锁。正常退出或进程被强制终止后，操作系统会释放锁。第二个 Web 或恢复进程应等待第一个完全停止。

服务启动时会先读取 `.restore-journal.json`，根据 SQLite 同批事务的提交记录核对凭据目录。已提交的恢复保留新凭据并清理同步缓存。未提交的恢复重新启用原凭据。日志、凭据目录或配置锁归属不明时，服务停止启动并保留现场。

1. 在服务器运行 `sudo /opt/mail-aggregator/scripts/doctor.sh --json`。如果从源码运行，请设置该实例的 `MAIL_AGG_DATA_DIR`。
2. 如报告显示恢复待核对，正常尝试启动一次服务，然后看服务日志及 `restore.last`。检查管理员可登录、原本地 Dovecot 密码可用、账号和规则与预期一致。
3. 如报告仍显示配置锁、损坏日志、旧版恢复现场或数据库不可读取，先停止服务与其他维护进程，保全数据目录及最近的 `restore-points`。此时应在隔离副本核对数据库和原凭据，再决定回退；单凭文件日期或进程编号无法判断安全的目录或锁归属。
4. 在线首页可下载同一格式的脱敏报告。离线模式中的实时队列为空，容量只记录能在本机读取的项目。旧版应用不识别恢复日志，切换回旧二进制前，应先让当前版本完成核对，并确认没有未完成恢复。

## 12. 2026-11-23 验收记录

| 环境 | 验收结果 |
| --- | --- |
| Windows x86_64，Node.js 22.12.0、22.23.4 和 24.21.0 | 各通过 322 项自动化测试。Node.js 22.23.4 的生产 SQLite 冒烟通过。Chromium 通过桌面 1440 px 和移动 390 px 的邮件及诊断测试。 |
| Alpine 3.24.4 x86_64 隔离虚拟机，Node.js 24.22.3、Dovecot 2.4.5 和 imapsync 2.314 | 使用锁文件完成全新安装、重复 `--full` 和 `--app-only` 升级。真实 `doveconf` 验证后的模拟启动失败保留两份原配置。OpenRC 重启后可登录 Web 和 IMAP，Web 停止期间仍能导出离线报告。重复安装与应用升级保留 Dovecot 配置和密码文件字节。 |
| 同一 Alpine 虚拟机，已安装服务和独立 ext4 邮件盘 | Web 改密成功。刻意让本地凭据写入失败后，原 Dovecot 账号文件和本地凭据恢复到原字节，原 IMAP 密码可用。安装后的 sudo helper 和在线报告读取到独立邮件盘的空间和 inode。加密备份从稳定副本恢复出了测试邮件和 Dovecot UID 元数据。 |
| Alpine 3.24.4 原生 SQLite、真实 Dovecot 2.4.5 与 Alpine 3.21.10 隔离根目录中的 Dovecot 2.3.21.1 | Web 原生冒烟、七个恢复强制退出边界和未知状态用例通过。两套真实 Dovecot 各通过两项用例，覆盖四种规则动作、冻结范围、重复应用、断线、UIDVALIDITY 变化和强制终止后继续。 |

虚拟机使用软件模拟。验收安装临时禁用原生模块的编译优化与 LTO，以缩短模拟构建时间。生产安装器的编译参数和应用依赖锁文件保持原样。恢复测试强制终止应用进程；主机断电和存储故障另属演练范围。

上线回退前应保全数据目录、凭据及 `restore-points`，用第 11 节的报告确认没有待核对恢复，停止 Web 服务后才切回先前应用版本。实际降级、Dovecot 2.3 到 2.4 的配置与存储迁移、真实 Gmail 和 Microsoft OAuth、真实服务商授权码同步、普通卸载、非默认交互安装及新一轮依赖漏洞库核查需要单独验收。

## 13. GitHub 应用更新验收

```sh
node --test tests/app-update.test.js
npm run test:integration
```

在低速软件模拟的隔离测试机上，若四个并发密码验证超过队列时限，可显式运行 `MAIL_TEST_ALLOW_PASSWORD_BACKPRESSURE=1 npm run test:integration`。该模式仍要求 Web 请求可响应，至少一次错密返回 401；其余只允许明确的密码服务繁忙 503，并在队列清空后复测错密 401。默认测试和发布工作流仍要求四次均为 401。

自动化测试核对版本顺序、维护时段、签名与下载、任务等待、SQLite WAL 快照和开机恢复。原生冒烟通过真实 Web 服务核对主管理员权限、CSRF、当前密码和访问方式。在支持 Unix 套接字的环境中，测试还会确认维护期间拒绝 Web 请求，并检查监听、数据库和空闲探针。

发布可自动安装的版本前，在隔离的 Alpine 3.24 x86_64、Node.js 24 和 OpenRC 中，以该签名清单列出的每个来源版本演练。先准备合成账号、凭据和本地邮件，再验证下列结果。

- 定时检查默认使用正式版。预览版切回正式渠道后只提示更高版本。连接失败和限流应保留上次结果。错误签名与需要人工迁移的包应无法安装。
- 手动安装接收指定版本。维护时段可跨午夜。任务忙碌时约 15 分钟后再尝试，且窗口结束后等到下一窗口。下载和预检可以提前完成。
- 配置预检失败时原进程继续提供服务。新版进程退出、就绪超时或切换中断后，需验证旧版登录、账号、凭据和邮件可用。同一失败版本不得重复安装。
- 在切换后、确认前重启主机，检查开机回退及服务就绪。已确认上线后的写入应能在后续重启中保留。
- 从安装目录备份并恢复，核对共用维护锁、网页下载的恢复点和独立保存的更新策略。

签名环境、首装公钥和启用步骤见[应用更新说明](./APP_UPDATES.md)。

2026-11-24 的隔离演练中，Windows Node.js 22.23.4 通过 335 项测试及原生冒烟。Alpine 3.24.4 / Node.js 24.22.3 通过 13 项应用更新测试及更新入口的原生冒烟。实际 OpenRC 使用测试签名包完成预览版升级、跨午夜自动安装、失败回退和重启恢复。Alpine 软件模拟的全量测试有 4 项失败、3 项取消。延长隔离副本中的测试时限后，邮件任务中断和备份上传用例通过。完整原生冒烟的并发密码用例在该环境仍触发处理时限。
