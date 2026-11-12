---
id: lsp
batch: 2
title: LSP 语言服务生命周期与工具集成设计
date: 2026-11-12
status: draft
---

## 1. 概述

本设计文档描述 Claude Code 中 Language Server Protocol (LSP) 集成的架构、生命周期管理、工具接口和错误隔离策略。

### 1.1 设计目标

- 提供一致的 LSP 服务管理，支持多语言服务器
- 实现完整的服务器生命周期（启动、初始化、请求处理、关闭）
- 提供与 LSP 交互的工具接口（goToDefinition、findReferences 等）
- 实现被动诊断（diagnostics）的异步推送与展示
- 确保错误隔离和服务器健康监控
- 支持服务器崩溃自动重启

### 1.2 范围

本文档涵盖：
- LSP 服务管理器架构与单例设计
- 服务器实例生命周期管理
- LSP 工具 (LSPTool) 接口与操作
- 文档同步机制
- 被动诊断注册与分发
- 超时与取消策略
- 错误隔离与重试机制

## 2. 入口与主要接口

### 2.1 服务入口：`src/services/lsp/manager.ts`

```typescript
// 全局单例初始化（非 bare 模式）
export function initializeLspServerManager(): void;

// 获取当前初始化状态
export function getInitializationStatus(): { status: 'not-started' | 'pending' | 'success' | 'failed'; error?: Error };

// 等待初始化完成
export async function waitForInitialization(): Promise<void>;

// 检查是否有 LSP 服务器连接
export function isLspConnected(): boolean;

// 获取管理器实例
export function getLspServerManager(): LSPServerManager | undefined;

// 强制重新初始化（用于插件刷新）
export function reinitializeLspServerManager(): void;

// 关闭并清理所有资源
export async function shutdownLspServerManager(): Promise<void>;
```

### 2.2 管理器接口：`LSPServerManager`

```typescript
// src/services/lsp/LSPServerManager.ts
export interface LSPServerManager {
  // 初始化：加载配置并创建服务器实例
  initialize(): Promise<void>;

  // 关闭所有服务器
  shutdown(): Promise<void>;

  // 根据文件路径获取对应的服务器
  getServerForFile(filePath: string): LSPServerInstance | undefined;

  // 确保文件对应的服务器已启动
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>;

  // 发送 LSP 请求
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T | undefined>;

  // 获取所有服务器
  getAllServers(): Map<string, LSPServerInstance>;

  // 文档同步
  openFile(filePath: string, content: string): Promise<void>;
  changeFile(filePath: string, content: string): Promise<void>;
  saveFile(filePath: string): Promise<void>;
  closeFile(filePath: string): Promise<void>;
  isFileOpen(filePath: string): boolean;
}
```

### 2.3 服务器实例接口：`LSPServerInstance`

```typescript
// src/services/lsp/LSPServerInstance.ts
export interface LSPServerInstance {
  readonly name: string;
  readonly config: ScopedLspServerConfig;
  readonly state: LspServerState; // 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  readonly startTime: Date | undefined;
  readonly lastError: Error | undefined;
  readonly restartCount: number;

  // 生命周期
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;

  // 健康检查
  isHealthy(): boolean;

  // LSP 通信
  sendRequest<T>(method: string, params: unknown): Promise<T>;
  sendNotification(method: string, params: unknown): Promise<void>;
  onNotification(method: string, handler: (params: unknown) => void): void;
  onRequest<TParams, TResult>(method: string, handler: (params: TParams) => TResult | Promise<TResult>): void;
}
```

### 2.4 工具入口：`LSPTool`

```typescript
// src/tools/LSPTool/LSPTool.ts
export const LSPTool = buildTool({
  name: 'LSP',
  isEnabled: () => isLspConnected(),
  // 支持的操作
  inputSchema: { operation: 'goToDefinition' | 'findReferences' | 'hover' | ... },
  call: async (input: Input) => Promise<Output>,
});
```

## 3. 服务器启停与请求生命周期

### 3.1 服务器启动与初始化流程

1. **启动阶段 (start)**：
   - 检查当前状态：仅从 stopped/error 启动
   - 校验 maxRestarts 限制
   - 调用 `createLSPClient.start()` 启动子进程
   - 验证进程 spawn 成功

2. **初始化阶段 (initialize)**：
   - 发送 `initialize` 请求，包含：
     - processId
     - workspaceFolders（当前 cwd）
     - 客户端能力配置（textDocument/hover, definition, references 等）
     - initializationOptions（来自插件配置）
   - 可选：等待 `initialized` 通知
   - 状态切换为 'running'

3. **超时配置**：
   - `startupTimeout`: 初始化超时
   - `shutdownTimeout`: 关闭超时

```typescript
// 状态机
type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
```

### 3.2 请求生命周期

1. 调用 `manager.sendRequest(filePath, method, params)`
2. `manager.ensureServerStarted(filePath)` → 启动对应服务器
3. `instance.sendRequest(method, params)`：
   - 检查健康状态：必须是 'running' 且 `client.isInitialized`
   - 调用 `client.sendRequest()`（vscode-jsonrpc）
   - 拦截 `ContentModified` 错误（代码 -32801），最多重试 3 次（指数退避）
4. 响应返回或错误抛出

### 3.3 关闭流程

1. `instance.stop(timeout)`：
   - 设置 `isStopping = true`（抑制错误日志）
   - 发送 `shutdown` 请求
   - 发送 `exit` 通知
   - 超时后强制 `process.kill()`
   - 清理连接资源
   - 状态切换为 'stopped'

## 4. 配置发现

### 4.1 配置来源：插件

LSP 服务器配置完全来自插件（不支持用户/项目设置）：

```typescript
// src/services/lsp/config.ts
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>;
}>;
```

### 4.2 配置结构

```typescript
// src/services/lsp/types.ts
export type LspServerConfig = {
  command: string;
  args?: string[];
  extensionToLanguage: Record<string, string>;
  transport?: 'stdio' | 'socket'; // 仅 stdio 目前支持
  env?: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceFolder?: string;
  startupTimeout?: number;
  shutdownTimeout?: number;
  restartOnCrash?: boolean;
  maxRestarts?: number;
};

export type ScopedLspServerConfig = LspServerConfig & {
  scope: 'dynamic';
  source: string; // 来源插件名
};
```

### 4.3 文件扩展名映射

```typescript
// 管理器内部维护
const extensionMap: Map<string, string[]>; // 扩展名 -> [服务器名]
```

当多个服务器处理同一扩展名时，取第一个注册的服务器。

## 5. 文档同步

### 5.1 同步接口

管理器提供完整的 LSP 文本同步接口：

```typescript
// 打开文件
manager.openFile(filePath, content) → textDocument/didOpen
// 变更文件
manager.changeFile(filePath, content) → textDocument/didChange
// 保存文件
manager.saveFile(filePath) → textDocument/didSave
// 关闭文件
manager.closeFile(filePath) → textDocument/didClose
// 检查是否已打开
manager.isFileOpen(filePath): boolean
```

### 5.2 打开状态跟踪

```typescript
// 管理器内部：URI -> 服务器名
const openedFiles: Map<string, string>;
```

- 避免重复发送 `didOpen`
- 用于判断是否需要先打开文件再发送请求

### 5.3 工具自动同步

`LSPTool.call()` 在发送请求前：
- 检查 `manager.isFileOpen(absolutePath)`
- 未打开时：读取文件（最大 10MB），调用 `manager.openFile()`

## 6. 超时与取消

### 6.1 启动/初始化超时

```typescript
// LSPServerInstance.start() 支持
config.startupTimeout;

// 使用 withTimeout 包装
withTimeout(initPromise, config.startupTimeout, 'LSP server timed out during initialization');
```

### 6.2 关闭超时

```typescript
// instance.stop(config.shutdownTimeout)
// 超时后强制 kill 进程
setTimeout(() => process.kill(), shutdownTimeout);
```

### 6.3 暂态错误重试（ContentModified）

```typescript
const LSP_ERROR_CONTENT_MODIFIED = -32801;
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3;
const RETRY_BASE_DELAY_MS = 500; // 500ms, 1s, 2s
```

当收到 ContentModified 错误时（如 rust-analyzer 正在索引），自动指数退避重试。

## 7. 错误隔离

### 7.1 服务器级别隔离

- 单个服务器崩溃不影响其他服务器
- 管理器继续处理其他服务器的请求
- 错误记录在 `instance.lastError`

### 7.2 崩溃自动重启

```typescript
config.restartOnCrash; // 启用自动重启
config.maxRestarts;    // 最大重启次数（默认 3）
```

- 客户端 crash handler 调用 `instance.restart()`
- 超过 `maxRestarts` 后状态固定为 'error'

### 7.3 通知处理错误隔离

```typescript
// passiveFeedback.ts 中的注册器
instance.onNotification('textDocument/publishDiagnostics', (params) => {
  try {
    // 转换和注册
  } catch (error) {
    // 仅记录，不抛出
    logError(error);
    // 跟踪连续失败次数
  }
});
```

单个通知处理失败不影响其他通知或服务器。

## 8. 覆盖

[Coverage](../../architecture/coverage/lsp.yaml)

## 9. 设计决策与备选方案

### 9.1 决策：全局单例管理器

**选择**：使用模块级单例 `lspManagerInstance`

**理由**：
- LSP 服务器是全局资源，不需要多个实例
- 简化初始化（Claude Code 启动时一次初始化）
- 避免重复启动服务器

**备选方案**：
- 按 workspace 或 session 创建管理器 → 过度设计
- 依赖注入 → 当前代码库不使用 DI

### 9.2 决策：配置仅来自插件

**选择**：LSP 服务器配置完全通过插件提供，不支持用户/项目设置

**理由**：
- 与现有插件架构一致
- 插件可以正确打包和配置语言服务器
- 避免复杂的配置合并逻辑

**备选方案**：
- 支持项目/.claude 配置 → 增加复杂度，当前无需求
- 混合插件+用户配置 → 配置优先级难以处理

### 9.3 决策：lazy start + lazy load

**选择**：
- 服务器仅在首次使用时启动（不是初始化时）
- `LSPClient` 使用 `require()` 延迟加载 vscode-jsonrpc

**理由**：
- 减少启动时间（不启动不需要的服务器）
- 减少内存占用（不需要时不加载 129KB 的 vscode-jsonrpc）
- 提高容错（一个服务器启动失败不影响其他）

**备选方案**：
- 初始化时启动所有服务器 → 慢，浪费资源
- eager load LSPClient → 总是加载大依赖

**证据**：
```typescript
// LSPServerInstance.ts: lazy load
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLSPClient } = require('./LSPClient.js') as { ... };
```

### 9.4 决策：结构化诊断注册表

**选择**：使用 `LSPDiagnosticRegistry` 跟踪待处理诊断，支持去重和跨回合记忆

**理由**：
- 与 AsyncHookRegistry 保持一致的异步交付模式
- 避免重复显示相同诊断
- 支持容量限制（避免过多诊断刷屏）

**备选方案**：
- 直接传递到对话 → 无去重，无记忆
- 另一种存储方式 → 增加不一致性

**设计细节**：
- `MAX_DIAGNOSTICS_PER_FILE = 10`
- `MAX_TOTAL_DIAGNOSTICS = 30`
- `deliveredDiagnostics` LRU 缓存（最大 500 文件）用于跨回合去重
- 编辑文件时清除该文件的已交付诊断

### 9.5 决策：stdio 传输为唯一支持

**选择**：目前仅支持 stdio 传输（types 中有 socket，但未实现）

**理由**：
- 绝大多数 LSP 服务器支持 stdio
- Socket 需要额外的端口管理和生命周期
- 当前无实际需求

**备选方案**：
- 实现 socket 传输 → 未来可扩展

### 9.6 决策：ContentModified 自动重试

**选择**：识别 LSP 错误代码 -32801 并自动指数退避重试

**理由**：
- 这是常见情况（rust-analyzer 索引中）
- 用户不需要知道这个细节
- 透明重试提供更好体验

**备选方案**：
- 直接失败 → 用户体验差
- 固定间隔重试 → 不如指数退避

### 9.7 决策：位置 1-based vs 0-based

**选择**：
- 用户输入和显示：1-based（编辑器显示方式）
- LSP 协议：0-based
- 在 `getMethodAndParams()` 中转换

**理由**：
- 符合用户心智模型（行号从 1 开始）
- 严格遵守 LSP 协议
- 转换集中在一处

**证据**：
```typescript
// LSPTool.ts: getMethodAndParams
const position = {
  line: input.line - 1,      // 1→0
  character: input.character - 1,
};
```

### 9.8 决策：gitignored 结果过滤

**选择**：在 `findReferences`、`goToDefinition`、`workspaceSymbol` 操作中，自动过滤 gitignored 文件的结果

**理由**：
- 避免显示 node_modules 等依赖库的引用
- 聚焦于用户代码

**实现**：
- 使用 `git check-ignore` 批量检查
- 位置 URI 转换为文件路径后检查
