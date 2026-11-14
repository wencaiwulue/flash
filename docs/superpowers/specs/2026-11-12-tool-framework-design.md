---
id: tool-framework
batch: 2
title: Tool Framework 工具契约、组合与执行上下文设计
date: 2026-11-12
status: draft
---

# Tool Framework 工具契约、组合与执行上下文设计

本文是对当前工具框架实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

工具框架负责工具定义、工具池组装、权限检查、执行调度和结果转换。其需要解决的核心问题包括：

- **工具类型契约**：60+ 工具实现必须遵循统一接口，包括输入验证、执行、权限检查、渲染等环节，不能每个工具都有完全不同的签名和行为。
- **工具池组装策略**：内置工具与 MCP 工具需要合并、去重，按特定顺序排列以保持 prompt cache 稳定性；还要根据权限上下文（deny 规则）过滤。
- **多路径工具执行**：有两条执行路径：批量执行（`runTools`）和流式执行（`StreamingToolExecutor`），两者需要产生一致的消息输出和错误处理。
- **执行上下文传递**：工具执行需要访问应用状态、权限系统、进度报告、内存附件等，同时支持子 agent 上下文隔离。
- **权限与错误边界**：工具执行前需要检查权限、验证输入，执行中需要处理异常、报告进度，执行后需要格式化结果并渲染到 UI。
- **消息与结果转换**：工具的内部结果类型需要转换为 Claude API 的 `ToolResultBlockParam`，同时要支持进度消息、附件消息等非标准输出。

约束条件：
- `Tool` 接口不能随意变更，因为有 60+ 工具实现依赖它；`buildTool` 提供默认值来降低实现负担。
- 内置工具优先级高于 MCP 工具（同名时），因为内置工具可能有特殊权限或渲染逻辑。
- 工具执行上下文（`ToolUseContext`）是 mutable 的，但在子 agent 中需要选择性隔离（如 `localDenialTracking`）。
- 进度消息和结果消息的顺序和格式必须与现有 UI 和 transcript 持久化兼容。

## 2. 设计理由与备选方案

### 2.1 Tool 接口与 buildTool 默认值填充

**当前设计**：`Tool` 是一个完整接口，包含 20+ 方法/字段；`ToolDef` 允许省略其中 7 个，由 `buildTool` 填充安全默认值。默认值策略是"fail closed"：
- `isEnabled: () => true`
- `isConcurrencySafe: () => false`
- `isReadOnly: () => false`
- `isDestructive: () => false`
- `checkPermissions: () => ({ behavior: 'allow', updatedInput: input })`
- `toAutoClassifierInput: () => ''`
- `userFacingName: () => def.name`

**证据位置**：`src/Tool.ts` 中 `TOOL_DEFAULTS` 的定义和 `buildTool` 的实现。

**为什么这样设计**：如果让每个工具都实现所有 20+ 方法，新增工具的成本太高，且容易遗漏安全关键方法（如 `isReadOnly`、`checkPermissions`）。通过 `buildTool` 提供默认值，可以让工具定义聚焦于核心逻辑；同时默认值选择"fail closed"（默认非并发安全、默认非只读、默认总是允许）是为了在工具遗漏实现时，不会意外放宽安全限制（比如工具实际写文件但忘记实现 `isReadOnly` 返回 false，默认返回 false 是安全的——默认不认为只读，权限检查会更谨慎）。

**备选方案**：
- 备选 1：完全使用继承（基类+子类）。代价是 TypeScript 中 mixin 组合多个正交特性（如并发安全、权限检查、渲染）比对象字面量组合更笨拙。
- 备选 2：没有默认值，所有方法都是必需的。代价是 60+ 工具都要写大量样板代码，新增工具时容易出错。
- 备选 3：默认值"fail open"（如 `isReadOnly` 默认 true，`checkPermissions` 默认 allow）。代价是工具作者忘记实现时，会意外降低安全性。

**为什么不采用备选**：备选 1 的继承模型在多个工具共享部分但不是全部行为时不如对象组合灵活；备选 2 会显著增加维护和新增工具的成本；备选 3 有安全风险。

### 2.2 工具池组装：先过滤再排序再去重

**当前设计**：`assembleToolPool()` 按以下步骤组装工具池：
1. 调用 `getTools()` 获取经过权限上下文过滤后的内置工具
2. 调用 `filterToolsByDenyRules()` 过滤 MCP 工具
3. 分别对内置工具和 MCP 工具按名称排序
4. 内置工具在前，MCP 工具在后，用 `uniqBy` 按名称去重（内置优先）

**证据位置**：`src/tools.ts` 中 `assembleToolPool()` 的实现。

**为什么这样设计**：
- 内置工具在前，保持 prompt cache 稳定性：服务器的 `claude_code_system_cache_policy` 依赖内置工具在前缀中的稳定位置；如果 MCP 工具混在中间，新增/移除 MCP 工具会导致所有后续内置工具的位置变化，cache 失效。
- 分别排序后合并：确保内置工具之间、MCP 工具之间的相对顺序稳定，只有两部分的拼接边界有变化。
- `uniqBy` 保留先出现的（内置）：内置工具可能有特殊权限或渲染逻辑，优先级高于同名 MCP 工具。

**代价**：MCP 工具如果与内置工具同名，会被静默遮蔽，用户可能困惑为什么 MCP 工具没有出现。

**备选方案**：
- 备选 1：完全混合排序。代价是 prompt cache 不稳定。
- 备选 2：检测到同名时警告/报错。代价是现有代码不兼容，且可能破坏某些 MCP 服务器的设计（它们可能有意覆盖内置工具）。

**为什么不采用备选**：备选 1 会破坏缓存性能；备选 2 会造成向后不兼容，且没有证据表明用户需要这种严格性。

### 2.3 ToolUseContext：既是执行上下文，又是可变状态承载

**当前设计**：`ToolUseContext` 包含：
- 不可变配置部分：`options`（工具、命令、MCP 客户端、agent 定义等）
- 可变状态部分：`abortController`、`readFileState`、`getAppState/setAppState`、`toolDecisions`、`contentReplacementState`、`localDenialTracking`
- 回调部分：`setToolJSX`、`addNotification`、`appendSystemMessage`、`requestPrompt`、`updateAttributionState`

**证据位置**：`src/Tool.ts` 中 `ToolUseContext` 的类型定义。

**为什么这样设计**：
- 分离 `getAppState/setAppState` 与 `setAppStateForTasks`：在子 agent 中，普通的 `setAppState` 可以是 no-op（避免子 agent 污染父状态），但 `setAppStateForTasks` 总是能到达根 store（用于注册后台任务等跨 agent 需要可见的状态）。
- `localDenialTracking` 存在的理由：子 agent 的权限拒绝不应该影响父 agent 的 deny counter，所以子 agent 有自己的本地 tracking，不通过 `setAppState` 共享。
- `toolDecisions` 是 Map：用于缓存权限决策结果，避免对同一 `tool_use_id` 重复询问用户；同时在决策后用于 log event。

**为什么 `ToolUseContext` 不做成 immutable**：工具执行过程中需要修改状态（如 `readFileState` 缓存、`toolDecisions` 缓存、`contentReplacementState` 跟踪），做成 immutable 需要频繁复制，性能开销大。

### 2.4 工具调用链的多层错误边界

**当前设计**：工具执行有多层错误处理：
1. 输入 Zod 验证：`tool.inputSchema.safeParse(input)`
2. 输入业务验证：`tool.validateInput()`（可选）
3. PreToolUse hooks：可以拦截或修改输入
4. 权限检查：`resolveHookPermissionDecision()`
5. 工具执行：`tool.call()` 内部 try/catch
6. PostToolUse hooks / PostToolUseFailure hooks
7. 最外层：`checkPermissionsAndCallTool()` 捕获所有异常，格式化错误

**证据位置**：`src/services/tools/toolExecution.ts` 中 `checkPermissionsAndCallTool()` 的完整流程。

**为什么这样设计**：
- Zod 验证先执行：快速拒绝类型错误的输入，不进入更昂贵的权限/执行路径；同时，对于 deferred 工具（schema 没发给模型），Zod 错误还会附带一个 hint 让模型先调用 ToolSearch 加载工具。
- `validateInput` 在权限前：不需要用户同意就能发现输入错误，减少不必要的权限弹窗。
- hooks 在权限前后都有：PreToolUse 可以修改输入或拦截；PostToolUse 可以修改结果或执行副作用；失败时专门的 PostToolUseFailure 路径处理清理。

**为什么权限检查在 validateInput 之后而不是之前**：如果输入本身无效，先检查权限再报错会让用户经历"同意→发现输入错误→修正→再次同意"的糟糕体验。先验证输入，可以在不打扰用户的情况下尽早失败。

### 2.5 进度消息与结果消息的分离与关联

**当前设计**：
- 进度消息（`ProgressMessage`）与结果消息（`UserMessage` / `ToolResultBlockParam`）是不同类型的消息，分别 yield。
- 进度消息通过 `toolUseId` 与对应的 `tool_use` 关联，也有 `parentToolUseId` 处理嵌套情况（如 AgentTool 内部工具的进度）。
- 进度消息有多种子类型：`bash_progress`、`powershell_progress`、`agent_progress`、`skill_progress`、`mcp_progress` 等。
- 渲染时：`renderToolUseProgressMessage` 接收一组同属一个 `tool_use` 的进度消息，聚合渲染。

**证据位置**：
- `src/Tool.ts` 中 `ToolProgress` 和 `ProgressMessage` 类型
- `src/services/tools/toolExecution.ts` 中 `onToolProgress` 回调和 `createProgressMessage` 的使用

**为什么这样设计**：
- 进度消息单独 yield：可以在工具执行中间更新 UI，不等到最终结果；同时它们不需要持久化到 transcript（只有结果需要）。
- `parentToolUseId` 存在的理由：AgentTool 等透明 wrapper 工具内部调用其他工具时，内部工具的进度需要与外层 wrapper 的 `tool_use_id` 关联，这样 UI 会把内部进度显示为外层工具的进度，而不是显示多个独立的工具调用。

## 3. 目标与非目标

### 3.1 目标

- **定义统一的工具契约**：通过 `Tool` 接口和 `buildTool`，让 60+ 工具实现遵循一致的行为和签名，减少重复代码。
- **支持灵活的工具池组装**：内置工具与 MCP 工具合并、去重、排序，尊重权限上下文的 deny 规则，保持 prompt cache 稳定。
- **提供完整的执行链路**：输入验证 → 权限检查 → 工具执行 → 结果转换 → 错误处理 → 进度报告 → UI 渲染，所有环节有明确的边界和扩展点（hooks）。
- **隔离子 agent 执行上下文**：`ToolUseContext` 支持选择性隔离（如 `localDenialTracking`），让子 agent 不会意外污染父状态。

### 3.2 非目标

- **不替换 MCP 协议**：本框架只是消费 MCP 工具，MCP 协议本身由 `services/mcp/` 子系统负责。
- **不负责 CLI UI 的组件实现**：渲染方法返回 React 节点，但具体的组件设计不属于本框架的范围。
- **不重新实现权限系统**：工具框架调用 `checkPermissions` 和 `canUseTool`，但权限规则由 `utils/permissions/` 子系统负责。

## 4. 架构、模块与数据流

### 4.1 核心类型与职责边界

| 类型 | 职责 | 定义位置 |
|------|------|----------|
| `Tool` | 工具的完整接口 | `src/Tool.ts` |
| `ToolDef` | 工具定义（允许省略默认方法） | `src/Tool.ts` |
| `Tools` | 工具集合 | `src/Tool.ts` |
| `ToolUseContext` | 工具执行上下文 | `src/Tool.ts` |
| `ToolResult` | 工具执行结果 | `src/Tool.ts` |

---

### 4.2 模块设计卡：Tool 接口与 buildTool

#### 真实类型与入口签名

```typescript
// src/Tool.ts
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

type ToolDef<Input extends AnyObject = AnyObject, Output = unknown, P extends ToolProgressData = ToolProgressData> =
  Omit<Tool<Input, Output, P>, DefaultableToolKeys>
  & Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D>
```

#### 输入输出

**输入**：`ToolDef` 对象，可省略默认方法
- 必需：`name`、`inputSchema`、`call()`、`description()`、`prompt()`、`mapToolResultToToolResultBlockParam()`、`renderToolUseMessage()`
- 可选：`isEnabled`、`isConcurrencySafe`、`isReadOnly`、`isDestructive`、`checkPermissions`、`toAutoClassifierInput`、`userFacingName` 等

**输出**：完整的 `Tool` 对象，所有方法都已填充默认值

#### 可变/不可变状态

- **不可变**：`TOOL_DEFAULTS` 常量对象，包含默认函数实现
- **可变**：无，`buildTool` 是纯函数，返回新对象

#### buildTool 默认值表

| 默认方法 | 默认实现 | 安全策略 |
|----------|----------|----------|
| `isEnabled()` | `() => true` | 工具默认启用 |
| `isConcurrencySafe(input)` | `(_input?: unknown) => false` | 默认非并发安全（fail closed） |
| `isReadOnly(input)` | `(_input?: unknown) => false` | 默认非只读（fail closed） |
| `isDestructive(input)` | `(_input?: unknown) => false` | 默认非破坏性 |
| `checkPermissions(input, context)` | `(input, _ctx?) => Promise.resolve({behavior: 'allow', updatedInput: input})` | 默认允许（依赖权限系统） |
| `toAutoClassifierInput(input)` | `(_input?: unknown) => ''` | 默认不参与分类器 |
| `userFacingName(input)` | `() => def.name` | 默认使用工具名 |

**证据位置**：`src/Tool.ts` 第 757-769 行

#### 设计取舍/备选

| 取舍 | 当前选择 | 备选方案 | 理由 |
|------|----------|----------|------|
| 默认值填充方式 | 运行时对象展开 | 类继承 | TypeScript mixin 组合比继承更灵活 |
| 默认值策略 | fail closed | fail open | 遗漏安全关键方法时不会放宽限制 |
| 类型安全 | `BuiltTool<D>` 映射类型 | 强制完整接口 | 保持工具定义简洁同时保证类型安全 |

**备选理由**：备选方案会导致 60+ 工具都要写大量样板代码，新增工具时容易出错；继承模型在多个工具共享部分但不是全部行为时不如对象组合灵活。

**源码证据**：`src/Tool.ts` 第 727-792 行

---

### 4.3 模块设计卡：工具池 assembleToolPool

#### 真实类型与入口签名

```typescript
// src/tools.ts
function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools
): Tools

// src/utils/toolPool.ts
function mergeAndFilterTools(
  initialTools: Tools,
  assembled: Tools,
  mode: ToolPermissionContext['mode']
): Tools

function filterToolsByDenyRules<T extends {name: string, mcpInfo?: {serverName: string, toolName: string}}>(
  tools: readonly T[],
  permissionContext: ToolPermissionContext
): T[]
```

#### 输入输出

**输入**：
- `permissionContext`：权限上下文，包含 allow/deny 规则
- `mcpTools`：MCP 工具列表

**输出**：合并、去重、排序后的工具池

#### 可变/不可变状态

- **不可变**：输入参数不修改
- **可变**：无，所有函数都是纯函数

#### 工具池过滤/排序/去重步骤

```text
步骤 1：获取内置工具
  └─ getTools(permissionContext)
      ├─ 过滤掉被 deny 规则覆盖的工具
      ├─ 根据环境模式（simple/REPL）过滤工具
      └─ 只保留 isEnabled() === true 的工具

步骤 2：过滤 MCP 工具
  └─ filterToolsByDenyRules(mcpTools, permissionContext)
      └─ 移除被 blanket deny 规则覆盖的工具

步骤 3：分别排序
  ├─ 内置工具按名称排序
  └─ MCP 工具按名称排序

步骤 4：合并与去重
  └─ uniqBy([...sortedBuiltIn, ...sortedMCP], 'name')
      └─ 内置优先，同名 MCP 工具被遮蔽
```

**证据位置**：`src/tools.ts` 第 355-376 行

#### mergeAndFilterTools 附加处理

```typescript
// 分区：MCP 与内置工具分离
const [mcp, builtIn] = partition(uniqBy([...initialTools, ...assembled], 'name'), isMcpTool)

// 分别排序保持 prompt-cache 稳定
const tools = [...builtIn.sort(byName), ...mcp.sort(byName)]

// Coordinator 模式过滤（如启用）
if (isCoordinatorMode()) {
  return applyCoordinatorToolFilter(tools)
}
```

**证据位置**：`src/utils/toolPool.ts` 第 55-79 行

#### 设计取舍/备选

| 取舍 | 当前选择 | 备选方案 | 理由 |
|------|----------|----------|------|
| 排序策略 | 分别排序后合并 | 完全混合排序 | 保持 prompt cache 稳定，服务器缓存策略依赖内置工具前缀 |
| 去重策略 | 内置优先，uniqBy 保留先出现 | MCP 优先或警告 | 内置工具可能有特殊权限或渲染逻辑 |
| 过滤时机 | 组装时先过滤 deny 规则 | 调用时才过滤 | 模型只看到可用工具，减少 token 浪费 |

**代价**：MCP 工具如果与内置工具同名，会被静默遮蔽，用户可能困惑为什么 MCP 工具没有出现。

**源码证据**：`src/tools.ts` 第 272-400 行

**测试证据**：`tests/toolPool.test.ts` 验证工具池包含具体工具且名称唯一

---

### 4.4 模块设计卡：ToolUseContext

#### 真实类型与入口签名

```typescript
// src/Tool.ts
type ToolUseContext = {
  // 不可变配置
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
    refreshTools?: () => Tools
  }

  // 可变状态
  abortController: AbortController
  readFileState: FileStateCache
  toolDecisions?: Map<string, {source: string, decision: 'accept'|'reject', timestamp: number}>
  localDenialTracking?: DenialTrackingState
  contentReplacementState?: ContentReplacementState
  renderedSystemPrompt?: SystemPrompt

  // 状态访问与修改
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  setAppStateForTasks?: (f: (prev: AppState) => AppState): void
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>): void
  setHasInterruptibleToolInProgress?: (v: boolean): void
  setResponseLength: (f: (prev: number) => number): void
  updateFileHistoryState: (updater: (prev: FileHistoryState) => FileHistoryState): void
  updateAttributionState: (updater: (prev: AttributionState) => AttributionState): void
  setConversationId?: (id: UUID): void
  setSDKStatus?: (status: SDKStatus): void
  setStreamMode?: (mode: SpinnerMode): void
  onCompactProgress?: (event: CompactProgressEvent): void

  // 回调与扩展
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification): void
  appendSystemMessage?: (msg: Exclude<SystemMessage, SystemLocalCommandMessage>): void
  sendOSNotification?: (opts: {message: string, notificationType: string}): void
  requestPrompt?: (sourceName: string, toolInputSummary?: string|null): (request: PromptRequest) => Promise<PromptResponse>
  handleElicitation?: (serverName: string, params: ElicitRequestURLParams, signal: AbortSignal): Promise<ElicitResult>
  openMessageSelector?: (): void

  // 执行时元数据
  messages: Message[]
  toolUseId?: string
  agentId?: AgentId
  agentType?: string
  requireCanUseTool?: boolean
  userModified?: boolean
  nestedMemoryAttachmentTriggers?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  discoveredSkillNames?: Set<string>
  fileReadingLimits?: {maxTokens?: number, maxSizeBytes?: number}
  globLimits?: {maxResults?: number}
  criticalSystemReminder_EXPERIMENTAL?: string
  preserveToolUseResults?: boolean
}
```

#### 可变/不可变状态

**不可变**：`options` 子对象内的所有配置
**可变**：
- `abortController`：可被信号中断
- `readFileState`：LRU 缓存，读取文件时更新
- `toolDecisions`：Map，缓存权限决策以避免重复询问
- `localDenialTracking`：子 Agent 的本地拒绝计数
- `contentReplacementState`：工具结果预算状态
- 通过 `setAppState()`、`setAppStateForTasks()`、`setInProgressToolUseIDs()` 等函数修改的外部状态

#### contextModifier 顺序与语义

`ToolResult` 可选返回 `contextModifier`：
```typescript
type ToolResult<Output> = {
  data: Output
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  // ...
}
```

**执行时机**：工具成功执行后，在产出 tool_result 消息时应用
**约束**：仅非并发安全工具的 `contextModifier` 会被尊重
**用途**：让工具能修改后续执行的上下文（如 Agent 工具设置子 Agent 隔离状态）

**证据位置**：`src/Tool.ts` 第 330 行、`src/services/tools/toolExecution.ts` 第 1466-1472 行

#### 子 Agent 隔离设计

| 状态/方法 | 父 Agent | 子 Agent | 隔离理由 |
|-----------|---------|---------|----------|
| `setAppState()` | 正常更新根状态 | no-op（不污染父状态） | 子 Agent 不应修改父应用状态 |
| `setAppStateForTasks()` | 同 `setAppState()` | 仍更新根状态 | 后台任务注册需要跨 Agent 可见 |
| `localDenialTracking` | 无或共享 | 独立本地状态 | 子 Agent 的拒绝计数不应影响父 |
| `toolDecisions` | 共享 | 可隔离 | 避免子 Agent 决策污染父 |
| `toolUseId` | 当前调用 | 子调用独立 | 进度与结果正确关联 |
| `agentId` / `agentType` | 无或主类型 | 子 Agent 标识 | 钩子与遥测能区分来源 |

**证据位置**：`src/Tool.ts` 第 192-294 行

#### 设计取舍/备选

| 取舍 | 当前选择 | 备选方案 | 理由 |
|------|----------|----------|------|
| 可变性 | 可变上下文对象 | 不可变状态 + 频繁复制 | 性能开销大，工具执行需要多次更新 |
| 隔离策略 | 选择性隔离（部分 no-op） | 完全独立复制 | 平衡隔离与共享基础设施（后台任务） |
| 状态访问 | `getAppState`/`setAppState` 分离 | 直接状态引用 | 支持子 Agent 隔离时的重写 |

---

### 4.5 模块设计卡：runTools 与 StreamingToolExecutor

#### 真实类型与入口签名

```typescript
// src/services/tools/toolExecution.ts
type MessageUpdateLazy<M extends Message = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifyContext: (context: ToolUseContext) => ToolUseContext
  }
}

async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext
): AsyncGenerator<MessageUpdateLazy, void>

function streamedCheckPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: {[key: string]: boolean | string | number},
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>
): AsyncIterable<MessageUpdateLazy>

async function checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: {[key: string]: boolean | string | number},
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  messageId: string,
  requestId: string | undefined,
  mcpServerType: McpServerType,
  mcpServerBaseUrl: ReturnType<typeof getLoggingSafeMcpBaseUrl>,
  onToolProgress: (progress: ToolProgress<ToolProgressData> | ProgressMessage<HookProgress>) => void
): Promise<MessageUpdateLazy[]>
```

#### 输入输出

**输入**：
- `toolUse`：模型产出的 `ToolUseBlock`
- `assistantMessage`：包含 tool_use 的助理消息
- `canUseTool`：权限检查回调
- `toolUseContext`：执行上下文

**输出**：
- `AsyncGenerator<MessageUpdateLazy>`：产生进度消息、工具结果消息、附件消息等

#### 完整工具执行顺序

```text
阶段 0：工具查找与中断检查
  ├─ findToolByName() 查找工具（当前 tools + 备选 getAllBaseTools()）
  ├─ 检查是否 toolUseContext.abortController.signal.aborted
  └─ 中断 → yield synthetic interrupt result

阶段 1：输入验证（不涉及用户）
  ├─ 1. Zod 输入验证：tool.inputSchema.safeParse(input)
  │   └─ 失败 → yield InputValidationError + schema not sent hint（延迟工具）
  └─ 2. 业务输入验证：tool.validateInput(input, context)（可选）
      └─ 失败 → yield 业务验证错误

阶段 2：预处理与钩子
  ├─ 防御性剥离 _simulatedSedEdit（仅 Bash 工具）
  ├─ backfillObservableInput() 填充遗留/派生字段（浅拷贝）
  └─ 运行 PreToolUse hooks
      ├─ 可产出进度/附件消息
      ├─ 可更新输入（hookUpdatedInput）
      ├─ 可返回权限决策（hookPermissionResult）
      └─ 可阻止继续（preventContinuation + stopReason）

阶段 3：权限检查
  ├─ resolveHookPermissionDecision() 综合判断
  │   ├─ 优先使用 hookPermissionResult（如提供）
  │   ├─ 否则调用 canUseTool() 询问用户或自动判断
  │   └─ 结果存入 toolUseContext.toolDecisions（缓存）
  ├─ 拒绝 → yield 拒绝消息 + 运行 PermissionDenied hooks（可选）
  └─ 允许 → 继续，使用 permissionDecision.updatedInput（如提供）

阶段 4：工具执行
  ├─ 启动工具 span（遥测）
  ├─ 恢复 callInput 为模型原始值（路径展开回写）
  ├─ tool.call() 执行
  │   └─ onProgress() 回调产生进度消息
  └─ 捕获异常 → 进入错误处理分支

阶段 5：成功后处理
  ├─ 运行 PostToolUse hooks
  │   ├─ 可修改 MCP 工具输出（updatedMCPToolOutput）
  │   └─ 可产出附加消息
  ├─ 映射工具结果：tool.mapToolResultToToolResultBlockParam()
  ├─ processToolResultBlock() 处理大结果持久化
  ├─ 添加 acceptFeedback（如用户批准时有）
  ├─ 应用 contextModifier（如工具返回且非并发安全）
  ├─ 添加工具返回的 newMessages（如提供）
  └─ yield 最终 tool_result 消息

阶段 6：错误边界与清理
  ├─ McpAuthError → 更新客户端状态为 'needs-auth'
  ├─ AbortError → 跳过错误日志（用户中断）
  ├─ 其他错误 → 格式化为 tool_result is_error
  ├─ 运行 PostToolUseFailure hooks
  └─ finally 块：
      ├─ stopSessionActivity('tool_exec')
      └─ 清理 toolDecisions 缓存（decisionInfo.delete）
```

**证据位置**：`src/services/tools/toolExecution.ts` 第 337-1745 行

#### 权限与错误边界

**多层错误边界**：

| 边界层 | 错误类型 | 处理位置 |
|--------|----------|----------|
| Zod 验证 | 输入类型错误 | checkPermissionsAndCallTool 开头 |
| 业务验证 | 输入业务逻辑错误 | tool.validateInput() 后 |
| 权限拒绝 | 权限不允许 | resolveHookPermissionDecision 后 |
| 工具执行 | 工具内部异常 | try/catch 包裹 tool.call() |
| Hook 异常 | Pre/Post 钩子错误 | 钩子内部 try/catch + 外层兜底 |
| 最终清理 | 无论成功失败 | finally 块 |

**权限检查时机**：`validateInput` 之后 → 输入错误时不打扰用户

**证据位置**：`src/services/tools/toolExecution.ts` 第 111、614-732、994-1087、1589-1737 行

#### 清理

| 资源 | 清理时机 | 清理方式 |
|------|----------|----------|
| `toolDecisions` 缓存 | finally 块 | `toolDecisions.delete(toolUseID)` |
| 会话活动标记 | finally 块 | `stopSessionActivity('tool_exec')` |
| 权限决策临时状态 | 工具完成后 | 随消息产出释放 |
| 进度消息聚合 | UI 渲染时 | 完成后不持久化 |

**证据位置**：`src/services/tools/toolExecution.ts` 第 1738-1744 行

#### 设计取舍/备选

| 取舍 | 当前选择 | 备选方案 | 理由 |
|------|----------|----------|------|
| 进度与结果流 | 单一流混合产出 | 分离进度与结果通道 | 简化消费，调用方一处接收所有更新 |
| 验证顺序 | Zod → validateInput → 权限 → 执行 | 权限先检查 | 输入错误时不打扰用户 |
| Hook 插入点 | Pre/Post 双点 + PostFailure | 单点扩展 | 覆盖成功/失败双路径 |
| 输入回写 | backfill 不修改 callInput | 直接修改原始输入 | 保持工具结果显示与 transcript 哈希稳定 |

---

### 4.6 模块设计卡：shared/services/tools 子系统

#### 真实类型与入口签名

```typescript
// 工具执行
export { runToolUse, streamedCheckPermissionsAndCallTool, checkPermissionsAndCallTool } from './toolExecution'

// 工具钩子
export { runPreToolUseHooks, runPostToolUseHooks, runPostToolUseFailureHooks, resolveHookPermissionDecision } from './toolHooks'

// MCP 工具集成
export { isMcpTool, getMcpServerScopeFromToolName, getLoggingSafeMcpBaseUrl } from '../mcp/utils'

// 工具查找
export { toolMatchesName, findToolByName } from '../../Tool'
```

#### tool_use 到 tool_result 消息映射

```typescript
// tool.mapToolResultToToolResultBlockParam() 核心责任
mapToolResultToToolResultBlockParam(
  content: Output,
  toolUseID: string
): ToolResultBlockParam

// 后处理：大结果持久化
processToolResultBlock(
  tool: Tool,
  toolUseResult: unknown,
  toolUseID: string
): Promise<ToolResultBlockParam>
  └─ 超过 tool.maxResultSizeChars 时写入磁盘，返回预览
```

**输出消息结构**：
```typescript
{
  type: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: string,
      content: string | ContentBlock[],
      is_error?: boolean
    },
    ...(permissionDecision.acceptFeedback ? [{type: 'text', text: string}] : []),
    ...(permissionDecision.contentBlocks || [])
  ],
  imagePasteIds?: number[], // 对应 contentBlocks 中的图片
  toolUseResult?: unknown, // 子 Agent 可选隐藏
  mcpMeta?: {_meta?: Record<string, unknown>, structuredContent?: Record<string, unknown>},
  sourceToolAssistantUUID: UUID
}
```

**证据位置**：`src/services/tools/toolExecution.ts` 第 1292-1502 行

#### 流式与批量路径等价性和差异

| 方面 | 流式路径 `streamedCheckPermissionsAndCallTool()` | 批量路径 `checkPermissionsAndCallTool()` |
|------|------------------------------------------------|------------------------------------------|
| 返回类型 | `AsyncIterable<MessageUpdateLazy>` | `Promise<MessageUpdateLazy[]>` |
| 进度消息 | 实时 yield | 收集在数组末尾一起返回 |
| 工具结果 | 完成后立即 yield | 收集在数组中 |
| 核心执行逻辑 | 委托给批量路径 | 实际实现 checkPermissionsAndCallTool |
| 消费者 | REPL UI（需要实时更新） | SDK/headless（批量处理） |
| Stream 包装 | 使用 `Stream` 类桥接异步函数与异步生成器 | 无 |

**等价性保证**：两条路径的权限检查、工具执行、结果映射、错误处理逻辑完全相同，都委托给 `checkPermissionsAndCallTool()`。

**证据位置**：`src/services/tools/toolExecution.ts` 第 492-569 行

#### 源码测试证据

| 模块 | 源码位置 | 测试位置 |
|------|----------|----------|
| 工具池组装 | `src/tools.ts` | `tests/toolPool.test.ts` |
| 工具执行 | `src/services/tools/toolExecution.ts` | （间接测试覆盖） |
| 工具定义 | `src/Tool.ts` | （各工具自身测试） |
| 工具池合并 | `src/utils/toolPool.ts` | （与 REPL 集成测试） |

**证据位置**：
- `src/tools.ts` 第 1-400 行
- `src/utils/toolPool.ts` 第 1-80 行
- `tests/toolPool.test.ts` 第 1-37 行

---

### 4.7 完整工具调用链

```text
模型产出 tool_use
  ↓
runToolUse()
  ├─ 查找工具: findToolByName()
  ├─ 检查是否 abort: 是 → yield synthetic interrupt result
  └─ streamedCheckPermissionsAndCallTool()
      └─ checkPermissionsAndCallTool()
          ├─ 1. Zod 输入验证
          ├─ 2. 业务输入验证（可选）
          ├─ 3. PreToolUse hooks
          ├─ 4. 权限检查
          ├─ 5. 工具执行 + onProgress 回调
          ├─ 6. PostToolUse hooks
          ├─ 7. 结果处理 + 持久化（如需要）
          └─ 8. 错误处理（catch 块）+ PostToolUseFailure hooks
```

**证据位置**：`src/services/tools/toolExecution.ts`

### 4.8 工具池组装数据流

```text
路径 A: REPL UI（useMergedTools）
  ├─ assembleToolPool(toolPermissionContext, mcpTools)
  │   ├─ getTools(): 获取过滤后的内置工具
  │   ├─ filterToolsByDenyRules(mcpTools)
  │   ├─ 分别排序内置和 MCP 工具
  │   └─ uniqBy(name): 内置优先
  └─ mergeAndFilterTools(initialTools, assembled, mode)

路径 B: runAgent（headless）
  └─ 直接调用 assembleToolPool()
```

**证据位置**：`src/tools.ts`、`src/utils/toolPool.ts`

## 5. 失败语义与工程取舍

### 5.1 工具不存在/找不到的语义

- 先在 `toolUseContext.options.tools` 中查找
- 若未找到，在 `getAllBaseTools()` 中查找（仅当通过 alias 匹配时使用，支持旧工具名兼容性）
- 若仍未找到：yield `tool_use_error`

### 5.2 性能取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| Zod 验证总是执行 | 是 | 少量 CPU | 防御性编程 |
| toolDecisions 缓存权限决策 | 是 | 少量内存 | 避免重复询问用户 |
| 内置/MCP 分别排序再合并 | 是 | 一次额外排序 | prompt cache 稳定 |

## 6. 现状验收标准

| 验收项 | 设计行为 | 证据位置 |
|--------|----------|----------|
| Tool 接口契约完整性 | 工具必须实现核心方法，其余由 `buildTool` 填充默认值 | `src/Tool.ts` |
| 工具池组装顺序与去重 | 内置工具在前、MCP 在后，同名时内置优先 | `src/tools.ts` |
| 权限检查在 validateInput 之后 | 输入验证先执行，失败时不打扰用户 | `src/services/tools/toolExecution.ts` |
| ToolUseContext 子 agent 隔离设计 | `localDenialTracking`、`setAppState` vs `setAppStateForTasks` 分离 | `src/Tool.ts` |

## 7. 代码与测试证据

### 7.1 核心模块

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/Tool.ts` | ~1000 | 核心类型定义、工具契约、默认值填充 |
| `src/tools.ts` | ~350 | 工具池组装、内置工具列表、过滤逻辑 |
| `src/utils/toolPool.ts` | ~100 | 工具池合并、协调器模式过滤 |
| `src/hooks/useMergedTools.ts` | ~50 | React hook 包装 |
| `src/services/tools/toolExecution.ts` | ~800 | 工具执行核心流程 |
| `src/tools/shared/` | ~150 | 共享工具辅助逻辑 |

**总计**：约 2450 行核心代码（不含具体工具实现）。

### 7.2 现有测试场景

| 测试文件 | 测试场景 |
|----------|----------|
| `tests/toolPool.test.ts` | 工具池包含具体工具且名称唯一 |
| `tests/internalTools.test.ts` | SleepTool、OverflowTestTool、CtxInspectTool、TerminalCaptureTool 验证 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/tool-framework.yaml)

### 8.1 本 spec 主拥有的文件

- `src/Tool.ts`
- `src/tools.ts`
- `src/utils/toolPool.ts`
- `src/hooks/useMergedTools.ts`
- `src/services/tools/toolExecution.ts`
- `src/tools/shared/`

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/services/tools/toolHooks.ts` → hooks spec
- `src/services/mcp/` → mcp spec
- `src/utils/permissions/` → permissions spec

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | 当前 `Tool` 接口有 20+ 方法/字段，部分旧工具可能还在使用旧模式，没有完全迁移到 `buildTool`，且没有显式的版本标识 | 定义 `ToolV1`、`ToolV2` 等显式版本接口，或在 `Tool` 中加入 `version` 字段；为旧工具提供自动化迁移脚本 | 低-中等 —— 可以保持向后兼容 | 增加版本化接口的类型测试，验证旧工具仍可正常工作 | L | 已证实（基于代码阅读） |
| P1 | `docs/STATUS.md` 记录 `src/tools/WebBrowserTool/WebBrowserTool.ts` 丢弃 MCP `result.isError`，成功导航测试不能证明后端错误可见 | 在 WebBrowser 结果适配层保留 `isError` 和结构化错误内容 | 中：需保持成功结果形状，并区分后端错误与本地异常 | 构造 MCP 成功、`isError=true` 和 transport 异常三种结果，验证工具调用方可见状态及内容均正确 | S | 待运行验证（先补失败适配测试） |
| P2 | 开发者难以知道为什么某个工具不在工具池中（被 deny 规则过滤？被 Repl 模式隐藏？与内置工具重名被遮蔽？） | 增加可选的"组装跟踪"模式，记录每个工具被包含/排除的原因 | 低 —— 可选功能，默认关闭 | 增加组装跟踪模式的测试，验证记录的原因与实际行为一致 | M | 设计推断 |
