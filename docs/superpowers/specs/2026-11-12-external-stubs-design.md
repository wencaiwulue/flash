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

### 4.2 模块设计卡

#### Computer Use 类型系统（`computer-use-types.ts`）

**真实入口签名与关键类型**
```typescript
// 核心后端抽象
export type ComputerUseBackendKind = 'zavora' | 'native-adapter'
export type ComputerUseBackend = {
  kind: ComputerUseBackendKind
  listTools(): Promise<ComputerUseTool[]>
  dispatch(
    name: string,
    args: unknown,
    context: ComputerUseSessionContext,
    signal: AbortSignal,
  ): Promise<CuCallToolResult>
  close(): Promise<void>
}

// 宿主适配器（由宿主实现）
export type ComputerUseHostAdapter = {
  serverName: string
  logger: Logger
  executor: ComputerExecutor
  ensureOsPermissions(): Promise<OsPermissionState>
  isDisabled(): boolean
  getSubGates(): CuSubGates
  getAutoUnhideEnabled(): boolean
  cropRawPatch(...args: unknown[]): Buffer | null
}

// 会话上下文（由宿主实现）
export type ComputerUseSessionContext = {
  getAllowedApps(): readonly AppGrant[]
  getGrantFlags(): CuGrantFlags
  getUserDeniedBundleIds(): readonly string[]
  getSelectedDisplayId(): number | undefined
  getDisplayPinnedByModel(): boolean
  getDisplayResolvedForApps(): string | undefined
  getLastScreenshotDims(): ScreenshotDims | undefined
  onPermissionRequest(
    request: CuPermissionRequest,
    dialogSignal: AbortSignal,
  ): Promise<CuPermissionResponse>
  onAllowedAppsChanged(
    apps: readonly AppGrant[],
    flags: CuGrantFlags,
  ): void
  onAppsHidden(bundleIds: readonly string[]): void
  onResolvedDisplayUpdated(displayId: number): void
  onDisplayPinned(displayId: number | undefined): void
  onDisplayResolvedForApps(key: string | undefined): void
  onScreenshotCaptured(dims: ScreenshotDims): void
  checkCuLock(): Promise<{ holder: string | undefined; isSelf: boolean }>
  acquireCuLock(): Promise<void>
  formatLockHeldMessage(holder: string): string
}
```

**输入输出**
- 输入：工具名称 `name`、工具参数 `args`、会话上下文 `context`、中止信号 `signal`
- 输出：`CuCallToolResult` 包含 `content`、`isError`、`structuredContent`、`telemetry.error_kind`
- 权限请求：`CuPermissionRequest` → `CuPermissionResponse`（同步权限授予）

**配置与后端状态**
- 无模块级配置
- 无模块级状态（状态由各具体实现持有）
- `CoordinateMode` 在创建时冻结：`'pixels'`（原生像素坐标）或 `'normalized'`（归一化坐标）

**创建/调用/关闭流程**
- 创建：无工厂函数，由具体后端模块实现 `ComputerUseBackend` 接口
- 调用：统一通过 `backend.dispatch(name, args, context, signal)` 进行
- 关闭：调用 `backend.close()` 释放后端资源

**错误与安全**
- 无直接错误类，通过 `CuCallToolResult.isError` 和 `telemetry.error_kind` 返回
- 安全边界由具体实现处理，类型系统仅定义契约

**设计取舍与备选**
- 采用接口而非基类：更灵活的组合，允许不同后端独立演进
- 类型仅定义契约：无运行时检查，由实现保证行为符合预期
- 备选：抽象基类 + 模板方法模式，但会增加耦合
- 公开实现与私有 wire compatibility 不宣称：类型定义仅为公开可用实现提供契约，不保证与私有实现的兼容性

**源码测试证据**
- 位置：`src/external-stubs/computer-use-types.ts` (L1-249)
- 覆盖：类型测试（无运行时测试）

---

#### Zavora Computer Use 后端（`computer-use-mcp.ts`）

**真实入口签名与关键类型**
```typescript
// 工厂函数
export function createZavoraComputerUseBackend(options?: {
  serverOptions?: ZavoraServerOptions
}): ComputerUseBackend

// 快捷绑定
export function bindZavoraSessionContext(
  context: ComputerUseSessionContext,
): (name: string, args: unknown, signal?: AbortSignal) => Promise<CuCallToolResult>

// 测试用直接客户端
export function getOpenComputerUseClient(): Promise<Client>
export async function closeOpenComputerUseClient(): Promise<void>
export async function listOpenComputerUseTools(): Promise<ComputerUseTool[]>

// 内部错误类型（附加 errorKind）
function hostError(kind: string, message: string): Error
```

**输入输出**
- 输入：`options.serverOptions`（可选，Zavora MCP 服务器配置，不含 `profile` 和 `authorizeToolCall`）
- 输出：`ComputerUseBackend` 实例
- 工具调用输入：工具名、参数、上下文、信号
- 工具调用输出：`CuCallToolResult`，包含 `structuredContent.error` 和 `structuredContent.remediation`

**配置与后端状态**
- 模块级单例客户端：`clientPromise: Promise<Client> | undefined`
- 后端实例状态：`current?: { context, signal }`、`sessionTarget: string`
- 配置：仅通过工厂参数传入 `serverOptions`
- 后端选择无自动降级：显式创建 Zavora 后端，失败即抛错

**创建/调用/关闭流程**
```
创建：
  createZavoraComputerUseBackend()
    → connectClient()
      → createComputerUseServer()（配置 authorizeToolCall 回调）
      → InMemoryTransport.createLinkedPair()
      → server.connect() + client.connect()

调用：
  backend.dispatch(name, args, context, signal)
    → 检查 current 状态（不可重入）
    → checkAbort(signal)
    → authorizeZavoraCall()（前置授权）
    → client.callTool()
    → setTarget 时更新 sessionTarget
    → 错误包装：errorKind + remediation

关闭：
  backend.close()
    → client.close()
```

**错误与安全**
- `errorKind` 类型：`'permission_denied'`、`'lock_held'`、`'backend_dispatch'`、`'invalid_arguments'` 等
- 安全验证：`authorizeZavoraCall()` 在 Zavora 内部工具调用前执行
- 权限交集：Zavora 内置权限 + 宿主上下文权限取交集
- 全屏截图禁用：`screenshot` 工具 `full_screen=true` 时抛错
- 工具重入锁：`context.checkCuLock()` 在变更操作前检查

**设计取舍与备选**
- 使用 `@zavora/computer-use-mcp` 上游包：利用成熟实现，减少维护成本
- InMemoryTransport 内存传输：无额外进程，性能更好
- 备选：使用独立子进程运行 Zavora，增加隔离但复杂
- 公开实现与私有 wire compatibility 不宣称：不保证与私有 Zavora 变体兼容
- 后端选择无自动降级：调用方明确选择，行为可预测

**源码测试证据**
- 位置：`src/external-stubs/computer-use-mcp.ts` (L1-490)
- 覆盖：`tests/openBackends.test.ts` 包含 Zavora 工具枚举测试

---

#### Native Adapter Computer Use 后端（`computer-use-native.ts`）

**真实入口签名与关键类型**
```typescript
// 工厂函数
export function createNativeComputerUseBackend(
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
): ComputerUseBackend

// 快捷绑定
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

// 图像缩放参数
export const API_RESIZE_PARAMS = { maxWidth: 1568, maxHeight: 1568, maxPixels: 1_150_000 }
export function targetImageSize(width: number, height: number, params: ImageResizeParams): [number, number]
```

**输入输出**
- 输入：`adapter`（宿主适配器）、`coordinateMode`（坐标模式，创建时冻结）
- 输出：`ComputerUseBackend` 实例
- 工具调用输出：`CuCallToolResult`，包含 `structuredContent.error` 和 `structuredContent.remediation`

**配置与后端状态**
- 无模块级单例
- 状态由 `createNativeDispatcher()` 创建的闭包持有
- `coordinateMode` 启动时冻结，运行时不可切换
- 权限标志：`CuGrantFlags`（`clipboardRead`、`clipboardWrite`、`systemKeyCombos`）仅增加不撤销

**创建/调用/关闭流程**
```
创建：
  createNativeComputerUseBackend(adapter, coordinateMode)
    → 持有 adapter 和 coordinateMode
    → 无预连接，按需创建 dispatcher

调用：
  backend.dispatch(name, args, context, signal)
    → createNativeDispatcher() 闭包
    → checkAbort(signal)
    → adapter.isDisabled() 检查
    → checkCuLock() + acquireCuLock()
    → adapter.ensureOsPermissions()（TCC 检查）
    → 工具路由：
      - request_access：权限对话框
      - list_*：只读查询
      - screenshot/zoom：捕获操作
      - mouse/key/type：输入操作
      - computer_batch：批处理执行
    → 输入操作前：prepareForAction() + verifyFrontmost()

关闭：
  backend.close()
    → resetComputerUseInputLoader()
    → resetComputerUseSwiftLoader()
    → closeComputerUseHelper()
```

**错误与安全**
- `errorKind` 类型：`'backend_unavailable'`、`'tcc_denied'`、`'permission_denied'`、`'invalid_arguments'`、`'invalid_coordinates'`、`'stale_screenshot'`、`'focus_failed'`、`'lock_held'`、`'unknown_tool'`、`'native_action_failed'`
- 前置应用验证：`verifyFrontmost()` 确保当前前台应用在授权列表中
- TCC 权限状态：`tcc_denied` 错误附加 `accessibility` 和 `screenRecording` 布尔字段
- 坐标验证：`resolvePoint()` 确保坐标在截图显示范围内
- 锁保护：变更操作前获取 CuLock，防止并发冲突

**设计取舍与备选**
- 闭包而非类：更灵活的状态封装，无 this 绑定问题
- 坐标模式冻结：避免模式切换带来的复杂性和错误
- 备选：运行时模式切换，但需要维护两套坐标转换逻辑
- 浏览器关闭行为：无（本模块不涉及浏览器）
- 公开实现与私有 wire compatibility 不宣称：不保证与私有原生实现的兼容性

**源码测试证据**
- 位置：`src/external-stubs/computer-use-native.ts` (L1-834)
- 覆盖：间接测试（通过宿主集成测试）

---

#### Swift 模块占位符（`computer-use-swift.ts`）

**真实入口签名与关键类型**
```typescript
// 这是公开版本的占位符，实际实现为私有
// 公开版本仅定义类型和工厂，无实际功能
export type ComputerUseAPI = {
  display: {
    getSize(displayId?: number): Promise<DisplayGeometry>
    listAll(): Promise<DisplayGeometry[]>
  }
  screenshot: {
    captureExcluding(...): Promise<ScreenshotResult>
    captureRegion(...): Promise<{ base64: string; width: number; height: number }>
  }
  apps: {
    prepareDisplay(...): Promise<{ hidden: string[]; activated?: string }>
    previewHideSet(...): Promise<Array<{ bundleId: string; displayName: string }>>
    findWindowDisplays(...): Promise<Array<{ bundleId: string; displayIds: number[] }>>
    appUnderPoint(x: number, y: number): Promise<FrontmostApp | null>
    listInstalled(): Promise<InstalledApp[]>
    iconDataUrl(path: string): Promise<string | null>
    listRunning(): Promise<RunningApp[]>
    open(bundleId: string): Promise<void>
    unhide(bundleIds: string[]): Promise<void>
  }
  tcc: {
    checkAccessibility(): Promise<boolean>
    checkScreenRecording(): Promise<boolean>
  }
  hotkey: {
    registerEscape(onEscape: () => void): Promise<boolean>
    unregister(): Promise<void>
    notifyExpectedEscape(): Promise<void>
  }
  resolvePrepareCapture(...): Promise<ResolvePrepareCaptureResult>
  _drainMainRunLoop(): Promise<void>
}

// 工厂函数（仅类型定义）
export function createComputerUseSwift(helper: ComputerUseHelper): ComputerUseAPI

// 导出命名空间（实际为私有实现占位）
export const display: ComputerUseAPI['display']
export const screenshot: ComputerUseAPI['screenshot']
export const apps: ComputerUseAPI['apps']
export const tcc: ComputerUseAPI['tcc']
export const hotkey: ComputerUseAPI['hotkey']
export const resolvePrepareCapture: ComputerUseAPI['resolvePrepareCapture']
export const _drainMainRunLoop: ComputerUseAPI['_drainMainRunLoop']
```

**输入输出**
- 无公开输入输出（占位符模块）
- 实际私有实现：通过 `getComputerUseHelper()` 注入的 helper 进行 IPC 通信

**配置与后端状态**
- 无公开配置
- 私有缓存：`cached: ComputerUseAPI | undefined`
- 公开实现与私有 wire compatibility 不宣称：类型仅为文档目的，不保证兼容性

**创建/调用/关闭流程**
- 创建：`createComputerUseSwift(helper)` → 包装 helper.request()
- 调用：通过命名空间导出的函数转发到 `defaultSwift()` 单例
- 重置：`resetComputerUseSwiftAdapter()` 清除缓存

**错误与安全**
- 无公开错误定义（由私有实现处理）
- 占位符明确标记不可用：避免外部依赖私有实现细节

**设计取舍与备选**
- 占位符设计：清晰区分公开/私有边界，external 构建可安全排除
- 备选：条件编译，但会增加构建复杂性
- 备选：完全移除文件，但会导致引用处需要条件导入
- 私有字段拒绝：不接受私有扩展字段（通过其他模块处理）

**源码测试证据**
- 位置：`src/external-stubs/computer-use-swift.ts` (L1-266)
- 覆盖：无独立测试（与宿主集成测试一起）

---

#### Input 模块占位符（`computer-use-input.ts`）

**真实入口签名与关键类型**
```typescript
// 公开版本仅定义类型，实际实现为私有
export type ComputerUseInputAPI = {
  isSupported: boolean
  moveMouse(x: number, y: number, animated: boolean): Promise<void>
  mouseButton(
    button: 'left' | 'right' | 'middle',
    action: 'click' | 'press' | 'release',
    count?: 1 | 2 | 3,
  ): Promise<void>
  mouseScroll(amount: number, axis: 'vertical' | 'horizontal'): Promise<void>
  mouseLocation(): Promise<{ x: number; y: number }>
  key(keyName: string, action: 'press' | 'release'): Promise<void>
  keys(keyNames: readonly string[]): Promise<void>
  typeText(text: string): Promise<void>
  getFrontmostAppInfo(): Promise<{ bundleId?: string; appName: string } | null>
}

export type ComputerUseInput = ComputerUseInputAPI | { isSupported: false }

// 工厂函数
export function createComputerUseInput(helper: ComputerUseHelper): ComputerUseInputAPI

// 导出命名空间
export const isSupported: boolean
export const moveMouse: ComputerUseInputAPI['moveMouse']
export const mouseButton: ComputerUseInputAPI['mouseButton']
export const mouseScroll: ComputerUseInputAPI['mouseScroll']
export const mouseLocation: ComputerUseInputAPI['mouseLocation']
export const key: ComputerUseInputAPI['key']
export const keys: ComputerUseInputAPI['keys']
export const typeText: ComputerUseInputAPI['typeText']
export const getFrontmostAppInfo: ComputerUseInputAPI['getFrontmostAppInfo']
```

**输入输出**
- 无公开输入输出（占位符模块）
- 平台支持：`isSupported = process.platform === 'darwin'`

**配置与后端状态**
- 私有缓存：`cached: ComputerUseInputAPI | undefined`
- 无公开配置

**创建/调用/关闭流程**
- 创建：`createComputerUseInput(helper)` → 包装 `helper.request('input.*')`
- 调用：命名空间函数转发到 `defaultInput()` 单例
- 重置：`resetComputerUseInputAdapter()` 清除缓存

**错误与安全**
- 无公开错误定义
- 占位符设计防止外部依赖私有实现

**设计取舍与备选**
- 同 Swift 占位符：明确边界，安全排除
- 公开实现与私有 wire compatibility 不宣称

**源码测试证据**
- 位置：`src/external-stubs/computer-use-input.ts` (L1-93)
- 覆盖：无独立测试

---

#### Sentinel Apps（`computer-use-sentinel-apps.ts`）

**真实入口签名与关键类型**
```typescript
export type SentinelCategory = 'shell' | 'filesystem' | 'system_settings'

export const SENTINEL_APPS: Readonly<Record<string, SentinelCategory>>

export function getSentinelCategory(bundleId: string): SentinelCategory | null
```

**输入输出**
- 输入：`bundleId`（应用包标识符）
- 输出：`SentinelCategory | null`（哨兵类别或 null）

**配置与后端状态**
- 硬编码常量：`SENTINEL_APPS`（只读冻结对象）
- 无运行时状态
- 无配置

**创建/调用/关闭流程**
- 无创建/关闭流程
- 纯函数查询：`getSentinelCategory(bundleId)` → 查表返回

**错误与安全**
- 无错误定义
- 纯函数，无副作用
- 用途：标记需要特殊处理的敏感应用（终端、Finder、系统设置）

**设计取舍与备选**
- 硬编码而非配置：简化，避免配置错误
- 备选：可配置哨兵列表，但会增加复杂性
- 备选：动态检测，但可能被绕过

**源码测试证据**
- 位置：`src/external-stubs/computer-use-sentinel-apps.ts` (L1-15)
- 覆盖：无独立测试

---

#### Chrome Isolated 浏览器（`claude-for-chrome-mcp.ts`）

**真实入口签名与关键类型**
```typescript
// 配置创建
export function createIsolatedBrowserConfig(options?: {
  allowedOrigins?: string[]
}): PlaywrightMcpConfig

// 客户端管理
export async function getOpenBrowserClient(): Promise<Client>
export async function closeOpenBrowserClient(): Promise<void>

// 工具列表
export async function listBrowserTools(): Promise<BrowserToolDescriptor[]>
```

**输入输出**
- 输入：`options.allowedOrigins`（可选，允许的网络源列表）或环境变量 `PLAYWRIGHT_MCP_ALLOWED_ORIGINS`
- 输出：`PlaywrightMcpConfig`、`Client`、`BrowserToolDescriptor[]`
- 工具调用：通过 MCP Client 进行，无专用导出函数

**配置与后端状态**
- 模块级单例：`isolatedConnection?: { generation, promise }`、`isolatedGeneration` 计数器
- 配置：仅通过工厂参数或环境变量
- 私有字段拒绝：本模块不涉及，由 Open Chrome 模块处理

**创建/调用/关闭流程**
```
创建：
  getOpenBrowserClient()
    → createConnection(createIsolatedBrowserConfig())（Playwright 无头隔离浏览器）
    → connectInMemory(server, 'flash-browser')
    → 缓存单例

调用：
  client.listTools() / client.callTool()
    → Playwright MCP 协议
    → 隔离浏览器上下文

关闭：
  closeOpenBrowserClient()
    → connection.close()
    → 清除缓存，增加 generation
```

**错误与安全**
- 无专用错误类型
- 安全：隔离浏览器，不访问用户数据
- 无 loopback CDP 校验：本模块不涉及真实 Chrome CDP

**设计取舍与备选**
- 隔离浏览器：安全，无用户数据风险
- 无头模式：无 UI 干扰，资源占用低
- 备选：有头模式，但可能干扰用户
- 浏览器关闭行为：关闭连接即销毁浏览器上下文

**源码测试证据**
- 位置：`src/external-stubs/claude-for-chrome-mcp.ts` (L418-445, 508-511)
- 覆盖：`tests/openBackends.test.ts` 包含隔离浏览器测试

---

#### Chrome Open CDP（`claude-for-chrome-mcp.ts`）

**真实入口签名与关键类型**
```typescript
// 上下文类型
export type OpenChromeContext = {
  kind: 'chrome-cdp'
  serverName: string
  logger: Logger
  cdpEndpoint: string
  cdpTimeoutMs: number
  allowedOrigins?: string[]
  initialPermissionMode: PermissionMode
  onToolCallDisconnected(): string
  trackEvent(name: string, metadata?: Record<string, unknown>): void
}
export type ClaudeForChromeContext = OpenChromeContext  // 兼容性别名

// 配置创建
export function createOpenChromeConfig(context: OpenChromeContext): PlaywrightMcpConfig

// 端点验证
export function assertLoopbackCdpEndpoint(endpoint: string): string

// 客户端管理
export async function getOpenChromeClient(context: OpenChromeContext): Promise<Client>
export async function closeOpenChromeClient(expectedClient?: Client): Promise<void>

// 工具操作
export async function listOpenChromeTools(context: OpenChromeContext): Promise<BrowserToolDescriptor[]>
export async function callOpenChromeTool(
  context: OpenChromeContext,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError?: boolean }>

// 服务器创建
export async function createClaudeForChromeMcpServer(context: ClaudeForChromeContext): Promise<Server>

// 常量
export const DEFAULT_OPEN_CHROME_CDP_ENDPOINT = 'http://127.0.0.1:9222'
export const DEFAULT_OPEN_CHROME_CDP_TIMEOUT_MS = 30_000
const PRIVATE_EXTENSION_FIELDS = ['socketPath', 'getSocketPaths', 'clientTypeId', ...] as const
```

**输入输出**
- 输入：`OpenChromeContext`（必须 `kind: 'chrome-cdp'`，无私有字段）
- 输出：`PlaywrightMcpConfig`、`Client`、`Server`、工具调用结果
- CDP 端点验证：`assertLoopbackCdpEndpoint()` 确保安全

**配置与后端状态**
- 模块级单例：`chromeConnection?: { generation, promise }`、`chromeGeneration` 计数器
- 代理服务器状态：`closing`、`disconnected`、`toolQueue: Promise`（串行队列）
- 配置：仅通过 `OpenChromeContext` 传入，无其他配置源
- 默认值：`DEFAULT_OPEN_CHROME_CDP_ENDPOINT`、`DEFAULT_OPEN_CHROME_CDP_TIMEOUT_MS`

**创建/调用/关闭流程**
```
创建：
  getOpenChromeClient(context)
    → createClaudeForChromeMcpServer(context)
      → createOpenChromeProxyServer(context)
        → assertOpenChromeContext(context)（验证无私有字段）
        → assertLoopbackCdpEndpoint(context.cdpEndpoint)（loopback 校验）
        → preflightOpenChrome(context)（预检查端点可用性）
        → connectPlaywrightUpstream(context)
          - Bun 下：启动 Node 子进程运行 NODE_CDP_SIDECAR
          - Node 下：直接连接
        → 创建代理 Server，设置 request handler
    → connectInMemory()
    → 缓存单例

调用：
  listOpenChromeTools() / callOpenChromeTool()
    → 代理拦截：
      - 移除 browser_close 工具
      - 添加 "Real Chrome" 描述前缀
      - 串行化工具调用（toolQueue）
      - 事件追踪 trackEvent()
    → Playwright MCP → Chrome CDP
    → 连接断开：onToolCallDisconnected() 回调

关闭：
  closeOpenChromeClient(expectedClient?)
    → 匹配 expectedClient（可选）
    → connection.close()
    → 清除缓存，增加 generation
    → 代理 onclose：只分离，不关闭用户 Chrome 标签
```

**错误与安全**
- CDP 端点验证错误：非 loopback 地址、含用户信息、含查询/哈希、协议不支持
- 私有字段错误：检测到 `PRIVATE_EXTENSION_FIELDS` 中任一字段时抛出
- 预检查失败：无法连接 Chrome CDP 时抛出，无隔离浏览器回退
- 连接断开：后续工具调用失败，触发 `onToolCallDisconnected()`
- loopback CDP 校验：仅允许 `http://127.0.0.1`、`https://127.0.0.1`、`ws://[::1]`、`wss://[::1]`
- 浏览器关闭行为：`browser_close` 工具被禁用，返回明确错误提示使用 `browser_tabs(close)` 或分离连接
- 私有字段拒绝：`assertOpenChromeContext()` 拒绝含私有扩展字段的上下文

**设计取舍与备选**
- 仅 loopback 地址：安全，防止 SSRF 攻击
- 备选：可配置允许列表，但增加复杂度
- 无隔离浏览器回退：失败即暴露，行为可预测
- 备选：透明回退到隔离浏览器，但可能误导用户
- 工具串行队列：避免 Chrome CDP 并发竞争
- 备选：并发调用，但可能导致竞争条件
- Bun 兼容性：使用 Node 子进程绕过 Bun WebSocket 问题
- 备选：等待 Bun 修复，但阻塞发布
- 不关闭用户浏览器：保护用户状态，只分离连接
- 备选：允许关闭，但风险高
- 公开实现与私有 wire compatibility 不宣称：不保证与私有 Claude Chrome 扩展兼容
- 后端选择无自动降级：显式使用 Open CDP，失败即抛错

**源码测试证据**
- 位置：`src/external-stubs/claude-for-chrome-mcp.ts` (L1-535)
- 覆盖：`tests/openBackends.test.ts` 包含 Open Chrome 测试、`assertLoopbackCdpEndpoint()` 边界测试

---

#### 协议禁用边界（跨模块）

**真实入口签名与关键类型**
```typescript
// Chrome 私有扩展字段（claude-for-chrome-mcp.ts）
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

// Zavora 全屏禁用（computer-use-mcp.ts）
if (name === 'screenshot' && args.full_screen === true) {
  throw hostError('permission_denied', 'Full-screen Zavora capture would exceed application grants; capture a granted target_app instead')
}

// 工具列表过滤（claude-for-chrome-mcp.ts）
tools.filter(tool => tool.name !== 'browser_close')
```

**输入输出**
- 输入：可能包含私有字段的上下文、Zavora 工具参数、浏览器工具列表
- 输出：验证错误、过滤后的工具列表、修改后的工具描述

**配置与后端状态**
- 硬编码禁用列表：`PRIVATE_EXTENSION_FIELDS`、`'browser_close'`、Zavora `full_screen=true`
- 无配置，无状态

**创建/调用/关闭流程**
- 创建时：`assertOpenChromeContext()` 检查私有字段
- 调用前：Zavora `authorizeZavoraCall()` 检查全屏参数
- 列表工具时：过滤 `browser_close`

**错误与安全**
- 私有字段拒绝：检测到任一个 `PRIVATE_EXTENSION_FIELDS` 即抛出
- Zavora 全屏拒绝：`permission_denied` 错误
- 浏览器关闭禁用：工具列表中移除，调用时返回明确错误
- loopback CDP 校验：非 loopback 地址抛出
- 公开实现与私有 wire compatibility 不宣称：不保证兼容私有协议

**设计取舍与备选**
- 显式拒绝而非忽略：行为清晰，错误明确
- 备选：静默忽略，但可能导致调试困难
- 硬编码列表：简单，不易出错
- 备选：可配置，但增加复杂性
- 浏览器关闭行为：禁用而非允许，保护用户浏览器状态

**源码测试证据**
- 位置：跨 `src/external-stubs/claude-for-chrome-mcp.ts` 和 `src/external-stubs/computer-use-mcp.ts`
- 覆盖：`tests/openBackends.test.ts` 包含部分测试

### 4.3 关键公开接口（保留原内容，移至此处）

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

### 4.4 数据流

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

### 4.5 公开实现与私有兼容边界

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

[Coverage](../../architecture/coverage/external-stubs.yaml)

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

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| P2 | 当前 `getOpenChromeClient()` 和 `getOpenBrowserClient()` 是独立顶级函数，使用体验分散 | 增加统一的客户端工厂抽象，同时保持后端显式选择原则 | 低：新功能为可选，不影响现有调用 | 验证工厂方法可正确创建各后端客户端且类型安全 | S | 已证实（基于代码阅读） |
| P2 | 当前主要使用字符串错误信息和 `errorKind` 字段，错误处理分散 | 定义专门的错误类层次结构，统一错误类型 | 中：需确保新错误类型与现有错误码兼容 | 测试各错误场景均返回正确错误类型且包含足够上下文 | M | 已证实（基于代码阅读） |
| P2 | `openBackends.test.ts` 中 Zavora 测试仍依赖真实 Zavora 包，测试速度慢且可能失败 | 增加更多测试替身（mock/fake），减少对外部包依赖 | 低：仅测试代码变更 | 验证测试可在无 Zavora 包时运行且覆盖关键路径 | S | 已证实（基于代码阅读） |
| P2 | `computer-use-sentinel-apps.ts` 无专门测试覆盖 | 增加 `computer-use-sentinel-apps.ts` 的测试覆盖 | 低：新增测试无副作用 | 验证哨兵应用分类、查询逻辑有测试覆盖 | S | 已证实（基于代码阅读） |
| P2 | 契约文档与实现可能漂移，无自动验证 | 验证契约文档与实现一致性，考虑增加契约测试 | 低：文档与新增测试不影响运行时 | 验证文档与代码匹配，考虑增加简单契约验证测试 | S | 已证实（基于代码阅读） |
| P2 | 无后端健康检查接口，调用时才发现不可用 | 增加健康检查 API，允许调用工具前探测后端可用性和能力 | 中：需设计合理健康检查协议，避免增加负担 | 测试健康检查可正确检测后端状态且不影响性能 | M | 已证实（基于代码阅读） |
| P3 | 工具集和能力硬编码，差异不明确 | 实现能力协商机制，允许客户端查询后端支持的工具集和能力 | 低：可实现为可选查询接口，不影响现有调用 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 当前主要是单例模式，多会话支持有限 | 支持多独立会话，允许隔离不同用户/场景 | 中：需重构单例状态为会话状态 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 坐标模式在启动时冻结，运行时无法切换 | 考虑支持安全的运行时坐标模式切换机制 | 中：需确保切换时状态一致性 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 权限标志仅可增加，无法撤销 | 支持权限标志撤销机制，平衡安全与灵活性 | 中：需考虑权限撤销对已授权操作的影响 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | CDP 端点仅支持硬编码的 loopback | 在安全前提下，支持可配置的 CDP 端点允许列表 | 中：需确保安全边界不被突破 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 后端为编译时选择，扩展需要重新编译 | 考虑插件化后端架构，通过统一 SPI 加载 | 高：架构变更较大，需仔细设计 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 不同后端工具接口有差异，上层需适配 | 提供跨后端工具兼容性层，简化上层调用 | 中：需保持显式选择原则，不隐藏差异 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 可观测性不足，调试外部依赖问题困难 | 增加更多追踪点、指标和结构化日志 | 低：可实现为可选功能，默认最小化 | 验证关键路径有足够日志且不影响性能 | M | 待运行验证 |
| P3 | Bun 下 Chrome CDP 通过 Node 子进程，增加复杂度 | 未来 Bun WebSocket 兼容后，考虑移除 Node 子进程方案 | 低：仅影响 Bun 平台，且依赖上游变化 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 当前仅限本地，无远程支持 | 考虑支持远程 Computer Use 后端，允许多机协作 | 高：涉及网络安全、认证等复杂问题 | 设计阶段验证架构方案 | L | 设计推断 |
| P3 | 外部依赖通信无加密，敏感场景有顾虑 | 考虑为外部依赖通信增加端到端加密支持 | 高：需设计密钥管理、性能平衡等方案 | 设计阶段验证架构方案 | L | 设计推断 |
