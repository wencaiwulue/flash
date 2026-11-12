---
id: external-stubs
batch: 7
title: External Stubs 外部依赖边界与禁用契约设计
date: 2026-11-12
status: draft
---

## 1. 问题与约束

### 1.1 问题背景

`src/external-stubs/` 目录是处理外部依赖边界的关键模块，主要负责：
- Chrome 浏览器连接与控制（通过公开 CDP 或 Playwright MCP）
- 桌面 Computer Use（通过 Zavora 或原生适配器）
- 外部服务接口隔离与契约定义

该模块面临的核心约束：
- 外部依赖可用性不确定（私有 Swift 模块、特定平台支持）
- 需要区分公开实现与私有兼容路径
- 安全边界必须严格执行（权限、本地地址验证等）
- 测试需要隔离外部依赖

### 1.2 关键约束条件

1. **外部依赖可用性**：`computer-use-swift.ts` 和 `computer-use-input.ts` 明确标记为 unavailable，external 构建不包含私有模块
2. **安全约束**：Chrome CDP 端点必须是显式回环地址（127.0.0.1 或 [::1]），不允许凭证
3. **契约分离**：公开实现与私有兼容路径必须有明确的边界，不能相互冒充
4. **平台支持**：不同操作系统有不同的实现路径和能力

## 2. 设计理由与备选方案

### 2.1 设计决策 1：显式后端选择而非透明回退

**决策**：采用显式 `ComputerUseBackendKind`（'zavora' | 'native-adapter'）区分后端，由调用方明确选择，不做透明回退。

**备选方案**：
- **方案 A（已拒绝）**：透明回退链——先尝试私有 Swift，失败后回退到 Zavora，再失败回退到占位符
  - 缺点：不可预测行为、难以调试、可能错误宣称能力
- **方案 B（已选择）**：显式后端工厂——`createZavoraComputerUseBackend()` 和 `createNativeComputerUseBackend()` 明确创建不同后端
  - 优点：行为可预测、错误明确、易于测试
- **方案 C（混合）**：提供便捷工厂，但记录实际使用的后端并返回元数据
  - 缺点：增加复杂度，仍然存在行为不明确问题

**代价**：调用方需要知道可用的后端并进行选择，增加了使用复杂度

**证据**：`computer-use-types.ts` 中明确定义 `ComputerUseBackend`、`createZavoraComputerUseBackend()`、`createNativeComputerUseBackend()`

### 2.2 设计决策 2：Chrome CDP 安全验证与隔离

**决策**：Chrome CDP 端点必须通过 `assertLoopbackCdpEndpoint()` 验证，且不支持私有扩展配对字段。

**备选方案**：
- **方案 A（已拒绝）**：接受任意 URL 并信任上游验证
  - 缺点：安全风险、可能暴露内部服务
- **方案 B（已选择）**：严格验证协议、地址、无凭证、无查询/哈希
  - 优点：安全边界清晰、防止 SSRF
- **方案 C（增强）**：允许配置允许列表，但默认仅允许回环
  - 优点：灵活性，缺点：增加复杂度

**代价**：不支持非回环地址的合法用例（如远程调试），需要用户通过显式例外处理

**证据**：`claude-for-chrome-mcp.ts` 中 `assertLoopbackCdpEndpoint()` 函数、`PRIVATE_EXTENSION_FIELDS` 列表、`createOpenChromeConfig()` 验证

### 2.3 设计决策 3：独立的工具列表与客户端管理

**决策**：isolated Playwright 浏览器与 real Chrome CDP 使用独立的客户端生成、工具列表和关闭逻辑。

**备选方案**：
- **方案 A（已拒绝）**：统一客户端抽象，透明切换后端
  - 缺点：隐藏差异、难以针对特定后端优化
- **方案 B（已选择）**：`getOpenBrowserClient()` / `listBrowserTools()` / `closeOpenBrowserClient()` 与 `getOpenChromeClient()` / `listOpenChromeTools()` / `closeOpenChromeClient()` 完全独立
  - 优点：边界清晰、可以独立演进、测试隔离
- **方案 C（共享基础设施）**：共享 MCP 客户端实现，但保持独立的工具过滤
  - 优点：代码复用，缺点：仍然可能产生意外耦合

**代价**：存在一些重复代码，维护两份相似的客户端生命周期管理

**证据**：`claude-for-chrome-mcp.ts` 中独立的 `isolatedConnection` 与 `chromeConnection` 状态、独立的工具列表函数

### 2.4 设计决策 4：权限委托与宿主验证结合

**决策**：Zavora 后端同时使用 `ServerOptions.authorizeToolCall` 和宿主 `ComputerUseSessionContext` 双重验证，权限取交集。

**备选方案**：
- **方案 A（已拒绝）**：完全信任 Zavora 内置权限系统
  - 缺点：绕过宿主侧权限模型、难以统一审计
- **方案 B（已选择）**：Zavora 侧 `authorizeToolCall` 先验证宿主侧权限，再执行工具，然后宿主侧可以再次验证
  - 优点：双重保障、权限统一管理
- **方案 C（仅宿主验证）**：完全由宿主验证后再调用 Zavora 工具
  - 优点：统一入口，缺点：Zavora 内部工具调用链无法拦截

**代价**：存在重复验证，可能略微影响性能

**证据**：`computer-use-mcp.ts` 中 `authorizeToolCall` 配置调用 `authorizeZavoraCall()`，后者使用宿主 `context` 进行权限检查

## 3. 目标与非目标

### 3.1 目标

1. **明确公开/私有边界**：清晰区分可以公开使用的接口（Zavora、公开 CDP）与私有兼容路径（Swift 模块、私有扩展）
2. **安全默认关闭**：除非显式配置，否则不允许不安全的操作（非回环 CDP、未授权权限等）
3. **可测试性**：提供测试钩子和隔离机制，允许单元测试和集成测试不依赖真实外部服务
4. **契约驱动设计**：通过 `docs/external-stubs/contracts/` 目录下的契约文档明确定义行为
5. **错误可观测**：外部依赖失败时提供明确的错误信息，不静默降级或冒充

### 3.2 非目标

1. **不实现私有模块**：不尝试重新实现 `@ant/computer-use-swift` 或私有 Chrome 扩展的 ABI
2. **不隐藏能力差异**：不同后端有不同能力，不尝试通过抽象层完全抹平差异
3. **不承诺跨平台统一**：接受不同平台有不同的可用后端和能力
4. **不替代上游验证**：在安全边界内工作，不尝试替代 Playwright 或 Zavora 已有的安全机制

## 4. 架构、模块与数据流

### 4.1 模块结构

```
src/external-stubs/
├── claude-for-chrome-mcp.ts     # Chrome MCP 服务器与客户端
├── computer-use-types.ts        # 公共类型定义
├── computer-use-native.ts       # 原生适配器后端实现
├── computer-use-mcp.ts          # Zavora MCP 后端与工具
├── computer-use-swift.ts        # Swift 模块占位符（unavailable）
├── computer-use-input.ts        # 输入模块占位符（unavailable）
└── computer-use-sentinel-apps.ts # 哨兵应用列表
```

### 4.2 关键公开接口

#### Chrome 浏览器接口 (`claude-for-chrome-mcp.ts`)

```typescript
// 配置创建
export function createIsolatedBrowserConfig(options?: {
  allowedOrigins?: string[]
}): PlaywrightMcpConfig

export function createOpenChromeConfig(
  context: OpenChromeContext,
): PlaywrightMcpConfig

// 端点验证
export function assertLoopbackCdpEndpoint(endpoint: string): string

// 客户端管理
export async function getOpenBrowserClient(): Promise<Client>
export async function closeOpenBrowserClient(): Promise<void>
export async function getOpenChromeClient(
  context: OpenChromeContext,
): Promise<Client>
export async function closeOpenChromeClient(expectedClient?: Client): Promise<void>

// 工具操作
export async function listBrowserTools(): Promise<BrowserToolDescriptor[]>
export async function listOpenChromeTools(
  context: OpenChromeContext,
): Promise<BrowserToolDescriptor[]>
export async function callOpenChromeTool(
  context: OpenChromeContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError?: boolean }>

// 服务器创建
export async function createClaudeForChromeMcpServer(
  context: ClaudeForChromeContext,
): Promise<Server>
```

#### Computer Use 接口 (`computer-use-types.ts`, `computer-use-mcp.ts`, `computer-use-native.ts`)

```typescript
// 后端工厂
export function createZavoraComputerUseBackend(options?: {
  serverOptions?: ZavoraServerOptions
}): ComputerUseBackend

export function createNativeComputerUseBackend(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
): ComputerUseBackend

// 上下文绑定
export function bindZavoraSessionContext(
  context: ComputerUseSessionContext,
): (name: string, args: unknown, signal?: AbortSignal) => Promise<CuCallToolResult>

export function bindSessionContext(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  context: ComputerUseSessionContext,
): (name: string, args: unknown, signal?: AbortSignal) => Promise<CuCallToolResult>

// 工具构建
export function buildComputerUseTools(
  capabilities: ComputerUseCapabilities,
  coordinateMode: CoordinateMode,
  installedAppNames?: string[],
): ComputerUseTool[]

// MCP 服务器
export function createComputerUseMcpServer(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
): Server

// Zavora 直接客户端（仅用于测试/验证）
export function getOpenComputerUseClient(): Promise<Client>
export async function closeOpenComputerUseClient(): Promise<void>
export async function listOpenComputerUseTools(): Promise<ComputerUseTool[]>
```

### 4.3 数据流图

#### Chrome CDP 连接流程

```
调用方 (OpenChromeContext)
    ↓
assertLoopbackCdpEndpoint() 验证地址
    ↓
createOpenChromeConfig() 验证无私有字段
    ↓
preflightOpenChrome() 探测端点可用性
    ↓
connectPlaywrightUpstream() 连接（Bun 下使用 Node 子进程）
    ↓
createOpenChromeProxyServer() 创建代理
    ↓
┌─────────────────────────────────────┐
│ 代理层过滤：                           │
│  - 移除 browser_close 工具            │
│  - 添加 "Real Chrome" 描述前缀       │
│  - 序列化工具调用队列                 │
│  - 事件追踪                           │
└─────────────────────────────────────┘
    ↓
Playwright MCP → Chrome CDP
```

#### Computer Use 调用流程

```
调用方
    ↓
bind[Zavora|Session]Context() 绑定上下文
    ↓
dispatch(name, args, context, signal)
    ↓
┌─────────────────────────────────────┐
│ 验证阶段：                            │
│  - checkAbort(signal)                │
│  - 检查后端可用性                     │
│  - 检查锁状态                         │
│  - check CuLock                      │
│  - 前置 OS 权限检查                   │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 权限阶段：                            │
│  - requiredFlags() 计算需要的权限     │
│  - ensureGrants() 请求缺失授权        │
│  - target 应用授权检查                │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ 执行阶段：                            │
│  Zavora:                             │
│    client.callTool() → upstream      │
│  Native:                             │
│    adapter.executor.method()         │
└─────────────────────────────────────┘
    ↓
结果包装（structuredContent, telemetry）
```

### 4.4 公开实现与私有兼容边界

| 路径 | 类型 | 状态 | 说明 |
|------|------|------|------|
| Zavora backend | 公开实现 | ✅ 可用 | 使用 `@zavora/computer-use-mcp` |
| Native adapter backend | 公开实现 | ✅ 可用 | 通过 `ComputerUseHostAdapter` 适配 |
| Chrome CDP (公开) | 公开实现 | ✅ 可用 | 回环地址验证 |
| Isolated Playwright | 公开实现 | ✅ 可用 | 独立浏览器实例 |
| computer-use-swift.ts | 私有兼容 | ❌ unavailable | 占位符，无实际实现 |
| computer-use-input.ts | 私有兼容 | ❌ unavailable | 占位符，无实际实现 |
| 私有 Chrome 扩展配对 | 私有兼容 | ❌ 禁用 | PRIVATE_EXTENSION_FIELDS 明确拒绝 |

## 5. 失败语义与工程取舍

### 5.1 失败语义

1. **Chrome 连接失败**：
   - 端点验证失败 → 抛出 `Error`，无回退
   - 预检查失败 → 抛出 `Error`，不启动隔离浏览器
   - 连接中途断开 → `onToolCallDisconnected()` 回调，后续工具调用失败

2. **Computer Use 后端不可用**：
   - Zavora 初始化失败 → `getOpenComputerUseClient()` 抛出
   - Native adapter `isDisabled()` → `listTools()` 返回空数组，调用失败
   - OS 权限缺失 → 明确返回 `tcc_denied` 错误

3. **权限失败**：
   - `onPermissionRequest()` 返回拒绝 → `permission_denied` 错误
   - target 应用未授权 → `permission_denied` 错误
   - 标志位未授权 → `permission_denied` 错误

4. **并发控制**：
   - Zavora 调用不可重入 → `lock_held` 错误
   - Chrome 客户端单例 → 并发 `getOpenChromeClient()` 返回同一实例

### 5.2 工程取舍

| 取舍 | 选择 | 理由 | 代价 |
|------|------|------|------|
| 客户端生命周期 | 模块级单例 | 简化使用，共享连接 | 状态管理复杂，需要显式关闭 |
| Bun 下 Chrome 连接 | Node 子进程 | 绕过 Bun WebSocket 兼容性问题 | 额外进程开销 |
| 工具调用队列 | 串行队列 | 避免 Chrome CDP 并发竞争 | 吞吐量降低 |
| browser_close | 禁用 | 保护用户真实浏览器标签 | 无法通过工具关闭整个浏览器 |
| Zavora full-screen | 禁用 | 防止超出授权范围捕获 | 需要明确 target_app |
| 坐标模式 | 启动时冻结 | 简化实现，避免模式切换错误 | 运行时无法切换 |

### 5.3 已知限制

1. **Bun 限制**：Chrome CDP 连接在 Bun 下必须通过 Node 子进程，因为 Bun 的 WebSocket 客户端无法完成 Playwright 的握手
2. **坐标系统差异**：Zavora 与 Native 后端坐标系统不同，Zavora 使用平台原生坐标，Native 支持 pixels/normalized 两种模式
3. **浏览器标签持久性**：Real Chrome 模式下，断开 MCP 连接不会关闭已打开的标签，这是设计选择而非缺陷
4. **权限只能增加**：`CuGrantFlags` 一旦授予，在会话期间只能增加，不能撤销单个标志

## 6. 现状验收标准

### 6.1 功能验收标准

1. **Chrome CDP 安全验证**：
   - ✅ 仅允许 `http://127.0.0.1`, `https://127.0.0.1`, `ws://[::1]`, `wss://[::1]` 格式
   - ✅ 拒绝包含用户信息的 URL（`user:pass@`）
   - ✅ 拒绝包含查询参数或哈希的 URL
   - ✅ 拒绝 `localhost`, `0.0.0.0`, 私有地址等

2. **后端显式选择**：
   - ✅ `createZavoraComputerUseBackend()` 返回 `kind: 'zavora'`
   - ✅ `createNativeComputerUseBackend()` 返回 `kind: 'native-adapter'`
   - ✅ 两者无相互调用或回退

3. **私有路径禁用**：
   - ✅ `computer-use-swift.ts` 和 `computer-use-input.ts` 固定 unavailable
   - ✅ `PRIVATE_EXTENSION_FIELDS` 在配置中被检测并拒绝

### 6.2 测试验收标准

1. **单元测试覆盖**：
   - `assertLoopbackCdpEndpoint()` 边界条件测试
   - `targetImageSize()` 边界条件测试
   - 权限验证逻辑测试

2. **集成测试**：
   - `openBackends.test.ts` 验证 isolated 与 real Chrome 客户端独立
   - `openBackends.test.ts` 验证 Zavora 工具枚举
   - `openBackends.test.ts` 验证权限拒绝流程

## 7. 代码与测试证据

### 7.1 关键代码片段

**Chrome CDP 端点验证** (`claude-for-chrome-mcp.ts`)：
```typescript
export function assertLoopbackCdpEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch (error) {
    throw new Error('Invalid Chrome CDP endpoint URL', { cause: error })
  }

  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Chrome CDP endpoint must use http(s) or ws(s)')
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    throw new Error(
      'Chrome CDP endpoint must use loopback 127.0.0.1 or [::1]; non-loopback and 0.0.0.0 are not allowed',
    )
  }
  if (url.username || url.password) {
    throw new Error('Chrome CDP endpoint must not contain URL userinfo')
  }
  if (url.search || url.hash) {
    throw new Error('Chrome CDP endpoint must not contain query or fragment data')
  }
  return endpoint
}
```

**后端显式创建** (`computer-use-mcp.ts`, `computer-use-native.ts`)：
```typescript
export function createZavoraComputerUseBackend(options?: {
  serverOptions?: ZavoraServerOptions
}): ComputerUseBackend {
  // ...
  return {
    kind: 'zavora',
    async listTools() { /* ... */ },
    async dispatch(name, args, context, signal) { /* ... */ },
    async close() { /* ... */ },
  }
}

export function createNativeComputerUseBackend(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
): ComputerUseBackend {
  return {
    kind: 'native-adapter',
    async listTools() { /* ... */ },
    dispatch(name, args, context, signal) { /* ... */ },
    async close() { /* ... */ },
  }
}
```

**私有字段拒绝** (`claude-for-chrome-mcp.ts`)：
```typescript
const PRIVATE_EXTENSION_FIELDS = [
  'socketPath',
  'getSocketPaths',
  'clientTypeId',
  'onAuthenticationError',
  'onExtensionPaired',
  'getPersistedDeviceId',
  'bridgeConfig',
  'callAnthropicMessages',
] as const

function assertOpenChromeContext(context: OpenChromeContext): void {
  if (context.kind !== 'chrome-cdp') {
    throw new Error('Real Chrome requires an explicit chrome-cdp context')
  }
  for (const field of PRIVATE_EXTENSION_FIELDS) {
    if ((context as unknown as Record<string, unknown>)[field] !== undefined) {
      throw new Error(
        `Open CDP does not support private extension pairing, native messaging, or bridge configuration (${field})`,
      )
    }
  }
  // ...
}
```

### 7.2 测试证据

**openBackends.test.ts** 测试覆盖：
- 独立客户端管理：`getOpenBrowserClient()` 与 `getOpenChromeClient()` 返回不同实例
- 端点验证测试：验证回环地址接受、其他地址拒绝
- 配置验证：isolated 与 chrome-cdp 配置分离
- 工具列表：`listBrowserTools()`, `listOpenChromeTools()`, `listOpenComputerUseTools()`
- 权限拒绝：Zavora 调用在未授权时返回 `permission_denied`

关键测试片段：
```typescript
test('accepts only explicit loopback CDP URLs without credentials', () => {
  expect(assertLoopbackCdpEndpoint('http://127.0.0.1:9222')).toContain('9222')
  expect(assertLoopbackCdpEndpoint('ws://[::1]:9222/devtools/browser/id')).toContain('devtools')
  for (const endpoint of [
    'not a URL',
    'http://localhost:9222',
    'http://0.0.0.0:9222',
    'http://192.168.1.2:9222',
    'https://example.com/cdp',
    'http://user:pass@127.0.0.1:9222',
    'http://127.0.0.1:9222/?access_token=secret',
    'file:///tmp/chrome',
  ]) {
    expect(() => assertLoopbackCdpEndpoint(endpoint)).toThrow()
  }
})
```

## 8. 文件覆盖与相关子系统

### 8.1 源文件覆盖

| 文件 | 主要职责 | 公开接口 | 测试覆盖 |
|------|----------|----------|----------|
| `src/external-stubs/claude-for-chrome-mcp.ts` | Chrome MCP 客户端/服务器 | `getOpenChromeClient()`, `createClaudeForChromeMcpServer()`, `assertLoopbackCdpEndpoint()` | ✅ `openBackends.test.ts` |
| `src/external-stubs/computer-use-types.ts` | 公共类型定义 | `ComputerUseBackend`, `ComputerUseSessionContext`, `CuCallToolResult` | 类型测试 |
| `src/external-stubs/computer-use-native.ts` | 原生适配器后端 | `createNativeComputerUseBackend()`, `bindSessionContext()`, `buildComputerUseTools()` | 间接覆盖 |
| `src/external-stubs/computer-use-mcp.ts` | Zavora 后端 | `createZavoraComputerUseBackend()`, `bindZavoraSessionContext()`, `listOpenComputerUseTools()` | ✅ `openBackends.test.ts` |
| `src/external-stubs/computer-use-swift.ts` | Swift 占位符 | (unavailable) | 无 |
| `src/external-stubs/computer-use-input.ts` | 输入占位符 | (unavailable) | 无 |
| `src/external-stubs/computer-use-sentinel-apps.ts` | 哨兵应用列表 | (常量) | 无 |

### 8.2 相关子系统

1. **MCP 集成** (`src/services/mcp/`)：
   - `connectToServer()` 可以连接 `claude-for-chrome-mcp`
   - 集成在更大的 MCP 服务器生态中

2. **Computer Use 宿主** (`src/utils/computerUse/`)：
   - `hostAdapter.ts` 提供 `ComputerUseHostAdapter` 实现
   - `wrapper.tsx` 使用 `bindSessionContext()` 或 `bindZavoraSessionContext()`
   - `mcpServer.ts` 创建 MCP 服务器

3. **Web 浏览器工具** (`src/tools/WebBrowserTool.ts`)：
   - 使用 `listBrowserTools()` 和隔离浏览器客户端

4. **契约文档** (`docs/external-stubs/contracts/`)：
   - `computer-use-backends.md`：后端设计契约
   - `open-chrome.md`：Chrome 连接契约
   - 其他契约定义各个子系统行为

## 9. 改进建议

### 9.1 短期改进

1. **增加客户端工厂抽象**：目前 `getOpenChromeClient()` 和 `getOpenBrowserClient()` 是独立的顶级函数，可以考虑统一的客户端工厂接口，同时保持后端显式选择的原则

2. **错误类型结构化**：目前主要使用字符串错误信息和 `errorKind` 字段，可以考虑定义专门的错误类层次结构

3. **测试隔离增强**：`openBackends.test.ts` 中 Zavora 测试仍然依赖真实的 Zavora 包，可以考虑增加更多测试替身

### 9.2 中期改进

1. **健康检查 API**：增加后端健康检查接口，允许在调用工具前探测后端可用性和能力

2. **能力协商**：允许客户端查询后端支持的工具集和能力，而不是硬编码差异

3. **多会话支持**：当前实现主要是单例模式，可以考虑支持多独立会话

### 9.3 长期考虑

1. **插件化后端**：考虑将后端实现完全插件化，通过统一的 SPI 加载，而不是编译时选择

2. **跨后端工具兼容性层**：在保持显式后端选择的前提下，可以提供工具兼容性映射，简化上层调用

3. **可观测性增强**：增加更多追踪点、指标和结构化日志，便于调试外部依赖问题
