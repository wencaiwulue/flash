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

### 9.1 短期改进

- 为 Hooks System 增加完整的测试覆盖，特别是 Command/HTTP/Async 钩子
- 增加钩子调试模式：提供更详细的执行日志，便于调试钩子
- 实现钩子热重载：配置变更后无需重启 CLI 即可生效
- 增加钩子执行可视化：在 UI 中显示钩子执行状态、输出、结果
- 改进错误信息：为常见钩子错误提供更友好的诊断和修复建议
- 增加钩子验证工具：在执行前验证钩子配置和脚本正确性
- 实现钩子优先级排序：允许用户定义钩子执行顺序

### 9.2 中期改进

- 钩子市场：提供官方钩子库，用户可以分享和发现钩子
- 钩子调试器：专门的钩子调试工具，支持断点、单步执行
- 分布式钩子执行：支持远程钩子执行，跨设备协作
- 钩子版本管理：集成 Git，支持钩子版本跟踪和回滚
- 钩子性能分析：提供钩子执行性能指标，识别慢钩子
- 更多钩子类型：支持 Webhook、GraphQL、gRPC 等更多类型
- 钩子测试框架：提供钩子单元测试和集成测试框架
- 钩子文档生成：自动从钩子配置生成文档

### 9.3 长期考虑

- 钩子即代码：允许用 TypeScript 编写钩子，类型安全
- 钩子沙箱：更严格的沙箱环境，限制钩子权限
- 钩子市场治理：评分、审核、安全扫描
- AI 钩子生成：用 LLM 自动生成钩子代码
- 钩子组合：允许将多个钩子组合成工作流
- 钩子事件溯源：完整的钩子执行历史和审计
- 钩子性能预算：允许用户定义钩子性能预算，超出时警告
- 跨平台钩子标准：定义行业标准的钩子协议
