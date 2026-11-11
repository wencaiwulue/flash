---
commit: ea8085139c013577cad3130c35a21fc53a3d8bee
title: "Implement declarative workflow execution"
date: 2026-11-10T20:30:36+08:00
status: partial
kind: component
---

# 实施计划：Implement declarative workflow execution

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让用户用 JSON 描述有依赖关系的多步骤 agent 工作流，并把定义安全地变成项目命令或 Workflow 工具调用。方案必须在执行前排除结构错误和循环依赖，在运行时限制 DAG 并发、传递输入及上游输出、明确失败与控制语义，同时复用现有 agent 的工具权限而不是另开特权通道；执行结果还要进入既有任务框架、输出文件、通知和详情界面。真实模型 agent 的在线效果不属于本提交已经取得的证据。

- 确认父提交的 WorkflowTool、动态命令和 LocalWorkflowTask 均为禁用或空实现，详情 UI 所需任务类型已经存在。
- 确认现有 runAgent 接受 ToolUseContext、CanUseToolFn、可用工具、AbortController 与 transcriptSubdir，能够承载单步执行。
- 确认任务框架提供 outputFile、AppState 更新和通知队列，JSON 定义只需数据解析而不需要新的可执行配置格式。
- 把真实模型在线验证与离线 schema/调度/任务回归分开规划，避免将 runner 注入测试误标为端到端模型证据。

## 复用与兼容处理

### 复用现有实现

- 复用 zod/v4 的 strictObject 和类型推导，让所有定义来源共享解析及默认值逻辑。
- 复用 getClaudeConfigHomeDir 定位用户 workflows，并以 cwd/.claude/workflows 定位项目定义。
- 复用 runAgent、GENERAL_PURPOSE_AGENT、getTools、createUserMessage 和原 canUseTool，保留 agent 权限与消息行为。
- 复用 createTaskStateBase、registerTask/updateTaskState、enqueuePendingNotification 和 escapeXml 完成任务生命周期。
- 复用现有 local-jsx 命令、FallbackPermissionRequest、Dialog 与构建 feature 档，不添加平行 UI 或注册框架。

### 兼容、迁移与生命周期

- 保留 Workflow 工具名称和 LocalWorkflowTask 类型，在原禁用位置启用实现，不要求调用方迁移到新入口。
- 动态命令复用定义名称，项目覆盖只影响同名定义选择；/workflows 能显示最终来源以解释选择结果。
- 默认 wait=false 保持长任务的后台使用方式，需要同步结果的调用者可显式选择 wait=true。
- 结果写入既有任务 outputFile 和通知协议，UI 继续消费 TaskStateBase，不引入第二套任务存储。

## 文件级实施步骤

### 1. 建立严格定义与图校验契约

先在 schema.ts 定义 WorkflowStep/WorkflowDefinition 及严格 Zod schema，落实名称格式、非空步骤、默认依赖/失败策略和 1 至 8 并发。随后实现 parseWorkflowDefinition 的 ID 集合、依赖存在性、自依赖和 DFS 环检查，最后实现 buildStepPrompt，让后续执行器只消费已校验定义并获得确定插值行为。

涉及位置：`src/tools/WorkflowTool/schema.ts`

### 2. 实现内置注册与分层发现

在 bundled/index.ts 建立经过 parseWorkflowDefinition 的注册表及幂等初始化，再让 discovery.ts 依次合并内置、用户和项目定义。目录读取只接受排序 JSON，readdir 错误静默视为空，单文件读取、JSON 或语义失败进入 debug 并略过；list/find 两个查询入口统一来源、覆盖和排序语义，为工具与命令提供相同输入。

涉及位置：`src/tools/WorkflowTool/bundled/index.ts`、`src/tools/WorkflowTool/discovery.ts`

### 3. 构建 DAG 执行状态机

基于已解析步骤初始化 agents/results/done，在 executor.ts 实现快照通知、wake 调度、依赖就绪和并发空位计算。接入 runner Promise 的成功/失败收口后，再实现 propagateSkips、continueOnError、skip、retry 的下游递归恢复和 kill 的中止等待；kill 防止迟到结果覆盖 killed，但反向声明传播与 skip→立即 retry 的旧 runner 竞态仍需单独修复。

涉及位置：`src/tools/WorkflowTool/executor.ts`

### 4. 接入 agent runner 与权限边界

实现 runWorkflowStep，把步骤 prompt 包装为用户消息，选择已注册 agent 或通用回退，链接执行器 skip/kill 的 AbortSignal，并把 context、canUseTool、getTools 和转录子目录传入 runAgent；从 assistant 流提取最后文本。原 ToolUseContext.abortController 未显式链入，父调用取消传播仍是缺口。WorkflowPermissionRequest 保留启动审查外观并注明步骤权限独立，避免上层工具替代实际工具授权。

涉及位置：`src/tools/WorkflowTool/runner.ts`、`src/tools/WorkflowTool/WorkflowPermissionRequest.ts`

### 5. 连接任务持久化与执行控制

在 LocalWorkflowTask.ts 创建并注册任务，将执行快照持续映射到 AppState，同时维护 taskId 到活动执行的控制索引。注入生产 runner 时传入 workflows/<taskId> 转录目录；完成时以 0700/0600 作为新建目录和 JSON 输出的请求模式，处理持久化失败、结束时间、通知与索引清理。WorkflowTool.ts 随后以发现和任务 API 提供 wait/后台两种调用方式；kill/skip/retry 控制函数由 LocalWorkflowTask.ts 暴露，供任务详情 UI 调用。

涉及位置：`src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`、`src/tools/WorkflowTool/WorkflowTool.ts`

### 6. 注册命令、详情界面和构建特性

让 createWorkflowCommand.ts 把已发现定义转为后台任务命令，workflows/index.ts 提供列表，WorkflowDetailDialog.tsx 将任务状态与 x/s/r 控制回调连接。最后在 build.ts 开启 WORKFLOW_SCRIPTS，确保源代码中已接通的工具、命令和任务实现进入同一外部特性构建，而不是停留在禁用 stub。

涉及位置：`src/tools/WorkflowTool/createWorkflowCommand.ts`、`src/commands/workflows/index.ts`、`src/components/tasks/WorkflowDetailDialog.tsx`、`scripts/build.ts`

### 7. 补齐离线回归、特性档与证据

在 workflow.test.ts 用 deferred fake runner 验证并发时序、依赖、失败、控制和持久化，用临时项目目录验证发现；在特性夹具开启 WORKFLOW_SCRIPTS 并输出命令注册信息，在组合测试固定 35 个非空工具及 Workflow/workflows。最后把实际记录的全量命令结果与真实模型未运行边界写入 STATUS/RELEASE，区分测试新增和执行结果。

涉及位置：`tests/workflow.test.ts`、`tests/fixtures/verify-enabled-features.ts`、`tests/enabledFeatures.test.ts`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 并发 Promise、人工 skip/kill 与迟到完成可能互相覆盖；通过运行状态检查、controllers 清理、统一 notify 和 killed 防写回降低竞态。
- 重试若清理过多下游会重复成功副作用；实现只递归重置带固定依赖跳过原因的步骤，不重置 completed 或独立 failed 步骤。
- 插值若执行任意表达式会形成代码注入面；实现只识别两个只读数据引用，未知引用原样保留。
- 输出或通知失败可能掩盖原执行结果；持久化异常显式转为 failed，输出标签仅在实际写成功后加入。
- fake runner 无法覆盖模型流、真实权限提示和工具副作用；这些被保留为授权环境验证，而非由构建成功推断。

## 验收顺序

1. 先运行 schema 定向测试，检查严格字段、重复 ID、未知依赖、自依赖/环和两种插值。
2. 再以可控 Promise 验证 DAG 并发上限、依赖等待、continueOnError、失败传播和最终结果。
3. 分别执行 retry、skip、kill 回归，观察下游恢复、AbortSignal、幂等控制及 killed 终态。
4. 运行项目发现与 AppState 任务测试，读取实际 outputFile，确认步骤结果和任务状态一致。
5. 构建独立特性夹具，核对 WORKFLOW_SCRIPTS、35 个非空工具、Workflow 工具和 workflows 命令。
6. 依据提交内记录引用 bun test 的 100/424、typecheck、build/declarations 结果，不把本记录的静态校验写成历史测试。
7. 真实模型 agent 工作流只在具备授权模型与工具环境时另行执行，并作为有来源的后续证据记录。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- 严格定义解析、图校验和受限插值已经集中到 schema。
- 内置/用户/项目发现及同名覆盖、动态命令查询已经统一。
- 正常 launch/settle 路径的有界 DAG 调度、失败/跳过传播、重试恢复和 kill 已经有实现与离线测试；反向声明传播和 skip→retry 交错缺陷保留在 incomplete，不能据此宣称核心控制语义全部完成。
- 现有 agent runner、canUseTool、工具集合、取消及转录路径已经接入。
- 任务状态、输出持久化、通知和活动控制索引已经形成闭环。
- Workflow 工具、/workflows、动态命令、详情操作及 WORKFLOW_SCRIPTS 构建已经注册。
- 离线工作流与特性档测试已加入，提交文档记录了 100/424 测试及类型检查/构建结果。

### 未完成或后续工作

- 核心 DAG 仍有反向声明时多级 skip 传播悬挂，以及 skip 后立即 retry 的旧 runner/迟到结果竞态；这些直接影响本提交要提供的调度和控制功能，因此状态为 partial，而不是将其视作无关的未来增强。
- 真实模型 agent 的多步执行和实际权限交互未在该提交验证。
- 运行中工作流没有跨重启恢复或重新附着控制句柄的机制。
- 内置注册表尚无具体定义，损坏的用户/项目文件也只在 debug 中可见。
