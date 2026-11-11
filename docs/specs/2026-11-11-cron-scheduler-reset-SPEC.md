---
commit: e31ff8ffe39417856b209be89190ef9cc429e6b9
title: Cron scheduler stop/restart 状态重置
date: 2026-11-11
retrospective: true
---

# Cron scheduler stop/restart 状态重置

## 设计

`stop()` 除了 stopped 和 interval 清理外，新增 `inFlight.clear()` 与 `nextFireAt.clear()`，防止旧任务在重启后永久占用执行中状态，或沿用停止前的触发时间。重启后从磁盘和当前时间重新建立调度。

`start()` 的两个 `void enable()` 都增加 `.catch(...)`，把异步启用失败写入 debug，避免未处理 Promise rejection。

接管测试在 owner.stop 后立即执行 other.stop/start，再推进 60 秒，验证 other 能从清理后的状态重新获锁并触发，而非只等待旧实例偶然接管。

## 验收标准

1. stop 清除 inFlight/nextFireAt 及所有 timer，旧状态不会阻止或重复触发。
2. stop/start 后从磁盘重锚 nextFireAt，other 可重新接管。
3. 两条 enable 异步路径都有 rejection 处理，不影响启动语义。
4. `cronLifecycle.test.ts` 的 owner/other、stop/start 和虚拟时间推进均验证该行为。
