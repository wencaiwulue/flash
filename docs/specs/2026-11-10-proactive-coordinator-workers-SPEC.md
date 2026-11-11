---
commit: edcaa957458d924bc9c1cfe42b7af59eb9c2db11
title: Proactive 状态调度与 Coordinator worker 设计
date: 2026-11-10
retrospective: true
---

# Proactive 状态调度与 Coordinator worker 设计

## Proactive 状态机

`src/proactive/index.ts` 将控制状态拆为 `active`、`paused`、`contextBlocked`，并单独保存 `nextTickAt`：

- activate/deactivate 重置三个状态和 nextTickAt；
- pause 只在 active 且未 paused 时成功；resume 只撤销 paused；
- contextBlocked 只在 active 时改变，进入 blocked 会清除 nextTickAt；
- 状态或 nextTickAt 变化通过 listener set 通知，React 用 `useSyncExternalStore` 订阅。

这些布尔状态不能直接启动定时器，调度还取决于当前 UI 是否空闲。

## Tick 调度

`ProactiveTickScheduler.sync()` 先取消旧 timer，再在全部条件满足时设置下一 tick：

- active 且非 paused、非 contextBlocked；
- 不在 loading、没有 queued commands、没有 active local JSX UI、不在 plan mode。

timer 到期时再次读取最新 options 和控制状态，避免使用闭包中的过期 UI 状态。loading 时调用 `onQueueTick`，否则 `onSubmitTick`；timer 使用 `unref()`，effect 清理时 cancel，防止进程被无意义计时器拖住。

`/proactive` 只负责切换上述控制状态。SleepTool 的启用与 proactive 状态关联，不能在未激活时把 Sleep 当作普通等待工具开放。

## Coordinator worker

`asyncAgentTools.ts` 以名称集合声明异步 worker 可用工具，避免加载整个工具 registry。`workerAgent.ts` 在该集合中排除 SyntheticOutput，排序后形成单一 built-in、background worker。

worker prompt 明确：只能看到 coordinator 给出的完整任务，不能读取用户对话；不得递归创建 agent；需要自行研究、修改和验证，并报告文件、实际执行和阻塞项。

构建新增 `PROACTIVE` 与 `COORDINATOR_MODE`，REPL 只在外部功能开启时接入 hook。

## 验收标准

1. activate/deactivate/pause/resume/contextBlocked 的非法转换返回 false，合法转换同步通知并正确清理 nextTickAt。
2. loading、queue、JSX UI、plan mode 和 blocked 状态均阻止 tick；timer 到期时使用最新状态，loading 与非 loading 分别走 queue/submit。
3. scheduler cancel 清理 timer 和 nextTickAt，effect 卸载后不再触发。
4. worker 为 background built-in，工具集等于 allowlist 减去 SyntheticOutput，prompt 禁止递归 agent。
5. `proactiveCoordinator.test.ts` 覆盖状态转换、调度竞争、Sleep 激活和 worker 定义；feature-profile 测试覆盖两个新 feature 与 REPL wiring。
