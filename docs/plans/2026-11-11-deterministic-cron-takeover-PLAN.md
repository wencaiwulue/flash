---
commit: 3948f914500e3982fb160607250d6a2e22f0578d
title: Cron 接管测试确定化的实施步骤
date: 2026-11-11
retrospective: true
---

# Cron 接管测试确定化的实施步骤

## 1. 注入锁 probe 间隔

**文件：** `src/utils/cronScheduler.ts`。

在 options 增加 `lockProbeIntervalMs?:number`，锁 probe setInterval 使用 `options.lockProbeIntervalMs ?? LOCK_PROBE_INTERVAL_MS`，不改变默认值。

## 2. 按实际触发者编写断言

**文件：** `tests/cronLifecycle.test.ts`。

second 设置 50ms probe。先等待 first 或 second 任一 nextFireTime，再推进 60 秒并等待总触发数至少一：

```ts
const owner = firstFired.length > 0 ? first : second
const other = firstFired.length > 0 ? second : first
const otherFired = firstFired.length > 0 ? secondFired : firstFired
expect(otherFired).toHaveLength(0)
owner.stop()
await waitFor(() => otherFired.length >= 1, 30_000)
```

## 3. 验收

```bash
bun test tests/cronLifecycle.test.ts
bun run typecheck
bun test
```

分别让两个实例先启动时，测试都应根据真实 owner 通过，而不是依赖 first 名称或生产 probe 周期。
