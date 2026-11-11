---
commit: e31ff8ffe39417856b209be89190ef9cc429e6b9
title: "Reset cron scheduler state on stop and restart"
date: 2026-11-11T01:02:40+08:00
status: implemented
---

# Reset cron scheduler state on stop and restart

## Background and requirements

在 scheduler stop 时清理 inFlight/nextFireAt，重启后从磁盘重新锚定。

## Actual scope

- Changed files: 2
- Diff statistics: 2 files changed, 12 insertions(+), 3 deletions(-)

```text
src/utils/cronScheduler.ts
tests/cronLifecycle.test.ts
```

## Protocol, dependencies, and security

避免旧任务在 stop/start 后永久阻塞或重复触发。

## Acceptance and verification

全量 cron、ReviewArtifact 与 CI 回归。

## Remaining / unimplemented boundaries

无该提交范围内的未实现项。
