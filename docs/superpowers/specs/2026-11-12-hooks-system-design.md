---
id: hooks-system
batch: 7
title: Hooks System 事件钩子配置与执行设计
date: 2026-11-12
status: draft
---

## 1. 概述

Hooks System 是 Claude Code 提供的强大扩展机制，允许用户配置自定义钩子（Hook）在系统的各种事件点执行，实现对系统行为的拦截、验证和增强。钩子可以是命令脚本、HTTP 请求、Prompt 或 Agent 调用，支持同步和异步执行模式。

### 1.1 核心能力

- **多事件点集成**：30+ 钩子事件点覆盖工具执行、会话生命周期、通知、配置变更等场景
- **多类型钩子**：Command（Shell 脚本）、HTTP、Prompt（LLM 判断）、Agent（Agent 调用）
- **事件匹配**：支持工具名、Agent 类型、通知类型等条件匹配
- **同步/异步执行**：同步阻塞主流程、异步后台执行，支持 asyncRewake 唤醒
- **输入/输出结构化**：JSON 格式输入输出，支持 permission decision、additional context 等
- **失败隔离**：单个钩子失败不影响其他钩子执行，区分 blocking 和 non-blocking 错误

### 1.2 设计原则

1. **安全优先**：所有钩子（包括 SessionEnd）需要工作区信任确认
2. **失败不崩溃**：钩子执行失败不应导致系统崩溃，提供清晰的错误反馈
3. **隔离执行**：钩子在独立进程/上下文中执行，不能直接修改内部状态
4. **配置驱动**：通过用户/项目/本地配置文件定义，无需代码修改
5. **可观测性**：支持进度事件、输出捕获、超时控制和调试日志

## 2. 钩子配置与事件匹配

### 2.1 钩子类型

| 类型 | 说明 | 配置字段 |
|-----|------|---------|
| Command | Shell 脚本/命令 | `command`、`shell`、`timeout`、`async`、`asyncRewake`、`if` |
| HTTP | HTTP POST 请求 | `url`、`headers`、`allowedEnvVars`、`timeout`、`if` |
| Prompt | LLM 判断 | `prompt`、`model`、`timeout`、`if` |
| Agent | Agent 调用 | `prompt`、`timeout`、`if` |

### 2.2 事件点元数据

系统定义了 30+ 钩子事件，每个事件有匹配字段：

| 事件组 | 事件 | 匹配字段 | 说明 |
|-------|-----|---------|-----|
| 工具执行 | PreToolUse | 工具名 | 工具执行前 |
| | PostToolUse | 工具名 | 工具成功后 |
| | PostToolUseFailure | 工具名 | 工具失败后 |
| | PermissionDenied | 工具名 | 自动拒绝后 |
| | PermissionRequest | 工具名 | 权限弹窗时 |
| 会话 | SessionStart | source（startup/resume/clear/compact） | 会话开始 |
| | SessionEnd | reason（clear/logout/prompt_input_exit/other） | 会话结束 |
| | Setup | trigger（init/maintenance） | 仓库初始化 |
| | InstructionsLoaded | load_reason | 指令文件加载 |
| 流程 | Stop | - | 响应结束前 |
| | StopFailure | error（rate_limit/authentication_failed/...） | API 错误 |
| | PreCompact/PostCompact | trigger（manual/auto） | 会话压缩 |
| | UserPromptSubmit | - | 用户提交前 |
| 子 Agent | SubagentStart/Stop | agent_type | 子 Agent 生命周期 |
| 团队协作 | TeammateIdle/TaskCreated/TaskCompleted | - | 队友事件 |
| MCP | Elicitation/ElicitationResult | mcp_server_name | MCP 引导 |
| 文件系统 | FileChanged | 文件名 | 文件变更 |
| | CwdChanged | - | 工作目录变更 |
| 配置 | ConfigChange | source（user_settings/project_settings/...） | 配置变更 |
| 通知 | Notification | notification_type | 通知发送时 |
| Worktree | WorktreeCreate/WorktreeRemove | - | 工作树操作 |

### 2.3 匹配规则

1. **简单匹配**：精确匹配，如 `"Write"`、`"Bash"`
2. **管道列表**：多值匹配，如 `"Write|Edit|Read"`
3. **正则表达式**：如 `"^Write.*"`、`".*"`、`"^(Write|Edit)$"`
4. **legacy 工具名兼容**：自动检测并匹配旧工具名
5. **`if` 条件**：支持 `ToolName(argument pattern)` 语法，如 `"Bash(git *)"`

匹配器优先级：精确匹配 > 较短模式 > 较长模式，同一模式下本地配置 > 项目配置 > 用户配置。

## 3. 钩子执行与超时

### 3.1 执行流程

```
获取钩子配置快照
  ↓
匹配事件和条件
  ↓
去重（同一 source 内相同命令）
  ↓
并行执行所有匹配钩子
  ↓
解析 JSON 输出或文本
  ↓
聚合结果（preventContinuation、permissionBehavior、...）
  ↓
发出 HookResponse 事件
```

### 3.2 超时配置

| 钩子类型 | 默认超时 | 配置方式 | 说明 |
|---------|---------|---------|------|
| Command/HTTP | 10 分钟 | `timeout` 字段（秒） | `TOOL_HOOK_EXECUTION_TIMEOUT_MS` |
| SessionEnd | 1.5 秒 | 环境变量 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | 快速关闭路径 |
| Prompt | 30 秒 | `timeout` 字段（秒） | `execPromptHook` 默认 |
| Async 响应 | 15 秒 | `asyncTimeout` 输出字段 | 异步钩子默认 |

超时使用 `createCombinedAbortSignal`，合并用户取消信号和超时信号。

### 3.3 同步与异步

#### 同步执行（默认）
- 阻塞主流程，等待钩子完成
- 直接使用返回的 JSON 输出或 exit code
- 适用场景：权限校验、输入验证、必须立即执行的逻辑

#### 异步执行
两种方式：
1. **配置驱动**：`async: true` 或 `asyncRewake: true`
2. **输出驱动**：第一行输出 `{"async": true, "asyncTimeout": 30000}`

异步钩子通过 `AsyncHookRegistry` 注册，`checkForAsyncHookResponses()` 定期检查完成状态。

**asyncRewake 特性**：
- 不调用 `shellCommand.background()`（避免 spill to disk）
- 输出保留在内存中
- 退出码为 2 时通过 `enqueuePendingNotification` 唤醒主流程
- 硬取消（Escape）仍会终止钩子

### 3.4 退出码约定

| 退出码 | Command/HTTP | Prompt/Agent | 说明 |
|-------|-------------|-------------|------|
| 0 | success | ok: true | 成功，继续执行 |
| 1 | non-blocking error | ok: false 或 JSON 无效 | 错误，继续执行（只显示给用户） |
| 2 | blocking error | ok: false + reason | 阻塞错误，终止流程（显示给模型） |

## 4. 输入输出与错误处理

### 4.1 钩子输入结构

所有钩子接收相同的基础输入：

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/dir",
  "permission_mode": "ask|allow|deny",
  "agent_id": "agent-uuid",
  "agent_type": "agent-type"
}
```

事件特定字段：
- PreToolUse/PostToolUse: `tool_name`, `tool_input`, `tool_use_id`, `tool_output`
- SessionStart: `source`
- Stop: `stop_hook_active`
- UserPromptSubmit: `user_prompt`
- FileChanged: `file_path`, `event`
- PermissionRequest: `tool_name`, `tool_input`
- Elicitation: `mcp_server_name`, `message`, `requested_schema`

### 4.2 钩子输出规范

同步响应：
```json
{
  "continue": false,
  "stopReason": "Security check failed",
  "suppressOutput": true,
  "systemMessage": "Additional context for the model",
  "decision": "approve",
  "reason": "Permission granted",
  "permissionDecision": "allow",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Git command allowed",
    "additionalContext": "Verified git repo",
    "updatedInput": {"path": "/safe/path"},
    "updatedMCPToolOutput": {},
    "watchPaths": ["/file/to/watch"],
    "initialUserMessage": "Override user prompt",
    "retry": true
  }
}
```

异步响应（仅首行）：
```json
{"async": true, "asyncTimeout": 30000}
```

### 4.3 Prompt 请求交互

Command 钩子可通过 stdout 行输出 Prompt Request 与模型交互：

```json
{"promptRequest": "What is 2 + 2?", "maxTokens": 100}
```

系统通过 stdin 返回 Prompt Response：
```json
{"response": "4"}
```

`requestPrompt` 回调在 `execCommandHook` 中绑定，用于 UI 上下文和工具输入摘要。

### 4.4 错误分类

| 错误类型 | 触发场景 | 处理方式 |
|---------|---------|---------|
| Blocking Error | 退出码 2、`decision: "block"`、`permissionDecision: "deny"` | 终止流程，显示给模型 |
| Non-blocking Error | 退出码 1、JSON 验证失败、执行异常 | 继续执行，仅显示给用户 |
| Cancelled | 用户取消（Escape）或超时 | 静默失败或显示取消 |
| Trust Check Failed | 工作区未信任 | 跳过所有钩子（非交互模式除外） |

### 4.5 输出解析流程

1. 首行检查是否为 `{"async": true}`（异步钩子）
2. 尝试 JSON 解析，通过 Zod schema 验证
3. JSON 有效 → 提取 `hookSpecificOutput` 和通用字段
4. JSON 无效 → 当作文本处理
5. 根据 exit code 区分 success/blocking/non-blocking

## 5. 钩子生命周期与失败隔离

### 5.1 进程生命周期管理

Command 钩子：
- 包装在 `ShellCommand` 中管理子进程
- stdin 写入 hook input JSON
- stdout/stderr 流式捕获
- `TaskOutput` 缓冲区支持内存模式或 spill to disk
- 超时或取消时调用 `shellCommand.kill()`

内部钩子（Callback）：
- 直接函数调用，不创建进程
- 快速路径：纯内部回调（attribution、sessionFileAccess）跳过度量和事件
- 依然通过相同的超时和取消机制

### 5.2 异步钩子注册表（AsyncHookRegistry）

全局 `pendingHooks: Map<processId, PendingAsyncHook>` 管理：
- 跟踪所有后台钩子的进程、超时、进度上报
- `registerPendingAsyncHook()`：注册新钩子
- `checkForAsyncHookResponses()`：检查完成，返回响应
- `removeDeliveredAsyncHooks()`：清理已响应的钩子
- `finalizePendingAsyncHooks()`：会话结束时强制完成/取消

进度通过 `hookEvents` 模块发射 `HookProgressEvent`，间隔 1 秒上报。

### 5.3 失败隔离设计

关键隔离机制：
1. **钩子间隔离**：`Promise.allSettled()` + 独立执行上下文，一个失败不影响其他
2. **输出隔离**：每个钩子有独立的 stdout/stderr 缓冲区
3. **错误聚合**：结果独立收集，最终合并，blocking 错误优先
4. **权限隔离**：插件钩子使用独立的 pluginRoot 和 pluginId，环境变量隔离
5. **超时隔离**：每个钩子有独立的超时计时器，不共享

### 5.4 SessionEnd 钩子特殊处理

SessionEnd 钩子在关闭路径，需要极快执行：
- 默认超时 1.5 秒（非 10 分钟）
- 环境变量可配置 `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`
- `finalizePendingAsyncHooks()` 确保所有异步钩子被清理
- 不在此阶段启动新钩子

## 6. HTTP 钩子安全与代理

### 6.1 SSRF 防护

HTTP 钩子通过多层防护防止服务端请求伪造：
1. **URL 允许列表**：`allowedHttpHookUrls` 配置支持通配符 `*`
2. **SSRF 防护查找器**：`ssrfGuardedLookup()` 阻止私有/链路本地 IP（允许 localhost）
3. **沙箱代理**：沙箱模式下通过 `SandboxManager` 网络代理路由
4. **重定向限制**：`maxRedirects: 0`，禁止自动跟随重定向
5. **Header 注入防护**：`sanitizeHeaderValue()` 移除 CR/LF/NUL

### 6.2 环境变量插值

Header 值支持 `$VAR` 或 `${VAR}` 插值：
- 仅允许钩子配置的 `allowedEnvVars` 列表中的变量
- 策略 `allowedEnvVars` 与钩子列表取交集
- 未允许的变量替换为空字符串
- 插值后再次 sanitize 防止 header injection

### 6.3 代理配置

三种代理路径：
1. **沙箱代理**：`SandboxManager.getProxyPort()` → 强制路由，强制域检查
2. **环境变量代理**：`HTTP_PROXY/HTTPS_PROXY/NO_PROXY` → 全局 axios 拦截器
3. **直连**：无代理 → SSRF guard 检查 IP

代理激活时跳过 SSRF guard（避免验证代理自身 IP）。

## 7. Shell 与平台兼容性

### 7.1 Shell 选择

```
hook.shell → DEFAULT_HOOK_SHELL（"bash"）
              ↓
         将来可扩展为 settings.defaultShell
```

| shell 选项 | 平台 | 执行方式 |
|-----------|------|---------|
| "bash" | Windows/macOS/Linux | Git Bash（Windows）或系统 bash |
| "powershell" | 所有 | pwsh -NoProfile -NonInteractive -Command |

### 7.2 Windows 路径处理

Windows bash 需要 POSIX 路径：
- `windowsPathToPosixPath("C:\\Users\\x")` → `"/c/Users/x"`
- UNC 路径保留（`\\server\share` → `//server/share`）
- PowerShell 使用原生路径，不转换

路径转换封装在 `toHookPath` 函数中，应用于：
- 环境变量：`CLAUDE_PROJECT_DIR`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`
- 命令插值：`${CLAUDE_PLUGIN_ROOT}`
- `CLAUDE_ENV_FILE` 路径

### 7.3 插件变量插值

插件钩子支持：
- `${CLAUDE_PLUGIN_ROOT}`：插件根目录
- `${CLAUDE_PLUGIN_DATA}`：插件数据目录
- `${user_config.VAR}`：插件配置变量（来自 manifest 声明）

插值顺序：先插件变量，再用户配置变量（避免 `${CLAUDE_PLUGIN_ROOT}` 被用户配置解释）。

## 8. 设计决策与权衡

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
| 方案 | 0=success, 1=non-blocking, 2=blocking |
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
| 方案 | `hookDedupKey` = `source + command/prompt/url + if`，Map 去重 |
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

## 9. Coverage 与边界情况

[Coverage](../architecture/coverage/hooks-system.yaml)

### 9.1 边界疑虑

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

### 9.2 测试覆盖

`tests/headlessHooks.test.ts` 覆盖：
- prompt/agent stop hooks success/blocking/error 路径
- 取消信号传播
- 非 Stop 事件的模型钩子不支持

未覆盖：
- Command hooks（需要真实子进程）
- HTTP hooks（需要测试服务器）
- Async hooks（需要时间控制）
- 权限决策聚合
- `if` 条件匹配
- 路径转换（Windows）
