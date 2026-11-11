---
commit: edcaa957458d924bc9c1cfe42b7af59eb9c2db11
title: Proactive 与 Coordinator worker 的实施顺序
date: 2026-11-10
retrospective: true
---

# Proactive 与 Coordinator worker 的实施顺序

## 1. 实现可订阅控制状态

**文件：** `src/proactive/index.ts`。

定义只读控制对象和模块级 nextTickAt。所有转换函数先检查非法状态并返回 false；合法转换通过 `setControlState()` 替换对象并通知 listeners。activate/deactivate 清空 nextTickAt，pause 和 blocked=true 也要清空。`subscribeToProactiveChanges()` 返回实际移除 listener 的 unsubscribe。

**测试：** 在 `tests/proactiveCoordinator.test.ts` 逐个断言非法转换、重复 activate、pause/resume、blocked 和通知次数。

## 2. 实现可取消的 tick scheduler

**文件：** `src/proactive/useProactive.ts`。

`sync()` 必须先 `cancel()`，再检查全部 gate。设置 timer 后，回调重新读取 `this.options` 和 `getProactiveControlState()`，不能直接复用 sync 时的旧状态：

```ts
if (latest.isLoading) latest.onQueueTick(prompt)
else latest.onSubmitTick(prompt)
```

timer 使用 `unref()`。React hook 用 useSyncExternalStore 订阅控制对象，effect 依赖 control 和全部 UI gate，并在 cleanup 调 cancel。

**测试：** 使用可控 timer 分别覆盖 loading→queue、idle→submit、timer 到期前变为 blocked、重复 sync 只保留一个 timer、卸载不触发。

## 3. 接入命令、Sleep 与 REPL

`src/commands/proactive.ts` 只调用 activate/pause/resume 等生产状态函数；`src/screens/REPL.tsx` 在外部 feature 开启时挂载 hook。SleepTool 的 enabled 判断必须读取 proactive 状态，不能仅因构建包含 Sleep 就始终可用。

`scripts/build.ts` 只新增 `PROACTIVE` 和 `COORDINATOR_MODE`，feature fixture 同步检查命令和初始 Sleep 状态。

## 4. 定义轻量 worker

先在 `src/constants/asyncAgentTools.ts` 声明名称集合，再在 `src/coordinator/workerAgent.ts` 过滤 SyntheticOutput、排序并导出单元素 `getCoordinatorAgents()`。

worker 定义必须保持 `source:'built-in'`、`baseDir:'built-in'`、`background:true`。system prompt 写明：任务自包含、看不到用户对话、不得 spawn 其他 agent、只报告实际执行。

**测试与集成：**

```bash
bun test tests/proactiveCoordinator.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除 REPL/命令接入，再回滚 scheduler 和 worker；不要用永久 setInterval、递归 Agent 或加载完整 registry 来绕过当前设计边界。
