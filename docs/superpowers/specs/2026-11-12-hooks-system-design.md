---
id: hooks-system
batch: 7
title: Hooks System 事件钩子配置与执行设计
date: 2026-11-12
status: draft
---

# Hooks System 事件钩子配置与执行设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 的 Hooks System 需要解决以下核心问题：

- 事件驱动扩展：用户需要在系统各事件点插入自定义逻辑，无需修改核心代码
- 多种钩子类型：支持命令脚本、HTTP 请求、Prompt 调用、Agent 调用等多种方式
- 安全边界：钩子执行需要工作区信任确认，防止恶意代码执行
- 失败隔离：单个钩子失败不应影响其他钩子或主流程
- 同步/异步模式：支持同步阻塞主流程和异步后台执行两种模式
- 权限决策：钩子可以影响工具执行权限（允许/拒绝/询问）
- 超时控制：防止钩子执行时间过长阻塞系统
- 事件匹配：支持按工具名、Agent 类型、通知类型等条件匹配
- 输入输出结构化：JSON 格式输入输出，便于编程处理
- 跨平台兼容：Windows/macOS/Linux 都需要支持，shell 选择需要适配
- 异步唤醒：异步钩子执行完成后可以唤醒主流程继续
- SSRF 防护：HTTP 钩子需要防止服务端请求伪造
- 环境变量安全：防止敏感环境变量泄露

关键约束条件：

- 所有钩子（包括 SessionEnd）需要工作区信任确认
- SessionEnd 钩子使用短超时（默认 1.5 秒），防止阻塞退出
- HTTP 钩子不支持 SessionStart/Setup 事件（启动早期 UI/回调可能未就绪）
- 同一 source 内相同命令去重执行
- asyncRewake 不 spill to disk，保留内存缓冲
- Header 插值仅允许白名单环境变量
- 退出码约定：0=success，1=non-blocking error，2=blocking error

## 2. 设计理由与备选方案

### 决策 1：所有钩子需要工作区信任（包括 SessionEnd）

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | SessionEnd 钩子在用户拒绝信任后仍可能被触发 |
| 方案 | `shouldSkipHookDueToTrust()` 在执行前检查，非交互模式除外 |
| 替代 | 仅"危险"钩子需要信任（难以界定） |
| 代价 | 非信任工作区无法使用钩子功能 |
| 证据 | 历史漏洞：SessionEnd 在拒绝信任后执行 |

### 决策 2：异步钩子使用首行 JSON 协议 + 注册表

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | 钩子需要长时间运行，不应阻塞用户 |
| 方案 | 首行 `{"async": true}` 检测 + `AsyncHookRegistry` 管理后台进程 |
| 替代 | 仅配置驱动异步（不灵活）；分离的守护进程（复杂） |
| 代价 | 需要轮询检查完成；输出缓冲内存占用 |
| 证据 | `AsyncHookRegistry.ts` + `executeInBackground()` |

### 决策 3：退出码 2 表示 blocking 错误，1 表示 non-blocking

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | 需要区分"停止流程"和"仅通知用户" |
| 方案 | 0=success，1=non-blocking，2=blocking |
| 替代 | 仅通过 JSON 输出（对简单脚本不友好） |
| 代价 | 用户需要记忆退出码约定 |
| 证据 | `hooks.ts` 中 `result.status === 2` 检查 |

### 决策 4：HTTP 钩子不支持 SessionStart/Setup

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | 早期启动阶段 UI/回调可能未就绪，死锁风险 |
| 方案 | 在 `getMatchingHooks()` 中过滤掉这些事件的 HTTP 钩子 |
| 替代 | 重构启动顺序（风险高） |
| 代价 | 功能限制；用户可能困惑 |
| 证据 | `getMatchingHooks()` 中的 HTTP 钩子过滤逻辑 |

### 决策 5：同一 source 内相同命令去重

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | 用户/项目/本地配置可能重复定义相同钩子 |
| 方案 | `hookDedupKey = source + command/prompt/url + if`，Map 去重 |
| 替代 | 完全不做去重（冗余执行）；强制用户手动去重（不友好） |
| 代价 | 同一命令无法以不同 `if` 条件多次执行（用不同 matcher 解决） |
| 证据 | `getMatchingHooks()` 中的 `uniqueCommandHooks`/`uniquePromptHooks` |

### 决策 6：asyncRewake 不 spill to disk

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | asyncRewake 需要在唤醒时重新读取输出，但 spill to disk 会丢失 |
| 方案 | `asyncRewake: true` 跳过 `shellCommand.background()`，保留内存缓冲 |
| 替代 | 总是保留内存（内存占用高）；spill to disk 后重新读取（复杂） |
| 代价 | 长时间运行的 asyncRewake 钩子占用内存 |
| 证据 | `executeInBackground()` 中 `asyncRewake` 分支 |

### 决策 7：组合 abort signal（用户取消 + 超时）

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | 需要同时支持用户按 Escape 取消和超时自动取消 |
| 方案 | `createCombinedAbortSignal(signal, {timeoutMs})` |
| 替代 | 手动管理两个 signal（易出错） |
| 代价 | 额外的抽象层；需要确保 cleanup 被调用 |
| 证据 | `execCommandHook()`、`execHttpHook()`、`execPromptHook()` 中的用法 |

### 决策 8：HTTP 钩子 Header 仅允许白名单 env var

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | Header 插值可能泄露 secrets（如 Authorization: $GITHUB_TOKEN） |
| 方案 | `allowedEnvVars` 显式列出，未允许的替换为空 |
| 替代 | 完全禁止插值（不灵活）；信任用户配置（不安全） |
| 代价 | 用户需要显式声明使用的变量 |
| 证据 | `execHttpHook.ts` 的 `interpolateEnvVars()` |

### 决策 9：Prompt 钩子使用小模型（Haiku）

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | 钩子执行需要快速，不应花费高成本/延迟 |
| 方案 | `getSmallFastModel()`（Haiku），可通过 `model` 字段覆盖 |
| 替代 | 总是使用主模型（慢/贵） |
| 代价 | 复杂判断可能能力不足 |
| 证据 | `execPromptHook.ts` 中的 `hook.model ?? getSmallFastModel()` |

### 决策 10：SessionEnd 钩子使用短超时（1.5 秒）

| 维度 | 说明 |
|-----|------|
| 状态 | 采用 |
| 问题 | 用户关闭会话时不应等待长时间 |
| 方案 | 默认 1.5 秒，环境变量可配置 |
| 替代 | 使用相同的 10 分钟超时（体验差） |
| 代价 | 复杂的清理脚本可能超时 |
| 证据 | `SESSION_END_HOOK_TIMEOUT_MS_DEFAULT` 和 `getSessionEndHookTimeoutMs()` |

## 3. 目标与非目标

### 目标

- **多事件点集成**：30+ 钩子事件点覆盖工具执行、会话生命周期、通知、配置变更等场景
- **多类型钩子**：Command（Shell 脚本）、HTTP、Prompt（LLM 判断）、Agent（Agent 调用）
- **事件匹配**：支持工具名、Agent 类型、通知类型等条件匹配
- **同步/异步执行**：同步阻塞主流程、异步后台执行，支持 asyncRewake 唤醒
- **输入/输出结构化**：JSON 格式输入输出，支持 permission decision、additional context 等
- **失败隔离**：单个钩子失败不影响其他钩子执行，区分 blocking 和 non-blocking 错误
- **安全优先**：所有钩子需要工作区信任确认，HTTP 钩子 SSRF 防护
- **超时控制**：每个钩子有独立超时，SessionEnd 钩子有更短超时
- **跨平台兼容**：支持 Windows/macOS/Linux，shell 选择适配
- **权限决策**：钩子可以返回 permission decision（allow/deny/ask）影响工具执行

### 非目标

- 不实现钩子市场（用户自己管理钩子配置）
- 不支持钩子热重载（需要重启 CLI）
- 不实现钩子调试器（用户使用常规调试工具）
- 不支持分布式钩子执行（仅本地）
- 不实现钩子版本管理（用户自己负责版本）
- 不替代 MCP（MCP 用于工具集成，钩子用于事件响应）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 钩子执行入口
function executeHooksForEvent(
  event: HookEvent,
  context: HookExecutionContext,
  options?: ExecuteHooksOptions
): Promise<HookExecutionResult>

// 钩子配置加载
function loadHooksConfig(): Promise<HooksConfig>
function getMatchingHooks(
  event: HookEvent,
  context: HookMatchingContext
): Hook[]

// 异步钩子注册表
class AsyncHookRegistry {
  static getInstance(): AsyncHookRegistry
  registerPendingAsyncHook(hook: PendingAsyncHook): void
  checkForAsyncHookResponses(): Promise<AsyncHookResponse[]>
  removeDeliveredAsyncHook(id: string): void
  finalizePendingAsyncHooks(): Promise<void>
}

// 钩子类型定义
type Hook = CommandHook | HttpHook | PromptHook | AgentHook

type HookEvent =
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'post-tool-use-failure'
  | 'permission-denied'
  | 'permission-request'
  | 'session-start'
  | 'session-end'
  | 'setup'
  | 'instructions-loaded'
  | 'stop'
  | 'stop-failure'
  | 'pre-compact'
  | 'post-compact'
  | 'user-prompt-submit'
  | 'subagent-start'
  | 'subagent-stop'
  | 'teammate-idle'
  | 'task-created'
  | 'task-completed'
  | 'elicitation'
  | 'elicitation-result'
  | 'file-changed'
  | 'cwd-changed'
  | 'config-change'
  | 'notification'
  | 'worktree-create'
  | 'worktree-remove'

// 钩子输出
interface HookOutput {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: 'approve' | 'block' | 'ask'
  reason?: string
  permissionDecision?: 'allow' | 'deny' | 'ask'
  hookSpecificOutput?: {
    hookEventName: string
    permissionDecision?: 'allow' | 'deny' | 'ask'
    permissionDecisionReason?: string
    additionalContext?: string
    updatedInput?: Record<string, unknown>
    updatedMCPToolOutput?: unknown
    watchPaths?: string[]
    initialUserMessage?: string
    retry?: boolean
  }
}
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要职责 | 不承担的职责 |
|-----|----------|---------|------------|
| `hooks.ts` | 无（纯函数） | `executeHooksForEvent()`、`getMatchingHooks()`、结果聚合 | 具体钩子类型执行 |
| `execCommandHook.ts` | 无（纯函数） | Command 钩子执行、shell 选择、路径转换 | 钩子匹配 |
| `execHttpHook.ts` | 无（纯函数） | HTTP 钩子执行、SSRF 防护、Header 插值 | 钩子匹配 |
| `execPromptHook.ts` | 无（纯函数） | Prompt 钩子执行、小模型选择 | 钩子匹配 |
| `execAgentHook.ts` | 无（纯函数） | Agent 钩子执行 | 钩子匹配 |
| `AsyncHookRegistry.ts` | `pendingHooks: Map` | 异步钩子注册、完成检查、清理 | 同步钩子执行 |
| `hookEvents.ts` | 无（纯函数） | 钩子事件定义、事件数据构造 | 钩子执行 |
| `hookTrust.ts` | 无（纯函数） | `shouldSkipHookDueToTrust()` 检查 | 钩子执行 |
| `hookTimeout.ts` | 无（纯函数） | 超时计算、SessionEnd 特殊处理 | 钩子执行 |
| `shellCommand.ts` | 子进程状态 | Shell 命令执行、输出缓冲、后台模式 | 钩子逻辑 |
| `hooksConfig.ts` | 无（纯函数） | 配置加载、验证、合并 | 钩子执行 |

### 4.3 主控制流

#### 钩子执行主流程

```
事件触发（如 pre-tool-use）
    ↓
loadHooksConfig() 加载配置
    ↓
getMatchingHooks() 匹配钩子
    ├─ 按事件类型匹配
    ├─ 按工具名/Agent 类型/通知类型匹配
    ├─ 去重（同一 source 相同命令）
    └─ 过滤 HTTP 钩子（SessionStart/Setup 事件）
    ↓
shouldSkipHookDueToTrust() 检查信任
    ├─ 未信任 → 跳过（非交互模式除外）
    └─ 已信任 → 继续
    ↓
Promise.allSettled() 并行执行所有匹配钩子
    ↓
每个钩子执行：
    ├─ 检查首行是否 {"async": true}
    ├─ 同步 → 等待完成，解析输出
    └─ 异步 → 注册到 AsyncHookRegistry，立即返回
    ↓
聚合结果：
    ├─ 优先 blocking 错误
    ├─ 合并 permission decision（deny > ask > allow）
    ├─ 合并 system messages
    └─ 合并 additional context
    ↓
发出 HookResponse 事件
    ↓
返回结果给调用者
```

#### Command 钩子执行流程

```
选择 shell（hook.shell → DEFAULT_HOOK_SHELL → bash）
    ↓
环境变量准备：
    ├─ 插值插件变量（${CLAUDE_PLUGIN_ROOT} 等）
    ├─ 路径转换（Windows bash 需要 POSIX 路径）
    └─ 设置 CLAUDE_ENV_FILE（PowerShell 除外）
    ↓
构造命令行
    ↓
创建 ShellCommand
    ↓
asyncRewake=true → 跳过 background()，保留内存缓冲
asyncRewake=false → 可选 background()，spill to disk
    ↓
写入 hook input JSON 到 stdin
    ↓
执行（超时 + 用户取消 signal 组合）
    ↓
读取 stdout/stderr
    ↓
解析输出：
    ├─ 首行检查 {"async": true, asyncTimeout}
    ├─ JSON 解析 + Zod 验证
    └─ 无效 → 当作文本处理
    ↓
根据退出码判断：
    ├─ 0 → success
    ├─ 1 → non-blocking error
    └─ 2 → blocking error
```

#### HTTP 钩子执行流程

```
SSRF 防护检查 URL
    ├─ 沙箱模式 → 强制代理 + 域检查
    └─ 非沙箱 → SSRF guard 检查 IP（允许 localhost）
    ↓
Header 插值：
    ├─ 仅允许 allowedEnvVars 列表中的变量
    ├─ 未允许的替换为空
    └─ 插值后 sanitize（移除 CR/LF/NUL）
    ↓
构造请求：
    ├─ POST 请求
    ├─ Content-Type: application/json
    ├─ Body: hook input JSON
    └─ 超时 + 用户取消 signal 组合
    ↓
发送请求（maxRedirects: 0）
    ↓
解析响应 JSON
    ↓
返回结果
```

#### 异步钩子唤醒流程

```
主流程轮询 checkForAsyncHookResponses()
    ↓
检查每个 pending hook 是否完成
    ↓
完成的钩子：
    ├─ 解析输出
    ├─ exit code 2 → enqueuePendingNotification 唤醒
    └─ 其他 → 仅显示通知
    ↓
用户看到通知，可选择查看结果
    ↓
removeDeliveredAsyncHook() 清理已送达的钩子
    ↓
会话结束时 finalizePendingAsyncHooks() 强制清理所有
```

### 4.4 数据结构

```typescript
// 钩子配置
interface HooksConfig {
  version: 1
  hooks: Hook[]
}

// Command 钩子
interface CommandHook {
  type: 'command'
  command: string
  shell?: 'bash' | 'powershell'
  timeout?: number
  async?: boolean
  asyncRewake?: boolean
  if?: string
  events: HookEvent[]
  tools?: string[]
  agents?: string[]
  notifications?: string[]
}

// HTTP 钩子
interface HttpHook {
  type: 'http'
  url: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]
  timeout?: number
  if?: string
  events: HookEvent[]
  tools?: string[]
  agents?: string[]
  notifications?: string[]
}

// Prompt 钩子
interface PromptHook {
  type: 'prompt'
  prompt: string
  model?: string
  timeout?: number
  if?: string
  events: HookEvent[]
  tools?: string[]
  agents?: string[]
  notifications?: string[]
}

// Agent 钩子
interface AgentHook {
  type: 'agent'
  prompt: string
  timeout?: number
  if?: string
  events: HookEvent[]
  tools?: string[]
  agents?: string[]
  notifications?: string[]
}

// 异步钩子
interface PendingAsyncHook {
  id: string
  hook: Hook
  event: HookEvent
  startTime: number
  timeout: number
  shellCommand?: ShellCommand
  asyncRewake: boolean
}

interface AsyncHookResponse {
  id: string
  output: HookOutput
  exitCode: number
  stdout: string
  stderr: string
}
```

### 4.4 模块设计卡

#### 4.4.1 钩子匹配与配置 (hook matching & config)

**真实入口签名与关键类型**

```typescript
// src/utils/hooks.ts
export async function getMatchingHooks(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
  hookInput: HookInput,
  tools?: Tools
): Promise<MatchedHook[]>

// 配置类型 (src/utils/settings/types.ts)
type HookCommand = CommandHook | HttpHook | PromptHook | AgentHook

type HookMatcher = {
  matcher?: string              // 匹配模式：工具名/Agent类型等
  hooks: HookCommand[]          // 匹配后执行的钩子列表
  pluginName?: string
}

type CommandHook = {
  type: 'command'
  command: string
  shell?: 'bash' | 'powershell'
  timeout?: number              // 秒
  async?: boolean
  asyncRewake?: boolean
  if?: string                   // 条件匹配语法 (如 "Bash(git *)")
  statusMessage?: string
  once?: boolean
}

type HttpHook = {
  type: 'http'
  url: string
  headers?: Record<string, string>
  allowedEnvVars?: string[]     // 允许插值的环境变量白名单
  timeout?: number
  if?: string
}

type PromptHook = {
  type: 'prompt'
  prompt: string
  model?: string
  timeout?: number
  if?: string
}

type AgentHook = {
  type: 'agent'
  prompt: string
  model?: string
  timeout?: number
  if?: string
}
```

**输入输出**

| 阶段 | 输入 | 输出 |
|-----|------|------|
| 配置加载 | settings.json、plugin hooks、session hooks | `HookMatcher[]` 按事件分组 |
| 事件匹配 | `HookEvent`, `HookInput`, match query | 过滤后的 `HookMatcher[]` |
| `if` 条件评估 | `if` string (如 "Bash(git *)"), tool input | boolean |
| 去重 | 相同 source 内的相同命令 | 去重后的 `MatchedHook[]` |

**注册与执行状态**

```typescript
// 配置来源 (多来源合并)
type HookSource = 
  | 'settings'        // 用户配置
  | 'plugin'          // 插件注册
  | 'skill'           // 技能注册
  | 'session'         // 会话临时注册 (agent frontmatter等)

// 去重键生成 (source namespace隔离)
function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}

// 匹配器类型
type MatcherType =
  | 'exact'           // 精确匹配 (如 "Write")
  | 'pipe'            // 管道分隔列表 (如 "Write|Edit")
  | 'regex'           // 正则表达式 (如 "^Write.*")
  | 'if-condition'    // if 条件 (如 "Bash(git *)")
```

**配置、匹配、执行、超时、清理流程**

```
配置加载
  ├─ 从快照加载: getHooksConfigFromSnapshot()
  ├─ 从注册加载: getRegisteredHooks()
  ├─ 从会话加载: getSessionHooks() + getSessionFunctionHooks()
  └─ managed hooks 过滤: shouldAllowManagedHooksOnly()
       ↓
匹配阶段
  ├─ 事件筛选: 按 HookEvent 过滤
  ├─ matcher 匹配: matchesPattern(query, matcher)
  │   ├─ 精确匹配 (normalize legacy tool names)
  │   ├─ 管道分隔列表 (| split)
  │   └─ 正则匹配
  ├─ if 条件评估: prepareIfConditionMatcher()
  │   ├─ 仅 tool 事件支持
  │   ├─ parse permission rule syntax
  │   └─ tool.preparePermissionMatcher()
  ├─ 去重: new Map() 保持最后一个
  │   ├─ command: shell + command + if
  │   ├─ prompt/agent: prompt + if
  │   ├─ http: url + if
  │   └─ callback/function: 跳过 (每个唯一)
  └─ HTTP 钩子过滤: SessionStart/Setup 事件不支持
       ↓
执行阶段 (见 4.4.2-4.4.5)
       ↓
超时与清理
  ├─ 每个钩子独立超时: createCombinedAbortSignal()
  ├─ SessionEnd 特殊超时: 1.5s 默认
  └─ 异步钩子最终清理: finalizePendingAsyncHooks()
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| 无效 if 条件 | 跳过该钩子, log | 不执行不确定的钩子 |
| 无效正则 | 跳过该钩子, log | 拒绝服务防护 |
| managed only 模式 | 非 managed hooks 过滤 | 策略执行 |
| 配置解析失败 | 加载失败, 拒绝启动 | 配置验证 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| 去重策略 | 保留最后一个 (Map) | 用户/本地配置覆盖项目配置 | 保留第一个；合并执行 |
| source 命名空间 | plugin/skill 独立隔离 | 避免跨插件钩子去重冲突 | 全局去重 |
| if 条件评估 | 仅 tool 事件支持 | 其他事件缺少 tool 上下文 | 扩展到更多事件类型 |
| matcher 语法 | 多模式 (exact/pipe/regex) | 灵活性与易用性平衡 | 仅正则；仅精确匹配 |

**源码测试证据**

- 源码: `src/utils/hooks.ts` (lines 1346-1874, `getMatchingHooks()`, `matchesPattern()`, `prepareIfConditionMatcher()`)
- 配置 Schema: `src/schemas/hooks.ts` (HookMatcherSchema, HookCommandSchema)
- 测试: 未覆盖 (见 7.2)

---

#### 4.4.2 AsyncHookRegistry (异步钩子注册表)

**真实入口签名与关键类型**

```typescript
// src/utils/hooks/AsyncHookRegistry.ts
export type PendingAsyncHook = {
  processId: string
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  startTime: number
  timeout: number
  command: string
  responseAttachmentSent: boolean
  shellCommand?: ShellCommand
  stopProgressInterval: () => void
}

export function registerPendingAsyncHook({
  processId,
  hookId,
  asyncResponse,
  hookName,
  hookEvent,
  command,
  shellCommand,
  toolName,
  pluginId,
}: {
  processId: string
  hookId: string
  asyncResponse: AsyncHookJSONOutput
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  command: string
  shellCommand: ShellCommand
  toolName?: string
  pluginId?: string
}): void

export function getPendingAsyncHooks(): PendingAsyncHook[]

export async function checkForAsyncHookResponses(): Promise<Array<{
  processId: string
  response: SyncHookJSONOutput
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  stdout: string
  stderr: string
  exitCode?: number
}>>

export function removeDeliveredAsyncHooks(processIds: string[]): void

export async function finalizePendingAsyncHooks(): Promise<void>

// 测试工具 (仅测试用)
export function clearAllAsyncHooks(): void
```

**输入输出**

| 操作 | 输入 | 输出 | 状态变化 |
|-----|------|------|---------|
| 注册 | processId, hookId, asyncResponse, shellCommand | void | `pendingHooks.set(processId, ...)` |
| 检查完成 | (无) | `AsyncHookResponse[]` | `responseAttachmentSent = true` |
| 清理已送达 | processIds[] | void | `pendingHooks.delete()` |
| 最终清理 | (无) | void | `pendingHooks.clear()` |

**注册与执行状态**

```typescript
// 全局单例状态
const pendingHooks = new Map<string, PendingAsyncHook>()

// 异步钩子生命周期
type AsyncHookLifecycle =
  | 'registered'         // 刚注册, 进程运行中
  | 'checking'           // 正在检查完成
  | 'completed-sent'     // 完成, 响应已发送
  | 'finalizing'         // 会话结束, 强制清理中
  | 'removed'            // 已从注册表移除

// PendingAsyncHook 字段解释
{
  processId: `async_hook_${pid}`,  // 唯一标识
  hookId: randomUUID(),            // 钩子 ID
  hookName: 'PreToolUse:Write',    // 显示名称
  hookEvent: 'PreToolUse',         // 触发事件
  toolName?: 'Write',              // 关联工具
  pluginId?: 'my-plugin',          // 关联插件
  startTime: Date.now(),           // 注册时间
  timeout: asyncTimeout ?? 15000,  // 超时 (ms)
  command: 'node my-hook.js',      // 原始命令
  responseAttachmentSent: false,   // 是否已发送响应
  shellCommand: ShellCommand,      // 进程包装
  stopProgressInterval: () => void // 清理进度显示
}
```

**配置、匹配、执行、超时、清理流程**

```
注册 (来自 execCommandHook)
  ├─ asyncRewake = true: 不注册, 直接 inline 处理
  │   └─ shellCommand.result.then() 内联等待
  ├─ asyncRewake = false: 注册到 registry
  │   ├─ shellCommand.background() 启用
  │   ├─ 启动 progress interval
  │   └─ pendingHooks.set(processId, hook)
       ↓
检查完成 (主循环轮询)
  ├─ 快照 pending hooks (避免并发修改)
  ├─ 对每个钩子:
  │   ├─ 无 shellCommand: 直接移除
  │   ├─ killed: 移除
  │   ├─ not completed: 跳过
  │   ├─ 已发送响应: 移除
  │   └─ stdout 为空: 移除
  ├─ 解析 JSON 输出 (跳过首行 async)
  ├─ emitHookResponse()
  ├─ 收集响应到结果数组
  └─ 从 pendingHooks 删除已处理钩子
       ↓
移除已送达
  └─ 对每个 processId, 检查 responseAttachmentSent 后删除
       ↓
最终清理 (会话结束)
  ├─ 对每个 pending hook:
  │   ├─ completed: emit response
  │   └─ not killed: kill()
  │       └─ emit as cancelled
  └─ pendingHooks.clear()
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| 进程崩溃 | 解析现有 stdout/stderr, 标记为 error | 不丢失已输出数据 |
| 超时 | 最终清理时 kill, 标记 cancelled | 资源泄漏防护 |
| JSON 解析失败 | 当作文本, 不解析 response | 容错处理 |
| 重复 processId | Map 自动覆盖 (后注册优先) | 避免孤儿记录 |
| SessionStart 钩子完成 | invalidateSessionEnvCache() | 环境变量一致性 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| asyncRewake 处理 | 不注册, inline then | 唤醒时需要内存中的 stdout/stderr | 注册 + spill to disk + 重新读取 |
| 完成检查时机 | 主循环轮询 | 简单, 可预测 | event-driven; 回调 |
| 响应发送语义 | 一次发送, 立即移除 | 避免重复通知 | 保留历史; 持久化 |
| 最终清理策略 | 强制 kill + 发送 cancelled | 会话退出不阻塞 | 等待完成; 跨会话恢复 |
| 超时 | asyncTimeout 可选, 默认 15s | 平衡灵活性与安全性 | 强制固定超时 |

**源码测试证据**

- 源码: `src/utils/hooks/AsyncHookRegistry.ts` (完整文件)
- 集成调用: `src/utils/hooks.ts` (lines 184-265, `executeInBackground()`)
- 测试: 未覆盖 (见 7.2)

---

#### 4.4.3 Command Hook 执行 (execCommandHook)

**真实入口签名与关键类型**

```typescript
// src/utils/hooks.ts (execCommandHook 内联在主文件中)
async function execCommandHook(
  hook: HookCommand & { type: 'command' },
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion',
  hookName: string,
  jsonInput: string,
  signal: AbortSignal,
  hookId: string,
  hookIndex?: number,
  pluginRoot?: string,
  pluginId?: string,
  skillRoot?: string,
  forceSyncExecution?: boolean,
  requestPrompt?: (request: PromptRequest) => Promise<PromptResponse>
): Promise<{
  stdout: string
  stderr: string
  output: string
  status: number
  aborted?: boolean
  backgrounded?: boolean
}>

// 相关类型
type ShellType = 'bash' | 'powershell'
type ProcessEnv = NodeJS.ProcessEnv & {
  CLAUDE_PROJECT_DIR: string
  CLAUDE_PLUGIN_ROOT?: string
  CLAUDE_PLUGIN_DATA?: string
  CLAUDE_ENV_FILE?: string
  [key: string]: string | undefined
}
```

**输入输出**

| 阶段 | 输入 | 输出 | 说明 |
|-----|------|------|------|
| 准备 | hook, jsonInput, signal | `ChildProcess` | 环境变量、路径转换 |
| stdin 写入 | jsonInput + '\n' | void | UTF-8 编码 |
| 执行等待 | (无) | exit code, stdout, stderr | timeout + 用户取消 |
| 异步检测 | stdout 首行 | `{async: true}?` | 首行 JSON 协议 |
| 输出解析 | stdout | `HookJSONOutput?` + plain text | Zod 验证 |

**注册与执行状态**

```typescript
// 执行路径分支
type ExecutionPath =
  | 'sync-blocking'       // 同步执行, 等待完成
  | 'async-config'        // 配置 async: true, 立即后台
  | 'async-response'      // 首行 {"async": true}, 后台
  | 'async-rewake'        // asyncRewake: true, 内联处理

// 内部执行状态
type ExecState = {
  child: ChildProcessWithoutNullStreams
  hookTaskOutput: TaskOutput
  shellCommand: ShellCommand
  stdout: string
  stderr: string
  initialResponseChecked: boolean
  promptChain: Promise<void>
  processedPromptLines: Set<string>
}
```

**配置、匹配、执行、超时、清理流程**

```
前置检查
  ├─ pluginRoot 存在?
  │   └─ 不存在 → throw (避免 exit code 2 误判)
  ├─ 工作区信任?
  │   └─ 未信任 → 跳过 (shouldSkipHookDueToTrust)
  └─ cwd 存在?
      └─ 不存在 → 回退到 originalCwd
       ↓
Shell 选择
  ├─ hook.shell → DEFAULT_HOOK_SHELL ('bash')
  ├─ PowerShell: 跳过路径转换、ENV_FILE、bash 前缀
  └─ bash (Windows):
      ├─ findGitBashPath() (硬退出)
      ├─ Windows → POSIX 路径转换
      └─ .sh 文件自动前置 'bash '
       ↓
环境变量
  ├─ CLAUDE_PROJECT_DIR (POSIX 格式)
  ├─ CLAUDE_PLUGIN_ROOT / _DATA
  ├─ 插件选项: CLAUDE_PLUGIN_OPTION_*
  └─ CLAUDE_ENV_FILE (仅 bash, 仅某些事件)
       ↓
命令插值
  ├─ ${CLAUDE_PLUGIN_ROOT} → 替换 (function form 避免 $ 重新解释)
  ├─ ${user_config.X} → 插件选项替换
  └─ CLAUDE_CODE_SHELL_PREFIX → 包装 (仅 bash)
       ↓
Spawn
  ├─ PowerShell: pwsh -NoProfile -NonInteractive -Command
  ├─ bash: shell=true (Git Bash on Windows)
  └─ windowsHide: true (Windows 无控制台窗口)
       ↓
Async 快速路径 (配置 async/asyncRewake)
  ├─ 先写 stdin (总是)
  ├─ asyncRewake: executeInBackground() 内联处理
  │   └─ 不 spill to disk, 保留内存缓冲
  └─ async: executeInBackground() 注册到 registry
       ↓
同步执行路径
  ├─ stdout/stderr data 事件收集
  ├─ 首行检查: {"async": true}?
  │   └─ 是 → executeInBackground(), 提前返回
  ├─ prompt request 检测 (requestPrompt 存在时)
  │   ├─ 解析 {"prompt": id, ...}
  │   ├─ promptChain 序列化响应
  │   ├─ 跟踪 processedPromptLines 从 stdout 剥离
  │   └─ child.stdin.write(response)
  ├─ stdin 写入错误处理
  │   ├─ EPIPE → non-blocking error
  │   └─ ABORT_ERR → aborted
  ├─ 等待 close 事件
  └─ stdout/stderr/exit code 返回
       ↓
超时与取消
  ├─ createCombinedAbortSignal(signal, {timeoutMs})
  │   ├─ hook.timeout → TOOL_HOOK_EXECUTION_TIMEOUT_MS (10m)
  │   └─ SessionEnd → 1.5s 默认
  ├─ signal 触发 → shellCommand.kill()
  └─ cleanup 总是调用 (除非 transferred to registry)
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| 插件目录不存在 | 提前 throw | 避免 exit code 2 被误判为 blocking |
| stdin EPIPE | 返回 non-blocking error | 钩子提前退出不阻塞主流程 |
| 超时 | 返回 aborted | 拒绝服务防护 |
| JSON 验证失败 | 当作文本, 继续 | 容错处理 |
| 未信任工作区 | 跳过所有钩子 | 安全边界 |
| PowerShell 无 pwsh | throw | 清晰错误信息 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| Shell 选择 | hook.shell → DEFAULT_HOOK_SHELL | 显式配置优先 | 全局 defaultShell 设置 |
| 路径转换 | Windows bash 自动 POSIX | Git Bash 兼容性 | 要求用户手动转换 |
| .sh 自动前置 | Windows + .sh → 加 'bash ' | 易用性 | 强制显式配置 |
| env var 插值 | function form replace | 避免 $ 二次解释 | 模板字符串 |
| 异步检测位置 | stdout 首行 | 无需配置, 灵活 | 仅配置驱动 |
| 退出码语义 | 0=success,1=error,2=blocking | 区分阻塞与非阻塞 | JSON 仅返回决策 |
| CLAUDE_ENV_FILE | 仅 bash, 仅某些事件 | PowerShell 不兼容 | 独立 PowerShell 格式 |

**源码测试证据**

- 源码: `src/utils/hooks.ts` (lines 747-1337, `execCommandHook()`)
- Shell 包装: `src/utils/shellCommand.ts`
- 路径转换: `src/utils/windowsPaths.ts`
- 测试: 未覆盖 (见 7.2)

---

#### 4.4.4 HTTP Hook 执行 (execHttpHook)

**真实入口签名与关键类型**

```typescript
// src/utils/hooks/execHttpHook.ts
const DEFAULT_HTTP_HOOK_TIMEOUT_MS = 10 * 60 * 1000

export async function execHttpHook(
  hook: HttpHook,
  _hookEvent: HookEvent,
  jsonInput: string,
  signal?: AbortSignal
): Promise<{
  ok: boolean
  statusCode?: number
  body: string
  error?: string
  aborted?: boolean
}>

// 相关类型
type HttpHookPolicy = {
  allowedUrls: string[] | undefined        // 来自 settings: allowedHttpHookUrls
  allowedEnvVars: string[] | undefined     // 来自 settings: httpHookAllowedEnvVars
}

type UrlMatchPattern = string              // 支持 * 通配符 (如 "https://my-api/*")
```

**输入输出**

| 阶段 | 输入 | 输出 | 说明 |
|-----|------|------|------|
| URL 白名单检查 | hook.url, policy.allowedUrls | pass/block | undefined = 无限制 |
| Header 插值 | hook.headers, allowedEnvVars | sanitized headers | $VAR / ${VAR} 语法 |
| 请求发送 | POST url, json body, headers | response | timeout + signal |
| 响应解析 | response.data | body | 不自动解析 JSON |

**注册与执行状态**

```typescript
// 无持久状态 (纯函数)
// 执行时临时状态仅在 axios 请求期间存在
```

**配置、匹配、执行、超时、清理流程**

```
前置检查
  ├─ URL 白名单 (getHttpHookPolicy)
  │   ├─ undefined → 不限制
  │   ├─ [] → 拦截所有
  │   └─ [pattern, ...] → urlMatchesPattern()
  │       ├─ * 通配符 → .* regex
  │       └─ 其他字符 → 正则转义
  └─ 拦截 → {ok: false, error: "..."}
       ↓
Header 准备
  ├─ Content-Type: application/json (总是)
  └─ 自定义 headers:
      ├─ hook.allowedEnvVars ∩ policy.allowedEnvVars
      │   └─ policy 存在时取交集
      ├─ $VAR / ${VAR} 插值
      │   ├─ 允许列表内 → process.env[VAR]
      │   └─ 外 → '' (空字符串)
      └─ sanitizeHeaderValue(): 移除 \r\n\x00
       ↓
代理配置
  ├─ 沙箱启用 → sandbox proxy
  │   └─ SandboxManager.waitForNetworkInitialization()
  ├─ 环境变量代理 (HTTP_PROXY/HTTPS_PROXY) 且非 bypass
  │   └─ 已配置 axios 拦截器处理
  └─ 无代理 → SSRF 防护 (直接 axios 请求)
       ↓
SSRF 防护 (无代理时)
  ├─ lookup 函数: ssrfGuardedLookup()
  │   ├─ 解析域名 → IP 地址
  │   ├─ 拒绝私有 IP 范围 (RFC 1918, RFC 4193)
  │   ├─ 拒绝链路本地地址 (169.254.0.0/16)
  │   ├─ 拒绝 localhost / 127.0.0.1?
  │   │   └─ 否: 允许本地开发 (例外)
  │   └─ 仅允许公网 IP
  └─ lookup 选项传递给 axios: {lookup: ssrfGuardedLookup}
       ↓
发送请求
  ├─ method: POST
  ├─ url: hook.url (验证通过)
  ├─ headers: 处理后的 headers
  ├─ body: jsonInput (字符串)
  ├─ timeout: hook.timeout → DEFAULT_10M
  ├─ maxRedirects: 0 (不跟随重定向)
  ├─ signal: 组合 timeout + 用户取消
  └─ validateStatus: () => true (不抛错, 总是返回)
       ↓
响应处理
  ├─ 2xx/3xx/4xx/5xx 都返回 {ok: status ∈ 200-299}
  ├─ 不自动解析 JSON (交给调用方)
  ├─ signal.aborted → {aborted: true}
  └─ 网络错误 → {error: message}
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| URL 不在白名单 | 拒绝执行, 返回 {ok: false} | 策略执行 |
| SSRF 检测到私有 IP | 网络请求被阻止 (lookup 抛错) | 内网资源防护 |
| maxRedirects: 0 | 不跟随 3xx 重定向 | 防止绕过 SSRF 防护 (重定向到内网) |
| Header 注入 | 移除 \r\n\x00 | CRLF 注入防护 |
| 环境变量泄露 | 白名单机制, 未允许 → '' | 防止 secrets 泄露 via header |
| 超时/取消 | {aborted: true} 或 {error} | 拒绝服务防护 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| HTTP 方法 | 仅 POST | 统一, 简单 | 允许配置 GET/PUT/PATCH/DELETE |
| 重定向 | maxRedirects: 0 | SSRF 防护 (重定向到内网) | 允许跟随但验证最终 URL |
| 白名单语法 | * 通配符 (glob) | 类似 MCP server 模式, 熟悉 | 仅正则; 仅精确匹配 |
| Header 插值 | 白名单 env var | 安全默认值 | 信任用户配置; 黑名单 |
| 响应解析 | 不自动解析 JSON | 灵活性 (可能返回非 JSON) | 强制 JSON, schema 验证 |
| SSRF 策略 | 禁止私有 IP, 允许 localhost | 本地开发友好, 同时阻止内网扫描 | 完全禁止 localhost; 可配置 |
| SessionStart/Setup | HTTP 钩子不支持 | 早期 UI/回调可能未就绪, 死锁风险 | 重构启动顺序 |

**源码测试证据**

- 源码: `src/utils/hooks/execHttpHook.ts` (完整文件)
- SSRF 防护: `src/utils/hooks/ssrfGuard.ts`
- 配置策略: `src/utils/settings/types.ts` (allowedHttpHookUrls, httpHookAllowedEnvVars)
- 测试: 未覆盖 (见 7.2)

---

#### 4.4.5 Prompt/Agent Hook 执行

**真实入口签名与关键类型**

```typescript
// src/utils/hooks/execPromptHook.ts
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string
): Promise<HookResult>

// src/utils/hooks/execAgentHook.ts
export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string,
  messages: Message[],
  agentType?: string
): Promise<HookResult>

// 相关类型
type PromptRequest = {
  prompt: string              // 请求 ID (任意字符串)
  message: string             // 显示给用户的消息
  options: Array<{
    key: string               // 返回时的 selected 值
    label: string             // 显示文本
    description?: string
  }>
}

type PromptResponse = {
  prompt_response: string     // 匹配请求的 prompt ID
  selected: string            // 用户选择的 option key
}
```

**输入输出**

| 钩子类型 | 输入 | 输出 | 说明 |
|---------|------|------|------|
| Prompt Hook | prompt 模板, $ARGUMENTS, model? | HookResult | 用小模型 (Haiku) 默认 |
| Agent Hook | prompt 描述, model? | HookResult | 调用子 agent 执行验证 |

**注册与执行状态**

```typescript
// 无持久状态 (纯函数调用模型)
// 执行期间临时状态:
// - 模型 API 请求上下文
// - 工具调用上下文 (agent hook)
```

**配置、匹配、执行、超时、清理流程**

```
Prompt Hook 流程
  ├─ 模型选择: hook.model ?? getSmallFastModel() (Haiku)
  ├─ Prompt 模板替换: $ARGUMENTS → jsonInput
  ├─ 调用模型（是否流式由具体调用配置决定）
  ├─ 解析响应 JSON (如果看起来像 JSON)
  └─ processHookJSONOutput() 转换为 HookResult
       ↓
Agent Hook 流程
  ├─ 模型选择: hook.model ?? Haiku
  ├─ 构造验证任务: 描述 + hook input
  ├─ 调用子 agent 执行验证
  │   ├─ 可访问工具 (只读?)
  │   └─ 可读取文件 (视 hook 事件而定)
  ├─ 解析 agent 输出决策
  └─ 返回 HookResult (blocking error 如验证失败)
       ↓
Prompt Request 交互 (仅 command hook 支持)
  ├─ hook stdout 检测 {"prompt": id, message, options}
  ├─ 序列化处理 (promptChain)
  ├─ 通过 requestPrompt 回调显示给用户
  ├─ 用户选择后写回 child.stdin
  │   └─ {"prompt_response": id, "selected": key}
  └─ 从最终 stdout 剥离 prompt request 行
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| 模型调用失败 | non-blocking error | 钩子失败不影响主流程 |
| 响应 JSON 无效 | 当作文本处理 | 容错优先 |
| 超时 | signal.aborted → cancelled | 慢钩子不阻塞 |
| 非 Stop 事件 | prompt/agent hooks 不支持 (headless 模式) | 避免影响正常工具执行流 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| 默认模型 | Haiku | 快, 便宜 | Sonnet; 主模型 |
| Prompt 模板 | $ARGUMENTS 占位符 | 简单, 无需复杂模板语法 | Handlebars/Mustache |
| Agent Hook 工具访问 | 受限 (上下文决定) | 安全优先 | 完全工具访问; 只读 |
| Prompt Request 支持 | 仅 command hook | 子进程 stdio 双向通信更自然 | 扩展到 HTTP hook (callback URL) |

**源码测试证据**

- 源码: `src/utils/hooks/execPromptHook.ts`, `src/utils/hooks/execAgentHook.ts`
- 测试: `tests/headlessHooks.test.ts` (prompt/agent stop hooks 覆盖)

---

#### 4.4.6 事件与错误处理 (hookEvents)

**真实入口签名与关键类型**

```typescript
// src/utils/hooks/hookEvents.ts
export function emitHookStarted(
  hookId: string,
  hookName: string,
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
): void

export function emitHookResponse({
  hookId,
  hookName,
  hookEvent,
  output,
  stdout,
  stderr,
  exitCode,
  outcome,
}: {
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}): void

export function startHookProgressInterval({
  hookId,
  hookName,
  hookEvent,
  getOutput,
}: {
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  getOutput: () => Promise<{ stdout: string; stderr: string; output: string }>
}): () => void
```

**输入输出**

| 事件 | 触发时机 | 数据负载 | 消费者 |
|-----|---------|---------|-------|
| hook:started | 钩子开始执行前 | hookId, hookName, hookEvent | UI 显示进度 |
| hook:response | 钩子完成后 | stdout/stderr/exitCode/outcome | 日志/UI 显示结果 |
| hook:progress | 异步钩子运行中 | 实时输出 (每秒轮询) | 终端/UI 显示更新 |

**注册与执行状态**

```typescript
// 事件系统是 fire-and-forget
// 无持久化状态, 仅通知订阅者
```

**配置、匹配、执行、超时、清理流程**

```
事件发射流程
  ├─ started: execCommandHook 中 spawn 后立即发射
  ├─ progress: AsyncHookRegistry 中注册时启动 interval
  │   └─ 每秒 getOutput() 检查更新
  └─ response:
      ├─ sync: 执行完成后立即 emit
      ├─ async:
      │   ├─ checkForAsyncHookResponses() 检测到完成
      │   └─ finalizePendingAsyncHooks() 会话结束清理
      └─ asyncRewake: inline then() 中 emit
       ↓
Progress Interval 清理
  ├─ hook 完成时: stopProgressInterval()
  ├─ async hook: responseAttachmentSent 后清理
  ├─ finalize: 总是清理所有 remaining hooks
  └─ 测试工具: clearAllAsyncHooks() 暴力清理
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| getOutput() 抛错 | 忽略继续轮询 | interval 不崩溃 |
| interval 泄漏 | finalizePendingAsyncHooks() 总是清理 | 会话结束时确保停止 |
| 重复事件 | 幂等处理 | 多次发射无害 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| Progress 更新频率 | 每秒 | 响应及时且低开销 | 可调; 事件驱动 (stream) |
| Event 协议 | 仅内部发射 | 钩子模块内部实现细节 | 暴露给插件订阅 |

**源码测试证据**

- 源码: `src/utils/hooks/hookEvents.ts`
- 集成: `src/utils/hooks.ts` (多处调用)

---

#### 4.4.7 超时与清理 (combinedAbortSignal, session end)

**真实入口签名与关键类型**

```typescript
// src/utils/combinedAbortSignal.ts
export function createCombinedAbortSignal(
  parentSignal: AbortSignal | undefined,
  options: { timeoutMs?: number }
): {
  signal: AbortSignal
  cleanup: () => void
}

// src/utils/hooks.ts
const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500

export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_SIMPLE_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

export async function finalizePendingAsyncHooks(): Promise<void>
```

**输入输出**

| 场景 | 输入 | 输出 | 说明 |
|-----|------|------|------|
| 普通钩子超时 | parentSignal, timeoutMs | combined signal | 超时 + 用户取消 OR 关系 |
| SessionEnd 钩子 | (无) | 1500ms 可配置 | CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS |
| Async hooks 最终清理 | (无) | Promise<void> | kill 未完成进程 |

**注册与执行状态**

```typescript
// combinedAbortSignal 内部状态
type CombinedAbortState = {
  controller: AbortController
  timeoutId?: NodeJS.Timeout
  parentListener?: () => void
  cleanedUp: boolean
}

// SessionEnd 批量执行状态
type SessionEndState = {
  hooks: MatchedHook[]
  overallSignal: AbortController
  overallTimeout: 1.5s * N_hooks?  // 不, 每个钩子独立超时
  allSettled: Promise<...>
}
```

**配置、匹配、执行、超时、清理流程**

```
组合 Signal 流程
  ├─ 创建新 AbortController
  ├─ parentSignal 存在?
  │   └─ 是 → 添加 'abort' listener → controller.abort()
  ├─ timeoutMs 存在?
  │   └─ 是 → setTimeout(controller.abort(), timeoutMs)
  ├─ 返回 {signal: controller.signal, cleanup}
  └─ cleanup():
      ├─ 移除 parent listener
      ├─ clearTimeout
      └─ 防止内存泄漏
       ↓
SessionEnd 钩子特殊处理
  ├─ 超时: getSessionEndHookTimeoutMs() → 1.5s 默认
  ├─ 环境变量可覆盖: CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
  ├─ 整体超时: 所有钩子并行执行, 总时间不超过单钩子超时?
  │   └─ 每个钩子独立超时, 无整体超时 (但用户等待退出)
  └─ 总是执行 finalizePendingAsyncHooks()
       ↓
Async hooks 最终清理
  ├─ Promise.all() 处理所有 pending hooks
  ├─ 对每个钩子:
  │   ├─ shellCommand.status === 'completed' → emit success/error
  │   ├─ status !== 'killed' → shellCommand.kill()
  │   └─ 否则 → emit cancelled
  └─ pendingHooks.clear()
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| cleanup 未调用 | 内存泄漏风险 | 总是 try/finally 包裹 |
| SessionEnd 超时钩子未完成 | 强制终止, 立即退出 | 不阻塞用户关闭应用 |
| 异步钩子会话后仍运行 | finalize 时 kill | 资源泄漏防护 |
| timeout 负数值 | NaN → 使用默认值 | 防御式编程 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| SessionEnd 超时 | 1.5s 默认 | 用户关闭应用不想等 | 更长默认; 可配置每个钩子 |
| SessionEnd 执行模式 | 并行 (all hooks together) | 更快完成 | 串行执行; 可配置顺序 |
| 超时精度 | setTimeout (ms 精度) | 足够, 且简单 | 高分辨率定时器 |
| cleanup 责任 | 返回 cleanup 函数给调用者 | 显式生命周期管理 | RAII / using 语句 (TS 5.2+) |

**源码测试证据**

- 源码: `src/utils/combinedAbortSignal.ts`
- 集成: `src/utils/hooks.ts` (lines 175-182, 739-745, etc.)

---

#### 4.4.8 SSRF 防护 (ssrfGuard)

**真实入口签名与关键类型**

```typescript
// src/utils/hooks/ssrfGuard.ts
export function ssrfGuardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number
  ) => void
): void

// 或 Promise 版本 (axios 使用)
export function ssrfGuardedLookupPromise(
  hostname: string,
  options: dns.LookupOptions
): Promise<{ address: string; family: number }>

// 内部 IP 范围检查
function isPrivateIp(ip: string): boolean {
  // RFC 1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  // RFC 4193: fd00::/8 (ULA IPv6)
  // RFC 3927: 169.254.0.0/16 (link-local IPv4)
  // IPv6 link-local: fe80::/10
  // IPv4 loopback: 127.0.0.0/8 (例外允许)
  // IPv6 loopback: ::1 (例外允许)
}
```

**输入输出**

| 输入 | 检查项 | 输出 |
|------|-------|------|
| hostname | 解析到 IP 地址 | callback(err, address, family) |
| address | 是否私有/链路本地/loopback | 允许或拒绝 |
| localhost | 特殊处理 | 明确允许 (本地开发) |

**注册与执行状态**

```typescript
// 无持久状态 (纯函数检查)
// 依赖 dns.lookup() 系统调用
```

**配置、匹配、执行、超时、清理流程**

```
DNS 解析
  ├─ 调用 dns.lookup(hostname)
  └─ 获取 IP 地址 (A/AAAA 记录)
       ↓
IP 检查
  ├─ IPv4:
  │   ├─ 127.0.0.0/8 → 允许 (loopback)
  │   ├─ 10.0.0.0/8 → 拒绝
  │   ├─ 172.16.0.0/12 → 拒绝
  │   ├─ 192.168.0.0/16 → 拒绝
  │   └─ 169.254.0.0/16 → 拒绝
  ├─ IPv6:
  │   ├─ ::1 → 允许 (loopback)
  │   ├─ fd00::/8 → 拒绝 (ULA)
  │   └─ fe80::/10 → 拒绝 (link-local)
  └─ 其他 → 允许 (公网 IP)
       ↓
允许路径
  └─ callback(null, address, family)
       ↓
拒绝路径
  └─ callback(Error('SSRF protection: ...'))
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| 解析到私有 IP | 抛错, 拒绝请求 | 内网资源防护 |
| localhost/127.0.0.1 | 例外允许 | 本地开发需求 |
| DNS 解析失败 | 传递原始错误 | 不吞掉网络错误 |
| 多 A 记录 | 检查返回的那个 IP (dns.lookup 只返回一个) | 可能绕过 (轮询解析), 但实际中 lookup 只选一个 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| 防护策略 | 黑名单私有范围, 允许 localhost | 安全 + 本地开发友好 | 完全禁止 localhost; 白名单 IP |
| 检查位置 | lookup 钩子 (无代理时) + 沙箱代理 (有代理时) | 深度防护, 两层检查 | 仅 URL 白名单; 仅代理检查 |
| IPv6 支持 | 完整检查 (ULA/link-local/loopback) | IPv6 环境同样安全 | 不支持 IPv6 (仅检查 IPv4) |
| 多 IP 处理 | dns.lookup 只返回一个, 检查那个 | 简单, 但可能绕过 (DNS 轮询) | 检查所有 IP (需用 dns.resolve4/6) |

**源码测试证据**

- 源码: `src/utils/hooks/ssrfGuard.ts`
- 集成: `src/utils/hooks/execHttpHook.ts` (lines 201-217, lookup 选项)
- 测试: 未覆盖 (见 7.2)

---

#### 4.4.9 Hook Trust (信任检查)

**真实入口签名与关键类型**

```typescript
// src/utils/hooks.ts
export function shouldSkipHookDueToTrust(): boolean {
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false  // SDK 模式: 信任隐式
  }
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

// src/utils/config.ts 相关
export function checkHasTrustDialogAccepted(): boolean {
  // 检查设置: settings.trustDialogAccepted
  // 或工作区信任状态
}
```

**输入输出**

| 输入 | 输出 | 说明 |
|-----|------|------|
| isInteractive | boolean | getIsNonInteractiveSession() 反 |
| hasTrust | boolean | checkHasTrustDialogAccepted() |
| (无) | boolean | skip all hooks? |

**注册与执行状态**

```typescript
// 无持久状态
// 每次调用检查当前设置
```

**配置、匹配、执行、超时、清理流程**

```
调用位置
  ├─ executeHooks() 开始处 (在 load/match 之后)
  ├─ 所有钩子类型通用检查
  └─ non-interactive → 跳过检查 (SDK 模式)
       ↓
检查内容
  ├─ 交互式模式?
  │   └─ 否 → 不跳过 (SDK)
  └─ 信任对话已接受?
      ├─ 是 → 不跳过
      └─ 否 → 跳过所有钩子
       ↓
历史漏洞修复
  ├─ SessionEnd 钩子曾在用户拒绝信任后执行
  │   └─ 现在所有钩子统一检查
  ├─ SubagentStop 钩子同样问题
  │   └─ 同样修复
  └─ 未来任何钩子事件自动受保护
```

**错误与安全**

| 错误场景 | 处理方式 | 安全考虑 |
|---------|---------|---------|
| 未信任工作区 | 跳过所有钩子 | 安全边界执行任意代码前确认 |
| SDK 模式 | 隐式信任 | 非交互环境无用户确认 |
| 部分钩子执行 | 无, all-or-nothing | 避免混淆, 简化安全模型 |

**设计取舍与备选**

| 取舍 | 选择 | 理由 | 备选 |
|-----|------|------|------|
| 检查粒度 | 每个钩子执行前, all-or-nothing | 安全优先, 实现简单 | 按钩子类型/来源区分信任 |
| SDK 模式 | 隐式信任 | 非交互场景无用户 | 要求配置文件明确启用 |
| 历史修复 | 所有钩子统一检查 | 防御式编程, 避免未来漏洞 | 仅修复特定事件 |

**源码测试证据**

- 源码: `src/utils/hooks.ts` (lines 286-296)
- 调用处: `src/utils/hooks.ts` (line 1998, executeHooks 开头)

---

### 4.5 补充设计细节

#### 4.5.1 Matcher 类型详解

```typescript
// 四种匹配模式
type MatcherPattern =
  | 'exact'           // "Write" → 精确匹配工具名
  | 'pipe'            // "Write|Edit|Read" → 多个选项 OR
  | 'regex'           // "^Write.*" → 正则表达式
  | 'if-condition'    // "Bash(git *)" → 权限规则语法

function matchesPattern(query: string, matcher: string): boolean {
  if (!matcher || matcher === '*') return true
  
  // 简单字符串或管道列表 (无正则特殊字符除 |)
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes('|')) {
      const patterns = matcher.split('|').map(normalizeLegacyToolName)
      return patterns.includes(query)
    }
    return query === normalizeLegacyToolName(matcher)
  }
  
  // 正则表达式
  try {
    const re = new RegExp(matcher)
    if (re.test(query)) return true
    // 也检查 legacy tool 别名
    for (const legacy of getLegacyToolNames(query)) {
      if (re.test(legacy)) return true
    }
    return false
  } catch {
    logForDebugging('invalid regex in hook matcher')
    return false
  }
}

// if 条件匹配 (仅 tool 事件)
function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools?: Tools
): Promise<IfConditionMatcher | undefined> {
  // PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest 才支持
  if (!isToolEvent(hookInput.hook_event_name)) return undefined
  
  const toolName = normalizeLegacyToolName(hookInput.tool_name)
  const tool = tools?.findByName(toolName)
  const input = tool?.inputSchema.safeParse(hookInput.tool_input)
  
  // 工具可自定义 matcher 准备
  const patternMatcher = input?.success && tool?.preparePermissionMatcher
    ? await tool.preparePermissionMatcher(input.data)
    : undefined
    
  return (ifCondition: string) => {
    const parsed = permissionRuleValueFromString(ifCondition)
    // 工具名必须匹配
    if (normalizeLegacyToolName(parsed.toolName) !== toolName) return false
    // 无 rule 内容 → 总是匹配
    if (!parsed.ruleContent) return true
    // 委托给工具的 matcher
    return patternMatcher?.(parsed.ruleContent) ?? false
  }
}
```

#### 4.5.2 Stdin/Stdout JSON 协议

```typescript
// 输入协议: JSON 写入 stdin, 尾随换行
hookInput → jsonStringify(hookInput) + '\n' → child.stdin
// 注: 总是 UTF-8 编码

// 输出协议 (stdout):
// 选项 1: 纯文本 (无格式要求)
// 选项 2: 同步响应 JSON (一行或多行)
{
  "continue": false,                    // 可选
  "stopReason": "validation failed",    // 可选
  "suppressOutput": true,               // 可选
  "decision": "approve" | "block",      // 可选
  "reason": "...",                      // 可选
  "systemMessage": "...",               // 可选
  "hookSpecificOutput": {               // 可选, 按事件类型区分
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "...",
    "updatedInput": {...},
    "additionalContext": "..."
  }
}
// 选项 3: 异步响应首行 (必须是第一行输出)
{"async": true, "asyncTimeout": 30000}  // asyncTimeout 可选, ms
// 随后可继续输出任意内容
// 完成后可再输出同步响应 JSON (同上选项 2)

// 选项 4: Prompt Request (仅 command hook 有 requestPrompt 回调时)
{
  "prompt": "my-request-id",
  "message": "选择一个选项",
  "options": [{"key": "a", "label": "选项 A"}, ...]
}
// 必须整行, 无 leading/trailing 空格?
// 处理后从 stdout 中剥离这些行 (按内容匹配)
// 响应写入 stdin: {"prompt_response": "my-request-id", "selected": "a"}
```

#### 4.5.3 Blocking Exit Code 2

```typescript
// 退出码语义约定
const EXIT_SUCCESS = 0           // 成功, 继续主流程
const EXIT_ERROR = 1             // 错误, 显示但继续
const EXIT_BLOCKING = 2          // 阻塞错误, 终止主流程

// 处理逻辑
if (exitCode === EXIT_BLOCKING) {
  // 钩子明确要求阻止
  result.blockingError = {
    blockingError: stderr || stdout || 'Hook returned exit code 2'
    command: hook.command
  }
  result.outcome = 'blocking'
} else if (exitCode !== EXIT_SUCCESS) {
  // 非零但非 2 → non-blocking
  result.outcome = 'non_blocking_error'
} else {
  result.outcome = 'success'
}

// asyncRewake 钩子唤醒条件
// exit code 2 时通过任务通知唤醒
if (result.code === 2) {
  enqueuePendingNotification({
    value: wrapInSystemReminder(
      `Stop hook blocking error from command "${hookName}": ${stderr || stdout}`
    ),
    mode: 'task-notification'
  })
  // 其他 exit code → 仅 emitHookResponse, 不唤醒
}
```

#### 4.5.4 Async Hook 完成与进程退出

```typescript
// AsyncHookRegistry 状态机
type AsyncHookState =
  | 'registered'         // processId in Map, shellCommand.running
  | 'checking'           // checkForAsyncHookResponses() 遍历中
  | 'completed'          // shellCommand.status === 'completed'
  | 'response-sent'      // emitHookResponse() 已调用
  | 'removed'            // 从 Map 中删除

// 检查循环 (主循环中定期调用 checkForAsyncHookResponses())
for (const hook of pendingHooks.values()) {
  if (!hook.shellCommand) { /* remove */ }
  if (hook.shellCommand.status === 'killed') { /* remove */ }
  if (hook.shellCommand.status !== 'completed') { /* skip */ }
  if (hook.responseAttachmentSent || !stdout.trim()) { /* remove */ }
  
  // 完成且有输出
  const stdout = await hook.shellCommand.taskOutput.getStdout()
  const lines = stdout.split('\n')
  let response: SyncHookJSONOutput = {}
  for (const line of lines) {
    if (line.trim().startsWith('{')) {
      try {
        const parsed = jsonParse(line.trim())
        if (!('async' in parsed)) { // 跳过 async 首行
          response = parsed
          break
        }
      } catch {}
    }
  }
  
  hook.responseAttachmentSent = true
  const execResult = await hook.shellCommand.result
  await finalizeHook(hook, execResult.code, 
    execResult.code === 0 ? 'success' : 'error')
  
  return { processId, response, ... }
}

// SessionEnd 清理 (总是在会话退出时调用)
for (const hook of pendingHooks.values()) {
  if (hook.shellCommand?.status === 'completed') {
    const result = await hook.shellCommand.result
    await finalizeHook(hook, result.code, result.code === 0 ? 'success' : 'error')
  } else {
    if (hook.shellCommand && hook.shellCommand.status !== 'killed') {
      hook.shellCommand.kill()
    }
    await finalizeHook(hook, 1, 'cancelled')
  }
}
pendingHooks.clear()
```

#### 4.5.5 HTTP SSRF Allowlist

```typescript
// 设置配置
type Settings = {
  // URL 白名单 (undefined = 无限制, [] = 阻止所有)
  allowedHttpHookUrls?: string[]
  
  // 环境变量白名单 (用于 header 插值)
  httpHookAllowedEnvVars?: string[]
}

// 匹配函数
function urlMatchesPattern(url: string, pattern: string): boolean {
  // pattern 中 * 通配符 → regex .*
  // 其他字符 → 正则转义
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`).test(url)
}

// 使用示例:
// settings.json:
// {
//   "allowedHttpHookUrls": ["https://my-api.example.com/*", "https://trusted-service.com"]
// }
// → 允许匹配这两个模式的 URL
```

#### 4.5.6 Hook Trust 与递归边界

```typescript
// 信任检查: 所有钩子统一检查 (包括 SessionEnd)
// 历史漏洞: SessionEnd 曾在用户拒绝后执行
// 修复: shouldSkipHookDueToTrust() 在 executeHooks() 开头调用
// 注意: SessionEnd 也是事件, 同样检查

// 递归边界: 钩子触发钩子?
// 场景: UserPromptSubmit hook 执行 → 可能触发其他钩子?
// 处理: execPromptHook 直接创建 user message, 不调用 processUserInput()
// → 避免 UserPromptSubmit hook 触发 UserPromptSubmit hook
// → 其他事件可能需要类似防护 (如 PreToolUse 不触发 PreToolUse)

// asyncRewake 钩子也可能递归:
// → 唤醒后执行 stop hook → stop hook 再次 asyncRewake?
// → 当前无显式防护, 但 exit code 2 才会唤醒, 且仅通知一次
```

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 失败场景 | 处理方式 | 影响范围 |
|---------|---------|---------|
| 单个钩子执行失败 | `Promise.allSettled()` 隔离，其他钩子继续 | 仅该钩子失败 |
| 钩子退出码 1 | 显示错误，继续主流程 | non-blocking error |
| 钩子退出码 2 | 显示错误，终止主流程 | blocking error |
| 钩子输出 JSON 无效 | 当作文本处理，继续主流程 | non-blocking |
| 钩子超时 | 取消执行，显示错误，继续主流程 | non-blocking |
| 用户按 Escape 取消 | 取消执行，静默或显示取消，继续主流程 | non-blocking |
| 工作区未信任 | 跳过所有钩子，继续主流程 | 非交互模式除外 |
| HTTP 钩子 SSRF 检查失败 | 拒绝执行，显示错误，继续主流程 | non-blocking |
| Header 插值未允许变量 | 替换为空，继续执行 | non-blocking |
| SessionEnd 钩子超时 | 强制终止，立即退出 | 不阻塞会话结束 |
| asyncRewake 钩子崩溃 | 丢弃结果，不唤醒 | 仅不唤醒 |
| 多个 permission 钩子冲突 | deny > ask > allow 优先级 | 取最严格的 |

### 5.2 工程取舍

| 取舍 | 选择 | 理由 | 代价 |
|-----|------|------|------|
| 执行模式 | Promise.allSettled() 并行 | 快速完成，失败隔离 | 钩子间不能依赖执行顺序 |
| 异步检测 | 首行 JSON 协议 | 灵活，不需要配置 | 需要输出首行符合格式 |
| asyncRewake 缓冲 | 内存缓冲，不 spill to disk | 唤醒时可重新读取输出 | 长时间运行占用内存 |
| Shell 选择 | bash 默认，支持 powershell | 跨平台兼容 | Windows 需要 Git Bash |
| SessionEnd 超时 | 1.5 秒默认 | 不阻塞用户退出 | 复杂清理脚本可能超时 |
| HTTP 钩子重定向 | maxRedirects: 0 | SSRF 防护 | 需要服务器直接响应 |
| Header 插值 | 白名单 env var | 安全防止泄露 | 用户需要显式声明 |
| Prompt 模型 | Haiku 默认 | 快速低成本 | 复杂判断能力不足 |
| 重复钩子处理 | 去重执行 | 避免冗余 | 相同命令不能用不同 if 条件 |
| Permission 聚合 | deny > ask > allow | 安全优先 | 可能与用户期望不一致 |

### 5.3 边界疑虑

| 边界情况 | 风险 | 当前处理 | 改进空间 |
|---------|-----|---------|---------|
| 异步钩子在会话结束后仍运行 | 资源泄漏；输出丢失 | `finalizePendingAsyncHooks()` 强制清理 | 持久化异步钩子状态跨会话恢复 |
| 钩子 stdin 写入 EPIPE（进程已退出） | 执行失败，用户困惑 | 捕获 EPIPE，返回 non-blocking 错误 | 更友好的错误信息，提示钩子可能有 bug |
| 插件目录在执行前被删除 | 启动失败，退出码 2（被误判为 blocking） | 先检查 `pathExists(pluginRoot)`，失败时 throw 而非 spawn | 已实现 |
| 嵌套钩子调用（钩子触发钩子） | 无限递归 | `UserPromptSubmit` 在 `execPromptHook` 中通过直接创建 user message 而非 `processUserInput` 避免 | 其他事件可能需要类似防护 |
| 工作区已删除但 cwd 指向那里 | spawn 失败 | 检测并回退到 `getOriginalCwd()` | 已实现 |
| asyncRewake 钩子在查询中崩溃 | 阻塞错误无法送达 | exit code 2 时通过任务通知唤醒，否则丢弃 | 考虑在下次查询时提供所有未送达的异步钩子输出 |
| 多个 permission 钩子返回不同 decision | 行为不明确 | deny > ask > allow 优先级，取第一个 blocking error | 考虑明确的钩子优先级排序 |
| HTTP 钩子在沙箱初始化前触发 | 代理不可用 | `SandboxManager.waitForNetworkInitialization()` | 已实现 |
| PowerShell 钩子不支持 `CLAUDE_ENV_FILE` | 环境变量持久化不一致 | SessionStart/Setup/CwdChanged/FileChanged 钩子不设置 env file（PowerShell） | 考虑 PowerShell 格式的 env var 持久化 |

## 6. 现状验收标准

### 6.1 功能验收标准

- 所有钩子需要工作区信任（包括 SessionEnd）：`shouldSkipHookDueToTrust()` 在执行前检查
- 异步钩子使用首行 JSON 协议 + 注册表：首行 `{"async": true}` 检测，`AsyncHookRegistry` 管理
- 退出码约定：0=success，1=non-blocking error，2=blocking error
- HTTP 钩子不支持 SessionStart/Setup 事件：在 `getMatchingHooks()` 中过滤
- 同一 source 内相同命令去重：`hookDedupKey` 计算，Map 去重
- asyncRewake 不 spill to disk：`asyncRewake: true` 跳过 `shellCommand.background()`
- 组合 abort signal：`createCombinedAbortSignal(signal, {timeoutMs})` 同时处理用户取消和超时
- HTTP 钩子 Header 仅允许白名单 env var：`allowedEnvVars` 显式列出，未允许的替换为空
- Prompt 钩子使用小模型（Haiku）：`getSmallFastModel()` 默认，`model` 字段可覆盖
- SessionEnd 钩子使用短超时（1.5 秒）：`SESSION_END_HOOK_TIMEOUT_MS_DEFAULT` 默认，环境变量可配置
- 30+ 钩子事件点支持：覆盖工具执行、会话生命周期、通知、配置变更等
- 4 种钩子类型支持：Command、HTTP、Prompt、Agent
- 事件匹配支持：工具名、Agent 类型、通知类型、`if` 条件
- 同步/异步执行支持：同步阻塞、异步后台、asyncRewake 唤醒
- 结构化输入输出：JSON 格式，支持 permission decision、additional context 等
- SSRF 防护：HTTP 钩子 URL 检查，沙箱代理，maxRedirects: 0
- 跨平台兼容：Windows/macOS/Linux，bash/powershell 支持，路径转换

### 6.2 行为验收标准

- 单个钩子失败不影响其他钩子：`Promise.allSettled()` 隔离执行
- 退出码 2 终止主流程：blocking error 优先
- permission decision 聚合：deny > ask > allow 优先级
- asyncRewake 钩子 exit code 2 时唤醒：通过 `enqueuePendingNotification` 唤醒
- SessionEnd 钩子不阻塞退出：1.5 秒超时，超时强制终止
- HTTP 钩子不跟随重定向：maxRedirects: 0
- 未信任工作区跳过所有钩子：`shouldSkipHookDueToTrust()` 检查
- 插件目录不存在时提前失败：先检查 `pathExists(pluginRoot)`
- 工作区已删除时回退到 original cwd：检测并回退

## 7. 代码与测试证据

### 7.1 关键代码证据

钩子执行核心：
- `src/utils/hooks/hooks.ts`：`executeHooksForEvent()`、`getMatchingHooks()`、结果聚合
- `src/utils/hooks/execCommandHook.ts`：Command 钩子执行
- `src/utils/hooks/execHttpHook.ts`：HTTP 钩子执行、SSRF 防护
- `src/utils/hooks/execPromptHook.ts`：Prompt 钩子执行
- `src/utils/hooks/execAgentHook.ts`：Agent 钩子执行

异步钩子管理：
- `src/utils/hooks/AsyncHookRegistry.ts`：异步钩子注册、检查、清理

安全与信任：
- `src/utils/hooks/hookTrust.ts`：信任检查
- `src/utils/hooks/ssrfGuard.ts`：SSRF 防护

超时与取消：
- `src/utils/hooks/hookTimeout.ts`：超时计算
- `src/utils/hooks/combinedAbortSignal.ts`：组合 signal

配置与类型：
- `src/utils/hooks/hooksConfig.ts`：配置加载、验证
- `src/utils/hooks/hookEvents.ts`：事件定义
- `src/utils/hooks/types.ts`：类型定义

Shell 命令：
- `src/utils/shellCommand.ts`：Shell 命令执行、缓冲、后台模式

### 7.2 测试覆盖现状

现有测试：
- `tests/headlessHooks.test.ts`：prompt/agent stop hooks success/blocking/error 路径；取消信号传播；非 Stop 事件的模型钩子不支持

未覆盖场景：
- Command hooks 完整测试（需要真实子进程）
- HTTP hooks 完整测试（需要测试服务器）
- Async hooks 完整测试（需要时间控制）
- Permission decision 聚合测试
- `if` 条件匹配测试
- 路径转换测试（Windows）
- SSRF 防护边界测试
- Header 插值白名单测试
- asyncRewake 唤醒测试
- SessionEnd 钩子超时测试
- 嵌套钩子调用防护测试
- 跨平台 shell 选择测试
- 钩子去重逻辑测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/hooks-system.yaml)

### 8.1 源文件覆盖

| 文件 | 主要职责 | 公开接口 |
|------|---------|---------|
| `src/utils/hooks/hooks.ts` | 钩子执行核心 | `executeHooksForEvent()`、`getMatchingHooks()` |
| `src/utils/hooks/execCommandHook.ts` | Command 钩子执行 | `execCommandHook()` |
| `src/utils/hooks/execHttpHook.ts` | HTTP 钩子执行 | `execHttpHook()` |
| `src/utils/hooks/execPromptHook.ts` | Prompt 钩子执行 | `execPromptHook()` |
| `src/utils/hooks/execAgentHook.ts` | Agent 钩子执行 | `execAgentHook()` |
| `src/utils/hooks/AsyncHookRegistry.ts` | 异步钩子管理 | `AsyncHookRegistry` 类 |
| `src/utils/hooks/hookTrust.ts` | 信任检查 | `shouldSkipHookDueToTrust()` |
| `src/utils/hooks/hookTimeout.ts` | 超时计算 | `getHookTimeoutMs()` |
| `src/utils/hooks/hookEvents.ts` | 事件定义 | `HookEvent` 类型、事件数据构造 |
| `src/utils/hooks/hooksConfig.ts` | 配置加载 | `loadHooksConfig()` |
| `src/utils/hooks/types.ts` | 类型定义 | 所有钩子类型 |
| `src/utils/hooks/combinedAbortSignal.ts` | 组合 signal | `createCombinedAbortSignal()` |
| `src/utils/hooks/ssrfGuard.ts` | SSRF 防护 | `ssrfGuardedLookup()` |
| `src/utils/shellCommand.ts` | Shell 命令执行 | `ShellCommand` 类 |

### 8.2 相关子系统

- 工具系统：钩子在工具执行前后触发（pre-tool-use/post-tool-use）
- 权限系统：钩子可以返回 permission decision 影响权限
- Agent 系统：Agent 钩子调用子 agent，subagent-start/subagent-stop 事件
- 会话系统：session-start/session-end/setup/instructions-loaded 事件
- 通知系统：notification 事件，asyncRewake 通过通知唤醒
- 配置系统：config-change 事件，钩子配置加载
- 沙箱系统：HTTP 钩子沙箱代理网络
- MCP 系统：elicitation/elicitation-result 事件

[Coverage](../../architecture/coverage/hooks-system.yaml)

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| P1 | Hooks System 无专门测试覆盖，关键路径验证不足 | 为 Hooks System 增加完整的测试覆盖，特别是 Command/HTTP/Async 钩子 | 低：仅测试代码变更 | 验证各钩子类型、错误路径、并发场景有测试覆盖 | M | 已证实（基于代码阅读） |
| P2 | 钩子调试困难，无详细执行日志可见 | 增加钩子调试模式，提供更详细的执行日志，便于调试钩子 | 低：可实现为可选功能，默认关闭 | 测试调试模式下可查看钩子执行日志、输入输出、时间戳 | M | 已证实（基于代码阅读） |
| P2 | 钩子配置变更需重启 CLI，开发体验差 | 实现钩子热重载，配置变更后无需重启 CLI 即可生效 | 中：需正确处理旧钩子清理、新钩子初始化 | 验证钩子配置变更后可自动生效且状态一致 | M | 已证实（基于代码阅读） |
| P2 | 钩子执行状态不可见，用户难以了解发生了什么 | 增加钩子执行可视化，在 UI 中显示钩子执行状态、输出、结果 | 低：UI 增强不影响核心功能 | 验证 UI 可显示钩子执行历史、状态、输出摘要 | S | 已证实（基于代码阅读） |
| P2 | 钩子错误信息不够友好，用户难以诊断 | 改进错误信息，为常见钩子错误提供更友好的诊断和修复建议 | 低：仅增强错误信息，不改变错误行为 | 验证常见错误场景返回明确诊断和修复建议 | S | 已证实（基于代码阅读） |
| P2 | 钩子配置错误在执行时才发现，反馈慢 | 增加钩子验证工具，在执行前验证钩子配置和脚本正确性 | 低：验证为可选前置步骤 | 验证工具可检测常见配置错误、语法错误、权限问题 | M | 已证实（基于代码阅读） |
| P2 | 钩子执行顺序不可控，依赖定义顺序 | 实现钩子优先级排序，允许用户定义钩子执行顺序 | 中：需确保顺序语义清晰且兼容现有配置 | 测试优先级排序可正确控制执行顺序且无遗漏 | S | 已证实（基于代码阅读） |
| P3 | 用户难以发现和分享钩子，生态不够丰富 | 提供官方钩子市场，用户可以分享和发现钩子 | 低：可选服务，不影响核心功能 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子调试手段有限，无专用工具 | 开发专门的钩子调试器，支持断点、单步执行 | 中：需设计调试协议和安全边界 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子仅限本地，无法跨设备协作 | 支持分布式钩子执行，跨设备协作 | 高：涉及网络、认证、安全等复杂问题 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子配置无版本管理，变更难回滚 | 集成 Git，支持钩子版本跟踪和回滚 | 中：需设计版本存储和切换机制 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 慢钩子难以识别和优化 | 提供钩子执行性能指标，识别慢钩子 | 低：可实现为可选性能统计 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子类型有限，无法满足更多场景 | 支持 Webhook、GraphQL、gRPC 等更多钩子类型 | 中：需确保新增类型与现有系统兼容 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子测试无框架，测试困难 | 提供钩子单元测试和集成测试框架 | 中：需设计测试沙箱和断言库 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子文档需手动维护，易过时 | 自动从钩子配置生成文档 | 低：文档生成工具不影响运行时 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子用 JSON/YAML 配置，类型不安全 | 允许用 TypeScript 编写钩子，类型安全 | 高：涉及执行模型变更，需设计沙箱 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子权限无限制，安全风险高 | 更严格的沙箱环境，限制钩子权限 | 高：需平衡功能性和安全性 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子市场质量无保障，有安全风险 | 建立钩子市场治理机制，包括评分、审核、安全扫描 | 高：涉及治理流程和技术措施 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子编写需专业技能，门槛高 | 用 LLM 自动生成钩子代码，降低门槛 | 中：需设计提示工程和验证机制 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 单个钩子能力有限，难以解决复杂问题 | 允许将多个钩子组合成工作流 | 中：需设计组合语义和状态管理 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 钩子执行无完整历史，难以审计 | 完整的钩子执行历史和审计溯源 | 低：可实现为可选审计功能 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 慢钩子无预算控制，可能阻塞主流程 | 允许用户定义钩子性能预算，超出时警告 | 中：需设计超时和中断机制 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 不同平台钩子行为可能有差异 | 定义跨平台钩子标准，确保行为一致 | 高：需抽象平台差异且保持兼容性 | 设计阶段验证架构方案 | L | 设计推断 |
