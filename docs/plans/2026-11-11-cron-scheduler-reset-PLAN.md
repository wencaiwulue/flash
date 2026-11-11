---
commit: e31ff8ffe39417856b209be89190ef9cc429e6b9
title: Cron stop/restart 状态重置的实施步骤
date: 2026-11-11
retrospective: true
---

# Cron stop/restart 状态重置的实施步骤

## 1. 清理停止状态

**文件：** `src/utils/cronScheduler.ts`。

在 stop 的 stopped=true 后立即执行：

```ts
inFlight.clear()
nextFireAt.clear()
```

保留 enablePoll 和其他 timer 清理。restart 不恢复这些旧 map，而是从磁盘重新计算。

## 2. 处理异步 enable 失败

两个 `void enable()` 都改为 `void enable().catch(error => logForDebugging(...))`，确保失败可观测且没有未处理 rejection。

## 3. 用 stop/start 验证接管

**文件：** `tests/cronLifecycle.test.ts`。

owner.stop 后立即 other.stop/start，再 current+=60_000，等待 otherFired。该顺序直接验证清理 inFlight/nextFireAt，而不是只依赖锁超时。

```bash
bun test tests/cronLifecycle.test.ts
bun run typecheck
bun test
```

若 other 不触发，检查 stop 是否清空地图以及 restart 是否重新读取磁盘；若重复触发，检查旧 inFlight 是否被异步回调重新引入。
