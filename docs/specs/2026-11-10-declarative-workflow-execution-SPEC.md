---
commit: ea8085139c013577cad3130c35a21fc53a3d8bee
title: "Implement declarative workflow execution"
date: 2026-11-10T20:30:36+08:00
status: partial
kind: component
---

# Implement declarative workflow execution

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交中的 WorkflowTool 以宽松的未知字段记录作为输入，但 isEnabled 固定为 false，调用只会抛出不可用错误；getWorkflowCommands 永远返回空数组，LocalWorkflowTask 也没有启动执行、保存步骤状态或恢复控制的能力。/workflows 与 WorkflowDetailDialog 已留有外部形态，却缺少从定义到 agent、任务状态和构建特性的完整数据链。因此问题不是给一个空工具补充提示词，而是要建立可校验、可发现、可调度、可控制且可观察的声明式执行组件。

需要让用户用 JSON 描述有依赖关系的多步骤 agent 工作流，并把定义安全地变成项目命令或 Workflow 工具调用。方案必须在执行前排除结构错误和循环依赖，在运行时限制 DAG 并发、传递输入及上游输出、明确失败与控制语义，同时复用现有 agent 的工具权限而不是另开特权通道；执行结果还要进入既有任务框架、输出文件、通知和详情界面。真实模型 agent 的在线效果不属于本提交已经取得的证据。

## 目标与非目标

### 目标

- 建立严格的 workflow/step 数据契约，对重复步骤、未知或自依赖以及依赖环给出确定性校验错误。
- 统一发现内置、用户和项目定义，以明确的同名覆盖优先级生成可排序、可查询的工作流集合。
- 以有界并发执行 DAG，支持输入与步骤输出插值、依赖失败传播、continueOnError、skip、retry 和 kill。
- 通过现有 runAgent、工具集合和 canUseTool 回调运行步骤，接入执行器 skip/kill 的 AbortSignal、权限询问与转录目录语义。
- 把每次执行接入本地任务状态、按新建项请求 0700/0600 模式的输出文件、任务通知以及 skip/retry/kill 详情操作。
- 注册 Workflow 工具、动态工作流命令和 /workflows，并在外部构建特性档中启用及核对 WORKFLOW_SCRIPTS。

### 非目标

- 不设计新的 agent 协议、模型调用循环或工具授权体系，步骤仍由现有 agent runner 执行。
- 不实现进程重启后的运行中工作流恢复；输出文件是结果记录，不是可恢复调度检查点。
- 不提供循环、条件表达式或任意模板求值，插值仅限工作流输入和已完成步骤的输出。
- 不在该提交中宣称真实模型驱动的端到端工作流已经运行，也不把离线 fake runner 当成在线验证。
- 不随框架预置具体内置业务流程；内置注册表提供扩展点，但在该 revision 没有注册定义。

## 方案架构与数据流

定义层以 z.strictObject 固定 JSON 外形：workflow 必须含合法名称、非空描述和至少一个步骤，步骤 ID 与名称都使用小写连字符格式；dependsOn 默认空数组，continueOnError 默认 false，concurrency 默认 2 且限制为整数 1 至 8。parseWorkflowDefinition 在 Zod 结构校验后建立 ID 集合，依次拒绝重复 ID、未知依赖和自依赖，再用 visiting/visited 两个集合做深度优先遍历，遇到回边即报告依赖环。这让 discovery、runner 和 executor 共享同一份已经规范化的 WorkflowDefinition。

发现层把 getBundledWorkflows、用户配置目录 workflows 和 cwd/.claude/workflows 三种来源折叠为 DiscoveredWorkflow。目录只读取排序后的 .json 文件，目录 readdir 的任何错误均静默视为空；单文件读取、JSON 或语义校验失败会记录 debug 并略过。合并顺序是内置、用户、项目，后写入 Map 的同名定义完整覆盖先前定义，最后按名称排序；findWorkflowDefinition 与命令生成都经过这一入口，避免工具与 CLI 各自解释路径和优先级。

执行核心 WorkflowExecution 将工作流状态表示为 running/completed/failed/killed，将每个步骤表示为 pending/running/completed/failed/skipped，并分别维护 results、每步 AbortController、完成 Promise 和唤醒回调。调度循环先传播依赖阻塞，再从依赖已满足的 pending 步骤中取 concurrency 减去当前运行数的空位启动；完成、失败或控制操作通过 notify 推送状态快照并唤醒循环。controllers.size 是正常 launch/settle 路径的调度计数和中止后等待收口依据，因此已测试的常规调度不会被尚未启动的 ready 步骤突破；skip 后在旧 runner 尚未收口时立即 retry 存在 controller 替换、旧 finally 误删和迟到结果竞态，不能视为所有控制交错下的严格运行计数。

步骤启动时用 buildStepPrompt 根据当时的 input 与 results 渲染提示：{{input}} 替换为原始输入，{{steps.<id>.output}} 只替换已有结果，未知或尚未产生的引用保留原文。runner 成功后同时写入 results 和步骤 output；依赖通常要求 completed，只有当前下游步骤设置 continueOnError 时才允许把 failed 依赖视为可继续。依赖 skipped，或依赖 failed 且未选择继续，会把下游标为 skipped 并写入固定原因。在未被 kill 的正常收口路径中，只要任一步骤 failed，工作流整体就是 failed，即使某些下游已被允许继续；kill 则优先保持 killed 终态。propagateSkips 单次按声明顺序扫描且 changed 未驱动立即重扫，反向声明的多级依赖仍可能留下 pending 并等待，不能把逐层传播视为所有声明顺序下的已完成保证。

控制面直接操作同一状态机。skip 可跳过尚未 completed 的步骤并中止其控制器；失败或被跳过的下游由传播逻辑继续处理。retry 只在工作流仍 running 且目标为 failed/skipped 时把目标重置为 pending，并递归唤醒那些因固定依赖失败原因而 skipped 的下游，不重置独立失败或已经成功的工作。kill 先把整体置为 killed、把 pending 置为 skipped，再中止所有运行中 runner；迟到完成或异常不会覆盖 killed，loop 等待控制器退出后完成 done。重复 kill 或非法状态控制返回 false。

runner 适配层动态加载 runAgent、getTools 和 GENERAL_PURPOSE_AGENT，按 step.agentType 从 context.options.agentDefinitions.allAgents 选择定义，找不到时使用通用 agent。它把执行器的 AbortSignal 转发给子 AbortController，但没有显式链入原 ToolUseContext.abortController，父调用取消传播未覆盖；随后以 createUserMessage 构造提示，传入原 ToolUseContext、canUseTool 和按权限上下文取得的工具集，并开启权限提示；异步消息流中收集 assistant 文本，最后一段文本作为步骤输出。transcriptSubdir 使用 workflows/<taskId>，finally 移除 abort 监听，避免跨步骤泄漏。

任务适配层 startWorkflowTask 先通过 createTaskStateBase、generateTaskId 和 registerTask 建立 local_workflow，再把执行快照映射到 AppState 的 agents、summary 与 error。活动实例保存在 taskId 到 WorkflowExecution 的 Map 中，供 killWorkflowTask、skipWorkflowAgent、retryWorkflowAgent 查找，完成后删除。done 收口时把完整执行状态以缩进 JSON 写入既有 outputFile，mkdir/writeFile 分别传入 0700/0600 作为新建项模式，但不会 chmod 既有目录或文件；持久化异常会把最终任务改为 failed。随后设置 endTime/notified，并用 TASK_NOTIFICATION_TAG 携带任务、工具调用、可用输出路径、状态和 XML 转义摘要，以 later 优先级排队通知。

外部入口共享上述组件：WorkflowTool 以严格输入 {workflow,input?,wait?} 查找定义并启动任务，默认立即返回 task_id，wait=true 时等待最终状态；动态 local-jsx 命令把命令参数作为 input 并要求交互权限上下文，/workflows 只负责列出名称、来源、描述和步骤数。WorkflowPermissionRequest 保留启动审查的 FallbackPermissionRequest 外形，而真正的工具授权在步骤内完成。WorkflowDetailDialog 展示各步状态、错误和至多 500 字符输出，以 x/s/r 调用 kill、跳过下一个未完成步骤、重试首个失败或跳过步骤。构建加入 WORKFLOW_SCRIPTS，特性档测试核对 Workflow、workflows 和 35 个非空工具。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/tools/WorkflowTool/schema.ts`，符号 `parseWorkflowDefinition` | 定义严格 JSON/Zod 契约、默认值、步骤唯一性、依赖完整性和 DFS 无环不变量，并提供受限提示插值。 |
| 变更 | `src/tools/WorkflowTool/discovery.ts`，符号 `listWorkflowDefinitions` | 统一读取内置、用户和项目来源，以 Map 合并同名覆盖、排序输出，并隔离无效文件。 |
| 变更 | `src/tools/WorkflowTool/executor.ts`，符号 `WorkflowExecution` | 承载 DAG 状态、并发空位调度、失败/跳过传播、重试恢复、终止和所有步骤结果。 |
| 变更 | `src/tools/WorkflowTool/runner.ts`，符号 `runWorkflowStep` | 把单步执行适配到现有 agent 流，连接 agent 选择、工具权限、取消信号、转录和最终文本提取。 |
| 变更 | `src/tools/WorkflowTool/bundled/index.ts`，符号 `registerBundledWorkflow` | 提供经过同一 schema 校验的内置定义注册表和幂等初始化扩展点，不预置业务流程。 |
| 变更 | `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`，符号 `startWorkflowTask` | 连接执行器与 AppState 任务、活动控制索引、新建输出项的 0700/0600 请求模式、持久化失败和任务通知，并导出 kill/skip/retry 控制函数。 |
| 变更 | `src/tools/WorkflowTool/WorkflowTool.ts`，符号 `WorkflowTool` | 把禁用 stub 改为严格输入的可调用工具，提供后台 task_id 与 wait 最终状态两种返回路径。 |
| 变更 | `src/tools/WorkflowTool/WorkflowPermissionRequest.ts`，符号 `WorkflowPermissionRequest` | 保留启动审查的通用权限组件，并用注释明确步骤工具权限独立执行，避免把启动审查误作步骤授权。 |
| 变更 | `src/tools/WorkflowTool/createWorkflowCommand.ts`，符号 `getWorkflowCommands` | 将发现结果转成 local-jsx 工作流命令，把参数作为 input，并在缺少交互 canUseTool 时拒绝启动。 |
| 变更 | `src/commands/workflows/index.ts`，符号 `workflows` | 实现可供非交互调用的定义列表入口，显示名称、来源、描述和步骤数量以及空目录提示。 |
| 变更 | `src/components/tasks/WorkflowDetailDialog.tsx`，符号 `WorkflowDetailDialog` | 将任务快照转换为步骤状态/错误/输出视图，并把键盘操作映射为 kill、skip、retry 回调。 |
| 变更 | `scripts/build.ts`，符号 `WORKFLOW_SCRIPTS` | 在外部构建的 Bun feature 列表中启用工作流实现，使注册代码不再被编译为禁用边界。 |
| 变更 | `tests/workflow.test.ts`，符号 `describe('workflow schema'` | 以可控 deferred/fake runner 和临时目录验证图语义、控制操作、项目发现及任务输出。 |
| 变更 | `tests/enabledFeatures.test.ts`，符号 `hasWorkflowsCommand` | 把外部特性档的验收数量固定为 35 个非空工具，并检查 Workflow 与 workflows 注册。 |
| 变更 | `tests/fixtures/verify-enabled-features.ts`，符号 `WORKFLOW_SCRIPTS` | 让独立特性构建夹具启用同一标志并导出 hasWorkflowsCommand，供组合测试读取真实构建结果。 |
| 变更 | `docs/STATUS.md`，符号 `Workflow definitions and execution` | 记录离线 runner/task 验证范围、100/424 全量结果和真实模型 agent 未运行的边界。 |
| 变更 | `docs/RELEASE.md`，符号 `## Declarative workflows` | 记录该组件的发布契约、验证命令范围及确定性 fake runner 限定，不提供在线模型证据。 |
| 复用 | `src/tools/AgentTool/runAgent.ts`，符号 `runAgent` | 复用既有 agent 异步消息循环，而非在工作流中重新实现模型与工具编排。 |
| 复用 | `src/Task.ts`，符号 `createTaskStateBase` | 复用任务 ID 之外的公共状态、outputFile 与任务类型基础结构。 |
| 复用 | `src/utils/task/framework.ts`，符号 `registerTask` | 复用 AppState 任务注册及增量更新接口，保持其他任务界面的观察方式。 |
| 复用 | `src/utils/messageQueueManager.ts`，符号 `enqueuePendingNotification` | 复用既有通知队列和优先级，不为工作流建立旁路消息通道。 |

## 关键决策与工程取舍

- 把结构校验和图校验集中在 parseWorkflowDefinition，而不是让 executor 在运行中补错；代价是所有来源都必须经过同一严格契约，换来发现、工具与命令的一致行为。
- 同名定义采用项目覆盖用户、用户覆盖内置的整份替换，不合并 steps 或 defaults；这样来源优先级可预测，也避免跨目录拼接出另一张依赖图。
- 调度器使用显式状态、AbortController 和单次 wake 等待，而非为整张图递归创建 Promise 链；由此可以在执行中重试、跳过并限制并发，但必须谨慎维护通知和控制器清理。
- continueOnError 只放宽下游启动条件，不把整体失败改写成成功；这允许收集可选分支结果，同时确保调用者仍能看到至少一个步骤失败。
- 活动控制句柄只保存在内存 Map，结果则写入既有任务输出路径；该分离简化了生命周期，也明确排除了重启后继续 skip/retry/kill 的能力。
- Workflow 工具本身允许启动，不复制一套工具白名单；每个 agent 仍接收原 canUseTool 和权限上下文，权限责任落在实际工具调用处。
- 后台任务作为默认调用方式，wait=true 作为同步观察选项；动态命令在具备交互式 canUseTool 上下文时后台启动并返回任务 ID，缺少该上下文时拒绝启动并返回说明，不提供 wait 选项。

### 备选方案与回溯分析

- 回溯性比较：可以为工作流另写模型循环和权限规则，但会与既有 agent 行为分叉；实际实现复用 runAgent/getTools/canUseTool，承担动态导入和上下文耦合，换取权限、转录及消息格式一致。
- 回溯性比较：可以采用可编程 DSL 或通用表达式模板来获得更强编排能力；实际选择 JSON、Zod 和两种插值引用，牺牲表达力以减少注入面、解析复杂度和校验不确定性。
- 回溯性比较：可以串行执行整张 DAG 或一次性并行所有 ready 节点；实际采用默认 2、最大 8 的空位调度，在吞吐与本地 agent/工具资源压力之间提供显式上限。
- 回溯性比较：可以把每次运行全部持久化为可恢复检查点；实际只持久化结果并在内存保存控制句柄，避免引入恢复协议，但进程退出后不能继续操作旧执行。

## 安全与协议边界

- 工作流文件只按 JSON 数据解析，不从定义路径导入代码；严格对象拒绝未声明字段，名称和步骤 ID 也受字符格式约束。
- WorkflowTool 的启动 allow 不等于工具调用放行；runWorkflowStep 将原 canUseTool、权限派生工具集和权限提示能力传给每个 agent。
- agentType 只在已提供的 agentDefinitions 中查找，未知值回退 GENERAL_PURPOSE_AGENT，不被当作模块路径或动态代码来源。
- 任务输出复用框架生成的 outputFile 路径，mkdir/writeFile 分别传入 0700/0600 作为新建项模式；既有路径权限不会被主动修正。通知摘要经过 escapeXml，避免工作流名称破坏通知标记结构。
- 无效定义不会进入执行集合，但错误仅进入 debug 日志；真实模型、外部工具副作用和在线权限交互仍需授权环境单独验收。

## 验收标准

- 任何来源的定义都必须先通过严格字段、非空步骤、唯一 ID、完整依赖、无自依赖和无环校验，并发值被规范为 1 至 8。
- 同一工作流名称同时存在时，项目定义优先于用户定义，用户定义优先于内置注册；查询、列表、工具和动态命令看到同一结果。
- 正常 launch/settle 路径中独立步骤可并行且调度计数不超过 concurrency，所有依赖完成后下游才启动，提示能获得输入及已完成的依赖输出；skip→立即 retry 的旧 runner 竞态不计作已保证范围。
- 失败会阻止未声明 continueOnError 的下游并传播跳过；声明继续的分支可执行，未 kill 时整体仍报告 failed。反向声明的多级跳过传播缺陷和 killed 终态例外必须单独保留。
- skip 会中止目标并传播，retry 能恢复目标及被依赖失败牵连的下游，kill 会中止活动 runner、跳过 pending 且最终返回 killed。
- 任务详情持续反映步骤快照；结束后输出 JSON 可读，持久化失败会反映为任务失败，通知包含状态及成功写入时的输出位置。
- Workflow 工具、按定义生成的命令、/workflows 和详情控制共用同一任务执行链，外部特性构建包含 Workflow 与 workflows。
- 离线测试与记录的命令证据只证明上述实现和 fake runner 行为；tests/workflow.test.ts、tests/enabledFeatures.test.ts 覆盖各组件行为。

## 实现状态与剩余范围

- 状态：**partial**
- 真实模型驱动的多步骤工作流、实际工具权限提示和模型输出质量仍需在授权环境单独验证，本记录不引用或推断后续 live 结果。
- 活动执行控制不跨进程恢复；持久化 JSON 可用于查看结果，但不能在重启后重新附着 WorkflowExecution。
- 无效 JSON 定义被略过且只写 debug，目录 readdir 的任何错误则静默视为空；列表不会把损坏文件作为显式错误展示，内置注册表在该 revision 仍为空。
- propagateSkips 单次按声明顺序扫描且 changed 未驱动立即重扫；反向声明的多级依赖可能在 controllers=0 且仍有 pending 步骤时等待，现有测试未覆盖该顺序。
- skip 后在旧 runner 尚未收口时立即 retry 存在 controller 替换、旧 finally 误删和迟到结果竞态；现有测试分别覆盖 skip 与 retry，不覆盖该交错。
- runWorkflowStep 已接入执行器 skip/kill 的 AbortSignal，但原 ToolUseContext.abortController 未显式链入，父调用取消传播仍未覆盖。
