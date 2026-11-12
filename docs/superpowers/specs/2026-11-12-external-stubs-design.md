---
id: external-stubs
batch: 7
title: External Stubs 外部依赖边界与禁用契约设计
date: 2026-11-12
status: draft
---

# External Stubs 外部依赖边界与禁用契约设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

`src/external-stubs/` 模块处理外部依赖边界，面临的核心问题与约束包括：

- 外部依赖可用性不确定：`computer-use-swift.ts` 和 `computer-use-input.ts` 明确标记为 unavailable，external 构建不包含私有模块
- 安全边界严格：Chrome CDP 端点必须是显式回环地址（127.0.0.1 或 [::1]），不允许凭证
- 公开/私有边界清晰：需要明确区分公开实现与私有兼容路径，不能相互冒充
- 平台支持差异：不同操作系统有不同的实现路径和能力
- 测试隔离：需要提供测试钩子和隔离机制，允许单元测试和集成测试不依赖真实外部服务
- 契约驱动：需要明确定义各子系统的行为契约
- 错误可观测：外部依赖失败时需要提供明确的错误信息，不静默降级或冒充
- Bun 兼容性：Chrome CDP 连接在 Bun 下需要通过 Node 子进程，因为 Bun 的 WebSocket 客户端无法完成 Playwright 的握手

## 2. 设计理由与备选方案

### 决策 1：显式后端选择而非透明回退

决策：采用显式 `ComputerUseBackendKind`（'zavora' | 'native-adapter'）区分后端，由调用方明确选择，不做透明回退。

为什么采用：行为可预测、错误明确、易于测试，不会错误宣称能力。

备选方案：
- 透明回退链：先尝试私有 Swift，失败后回退到 Zavora，再失败回退到占位符 —— 缺点是不可预测行为、难以调试
- 混合方案：提供便捷工厂但记录实际使用的后端 —— 缺点是增加复杂度，仍然存在行为不明确问题

代价：调用方需要知道可用的后端并进行选择，增加了使用复杂度。

证据：`src/external-stubs/computer-use-types.ts` 中明确定义 `ComputerUseBackend`、`createZavoraComputerUseBackend()`、`createNativeComputerUseBackend()`

### 决策 2：Chrome CDP 安全验证与隔离

决策：Chrome CDP 端点必须通过 `assertLoopbackCdpEndpoint()` 验证，且不支持私有扩展配对字段。

为什么采用：安全边界清晰、防止 SSRF，确保不连接到非预期的地址。

备选方案：
- 接受任意 URL 并信任上游验证 —— 缺点是安全风险高，可能暴露内部服务
- 允许配置允许列表但默认仅允许回环 —— 优点是灵活性，缺点是增加复杂度

代价：不支持非回环地址的合法用例（如远程调试），需要用户通过显式例外处理。

证据：`src/external-stubs/claude-for-chrome-mcp.ts` 中 `assertLoopbackCdpEndpoint()` 函数、`PRIVATE_EXTENSION_FIELDS` 列表、`createOpenChromeConfig()` 验证

### 决策 3：独立的工具列表与客户端管理

决策：isolated Playwright 浏览器与 real Chrome CDP 使用独立的客户端生成、工具列表和关闭逻辑。

为什么采用：边界清晰、可以独立演进、测试隔离，不会意外混用不同后端。

备选方案：
- 统一客户端抽象，透明切换后端 —— 缺点是隐藏差异、难以针对特定后端优化
- 共享基础设施但保持独立的工具过滤 —— 优点是代码复用，缺点是仍然可能产生意外耦合

代价：存在一些重复代码，维护两份相似的客户端生命周期管理。

证据：`src/external-stubs/claude-for-chrome-mcp.ts` 中独立的 `isolatedConnection` 与 `chromeConnection` 状态、独立的工具列表函数

### 决策 4：权限委托与宿主验证结合

决策：Zavora 后端同时使用 `ServerOptions.authorizeToolCall` 和宿主 `ComputerUseSessionContext` 双重验证，权限取交集。

为什么采用：双重保障、权限统一管理，Zavora 内部工具调用链也能被拦截。

备选方案：
- 完全信任 Zavora 内置权限系统 —— 缺点是绕过宿主侧权限模型、难以统一审计
- 仅宿主验证，完全由宿主验证后再调用 Zavora 工具 —— 优点是统一入口，缺点是 Zavora 内部工具调用链无法拦截

代价：存在重复验证，可能略微影响性能。

证据：`src/external-stubs/computer-use-mcp.ts` 中 `authorizeToolCall` 配置调用 `authorizeZavoraCall()`，后者使用宿主 `context` 进行权限检查

### 决策 5：占位符明确标记 unavailable

决策：`computer-use-swift.ts` 和 `computer-use-input.ts` 明确标记为 unavailable，不提供实际实现。

为什么采用：清晰区分公开/私有边界，防止意外依赖私有模块，external 构建可以安全排除。

备选方案：
- 提供模拟实现 —— 缺点是可能误导调用方，以为功能可用
- 完全移除文件 —— 缺点是代码库结构不完整，引用处需要条件编译

代价：引用处需要检查可用性，增加了调用方复杂度。

证据：`src/external-stubs/computer-use-swift.ts`、`src/external-stubs/computer-use-input.ts`

## 3. 目标与非目标

### 目标

- 明确公开/私有边界：清晰区分可以公开使用的接口（Zavora、公开 CDP）与私有兼容路径（Swift 模块、私有扩展）
- 安全默认关闭：除非显式配置，否则不允许不安全的操作（非回环 CDP、未授权权限等）
- 可测试性：提供测试钩子和隔离机制，允许单元测试和集成测试不依赖真实外部服务
- 契约驱动设计：通过 `docs/external-stubs/contracts/` 目录下的契约文档明确定义行为
- 错误可观测：外部依赖失败时提供明确的错误信息，不静默降级或冒充
- 显式后端选择：不做透明回退，行为可预测
- 双重权限验证：Zavora 侧和宿主侧同时验证，取交集
- Bun 兼容性：在 Bun 下通过 Node 子进程处理 Chrome CDP 连接

### 非目标

- 不实现私有模块：不尝试重新实现 `@ant/computer-use-swift` 或私有 Chrome 扩展的 ABI
- 不隐藏能力差异：不同后端有不同能力，不尝试通过抽象层完全抹平差异
- 不承诺跨平台统一：接受不同平台有不同的可用后端和能力
- 不替代上游验证：在安全边界内工作，不尝试替代 Playwright 或 Zavora 已有的安全机制
- 不实现透明回退：调用方需要明确选择后端
- 不支持非回环 CDP 地址：默认仅允许 127.0.0.1 和 [::1]

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

docs/external-stubs/
└── contracts/                   # 契约文档
    ├── computer-use-backends.md
    ├── open-chrome.md
    └── ...
```

### 4.2 关键公开接口

#### Chrome 浏览器接口（`claude-for-chrome-mcp.ts`）

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

#### Computer Use 接口（`computer-use-types.ts`、`computer-use-mcp.ts`、`computer-use-native.ts`）

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

### 4.3 数据流

#### Chrome CDP 连接流程

```
调用方 (OpenChromeContext)
    ↓
assertLoopbackCdpEndpoint() 验证地址
    ├─ 失败 → 抛出 Error，无回退
    └─ 成功 → 继续
    ↓
createOpenChromeConfig() 验证无私有字段
    ├─ 发现私有字段 → 抛出 Error
    └─ 成功 → 继续
    ↓
preflightOpenChrome() 探测端点可用性
    ├─ 失败 → 抛出 Error，不启动隔离浏览器
    └─ 成功 → 继续
    ↓
connectPlaywrightUpstream() 连接（Bun 下使用 Node 子进程）
    ↓
createOpenChromeProxyServer() 创建代理
    ↓
代理层过滤：
    ├─ 移除 browser_close 工具
    ├─ 添加 "Real Chrome" 描述前缀
    ├─ 序列化工具调用队列
    └─ 事件追踪
    ↓
Playwright MCP → Chrome CDP
    ↓
连接中途断开 → onToolCallDisconnected() 回调，后续工具调用失败
```

#### Computer Use 调用流程

```
调用方
    ↓
bind[Zavora|Session]Context() 绑定上下文
    ↓
dispatch(name, args, context, signal)
    ↓
验证阶段：
    ├─ checkAbort(signal)
    ├─ 检查后端可用性
    ├─ 检查锁状态
    ├─ check CuLock
    └─ 前置 OS 权限检查
    ↓
权限阶段：
    ├─ requiredFlags() 计算需要的权限
    ├─ ensureGrants() 请求缺失授权
    └─ target 应用授权检查
    ↓
执行阶段：
    ├─ Zavora：client.callTool() → upstream
    └─ Native：adapter.executor.method()
    ↓
结果包装（structuredContent, telemetry）
```

### 4.4 公开实现与私有兼容边界

| 路径 | 类型 | 状态 | 说明 |
|------|------|------|------|
| Zavora backend | 公开实现 | 可用 | 使用 `@zavora/computer-use-mcp` |
| Native adapter backend | 公开实现 | 可用 | 通过 `ComputerUseHostAdapter` 适配 |
| Chrome CDP (公开) | 公开实现 | 可用 | 回环地址验证 |
| Isolated Playwright | 公开实现 | 可用 | 独立浏览器实例 |
| computer-use-swift.ts | 私有兼容 | unavailable | 占位符，无实际实现 |
| computer-use-input.ts | 私有兼容 | unavailable | 占位符，无实际实现 |
| 私有 Chrome 扩展配对 | 私有兼容 | 禁用 | PRIVATE_EXTENSION_FIELDS 明确拒绝 |

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 失败场景 | 处理方式 | 错误类型 |
|---------|---------|---------|
| Chrome CDP 端点验证失败 | 抛出 Error，无回退 | 明确错误信息 |
| Chrome 配置发现私有字段 | 抛出 Error | 明确拒绝 |
| Chrome 预检查失败 | 抛出 Error，不启动隔离浏览器 | 明确错误信息 |
| Chrome 连接中途断开 | onToolCallDisconnected() 回调 | 后续工具调用失败 |
| Zavora 初始化失败 | getOpenComputerUseClient() 抛出 | 明确错误信息 |
| Native adapter isDisabled() | listTools() 返回空数组，调用失败 | 明确错误信息 |
| OS 权限缺失 | 明确返回 tcc_denied 错误 | 结构化错误 |
| onPermissionRequest() 返回拒绝 | permission_denied 错误 | 结构化错误 |
| target 应用未授权 | permission_denied 错误 | 结构化错误 |
| 标志位未授权 | permission_denied 错误 | 结构化错误 |
| Zavora 调用不可重入 | lock_held 错误 | 结构化错误 |
| Chrome 客户端并发访问 | 模块级单例，返回同一实例 | 线程安全 |

### 5.2 工程取舍

| 取舍 | 选择 | 理由 | 代价 |
|-----|------|------|------|
| 后端选择策略 | 显式选择，不透明回退 | 行为可预测、错误明确 | 调用方复杂度增加 |
| 客户端生命周期 | 模块级单例 | 简化使用，共享连接 | 状态管理复杂，需要显式关闭 |
| Bun 下 Chrome 连接 | Node 子进程 | 绕过 Bun WebSocket 兼容性问题 | 额外进程开销 |
| 工具调用队列 | 串行队列 | 避免 Chrome CDP 并发竞争 | 吞吐量降低 |
| browser_close 工具 | 禁用 | 保护用户真实浏览器标签 | 无法通过工具关闭整个浏览器 |
| Zavora full-screen | 禁用 | 防止超出授权范围捕获 | 需要明确 target_app |
| 坐标模式 | 启动时冻结 | 简化实现，避免模式切换错误 | 运行时无法切换 |
| 权限验证 | 双重验证（Zavora + 宿主） | 双重保障，统一管理 | 重复验证，轻微性能影响 |
| 私有模块处理 | 明确标记 unavailable | 边界清晰，防止意外依赖 | 调用方需要检查可用性 |

### 5.3 已知限制

- Bun 限制：Chrome CDP 连接在 Bun 下必须通过 Node 子进程，因为 Bun 的 WebSocket 客户端无法完成 Playwright 的握手
- 坐标系统差异：Zavora 与 Native 后端坐标系统不同，Zavora 使用平台原生坐标，Native 支持 pixels/normalized 两种模式
- 浏览器标签持久性：Real Chrome 模式下，断开 MCP 连接不会关闭已打开的标签，这是设计选择而非缺陷
- 权限只能增加：`CuGrantFlags` 一旦授予，在会话期间只能增加，不能撤销单个标志
- 非回环 CDP 不支持：默认仅允许 127.0.0.1 和 [::1]，远程调试需要显式例外

## 6. 现状验收标准

### 6.1 功能验收标准

- Chrome CDP 安全验证：仅允许 `http://127.0.0.1`、`https://127.0.0.1`、`ws://[::1]`、`wss://[::1]` 格式；拒绝包含用户信息的 URL；拒绝包含查询参数或哈希的 URL；拒绝 `localhost`、`0.0.0.0`、私有地址等
- 后端显式选择：`createZavoraComputerUseBackend()` 返回 `kind: 'zavora'`；`createNativeComputerUseBackend()` 返回 `kind: 'native-adapter'`；两者无相互调用或回退
- 私有路径禁用：`computer-use-swift.ts` 和 `computer-use-input.ts` 固定 unavailable；`PRIVATE_EXTENSION_FIELDS` 在配置中被检测并拒绝
- 独立客户端管理：`getOpenBrowserClient()` 与 `getOpenChromeClient()` 返回不同实例，状态独立
- 双重权限验证：Zavora `authorizeToolCall` 调用宿主 `authorizeZavoraCall()`，两者都通过才允许执行
- Bun 兼容性：在 Bun 下 Chrome CDP 连接通过 Node 子进程处理
- 工具调用串行化：Real Chrome 模式下工具调用被串行队列化，避免并发竞争
- browser_close 工具被过滤：Real Chrome 模式下不暴露 browser_close 工具
- Zavora full-screen 被禁用：需要明确 target_app 才能使用

### 6.2 行为验收标准

- Chrome CDP 端点验证失败时立即抛出，无回退
- Chrome 配置发现私有字段时立即拒绝
- Chrome 连接中途断开时触发 `onToolCallDisconnected()` 回调
- Native adapter `isDisabled()` 为 true 时 `listTools()` 返回空数组
- Zavora 调用不可重入，并发尝试返回 `lock_held` 错误
- 权限缺失时返回明确的 `tcc_denied` 或 `permission_denied` 错误
- 所有外部依赖失败时提供明确的错误信息，不静默降级或冒充
- 坐标模式在启动时冻结，运行时无法切换

## 7. 代码与测试证据

### 7.1 关键代码证据

Chrome CDP 端点验证：
- `src/external-stubs/claude-for-chrome-mcp.ts`：`assertLoopbackCdpEndpoint()` 函数

后端显式创建：
- `src/external-stubs/computer-use-mcp.ts`：`createZavoraComputerUseBackend()`
- `src/external-stubs/computer-use-native.ts`：`createNativeComputerUseBackend()`

私有字段拒绝：
- `src/external-stubs/claude-for-chrome-mcp.ts`：`PRIVATE_EXTENSION_FIELDS` 列表、`assertOpenChromeContext()`

双重权限验证：
- `src/external-stubs/computer-use-mcp.ts`：`authorizeToolCall` 配置、`authorizeZavoraCall()`

独立客户端管理：
- `src/external-stubs/claude-for-chrome-mcp.ts`：`isolatedConnection` 与 `chromeConnection` 独立状态、`getOpenBrowserClient()`、`getOpenChromeClient()`

占位符模块：
- `src/external-stubs/computer-use-swift.ts`：unavailable 标记
- `src/external-stubs/computer-use-input.ts`：unavailable 标记

### 7.2 测试覆盖现状

现有测试：
- `tests/openBackends.test.ts`：验证 isolated 与 real Chrome 客户端独立；验证 Zavora 工具枚举；验证权限拒绝流程；验证 `assertLoopbackCdpEndpoint()` 边界条件

未覆盖场景：
- Bun 下 Node 子进程 Chrome CDP 连接的完整流程测试
- Native adapter 后端的完整测试覆盖
- Zavora 双重权限验证的完整路径测试
- 工具调用串行化的并发测试
- 错误路径的完整覆盖（预检查失败、连接中途断开、权限缺失等）
- 契约文档与实现的一致性验证
- `computer-use-sentinel-apps.ts` 的测试覆盖
- 坐标系统差异的测试（Zavora vs Native）

## 8. 文件覆盖与相关子系统

### 8.1 源文件覆盖

| 文件 | 主要职责 | 公开接口 | 测试覆盖 |
|------|---------|---------|---------|
| `src/external-stubs/claude-for-chrome-mcp.ts` | Chrome MCP 客户端/服务器 | `getOpenChromeClient()`, `createClaudeForChromeMcpServer()`, `assertLoopbackCdpEndpoint()` | 有（openBackends.test.ts） |
| `src/external-stubs/computer-use-types.ts` | 公共类型定义 | `ComputerUseBackend`, `ComputerUseSessionContext`, `CuCallToolResult` | 类型测试 |
| `src/external-stubs/computer-use-native.ts` | 原生适配器后端 | `createNativeComputerUseBackend()`, `bindSessionContext()`, `buildComputerUseTools()` | 间接覆盖 |
| `src/external-stubs/computer-use-mcp.ts` | Zavora 后端 | `createZavoraComputerUseBackend()`, `bindZavoraSessionContext()`, `listOpenComputerUseTools()` | 有（openBackends.test.ts） |
| `src/external-stubs/computer-use-swift.ts` | Swift 占位符 | unavailable | 无 |
| `src/external-stubs/computer-use-input.ts` | 输入占位符 | unavailable | 无 |
| `src/external-stubs/computer-use-sentinel-apps.ts` | 哨兵应用列表 | 常量 | 无 |

### 8.2 相关子系统

- MCP 集成：`src/services/mcp/` 用于连接 `claude-for-chrome-mcp`
- Computer Use 宿主：`src/utils/computerUse/` 提供 `ComputerUseHostAdapter` 实现，`wrapper.tsx` 使用 `bindSessionContext()` 或 `bindZavoraSessionContext()`，`mcpServer.ts` 创建 MCP 服务器
- Web 浏览器工具：`src/tools/WebBrowserTool.ts` 使用 `listBrowserTools()` 和隔离浏览器客户端
- 契约文档：`docs/external-stubs/contracts/` 定义各子系统行为

[Coverage](../../architecture/coverage/external-stubs.yaml)

## 9. 改进建议

### 9.1 短期改进

- 增加客户端工厂抽象：目前 `getOpenChromeClient()` 和 `getOpenBrowserClient()` 是独立的顶级函数，可以考虑统一的客户端工厂接口，同时保持后端显式选择的原则
- 错误类型结构化：目前主要使用字符串错误信息和 `errorKind` 字段，可以考虑定义专门的错误类层次结构
- 测试隔离增强：`openBackends.test.ts` 中 Zavora 测试仍然依赖真实的 Zavora 包，可以考虑增加更多测试替身
- 增加 `computer-use-sentinel-apps.ts` 的测试覆盖
- 验证契约文档与实现的一致性，确保文档是最新的

### 9.2 中期改进

- 健康检查 API：增加后端健康检查接口，允许在调用工具前探测后端可用性和能力
- 能力协商：允许客户端查询后端支持的工具集和能力，而不是硬编码差异
- 多会话支持：当前实现主要是单例模式，可以考虑支持多独立会话
- 运行时坐标模式切换：考虑支持安全的运行时坐标模式切换机制
- 权限撤销机制：考虑支持权限标志的撤销，而不仅是增加
- 可配置的 CDP 允许列表：在安全的前提下，考虑支持可配置的 CDP 端点允许列表

### 9.3 长期考虑

- 插件化后端：考虑将后端实现完全插件化，通过统一的 SPI 加载，而不是编译时选择
- 跨后端工具兼容性层：在保持显式后端选择的前提下，可以提供工具兼容性映射，简化上层调用
- 可观测性增强：增加更多追踪点、指标和结构化日志，便于调试外部依赖问题
- Bun 原生支持：如果 Bun 的 WebSocket 客户端未来能够完成 Playwright 握手，考虑移除 Node 子进程方案
- 分布式 Computer Use：考虑支持远程 Computer Use 后端，允许多机协作
- 端到端加密：考虑为外部依赖通信增加端到端加密支持
