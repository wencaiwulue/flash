---
commit: ea8085139c013577cad3130c35a21fc53a3d8bee
title: 声明式 workflow 的实施顺序
date: 2026-11-10
retrospective: true
---

# 声明式 workflow 的实施顺序

## 1. 先固定 schema 与发现规则

**文件：** `src/tools/WorkflowTool/schema.ts`、`discovery.ts`、`bundled/index.ts`。

实现 strict Zod schema 后，再检查重复 id、未知依赖、自依赖和 DFS cycle。模板替换只处理 input 和已有 step output。discovery 逐文件捕获解析错误，按 bundled < user < project 合并并排序。

**测试：** `tests/workflow.test.ts` 先覆盖非法 schema、重复/未知/自依赖、环、未知模板引用和 project 覆盖同名 user workflow。

## 2. 实现 DAG 状态机

**文件：** `src/tools/WorkflowTool/executor.ts`。

先初始化全部 pending agents 和空 results。每轮顺序固定为 propagateSkips → 找 ready → 按剩余并发 launch → 无工作时等待 notify。

launch 为 step 建 AbortController，runner 的 prompt 来自 buildStepPrompt；只有整体非 killed 且 agent 仍 running 时才接收 success/failure，避免 kill 后迟到结果改写状态。

实现 skip、retry、kill：retry 递归恢复因依赖未完成而 skipped 的下游；kill 先改整体状态再 abort 全部 controllers。done 只能在 controllers 清空后 resolve，failed agent 使整体 failed，否则 completed。

**测试：** 用 deferred runner 控制完成顺序，覆盖并发上限、continueOnError、skip 传播、retry 下游、kill 迟到输出和唤醒。

## 3. 接入真实 agent runner

**文件：** `src/tools/WorkflowTool/runner.ts`。

动态加载 runAgent/getTools/generalPurposeAgent，按 agentType 选择定义；promptMessages 只有当前 step prompt。把外部 signal 接入内部 AbortController，并在 finally 移除 listener。遍历 assistant 消息，返回最后一个非空文本，abort 时调用 throwIfAborted。

## 4. 映射到任务框架与持久化

**文件：** `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`。

注册 local_workflow task，并保存 taskId→execution。onUpdate 同步 agents、summary、error。done 后先删除 map，再以目录 0700、文件 0600 写完整 state；写失败时把 status/error 改为失败，然后更新任务和发送通知。

skip/retry/kill 命令只调用 executions 中对应方法，未知 task 由 LocalWorkflowTask.kill 给出明确错误。

## 5. 接入外部入口并验收

WorkflowTool、createWorkflowCommand 和 WorkflowDetailDialog 复用 execution 的 skip/retry/kill 与 agents 状态；`scripts/build.ts` 只添加 `WORKFLOW_SCRIPTS`。

```bash
bun test tests/workflow.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除 UI/命令，再回滚任务层、runner 和 DAG executor。不得用顺序执行冒充 DAG、吞掉依赖失败，或在 controllers 尚未结束时提前 resolve done。
