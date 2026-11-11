---
commit: edcaa957458d924bc9c1cfe42b7af59eb9c2db11
title: "Implement proactive state and coordinator workers"
date: 2026-11-10T19:29:50+08:00
status: implemented
kind: component
---

# Implement proactive state and coordinator workers

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 proactive 模块仍由固定 false/null/no-op 组成，useProactive 不建立 timer，getCoordinatorAgents 返回空数组；Sleep 虽已有等待实现，却仅凭静态 isEnabled=true 暴露，未随主动状态启停。REPL 中 useProactive 还位于 USER_TYPE === ant 的内部用户分支，外部构建即使编译模块也不会执行该 hook。异步 worker 所需的 AgentTool、coordinator mode、后台任务和工具过滤框架已经存在，但缺少具体 worker 定义；直接从未拆分模块读取工具名还会拉入重型工具实现。构建与画像未开启 PROACTIVE/COORDINATOR_MODE。

需要建立可控的 proactive 生命周期：激活、停用、暂停、恢复和上下文阻塞必须有一致状态，空闲 tick 只在安全条件下进入既有 query 管道，Sleep 随 active 状态动态可见；同时提供一个后台、非递归的 Coordinator worker 定义供既有 AgentTool 体系发现。交付边界是进程内状态、调度器、REPL 接线、worker 契约及离线 bundle 验证，真实模型持续 tick/Sleep 和多 worker 选择、并行、汇总仍属于独立编排验证。

## 目标与非目标

### 目标

- 实现进程内 active/paused/contextBlocked/nextTickAt 状态、幂等转换和订阅通知，并提供 /proactive 控制命令。
- 以可取消、unref 的 idle scheduler 生成 meta tick，在 loading、队列、local-JSX UI、plan、暂停和阻塞条件下抑制调度。
- 把 proactive hook 移到 PROACTIVE/KAIROS 外部特性路径，复用 REPL 提交与队列以及既有错误、取消、compact/clear 生命周期。
- 让 Sleep 仅在 proactive active 时启用，并在编译画像中验证初始关闭、激活后开放。
- 注册一个 background worker，限制为异步允许工具且排除 Agent/SendMessage/StructuredOutput，保留非递归执行边界。
- 拆分轻量工具名常量并保留旧 re-export，开启两个构建特性，补充离线状态、scheduler、worker 和真实 bundle 画像测试。

### 非目标

- 不声称真实模型驱动的 perpetual proactive session 已运行或证明长期成本、延迟和稳定性。
- 不实现或验证多 worker 模型编排、并行启动、继续、停止和汇总；这些仍由既有 AgentTool 执行体系另行验收。
- 不持久化 proactive 状态或跨进程同步 paused/contextBlocked/nextTickAt，session 恢复不等于控制状态恢复。
- 不启用 CONTEXT_COLLAPSE/CtxInspect，不交付 workflow、daemon、UDS inbox 或 local skill-search。
- 不把 worker 系统提示当作权限系统，不为 Bash/Write/Edit/Web/Worktree 等工具增加授权绕过。
- 不把 headless scheduler 与交互式 REPL 的 context-block 行为混为同一已验证保证。

## 方案架构与数据流

proactive/index.ts 以模块级 controlState 保存 active、paused、contextBlocked 和 nextTickAt，listeners 保存订阅者。activate 只在 inactive 时进入全清零的 active 状态，deactivate 回到全 false；pause/resume 分别要求 active 且未暂停/已暂停。setContextBlocked 仅在 active 且值变化时转换，置位清 nextTickAt，清除时保留 paused；重复操作返回 false 且不重复通知。getProactiveControlState 是 useSyncExternalStore snapshot，订阅返回真实 unregister。

/proactive 是 immediate local-jsx 命令。无参数按 active 在 on/off 间切换；on 可激活 inactive 或恢复 paused，off 停用，pause/resume 根据状态转换结果提示，status 依次显示 off、paused、contextBlocked、active。命令只改变控制状态，不直接发起模型请求；后续 REPL query 每次调用 getSystemPrompt，并按当前 isProactiveActive() 选择完整 proactive system prompt。启动参数/env 与 /proactive 在这一点上共用状态驱动路径。

ProactiveTickScheduler 默认 delay 为 1000ms，sync 先取消旧 timer，再在 options 缺失、inactive、paused、contextBlocked、loading、queuedCommands、local-JSX UI 或 plan mode 时保持空闲。可调度时公开 nextTickAt 并创建 unref timeout；触发时重新读取最新 options 和控制状态，若 loading 已出现则 onQueueTick，否则 onSubmitTick，仍繁忙或被阻塞则取消。cancel 同清 timer 和到期时间，React hook 通过 ref 保持同一 scheduler 并订阅状态及 idle 条件。

REPL 将 useProactive 从内部用户分支移到 feature(PROACTIVE)||feature(KAIROS) 下，task-list watcher 仍保留原内部用户条件。onSubmitTick 以 isMeta=true 进入 handleIncomingPrompt，onQueueTick 以 prompt/isMeta 进入既有 enqueue；handleIncomingPrompt 继续负责 query 活跃检查、用户队列优先、AbortController 和 onQuery。既有 onCancel 暂停、下次用户提交恢复，API error 置 contextBlocked，普通成功 assistant、compact 和 /clear 解除阻塞，因而新状态实现接入已有失控缓解点。

SleepTool 只把 isEnabled 改为 isProactiveActive，等待、设置上下限、duration_ms alias 和 abort 逻辑保持父提交实现。active=false 时既有 getTools 过滤 Sleep，activate 后开放；paused/contextBlocked 只抑制自动 tick，不会单独禁用 Sleep。正式构建和 fixture 开启 PROACTIVE 后，外部基础工具数从 30 增至 31，画像实际调用 activate/deactivate 并观察 Sleep 的动态状态。

workerAgent.ts 返回单个内置 agentType=worker、background=true 的 WORKER_AGENT。工具从 ASYNC_AGENT_ALLOWED_TOOLS 取集合并排除 SYNTHETIC_OUTPUT_TOOL_NAME 后排序，覆盖 Bash、Read、Write、Edit、Glob、Grep、Web、Skill、TodoWrite、Worktree 等 15 个名称，不含 Agent、TaskOutput、TaskStop、SendMessage；真实 StructuredOutput 也被剔除。系统提示说明 worker 看不到用户会话、不得 spawn 其他 agent，并要求报告实际验证和 blocker。

非递归约束由三层组成：轻量 ASYNC_AGENT_ALLOWED_TOOLS 集合本身不含递归/主线程工具，worker 再排除 StructuredOutput，既有 agentToolUtils 还对 async agent 施加 allowlist 与 ALL_AGENT_DISALLOWED_TOOLS。builtInAgents 只在 COORDINATOR_MODE 编译且 CLAUDE_CODE_COORDINATOR_MODE 运行时门控成立时加载 worker 列表，coordinatorMode/toolPool/AgentTool 继续承担主线程工具收缩、后台生命周期与通知；本提交没有另写执行循环。

为避免 worker 定义仅为名称加载完整工具实现，Read、Write、StructuredOutput 的名字分别移到轻量 constants.ts，旧 prompt/实现模块原样 re-export；ASYNC_AGENT_ALLOWED_TOOLS 也拆到 asyncAgentTools.ts，constants/tools.ts 保留原路径导出。feature-check 导出真实 proactive/coordinator 符号，verify-enabled-features 在同两个 feature 下构建 bundle、切换状态并输出 worker/Sleep/command 字段，测试再核对 31 个非空工具和既有 ultraplan/voice/brief 注册。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/proactive/index.ts`，符号 `let controlState: ProactiveControlState` | 实现 active/paused/contextBlocked/nextTickAt、合法转换、可见快照和真实订阅。 |
| 变更 | `src/proactive/useProactive.ts`，符号 `export class ProactiveTickScheduler` | 实现可取消 unref idle timer、最新 gate 重查、submit/queue 分支及 React external-store hook。 |
| 变更 | `src/commands/proactive.ts`，符号 `async function call(onDone: LocalJSXCommandOnDone` | 新增 /proactive on/off/pause/resume/status 与无参数切换，仅操作控制状态。 |
| 变更 | `src/screens/REPL.tsx`，符号 `useProactive?.({` | 把 proactive hook 移到外部 feature 路径，并连接 meta tick、队列和既有 idle gates。 |
| 变更 | `src/tools/SleepTool/SleepTool.ts`，符号 `isEnabled: () => isProactiveActive()` | 让既有 Sleep 等待工具仅随 proactive active 状态开放。 |
| 变更 | `src/coordinator/workerAgent.ts`，符号 `const WORKER_AGENT: BuiltInAgentDefinition` | 注册唯一后台内置 worker，给出非递归工具集合、完整任务上下文提示和验证报告要求。 |
| 变更 | `src/constants/asyncAgentTools.ts`，符号 `export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([` | 以轻量模块承载异步 agent 工具名集合，避免加载完整工具 registry。 |
| 变更 | `src/constants/tools.ts`，符号 `export { ASYNC_AGENT_ALLOWED_TOOLS } from './asyncAgentTools.js'` | 移除重型定义并从原路径 re-export，保持现有消费者兼容。 |
| 变更 | `src/tools/FileReadTool/constants.ts`，符号 `export const FILE_READ_TOOL_NAME = 'Read'` | 为 Read 工具名提供无文件处理实现依赖的轻量来源。 |
| 变更 | `src/tools/FileReadTool/prompt.ts`，符号 `export { FILE_READ_TOOL_NAME } from './constants.js'` | 保留 Read 名称旧导入路径，提示语义不变。 |
| 变更 | `src/tools/FileWriteTool/constants.ts`，符号 `export const FILE_WRITE_TOOL_NAME = 'Write'` | 为 Write 工具名提供轻量常量模块。 |
| 变更 | `src/tools/FileWriteTool/prompt.ts`，符号 `export { FILE_WRITE_TOOL_NAME } from './constants.js'` | 从旧 prompt 路径 re-export Write 名称，维持兼容。 |
| 变更 | `src/tools/SyntheticOutputTool/constants.ts`，符号 `export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'` | 以真实 StructuredOutput 名称提供轻量排除依据。 |
| 变更 | `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts`，符号 `export { SYNTHETIC_OUTPUT_TOOL_NAME } from './constants.js'` | 保留 StructuredOutput 名称原路径导出，工具实现不变。 |
| 变更 | `scripts/build.ts`，符号 `'COORDINATOR_MODE',` | 在外部 CLI/SDK 构建中启用 PROACTIVE 与 COORDINATOR_MODE。 |
| 变更 | `tests/proactiveCoordinator.test.ts`，符号 `registers one real asynchronous worker with non-recursive tools` | 新增四个离线测试，覆盖状态、timer、抑制条件和 worker 定义。 |
| 变更 | `tests/fixtures/feature-check.ts`，符号 `export { getCoordinatorAgents } from '../../src/coordinator/workerAgent.ts'` | 向独立 bundle fixture 导出真实 worker 与 proactive 控制入口。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `const sleepTool = tools.find` | 编译同两个特性并采集 Sleep 动态启停、worker 和 proactive 命令画像。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `expect(profile.workerHasAgent).toBe(false)` | 固定 31 个非空工具及 Sleep/proactive/worker/command 的 bundle 断言。 |
| 变更 | `docs/STATUS.md`，符号 `Proactive and Sleep` | 记录 77/329、31 工具以及 offline scheduler/build 与 definition/build 的有限验证范围。 |
| 变更 | `docs/RELEASE.md`，符号 `## Proactive state and Coordinator workers` | 记录实现、离线验证及真实 proactive/multi-worker 独立 live validation 边界。 |
| 复用 | `src/tools/AgentTool/builtInAgents.ts`，符号 `workerAgent` | 复用 coordinator 编译/env 门控下的内置 worker lazy loading 和列表替换。 |
| 复用 | `src/coordinator/coordinatorMode.ts`，符号 `CLAUDE_CODE_COORDINATOR_MODE` | 复用 coordinator session mode、系统提示和 worker 工具上下文，不新增运行时开关。 |
| 复用 | `src/tools/AgentTool/agentToolUtils.ts`，符号 `ASYNC_AGENT_ALLOWED_TOOLS` | 复用 async allowlist、disallowed tools 与后台 agent 生命周期约束。 |
| 复用 | `src/constants/prompts.ts`，符号 `getProactiveSection` | 复用各 query 的 getSystemPrompt，按当前 isProactiveActive 选择完整 proactive system prompt；启动与命令入口只激活同一状态。 |
| 复用 | `src/main.tsx`，符号 `maybeActivateProactive` | 复用启动参数/env 激活，以及 headless 在 getTools 前激活、使 Sleep 通过 isEnabled 过滤的路径；proactive system prompt 由各 query 的 getSystemPrompt 按 active 状态生成。 |
| 复用 | `src/cli/print.ts`，符号 `set_proactive` | 复用 headless 控制消息和 queue idle 时的 meta tick fallback。 |
| 复用 | `src/commands/clear/conversation.ts`，符号 `setContextBlocked` | 复用 /clear 后解除 context blocking 的既有生命周期。 |
| 复用 | `src/tools.ts`，符号 `getAllBaseTools` | 复用 PROACTIVE/KAIROS 下 Sleep 条件加载和最终 isEnabled 过滤。 |

## 关键决策与工程取舍

- 采用模块级显式状态和订阅，而不是把控制位分散在 React 局部状态；命令、Sleep、scheduler、headless 入口和底部倒计时可以读取同一控制面，但状态生命周期仅限当前进程。
- timer 触发时重新读取最新 gate，而不是只相信创建 timer 时的闭包；这覆盖等待期间变为 loading 的情况，并选择排队而非并行提交第二个 query。
- active 与 paused/contextBlocked 分离，使 status 能表达“已启用但暂不 tick”，同时保留 Sleep 只随 active 变化的简单工具可见性语义。
- worker 通过声明式 BuiltInAgentDefinition 接入现有异步 AgentTool，而非新增 coordinator 执行器；非递归主要由实际工具集合保证，提示词只作行为补充。
- 工具名常量和异步 allowlist 采用移动加 re-export，而非让轻量模块 import 重型 prompt/registry；依赖减轻同时不破坏旧导入路径。
- 外部 REPL 由编译 feature 决定 proactive hook 是否运行，不再复用 task watcher 的内部用户条件；运行时仍需显式激活，编译不是自动启动。

### 备选方案与回溯分析

- 回溯性比较：可以用递归 setTimeout 在每次 tick 后无条件续排，代码较短却难以响应暂停、错误和用户队列；实际 scheduler 每次 sync 先取消，并在触发时重查最新状态。
- 回溯性比较：可以让 /proactive 直接调用模型或自行维护 query，但会绕过 REPL 的队列、取消和权限上下文；实际命令只转换状态，tick 进入既有 meta prompt 管道。
- 回溯性比较：可以给 worker 开放 Agent 以便继续分派子任务，但这会破坏非递归 worker 角色并增加编排复杂度；实际从数据层移除 Agent/SendMessage 等能力。
- 回溯性比较：可以复制工具名字符串避免依赖调整，却容易与真实 registry 漂移；实际集中轻量 constants 并保留 re-export，让 worker 和工具实现共享同一名称来源。
- 回溯性比较：可以把真实多 worker 在线测试与本提交捆绑，但需要授权模型及更大会话范围；实际只声明离线定义/scheduler/build 证据，明确留下独立 live validation。

## 安全与协议边界

- proactive 默认 inactive，需要命令、启动参数/env 或控制消息激活；编译 PROACTIVE 本身不创建模型调用。
- 激活后 meta tick 可能引发模型探索及真实工具副作用，成本与自主修改风险由 loading/queue/UI/plan gate、Esc 暂停、用户恢复和 API-error blocking 缓解。
- worker 的 Bash、Write、Edit、Web 和 Worktree 能力继续走既有工具池、权限与 query guard，系统提示不能替代授权。
- timer.unref 避免仅因 proactive timer 阻止进程退出；timer 清理与 nextTickAt 同步，减少隐藏后台活动。
- 画像使用占位 API key 和离线状态切换，没有模型网络请求；worker 测试只检查定义，不启动真实异步 agent。

## 验收标准

- activate/deactivate/pause/resume/contextBlocked 仅在合法状态转换时返回 true、更新状态并通知订阅者，到期时间在暂停和阻塞时清除。
- /proactive 支持 on/off/pause/resume/status 及无参数切换，status 能区分 paused 与 contextBlocked。
- idle 时仅排一个 unref timer，tick 形如 <tick>time</tick>；繁忙、队列、UI、plan、暂停和阻塞条件不提交，触发时 loading 改走队列。
- 外部 PROACTIVE/KAIROS 路径能执行 REPL hook，meta tick 复用 handleIncomingPrompt/enqueue，Sleep 在 inactive 时禁用、active 时启用。
- getCoordinatorAgents 返回唯一内置后台 worker，包含 Bash/Read，不包含 Agent/SendMessage/StructuredOutput，且提示禁止继续 spawn。
- 旧工具名和 ASYNC_AGENT_ALLOWED_TOOLS 导入路径仍有效，真实 bundle 含 PROACTIVE/COORDINATOR_MODE、31 个非空工具及 /proactive。
- 文档只把 proactive 标为 offline scheduler/build、worker 标为 definition/build，真实模型 perpetual 与 multi-worker orchestration 保持未运行。

## 实现状态与剩余范围

- 状态：**implemented**
- 真实模型驱动的持续 tick/Sleep、多 worker 选择/并行/通知/汇总和工具权限行为仍需授权环境验证。
- headless scheduler 没有与 REPL 相同的 contextBlocked 检查，不能把交互式错误抑制结论扩展到 headless。
- 新增 worker 单测负向检查写成 SyntheticOutput，而真实排除名是 StructuredOutput；实现正确不等于该断言覆盖有效。
- /proactive 各参数、React hook 渲染、timer 等待期间 loading 的 queue 分支及 API error/compact/clear 端到端生命周期未直接测试。
- 控制状态不持久化；/proactive 与启动参数/env 都只激活同一进程内状态，后续 query 均据当前状态生成 proactive system prompt；该动态提示链未由新增测试直接覆盖。
- 未修改的 ARCHITECTURE 文档仍把外部 features 描述为空，与本次构建和 STATUS 不一致。
