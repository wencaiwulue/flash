---
commit: ea8085139c013577cad3130c35a21fc53a3d8bee
title: 声明式 workflow 的 DAG 执行与任务生命周期
date: 2026-11-10
retrospective: true
---

# 声明式 workflow 的 DAG 执行与任务生命周期

## 定义与发现

workflow 由 name、description、steps 和 concurrency（1–8，默认 2）组成。step 含合法 id、非空 prompt、可选 agentType、dependsOn 和 continueOnError。`parseWorkflowDefinition()` 在 Zod strict schema 之外检查重复 id、未知依赖、自依赖和 DFS 环。

`buildStepPrompt()` 只替换 `{{input}}` 与已经存在的 `{{steps.<id>.output}}`，未知引用保留原文，避免把拼写错误静默替换为空字符串。

discovery 并发读取 project `.claude/workflows` 和 user config workflows，逐文件解析并跳过非法定义；合并优先级为 bundled < user < project，最终按 name 排序。

## DAG 执行

`WorkflowExecution` 为每个 step 保存 pending/running/completed/failed/skipped，并单独保存 results 和整体 running/completed/failed/killed。

主循环每轮先传播 skip，再启动依赖满足且不超过 concurrency 的 step：

- 依赖 completed 才 ready；依赖 failed 时只有 continueOnError=true 可继续。
- 依赖 skipped，或 failed 且未允许继续时，当前 step 被标记 skipped，并沿 DAG 继续传播。
- 每个 running step 有独立 AbortController，完成时写 output/results，失败时写 error。
- controllers 非空且 pending 仍存在时等待 notify 唤醒，避免忙轮询。

retry 只允许 failed/skipped step 回到 pending，并递归重置因依赖未完成而 skipped 的下游；skip 可中止当前 step；kill 把整体置 killed、pending 置 skipped 并中止所有 controller。整体最终状态在任何 running controller 收尾后才决定。

## Runner 与任务层

`runWorkflowStep()` 复用 runAgent 和现有工具权限，选择 step.agentType 或 general-purpose agent，转发 abort signal，并返回最后一个 assistant 文本。

`LocalWorkflowTask` 把 execution 状态映射到任务框架：taskId 对应 executions map，updateTaskState 同步 agents/summary/error。done 后先把完整 state 以 0600 写入 outputFile，再更新任务和发送通知；持久化失败会把整体改为 failed，并省略 outputFile tag。

构建新增 `WORKFLOW_SCRIPTS`，WorkflowTool、斜杠命令和 UI 都复用同一 execution 控制面。

## 验收标准

1. schema、重复/未知/自依赖、环、模板替换和发现优先级均有确定结果。
2. DAG 并发、依赖失败传播、continueOnError、skip/retry/kill 和最终状态符合上述状态机。
3. runner 传递 agentType、权限和 abort，LocalWorkflowTask 的 task 状态、output 权限、通知和持久化失败一致。
4. `workflow.test.ts` 覆盖 DAG 调度、skip/retry/kill、依赖失败、任务输出和 discovery；feature-profile 覆盖 WORKFLOW_SCRIPTS。
