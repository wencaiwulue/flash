---
id: shell-tools
batch: 2
title: Shell Tools 命令执行、沙箱与进程生命周期设计
date: 2026-11-12
status: draft
---

# Shell Tools 命令执行、沙箱与进程生命周期设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Shell tools（Bash 和 PowerShell）需要解决的核心问题是如何在保证安全的前提下，让模型执行任意 shell 命令，同时支持前台/后台执行、超时控制、进程树终止、输出收集与截断，以及权限分类。

### 主要问题域

- **命令解析与安全检查**：需要解析命令行、管道、重定向，同时检测命令注入风险
- **前台/后台执行**：长时运行命令需要后台化，避免阻塞对话
- **输出限制与持久化**：输出过长时需要截断并保存到文件，模型可通过 FileRead 读取
- **进程树终止**：取消时需要终止整个进程树，而不只是主进程
- **沙箱边界**：哪些命令在沙箱中运行，哪些例外，如何配置
- **权限分类**：模型建议的描述与最终权限裁决分离，支持 deny/ask/allow 规则
- **Shell 差异**：Bash 与 PowerShell 的解析、引用和安全模型不同

### 调用方与责任边界

```
模型请求 (command/timeout/description/run_in_background)
  → BashTool/PowerShellTool 入口验证
  → 权限检查 (bashPermissions.ts)
  → 沙箱决策 (shouldUseSandbox)
  → Shell.ts 执行与进程管理
  → 输出收集、截断、持久化
  → 工具结果返回给模型
```

### 实际约束

- **平台差异**：macOS/Linux/WSL 支持沙箱，Windows 不支持；PowerShell 仅在 Windows 可用
- **安全模型**：Bash 使用 tree-sitter 解析，PowerShell 有其自己的安全检查
- **性能**：权限分类需要调用侧查询，异步但不阻塞过长时间
- **兼容性**：用户已有权限规则（前缀、通配符）需要继续工作

### 内部与外部差异

- CLI 有本地 TerminalCaptureTool，SDK 无；但后台任务在两者都有一致的生命周期
- 沙箱配置在 CLI 有 UI，SDK 通过设置文件/标志控制
- 权限裁决核心逻辑共享，但提示界面不同

## 2. 设计理由与备选方案

### 命令解析：tree-sitter 与 legacy regex 双轨

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 优先用 tree-sitter 解析命令为 AST，若失败或检测到危险结构（命令替换、扩展）则 fall back 到手动提示；若 tree-sitter 不可用则用 legacy regex 检查 |
| **为什么采用** | tree-sitter 能准确解析管道、重定向、引号和嵌套结构，避免误报；但 tree-sitter 不是在所有构建中都可用，且复杂命令可能解析失败，故需要 fall back 路径 |
| **备选方案及不采用原因** | 仅用 regex：误报率高，如 `echo "foo && bar"` 会被误认为两个命令；要求用户提供解析好的 argv：模型难以正确处理引用和转义 |
| **代价** | 两条路径需要分别测试，行为可能不完全一致 |
| **证据** | `parseCommandRaw()` + `parseForSecurityFromAst()` 与 `bashCommandIsSafeAsync()` 并存 |

### 权限分类：模型建议描述与最终裁决分离

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 用户配置 `Bash(prompt:描述)` 规则；权限检查时调用 `classifyBashCommand()` 让模型判断命令是否匹配描述；classifier 结果是建议，最终由 `bashToolHasPermission()` 做裁决；classifier 结果支持 `available/matches/confidence/matchedDescription` |
| **为什么采用** | 自然语言描述比精确模式更灵活，用户不需要学习语法；但分类器可能出错，最终控制权仍在代码 |
| **备选方案及不采用原因** | 仅用精确模式匹配：对复杂命令不够灵活；完全信任分类器：安全风险过高 |
| **代价** | 每次权限检查需要一次模型调用，增加延迟和成本 |
| **证据** | `bashClassifier.ts` 中的 `classifyBashCommand()` 与 `bashPermissions.ts` 中的消费逻辑 |

### 沙箱：默认启用但有例外

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `shouldUseSandbox()` 决定命令是否在沙箱中运行；例外：`excludedCommands` 配置、`dangerouslyDisableSandbox` 参数、Git 相关命令（需访问真实 Git 配置）；沙箱包装由 `SandboxManager.wrapWithSandbox()` 完成；沙箱内网络/文件系统有限制，由 `convertToSandboxRuntimeConfig()` 从权限规则生成 |
| **为什么采用** | 沙箱提供安全边界，但部分命令需要访问真实系统资源；例外机制让用户可根据信任程度调整 |
| **备选方案及不采用原因** | 全沙箱无例外：Git 等工具无法正常工作；无沙箱：安全风险过高；每个命令用户确认：交互体验差 |
| **代价** | 例外列表需要维护，用户可能误配置 |
| **证据** | `shouldUseSandbox.ts` 与 `SandboxManager` |

### 前台/后台执行：显式参数 + 自动超时 + 用户手动后台

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `run_in_background: true` 显式后台，立即返回 taskId；前台命令超过 `ASSISTANT_BLOCKING_BUDGET_MS`（15秒）在 assistant 模式自动后台；用户可通过 Ctrl+B 手动后台运行中的命令（先注册为 foreground task）；超时触发时也可自动后台；后台命令由 `LocalShellTask` 管理，输出写入文件，可通过 taskId 读取；优先用 `backgroundExistingForegroundTask()` 而不是重新 spawn 避免重复任务 |
| **为什么采用** | 既给模型显式控制，又防止长时命令阻塞对话；用户干预作为最后手段 |
| **备选方案及不采用原因** | 总是前台：长时命令体验差；总是后台：简单命令延迟增加；仅显式后台：模型可能忘记设置参数 |
| **代价** | 后台任务状态管理复杂，需要处理通知、输出文件生命周期 |
| **证据** | `BashTool.tsx` 中 `runShellCommand()`、`registerForeground()`、`backgroundExistingForegroundTask()`、`spawnShellTask()` 与 `LocalShellTask/` 目录 |

### 超时配置：默认 30 分钟，可自定义

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 默认超时：`DEFAULT_TIMEOUT = 30 * 60 * 1000`（30分钟）；用户可通过 `timeout` 参数自定义；有最大超时限制 `getMaxTimeoutMs()`；超时定时器用 `unref()` 避免阻塞进程退出；超时后先发送 `SIGTERM`，若不退出则升级到 `SIGKILL` |
| **为什么采用** | 给命令足够时间完成，但避免无限期挂起；用户可根据需求调整 |
| **备选方案及不采用原因** | 固定超时：不够灵活；无超时：可能无限挂起 |
| **代价** | 需要合理的默认值，用户可能设置不合理的超时 |
| **证据** | `BashTool.tsx` prompt.ts、`ShellCommand.ts` 超时逻辑 |

### 输出处理：截断 + 持久化 + 图片检测

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 输出超过限制时，前端用 `EndTruncatingAccumulator` 保留开头和结尾；完整输出写入临时文件，路径通过 `persistedOutputPath` 暴露给模型；stdout 和 stderr 合并写入同一文件以保持交错顺序；POSIX 用 O_APPEND 保证原子写入，Windows 用 'w' 模式避免 MSYS2 问题；检测 base64 图片输出，用 `buildImageToolResult()` 格式化为内容块；大输出（>64MB）截断后再持久化 |
| **为什么采用** | 工具结果有大小限制，但完整输出可能包含重要信息；图片需要特殊格式才能被模型理解 |
| **备选方案及不采用原因** | 仅截断丢弃：丢失重要信息；总是持久化：小命令开销大；不处理图片：模型无法理解图片输出 |
| **代价** | 需要管理临时文件生命周期，图片检测和调整大小有额外开销 |
| **证据** | `outputLimits.ts`、`TaskOutput.ts`、`resizeShellImageOutput()`、`Shell.ts` 输出文件逻辑 |

### 进程终止：信号 + 进程组 + 超时

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 超时用 `setTimeout` 触发，发送 `SIGTERM`，若不退出则升级到 `SIGKILL`；前台命令通过 AbortController 取消；后台命令通过 taskId 和 `stopTask()` 取消；进程组用于终止整个子进程树 |
| **为什么采用** | 单一信号可能无法终止顽固进程，进程组确保子进程也被清理 |
| **备选方案及不采用原因** | 仅 `SIGTERM`：进程可能忽略；仅 `SIGKILL`：不给进程清理机会；不处理进程组：子进程可能泄漏 |
| **代价** | 跨平台进程组处理复杂（Windows 与 POSIX 不同） |
| **证据** | `Shell.ts` 中的超时和取消逻辑 |

### Bash 与 PowerShell 共享抽象但独立实现

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | `shellProvider.ts` 定义共享接口 `ShellProvider`；`bashProvider.ts` 与 `powershellProvider.ts` 分别实现；两者共享输出限制、任务管理，但解析、安全检查和执行方式不同 |
| **为什么采用** | 共享核心逻辑减少重复，但两个 shell 差异太大，难以完全统一 |
| **备选方案及不采用原因** | 完全统一：抽象泄漏，无法处理 shell 特定行为；完全独立：大量重复代码 |
| **代价** | 需要维护两个实现，新增功能可能需要写两遍 |
| **证据** | `shell/` 目录结构与 `ShellProvider` 接口 |

### 权限规则：精确匹配 + 前缀 + 通配符 + 自然语言描述

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 优先精确匹配 `Bash(command)`；然后前缀匹配 `Bash(command:*)`；然后通配符匹配 `Bash(command*)`；然后自然语言描述分类（启用 `BASH_CLASSIFIER` feature）；deny 规则优先级高于 ask，ask 高于 allow |
| **为什么采用** | 精确匹配最安全，前缀/通配符更灵活，自然语言最易用；多级规则满足不同场景 |
| **备选方案及不采用原因** | 仅精确匹配：不够灵活；仅自然语言：不够精确，延迟高 |
| **代价** | 规则匹配逻辑复杂，需要测试所有组合 |
| **证据** | `bashPermissions.ts` 中的 `matchingRulesForInput()` |

### Git 裸仓库防护：拒绝写入 + 事后清理

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 检测到 cwd 是 Git 仓库时，拒绝写入 `HEAD`/`objects`/`refs` 等路径（已存在时）；若这些路径不存在但命令可能创建它们，事后用 `scrubBareGitRepoFiles()` 清理；阻止 `cd /tmp && git init && ...` 模式，避免在不可信目录创建裸仓库 |
| **为什么采用** | Git 裸仓库 + `core.fsmonitor` 配置可用于沙箱逃逸，需要多层防护 |
| **备选方案及不采用原因** | 总是拒绝：正常 Git 操作无法进行；仅事后清理：有时间窗口漏洞 |
| **代价** | 需要检测 Git 仓库状态，清理逻辑复杂 |
| **证据** | `sandbox-adapter.ts` 中的 bare git repo 防护 |

## 3. 目标与非目标

### 目标

- **提供安全的命令执行**：通过沙箱、权限规则、注入检测多层防护
- **支持灵活的权限配置**：精确匹配、前缀、通配符、自然语言描述多种方式
- **管理进程生命周期**：超时、取消、前台/后台切换、进程组终止
- **处理大输出与特殊输出**：截断、持久化、图片检测
- **同时支持 Bash 和 PowerShell**：共享抽象但各自实现
- **与现有权限系统集成**：不重新发明权限规则语法

### 非目标

- 不保证完全安全：这是多层防护，不是绝对保证；用户仍需谨慎
- 不替代完整容器：沙箱是轻量级隔离，不是完整容器
- 不解析所有 shell 语法：边缘情况可能 fall back 到手动确认
- 不跨平台统一所有行为：Windows 与 POSIX 信号、进程管理差异保留
- 不管理全局 shell 配置：用户 `.bashrc`/`.zshrc` 不在设计范围内
- 不吞并通用 permissions 域：权限裁决核心逻辑由 permissions 模块拥有

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**BashTool/PowerShellTool 入口：**
```typescript
// 主工具调用
{
  command: string,
  timeout?: number,
  description?: string,
  run_in_background?: boolean,
  dangerouslyDisableSandbox?: boolean,
  _simulatedSedEdit?: { filePath: string, newContent: string } // 内部
}
// → 输出
{
  stdout: string,
  stderr: string,
  interrupted: boolean,
  isImage?: boolean,
  backgroundTaskId?: string,
  backgroundedByUser?: boolean,
  assistantAutoBackgrounded?: boolean,
  persistedOutputPath?: string,
  persistedOutputSize?: number
}
```

**权限检查入口：**
```typescript
bashToolHasPermission(input, context): Promise<PermissionResult>
// 返回 behavior: deny/ask/allow/passthrough, 可选 pendingClassifierCheck
```

**Shell 执行入口：**
```typescript
exec(command, signal, shellType, options): Promise<ExecResult>
// 返回 stdout/stderr/code/interrupted，支持 onProgress 回调
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|-----|----------|---------|------------|----------------|
| `BashTool.tsx` | 运行中的前台命令、进度显示状态 | 输入验证、权限检查、调用 Shell.ts、输出处理 | 权限裁决、沙箱包装细节 | 接收 tool input，返回 tool output；调用 bashPermissions、Shell、SandboxManager |
| `PowerShellTool.tsx` | 同 BashTool | 同 BashTool（PowerShell 特定） | 同 BashTool | 同 BashTool，PowerShell 特定解析 |
| `bashPermissions.ts` | pendingClassifierChecks map、speculative 结果缓存 | 规则匹配、分类器调用、权限裁决 | 通用权限规则解析（由 permissions.ts 拥有） | 接收 command/context，返回 PermissionResult |
| `bashClassifier.ts` | 无（无状态） | 调用侧查询分类命令 | 权限规则存储 | 接收 command/descriptions/behavior，返回 ClassifierResult |
| `Shell.ts` / `ShellCommand.ts` | 运行中的进程、输出文件、超时定时器 | 生成执行命令、spawn 进程、处理输出、超时/取消 | UI 显示、权限检查 | 接收 command/options，返回 ExecResult；调用 shellProvider |
| `shellProvider.ts` | 无（接口定义） | buildExecCommand、getSpawnArgs、getEnvironmentOverrides | 实际进程 spawn | 被 Shell.ts 调用；bashProvider/powershellProvider 实现 |
| `SandboxManager` (sandbox-adapter.ts) | 初始化状态、配置订阅、worktreeMainRepoPath、bareGitRepoScrubPaths | wrapWithSandbox、convertToSandboxRuntimeConfig、cleanupAfterCommand | 权限规则来源（仅消费） | 被 Shell.ts 调用；消费权限 settings |
| `LocalShellTask` | tasks map、polling 状态 | spawnShellTask、后台任务管理、通知 | 前台执行 | 被 BashTool/PowerShellTool 调用；管理后台任务 |
| `TaskOutput` | 无（纯函数） | startPolling、stopPolling、输出文件路径 | 任务状态存储 | 被 Shell.ts/LocalShellTask 调用 |

### 4.3 主控制流

**前台命令完整流程：**
```
模型请求
  → 输入验证 (validateInput)
  → 权限检查 (bashToolHasPermission)
    → 精确规则匹配
    → 前缀/通配符规则匹配
    → AST 解析与安全检查 (parseForSecurityFromAst)
    → 分类器调用 (可选，speculative/async)
  → 沙箱决策 (shouldUseSandbox)
  → ShellProvider.buildExecCommand
    → 环境变量设置
    → 快照 sourcing
    → 禁用 extglob
    → eval 包装
  → Shell.ts spawn
    → 输出到临时文件
    → onProgress 回调
    → 超时检测
  → 等待完成或取消
  → 输出处理
    → 截断
    → 图片检测与调整大小
    → Claude Code hints 提取
  → 持久化大输出
  → 返回工具结果
```

**后台命令流程：**
```
模型请求 run_in_background: true
  → 输入验证
  → 权限检查
  → spawnShellTask
  → 立即返回 { stdout: "", stderr: "", backgroundTaskId }
  → 后台异步执行
    → 输出写入 task file
    → 完成时发送通知
  → 用户/模型后续用 Read 读取输出或用 taskId 查询
```

**权限裁决详细流程：**
```
bashToolHasPermission 被调用
  → 检查精确规则匹配
  → 检查前缀/通配符规则匹配
  → 尝试 AST 解析 (parseCommandRaw + parseForSecurityFromAst)
    → 若 tooComplex → checkEarlyExitDeny → ask
    → 若有语义问题 (eval/…) → checkSemanticsDeny → ask
  → 检查沙箱 autoAllow (若启用且无 explicit deny/ask)
  → 检查 Bash prompt deny/ask 规则 (并行调用 classifyBashCommand)
    → 若 deny match high confidence → deny
    → 若 ask match high confidence → ask
  → 检查命令操作符 (管道/&&/||/…)
  → 检查路径约束 (pathValidation)
  → 检查只读约束 (readOnlyValidation)
  → 检查 sed 约束 (sedValidation)
  → 检查复合命令子命令
  → 生成建议规则
  → 构建 pendingClassifierCheck (若启用)
  → 返回 ask/passthrough 或 allow
```

### 4.4 关键数据结构

**CommandPrefixResult（前缀提取结果）：**
```typescript
{
  commandPrefix: string | null,  // 可用于规则的前缀，如 "npm run"
  subcommandPrefixes: Map<string, string>  // 复合命令每个子命令的前缀
}
```

**ClassifierResult（分类器结果）：**
```typescript
{
  available: boolean,           // 分类是否可用
  matches: boolean,             // 是否匹配
  matchedDescription?: string,  // 匹配的描述
  confidence: "high" | "medium" | "low",
  reason: string
}
```

**PermissionResult（权限结果）：**
```typescript
{
  behavior: "deny" | "ask" | "allow" | "passthrough",
  message?: string,
  decisionReason: { type: "rule" | "classifier" | "other", ... },
  suggestions?: PermissionUpdate[],
  pendingClassifierCheck?: PendingClassifierCheck,
  updatedInput?: Input
}
```

**ParseForSecurityResult（安全解析结果）：**
```typescript
{ kind: "tooComplex", reason: string, nodeTypeId: number } |
{ kind: "parseUnavailable" } |
{ kind: "simple", commands: SimpleCommand[], redirects: Redirect[] }
```

**SandboxRuntimeConfig（沙箱配置）：**
```typescript
{
  network: { allowedDomains, deniedDomains, ... },
  filesystem: { allowWrite, denyWrite, allowRead, denyRead },
  ignoreViolations,
  enableWeakerNestedSandbox,
  ripgrep: { command, args, argv0 }
}
```

### 4.5 跨子系统依赖

| 依赖 | 用途 | 所属 spec |
|-----|-----|---------|
| `permissions.ts` | 通用权限规则解析、规则存储 | permissions 域 |
| `settings.ts` | 读取沙箱配置、权限规则 | settings 域 |
| `fileHistory.ts` | sed 编辑模拟的文件历史 | file-history 域 |
| `mcp/vscodeSdkMcp.ts` | sed 编辑后通知 VS Code | mcp 域 |
| `analytics/index.ts` | 记录命令执行、分类器结果 | analytics 域 |
| `sideQuery.ts` | 调用小模型做分类 | model-query 域 |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|--------|--------|-----------------|--------------|--------------|--------------|
| 命令注入检测到危险模式 | `bashCommandIsSafeAsync()` / `parseForSecurityFromAst()` | 返回 ask behavior，无异常 | 否（用户决定） | 无（命令未启动） | `{ behavior: "ask", message: "...", suggestions: [] }` |
| 权限拒绝规则匹配 | `matchingRulesForInput()` | 返回 deny behavior，无异常 | 否 | 无（命令未启动） | `{ behavior: "deny", message: "..." }` |
| 分类器不可用 | `classifyBashCommand()` | 返回 unavailable，fallback 到手动确认 | 否（maxRetries=1） | 无 | `{ available: false, matches: false, ... }` |
| 沙箱初始化失败 | `SandboxManager.initialize()` | 记录日志，fallback 到无沙箱（若 allowUnsandboxedCommands） | 否 | 清理部分初始化 | 命令无沙箱运行，或拒绝 |
| 命令超时 | `Shell.ts` setTimeout | 设置 `interrupted: true`，发送 SIGTERM → SIGKILL | 否（超时是最终结果） | 终止进程组，关闭输出文件 | `{ stdout, stderr, interrupted: true, code }` |
| 用户取消/AbortController | `signal.addEventListener("abort")` | 抛出 AbortError，被捕获后设置 interrupted | 否 | 终止进程组，停止 poller，清理定时器 | `{ stdout, stderr, interrupted: true }` |
| 后台任务被停止 | `stopTask()` | 更新任务状态为 stopped | 否 | 终止进程，保留输出文件供读取 | 任务状态变为 stopped |
| 输出文件写入失败 | `Shell.ts` fs.write | 抛出异常，被捕获后 stderr 记录错误 | 否 | 关闭文件，删除部分写入的文件 | `{ stdout, stderr: "...", code: 1 }` |
| 图片解析失败 | `resizeShellImageOutput()` | 记录日志，fallback 到文本输出 | 否 | 释放图片 buffer | `isImage` 不设置，输出作为文本 |
| tree-sitter 解析失败 | `parseCommandRaw()` | 返回 `{ kind: "parseUnavailable" }`，fallback 到 legacy 路径 | 否 | 无 | 使用 regex 重新检查 |
| 复合命令子命令过多 | `bashToolHasPermission()` | 返回 ask | 否 | 无 | `{ behavior: "ask", decisionReason: { type: "other", reason: "..." } }` |

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 分类器 vs 仅规则 | 两者都有，规则优先 | 增加延迟和成本 | 更灵活的权限描述 |
| tree-sitter vs regex | tree-sitter 优先，regex fallback | 代码复杂度增加 | 更准确的解析，更少误报 |
| 沙箱默认启用 vs 默认禁用 | 默认启用（若平台支持） | 部分命令需要例外 | 安全边界默认存在 |
| 前台超时自动后台 vs 总是等待 | 自动后台（assistant 模式） | 状态管理复杂 | 对话保持响应 |
| 输出截断保留两端 vs 仅开头 | 两端都保留 | 实现复杂 | 既看开头错误，也看结尾总结 |
| 大输出持久化 vs 仅截断 | 持久化 + FileRead | 临时文件需要管理 | 完整输出可被模型访问 |
| 进程组终止 vs 仅主进程 | 进程组 | 跨平台复杂 | 无孤儿进程泄漏 |

## 6. 现状验收标准

1. **给定**含命令替换的命令，**当** `parseForSecurityFromAst()` 被调用时，**必须**返回 `tooComplex`
2. **给定**带引号的管道命令，**当** `parseForSecurityFromAst()` 被调用时，**必须**返回 `simple` 且正确识别子命令
3. **给定** `Bash(prompt:列出文件)` 规则和 `ls -la` 命令，**当** `classifyBashCommand()` 被调用时，**必须**返回高置信度匹配
4. **给定**沙箱启用且命令不在例外列表，**当** `shouldUseSandbox()` 被调用时，**必须**返回 true
5. **给定** `run_in_background: true`，**当**命令执行时，**必须**立即返回 `backgroundTaskId`
6. **给定**长输出，**当**处理时，**必须**由 `EndTruncatingAccumulator` 正确保留开头和结尾
7. **给定**超时，**当**触发时，**必须**终止进程组且设置 `interrupted: true`
8. **给定** cwd 有 Git 仓库，**当**写入裸仓库路径时，**必须**被拒绝或事后清理

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 命令用 tree-sitter 解析，fallback 到 regex | `src/utils/bash/ast.ts` `parseForSecurityFromAst()` | `tests/bashParser.test.ts` 验证各种命令结构 | tree-sitter 在某些构建中不可用，需测试 legacy 路径 |
| 权限分类器用 sideQuery 调用小模型 | `src/utils/permissions/bashClassifier.ts` `classifyBashCommand()` | `tests/bashClassifier.test.ts` 验证分类、prompt 规则解析、分类器不可用 fallback | 侧查询可能失败/超时，需测试不可用路径 |
| 沙箱配置从权限规则生成 | `src/utils/sandbox/sandbox-adapter.ts` `convertToSandboxRuntimeConfig()` | 需补充测试 | sandbox-runtime 包的行为是外部依赖 |
| 命令超时与进程组终止 | `src/utils/Shell.ts` 超时逻辑、kill 逻辑 | 需补充测试 | 跨平台进程组行为有差异（Windows vs POSIX） |
| 输出截断保留两端 | `src/utils/stringUtils.ts` `EndTruncatingAccumulator` | 需补充测试 | 截断点选择是启发式 |
| 大输出持久化 | `src/utils/toolResultStorage.ts` `buildLargeToolResultMessage()` | 需补充测试 | 临时文件生命周期管理（何时删除） |
| 后台任务管理 | `src/tasks/LocalShellTask/LocalShellTask.ts` | 需补充测试 | 任务持久化与恢复不在当前范围 |
| Bash/PowerShell 共享抽象 | `src/utils/shell/shellProvider.ts` `ShellProvider` 接口 | 需补充测试 | PowerShell 支持仅限 Windows |
| Git 裸仓库防护 | `src/utils/sandbox/sandbox-adapter.ts` bareGitRepoScrubPaths、`scrubBareGitRepoFiles()` | 需补充测试 | 仅保护特定路径，不是全面 Git 安全 |
| 复合命令权限检查 | `src/tools/BashTool/bashPermissions.ts` `checkCommandOperatorPermissions()` | `tests/bashPermissionsClassifier.test.ts` 验证复合命令处理 | 子命令数量限制为 50，超过返回 ask |

### 未覆盖

- 跨平台行为差异（Windows vs macOS vs Linux vs WSL）
- 并发命令执行（同一工具的多个调用同时运行）
- 沙箱逃逸途径的完整覆盖
- PowerShell 完整测试覆盖
- 后台任务持久化与重启后恢复

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/shell-tools.yaml)

### 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|----------|------------------|----------------|
| bash-tool | BashTool 主实现、UI、权限检查 | `tests/bashPermissionsClassifier.test.ts`、`tests/bashClassifier.test.ts` | permissions.ts（通用权限） |
| powershell-tool | PowerShellTool 主实现、UI、权限检查 | 需补充 | 同 bash-tool |
| bash-utils | Bash 解析、AST、引用、前缀提取 | 需补充 |  |
| shell-utils | ShellProvider 抽象、输出限制、TaskOutput | 需补充 |  |
| sandbox | 沙箱适配器、配置转换、裸 Git 防护 | 需补充 | sandbox-runtime 包（外部） |
| local-shell-task | 后台任务管理、polling、通知 | 需补充 |  |

### 相关子系统

- **permissions 域**：通用权限规则解析、存储、应用；本 spec 仅覆盖 Bash/PowerShell 特定部分
- **query-core**：工具调用的生命周期，与本 spec 在工具执行点交互
- **file-history**：sed 编辑模拟依赖文件历史
- **mcp**：VS Code 通知由 MCP 处理

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P0 | 分类器失败时返回 unavailable，可区分临时性失败（网络/超时）与永久性不可用 | 区分临时性错误（网络、超时）与永久性错误；临时性错误可在后台静默重试，同时显示手动确认 | 低（仅改进降级路径） | 分类器临时失败时自动重试 | M | 已证实（基于代码阅读） |
| P1 | 沙箱配置无明确反馈，违规仅注释在 stderr | 提供命令查看沙箱状态、启用的规则、违规日志；沙箱违规时更明显提示（如在工具结果中单独字段）；沙箱不可用时明确错误信息，包含修复步骤 | 低（仅新增 UI 和日志） | 用户能清晰看到沙箱状态和违规 | M | 设计推断 |
| P2 | 后台任务可启动和停止，但缺少查看任务列表、查看任务状态、读取任务部分输出、重新等待任务完成的功能 | 新增列出后台任务的工具；新增查询任务状态的工具；新增读取任务输出（从 offset 开始）的工具；新增等待任务完成的工具 | 中（需要确保任务状态一致，新增工具不破坏现有功能） | 所有新工具正常工作 | L | 设计推断 |
| P3 | 权限规则通过设置文件编辑，对于自然语言描述规则，用户可能难以写出准确的描述 | 提供命令查看当前规则；提供向导式创建规则，从历史命令中选择并生成描述；分类器结果可视化，显示为什么匹配/不匹配 | 低（仅新增 UI 和工具） | 向导式创建规则正常工作 | L | 设计推断 |
