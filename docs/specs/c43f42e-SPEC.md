---
commit: c43f42e4eba9ae16c7d7a78dfbcfcb4bfb177d0c
title: "Isolate CI lifecycle test timing and cwd"
date: 2026-11-11T00:44:19+08:00
status: implemented
---

# Isolate CI lifecycle test timing and cwd

## Background and requirements

消除 CI 生命周期测试的 cwd 污染并放宽 lock takeover 时间窗口。

## Actual scope

- Changed files: 2
- Diff statistics: 2 files changed, 10 insertions(+), 11 deletions(-)

```text
tests/cronLifecycle.test.ts
tests/reviewArtifact.test.ts
```

## Protocol, dependencies, and security

测试使用 AsyncLocalStorage cwd 和隔离目录。

## Acceptance and verification

ReviewArtifact/cron 定向回归。

## Remaining / unimplemented boundaries

后续提交继续收敛接管竞态。
