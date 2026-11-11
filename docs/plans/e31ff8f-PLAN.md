---
commit: e31ff8ffe39417856b209be89190ef9cc429e6b9
title: "Reset cron scheduler state on stop and restart"
date: 2026-11-11T01:02:40+08:00
status: implemented
kind: component
---

# 实施计划：Reset cron scheduler state on stop and restart

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让 stop/start 成为干净的调度生命周期：停止时丢弃进程内触发状态，重启重新发起磁盘加载并在空 Map 上重锚，而不是沿用旧 Map/Set。回归通过显式重启非 owner 并再次推进虚拟时间区别于父提交的被动接管，但该序列是否真正构造旧状态、未 await 的读盘顺序以及跨生命周期异步 finally 都需单独限定；异步 enable 失败也应进入 debug 日志而不是形成未处理 rejection。

- 确认父提交 stop 保留 inFlight/nextFireAt，而 load(true) 和 check 已具备从磁盘任务首次锚定的路径。
- 确认回归已能动态识别 owner/other，新增步骤必须显式重启 other，不能只等待被动 probe。
- 确认测试的 now 只控制任务到期，真实 check/probe timers 仍需要 waitFor。

## 复用与兼容处理

### 复用现有实现

- 复用 readCronTasks、recurring 的 lastFiredAt ?? createdAt 锚定、jitter 计算和持久化写入。
- 复用 stop 的 timer/watcher/lock 清理、enable/start 正常流程以及既有 afterEach 清理。
- 复用父提交的 50 毫秒 lockProbeIntervalMs 与 owner/other 动态选择，不重复设计接管机制。

### 兼容、迁移与生命周期

- CronSchedulerOptions、start/stop 签名和 cron 文件结构不变，生产默认探测与 check 周期不变。
- 停止后 getNextFireTime 不再返回旧生命周期值；重启继续使用磁盘 lastFiredAt/createdAt，而非无条件立即触发。

## 文件级实施步骤

### 1. 重置 stop 生命周期状态并收口启动异常

在 cronScheduler.ts 的 stop 开头清 inFlight 和 nextFireAt，保留原有 stopped、timer、watcher、锁处理。给 dir 与已启用 REPL 两个直接 enable 调用添加 catch/debug；不要改 cron 文件或首次锚定算法，让重启通过空 Map 和 load(true) 自然重建。

涉及位置：`src/utils/cronScheduler.ts`

### 2. 把被动接管回归扩展为显式重启

在 cronLifecycle.test.ts 保留 owner.stop，随后加入 other.stop/start，再把 current 推进 60_000，以 10 秒 waitFor 等 otherFired。这样测试观察的是此前未触发的 other 实例显式重启、重新获锁并再次触发，而不是上一提交的被动 takeover；不把它记为旧 owner 状态清理或读盘先于 check 的定向回归。

涉及位置：`tests/cronLifecycle.test.ts`

## 风险与处理

- 若只清 nextFireAt 而保留 inFlight，重启仍可能跳过任务；两个派生结构必须同时重置。
- 虚拟时钟推进不会唤醒真实 timer，测试仍需真实 waitFor；10 秒等待不是把文件与锁操作同步化。
- 该用例不覆盖 stop 与未结束 one-shot 删除的交错，enable catch 也只记录异常而不证明恢复。

## 验证顺序

1. 定向重复运行 cron lifecycle，确认 owner.stop 后 other 经显式 stop/start 在第二次虚拟时间推进后触发。
2. 另补定向检查：让实际触发并持有 nextFireAt/inFlight 的 owner 停止再启动，直接验证 stop 后两者为空及 recurring 重锚；现有 other 用例没有执行这些断言。
3. 核对两个直接 start 分支的 rejection 日志路径；任何测试通过结论必须引用实际命令或 CI 来源。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- stop 已清 inFlight/nextFireAt，两个直接 enable 启动路径已增加 rejection 日志。
- 测试已加入非 owner 的 other.stop/start 和第二次虚拟时间推进，用于观察显式重启后的再次触发；不将其记为旧状态清理或磁盘重锚的定向回归。

### 未完成或后续工作

- 真实多进程崩溃恢复、实际 owner 旧状态清理、读盘与首次 check 顺序、one-shot/recurring 异步 finally 跨生命周期交错及 enable 失败重试没有新增验证。
- enablePoll 的异步回调未随这两个直接调用一起修改。
