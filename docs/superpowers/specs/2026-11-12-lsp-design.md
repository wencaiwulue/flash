---
id: lsp
batch: 2
title: LSP 语言服务生命周期与工具集成设计
date: 2026-11-12
status: draft
---

# LSP 语言服务生命周期与工具集成设计

## 1. 问题与约束

Claude Code 中 Language Server Protocol (LSP) 集成面临的约束包括：

- 需要提供一致的 LSP 服务管理，支持多语言服务器
- 实现完整的服务器生命周期（启动、初始化、请求处理、关闭）
- 提供与 LSP 交互的工具接口（goToDefinition、findReferences、hover 等）
- 实现被动诊断（diagnostics）的异步推送与展示
- 确保错误隔离和服务器健康监控
- 支持服务器崩溃自动重启
- 服务器配置完全来自插件（不支持用户/项目设置）
- 延迟启动服务器（首次使用时启动，不是初始化时）
- 延迟加载 LSPClient（使用 `require()` 延迟加载 vscode-jsonrpc，约 129KB）
- 支持 stdio 传输（当前仅支持，types 中有 socket 但未实现）
- 识别 LSP 错误代码 -32801（ContentModified）并自动指数退避重试
- 用户输入和显示使用 1-based 行号/字符位置，LSP 协议使用 0-based，在 `getMethodAndParams()` 中转换
- 在 `findReferences`、`goToDefinition`、`workspaceSymbol` 操作中自动过滤 gitignored 文件的结果
- 单个服务器崩溃不影响其他服务器
- 服务器启动/初始化有超时配置
- 通知处理错误隔离（单个通知处理失败不影响其他通知或服务器）

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 全局单例管理器 | 使用模块级单例 `lspManagerInstance` | LSP 服务器是全局资源，不需要多个实例；简化初始化（Claude Code 启动时一次初始化）；避免重复启动服务器 | 按 workspace 或 session 创建管理器（过度设计）、依赖注入（当前代码库不使用 DI） | 测试时可能需要重置单例 | LSPServerManager 实现 |
| 配置仅来自插件 | LSP 服务器配置完全通过插件提供，不支持用户/项目设置 | 与现有插件架构一致；插件可以正确打包和配置语言服务器；避免复杂的配置合并逻辑 | 支持项目/.claude 配置（增加复杂度，当前无需求）、混合插件+用户配置（配置优先级难以处理） | 用户无法自定义 LSP 配置 | `getAllLspServers()` 实现 |
| lazy start + lazy load | 服务器仅在首次使用时启动（不是初始化时）；`LSPClient` 使用 `require()` 延迟加载 vscode-jsonrpc | 减少启动时间（不启动不需要的服务器）；减少内存占用（不需要时不加载 129KB 的 vscode-jsonrpc）；提高容错（一个服务器启动失败不影响其他） | 初始化时启动所有服务器（慢，浪费资源）、eager load LSPClient（总是加载大依赖） | 首次使用时有延迟 | `LSPServerInstance.ts` lazy load 注释 |
| 结构化诊断注册表 | 使用 `LSPDiagnosticRegistry` 跟踪待处理诊断，支持去重和跨回合记忆，`MAX_DIAGNOSTICS_PER_FILE = 10`，`MAX_TOTAL_DIAGNOSTICS = 30`，`deliveredDiagnostics` LRU 缓存（最大 500 文件）用于跨回合去重，编辑文件时清除该文件的已交付诊断 | 与 AsyncHookRegistry 保持一致的异步交付模式；避免重复显示相同诊断；支持容量限制（避免过多诊断刷屏） | 直接传递到对话（无去重，无记忆）、另一种存储方式（增加不一致性） | 需要维护注册表状态 | passiveFeedback.ts 实现 |
| stdio 传输为唯一支持 | 当前仅支持 stdio 传输（types 中有 socket，但未实现） | 绝大多数 LSP 服务器支持 stdio；Socket 需要额外的端口管理和生命周期；当前无实际需求 | 实现 socket 传输（未来可扩展） | 不支持需要 socket 传输的 LSP 服务器 | LSPServerInstance types |
| ContentModified 自动重试 | 识别 LSP 错误代码 -32801 并自动指数退避重试，`MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3`，`RETRY_BASE_DELAY_MS = 500`（500ms, 1s, 2s） | 这是常见情况（rust-analyzer 索引中）；用户不需要知道这个细节；透明重试提供更好体验 | 直接失败（用户体验差）、固定间隔重试（不如指数退避） | 可能短暂延迟响应 | `sendRequest()` 实现 |
| 位置 1-based vs 0-based | 用户输入和显示：1-based（编辑器显示方式）；LSP 协议：0-based；在 `getMethodAndParams()` 中转换 | 符合用户心智模型（行号从 1 开始）；严格遵守 LSP 协议；转换集中在一处 | 全部 0-based（不符合用户心智）、全部 1-based（不符合 LSP 协议）、转换分散在多处（容易出错） | 需要注意转换正确 | `LSPTool.ts` getMethodAndParams |
| gitignored 结果过滤 | 在 `findReferences`、`goToDefinition`、`workspaceSymbol` 操作中，自动过滤 gitignored 文件的结果，使用 `git check-ignore` 批量检查 | 避免显示 node_modules 等依赖库的引用；聚焦于用户代码 | 不过滤（显示太多无关结果）、手动过滤（用户体验差） | 需要 git 支持，可能略微增加延迟 | LSPTool 操作实现 |
| 错误隔离（服务器级别） | 单个服务器崩溃不影响其他服务器，管理器继续处理其他服务器的请求，错误记录在 `instance.lastError` | 提高容错，一个语言服务器不影响其他语言 | 全局崩溃（容错差） | 需要维护每个服务器的状态 | LSPServerManager 实现 |
| 崩溃自动重启 | `config.restartOnCrash` 启用自动重启，`config.maxRestarts` 最大重启次数（默认 3），客户端 crash handler 调用 `instance.restart()`，超过 `maxRestarts` 后状态固定为 'error' | 提高可用性， transient crash 自动恢复 | 不重启（用户需要手动重启）、无限重启（可能造成资源浪费） | 需要维护重启计数 | LSPServerInstance 实现 |
| 通知处理错误隔离 | `passiveFeedback.ts` 中的注册器，`instance.onNotification('textDocument/publishDiagnostics', (params) => { try { /* 转换和注册 */ } catch (error) { /* 仅记录，不抛出 */ /* 跟踪连续失败次数 */ } })` | 单个通知处理失败不影响其他通知或服务器 | 抛出错误（可能导致服务器崩溃） | 需要捕获并记录错误 | passiveFeedback.ts 实现 |

## 3. 目标与非目标

### 目标
- 提供一致的 LSP 服务管理，支持多语言服务器
- 实现完整的服务器生命周期（启动、初始化、请求处理、关闭）
- 提供与 LSP 交互的工具接口（goToDefinition、findReferences、hover 等）
- 实现被动诊断（diagnostics）的异步推送与展示
- 确保错误隔离和服务器健康监控
- 支持服务器崩溃自动重启
- 延迟启动服务器（首次使用时启动）
- 延迟加载 LSPClient（减少内存占用）
- 识别 ContentModified 错误并自动指数退避重试
- 自动过滤 gitignored 文件的结果
- 提供结构化诊断注册表，支持去重和跨回合记忆

### 非目标
- 不支持 socket 传输（当前仅支持 stdio）
- 不支持用户/项目级 LSP 配置（仅来自插件）
- 不实现 LSP 所有功能（仅实现常用功能）
- 不提供 LSP 服务器安装功能（由插件负责）
- 不支持远程 LSP 服务器（当前仅本地）

## 4. 架构、模块与数据流

### 模块设计卡：LSPServerManager（全局单例管理器）

**真实入口签名/关键类型**
```typescript
// src/services/lsp/manager.ts
export function initializeLspServerManager(): void
export function getInitializationStatus(): 
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error }
export async function waitForInitialization(): Promise<void>
export function isLspConnected(): boolean
export function getLspServerManager(): LSPServerManager | undefined
export function reinitializeLspServerManager(): void
export async function shutdownLspServerManager(): Promise<void>

// src/services/lsp/LSPServerManager.ts
export function createLSPServerManager(): LSPServerManager
export type LSPServerManager = {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  getServerForFile(filePath: string): LSPServerInstance | undefined
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T | undefined>
  getAllServers(): Map<string, LSPServerInstance>
  openFile(filePath: string, content: string): Promise<void>
  changeFile(filePath: string, content: string): Promise<void>
  saveFile(filePath: string): Promise<void>
  closeFile(filePath: string): Promise<void>
  isFileOpen(filePath: string): boolean
}
```

**输入输出**
- 输入：插件配置（通过 `getAllLspServers()` 加载）、文件路径、LSP 方法与参数
- 输出：LSPServerInstance 映射、请求响应、文档同步确认

**Server 状态与文档状态**
- 内部私有状态：
  - `servers: Map<string, LSPServerInstance>` - 按名称存储服务器实例
  - `extensionMap: Map<string, string[]>` - 扩展名到服务器名称列表的映射
  - `openedFiles: Map<string, string>` - 已打开文件 URI 到服务器名称的映射
- 初始化后：servers 包含所有配置的服务器（但未启动）、extensionMap 填充
- 文档状态：通过 `isFileOpen()` 检查，`openedFiles` 跟踪已同步到 LSP 服务器的文件

**启动/请求/诊断/关闭流程**
- 初始化流程：
  1. `initializeLspServerManager()` 被调用（仅非 bare 模式）
  2. 创建 LSPServerManager 单例，状态设为 'pending'
  3. 异步调用 `manager.initialize()`，不阻塞启动
  4. `initialize()` 加载所有插件的 LSP 配置，创建服务器实例
  5. 注册 `workspace/configuration` 请求处理器（返回空配置）
  6. 成功后注册被动诊断通知处理器
- 请求路由流程：
  1. 根据文件扩展名查找服务器
  2. `ensureServerStarted()` 确保服务器运行
  3. 转发请求到对应实例
- 文档同步流程：
  1. `openFile()`: 转换为 URI，检查是否已打开，发送 didOpen，记录到 openedFiles
  2. `changeFile()`: 检查文件是否已打开，未打开则先 open，发送 didChange
  3. `saveFile()`: 发送 didSave
  4. `closeFile()`: 发送 didClose，从 openedFiles 移除
- 关闭流程：
  1. `shutdown()` 收集所有状态为 'running' 或 'error' 的服务器
  2. 并行调用 `server.stop()`，使用 Promise.allSettled
  3. 清空 servers、extensionMap、openedFiles
  4. 有错误时记录并抛出

**超时取消重试**
- 初始化：无单独超时（依赖服务器启动超时）
- 关闭：无单独超时（依赖服务器关闭超时）
- 世代计数器 `initializationGeneration`：防止旧的初始化 promise 更新状态

**错误隔离**
- 单个服务器配置加载失败不影响其他服务器
- `getAllLspServers()` 出错仅记录，不抛出
- 单个服务器关闭失败不影响其他服务器，不阻止状态清理
- 管理器初始化失败不影响 Claude Code 其他功能（LSP 功能不可用）

**设计取舍/备选**
- 全局单例 vs 按 workspace：选择单例，简化生命周期，当前架构无多 workspace 需求
- 初始化异步 vs 同步：选择异步，不阻塞 Claude Code 启动
- 错误隔离：单个服务器失败不影响其他，而不是全局失败
- 备选：依赖注入管理器 - 当前代码库不使用 DI 模式
- 备选：按会话创建管理器 - 过度设计，当前需求不需要

**源码测试证据**
- 源码：`src/services/lsp/manager.ts`、`src/services/lsp/LSPServerManager.ts`
- 测试：`tests/lspLifecycle.test.ts`（覆盖初始化、关闭流程）

**边界条件**
- `closeFile()` 目前可用但未与 compact 流程集成（源码中有注释说明）
- `reinitializeLspServerManager()` 安全地处理未初始化状态
- bare 模式下跳过初始化

---

### 模块设计卡：LSPServerInstance（服务器实例）

**真实入口签名/关键类型**
```typescript
// src/services/lsp/LSPServerInstance.ts
export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig
): LSPServerInstance

export type LSPServerInstance = {
  readonly name: string
  readonly config: ScopedLspServerConfig
  readonly state: LspServerState  // 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  readonly startTime: Date | undefined
  readonly lastError: Error | undefined
  readonly restartCount: number
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  isHealthy(): boolean
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>
  ): void
}

// ContentModified 重试参数（硬编码常量）
const LSP_ERROR_CONTENT_MODIFIED = -32801
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3
const RETRY_BASE_DELAY_MS = 500
// 实际延迟：500ms, 1000ms, 2000ms（3次重试，共4次尝试）
```

**输入输出**
- 输入：服务器名称、配置、LSP 方法与参数
- 输出：LSP 响应、通知确认

**Server 状态与文档状态**
- 服务器状态机：
  - 'stopped' → 'starting' → 'running'
  - 'running' → 'stopping' → 'stopped'
  - 任何状态 → 'error'（失败时）
  - 'error' → 'starting'（重启时）
- 状态通过闭包私有变量存储，通过 getter 暴露只读
- 内部状态：
  - `state: LspServerState`
  - `startTime: Date | undefined`
  - `lastError: Error | undefined`
  - `restartCount: number`
  - `crashRecoveryCount: number`（崩溃恢复计数，与手动 restartCount 分开）

**启动/请求/诊断/关闭流程**
- 启动流程：
  1. 检查状态，已 'running' 或 'starting' 直接返回
  2. 检查 maxRestarts 限制（crashRecoveryCount > maxRestarts 时抛出）
  3. 状态切换为 'starting'
  4. `client.start()` 启动子进程
  5. 等待 spawn 确认
  6. 构造 initialize 参数：
     - `processId`
     - `workspaceFolders`（当前 cwd）
     - `rootPath` / `rootUri`（deprecated 但保留兼容性）
     - `initializationOptions`（来自插件配置）
     - 客户端能力：声明不支持 `workspace/configuration`、不支持 `workspaceFolders` 变更，支持 `textDocument/hover`、`definition`、`references`、`documentSymbol`、`callHierarchy`、`publishDiagnostics`
     - `positionEncodings: ['utf-16']`
  7. `client.initialize()`（可选超时配置）
  8. 状态切换为 'running'，reset crashRecoveryCount
- 请求流程：
  1. `isHealthy()` 检查：state === 'running' 且 client.isInitialized
  2. 调用 `client.sendRequest()`
  3. 捕获错误，检查 `error.code === -32801`（ContentModified）
  4. 指数退避重试（最多 3 次）
  5. 所有重试失败后抛出
- 关闭流程：
  1. 状态切换为 'stopping'
  2. `client.stop(config.shutdownTimeout)`
  3. 状态切换为 'stopped'
- 重启流程：
  1. `stop()` 先停止
  2. restartCount++
  3. 检查 maxRestarts 限制
  4. `start()` 重新启动

**超时取消重试**
- 启动超时：`config.startupTimeout`（可选），使用 `withTimeout()` 包装 initialize
- 关闭超时：`config.shutdownTimeout`（可选），超时后 `process.kill()`
- ContentModified 重试：
  - 最大重试次数：3 次（MAX_RETRIES_FOR_TRANSIENT_ERRORS）
  - 基础延迟：500ms（RETRY_BASE_DELAY_MS）
  - 退避策略：指数退避（500ms, 1000ms, 2000ms）
  - 重试条件：仅 `error.code === -32801`
- withTimeout 实现：使用 Promise.race，清理定时器避免泄漏

**错误隔离**
- 单个服务器崩溃不影响其他服务器（crash handler 仅更新自身状态）
- crash handler 捕获非零退出码，设置 state = 'error'
- restartOnCrash 启用时自动重启，受 maxRestarts 限制
- maxRestarts 同时限制 crashRecoveryCount（崩溃恢复）和 restartCount（手动重启）
- 初始化失败时清理：client.stop() 清理子进程，initPromise.catch() 避免未处理拒绝

**设计取舍/备选**
- 状态机 vs 简单标志：选择状态机，更清晰的生命周期跟踪
- crashRecoveryCount 与 restartCount 分开：区分自动崩溃恢复与手动重启
- 幂等 start()：已 starting/running 时直接返回
- 备选：socket 传输 - types 中有定义但未实现
- 备选：支持取消请求 - 当前未实现

**源码测试证据**
- 源码：`src/services/lsp/LSPServerInstance.ts`
- 测试：`tests/lspLifecycle.test.ts`（覆盖启动、初始化、停止、崩溃重启、重启策略）

**边界条件**
- transport 仅支持 'stdio'，'socket' 在 types 中定义但未实现
- 初始化时同时发送 workspaceFolders（现代）和 rootPath/rootUri（兼容旧服务器）
- 客户端能力明确声明不支持 workspace/configuration 和 workspaceFolders 变更
- 进程 spawn 后等待 'spawn' 事件确认，而不是立即使用

---

### 模块设计卡：LSPClient（延迟加载客户端）

**真实入口签名/关键类型**
```typescript
// src/services/lsp/LSPClient.ts
export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void
): LSPClient

export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string }
  ): Promise<void>
  initialize(params: InitializeParams): Promise<InitializeResult>
  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>
  ): void
  stop(shutdownTimeoutMs?: number): Promise<void>
}
```

**输入输出**
- 输入：命令、参数、环境变量、工作目录、LSP 方法与参数
- 输出：初始化结果、请求响应

**Server 状态与文档状态**
- 内部私有状态（闭包）：
  - `process: ChildProcess | undefined`
  - `connection: MessageConnection | undefined`
  - `capabilities: ServerCapabilities | undefined`
  - `isInitialized: boolean`
  - `startFailed: boolean`
  - `startError: Error | undefined`
  - `isStopping: boolean`
  - `connectionClosed: boolean`
  - `pendingHandlers: Array<{ method: string; handler: (params: unknown) => void }>`
  - `pendingRequestHandlers: Array<{ method: string; handler: (params: unknown) => unknown | Promise<unknown> }>`
- 延迟加载：通过 `require('./LSPClient.js')` 按需加载，不使用 import 静态加载
- 延迟处理器注册：连接建立前注册的处理器放入 pendingHandlers，连接就绪后应用

**启动/请求/诊断/关闭流程**
- 启动流程：
  1. `spawn(command, args, options)` 启动子进程
  2. 等待 'spawn' 事件确认（关键！防止写入无效流）
  3. 设置 stderr 捕获（记录到 debug 日志）
  4. 设置 'error' 事件监听器
  5. 设置 'exit' 事件监听器（非零退出码且非 stopping 时触发 onCrash）
  6. 设置 stdin 'error' 事件监听器
  7. 创建 `StreamMessageReader(process.stdout)` 和 `StreamMessageWriter(process.stdin)`
  8. 创建 `createMessageConnection(reader, writer)`
  9. 注册 connection 'error' 和 'close' 处理器
  10. `connection.listen()`
  11. `connection.trace(Trace.Verbose)` 启用协议追踪
  12. 应用 pendingHandlers 和 pendingRequestHandlers
- 请求流程：
  1. 检查 connection 存在
  2. 检查 startFailed
  3. 检查 isInitialized
  4. `connection.sendRequest(method, params)`
- 通知流程：
  1. 检查 connection 存在
  2. 检查 startFailed
  3. `connection.sendNotification(method, params)`
  4. 通知出错仅记录，不抛出（fire-and-forget）
- 处理器注册流程：
  1. 连接未就绪时放入 pendingHandlers/pendingRequestHandlers
  2. 连接就绪后直接注册到 connection
- 关闭流程：
  1. 设置 `isStopping = true`（抑制错误日志）
  2. 启动超时定时器（如提供），超时后 `process.kill()`
  3. 尝试发送 `shutdown` 请求
  4. 尝试发送 `exit` 通知
  5. `connection.dispose()`
  6. 清理 process 事件监听器
  7. `process.kill()` 确保进程终止
  8. 清理状态：`isInitialized = false`，`capabilities = undefined`，`isStopping = false`
  9. 保留 `startFailed` 和 `startError` 用于诊断
  10. 关闭失败时抛出错误

**超时取消重试**
- 关闭超时：`shutdownTimeoutMs` 参数，超时后强制 kill
- 定时器使用 `unref()` 避免阻塞进程退出
- 无请求取消机制（当前未实现）

**错误隔离**
- `isStopping` 标志：关闭期间抑制错误日志（避免虚假错误）
- `startFailed`/`startError`：跟踪启动失败状态
- `connectionClosed`：跟踪连接状态，避免在已关闭连接上操作
- 进程 'exit' 事件：非零退出码且非 stopping 时触发 onCrash
- 连接 'error' 事件：非 stopping 时记录错误并设置 startFailed
- 连接 'close' 事件：非 stopping 时记录但不设置 startFailed
- stdin 'error'：仅记录，不抛出
- 关闭期间所有错误捕获并继续清理
- 通知出错仅记录，不抛出

**设计取舍/备选**
- 延迟加载 vs 静态加载：选择延迟，减少启动时内存占用（vscode-jsonrpc ~129KB）
- 工厂函数 + 闭包 vs 类：选择工厂函数，私有状态封装更清晰
- pendingHandlers 队列：支持连接建立前注册处理器
- `isStopping` 标志：避免关闭期间的虚假错误日志
- spawn 等待确认：防止写入无效流导致未处理拒绝
- 备选：使用 AbortController 取消请求 - 当前未实现
- 备选：socket 传输 - 当前仅支持 stdio

**源码测试证据**
- 源码：`src/services/lsp/LSPClient.ts`
- 测试：`tests/lspLifecycle.test.ts`（覆盖启动、关闭、超时强制 kill）

**边界条件**
- 仅支持 stdio 传输，socket 未实现
- 关闭时即使 shutdown/exit 失败也继续清理资源
- 进程可能已退出，`process.kill()` 可能抛出但被捕获
- 关闭失败后 `startFailed` 设为 true，保留错误状态

---

### 模块设计卡：Config/Types（配置与类型）

**真实入口签名/关键类型**
```typescript
// src/services/lsp/types.ts
export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export type LspServerConfig = {
  command: string
  args?: string[]
  extensionToLanguage: Record<string, string>
  transport?: 'stdio' | 'socket'  // socket 定义但未实现
  env?: Record<string, string>
  initializationOptions?: unknown
  settings?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  shutdownTimeout?: number
  restartOnCrash?: boolean
  maxRestarts?: number
}

export type ScopedLspServerConfig = LspServerConfig & {
  scope: 'dynamic'
  source: string  // 来源插件名
}

// src/services/lsp/config.ts
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}>
```

**输入输出**
- 输入：插件配置（通过 `getPluginLspServers()`）
- 输出：按名称索引的 ScopedLspServerConfig 记录

**Server 状态与文档状态**
- 配置无状态，纯数据结构
- extensionToLanguage 映射用于服务器路由

**配置加载流程**
1. `loadAllPluginsCacheOnly()` 获取所有启用插件
2. 并行调用 `getPluginLspServers(plugin, errors)` 加载每个插件的配置
3. 单个插件加载出错仅记录，不影响其他插件
4. 合并所有插件的配置到单个 Record
5. 返回结果

**超时取消重试**
- 无超时，无重试

**错误隔离**
- 单个插件配置加载失败不影响其他插件
- `getAllLspServers()` 整体失败仅记录，不抛出（返回空 servers）
- 错误收集到 `errors` 数组，不中断流程

**设计取舍/备选**
- 配置仅来自插件 vs 用户/项目配置：选择仅插件，与现有插件架构一致，避免复杂的配置合并
- 并行加载 vs 串行加载：选择并行，提高性能
- 空配置回退 vs 抛出：选择回退，提高容错
- 备选：支持用户/项目级配置 - 当前不需要，增加复杂度
- 备选：配置优先级（插件 vs 用户 vs 项目） - 过度设计

**源码测试证据**
- 源码：`src/services/lsp/config.ts`、`src/services/lsp/types.ts`
- 测试：`tests/lsp.test.ts`（覆盖配置解析和基本初始化）

**边界条件**
- transport 可选，默认 undefined，仅 'stdio' 实现，'socket' 定义但未实现
- maxRestarts 默认 3（未提供时）
- startupTimeout/shutdownTimeout 可选
- restartOnCrash 可选（布尔）
- extensionToLanguage 必须非空

---

### 模块设计卡：Passive Diagnostics（被动诊断）

**真实入口签名/关键类型**
```typescript
// src/services/lsp/LSPDiagnosticRegistry.ts
export type PendingLSPDiagnostic = {
  serverName: string
  files: DiagnosticFile[]
  timestamp: number
  attachmentSent: boolean
}

export function registerPendingLSPDiagnostic({
  serverName,
  files,
}: {
  serverName: string
  files: DiagnosticFile[]
}): void

export function checkForLSPDiagnostics(): Array<{
  serverName: string
  files: DiagnosticFile[]
}>

export function clearAllLSPDiagnostics(): void
export function resetAllLSPDiagnosticState(): void
export function clearDeliveredDiagnosticsForFile(fileUri: string): void
export function getPendingLSPDiagnosticCount(): number

// 容量限制常量
const MAX_DIAGNOSTICS_PER_FILE = 10
const MAX_TOTAL_DIAGNOSTICS = 30
const MAX_DELIVERED_FILES = 500  // LRU 缓存大小

// src/services/lsp/passiveFeedback.ts
export function formatDiagnosticsForAttachment(
  params: PublishDiagnosticsParams
): DiagnosticFile[]

export function registerLSPNotificationHandlers(
  manager: LSPServerManager
): HandlerRegistrationResult

export type HandlerRegistrationResult = {
  totalServers: number
  successCount: number
  registrationErrors: Array<{ serverName: string; error: string }>
  diagnosticFailures: Map<string, { count: number; lastError: string }>
}
```

**输入输出**
- 输入：LSP PublishDiagnosticsParams
- 输出：DiagnosticFile[]（转换后的诊断）

**诊断状态与 LRU 缓存**
- 全局注册表状态：
  - `pendingDiagnostics: Map<string, PendingLSPDiagnostic>` - UUID 到待处理诊断的映射
  - `deliveredDiagnostics: LRUCache<string, Set<string>>` - 文件 URI 到诊断键集合的 LRU 缓存（最大 500 文件）
- 诊断键：`hash(message + severity + range + source + code)` 用于去重
- LRU 策略：超过 500 文件时自动淘汰最近最少使用的文件的已交付诊断记录

**诊断推送/注册/交付流程**
- 推送流程（被动）：
  1. LSP 服务器发送 `textDocument/publishDiagnostics` 通知
  2. `instance.onNotification()` 处理器被调用
  3. try-catch 包裹整个处理逻辑
  4. 验证 params 结构（uri、diagnostics 存在）
  5. `formatDiagnosticsForAttachment()` 转换为 Claude 格式
  6. `registerPendingLSPDiagnostic()` 注册到注册表
  7. 成功时重置该服务器的失败计数器
  8. 失败时递增失败计数器，3+ 次连续失败时记录警告
- 注册流程：
  1. 生成 UUID 作为诊断 ID
  2. 存储到 `pendingDiagnostics` Map
  3. 标记 `attachmentSent: false`
- 交付流程：
  1. `checkForLSPDiagnostics()` 被调用（通常在 getAttachments 期间）
  2. 收集所有 `attachmentSent: false` 的诊断
  3. `deduplicateDiagnosticFiles()` 去重：
     - 同一批次内去重
     - 跨回合去重（检查 deliveredDiagnostics LRU）
  4. 容量限制：
     - 按严重程度排序（Error < Warning < Info < Hint）
     - 每文件最多 10 个诊断（MAX_DIAGNOSTICS_PER_FILE）
     - 总共最多 30 个诊断（MAX_TOTAL_DIAGNOSTICS）
  5. 标记为 `attachmentSent: true`，从 pendingDiagnostics 删除
  6. 记录到 deliveredDiagnostics LRU（跨回合去重）
  7. 返回去重和限制后的诊断

**超时取消重试**
- 无超时，无重试（通知是单向的）

**错误隔离**
- 单个服务器诊断处理失败不影响其他服务器
- 通知处理器被 try-catch 完全包裹，不抛出
- 诊断失败计数器：`diagnosticFailures: Map<string, { count: number; lastError: string }>`
- 连续失败 3+ 次记录警告
- 去重失败：回退到未去重的诊断
- 创建诊断键失败：包含该诊断但不跟踪去重
- 单个服务器注册失败不影响其他服务器注册

**设计取舍/备选**
- LRU 缓存 vs 无限制：选择 LRU，防止长会话内存无限增长
- 容量限制 vs 无限制：选择限制，避免诊断刷屏
- 按严重程度排序 vs 原始顺序：选择排序，优先显示错误
- 跨回合去重 vs 每次都显示：选择去重，避免重复显示相同诊断
- 编辑文件时清除该文件的已交付诊断：允许新诊断显示
- UUID  vs 时间戳：选择 UUID，处理快速连续注册
- 备选：持久化诊断到磁盘 - 当前不需要，仅跨回合内存跟踪
- 备选：诊断优先级用户配置 - 当前不需要

**源码测试证据**
- 源码：`src/services/lsp/LSPDiagnosticRegistry.ts`、`src/services/lsp/passiveFeedback.ts`
- 测试：未找到直接测试

**边界条件**
- 诊断容量限制：每文件最多 10 个，总共最多 30 个
- LRU 缓存大小：最多 500 个文件的已交付诊断记录
- 编辑文件时调用 `clearDeliveredDiagnosticsForFile()` 清除该文件的已交付诊断（允许新诊断显示）
- 空诊断跳过交付
- URI 转换失败回退到原始 URI
- 诊断键创建失败包含诊断但不跟踪去重

---

### 模块设计卡：LSPTool（LSP 工具）

**真实入口签名/关键类型**
```typescript
// src/tools/LSPTool/LSPTool.ts
export const LSPTool = buildTool({
  name: LSP_TOOL_NAME,
  searchHint: 'code intelligence (definitions, references, symbols, hover)',
  maxResultSizeChars: 100_000,
  isLsp: true,
  async description() { return DESCRIPTION },
  userFacingName,
  shouldDefer: true,
  isEnabled() { return isLspConnected() },
  get inputSchema(): InputSchema { return inputSchema() },
  get outputSchema(): OutputSchema { return outputSchema() },
  isConcurrencySafe() { return true },
  isReadOnly() { return true },
  getPath({ filePath }: Input): string { return expandPath(filePath) },
  async validateInput(input: Input): Promise<ValidationResult>,
  async checkPermissions(input: Input, context: ToolContext): Promise<PermissionDecision>,
  async prompt() { return DESCRIPTION },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  async call(input: Input, context: ToolContext): Promise<ToolResult<Output>>,
  mapToolResultToToolResultBlockParam,
} satisfies ToolDef<InputSchema, OutputSchema>)

type InputSchema = LazyReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
type Output = z.infer<OutputSchema>

// 支持的操作
type Operation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls'

// 文件大小限制
const MAX_LSP_FILE_SIZE_BYTES = 10_000_000  // 10 MB

// gitignore 批处理参数
const BATCH_SIZE = 50  // git check-ignore 每批最多 50 个路径
```

**输入输出**
- 输入：
  - `operation: Operation` - LSP 操作类型
  - `filePath: string` - 文件路径（相对或绝对）
  - `line: number` - 行号（1-based，用户友好）
  - `character: number` - 字符位置（1-based，用户友好）
- 输出：
  - `operation: Operation` - 执行的操作
  - `result: string` - 格式化结果
  - `filePath: string` - 操作的文件路径
  - `resultCount?: number` - 结果数量
  - `fileCount?: number` - 涉及的文件数量

**Server 状态与文档状态**
- `isLspConnected()` 检查至少一个服务器健康（非 error 状态）
- `isFileOpen()` 检查文件是否已同步到 LSP 服务器
- 未打开时自动读取文件并调用 `openFile()`
- 文件大小超过 10MB 时拒绝打开

**工具调用流程**
1. `validateInput()`：验证输入 schema，验证文件存在且是普通文件，跳过 UNC 路径检查
2. `checkPermissions()`：检查文件读取权限
3. `waitForInitialization()`：初始化 pending 时等待
4. `getLspServerManager()`：获取管理器
5. `getMethodAndParams()`：转换输入为 LSP 方法和参数：
   - 1-based → 0-based 转换（line/character 各减 1）
   - filePath → file:// URI
   - 映射操作到 LSP 方法
6. 检查文件是否已打开：
   - 未打开时读取文件内容
   - 检查文件大小（>10MB 时返回错误）
   - `manager.openFile()` 发送 didOpen
7. `manager.sendRequest()` 发送请求
8. 对于 incomingCalls/outgoingCalls：
   - 先调用 prepareCallHierarchy 获取 CallHierarchyItem
   - 再调用 callHierarchy/incomingCalls 或 callHierarchy/outgoingCalls
9. gitignore 过滤（适用操作：findReferences、goToDefinition、goToImplementation、workspaceSymbol）：
   - 收集所有位置 URI
   - 转换为文件路径
   - 分批调用 `git check-ignore`（每批 50 个路径）
   - 过滤掉 gitignored 的路径
10. `formatResult()` 格式化结果
11. 返回输出

**gitignore 批处理参数**
- 批大小：50 路径/批（BATCH_SIZE）
- 批处理策略：所有位置 URI 去重后分批检查
- git 调用：`execFileNoThrowWithCwd('git', ['check-ignore', ...batch], { cwd, timeout: 5000 })`
- 超时：5000ms
- 错误处理：git 失败时不过滤，返回所有结果

**超时取消重试**
- 无工具级超时（依赖 LSP 请求层）
- git check-ignore 超时：5000ms
- ContentModified 重试：由 LSPServerInstance 层处理

**错误隔离**
- 管理器未初始化返回友好错误
- 无服务器处理该文件类型返回友好错误
- 文件过大返回友好错误
- LSP 请求失败记录错误并返回友好错误
- git check-ignore 失败回退到不过滤（容错）
- 无效位置 URI 记录并过滤

**设计取舍/备选**
- 1-based vs 0-based：用户输入/显示 1-based，LSP 协议 0-based，在 getMethodAndParams() 集中转换
- auto-open vs 要求用户显式打开：选择 auto-open，更易用
- 文件大小限制：10MB，避免大文件性能问题
- gitignore 批处理：50 路径/批，平衡性能与命令行长度限制
- gitignore 过滤 vs 不过滤：选择过滤，避免 node_modules 等无关结果
- 过滤位置：在工具层而不是管理器层，保持管理器通用
- 备选：支持用户配置文件大小限制 - 当前不需要
- 备选：支持用户配置 gitignore 过滤 - 当前不需要
- 备选：更智能的批大小（根据操作系统限制动态调整） - 当前不需要

**源码测试证据**
- 源码：`src/tools/LSPTool/LSPTool.ts`
- 测试：未找到直接测试

**边界条件**
- 文件大小限制：10MB（MAX_LSP_FILE_SIZE_BYTES）
- UNC 路径：跳过文件系统检查（安全考虑）
- workspaceSymbol：空查询返回所有符号
- incomingCalls/outgoingCalls：两步流程（先 prepareCallHierarchy 再调用）
- LocationLink 与 Location 混合：转换为统一 Location 格式处理
- 诊断数量/LRU：不适用 LSPTool（由 LSPDiagnosticRegistry 处理）
- closeFile 与 compact 的边界：不适用 LSPTool（由管理器处理）

---

### 核心模块接口（摘要）

```typescript
// 服务入口
initializeLspServerManager(): void  // 全局单例初始化（非 bare 模式）
getInitializationStatus(): { status: 'not-started' | 'pending' | 'success' | 'failed'; error?: Error }  // 获取当前初始化状态
waitForInitialization(): Promise<void>  // 等待初始化完成
isLspConnected(): boolean  // 检查是否有 LSP 服务器连接
getLspServerManager(): LSPServerManager | undefined  // 获取管理器实例
reinitializeLspServerManager(): void  // 强制重新初始化（用于插件刷新）
shutdownLspServerManager(): Promise<void>  // 关闭并清理所有资源

// 管理器接口
interface LSPServerManager {
  initialize(): Promise<void>  // 初始化：加载配置并创建服务器实例
  shutdown(): Promise<void>  // 关闭所有服务器
  getServerForFile(filePath: string): LSPServerInstance | undefined  // 根据文件路径获取对应的服务器
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>  // 确保文件对应的服务器已启动
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T | undefined>  // 发送 LSP 请求
  getAllServers(): Map<string, LSPServerInstance>  // 获取所有服务器
  openFile(filePath: string, content: string): Promise<void>  // 文档同步：打开文件
  changeFile(filePath: string, content: string): Promise<void>  // 文档同步：变更文件
  saveFile(filePath: string): Promise<void>  // 文档同步：保存文件
  closeFile(filePath: string): Promise<void>  // 文档同步：关闭文件
  isFileOpen(filePath: string): boolean  // 文档同步：检查是否已打开
}

// 服务器实例接口
interface LSPServerInstance {
  readonly name: string
  readonly config: ScopedLspServerConfig
  readonly state: LspServerState  // 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  readonly startTime: Date | undefined
  readonly lastError: Error | undefined
  readonly restartCount: number

  // 生命周期
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>

  // 健康检查
  isHealthy(): boolean

  // LSP 通信
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(method: string, handler: (params: TParams) => TResult | Promise<TResult>): void
}

// 配置
getAllLspServers(): Promise<{ servers: Record<string, ScopedLspServerConfig> }>  // 从插件获取所有 LSP 服务器配置

type LspServerConfig = {
  command: string
  args?: string[]
  extensionToLanguage: Record<string, string>
  transport?: 'stdio' | 'socket'  // 仅 stdio 目前支持
  env?: Record<string, string>
  initializationOptions?: unknown
  settings?: unknown
  workspaceFolder?: string
  startupTimeout?: number
  shutdownTimeout?: number
  restartOnCrash?: boolean
  maxRestarts?: number
}

type ScopedLspServerConfig = LspServerConfig & {
  scope: 'dynamic'
  source: string  // 来源插件名
}

// 工具入口
const LSPTool = buildTool({
  name: 'LSP',
  isEnabled: () => isLspConnected(),
  inputSchema: { operation: 'goToDefinition' | 'findReferences' | 'hover' | ... },
  call: async (input: Input) => Promise<Output>,
})
```

### 服务器启动与初始化流程

```
首次使用服务器（manager.ensureServerStarted(filePath)）
  ↓
检查当前状态：仅从 stopped/error 启动
  ↓
校验 maxRestarts 限制（crashRecoveryCount > maxRestarts 时抛出）
  ↓
状态切换为 'starting'
  ↓
调用 `createLSPClient.start()` 启动子进程
  ↓
验证进程 spawn 成功（等待 'spawn' 事件）
  ↓
发送 `initialize` 请求，包含：
  processId
  workspaceFolders（当前 cwd）
  rootPath / rootUri（deprecated 但保留兼容性）
  客户端能力配置（textDocument/hover, definition, references 等）
  initializationOptions（来自插件配置）
  ↓
发送 `initialized` 通知
  ↓
状态切换为 'running'
  ↓
crashRecoveryCount 重置为 0
```

### 请求生命周期

```
调用 `manager.sendRequest(filePath, method, params)`
  ↓
`manager.ensureServerStarted(filePath)` → 启动对应服务器
  ↓
检查 `manager.isFileOpen(absolutePath)`，未打开时：读取文件（最大 10MB），调用 `manager.openFile()`
  ↓
`instance.sendRequest(method, params)`：
  检查健康状态：必须是 'running' 且 `client.isInitialized`
  调用 `client.sendRequest()`（vscode-jsonrpc）
  拦截 `ContentModified` 错误（代码 -32801），最多重试 3 次（指数退避：500ms, 1s, 2s）
  ↓
响应返回或错误抛出
  ↓
如果是 `findReferences`、`goToDefinition`、`goToImplementation`、`workspaceSymbol`，自动过滤 gitignored 文件的结果
  ↓
gitignore 过滤：
  收集所有位置 URI 并转换为文件路径
  去重后分批调用 `git check-ignore`（每批 50 个路径，超时 5000ms）
  过滤掉 gitignored 的路径
  ↓
用户输入和显示使用 1-based 行号/字符位置，LSP 协议使用 0-based，在 `getMethodAndParams()` 中转换
```

### 关闭流程

```
`instance.stop(timeout)`：
  ↓
设置 `isStopping = true`（抑制错误日志）
  ↓
启动超时定时器（如提供 shutdownTimeout）
  ↓
发送 `shutdown` 请求
  ↓
发送 `exit` 通知
  ↓
超时后强制 `process.kill()`
  ↓
`connection.dispose()`
  ↓
清理进程事件监听器
  ↓
再次 `process.kill()` 确保终止
  ↓
状态切换为 'stopped'
```

### 被动诊断推送流程

```
服务器推送 `textDocument/publishDiagnostics` 通知
  ↓
`instance.onNotification('textDocument/publishDiagnostics', handler)` 调用
  ↓
try {
  验证 params 结构
  转换诊断（LSP → Claude 格式）
  注册到 `LSPDiagnosticRegistry`
    去重（同一批次 + 跨回合）
    容量限制：`MAX_DIAGNOSTICS_PER_FILE = 10`，`MAX_TOTAL_DIAGNOSTICS = 30`
    按严重程度排序（Error < Warning < Info < Hint）
    跨回合记忆：`deliveredDiagnostics` LRU 缓存（最大 500 文件）
} catch (error) {
  仅记录，不抛出
  跟踪连续失败次数（3+ 次警告）
}
  ↓
诊断注册后，AsyncHookRegistry 触发交付（checkForLSPDiagnostics()）
  ↓
编辑文件时调用 `clearDeliveredDiagnosticsForFile()` 清除该文件的已交付诊断
```

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 | 工程取舍 |
|---|---|---|
| 服务器 spawn 失败 | 记录错误，状态切换为 'error'，不影响其他服务器 | 错误隔离，一个服务器失败不影响其他 |
| 服务器初始化超时 | 记录错误，状态切换为 'error'，不影响其他服务器 | 可配置 `startupTimeout` |
| 服务器崩溃 | `restartOnCrash` 启用时自动重启，`maxRestarts` 限制重启次数，超过后状态固定为 'error' | 提高可用性，transient crash 自动恢复 |
| 请求超时 | vscode-jsonrpc 超时机制，抛出错误 | 需要客户端处理超时 |
| ContentModified 错误（代码 -32801） | 自动指数退避重试，最多 3 次（500ms, 1s, 2s） | 透明处理常见情况（rust-analyzer 索引中） |
| 通知处理错误 | 仅记录，不抛出，跟踪连续失败次数 | 错误隔离，单个通知处理失败不影响其他通知或服务器 |
| 文档同步失败 | 记录错误，继续 | 容错，不阻塞其他操作 |
| git check-ignore 失败 | 不过滤结果，继续 | 容错，不过滤比过滤错误好 |
| 管理器初始化失败 | 记录错误，`getInitializationStatus()` 返回 'failed' | LSP 功能不可用，但不影响其他功能 |

## 6. 现状验收标准

- `initializeLspServerManager()` 正确初始化全局单例
- `getAllLspServers()` 正确从插件获取 LSP 服务器配置
- `getServerForFile(filePath)` 正确根据文件扩展名映射找到对应服务器
- `ensureServerStarted(filePath)` 正确在首次使用时启动服务器
- 服务器启动与初始化流程正确工作（spawn、initialize、initialized）
- 请求生命周期正确工作（打开文件、发送请求、重试 ContentModified、过滤 gitignored）
- 位置 1-based/0-based 转换正确
- 关闭流程正确工作（shutdown、exit、强制 kill）
- 被动诊断推送流程正确工作（注册、去重、容量限制、跨回合记忆）
- 错误隔离正确工作（单个服务器崩溃不影响其他服务器，单个通知处理失败不影响其他通知）
- 崩溃自动重启正确工作（restartOnCrash、maxRestarts）
- lazy start + lazy load 正确工作（首次使用时启动，延迟加载 vscode-jsonrpc）

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
| --- | --- | --- | --- |
| 全局单例管理器 | `src/services/lsp/LSPServerManager.ts` | 未找到直接测试 |  |
| 配置仅来自插件 | `src/services/lsp/config.ts` | 未找到直接测试 |  |
| lazy start + lazy load | `src/services/lsp/LSPServerInstance.ts`, `src/services/lsp/LSPClient.ts` | tests/lspLifecycle.test.ts：启动/初始化/停止、崩溃重启、超时强制kill | 未覆盖多个并发服务器场景 |
| 结构化诊断注册表 | `src/services/lsp/passiveFeedback.ts` | 未找到直接测试 | 未覆盖诊断去重和容量限制场景 |
| stdio传输为唯一支持 | `src/services/lsp/LSPServerInstance.ts` | tests/lsp.test.ts：配置解析和基本初始化 | 不支持socket传输 |
| ContentModified自动重试 | `src/services/lsp/LSPServerInstance.ts` | tests/lspLifecycle.test.ts：崩溃后自动重启 | 未验证ContentModified具体重试逻辑 |
| 位置1-based vs 0-based | `src/tools/LSPTool/LSPTool.ts` | 未找到直接测试 | 未验证所有操作的转换正确性 |
| gitignored结果过滤 | `src/tools/LSPTool/LSPTool.ts` | 未找到直接测试 |  |
| 错误隔离（服务器级别） | `src/services/lsp/LSPServerManager.ts` | 未找到直接测试 |  |
| 崩溃自动重启 | `src/services/lsp/LSPServerInstance.ts` | tests/lspLifecycle.test.ts：重启策略验证 | 未验证maxRestarts=0情况 |
| 通知处理错误隔离 | `src/services/lsp/passiveFeedback.ts` | 未找到直接测试 |  |
| LSPTool实现 | `src/tools/LSPTool/LSPTool.ts` | 未找到直接测试 | 未覆盖所有LSP操作（goToDefinition、findReferences、hover等） |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/lsp.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
| --- | --- | --- | --- |
| lsp-manager | LSP服务器管理器（单例、初始化、关闭、服务器路由） | tests/lspLifecycle.test.ts |  |
| lsp-server-instance | LSP服务器实例（启动/停止、健康检查、请求发送、通知处理） | tests/lspLifecycle.test.ts |  |
| lsp-client | LSP客户端（lazy load、vscode-jsonrpc封装） | tests/lspLifecycle.test.ts |  |
| lsp-config | LSP配置获取（从插件加载） | tests/lsp.test.ts |  |
| lsp-passive-feedback | 被动诊断注册、去重、容量限制 |  |  |
| lsp-tool | LSP工具实现（所有LSP操作、位置转换、gitignore过滤） |  |  |

相关子系统：
- plugins: 提供 LSP 服务器配置
- tools: LSPTool 集成
- async-hooks: AsyncHookRegistry 用于诊断交付
- git: git check-ignore 用于结果过滤
- workspace: 工作区状态、文件变更事件
- settings: 可能提供全局配置（当前不支持用户/项目级 LSP 配置）

## 9. 改进建议

1. 实现 socket 传输支持
2. 支持用户/项目级 LSP 配置
3. 实现更多 LSP 功能（code actions、rename、formatting 等）
4. 提供 LSP 服务器安装功能（由插件或用户安装）
5. 支持远程 LSP 服务器
6. 增加 LSP 服务器健康监控 UI（显示服务器状态、重启次数、最后错误等）
7. 实现 LSP 请求取消（AbortController）
8. 增加 LSP 请求性能监控（延迟、成功率等）
9. 实现更智能的诊断优先级排序（按严重性、文件位置等）
10. 支持 LSP 工作区符号搜索（workspace/symbol）
11. 实现 LSP 代码镜头（code lens）
12. 支持 LSP 内联提示（inlay hints）
13. 实现 LSP 调用层次（call hierarchy）
14. 支持 LSP 类型层次（type hierarchy）
15. 实现 LSP 文档链接（document links）
16. 支持 LSP 文档颜色（document colors）
17. 实现 LSP 折叠范围（folding ranges）
18. 支持 LSP 选择范围（selection ranges）
19. 实现 LSP 语义高亮（semantic tokens）
20. 支持 LSP 草稿缩进（linked editing ranges）
