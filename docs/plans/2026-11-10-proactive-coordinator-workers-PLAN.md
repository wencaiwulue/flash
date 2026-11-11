---
commit: edcaa957458d924bc9c1cfe42b7af59eb9c2db11
title: "Implement proactive state and coordinator workers"
date: 2026-11-10T19:29:50+08:00
status: implemented
kind: component
---

# 实施计划：Implement proactive state and coordinator workers

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要建立可控的 proactive 生命周期：激活、停用、暂停、恢复和上下文阻塞必须有一致状态，空闲 tick 只在安全条件下进入既有 query 管道，Sleep 随 active 状态动态可见；同时提供一个后台、非递归的 Coordinator worker 定义供既有 AgentTool 体系发现。交付边界是进程内状态、调度器、REPL 接线、worker 契约及离线 bundle 验证，真实模型持续 tick/Sleep 和多 worker 选择、并行、汇总仍属于独立编排验证。

- 确认父提交 proactive 状态/scheduler 为空实现、worker 列表为空，Sleep 实现和 AgentTool 异步框架可复用。
- 确认 REPL 已有暂停/恢复、API error、compact/clear 和 meta prompt 管线，新模块只需提供真实控制状态。
- 确认 coordinator 编译与运行时 env gate 分离，worker 定义不会绕过既有权限或自动产生模型编排。
- 将离线 scheduler/definition/build 验证与真实 perpetual/multi-worker 会话分开规划。

## 复用与兼容处理

### 复用现有实现

- 复用 handleIncomingPrompt/enqueue、AbortController、用户队列优先和 onQuery，而非新建 proactive query 循环。
- 复用 Sleep 的时长解析、settings 与 abort，AgentTool 的异步生命周期、通知、allowlist 和 coordinator mode。
- 复用 main.tsx/print.ts 的启动、env 和控制消息激活，以及 PromptInputFooter 的 nextTickAt 展示。
- 复用独立 feature-profile 构建夹具，只扩充真实符号导出、画像字段和断言。
- 复用原工具名和 constants/tools.ts 导出路径，以 re-export 避免消费者迁移。

### 兼容、迁移与生命周期

- PROACTIVE/KAIROS 继续共享同一控制模块，编译后仍需运行时激活；COORDINATOR_MODE 也保留运行时 env gate。
- Read/Write/StructuredOutput 名称及 ASYNC_AGENT_ALLOWED_TOOLS 旧路径均 re-export，工具名字符串没有迁移。
- task-list watcher 的内部用户条件不变，仅 proactive hook 改为外部 feature 条件，避免扩大无关内部功能。
- Sleep 的 duration_ms、min/max、abort 契约保持，变化只在动态 isEnabled。
- worker 复用 BuiltInAgentDefinition 和 AgentTool，普通非 coordinator 内置 agent 列表不被新定义替代。

## 文件级实施步骤

### 1. 建立 proactive 控制状态与命令

在 index.ts 实现默认 inactive 的 controlState、listeners、合法 activate/deactivate/pause/resume/setContextBlocked 和 nextTickAt 更新，重复转换不通知。随后新增 /proactive，以状态转换函数实现 on/off/pause/resume/status 和无参数切换，不让命令直接调用模型。

涉及位置：`src/proactive/index.ts`、`src/commands/proactive.ts`

### 2. 实现 idle scheduler 并连接 REPL

在 useProactive.ts 实现 ProactiveTickScheduler 的 cancel/sync、unref timeout、到期时间和触发时最新 gate 重查，以 onSubmitTick/onQueueTick 区分空闲与等待期间 loading。React hook 订阅 controlState 和 idle 条件；REPL 将 hook 移到 PROACTIVE/KAIROS 路径并传入 queue/UI/plan/loading gate，复用 meta prompt 提交。

涉及位置：`src/proactive/useProactive.ts`、`src/screens/REPL.tsx`

### 3. 让 Sleep 跟随运行时状态并启用构建

将 Sleep.isEnabled 改为 isProactiveActive，保持其他实现不动；build.ts 加入 PROACTIVE 和 COORDINATOR_MODE，使既有 src/tools.ts 插槽与 worker loader 可进入外部 bundle。注意 paused/contextBlocked 只抑制 tick，不额外改变 Sleep 的 active 判定。

涉及位置：`src/tools/SleepTool/SleepTool.ts`、`scripts/build.ts`、`src/tools.ts`

### 4. 拆分轻量工具名与异步 allowlist

分别为 Read、Write、StructuredOutput 新建 constants.ts，并在旧 prompt/实现模块 re-export；把 ASYNC_AGENT_ALLOWED_TOOLS 移入 asyncAgentTools.ts，constants/tools.ts 保留导出。所有字符串和集合成员语义保持不变，只降低 worker 定义的模块加载重量。

涉及位置：`src/constants/asyncAgentTools.ts`、`src/constants/tools.ts`、`src/tools/FileReadTool/constants.ts`、`src/tools/FileReadTool/prompt.ts`、`src/tools/FileWriteTool/constants.ts`、`src/tools/FileWriteTool/prompt.ts`、`src/tools/SyntheticOutputTool/constants.ts`、`src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`

### 5. 定义非递归后台 worker

在 workerAgent.ts 声明唯一内置 background worker，从异步 allowlist 排序生成工具并排除 StructuredOutput，确保 Agent/SendMessage 等不在集合。系统提示说明完整任务上下文、禁止 spawn、验证报告与 blocker 规则；既有 builtInAgents/coordinatorMode/agentToolUtils 负责门控和实际执行。

涉及位置：`src/coordinator/workerAgent.ts`、`src/tools/AgentTool/builtInAgents.ts`、`src/coordinator/coordinatorMode.ts`、`src/tools/AgentTool/agentToolUtils.ts`

### 6. 扩充真实 bundle 画像

feature-check.ts 导出 getCoordinatorAgents 和 proactive 控制函数，verify-enabled-features.ts 启用两个 feature、加载产物后切换 active 并读取 Sleep/worker/command。enabledFeatures.test.ts 固定 31 个非空工具、初始/激活 Sleep 状态、worker background/Bash/无 Agent 和 /proactive，保留其他既有画像字段。

涉及位置：`tests/fixtures/feature-check.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`

### 7. 加入离线回归并记录在线边界

proactiveCoordinator.test.ts 用状态调用和短 timer 验证转换、listener、tick、繁忙抑制及 worker 工具定义；修正负向断言时使用真实 StructuredOutput 名称的意识应保留，现有 SyntheticOutput 写法需记为缺口。STATUS/RELEASE 只引用已记录 77/329、typecheck/build/declarations/CLI smoke/31-tool profile，并明确真实模型会话未运行。

涉及位置：`tests/proactiveCoordinator.test.ts`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 短时钟 scheduler 测试可能有调度时序敏感性，真实 React 生命周期和等待中 loading 分支也未完整覆盖。
- headless 与 REPL 的 gate 不完全一致，尤其 contextBlocked；两条路径需要分别验证，不能共享一个过宽结论。
- worker 工具能力强，非递归列表不限制单个工具自身副作用，权限、中止和后台通知仍至关重要。
- 测试把 StructuredOutput 错写为 SyntheticOutput，可能造成负向排除断言的假安全感。
- 主动 tick 可能增加成本并形成错误循环，必须维持 API-error block、取消暂停、用户优先和 plan/UI 抑制。
- 文档 ARCHITECTURE 与已启用 feature 集不一致，读者可能误判外部能力边界。

## 验收顺序

1. 定向测试所有状态合法/非法转换、listener 次数和 nextTickAt 清理，并检查 activate/deactivate 幂等。
2. 以可控 delay 验证 idle tick 只提交一次、timer unref/cancel、繁忙抑制和等待期间 loading 的 queue 分支。
3. 检查 REPL meta prompt 进入原 onQuery，实测 Esc/用户输入/API error/compact/clear 生命周期；headless 单独验证。
4. 构建外部画像，核对 31 个非空工具、Sleep inactive/active、/proactive 和 worker background/工具。
5. 同时断言 worker 不含 Agent、SendMessage 与真实 StructuredOutput，避免沿用 SyntheticOutput 错名。
6. 依据 at-commit STATUS/RELEASE 引用 77/329、typecheck/build/declarations/CLI smoke，不把记录校验当成历史命令重跑。
7. 真实 perpetual tick/Sleep 和 Coordinator 多 worker 会话只在授权 provider 环境另行执行并留存独立证据。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- proactive 进程内状态、订阅、命令和 idle scheduler 已实现。
- 外部 REPL 的 meta tick 接线、Sleep 动态启停和两个构建 feature 已接通。
- 唯一后台非递归 worker 定义及轻量工具名/allowlist 模块已完成，旧导出路径保留。
- 真实 bundle fixture 已采集 proactive/Sleep/worker/command 状态，画像更新为 31 工具。
- 四个离线控制/定义测试和八项画像断言已加入，at-commit 文档记录 77/329 及构建结果。

### 未完成或后续工作

- 真实模型 perpetual proactive 与 multi-worker orchestration 未在该提交运行。
- headless context-block、完整 React/命令生命周期和长会话行为未充分验证。
- StructuredOutput 的测试负向断言名称错位，worker 单测覆盖需要修正。
- proactive 控制状态持久化、运行时命令激活后系统提示链的直接测试，以及 ARCHITECTURE 文档同步未完成。
- CtxInspect activation/context-collapse、workflow、daemon、local skill-search 等仍是独立工作。
