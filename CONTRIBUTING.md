# Contributing

感谢参与 Mail Aggregator。项目仍处于 Public Beta，优先接受可复现的缺陷修复、安全加固、测试补充和部署兼容性改进。

## 开始之前

- 搜索现有 Issue，避免重复报告
- 安全问题使用 GitHub 私密漏洞报告，遵循 [SECURITY.md](./SECURITY.md)
- 不要提交真实邮箱密码、授权码、OAuth 凭据、Cookie、数据库、Maildir、备份或未脱敏日志
- 大型功能先开 Issue 说明目标、边界和迁移影响

## 本地开发

```sh
npm ci
npm test
```

Linux 上同时运行：

```sh
sh -n scripts/*.sh scripts/lib/*.sh scripts/platforms/*.sh
```

功能变更应增加或更新自动化测试。涉及安装、Dovecot、imapsync、OAuth 或恢复的改动，还要在隔离的 Linux 测试机按 [TESTING.md](./TESTING.md) 做对应真机验收。

## Pull Request

请在 PR 中说明：

- 问题和预期行为
- 实现范围与没有处理的范围
- 数据库、配置或部署兼容性影响
- 执行过的自动化与真机测试
- UI 变化的截图（如适用）

尽量保持一次 PR 只解决一个问题。不要顺带格式化或重写无关文件。
