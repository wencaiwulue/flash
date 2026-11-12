---
id: permissions
batch: 2
title: Permissions 工具权限裁决与审批设计
date: 2026-11-12
status: draft
---

# Permissions 工具权限裁决与审批设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

当模型请求执行工具（如 Bash、文件编辑）时，系统需要根据配置规则、当前权限模式和用户反馈做出允许/拒绝/询问的决策。如果没有分层裁决机制，会导致：

- 用户每次都要手动确认每个工具调用，体验不佳
- 无法区分安全操作和高风险操作
- 没有规则优先级，配置冲突时行为不可预测
- classifier 自动批准可能绕过必要的安全检查
- plan mode 与 bypassPermissions 边界不清导致意外执行

因此本子系统必须在以下约束下完成权限裁决：

- 支持多种 PermissionMode（default、plan、acceptEdits、bypassPermissions、dontAsk、auto），其中 auto mode 为 ant-only feature
- 规则来源有优先级（cliArg > command > session > localSettings > projectSettings > userSettings > flagSettings > policySettings）
- 工具自身的 checkPermissions 是安全检查的最后一道防线，不能被规则绕过
- 分类器（bash classifier、auto mode classifier）的输出只是输入之一，不能直接作为最终授权
- sandbox 环境有特殊权限覆盖逻辑
- 支持异步 Agent/worker 场景下的权限处理（无用户交互时走 hooks 或自动拒绝）

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 分层裁决流：规则→工具检查→模式转换 | `hasPermissionsToUseTool` 先查 allow/deny 规则，再调用 `tool.checkPermissions`，最后应用 mode 转换 | 规则优先，工具检查作为安全底线，mode 只改变询问/拒绝行为，不能绕过安全检查 | 完全由工具决定：规则无法覆盖常见场景；完全由规则决定：工具的动态安全检查无法生效 | 裁决路径变长，需理解多层交互 | `src/utils/permissions/permissions.ts:473` |
| PermissionMode 作为最后转换层，不影响 allow 规则 | `dontAsk` 只在结果为 `ask` 时才转为 `deny`，`auto` 只在 `ask` 时才调用分类器，`acceptEdits` 在 `ask` 时先做一次模拟检查 | 允许规则始终生效，安全检查始终生效，mode 只改变用户交互策略 | mode 覆盖一切：会绕过工具安全检查，不安全 | mode 逻辑分散在多处，需仔细追踪 | `src/utils/permissions/permissions.ts:503-850` |
| 规则来源有明确优先级：cliArg 最高，policySettings 最低 | `PERMISSION_RULE_SOURCES` 按优先级排序，`getAllowRules` 等按此顺序收集，但同一行为内的规则顺序不影响（只要匹配一条就生效） | 允许临时命令行参数覆盖持久化配置，企业策略可以作为默认值但被用户覆盖 | 无优先级：配置冲突时行为不可预测 | 优先级顺序需牢记，调试时需检查多层来源 | `src/utils/permissions/permissions.ts:109-131` |
| dontAsk 模式：ask → deny，在最后一步应用 | 在 `hasPermissionsToUseToolInner` 返回后检查，如果 result.behavior 是 ask 且 mode 是 dontAsk，则转为 deny | 确保工具检查和规则都已生效后，才静默拒绝，而不是一开始就短路 | 一开始就拒绝：allow 规则会失效，用户无法通过规则放行 | 名称有歧义：不是不问，是问了但替用户拒绝 | `src/utils/permissions/permissions.ts:505-517` |
| auto mode：先尝试 acceptEdits 快速路径，再试安全工具允许列表，最后才调用 classifier | auto mode 下，先模拟 acceptEdits 检查，通过则直接放行；再检查是否在安全工具允许列表；最后调用 YOLO classifier | 避免对明显安全的操作进行昂贵的 API 调用，降低延迟和成本 | 直接调用 classifier：成本高，延迟大；完全跳过 classifier：不安全 | 增加了三条路径，逻辑复杂；需要维护安全工具列表 | `src/utils/permissions/permissions.ts:593-686` |
| safetyCheck 决策：classifierApprovable 标志控制是否可以被 auto-approve | `decisionReason.type === 'safetyCheck'` 时检查 `classifierApprovable`，为 false 时即使 auto mode 也保留为 ask | 某些高风险操作（如跨机器桥接）必须用户手动确认，不能被 classifier 或 acceptEdits 绕过 | 全部可 auto-approve：不安全 | 需要工具实现者正确设置该标志 | `src/utils/permissions/permissions.ts:532-548` |
| 拒绝跟踪：连续拒绝 3 次或总拒绝 20 次后回退到用户提示 | `DenialTrackingState` 记录 `consecutiveDenials` 和 `totalDenials`，`shouldFallbackToPrompting` 判断是否回退 | 避免 classifier 连续误判导致用户无法执行操作，提供回退机制 | 无回退：用户被卡住 | 需要维护状态，state 放在 appState 中 | `src/utils/permissions/denialTracking.ts:1-45` |
| PowerShell 在 auto mode 默认不使用 classifier | 检查 `feature('POWERSHELL_AUTO_MODE')`，未开启时直接返回 ask | PowerShell 风险更高，默认需要用户确认，除非显式启用 | 像 Bash 一样默认启用：安全风险过高 | PowerShell 路径特殊，需注意 | `src/utils/permissions/permissions.ts:572-591` |
| sandbox 覆盖：`sandboxOverride` decisionReason | sandbox 环境下，某些命令可以在 sandbox 外执行，通过 `sandboxOverride` 原因表示 | sandbox 是主要安全边界，例外需明确记录 | 无特殊处理：sandbox 边界不清 | sandbox 逻辑在 shell tools spec 中 | `src/types/permissions.ts:304-306` |
| 危险规则检测：`isDangerousBashPermission` 等检查自动模式下的过宽规则 | 检测 `Bash(*)`、`Bash(python:*)`、`PowerShell(iex:*)` 等规则，启动时警告或剥离 | 避免用户不小心设置过宽规则绕过 classifier 安全检查 | 不检测：用户可能意外配置过高权限 | 检测逻辑复杂，需维护危险模式列表 | `src/utils/permissions/permissionSetup.ts:87-145` |
| 异步 Agent 权限处理：`shouldAvoidPermissionPrompts` 下先运行 hooks，再自动拒绝 | 检查 `shouldAvoidPermissionPrompts`，先执行 `executePermissionRequestHooks`，无 hook 决定时返回 `asyncAgent` reason 的 deny | Agent 没有用户交互界面，需给 hooks 机会介入，否则安全拒绝 | 直接拒绝：hooks 无法介入；强制弹窗：不可能 | 增加了 hook 路径，需确保 hooks 正确实现 | `src/utils/permissions/permissions.ts:400-471` |
| 用户确认通过 React 状态队列：`ToolUseConfirm` 队列 + `PermissionContext` | `useCanUseTool` 创建 `PermissionContext`，调用 `hasPermissionsToUseTool`，ask 时调用 `handleInteractivePermission` 推入队列；UI 组件从队列渲染，用户操作后 resolve | 支持多个待确认权限按顺序处理，支持 async hooks/classifier 在后台运行 | 同步弹窗：阻塞主线程，无法后台处理 | 涉及 React 状态，逻辑分散在 hooks 和组件中 | `src/hooks/useCanUseTool.tsx:55-363` |
| PermissionResult 支持 passthrough 行为：用于子命令需要单独确认 | Bash 等工具可返回 `passthrough`，表示需要进一步确认子命令；`subcommandResults` 记录各部分决策 | 复合命令可逐部分确认，而不是全有或全无 | 只有 allow/deny/ask：粒度太粗 | 子命令逻辑在各工具内部，权限层只需传递 | `src/types/permissions.ts:252-268` |

## 3. 目标与非目标

### 状态与生命周期

- **ToolPermissionContext** 拥有当前 mode、规则集、工作目录列表，由 `permissionSetup.ts` 初始化，可通过 `applyPermissionUpdates` 更新
- **DenialTrackingState** 拥有连续拒绝次数和总拒绝次数，放在 AppState 中，允许时重置连续计数，拒绝时递增
- **ToolUseConfirm 队列** 拥有待用户确认的权限请求，由 React 状态管理，用户操作后移除
- **classifier 检查状态** 临时状态，通过 `setClassifierChecking`/`clearClassifierChecking` 标记，用于 UI 显示

### 接口与数据

- **目标**：保证 `PermissionDecision` 包含 `behavior`（allow/deny/ask）、`decisionReason`（规则/模式/分类器/钩子等）、`message`（用户提示）、可选 `updatedInput`（用户修改后的输入）
- **目标**：`PermissionUpdate` 支持添加/替换/删除规则、设置模式、添加工作目录，可持久化到各设置层
- **非目标**：不保证跨版本的 `PermissionUpdate` 格式兼容性，只保证当前代码能正确处理
- **非目标**：不提供统一的权限规则语言语法定义，各工具自行解析 `ruleContent`

### 执行与环境

- **目标**：支持 CLI 交互模式、SDK 嵌入模式、异步 Agent 模式三种入口
- **目标**：支持 feature flag 控制（`TRANSCRIPT_CLASSIFIER`、`BASH_CLASSIFIER`、`POWERSHELL_AUTO_MODE`）
- **非目标**：不支持 Web 权限模型，不处理浏览器沙箱

### 依赖边界

- **工具权限检查**：各工具的 `checkPermissions` 由工具自身实现，本文只描述调用契约，主设计由各工具 spec 负责
- **Sandbox 覆盖**：sandbox 环境的权限逻辑由 shell tools spec 主拥有，本文只描述 `sandboxOverride` decisionReason 的存在
- **Query Core 集成**：`useCanUseTool` 如何被 query 调用由 query-core spec 负责，本文只描述权限裁决自身

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 主要裁决入口
function hasPermissionsToUseTool(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string
): Promise<PermissionDecision>

// 权限上下文创建与队列操作（React 侧）
function useCanUseTool(
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>,
  setToolPermissionContext: (context: ToolPermissionContext) => void
): CanUseToolFn

// 权限更新应用
function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[]
): ToolPermissionContext

function persistPermissionUpdates(updates: PermissionUpdate[]): void
```

调用方式：

1. **SDK/Query 路径**：`queryLoop` 调用 `canUseTool`（即 `useCanUseTool` 返回的函数）
2. **React 侧**：`useCanUseTool` 创建 `PermissionContext`，先调用 `hasPermissionsToUseTool` 获取初步决策
3. **用户交互**：如果是 ask，推入 `ToolUseConfirm` 队列，UI 渲染对应组件，用户操作后 resolve
4. **后台处理**：hooks 和 classifier 可在后台运行，自动批准时无需用户操作

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `permissions.ts` | 无（纯函数 + 从 context 读取） | `hasPermissionsToUseTool`、`getAllowRules`、`getDenyRules` | 规则持久化、UI 渲染 | 接收 `ToolPermissionContext`、`ToolUseContext`，返回 `PermissionDecision` |
| `permissionSetup.ts` | 无（纯函数） | `createToolPermissionContext`、`findDangerousClassifierPermissions`、`isDangerousBashPermission` | 实际裁决逻辑 | 读取 settings，返回 `ToolPermissionContext` |
| `PermissionMode.ts` | 无（常量 + 纯函数） | `permissionModeTitle`、`isExternalPermissionMode`、`permissionModeFromString` | 裁决逻辑 | 模式枚举与转换 |
| `denialTracking.ts` | `DenialTrackingState`（在 AppState 中） | `createDenialTrackingState`、`recordDenial`、`recordSuccess`、`shouldFallbackToPrompting` | 拒绝后的恢复逻辑 | 接收 state，返回新 state |
| `useCanUseTool.tsx` | 无（React hook） | `useCanUseTool` → 返回 `CanUseToolFn` | 权限规则定义 | 接收 React state setters，协调 `hasPermissionsToUseTool` 和 UI 队列 |
| `PermissionContext.ts` | 无（工厂函数创建闭包） | `createPermissionContext`、`createPermissionQueueOps` | 裁决逻辑 | 封装日志、持久化、取消操作 |
| `PermissionRequest.tsx` + 各工具组件 | `ToolUseConfirm` 队列（React state） | 渲染权限弹窗、处理用户输入 | 裁决逻辑 | 从队列读取，用户操作后调用 resolve |
| `permissions.tsx`（command） | 无 | `/permissions` 命令 UI | 裁决逻辑 | 显示和编辑当前权限规则 |

状态位置与理由：

- `ToolPermissionContext` 放在 AppState 中：需要在会话间持久化，且被多处共享
- `DenialTrackingState` 放在 AppState 中：跨工具调用保持连续拒绝计数
- `ToolUseConfirm` 队列是 React 本地状态：仅 UI 需要，不持久化

### 4.3 主控制流

完整裁决流（端到端）：

```text
模型 tool_use 请求
  ↓
queryLoop 调用 canUseTool(tool, input, ...)
  ↓
useCanUseTool 创建 PermissionContext
  ↓
hasPermissionsToUseToolInner（核心裁决）
  ├─ 0. 检查 bypassPermissions 模式且可用 → 直接 allow
  ├─ 1. 收集规则：按优先级顺序 getAllowRules/getDenyRules/getAskRules
  ├─ 2. 检查是否匹配 allow 规则 → 是则返回 allow + rule reason
  ├─ 3. 检查是否匹配 deny 规则 → 是则返回 deny + rule reason
  ├─ 4. 调用 tool.checkPermissions(input, context) → 获取工具自身决策
  ├─ 5. 如果工具返回 allow/deny → 直接采用该决策
  └─ 6. 否则（工具返回 ask）→ 准备 ask 决策
  ↓
模式转换层（在 hasPermissionsToUseTool 外层）
  ├─ 如果 result 是 ask 且 mode 是 dontAsk → 转为 deny
  ├─ 如果 result 是 ask 且 mode 是 auto（或 plan+auto 激活）
  │   ├─ 检查 safetyCheck.classifierApprovable → false 则保留 ask
  │   ├─ 检查工具是否需要用户交互 → 是则保留 ask
  │   ├─ 尝试 acceptEdits 快速路径 → 模拟检查，通过则 allow
  │   ├─ 尝试安全工具允许列表 → 在列表则 allow
  │   └─ 调用 YOLO classifier → 根据结果 allow/deny/回退提示
  ↓
useCanUseTool 处理决策
  ├─ allow → 直接 resolve，记录日志
  ├─ deny → 直接 resolve，记录日志，auto mode 下记录拒绝并可能回退
  └─ ask → 进入用户交互路径
      ├─ awaitAutomatedChecksBeforeDialog → 先处理 coordinator worker 检查
      ├─ swarm worker → 转发到 leader 或尝试 classifier
      ├─ Bash 且有 pendingClassifierCheck → 等待最多 2s 看投机检查结果
      └─ 显示弹窗：handleInteractivePermission 推入队列，渲染对应组件
  ↓
用户操作（或后台自动批准）
  ├─ 用户允许 → 可能创建 PermissionUpdate 并持久化 → resolve allow
  ├─ 用户拒绝 → 记录拒绝 → resolve deny（可能 abort）
  ├─ classifier 自动批准 → 无需用户操作 → resolve allow
  └─ hook 批准/拒绝 → 无需用户操作 → 相应 resolve
  ↓
返回 PermissionDecision 给 queryLoop
  ├─ allow → 执行工具
  └─ deny → 返回 tool_result 给模型，记录到 permissionDenials
```

分支条件：

- **bypassPermissions**：短路路径，直接 allow
- **dontAsk**：ask → deny 转换
- **auto mode**：多条快速路径 + classifier 路径
- **asyncAgent**：无用户交互时 hooks 优先，否则自动拒绝
- **plan mode**：通常阻止执行，只显示计划；但可与 auto 组合

### 4.4 数据结构与持久化

关键数据结构：

```typescript
// 权限模式
type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto'

// 权限规则
type PermissionRule = {
  source: PermissionRuleSource  // userSettings / projectSettings / localSettings / ... / cliArg
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: {
    toolName: string
    ruleContent?: string  // 工具特定内容，如 Bash(prefix:*)
  }
}

// 权限决策
type PermissionDecision =
  | PermissionAllowDecision
  | PermissionAskDecision
  | PermissionDenyDecision

type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'subcommandResults'; reasons: Map<string, PermissionResult> }
  | { type: 'hook'; hookName: string; hookSource?: string; reason?: string }
  | { type: 'classifier'; classifier: string; reason: string }
  | { type: 'safetyCheck'; reason: string; classifierApprovable: boolean }
  | { type: 'sandboxOverride'; reason: 'excludedCommand' | 'dangerouslyDisableSandbox' }
  // ... 更多类型

// 拒绝跟踪
type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}
```

持久化：

- **权限规则**：持久化到用户/项目/local settings 文件（JSON），通过 `persistPermissionUpdates` 写入
- **模式设置**：同样持久化到 settings
- **DenialTrackingState**：不持久化，仅内存状态
- **ToolUseConfirm 队列**：不持久化，仅 React 本地状态

恢复时：

- 从 settings 重建 `ToolPermissionContext`
- `DenialTrackingState` 从零开始
- 未完成的权限请求不恢复，模型需要重新请求

### 4.5 跨子系统依赖

- **Query Core**：调用 `canUseTool`，接收 `PermissionDecision`，处理拒绝记录；主设计由 query-core spec 负责
- **各工具**：实现 `tool.checkPermissions`，提供权限请求 UI 组件；主设计由各工具 spec 负责
- **Shell Tools / Sandbox**：处理 sandbox 环境权限覆盖；主设计由 shell-tools spec 负责，本文只引用 `sandboxOverride`
- **Hooks**：`executePermissionRequestHooks` 允许外部介入权限决策；hooks 机制由独立 spec 负责
- **Settings**：存储和加载权限规则与模式；settings spec 负责持久化机制

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 工具 checkPermissions 抛出异常 | `hasPermissionsToUseTool` try/catch | 转换为 `AbortError` 或重新抛出 | 否 | `clearClassifierChecking` | 拒绝，abort |
| Classifier API 调用失败 | `classifyYoloAction` | 返回 `unavailable` 状态 | 否，直接回退到用户提示 | 记录日志，可选 dump 提示到 /share | ask 用户确认 |
| Classifier prompt 过长 | `classifyYoloAction` | `transcriptTooLong` 标志 | 否，回退到用户提示 | 无特殊清理 | ask 用户确认 |
| 连续拒绝 3 次 / 总拒绝 20 次 | `shouldFallbackToPrompting` | 不传播异常，改变行为 | 回到用户提示后重置连续计数 | 无 | ask 用户确认（不再自动拒绝） |
| 用户 abort（ctrl+c） | `resolveIfAborted` | 检查 `signal.aborted` | 否 | `logCancelled`，调用 `abortController.abort()` | 拒绝，abort |
| Async Agent 无用户交互且 hooks 无决策 | `runPermissionRequestHooksForHeadlessAgent` | 返回 `asyncAgent` reason 的 deny | 否 | 无特殊清理 | deny，拒绝消息说明无法提示 |
| 权限更新持久化失败 | `persistPermissionUpdates` | 可能抛出（取决于 settings 实现） | 否 | context 中的状态已更新，磁盘未更新 | 异常传播到调用方 |

工程取舍：

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| dontAsk 命名 | 叫 "dontAsk" 但实际是 "ask then auto-reject" | 名称易误解 | 无需新增模式枚举 |
| auto mode 快速路径顺序 | acceptEdits → allowlist → classifier | 路径多，难追踪 | 降低延迟和成本 |
| classifier 失败开放策略 | classifier 不可用时回退到用户提示，而不是 fail-closed | 可能放过风险操作 | 可用性更高 |
| 拒绝计数无持久化 | 仅内存状态，重启归零 | 重启后连续拒绝计数重置 | 实现简单，用户体验可接受 |
| 危险规则只警告不阻止 | 启动时检测并显示，但不阻止使用（除非是 auto mode 下的剥离） | 用户可能忽略警告继续使用 | 避免破坏已有配置 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| mode = bypassPermissions 且可用 | 任何工具请求 | 直接 allow，不询问用户 | 不能调用工具 checkPermissions |
| mode = dontAsk，工具返回 ask | 任何工具请求 | 返回 deny，不询问用户 | allow 规则必须仍然生效 |
| 存在 allow 规则匹配 | 工具请求匹配该规则 | 返回 allow，原因是该 rule | 不能继续询问用户 |
| 存在 deny 规则匹配 | 工具请求匹配该规则 | 返回 deny，原因是该 rule | 不能调用工具 checkPermissions |
| safetyCheck 且 classifierApprovable = false | auto mode 下触发该检查 | 保持 ask，不调用 classifier | classifier 不能绕过此类检查 |
| PowerShell 工具请求，POWERSHELL_AUTO_MODE 关闭 | auto mode | 保持 ask，不调用 classifier | 不能调用 YOLO classifier |
| classifier 连续拒绝 3 次 | auto mode 下连续被拒 | 回退到用户提示，不再自动拒绝 | 不能无限自动拒绝 |
| asyncAgent 场景，无用户交互 | 工具返回 ask | 先执行 hooks，再决定；无 hook 决策则 deny | 不能尝试显示 UI |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 分层裁决流：规则 → 工具检查 → 模式转换 | `src/utils/permissions/permissions.ts:473-501` | 需查找相关测试 | 未找到直接测试覆盖 |
| dontAsk 只在 ask 时转 deny | `src/utils/permissions/permissions.ts:505-517` | 需查找相关测试 | 未找到直接测试覆盖 |
| auto mode 快速路径：acceptEdits → allowlist → classifier | `src/utils/permissions/permissions.ts:593-686` | 需查找相关测试 | 未找到直接测试覆盖 |
| safetyCheck classifierApprovable 控制 auto-approve | `src/utils/permissions/permissions.ts:532-548` | 需查找相关测试 | 未找到直接测试覆盖 |
| 拒绝跟踪：连续 3 次 / 总 20 次回退 | `src/utils/permissions/denialTracking.ts:1-45` | 需查找相关测试 | 未找到直接测试覆盖 |
| 危险规则检测：Bash(*)、python:* 等 | `src/utils/permissions/permissionSetup.ts:87-145` | 需查找相关测试 | 未找到直接测试覆盖 |
| async Agent 权限处理：hooks 优先 | `src/utils/permissions/permissions.ts:400-471` | 需查找相关测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/types/permissions.ts` | `PermissionMode`、`PermissionRule`、`PermissionDecision`、`PermissionDecisionReason` | 纯类型定义，提取出来避免循环依赖 |
| `src/utils/permissions/permissions.ts` | `hasPermissionsToUseTool`、`getAllowRules`、`getDenyRules` | 核心裁决逻辑 |
| `src/utils/permissions/permissionSetup.ts` | `createToolPermissionContext`、`isDangerousBashPermission`、`findDangerousClassifierPermissions` | 上下文创建与危险规则检测 |
| `src/utils/permissions/PermissionMode.ts` | `permissionModeTitle`、`isExternalPermissionMode` | 模式枚举与工具函数 |
| `src/utils/permissions/denialTracking.ts` | `DenialTrackingState`、`recordDenial`、`shouldFallbackToPrompting` | 拒绝计数与回退逻辑 |
| `src/utils/permissions/PermissionUpdate.ts` | `applyPermissionUpdates`、`persistPermissionUpdates` | 权限更新应用与持久化 |
| `src/hooks/useCanUseTool.tsx` | `useCanUseTool`、`CanUseToolFn` | React hook 整合裁决与 UI |
| `src/hooks/toolPermission/PermissionContext.ts` | `createPermissionContext`、`createPermissionQueueOps` | 权限上下文工厂 |
| `src/components/permissions/PermissionRequest.tsx` | `permissionComponentForTool`、`ToolUseConfirm` | 权限请求 UI 入口 |
| `src/commands/permissions/permissions.tsx` | `/permissions` 命令 | 权限规则管理 UI |

### 7.2 未覆盖行为（基于代码阅读）

- 完整的 auto mode classifier 端到端测试
- 危险规则检测的实际效果测试
- 异步 Agent 权限处理的完整测试
- plan mode 与 auto mode 组合场景测试
- PowerShell 在 auto mode 下的行为测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/permissions.yaml)

### 8.1 本 spec 主拥有的文件

| 分组 | 主拥有职责 |
|---|---|
| permissions-core | 核心裁决逻辑、规则匹配、模式转换 |
| permissions-types | 权限类型定义 |
| permissions-setup | 权限上下文初始化、危险规则检测 |
| permissions-hooks | React hooks 整合裁决与 UI |
| permissions-components | 权限请求 UI 组件 |
| permissions-commands | 权限管理命令 |
| permissions-denial-tracking | 拒绝计数与回退逻辑 |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/sandbox/*` → 主归 shell-tools spec，本文只引用 `sandboxOverride`
- 各工具的 `checkPermissions` 和权限组件 → 主归各工具 spec
- `src/QueryEngine.ts` 中的权限调用 → 主归 query-core spec

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | `dontAsk` 名称有歧义，实际是 "ask then auto-reject" 而不是 "never ask" | 重命名为 `autoReject` 或 `silentReject`；或保持名称但改进文档 | 中等（设置中的模式名称需兼容） | 新旧名称都能识别，文档明确说明行为 | S | 已证实 |
| P2 | auto mode 路径过多（acceptEdits、allowlist、classifier），难以追踪和调试 | 增加结构化的决策日志，记录每个路径是否触发及原因 | 低（仅日志） | 开启调试日志后能看到完整决策路径 | S | 已证实 |
| P2 | 拒绝计数无持久化，重启后连续拒绝重置 | 可选持久化到 local settings | 低（可配置开启） | 配置开启后重启保留计数 | M | 设计推断 |
| P3 | 危险规则只警告不阻止，用户可能忽略 | 增加 "强制安全模式" 设置，开启时自动剥离危险规则 | 低（可选） | 开启后危险规则被阻止，无法使用 | M | 设计推断 |
