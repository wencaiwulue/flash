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

### 4.0 模块设计卡片总览

本章为每个核心模块提供详细的设计卡片，包含真实类型签名、输入输出、上下文状态、完整裁决顺序、副作用与持久化、失败安全、设计取舍与备选、源码证据等。

---

#### 模块设计卡片：PermissionMode 权限模式枚举

**真实类型与函数签名**
```typescript
// src/types/permissions.ts
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan',
] as const
export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
export type PermissionMode = InternalPermissionMode

// src/utils/permissions/PermissionMode.ts
export function permissionModeTitle(mode: PermissionMode): string
export function permissionModeShortTitle(mode: PermissionMode): string
export function permissionModeSymbol(mode: PermissionMode): string
export function isExternalPermissionMode(mode: PermissionMode): mode is ExternalPermissionMode
export function toExternalPermissionMode(mode: PermissionMode): ExternalPermissionMode
export function permissionModeFromString(str: string): PermissionMode
```

**输入输出**
| 输入 | 输出 |
|------|------|
| 字符串（`permissionModeFromString`） | `PermissionMode` 枚举值 |
| `PermissionMode`（`permissionModeTitle`） | 用户可读标题字符串 |

**上下文状态**
- 从 `ToolPermissionContext.mode` 读取当前模式
- 模式持久化于 `settings.permissions.defaultMode`

**模式行为转换表**
| 模式 | 行为 | 对 `ask` 的转换 | 对 `allow` 的影响 | 对 `deny` 的影响 |
|------|------|-----------------|-------------------|------------------|
| `default` | 默认交互 | 保留 `ask` | 不变 | 不变 |
| `plan` | 计划模式（通常阻止执行） | 保留 `ask`（除非与 `auto` 组合） | 不变 | 不变 |
| `acceptEdits` | 自动接受编辑操作 | 保留 `ask`（工具层处理） | 不变 | 不变 |
| `bypassPermissions` | 绕过安全检查 | 短路为 `allow` | 短路（优先） | 仍需检查 deny 规则/安全检查 |
| `dontAsk` | 自动拒绝询问 | `ask` → `deny` | 不变 | 不变 |
| `auto` | 自动模式（ant-only） | `ask` → 快速路径或分类器裁决 | 不变 | 不变 |
| `bubble` | 冒泡模式（内部） | 保留 `ask` | 不变 | 不变 |

**失败安全**
- `permissionModeFromString` 对无效输入回退到 `'default'`
- `isExternalPermissionMode` 对非 ant 用户始终返回 `true`

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| `auto` 仅对 ant 可用 | `feature('TRANSCRIPT_CLASSIFIER')` 门控 | 分割代码路径 | 逐步推出安全功能 |
| `dontAsk` 命名歧义 | 保留名称但在文档中澄清 | 新用户困惑 | 避免破坏性变更 |
| `bubble` 内部模式 | 不暴露给外部用户 | 需要额外类型分支 | 支持内部实现细节 |
| 备选方案 1 | 重命名 `dontAsk` → `autoReject` | 迁移成本高 | 语义更清晰 |
| 备选方案 2 | 将 `auto` 模式拆分为多个细粒度模式 | 模式爆炸 | 更简单的当前设计 |

**源码证据**
- `src/types/permissions.ts:13-45` - 类型定义
- `src/utils/permissions/PermissionMode.ts:1-142` - 实现与配置
- 证据边界：`PERMISSION_MODE_CONFIG` 定义了 UI 展示属性，非核心裁决逻辑

---

#### 模块设计卡片：规则匹配与优先级

**真实类型与函数签名**
```typescript
// src/types/permissions.ts
export type PermissionRuleSource =
  | 'userSettings' | 'projectSettings' | 'localSettings'
  | 'flagSettings' | 'policySettings' | 'cliArg' | 'command' | 'session'

export type PermissionRule = {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior  // 'allow' | 'deny' | 'ask'
  ruleValue: PermissionRuleValue    // { toolName, ruleContent? }
}

// src/utils/permissions/permissions.ts
export const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES, 'cliArg', 'command', 'session',
] as const

export function getAllowRules(context: ToolPermissionContext): PermissionRule[]
export function getDenyRules(context: ToolPermissionContext): PermissionRule[]
export function getAskRules(context: ToolPermissionContext): PermissionRule[]
export function toolAlwaysAllowedRule(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>
): PermissionRule | null
export function getDenyRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>
): PermissionRule | null
export function getAskRuleForTool(
  context: ToolPermissionContext,
  tool: Pick<Tool, 'name' | 'mcpInfo'>
): PermissionRule | null
export function getRuleByContentsForTool(
  context: ToolPermissionContext,
  tool: Tool,
  behavior: PermissionBehavior
): Map<string, PermissionRule>
```

**规则来源优先级（从高到低）**
| 优先级 | 来源 | 持久化 | 说明 |
|--------|------|--------|------|
| 1 | `cliArg` | 否 | 命令行参数（最高优先级） |
| 2 | `command` | 否 | `/permissions` 命令添加 |
| 3 | `session` | 否 | 当前会话临时规则 |
| 4 | `localSettings` | 是 | 本地项目设置 |
| 5 | `projectSettings` | 是 | 项目设置 |
| 6 | `userSettings` | 是 | 用户全局设置 |
| 7 | `flagSettings` | 否 | Feature flag 注入 |
| 8 | `policySettings` | 是 | 企业策略（最低优先级） |

**规则匹配算法**
1. 按优先级顺序收集规则（`cliArg` 先于 `userSettings`）
2. 先检查 deny 规则 → 匹配则立即返回 `deny`
3. 再检查 ask 规则 → 匹配则立即返回 `ask`
4. 最后检查 allow 规则 → 匹配则立即返回 `allow`
5. 工具级规则匹配（无 `ruleContent`）优先于内容级规则
6. 同来源内多条规则：任一匹配即生效

**MCP 工具匹配扩展**
- 完整工具名匹配：`mcp__server__tool`
- 服务器级通配符：`mcp__server` 或 `mcp__server__*`
- 通过 `mcpInfoFromString` 解析

**失败安全**
- 规则解析失败时：忽略该规则，继续下一个
- 危险规则检测：`Bash(*)`、`Bash(python:*)`、`PowerShell(iex:*)` 自动警告或剥离

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 优先级顺序固定 | `PERMISSION_RULE_SOURCES` 硬编码 | 灵活性低 | 行为可预测 |
| 同来源内任一匹配即生效 | 不需全部规则匹配 | 无法表达"除某规则外全部允许" | 实现简单 |
| deny 规则优先级最高 | 安全优先 | 临时 allow 规则无法覆盖策略 deny | 防止错误配置 |
| 备选方案 1 | 支持规则优先级注释 | 解析复杂 | 更高灵活性 |
| 备选方案 2 | 支持异常规则（"除 X 外允许 Y"） | 规则语言复杂 | 更强表达力 |

**源码证据**
- `src/utils/permissions/permissions.ts:109-390` - 规则收集与匹配
- `src/utils/permissions/permissionSetup.ts:87-145` - 危险规则检测
- 证据边界：MCP 规则解析使用 `mcpInfoFromString`，定义在 `src/services/mcp/mcpStringUtils.ts`

---

#### 模块设计卡片：hasPermissionsToUseTool 核心裁决

**真实类型与函数签名**
```typescript
// src/utils/permissions/permissions.ts
export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string
): Promise<PermissionDecision>

async function hasPermissionsToUseToolInner(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext
): Promise<PermissionDecision>

export async function checkRuleBasedPermissions(
  tool: Tool,
  input: Record<string, unknown>,
  context: ToolUseContext
): Promise<PermissionAskDecision | PermissionDenyDecision | null>
```

**完整裁决顺序（从先到后）**

```
阶段 1: hasPermissionsToUseToolInner - 基础裁决
  ├─ 1a. 检查 deny 规则（工具级）→ 匹配 → 返回 deny
  ├─ 1b. 检查 ask 规则（工具级）→ 匹配 → 返回 ask（除非 sandbox 自动允许）
  ├─ 1c. 调用 tool.checkPermissions(input, context) → 获取工具决策
  ├─ 1d. 工具返回 deny → 返回 deny
  ├─ 1e. 工具 requiresUserInteraction 且结果为 ask → 返回 ask
  ├─ 1f. 工具返回 ask 且决策原因是 ask 规则 → 返回 ask
  ├─ 1g. 工具返回 ask 且决策原因是 safetyCheck → 返回 ask
  ├─ 2a. 检查 bypassPermissions 模式 → 启用 → 返回 allow
  │      (注: bypassPermissions 仅在 1d/1e/1f/1g 未触发时生效)
  ├─ 2b. 检查 allow 规则（工具级）→ 匹配 → 返回 allow
  └─ 3. 工具返回 passthrough → 转换为 ask

阶段 2: hasPermissionsToUseTool - 模式转换层
  ├─ 结果为 allow → 返回 allow
  ├─ 结果为 deny → 返回 deny
  └─ 结果为 ask:
      ├─ 模式为 dontAsk → 转换为 deny
      ├─ 模式为 auto 或 (plan + auto 激活):
      │   ├─ safetyCheck.classifierApprovable === false → 保留 ask
      │   ├─ 工具 requiresUserInteraction → 保留 ask
      │   ├─ PowerShell 且 POWERSHELL_AUTO_MODE 关闭 → 保留 ask
      │   ├─ [快速路径 1] 模拟 acceptEdits 模式检查 → allow → 返回 allow
      │   ├─ [快速路径 2] 工具在安全允许列表 → 返回 allow
      │   ├─ 调用 YOLO 分类器:
      │   │   ├─ 分类器不可用且 iron_gate_closed → deny
      │   │   ├─ 分类器不可用且 iron_gate_open → 保留 ask
      │   │   ├─ transcriptTooLong → 保留 ask
      │   │   ├─ 分类器拒绝 → 记录拒绝，检查拒绝计数
      │   │   │   ├─ 拒绝超限 → 回退到 ask
      │   │   │   └─ 未超限 → 返回 deny
      │   │   └─ 分类器批准 → 返回 allow
      ├─ shouldAvoidPermissionPrompts === true:
      │   ├─ 执行 PermissionRequest hooks
      │   │   ├─ hook 返回 allow → 返回 allow
      │   │   └─ hook 返回 deny → 返回 deny
      │   └─ 无 hook 决策 → 返回 deny（asyncAgent 原因）
      └─ 其他情况 → 保留 ask
```

**输入输出**
| 输入 | 输出 |
|------|------|
| `tool: Tool` | `PermissionDecision` |
| `input: Record<string, unknown>` | `behavior: 'allow' \| 'deny' \| 'ask'` |
| `context: ToolUseContext` | `decisionReason?` 解释原因 |
| `assistantMessage: AssistantMessage` | `updatedInput?` 用户修改后的输入 |
| `toolUseID: string` | `message?` 给用户的提示 |

**上下文状态（读取）**
- `context.getAppState().toolPermissionContext.mode` - 当前权限模式
- `context.getAppState().toolPermissionContext.alwaysAllowRules` - allow 规则
- `context.getAppState().toolPermissionContext.alwaysDenyRules` - deny 规则
- `context.getAppState().toolPermissionContext.alwaysAskRules` - ask 规则
- `context.getAppState().toolPermissionContext.shouldAvoidPermissionPrompts` - 是否避免提示
- `context.getAppState().denialTracking` - 拒绝计数（auto mode）

**副作用（可观察）**
| 副作用 | 触发条件 | 持久化 |
|--------|----------|--------|
| 记录成功（`recordSuccess`） | allow 决策且 auto mode | 否（内存） |
| 记录拒绝（`recordDenial`） | auto mode 分类器拒绝 | 否（内存） |
| 记录分析事件（`logEvent`） | auto mode 所有决策 | 否（仅遥测） |
| 设置分类器检查状态（`setClassifierChecking`） | 调用分类器前 | 否（临时） |
| 清除分类器检查状态（`clearClassifierChecking`） | 分类器完成后 | 否（临时） |
| 添加通知（`addNotification`） | auto mode 拒绝或错误 | 否（UI） |

**失败安全**
- `tool.checkPermissions` 抛出异常 → 捕获并记录，转换为 `ask`（除非 abort）
- `AbortError` / `APIUserAbortError` → 重新抛出，向上传递取消
- 分类器 API 失败 → `unavailable` 状态，根据 `iron_gate_closed` 决定 fail-close/fail-open
- `transcriptTooLong` → 回退到 `ask`，不重试

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 分层设计（inner + 外层模式转换） | 分离关注点 | 需要理解两层 | 更易测试 inner 逻辑 |
| bypassPermissions 仅在工具检查后生效 | 安全检查不可绕过 | 模式命名有误导 | 防止绕过关键安全检查 |
| auto mode 快速路径先于分类器 | acceptEdits → allowlist → classifier | 路径多，调试难 | 降低延迟和成本 |
| 分类器失败默认 fail-open | `iron_gate_closed` 默认 true | 潜在安全风险 | 更好的可用性 |
| 拒绝计数仅在内存中 | 重启归零 | 长期滥用无法追踪 | 实现简单 |
| 备选方案 1 | 分类器默认 fail-closed | 用户体验差 | 更高安全性 |
| 备选方案 2 | 持久化拒绝计数 | 增加存储复杂度 | 跨会话追踪 |

**源码证据**
- `src/utils/permissions/permissions.ts:473-1320` - 完整裁决实现
- `src/utils/permissions/permissions.ts:1158-1320` - `hasPermissionsToUseToolInner`
- `src/utils/permissions/permissions.ts:1071-1156` - `checkRuleBasedPermissions`
- 证据边界：工具侧 `checkPermissions` 由各工具实现，非本模块所有

---

#### 模块设计卡片：PermissionUpdate 权限更新与持久化

**真实类型与函数签名**
```typescript
// src/types/permissions.ts
export type PermissionUpdateDestination =
  | 'userSettings' | 'projectSettings' | 'localSettings'
  | 'session' | 'cliArg'

export type PermissionUpdate =
  | { type: 'addRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior }
  | { type: 'replaceRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior }
  | { type: 'removeRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior }
  | { type: 'setMode'
      destination: PermissionUpdateDestination
      mode: ExternalPermissionMode }
  | { type: 'addDirectories'
      destination: PermissionUpdateDestination
      directories: string[] }
  | { type: 'removeDirectories'
      destination: PermissionUpdateDestination
      directories: string[] }

// src/utils/permissions/PermissionUpdate.ts
export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate
): ToolPermissionContext

export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[]
): ToolPermissionContext

export function persistPermissionUpdate(update: PermissionUpdate): void
export function persistPermissionUpdates(updates: PermissionUpdate[]): void

export function supportsPersistence(
  destination: PermissionUpdateDestination
): destination is EditableSettingSource
```

**可持久化 vs 仅内存来源**
| 来源 | `supportsPersistence` | 持久化位置 |
|------|----------------------|-----------|
| `userSettings` | `true` | `~/.anthropic/claude.json` |
| `projectSettings` | `true` | `.claude/settings.json` |
| `localSettings` | `true` | `.claude/local.settings.json` |
| `session` | `false` | 仅内存 |
| `cliArg` | `false` | 仅内存 |

**输入输出**
| 输入 | 输出 |
|------|------|
| `context: ToolPermissionContext`（apply） | 更新后的 `ToolPermissionContext` |
| `update: PermissionUpdate`（apply） | 新的 context 对象（不可变） |
| `updates: PermissionUpdate[]`（persist） | `void`（副作用：写入磁盘） |

**上下文状态（修改）**
- `ToolPermissionContext.mode`（`setMode`）
- `ToolPermissionContext.alwaysAllowRules`（`addRules`/`replaceRules`/`removeRules`）
- `ToolPermissionContext.alwaysDenyRules`（同上）
- `ToolPermissionContext.alwaysAskRules`（同上）
- `ToolPermissionContext.additionalWorkingDirectories`（`addDirectories`/`removeDirectories`）

**副作用（可观察）**
| 副作用 | 触发条件 |
|--------|----------|
| 写入 `userSettings` | persist 且 destination 是 userSettings |
| 写入 `projectSettings` | persist 且 destination 是 projectSettings |
| 写入 `localSettings` | persist 且 destination 是 localSettings |
| 记录调试日志（`logForDebugging`） | 所有 apply 操作 |

**权限模式与工具 checkPermissions 的组合**
- `setMode` 仅接受 `ExternalPermissionMode`（`auto` 不能直接设置）
- `auto` 模式通过 feature flag 启用，通过 UI 切换
- `plan` 模式可与 `auto` 组合使用（`isAutoModeActive`）

**失败安全**
- `applyPermissionUpdate` 对未知 `update.type` 返回原 context
- `persistPermissionUpdate` 对不支持的 destination 静默跳过
- 规则去重：`addRules` 不检查重复（允许重复规则存在）
- 目录去重：`addDirectories` 避免添加已存在目录

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 不可变更新 | apply 返回新对象 | 内存分配 | 更易推理，React 友好 |
| 分离 apply 与 persist | 调用方需显式 persist | 容易忘记 persist | 灵活控制何时写入磁盘 |
| 规则标准化 | parse→serialize 圆规正转 | 少量性能开销 | 确保匹配一致性 |
| 备选方案 1 | apply 时自动 persist | 难以批量更新 | 更少的用户错误 |
| 备选方案 2 | 事务性更新 | 实现复杂 | 原子性保证 |

**源码证据**
- `src/utils/permissions/PermissionUpdate.ts:55-354` - 完整实现
- `src/types/permissions.ts:84-147` - 类型定义
- 证据边界：`updateSettingsForSource` 由 settings 模块提供

---

#### 模块设计卡片：用户确认与 UI 集成（useCanUseTool）

**真实类型与函数签名**
```typescript
// src/hooks/useCanUseTool.tsx
export type CanUseToolFn<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = (
  tool: ToolType,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision<Input>,
) => Promise<PermissionDecision<Input>>

function useCanUseTool(
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>,
  setToolPermissionContext: (context: ToolPermissionContext) => void
): CanUseToolFn

// 内部处理器
async function handleCoordinatorPermission(...)
async function handleSwarmWorkerPermission(...)
async function handleInteractivePermission(...)
```

**完整决策路径（React 侧）**
```
useCanUseTool 返回的 CanUseToolFn:
  ├─ 创建 PermissionContext
  ├─ 检查 abort → 已中止 → resolve cancel
  ├─ 调用 hasPermissionsToUseTool（或使用 forceDecision）
  ├─ 记录决策日志（ant-only）
  ├─ 结果为 allow →
  │   ├─ 标记分类器批准（如果是 classifier 原因）
  │   └─ resolve allow
  ├─ 结果为 deny →
  │   ├─ 记录拒绝（auto mode 时）
  │   ├─ 显示通知（auto mode 时）
  │   └─ resolve deny
  └─ 结果为 ask →
      ├─ awaitAutomatedChecksBeforeDialog →
      │   ├─ 执行 coordinator worker 检查
      │   └─ 检查返回决策 → resolve 该决策
      ├─ 检查 abort → 已中止 → resolve cancel
      ├─ Swarm worker →
      │   ├─ 尝试分类器自动批准
      │   ├─ 转发到 leader（通过 mailbox）
      │   └─ 检查返回决策 → resolve 该决策
      ├─ Bash 且有 pendingClassifierCheck →
      │   ├─ 等待最多 2s（投机检查）
      │   ├─ 分类器在窗口期内批准 → resolve allow
      │   └─ 超时或未批准 → 继续
      └─ handleInteractivePermission →
          ├─ 推入 ToolUseConfirm 队列
          ├─ 后台执行 hooks/classifier
          ├─ UI 渲染对应工具的权限组件
          ├─ 用户操作（允许/拒绝/修改输入/添加规则）
          └─ 用户决策后 resolve
```

**输入输出**
| 输入 | 输出 |
|------|------|
| `tool: ToolType` | `Promise<PermissionDecision>` |
| `input: Input` | 最终决策（经过用户/自动化检查） |
| `toolUseContext: ToolUseContext` | 包含 `updatedInput`（用户可能修改） |
| `assistantMessage: AssistantMessage` | 包含 `decisionReason`（最终原因） |
| `toolUseID: string` | 包含 `suggestions`（权限更新建议） |

**上下文状态（读写）**
| 状态 | 读取 | 修改 | 位置 |
|------|------|------|------|
| `ToolUseConfirm` 队列 | 否 | 是（推入） | React 本地状态 |
| `ToolPermissionContext` | 是 | 是（通过 PermissionUpdate） | AppState |
| `classifierApprovals` | 是 | 是（标记批准） | 全局状态 |
| `denialTracking` | 是 | 是（间接通过 persistDenialState） | AppState |

**副作用（可观察）**
| 副作用 | 触发条件 |
|--------|----------|
| 推入 `ToolUseConfirm` 队列 | ask 决策且无自动批准 |
| UI 渲染权限组件 | 队列中有项目 |
| 持久化权限规则 | 用户选择"始终允许" |
| 记录分析事件 | 所有决策（ant-only） |
| 显示拒绝通知 | auto mode 分类器拒绝 |
| 写入错误 prompt 到 /share | auto mode 分类器错误（ant-only） |

**hook/UI 回调与 orphan 权限边界**
| 场景 | 处理方式 | 权限边界 |
|------|----------|----------|
| Coordinator worker | `handleCoordinatorPermission` | `awaitAutomatedChecksBeforeDialog` 标志 |
| Swarm worker | `handleSwarmWorkerPermission` | 通过 mailbox 转发到 leader |
| Orphan（无 UI 上下文） | `shouldAvoidPermissionPrompts` → hooks 优先，否则 deny | `asyncAgent` 决策原因 |
| Bridge 模式 | `replBridgePermissionCallbacks` | 通过桥接回调委托给外部 |
| Kairos/Channels | `channelPermissionCallbacks` | 通过频道委托 |

**孤儿权限（orphan）场景**
- 异步 Agent 无用户交互界面
- 后台工作进程
- `shouldAvoidPermissionPrompts === true`
- 处理：先执行 `PermissionRequest` hooks，无 hook 决策则自动 deny

**失败安全**
- Promise 永远 resolve（不 reject）
- 错误转换为 `cancelAndAbort` 决策
- `AbortError` / `APIUserAbortError` 捕获并正常处理
- 最终总是 `clearClassifierChecking`（finally 块）

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 始终 resolve 的 Promise | 无 reject | 调用方需检查 `behavior === 'deny'` | 更易使用，避免未捕获异常 |
| 分离裁决与 UI | `hasPermissionsToUseTool` 纯逻辑，`useCanUseTool` React 集成 | 两层需要理解 | 可独立测试裁决逻辑 |
| 投机分类器检查窗口期 2s | 硬编码 2000ms | 不够灵活 | 平衡响应性与自动批准率 |
| 备选方案 1 | 可配置窗口期 | 增加复杂度 | 更高灵活性 |
| 备选方案 2 | 并行执行分类器与显示 UI | 用户体验可能混乱 | 更低延迟 |

**源码证据**
- `src/hooks/useCanUseTool.tsx:55-363` - 完整实现
- `src/hooks/toolPermission/handlers/` - 各场景处理器
- 证据边界：UI 组件由 `src/components/permissions/` 提供

---

#### 模块设计卡片：拒绝跟踪与回退

**真实类型与函数签名**
```typescript
// src/utils/permissions/denialTracking.ts
export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}

export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const

export function createDenialTrackingState(): DenialTrackingState
export function recordDenial(state: DenialTrackingState): DenialTrackingState
export function recordSuccess(state: DenialTrackingState): DenialTrackingState
export function shouldFallbackToPrompting(state: DenialTrackingState): boolean

// src/utils/permissions/permissions.ts
function persistDenialState(
  context: ToolUseContext,
  newState: DenialTrackingState
): void

function handleDenialLimitExceeded(...): PermissionDecision | null
```

**拒绝计数状态转换**
| 当前状态 | 事件 | 下一状态 |
|----------|------|----------|
| `{ consecutiveDenials: 0, totalDenials: 0 }` | `recordDenial` | `{ consecutiveDenials: 1, totalDenials: 1 }` |
| `{ consecutiveDenials: 2, totalDenials: 5 }` | `recordDenial` | `{ consecutiveDenials: 3, totalDenials: 6 }` |
| `{ consecutiveDenials: 3, totalDenials: 6 }` | `recordSuccess` | `{ consecutiveDenials: 0, totalDenials: 6 }` |
| `{ consecutiveDenials: 0, totalDenials: 20 }` | `recordDenial` | `{ consecutiveDenials: 1, totalDenials: 21 }` |

**回退触发条件**
| 条件 | 触发回退 |
|------|---------|
| `consecutiveDenials >= 3` | 是（连续拒绝） |
| `totalDenials >= 20` | 是（总拒绝） |
| 两者同时满足 | 是（任一即可） |

**回退行为**
- 回退到用户提示（`ask` 决策）
- 保留分类器拒绝原因作为提示的一部分
- `totalDenials` 回退后重置为 0
- 记录 `tengu_auto_mode_denial_limit_exceeded` 分析事件
- Headless 模式下抛出 `AbortError`（无法提示用户）

**输入输出**
| 输入 | 输出 |
|------|------|
| `state: DenialTrackingState`（`recordDenial`） | 新的 `DenialTrackingState` |
| `state: DenialTrackingState`（`recordSuccess`） | 新的 `DenialTrackingState`（或原引用，如无变化） |
| `state: DenialTrackingState`（`shouldFallbackToPrompting`） | `boolean` |

**上下文状态（读写）**
- `AppState.denialTracking` - 全局拒绝计数
- `context.localDenialTracking` - 异步子 Agent 的本地计数（可选）

**持久化**
- `DenialTrackingState` 不持久化到磁盘
- 仅内存状态，重启归零
- 异步子 Agent 使用本地可变对象（`Object.assign` 原地更新）

**失败安全**
- `recordSuccess` 当 `consecutiveDenials === 0` 时返回原对象引用（避免不必要的状态更新）
- 无状态溢出保护（`totalDenials` 可无限增长，但回退后重置）

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 仅内存状态 | 不持久化 | 重启后计数归零 | 实现简单 |
| 连续拒绝阈值 3 | 硬编码 3 | 不可配置 | 平衡安全与可用性 |
| 总拒绝阈值 20 | 硬编码 20 | 不可配置 | 防止长期滥用 |
| 回退后重置 totalDenials | 完全重置 | 失去历史记录 | 用户可以继续使用 |
| 备选方案 1 | 可配置阈值 | 增加设置复杂度 | 更高灵活性 |
| 备选方案 2 | 持久化拒绝计数 | 增加存储 | 跨会话追踪 |
| 备选方案 3 | 指数退避替代固定阈值 | 逻辑复杂 | 更精细的控制 |

**源码证据**
- `src/utils/permissions/denialTracking.ts:1-45` - 完整实现
- `src/utils/permissions/permissions.ts:887-1058` - `handleDenialLimitExceeded`
- `src/utils/permissions/permissions.ts:963-978` - `persistDenialState`

---

#### 模块设计卡片：Auto Classifier 自动分类器

**真实类型与函数签名**
```typescript
// src/types/permissions.ts
export type YoloClassifierResult = {
  thinking?: string
  shouldBlock: boolean
  reason: string
  unavailable?: boolean
  transcriptTooLong?: boolean
  model: string
  usage?: ClassifierUsage
  durationMs?: number
  promptLengths?: {
    systemPrompt: number
    toolCalls: number
    userPrompts: number
  }
  errorDumpPath?: string
  stage?: 'fast' | 'thinking'
  stage1Usage?: ClassifierUsage
  stage1DurationMs?: number
  stage1RequestId?: string
  stage1MsgId?: string
  stage2Usage?: ClassifierUsage
  stage2DurationMs?: number
  stage2RequestId?: string
  stage2MsgId?: string
}

// src/utils/permissions/permissions.ts
async function classifyYoloAction(...): Promise<YoloClassifierResult>
function formatActionForClassifier(
  toolName: string,
  input: Record<string, unknown>
): string
```

**Auto Fast Path 快速路径（先于分类器）**
| 路径 | 条件 | 结果 |
|------|------|------|
| 1. acceptEdits 模拟 | 工具非 Agent/REPL，且 `tool.checkPermissions` 在 acceptEdits 模式下返回 allow | `allow` |
| 2. 安全工具允许列表 | 工具在预定义安全列表中 | `allow` |
| 3. YOLO 分类器 | 前两条未触发 | 调用分类器 API |

**分类器决策树**
```
classifyYoloAction 返回后:
  ├─ unavailable === true →
  │   ├─ iron_gate_closed === true → deny（分类器不可用）
  │   └─ iron_gate_closed === false → ask（fail-open）
  ├─ transcriptTooLong === true → ask（不重试）
  ├─ shouldBlock === true →
  │   ├─ 记录拒绝计数
  │   ├─ 检查拒绝超限 → 超限 → ask（回退到用户）
  │   └─ 未超限 → deny
  └─ shouldBlock === false → allow
```

**allow/deny/ask 转换表（auto mode）**
| 基础决策 | safetyCheck.approvable | 快速路径/分类器 | 最终决策 |
|----------|------------------------|-----------------|----------|
| allow | N/A | N/A | allow |
| deny | N/A | N/A | deny |
| ask | false | N/A | ask（不可自动批准） |
| ask | true | acceptEdits 允许 | allow |
| ask | true | 安全工具列表 | allow |
| ask | true | 分类器批准 | allow |
| ask | true | 分类器拒绝（未超限） | deny |
| ask | true | 分类器拒绝（超限） | ask（回退） |
| ask | true | 分类器不可用（fail-open） | ask |
| ask | true | 分类器不可用（fail-closed） | deny |
| ask | true | transcriptTooLong | ask |

**分类器输出 ≠ 最终授权**
- 分类器只是输入之一
- 拒绝计数可能回退到用户提示
- `safetyCheck.classifierApprovable === false` 时分类器完全不调用
- 工具 `requiresUserInteraction` 时分类器不调用
- PowerShell 默认不使用分类器（除非 `POWERSHELL_AUTO_MODE`）

**输入输出**
| 输入 | 输出 |
|------|------|
| 对话历史 | `YoloClassifierResult` |
| 工具名 + 输入（格式化后） | `shouldBlock: boolean` |
| 工具列表 | `reason: string` |
| abort signal | `unavailable?: boolean` |
| | `transcriptTooLong?: boolean` |

**上下文状态（读写）**
| 状态 | 读取 | 修改 |
|------|------|------|
| `denialTracking` | 是 | 是（`recordDenial`/`recordSuccess`） |
| `classifierChecking` | 否 | 是（`setClassifierChecking`/`clearClassifierChecking`） |

**副作用（可观察）**
| 副作用 | 触发条件 |
|--------|----------|
| 调用 Anthropic API | 分类器检查 |
| 记录分析事件（`tengu_auto_mode_decision`） | 所有决策 |
| 记录 token 消耗 | 分类器 API 调用 |
| 写入错误 prompt 到 /share | 分类器错误（ant-only） |
| 添加通知 | 分类器错误（ant-only） |
| 增加回合分类器耗时 | 分类器完成后 |

**失败安全**
- API 调用失败 → `unavailable = true`
- `transcriptTooLong` → 回退到 `ask`（不重试，确定性失败）
- `iron_gate_closed` feature flag 控制 fail-close/fail-open（默认 true）
- `CLASSIFIER_FAIL_CLOSED_REFRESH_MS = 30 * 60 * 1000` 刷新间隔

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 两阶段分类器 | fast stage + thinking stage | 复杂度高 | 低延迟 + 高质量 |
| 默认 fail-closed | `iron_gate_closed` 默认 true | 用户体验可能差 | 安全优先 |
| 快速路径先于分类器 | acceptEdits → allowlist → classifier | 路径多，调试难 | 降低延迟和成本 |
| prompt 长度错误不重试 | transcript 只会增长 | 无法恢复 | 避免无限重试 |
| 备选方案 1 | 截断过长的 transcript | 可能降低分类质量 | 可恢复 |
| 备选方案 2 | 本地轻量级分类器替代 API | 模型质量可能差 | 离线可用 |

**源码证据**
- `src/utils/permissions/yoloClassifier.ts` - 分类器调用（未完全展示）
- `src/utils/permissions/permissions.ts:689-927` - auto mode 实现
- `src/types/permissions.ts:348-401` - `YoloClassifierResult` 类型
- 证据边界：分类器提示工程与实际 API 调用在独立模块

---

#### 模块设计卡片：Plan & Bypass 计划与绕过

**真实类型与函数签名**
```typescript
// src/types/permissions.ts
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode
}

// src/utils/permissions/permissions.ts
// (内嵌在 hasPermissionsToUseToolInner 中)
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
   appState.toolPermissionContext.isBypassPermissionsModeAvailable)
```

**bypassPermissions 绕过边界（什么不可绕过）**
| 检查 | 可绕过？ | 说明 |
|------|---------|------|
| deny 规则 | ❌ 否 | 步骤 1a 在 bypass 检查前执行 |
| ask 规则 | ❌ 否 | 步骤 1b 在 bypass 检查前执行 |
| 工具 checkPermissions | ❌ 否 | 步骤 1c 在 bypass 检查前执行 |
| 工具 requiresUserInteraction | ❌ 否 | 步骤 1e 在 bypass 检查前执行 |
| safetyCheck | ❌ 否 | 步骤 1g 在 bypass 检查前执行 |
| allow 规则检查 | ✅ 是 | bypass 在步骤 2a，先于 allow 规则 |
| 用户交互提示 | ✅ 是 | 直接 allow，不进入 ask 路径 |

**plan 模式与 auto 组合**
| plan 模式 | auto 激活 | 行为 |
|-----------|-----------|------|
| plan | 否 | 通常阻止执行，仅显示计划（由 query core 处理） |
| plan | 是 | `isAutoModeActive()` 返回 true → auto mode 逻辑生效 |
| plan + bypass 可用 | 任意 | `shouldBypassPermissions` 为 true → allow |

**prePlanMode 状态**
- 进入 plan 模式前保存原模式
- 退出 plan 模式时恢复
- 用于 `isBypassPermissionsModeAvailable` 判断

**输入输出**
| 输入 | 输出 |
|------|------|
| `ToolPermissionContext.mode` | `shouldBypassPermissions: boolean` |
| `ToolPermissionContext.isBypassPermissionsModeAvailable` | bypass 决策（在 inner 中） |

**上下文状态（读取）**
- `ToolPermissionContext.mode` - 当前模式
- `ToolPermissionContext.isBypassPermissionsModeAvailable` - bypass 是否可用（从 plan 模式）
- `ToolPermissionContext.prePlanMode` - 进入 plan 前的模式

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| bypass 不能绕过安全检查 | deny/ask 规则、工具检查先于 bypass | 命名有误导 | 安全优先 |
| `isBypassPermissionsModeAvailable` 标志 | 保存是否从 bypass 进入 plan | 额外状态 | 支持 plan + bypass 组合 |
| plan 模式本身不改变裁决 | 仅标记，由 query core 处理 | 职责分离 | 权限模块保持简单 |
| 备选方案 1 | bypass 真正绕过一切 | 极不安全 | 命名准确 |
| 备选方案 2 | 移除 bypass 模式 | 功能减少 | 更安全的默认 |

**源码证据**
- `src/types/permissions.ts:429-445` - `ToolPermissionContext` 类型
- `src/utils/permissions/permissions.ts:1269-1281` - `shouldBypassPermissions` 逻辑
- 证据边界：plan 模式执行逻辑在 query core，非本模块所有

---

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

### 7.2 第4章模块设计卡对应源码证据汇总

| 设计卡 | 核心源码文件 | 关键行号 | 说明 |
|--------|-------------|---------|------|
| PermissionMode | `src/types/permissions.ts` | 13-45 | 类型定义与枚举 |
| | `src/utils/permissions/PermissionMode.ts` | 1-142 | 模式工具函数与配置 |
| 规则匹配与优先级 | `src/utils/permissions/permissions.ts` | 109-390 | 规则收集、匹配、优先级 |
| | `src/utils/permissions/permissionSetup.ts` | 87-145 | 危险规则检测 |
| hasPermissionsToUseTool | `src/utils/permissions/permissions.ts` | 473-1320 | 核心裁决实现 |
| | `src/utils/permissions/permissions.ts` | 1158-1320 | Inner 函数（基础裁决） |
| | `src/utils/permissions/permissions.ts` | 1071-1156 | Rule-based 检查 |
| PermissionUpdate | `src/types/permissions.ts` | 84-147 | 类型定义 |
| | `src/utils/permissions/PermissionUpdate.ts` | 55-354 | apply 与 persist 实现 |
| 用户确认与 UI | `src/hooks/useCanUseTool.tsx` | 55-363 | React hook 集成 |
| | `src/hooks/toolPermission/handlers/` | - | 各场景处理器 |
| 拒绝跟踪 | `src/utils/permissions/denialTracking.ts` | 1-45 | 计数与回退逻辑 |
| | `src/utils/permissions/permissions.ts` | 887-1058 | 超限处理 |
| Auto Classifier | `src/types/permissions.ts` | 348-401 | 结果类型定义 |
| | `src/utils/permissions/permissions.ts` | 689-927 | Auto mode 路径 |
| Plan & Bypass | `src/types/permissions.ts` | 429-445 | Context 类型 |
| | `src/utils/permissions/permissions.ts` | 1269-1281 | Bypass 判断逻辑 |

注：本 spec 不虚构测试通过声明，上述测试场景与不变量标注"需查找相关测试"表示当前阶段未定位到对应测试文件。

### 7.3 未覆盖行为（基于代码阅读）

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
| P2 | 跨层：ReviewArtifact 权限委托边界缺陷（主修复见 review-analysis spec） | - | - | 遵循 review-analysis spec 验收标准，确保与工具输入契约集成正确 | - | 跨层说明 |
