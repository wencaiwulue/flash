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

### 核心模块接口

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
校验 maxRestarts 限制
  ↓
状态切换为 'starting'
  ↓
调用 `createLSPClient.start()` 启动子进程
  ↓
验证进程 spawn 成功
  ↓
发送 `initialize` 请求，包含：
  processId
  workspaceFolders（当前 cwd）
  客户端能力配置（textDocument/hover, definition, references 等）
  initializationOptions（来自插件配置）
  ↓
可选：等待 `initialized` 通知
  ↓
状态切换为 'running'
  ↓
如果有已打开的文件，发送 `didOpen` 通知
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
如果是 `findReferences`、`goToDefinition`、`workspaceSymbol`，自动过滤 gitignored 文件的结果
  ↓
用户输入和显示使用 1-based 行号/字符位置，LSP 协议使用 0-based，在 `getMethodAndParams()` 中转换
```

### 关闭流程

```
`instance.stop(timeout)`：
  ↓
设置 `isStopping = true`（抑制错误日志）
  ↓
发送 `shutdown` 请求
  ↓
发送 `exit` 通知
  ↓
超时后强制 `process.kill()`
  ↓
清理连接资源
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
  转换诊断
  注册到 `LSPDiagnosticRegistry`
    去重
    容量限制：`MAX_DIAGNOSTICS_PER_FILE = 10`，`MAX_TOTAL_DIAGNOSTICS = 30`
    跨回合记忆：`deliveredDiagnostics` LRU 缓存（最大 500 文件）
} catch (error) {
  仅记录，不抛出
  跟踪连续失败次数
}
  ↓
诊断注册后，AsyncHookRegistry 触发交付
  ↓
编辑文件时清除该文件的已交付诊断
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

### 现有实现
- `src/services/lsp/manager.ts`: 服务入口
- `src/services/lsp/LSPServerManager.ts`: 管理器实现
- `src/services/lsp/LSPServerInstance.ts`: 服务器实例实现
- `src/services/lsp/LSPClient.ts`: LSP 客户端实现（lazy load）
- `src/services/lsp/config.ts`: 配置获取
- `src/services/lsp/types.ts`: 类型定义
- `src/services/lsp/passiveFeedback.ts`: 被动诊断注册
- `src/tools/LSPTool/LSPTool.ts`: LSP 工具

### 未覆盖测试
- 服务器启动与初始化各种失败场景测试
- 服务器崩溃自动重启测试
- ContentModified 错误重试测试
- 各种 LSP 操作（goToDefinition、findReferences、hover 等）集成测试
- gitignored 结果过滤测试
- 位置 1-based/0-based 转换测试
- 被动诊断推送、去重、容量限制、跨回合记忆测试
- 错误隔离测试（单个服务器崩溃不影响其他服务器，单个通知处理失败不影响其他通知）
- 多服务器并发测试
- 大型代码库性能测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/lsp.yaml)

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
