---
commit: a8c8b90fd2e7b5fa14ebb2bc6beff3f5c2904346
title: "Add lifecycle regressions and race fixes"
date: 2026-11-11T00:06:18+08:00
status: implemented
---

# Add lifecycle regressions and race fixes

## Background and requirements

补 changed-file、cron、LSP 生命周期测试并修复删除竞态和崩溃重启状态。

## Actual scope

- Changed files: 9
- Diff statistics: 9 files changed, 363 insertions(+), 9 deletions(-)

```text
docs/RELEASE.md
docs/STATUS.md
src/services/lsp/LSPClient.ts
src/services/lsp/LSPServerInstance.ts
src/utils/cronScheduler.ts
tests/changedFiles.test.ts
tests/cronLifecycle.test.ts
tests/fixtures/fake-lsp-server.ts
tests/lspLifecycle.test.ts
```

## Protocol, dependencies, and security

真实文件与 JSON-RPC 子进程，不依赖配置字段假验证。

## Acceptance and verification

offset/limit、cron lock/aging、LSP restart/timeout 全量测试。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
