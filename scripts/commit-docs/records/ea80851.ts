import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'ea8085139c013577cad3130c35a21fc53a3d8bee',
  title: 'Implement declarative workflow execution',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父提交中的 WorkflowTool 以宽松的未知字段记录作为输入，但 isEnabled 固定为 false，调用只会抛出不可用错误；getWorkflowCommands 永远返回空数组，LocalWorkflowTask 也没有启动执行、保存步骤状态或恢复控制的能力。/workflows 与 WorkflowDetailDialog 已留有外部形态，却缺少从定义到 agent、任务状态和构建特性的完整数据链。因此问题不是给一个空工具补充提示词，而是要建立可校验、可发现、可调度、可控制且可观察的声明式执行组件。',
  problem:
    '需要让用户用 JSON 描述有依赖关系的多步骤 agent 工作流，并把定义安全地变成项目命令或 Workflow 工具调用。方案必须在执行前排除结构错误和循环依赖，在运行时限制 DAG 并发、传递输入及上游输出、明确失败与控制语义，同时复用现有 agent 的工具权限而不是另开特权通道；执行结果还要进入既有任务框架、输出文件、通知和详情界面。真实模型 agent 的在线效果不属于本提交已经取得的证据。',
  goals: [
    '建立严格的 workflow/step 数据契约，对重复步骤、未知或自依赖以及依赖环给出确定性校验错误。',
    '统一发现内置、用户和项目定义，以明确的同名覆盖优先级生成可排序、可查询的工作流集合。',
    '以有界并发执行 DAG，支持输入与步骤输出插值、依赖失败传播、continueOnError、skip、retry 和 kill。',
    '通过现有 runAgent、工具集合和 canUseTool 回调运行步骤，接入执行器 skip/kill 的 AbortSignal、权限询问与转录目录语义。',
    '把每次执行接入本地任务状态、按新建项请求 0700/0600 模式的输出文件、任务通知以及 skip/retry/kill 详情操作。',
    '注册 Workflow 工具、动态工作流命令和 /workflows，并在外部构建特性档中启用及核对 WORKFLOW_SCRIPTS。',
  ],
  nonGoals: [
    '不设计新的 agent 协议、模型调用循环或工具授权体系，步骤仍由现有 agent runner 执行。',
    '不实现进程重启后的运行中工作流恢复；输出文件是结果记录，不是可恢复调度检查点。',
    '不提供循环、条件表达式或任意模板求值，插值仅限工作流输入和已完成步骤的输出。',
    '不在该提交中宣称真实模型驱动的端到端工作流已经运行，也不把离线 fake runner 当成在线验证。',
    '不随框架预置具体内置业务流程；内置注册表提供扩展点，但在该 revision 没有注册定义。',
  ],
  architecture: [
    '定义层以 z.strictObject 固定 JSON 外形：workflow 必须含合法名称、非空描述和至少一个步骤，步骤 ID 与名称都使用小写连字符格式；dependsOn 默认空数组，continueOnError 默认 false，concurrency 默认 2 且限制为整数 1 至 8。parseWorkflowDefinition 在 Zod 结构校验后建立 ID 集合，依次拒绝重复 ID、未知依赖和自依赖，再用 visiting/visited 两个集合做深度优先遍历，遇到回边即报告依赖环。这让 discovery、runner 和 executor 共享同一份已经规范化的 WorkflowDefinition。',
    '发现层把 getBundledWorkflows、用户配置目录 workflows 和 cwd/.claude/workflows 三种来源折叠为 DiscoveredWorkflow。目录只读取排序后的 .json 文件，目录 readdir 的任何错误均静默视为空；单文件读取、JSON 或语义校验失败会记录 debug 并略过。合并顺序是内置、用户、项目，后写入 Map 的同名定义完整覆盖先前定义，最后按名称排序；findWorkflowDefinition 与命令生成都经过这一入口，避免工具与 CLI 各自解释路径和优先级。',
    '执行核心 WorkflowExecution 将工作流状态表示为 running/completed/failed/killed，将每个步骤表示为 pending/running/completed/failed/skipped，并分别维护 results、每步 AbortController、完成 Promise 和唤醒回调。调度循环先传播依赖阻塞，再从依赖已满足的 pending 步骤中取 concurrency 减去当前运行数的空位启动；完成、失败或控制操作通过 notify 推送状态快照并唤醒循环。controllers.size 是正常 launch/settle 路径的调度计数和中止后等待收口依据，因此已测试的常规调度不会被尚未启动的 ready 步骤突破；skip 后在旧 runner 尚未收口时立即 retry 存在 controller 替换、旧 finally 误删和迟到结果竞态，不能视为所有控制交错下的严格运行计数。',
    '步骤启动时用 buildStepPrompt 根据当时的 input 与 results 渲染提示：{{input}} 替换为原始输入，{{steps.<id>.output}} 只替换已有结果，未知或尚未产生的引用保留原文。runner 成功后同时写入 results 和步骤 output；依赖通常要求 completed，只有当前下游步骤设置 continueOnError 时才允许把 failed 依赖视为可继续。依赖 skipped，或依赖 failed 且未选择继续，会把下游标为 skipped 并写入固定原因。在未被 kill 的正常收口路径中，只要任一步骤 failed，工作流整体就是 failed，即使某些下游已被允许继续；kill 则优先保持 killed 终态。propagateSkips 单次按声明顺序扫描且 changed 未驱动立即重扫，反向声明的多级依赖仍可能留下 pending 并等待，不能把逐层传播视为所有声明顺序下的已完成保证。',
    '控制面直接操作同一状态机。skip 可跳过尚未 completed 的步骤并中止其控制器；失败或被跳过的下游由传播逻辑继续处理。retry 只在工作流仍 running 且目标为 failed/skipped 时把目标重置为 pending，并递归唤醒那些因固定依赖失败原因而 skipped 的下游，不重置独立失败或已经成功的工作。kill 先把整体置为 killed、把 pending 置为 skipped，再中止所有运行中 runner；迟到完成或异常不会覆盖 killed，loop 等待控制器退出后完成 done。重复 kill 或非法状态控制返回 false。',
    'runner 适配层动态加载 runAgent、getTools 和 GENERAL_PURPOSE_AGENT，按 step.agentType 从 context.options.agentDefinitions.allAgents 选择定义，找不到时使用通用 agent。它把执行器的 AbortSignal 转发给子 AbortController，但没有显式链入原 ToolUseContext.abortController，父调用取消传播未覆盖；随后以 createUserMessage 构造提示，传入原 ToolUseContext、canUseTool 和按权限上下文取得的工具集，并开启权限提示；异步消息流中收集 assistant 文本，最后一段文本作为步骤输出。transcriptSubdir 使用 workflows/<taskId>，finally 移除 abort 监听，避免跨步骤泄漏。',
    '任务适配层 startWorkflowTask 先通过 createTaskStateBase、generateTaskId 和 registerTask 建立 local_workflow，再把执行快照映射到 AppState 的 agents、summary 与 error。活动实例保存在 taskId 到 WorkflowExecution 的 Map 中，供 killWorkflowTask、skipWorkflowAgent、retryWorkflowAgent 查找，完成后删除。done 收口时把完整执行状态以缩进 JSON 写入既有 outputFile，mkdir/writeFile 分别传入 0700/0600 作为新建项模式，但不会 chmod 既有目录或文件；持久化异常会把最终任务改为 failed。随后设置 endTime/notified，并用 TASK_NOTIFICATION_TAG 携带任务、工具调用、可用输出路径、状态和 XML 转义摘要，以 later 优先级排队通知。',
    '外部入口共享上述组件：WorkflowTool 以严格输入 {workflow,input?,wait?} 查找定义并启动任务，默认立即返回 task_id，wait=true 时等待最终状态；动态 local-jsx 命令把命令参数作为 input 并要求交互权限上下文，/workflows 只负责列出名称、来源、描述和步骤数。WorkflowPermissionRequest 保留启动审查的 FallbackPermissionRequest 外形，而真正的工具授权在步骤内完成。WorkflowDetailDialog 展示各步状态、错误和至多 500 字符输出，以 x/s/r 调用 kill、跳过下一个未完成步骤、重试首个失败或跳过步骤。构建加入 WORKFLOW_SCRIPTS，特性档测试核对 Workflow、workflows 和 35 个非空工具。',
  ],
  decisions: [
    '把结构校验和图校验集中在 parseWorkflowDefinition，而不是让 executor 在运行中补错；代价是所有来源都必须经过同一严格契约，换来发现、工具与命令的一致行为。',
    '同名定义采用项目覆盖用户、用户覆盖内置的整份替换，不合并 steps 或 defaults；这样来源优先级可预测，也避免跨目录拼接出另一张依赖图。',
    '调度器使用显式状态、AbortController 和单次 wake 等待，而非为整张图递归创建 Promise 链；由此可以在执行中重试、跳过并限制并发，但必须谨慎维护通知和控制器清理。',
    'continueOnError 只放宽下游启动条件，不把整体失败改写成成功；这允许收集可选分支结果，同时确保调用者仍能看到至少一个步骤失败。',
    '活动控制句柄只保存在内存 Map，结果则写入既有任务输出路径；该分离简化了生命周期，也明确排除了重启后继续 skip/retry/kill 的能力。',
    'Workflow 工具本身允许启动，不复制一套工具白名单；每个 agent 仍接收原 canUseTool 和权限上下文，权限责任落在实际工具调用处。',
    '后台任务作为默认调用方式，wait=true 作为同步观察选项；动态命令在具备交互式 canUseTool 上下文时后台启动并返回任务 ID，缺少该上下文时拒绝启动并返回说明，不提供 wait 选项。',
  ],
  alternatives: [
    '回溯性比较：可以为工作流另写模型循环和权限规则，但会与既有 agent 行为分叉；实际实现复用 runAgent/getTools/canUseTool，承担动态导入和上下文耦合，换取权限、转录及消息格式一致。',
    '回溯性比较：可以采用可编程 DSL 或通用表达式模板来获得更强编排能力；实际选择 JSON、Zod 和两种插值引用，牺牲表达力以减少注入面、解析复杂度和校验不确定性。',
    '回溯性比较：可以串行执行整张 DAG 或一次性并行所有 ready 节点；实际采用默认 2、最大 8 的空位调度，在吞吐与本地 agent/工具资源压力之间提供显式上限。',
    '回溯性比较：可以把每次运行全部持久化为可恢复检查点；实际只持久化结果并在内存保存控制句柄，避免引入恢复协议，但进程退出后不能继续操作旧执行。',
  ],
  security: [
    '工作流文件只按 JSON 数据解析，不从定义路径导入代码；严格对象拒绝未声明字段，名称和步骤 ID 也受字符格式约束。',
    'WorkflowTool 的启动 allow 不等于工具调用放行；runWorkflowStep 将原 canUseTool、权限派生工具集和权限提示能力传给每个 agent。',
    'agentType 只在已提供的 agentDefinitions 中查找，未知值回退 GENERAL_PURPOSE_AGENT，不被当作模块路径或动态代码来源。',
    '任务输出复用框架生成的 outputFile 路径，mkdir/writeFile 分别传入 0700/0600 作为新建项模式；既有路径权限不会被主动修正。通知摘要经过 escapeXml，避免工作流名称破坏通知标记结构。',
    '无效定义不会进入执行集合，但错误仅进入 debug 日志；真实模型、外部工具副作用和在线权限交互仍需授权环境单独验收。',
  ],
  acceptance: [
    '任何来源的定义都必须先通过严格字段、非空步骤、唯一 ID、完整依赖、无自依赖和无环校验，并发值被规范为 1 至 8。',
    '同一工作流名称同时存在时，项目定义优先于用户定义，用户定义优先于内置注册；查询、列表、工具和动态命令看到同一结果。',
    '正常 launch/settle 路径中独立步骤可并行且调度计数不超过 concurrency，所有依赖完成后下游才启动，提示能获得输入及已完成的依赖输出；skip→立即 retry 的旧 runner 竞态不计作已保证范围。',
    '失败会阻止未声明 continueOnError 的下游并传播跳过；声明继续的分支可执行，未 kill 时整体仍报告 failed。反向声明的多级跳过传播缺陷和 killed 终态例外必须单独保留。',
    'skip 会中止目标并传播，retry 能恢复目标及被依赖失败牵连的下游，kill 会中止活动 runner、跳过 pending 且最终返回 killed。',
    '任务详情持续反映步骤快照；结束后输出 JSON 可读，持久化失败会反映为任务失败，通知包含状态及成功写入时的输出位置。',
    'Workflow 工具、按定义生成的命令、/workflows 和详情控制共用同一任务执行链，外部特性构建包含 Workflow 与 workflows。',
    '离线测试与记录的命令证据只证明上述实现和 fake runner 行为，不被解释为真实模型工作流已经通过。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '该 revision 的 parseWorkflowDefinition 同时使用严格 Zod schema、ID/依赖检查和 DFS 环检测，buildStepPrompt 只实现 input 与步骤输出两类替换。',
      source: {
        path: 'src/tools/WorkflowTool/schema.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'parseWorkflowDefinition',
        note: '定义契约与图校验的直接实现证据。',
      },
    },
    {
      kind: 'diff-observed',
      statement: 'WorkflowExecution 的 controllers、wake、dependenciesReady、propagateSkips、skip/retry/kill 与最终状态计算共同形成有界 DAG 状态机。',
      source: {
        path: 'src/tools/WorkflowTool/executor.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'class WorkflowExecution',
        note: '调度和控制语义的直接实现证据。',
      },
    },
    {
      kind: 'test-added',
      statement: '新增 workflow 测试覆盖 schema/插值、并发与依赖、失败传播、重试、跳过、终止、项目发现和真实 AppState 中的输出持久化；步骤 runner 是受控 fake，不是模型在线测试。',
      source: {
        path: 'tests/workflow.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: "describe('WorkflowExecution'",
        note: '新增的离线工作流回归套件；此项只声明测试被加入。',
      },
    },
    {
      kind: 'test-added',
      statement: '特性档回归把工具总数更新为 35，并新增 Workflow 工具、workflows 命令与 WORKFLOW_SCRIPTS 构建断言。',
      source: {
        path: 'tests/enabledFeatures.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: 'expect(profile.toolCount',
        note: '新增的外部构建注册断言；测试存在不单独代表执行通过。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: '提交内 STATUS 记录 bun test 已执行并通过 100 个测试、424 个断言；这是历史记录中的全量离线结果，不是本次文档编写重新运行所得。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '`bun test`',
        note: 'at-commit Verified evidence 表记录 100 tests、424 assertions。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: '提交内 STATUS 记录 bun run typecheck 零错误，bun run build 完成 CLI、SDK 与声明构建。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '`bun run typecheck`',
        note: 'at-commit 类型检查和构建命令结果。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: '提交内 RELEASE 的 Declarative workflows 段记录测试、类型检查、构建、声明及 35 工具特性档通过，同时明确步骤 runner 为确定性 fake。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '## Declarative workflows',
        note: '工作流发布段的验证范围与 fake runner 限定。',
      },
    },
    {
      kind: 'not-recorded',
      statement: '该提交没有真实模型 agent 工作流的执行证据；STATUS 标注 real model agents not run，RELEASE 进一步明确 real model-agent workflows remain live validation。',
    },
  ],
  remaining: [
    '真实模型驱动的多步骤工作流、实际工具权限提示和模型输出质量仍需在授权环境单独验证，本记录不引用或推断后续 live 结果。',
    '活动执行控制不跨进程恢复；持久化 JSON 可用于查看结果，但不能在重启后重新附着 WorkflowExecution。',
    '无效 JSON 定义被略过且只写 debug，目录 readdir 的任何错误则静默视为空；列表不会把损坏文件作为显式错误展示，内置注册表在该 revision 仍为空。',
    'propagateSkips 单次按声明顺序扫描且 changed 未驱动立即重扫；反向声明的多级依赖可能在 controllers=0 且仍有 pending 步骤时等待，现有测试未覆盖该顺序。',
    'skip 后在旧 runner 尚未收口时立即 retry 存在 controller 替换、旧 finally 误删和迟到结果竞态；现有测试分别覆盖 skip 与 retry，不覆盖该交错。',
    'runWorkflowStep 已接入执行器 skip/kill 的 AbortSignal，但原 ToolUseContext.abortController 未显式链入，父调用取消传播仍未覆盖。',
  ],
  references: [
    {
      path: 'src/tools/WorkflowTool/schema.ts',
      role: 'changed',
      symbol: 'parseWorkflowDefinition',
      note: '定义严格 JSON/Zod 契约、默认值、步骤唯一性、依赖完整性和 DFS 无环不变量，并提供受限提示插值。',
    },
    {
      path: 'src/tools/WorkflowTool/discovery.ts',
      role: 'changed',
      symbol: 'listWorkflowDefinitions',
      note: '统一读取内置、用户和项目来源，以 Map 合并同名覆盖、排序输出，并隔离无效文件。',
    },
    {
      path: 'src/tools/WorkflowTool/executor.ts',
      role: 'changed',
      symbol: 'WorkflowExecution',
      note: '承载 DAG 状态、并发空位调度、失败/跳过传播、重试恢复、终止和所有步骤结果。',
    },
    {
      path: 'src/tools/WorkflowTool/runner.ts',
      role: 'changed',
      symbol: 'runWorkflowStep',
      note: '把单步执行适配到现有 agent 流，连接 agent 选择、工具权限、取消信号、转录和最终文本提取。',
    },
    {
      path: 'src/tools/WorkflowTool/bundled/index.ts',
      role: 'changed',
      symbol: 'registerBundledWorkflow',
      note: '提供经过同一 schema 校验的内置定义注册表和幂等初始化扩展点，不预置业务流程。',
    },
    {
      path: 'src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts',
      role: 'changed',
      symbol: 'startWorkflowTask',
      note: '连接执行器与 AppState 任务、活动控制索引、新建输出项的 0700/0600 请求模式、持久化失败和任务通知，并导出 kill/skip/retry 控制函数。',
    },
    {
      path: 'src/tools/WorkflowTool/WorkflowTool.ts',
      role: 'changed',
      symbol: 'WorkflowTool',
      note: '把禁用 stub 改为严格输入的可调用工具，提供后台 task_id 与 wait 最终状态两种返回路径。',
    },
    {
      path: 'src/tools/WorkflowTool/WorkflowPermissionRequest.ts',
      role: 'changed',
      symbol: 'WorkflowPermissionRequest',
      note: '保留启动审查的通用权限组件，并用注释明确步骤工具权限独立执行，避免把启动审查误作步骤授权。',
    },
    {
      path: 'src/tools/WorkflowTool/createWorkflowCommand.ts',
      role: 'changed',
      symbol: 'getWorkflowCommands',
      note: '将发现结果转成 local-jsx 工作流命令，把参数作为 input，并在缺少交互 canUseTool 时拒绝启动。',
    },
    {
      path: 'src/commands/workflows/index.ts',
      role: 'changed',
      symbol: 'workflows',
      note: '实现可供非交互调用的定义列表入口，显示名称、来源、描述和步骤数量以及空目录提示。',
    },
    {
      path: 'src/components/tasks/WorkflowDetailDialog.tsx',
      role: 'changed',
      symbol: 'WorkflowDetailDialog',
      note: '将任务快照转换为步骤状态/错误/输出视图，并把键盘操作映射为 kill、skip、retry 回调。',
    },
    {
      path: 'scripts/build.ts',
      role: 'changed',
      symbol: 'WORKFLOW_SCRIPTS',
      note: '在外部构建的 Bun feature 列表中启用工作流实现，使注册代码不再被编译为禁用边界。',
    },
    {
      path: 'tests/workflow.test.ts',
      role: 'changed',
      symbol: "describe('workflow schema'",
      note: '以可控 deferred/fake runner 和临时目录验证图语义、控制操作、项目发现及任务输出。',
    },
    {
      path: 'tests/enabledFeatures.test.ts',
      role: 'changed',
      symbol: 'hasWorkflowsCommand',
      note: '把外部特性档的验收数量固定为 35 个非空工具，并检查 Workflow 与 workflows 注册。',
    },
    {
      path: 'tests/fixtures/verify-enabled-features.ts',
      role: 'changed',
      symbol: 'WORKFLOW_SCRIPTS',
      note: '让独立特性构建夹具启用同一标志并导出 hasWorkflowsCommand，供组合测试读取真实构建结果。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: 'Workflow definitions and execution',
      note: '记录离线 runner/task 验证范围、100/424 全量结果和真实模型 agent 未运行的边界。',
    },
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## Declarative workflows',
      note: '记录该组件的发布契约、验证命令范围及确定性 fake runner 限定，不提供在线模型证据。',
    },
    {
      path: 'src/tools/AgentTool/runAgent.ts',
      role: 'reused',
      symbol: 'runAgent',
      note: '复用既有 agent 异步消息循环，而非在工作流中重新实现模型与工具编排。',
    },
    {
      path: 'src/Task.ts',
      role: 'reused',
      symbol: 'createTaskStateBase',
      note: '复用任务 ID 之外的公共状态、outputFile 与任务类型基础结构。',
    },
    {
      path: 'src/utils/task/framework.ts',
      role: 'reused',
      symbol: 'registerTask',
      note: '复用 AppState 任务注册及增量更新接口，保持其他任务界面的观察方式。',
    },
    {
      path: 'src/utils/messageQueueManager.ts',
      role: 'reused',
      symbol: 'enqueuePendingNotification',
      note: '复用既有通知队列和优先级，不为工作流建立旁路消息通道。',
    },
  ],
  plan: {
    preconditions: [
      '确认父提交的 WorkflowTool、动态命令和 LocalWorkflowTask 均为禁用或空实现，详情 UI 所需任务类型已经存在。',
      '确认现有 runAgent 接受 ToolUseContext、CanUseToolFn、可用工具、AbortController 与 transcriptSubdir，能够承载单步执行。',
      '确认任务框架提供 outputFile、AppState 更新和通知队列，JSON 定义只需数据解析而不需要新的可执行配置格式。',
      '把真实模型在线验证与离线 schema/调度/任务回归分开规划，避免将 runner 注入测试误标为端到端模型证据。',
    ],
    reuse: [
      '复用 zod/v4 的 strictObject 和类型推导，让所有定义来源共享解析及默认值逻辑。',
      '复用 getClaudeConfigHomeDir 定位用户 workflows，并以 cwd/.claude/workflows 定位项目定义。',
      '复用 runAgent、GENERAL_PURPOSE_AGENT、getTools、createUserMessage 和原 canUseTool，保留 agent 权限与消息行为。',
      '复用 createTaskStateBase、registerTask/updateTaskState、enqueuePendingNotification 和 escapeXml 完成任务生命周期。',
      '复用现有 local-jsx 命令、FallbackPermissionRequest、Dialog 与构建 feature 档，不添加平行 UI 或注册框架。',
    ],
    steps: [
      {
        title: '建立严格定义与图校验契约',
        detail:
          '先在 schema.ts 定义 WorkflowStep/WorkflowDefinition 及严格 Zod schema，落实名称格式、非空步骤、默认依赖/失败策略和 1 至 8 并发。随后实现 parseWorkflowDefinition 的 ID 集合、依赖存在性、自依赖和 DFS 环检查，最后实现 buildStepPrompt，让后续执行器只消费已校验定义并获得确定插值行为。',
        paths: ['src/tools/WorkflowTool/schema.ts'],
      },
      {
        title: '实现内置注册与分层发现',
        detail:
          '在 bundled/index.ts 建立经过 parseWorkflowDefinition 的注册表及幂等初始化，再让 discovery.ts 依次合并内置、用户和项目定义。目录读取只接受排序 JSON，readdir 错误静默视为空，单文件读取、JSON 或语义失败进入 debug 并略过；list/find 两个查询入口统一来源、覆盖和排序语义，为工具与命令提供相同输入。',
        paths: [
          'src/tools/WorkflowTool/bundled/index.ts',
          'src/tools/WorkflowTool/discovery.ts',
        ],
      },
      {
        title: '构建 DAG 执行状态机',
        detail:
          '基于已解析步骤初始化 agents/results/done，在 executor.ts 实现快照通知、wake 调度、依赖就绪和并发空位计算。接入 runner Promise 的成功/失败收口后，再实现 propagateSkips、continueOnError、skip、retry 的下游递归恢复和 kill 的中止等待；kill 防止迟到结果覆盖 killed，但反向声明传播与 skip→立即 retry 的旧 runner 竞态仍需单独修复。',
        paths: ['src/tools/WorkflowTool/executor.ts'],
      },
      {
        title: '接入 agent runner 与权限边界',
        detail:
          '实现 runWorkflowStep，把步骤 prompt 包装为用户消息，选择已注册 agent 或通用回退，链接执行器 skip/kill 的 AbortSignal，并把 context、canUseTool、getTools 和转录子目录传入 runAgent；从 assistant 流提取最后文本。原 ToolUseContext.abortController 未显式链入，父调用取消传播仍是缺口。WorkflowPermissionRequest 保留启动审查外观并注明步骤权限独立，避免上层工具替代实际工具授权。',
        paths: [
          'src/tools/WorkflowTool/runner.ts',
          'src/tools/WorkflowTool/WorkflowPermissionRequest.ts',
        ],
      },
      {
        title: '连接任务持久化与执行控制',
        detail:
          '在 LocalWorkflowTask.ts 创建并注册任务，将执行快照持续映射到 AppState，同时维护 taskId 到活动执行的控制索引。注入生产 runner 时传入 workflows/<taskId> 转录目录；完成时以 0700/0600 作为新建目录和 JSON 输出的请求模式，处理持久化失败、结束时间、通知与索引清理。WorkflowTool.ts 随后以发现和任务 API 提供 wait/后台两种调用方式；kill/skip/retry 控制函数由 LocalWorkflowTask.ts 暴露，供任务详情 UI 调用。',
        paths: [
          'src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts',
          'src/tools/WorkflowTool/WorkflowTool.ts',
        ],
      },
      {
        title: '注册命令、详情界面和构建特性',
        detail:
          '让 createWorkflowCommand.ts 把已发现定义转为后台任务命令，workflows/index.ts 提供列表，WorkflowDetailDialog.tsx 将任务状态与 x/s/r 控制回调连接。最后在 build.ts 开启 WORKFLOW_SCRIPTS，确保源代码中已接通的工具、命令和任务实现进入同一外部特性构建，而不是停留在禁用 stub。',
        paths: [
          'src/tools/WorkflowTool/createWorkflowCommand.ts',
          'src/commands/workflows/index.ts',
          'src/components/tasks/WorkflowDetailDialog.tsx',
          'scripts/build.ts',
        ],
      },
      {
        title: '补齐离线回归、特性档与证据',
        detail:
          '在 workflow.test.ts 用 deferred fake runner 验证并发时序、依赖、失败、控制和持久化，用临时项目目录验证发现；在特性夹具开启 WORKFLOW_SCRIPTS 并输出命令注册信息，在组合测试固定 35 个非空工具及 Workflow/workflows。最后把实际记录的全量命令结果与真实模型未运行边界写入 STATUS/RELEASE，区分测试新增和命令通过。',
        paths: [
          'tests/workflow.test.ts',
          'tests/fixtures/verify-enabled-features.ts',
          'tests/enabledFeatures.test.ts',
          'docs/STATUS.md',
          'docs/RELEASE.md',
        ],
      },
    ],
    compatibility: [
      '保留 Workflow 工具名称和 LocalWorkflowTask 类型，在原禁用位置启用实现，不要求调用方迁移到新入口。',
      '动态命令复用定义名称，项目覆盖只影响同名定义选择；/workflows 能显示最终来源以解释选择结果。',
      '默认 wait=false 保持长任务的后台使用方式，需要同步结果的调用者可显式选择 wait=true。',
      '结果写入既有任务 outputFile 和通知协议，UI 继续消费 TaskStateBase，不引入第二套任务存储。',
    ],
    risks: [
      '并发 Promise、人工 skip/kill 与迟到完成可能互相覆盖；通过运行状态检查、controllers 清理、统一 notify 和 killed 防写回降低竞态。',
      '重试若清理过多下游会重复成功副作用；实现只递归重置带固定依赖跳过原因的步骤，不重置 completed 或独立 failed 步骤。',
      '插值若执行任意表达式会形成代码注入面；实现只识别两个只读数据引用，未知引用原样保留。',
      '输出或通知失败可能掩盖原执行结果；持久化异常显式转为 failed，输出标签仅在实际写成功后加入。',
      'fake runner 无法覆盖模型流、真实权限提示和工具副作用；这些被保留为授权环境验证，而非由构建成功推断。',
    ],
    verification: [
      '先运行 schema 定向测试，检查严格字段、重复 ID、未知依赖、自依赖/环和两种插值。',
      '再以可控 Promise 验证 DAG 并发上限、依赖等待、continueOnError、失败传播和最终结果。',
      '分别执行 retry、skip、kill 回归，观察下游恢复、AbortSignal、幂等控制及 killed 终态。',
      '运行项目发现与 AppState 任务测试，读取实际 outputFile，确认步骤结果和任务状态一致。',
      '构建独立特性夹具，核对 WORKFLOW_SCRIPTS、35 个非空工具、Workflow 工具和 workflows 命令。',
      '依据提交内记录引用 bun test 的 100/424、typecheck、build/declarations 结果，不把本记录的静态校验写成历史测试。',
      '真实模型 agent 工作流只在具备授权模型与工具环境时另行执行，并作为有来源的后续证据记录。',
    ],
    completed: [
      '严格定义解析、图校验和受限插值已经集中到 schema。',
      '内置/用户/项目发现及同名覆盖、动态命令查询已经统一。',
      '正常 launch/settle 路径的有界 DAG 调度、失败/跳过传播、重试恢复和 kill 已经有实现与离线测试；反向声明传播和 skip→retry 交错缺陷保留在 incomplete，不能据此宣称核心控制语义全部完成。',
      '现有 agent runner、canUseTool、工具集合、取消及转录路径已经接入。',
      '任务状态、输出持久化、通知和活动控制索引已经形成闭环。',
      'Workflow 工具、/workflows、动态命令、详情操作及 WORKFLOW_SCRIPTS 构建已经注册。',
      '离线工作流与特性档测试已加入，提交文档记录了 100/424 测试及类型检查/构建结果。',
    ],
    incomplete: [
      '核心 DAG 仍有反向声明时多级 skip 传播悬挂，以及 skip 后立即 retry 的旧 runner/迟到结果竞态；这些直接影响本提交要提供的调度和控制功能，因此状态为 partial，而不是将其视作无关的未来增强。',
      '真实模型 agent 的多步执行和实际权限交互未在该提交验证。',
      '运行中工作流没有跨重启恢复或重新附着控制句柄的机制。',
      '内置注册表尚无具体定义，损坏的用户/项目文件也只在 debug 中可见。',
    ],
  },
})
