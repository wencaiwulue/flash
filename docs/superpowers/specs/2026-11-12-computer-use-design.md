---
id: computer-use
batch: 2
title: Computer Use 浏览器与桌面自动化后端设计
date: 2026-11-12
status: draft
---

# Computer Use 浏览器与桌面自动化后端设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Computer Use 是 Claude Code 提供的桌面与浏览器自动化能力，支持两种后端实现：
- **Native Adapter**：基于 Swift + Rust 原生实现的 macOS 桌面控制
- **Zavora MCP**：基于 MCP 协议的第三方实现

本设计文档描述 Computer Use 的架构、后端抽象、安全机制与设计决策。

核心约束：
- 同一台主机不能由多个会话并发控制，必须通过跨进程锁明确持有者并处理进程死亡、锁损坏和过期恢复。
- 截图、输入、剪贴板和系统组合键具有不同隐私边界；应用授权必须精确匹配，TCC 缺失必须在动作前失败。
- Native Adapter 当前依赖 macOS Swift/Rust 与 CFRunLoop，Zavora 通过 MCP 提供另一后端；统一接口不能掩盖两者能力和清理方式差异。
- 坐标必须保留显示器原点、物理像素与缩放元数据，归一化输入限制在 [0,1]，避免多显示器下误操作。
- 回合自然结束、流式中止和工具中止都必须恢复隐藏应用、注销 ESC、关闭后端并释放锁；单个清理步骤失败不得阻断其余步骤。

## 2. 设计理由与备选方案

### 决策 1：双后端架构（Native vs Zavora）

| 维度 | Native Adapter | Zavora MCP |
|------|----------------|------------|
| 平台 | macOS only | 多平台 |
| 实现 | Swift + Rust | 第三方 MCP |
| ESC 中止 | CGEventTap | Zavora 控制 |
| 截图过滤 | 原生 | 依赖后端 |
| 速度 | 快 | 稍慢 |

**决策理由**：Native 提供最佳 macOS 体验，Zavora 提供跨平台能力和未来扩展。

### 决策 2：文件锁而非内存锁

| 选项 | 优点 | 缺点 |
|------|------|------|
| 文件锁 | 跨进程、持久化 | 需要处理过期 |
| 内存锁 | 简单 | 仅单进程 |

**决策理由**：支持多 Claude Code 会话，防止并发控制冲突。

**替代方案**：命名信号量。未选择，因为文件锁更简单且支持检查锁持有者。

**证据**：`computerUseLock.ts` 的 O_EXCL 创建 + PID 存活检查。

### 决策 3：终端作为 Surrogate Host

| 选项 | 优点 | 缺点 |
|------|------|------|
| Surrogate Host | 终端不被隐藏 | 需要检测终端 Bundle ID |
| 固定 Host | 简单 | 终端可能被隐藏 |

**决策理由**：用户需要看到 Claude Code 的输出，不能被隐藏。

**替代方案**：将终端加入白名单。未选择，因为白名单应用会被截图，可能暴露敏感信息。

**证据**：`executor.ts` 的 `withoutTerminal` 过滤 + `surrogateHost` 传递。

### 决策 4：JSON Lines 协议

| 选项 | 优点 | 缺点 |
|------|------|------|
| JSON Lines | 简单、人类可读、流式 | 二进制效率低 |
| Protocol Buffers | 高效 | 需要编译 schema |
| IPC Channel | 原生 | Node.js 侧复杂 |

**决策理由**：Native Helper 调用频率低，JSON 足够，开发效率优先。

**证据**：`nativeHelper.ts` 的 `NativeHelperClient` 实现。

### 决策 5：drainRunLoop 包装

| 选项 | 优点 | 缺点 |
|------|------|------|
| drainRunLoop | 窗口事件正常处理 | 30s 超时限制 |
| 不包装 | 简单 | 窗口闪烁、事件堆积 |

**决策理由**：Electron 持续运行 CFRunLoop，CLI 需要手动泵。

**替代方案**：使用 N-API 主线程回调。未选择，因为复杂度高，当前方案足够。

**证据**：`drainRunLoop.ts` + `executor.ts` 中所有 Swift 调用的包装。

## 3. 目标与非目标

### 目标

- 以 `ComputerUseBackend` 统一 Native 与 Zavora 的工具枚举、调用分发、AbortSignal 和关闭语义。
- 以 `ComputerExecutor`、`ComputerUseHostAdapter` 和 `ComputerUseSessionContext` 隔离平台动作、宿主能力与会话状态。
- 提供截图、缩放、输入、剪贴板、应用管理、显示器选择及应用隐藏能力，并记录坐标转换所需元数据。
- 在每次动作前执行 OS 权限、应用授权、子门控和会话锁检查，提供用户可按 ESC 中止的控制路径。
- 动态加载原生模块并限制工具 schema，非 Computer Use 回合不承担相关加载成本。

### 非目标

- 不在本文实现 Swift/Rust 内部算法或第三方 Zavora 服务端，也不承诺 Native Adapter 跨平台运行。
- 不允许多会话同时控制桌面，不把内存锁当作跨进程互斥方案。
- 不将应用白名单等同于截图安全保证；终端 Surrogate Host 与截图可见性必须分别处理。
- 不在后台会话结束后保留隐藏应用、热键或文件锁，不在线验证真实桌面环境之外的服务能力。

## 4. 架构、模块与数据流

### 4.1 后端抽象模块

#### 真实入口签名/关键类型

```typescript
// src/utils/computerUse/hostAdapter.ts
function getComputerUseHostAdapter(): ComputerUseHostAdapter

type ComputerUseHostAdapter = {
  serverName: string;
  logger: Logger;
  executor: ComputerExecutor;
  ensureOsPermissions(): Promise<OsPermissionState>;
  isDisabled(): boolean;
  getSubGates(): CuSubGates;
  getAutoUnhideEnabled(): boolean;
  cropRawPatch(...args: unknown[]): Buffer | null;
};

type OsPermissionState =
  | { granted: true }
  | { granted: false; accessibility: boolean; screenRecording: boolean };
```

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| 无（单例） | - | 模块级缓存 `cached: ComputerUseHostAdapter | undefined` |

| 输出 | 类型 | 说明 |
|------|------|------|
| hostAdapter.serverName | string | 恒为 "computer-use" |
| hostAdapter.logger | Logger | Debug 日志适配器 |
| hostAdapter.executor | ComputerExecutor | CLI 执行器实例 |

#### 会话/显示/锁状态

- **会话状态**：无状态单例，与 `sessionId` 无关
- **显示状态**：通过 `executor` 间接访问
- **锁状态**：通过 `SessionContext` 接口访问，不在此模块

#### 准备/执行/中止/清理流程

- **准备**：首次调用 `getComputerUseHostAdapter()` 时创建单例
- **执行**：每次工具调用通过 `wrapper.tsx` 转发到 `hostAdapter`
- **中止**：通过传入的 `AbortSignal` 向上传播
- **清理**：无内部清理，由 `cleanupComputerUseAfterTurn` 负责

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| `getChicagoEnabled()` 为 false | `isDisabled()` 返回 true，MCP 服务器不可用 |
| TCC 权限缺失 | `ensureOsPermissions()` 返回 `{granted: false, accessibility, screenRecording}` | 结构化错误向上传播 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| 单例 vs 每次创建 | 选择单例，避免重复加载 Swift Helper |
| `cropRawPatch` 返回 null | 像素验证当前禁用，留作扩展 |

#### 源码测试证据

- **源码**：`src/utils/computerUse/hostAdapter.ts`
- **测试**：`tests/computerUseBackends.test.ts` 覆盖 `getSubGates()`、`isDisabled()`
- **关联**：`packages/desktop/computer-use-mcp` 提供类型契约

---

### 4.2 执行器模块

#### 真实入口签名/关键类型

```typescript
// src/utils/computerUse/executor.ts
function createCliExecutor(opts: {
  getMouseAnimationEnabled: () => boolean;
  getHideBeforeActionEnabled: () => boolean;
  input?: ReturnType<typeof requireComputerUseInput>;
  swift?: ReturnType<typeof requireComputerUseSwift>;
}): ComputerExecutor

export async function unhideComputerUseApps(
  bundleIds: readonly string[]
): Promise<void>

// 关键内部函数
function moveAndSettle(input: Input, x: number, y: number): Promise<void>
function releasePressed(input: Input, pressed: string[]): Promise<void>
async function withModifiers<T>(
  input: Input, mods: string[], fn: () => Promise<T>
): Promise<T>
async function typeViaClipboard(input: Input, text: string): Promise<void>
async function animatedMove(
  input: Input, targetX: number, targetY: number, mouseAnimationEnabled: boolean
): Promise<void>
```

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| opts.getMouseAnimationEnabled | () => boolean | 子门控回调 |
| opts.getHideBeforeActionEnabled | () => boolean | 子门控回调 |
| opts.input | optional | 注入的输入模块（测试用） |
| opts.swift | optional | 注入的 Swift 模块（测试用） |

| 输出 | 类型 | 说明 |
|------|------|------|
| executor.capabilities | { screenshotFiltering: 'native', platform: 'darwin', hostBundleId: string } | 能力声明 |
| executor.screenshot() | Promise<ScreenshotResult> | 截图，已缩放到 API 目标尺寸 |
| executor.prepareForAction() | Promise<string[]> | 返回被隐藏的 bundleId 列表 |

#### 会话/显示/锁状态

- **会话状态**：通过 `terminalBundleId` 检测 Surrogate Host
- **显示状态**：`resolvePrepareCapture` 记录 `displayResolvedForApps`
- **锁状态**：不直接访问锁，由上层协调

#### 坐标缩放

```typescript
// 坐标转换：Logical → Physical → API Target
function computeTargetDims(
  logicalW: number, logicalH: number, scaleFactor: number
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor);
  const physH = Math.round(logicalH * scaleFactor);
  return targetImageSize(physW, physH, API_RESIZE_PARAMS);
}
```

- **API_RESIZE_PARAMS**：最大 1568x1568，总像素 ≤ 1.15M
- **Native 坐标**：带显示原点偏移 `(origin_x, origin_y)`
- **Normalized**：[0,1] 归一化，原点左上角

#### Surrogate Host

```typescript
// src/utils/computerUse/common.ts
const CLI_HOST_BUNDLE_ID = 'com.anthropic.claude-code.cli-no-window'
const surrogateHost = terminalBundleId ?? CLI_HOST_BUNDLE_ID

function getTerminalBundleId(): string | null {
  const cfBundleId = process.env.__CFBundleIdentifier
  if (cfBundleId) return cfBundleId
  return TERMINAL_BUNDLE_ID_FALLBACK[env.terminal ?? ''] ?? null
}
```

- **豁免隐藏**：`prepareDisplay(allowlist, surrogateHost, ...)`
- **豁免截图**：`withoutTerminal(allowed)` 过滤终端 bundleId
- **检测方式**：优先 `__CFBundleIdentifier`，次查表 fallback

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **准备** | `prepareForAction()` → `cu.apps.prepareDisplay()` + `drainRunLoop` 包装 |
| **执行** | 鼠标键盘操作通过 `drainRunLoop()` 包装，确保 CFRunLoop 泵动 |
| **中止** | `AbortSignal` 由 `drainRunLoop` 转发到 `NativeHelperClient.request()` |
| **清理** | `unhideComputerUseApps()` 单独导出，供 `cleanup.ts` 调用 |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| 输入序列部分失败 | `holdKey()`/`drag()` 中途抛错 | `releasePressed()` 逆序释放已按下键/修饰键，鼠标按钮最终释放 |
| `typeViaClipboard` 回写验证失败 | `pbpaste` 结果不一致 | 不按 Cmd+V，抛错，`finally` 恢复原始剪贴板 |
| `unhideComputerUseApps()` 超时/失败 | 由 `cleanup.ts` 5s 超时处理 | 记录日志，继续执行后续清理 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| `moveAndSettle` 50ms vs 更长 | 选择 50ms，平衡响应性与 HID 事件稳定时间 |
| `animatedMove` 60fps ease-out-cubic | 选择缓动，避免拖拽跳变；最长 0.5s |
| `typeViaClipboard` 读回验证 vs 不验证 | 选择验证，避免粘贴错误内容 |
| `typeViaClipboard` 恢复前 sleep 100ms | 选择 sleep，避免目标应用尚未粘贴我们就恢复 |
| CLI 无窗口 | 不做 `setIgnoreMouseEvents` |

#### 源码测试证据

- **源码**：`src/utils/computerUse/executor.ts`
- **测试**：`tests/computerUseExecutor.test.ts` 覆盖 `holdKey` 释放、`drag` 释放、`typeViaClipboard` 回写验证
- **证据**：第 4.2 节 `computeTargetDims` 坐标缩放

---

### 4.3 Native Helper 通信模块

#### 真实入口签名/关键类型

```typescript
// src/utils/computerUse/nativeHelper.ts
export type ComputerUseHelper = {
  request<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T>;
  onEvent(event: 'escape', listener: () => void): () => void;
  close(): Promise<void>;
};

class NativeHelperClient implements ComputerUseHelper {
  constructor(child: ChildProcessWithoutNullStreams);
}

export function getComputerUseHelper(): ComputerUseHelper;
export async function closeComputerUseHelper(): Promise<void>;
```

#### JSON Lines 协议

```
// 请求线
{"id":"<uuid>","method":"<method>","params":<object>}\n

// 响应线
{"id":"<uuid>","ok":true,"result":<value>}\n
{"id":"<uuid>","ok":false,"error":"<message>"}\n

// 事件线
{"event":"escape"}\n
```

- **每线一个 JSON**：无嵌套帧
- **超时**：默认 30s，可配置 `timeoutMs`
- **stderr**：仅诊断，不解析，不记录（避免敏感桌面数据）

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| method | string | Swift 方法名，如 `screenshot.captureExcluding` |
| params | Record<string, unknown> | 方法参数 |
| options.signal | AbortSignal? | 中止信号 |
| options.timeoutMs | number? | 超时，默认 30000 |

| 输出 | 类型 | 说明 |
|------|------|------|
| result | T | 反序列化的结果 |
| event: 'escape' | 事件 | 用户按 ESC 时触发 |

#### 会话/显示/锁状态

- **会话状态**：`getComputerUseHelper()` 单例缓存
- **显示状态**：不直接访问，由 Swift 侧处理
- **锁状态**：不直接访问，由上层协调

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **准备** | `getComputerUseHelper()` 首次调用时 `spawn()` Swift 二进制 |
| **执行** | `request()` → 写 stdin JSON Line → 读 stdout JSON Line |
| **中止** | `signal?.addEventListener('abort')` → `reject(abortError())` |
| **清理** | `close()` → `stdin.end()` → 250ms 后 `SIGTERM` |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| `AbortError` | `options.signal` 触发 | 清理 pending map、timer、监听器 |
| 超时 | `options.timeoutMs` 到期 | 同上，抛错含方法名 |
| Helper 意外退出 | `child.on('exit')` | `failAll()` 所有 pending 请求 |
| stderr 数据 | 任意 | 静默消费，不记录（避免敏感桌面数据） |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| JSON Lines vs Protocol Buffers | 选择 JSON Lines，人类可读，无需预编译 |
| 30s 默认超时 | 平衡慢速操作与用户体验 |
| 250ms SIGTERM 延迟 | 给 Swift 侧优雅退出机会 |

#### 源码测试证据

- **源码**：`src/utils/computerUse/nativeHelper.ts`
- **测试**：`tests/computerUseNativeHelper.test.ts` 覆盖 JSON Lines 协议、事件监听、超时与 AbortSignal
- **证据**：第 4.3 节 `NativeHelperClient`

---

### 4.4 drainRunLoop 模块

#### 真实入口签名/关键类型

```typescript
// src/utils/computerUse/drainRunLoop.ts
export async function drainRunLoop<T>(
  fn: () => Promise<T>,
  cu: ReturnType<typeof requireComputerUseSwift> = requireComputerUseSwift()
): Promise<T>;

// 内部状态
let pump: ReturnType<typeof setInterval> | undefined
let pending = 0
let drainInFlight = false
const TIMEOUT_MS = 30_000
```

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| fn | () => Promise<T> | 要执行的 Swift/NAPI 函数 |
| cu | optional | 注入的 Swift 模块（测试用） |

| 输出 | 类型 | 说明 |
|------|------|------|
| fn() 的结果 | T | 透传返回值 |

#### 会话/显示/锁状态

- **会话状态**：进程级共享 `pump`、`pending` 计数器
- **显示状态**：不直接访问
- **锁状态**：不直接访问

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **准备** | `retain()` → `pending++` → 启动 `setInterval(drainTick, 1, cu)` |
| **执行** | `Promise.race([fn(), timeout])`，同时泵动 |
| **中止** | 超时或 AbortSignal 触发，孤儿 Promise 附加 `.catch(() => {})` 避免 `unhandledRejection` |
| **清理** | `release()` → `pending--` → `pending <= 0` 时 clearInterval |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| 30s 超时 | `TIMEOUT_MS` 到期 | 抛错 `computer-use native call exceeded 30000ms` |
| `drainTick()` 抛错 | `_drainMainRunLoop()` 失败 | 静默 `.catch()`，不掩盖实际 `fn()` 错误 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| setInterval 1ms vs 更长 | 选择 1ms，快速响应 CFRunLoop 事件 |
| 30s 超时 vs 无超时 | 选择 30s，避免挂起 CLI |
| 孤儿 Promise 附加 catch | 避免 `unhandledRejection` |

#### 源码测试证据

- **源码**：`src/utils/computerUse/drainRunLoop.ts`
- **测试**：`tests/computerUseExecutor.test.ts` 间接覆盖
- **证据**：第 4.4 节 `drainRunLoop` 包装所有 Swift 调用

---

### 4.5 文件锁模块

#### 真实入口签名/关键类型

```typescript
// src/utils/computerUse/computerUseLock.ts
type ComputerUseLock = {
  readonly sessionId: string;
  readonly pid: number;
  readonly acquiredAt: number;
};

export type AcquireResult =
  | { readonly kind: 'acquired'; readonly fresh: boolean }
  | { readonly kind: 'blocked'; readonly by: string };

export type CheckResult =
  | { readonly kind: 'free' }
  | { readonly kind: 'held_by_self' }
  | { readonly kind: 'blocked'; readonly by: string };

export async function checkComputerUseLock(): Promise<CheckResult>;
export function isLockHeldLocally(): boolean;
export async function tryAcquireComputerUseLock(): Promise<AcquireResult>;
export async function releaseComputerUseLock(): Promise<boolean>;
```

#### O_EXCL 锁与 PID 复用

```typescript
// 原子创建（O_EXCL）
async function tryCreateExclusive(lock: ComputerUseLock): Promise<boolean> {
  try {
    await writeFile(getLockPath(), jsonStringify(lock), { flag: 'wx' });
    return true;
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') return false;
    throw e;
  }
}

// PID 存活探测
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- **O_EXCL**：`flag: 'wx'` 保证仅一个进程创建成功
- **PID 复用风险**：进程死亡后，锁文件仍存在 → 同 PID 新进程被误判为存活 → 极小概率可接受
- **锁路径**：`join(getClaudeConfigHomeDir(), 'computer-use.lock')`

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| 无（状态从全局获取） | - | `sessionId` 来自 `getSessionId()`、`pid` 来自 `process.pid` |

| 输出 | 类型 | 说明 |
|------|------|------|
| `AcquireResult` | Union | 区分 `acquired`/`blocked`；`acquired` 分 `fresh: boolean` 用于决定是否发 enter 通知 |
| `CheckResult` | Union | `defersLockAcquire` 工具用（如 `request_access`） |

#### 会话/显示/锁状态

- **会话状态**：`unregisterCleanup` 存在表示本地持有锁（零 syscall 检查）
- **显示状态**：不直接访问
- **锁状态**：
  - `sessionId`、`pid`、`acquiredAt` 写入锁文件
  - `isLockHeldLocally()` 零 syscall 快速路径
  - `registerLockCleanup()` 注册进程退出清理

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **检查** | `checkComputerUseLock()` → 读锁 → 检查 PID 存活 → 可恢复则 `unlink` |
| **获取** | `tryAcquireComputerUseLock()` → O_EXCL 创建 → 若存在则检查归属/PID → 可恢复则 `unlink` 重试一次 → 注册 shutdown cleanup |
| **中止** | 不提供主动放弃，仅回合结束/进程退出释放 |
| **清理** | `releaseComputerUseLock()` → `unregisterCleanup` → `unlink` 锁文件（仅自己持有） |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| 锁文件损坏/不可解析 | `jsonParse` 失败 | 视为 stale，`unlink` 后重试 |
| `unlink` 失败 | 权限/竞态 | 静默 `catch(() => {})`，不阻塞重试/退出 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| 文件锁 vs 内存锁/命名信号量 | 选择文件锁，跨进程，持久化，可检查持有者 |
| 重试一次 vs 无限重试 | 选择一次，避免 livelock |
| 零 syscall `isLockHeldLocally()` | 避免非 CU 回合碰磁盘 |

#### 源码测试证据

- **源码**：`src/utils/computerUse/computerUseLock.ts`
- **测试**：`tests/computerUseBackends.test.ts` 覆盖 acquire/release/check、stale recovery、reentrant
- **证据**：第 4.5 节 O_EXCL 与 PID 存活检查

---

### 4.6 ESC 热键模块

#### 真实入口签名/关键类型

```typescript
// src/utils/computerUse/escHotkey.ts
export async function registerEscHotkey(onEscape: () => void): Promise<boolean>;
export async function unregisterEscHotkey(): Promise<void>;
export async function notifyExpectedEscape(): Promise<void>;

// 内部状态
let registered = false
```

#### CGEventTap ESC

- **注册**：`cu.hotkey.registerEscape(onEscape)` → Swift 侧 `CGEvent.tapCreate` 监听系统 ESC
- **消费**：注册期间 ESC 被全局消费（PI 防御：注入的 Escape 无法关闭对话框）
- **豁免**：`notifyExpectedEscape()` → Swift 侧 100ms 窗口，此窗口内的 ESC 不触发 abort
- **失败降级**：`registerEscape` 返回 `false` → 记录警告，CU 仍可用，只是没有 ESC abort

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| onEscape | () => void | ESC 回调，通常是 `abortController.abort()` |

| 输出 | 类型 | 说明 |
|------|------|------|
| `registerEscHotkey` | Promise<boolean> | `false` 表示 CGEventTap 创建失败（通常缺少辅助权限） |

#### 会话/显示/锁状态

- **会话状态**：`registered` 布尔表示本进程已注册
- **显示状态**：不直接访问
- **锁状态**：不直接访问

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **准备** | `registerEscHotkey()` → `cu.hotkey.registerEscape()` → 设 `registered = true` |
| **执行** | 用户按 ESC → Swift 侧 tap 回调 → 触发 `onEscape()` |
| **中止** | 模型合成 ESC → `key("escape")`/`holdKey(["escape"])` 内调用 `notifyExpectedEscape()` |
| **清理** | `unregisterEscHotkey()` → `cu.hotkey.unregister()` → 设 `registered = false` |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| `registerEscape` 返回 `false` | 缺少辅助权限或 tapCreate 失败 | 记录警告，CU 继续工作（无 ESC abort） |
| `unregister` 抛错 | NAPI 异常 | `try/finally` 确保 `registered` 仍设 `false`，不阻塞锁释放 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| 全局消费 ESC | PI 防御：注入的 Escape 不能关闭对话框 |
| 100ms 豁免窗口 | 平衡模型合成 Escape 与真实用户 Escape |

#### 源码测试证据

- **源码**：`src/utils/computerUse/escHotkey.ts`
- **测试**：`tests/computerUseBackends.test.ts` 间接覆盖
- **证据**：第 4.6 节 `notifyExpectedEscape` 模型 ESC 豁免

---

### 4.7 应用隐藏与显示解析模块

#### 真实入口签名/关键类型

```typescript
// executor.ts 内
async resolvePrepareCapture(opts: {
  allowedBundleIds: string[];
  preferredDisplayId?: number;
  autoResolve: boolean;
  doHide?: boolean;
}): Promise<ResolvePrepareCaptureResult>;

async prepareForAction(
  allowlistBundleIds: string[],
  displayId?: number
): Promise<string[]>;

async previewHideSet(
  allowlistBundleIds: string[],
  displayId?: number
): Promise<Array<{ bundleId: string; displayName: string }>>;

// common.ts
export const CLI_HOST_BUNDLE_ID = 'com.anthropic.claude-code.cli-no-window';
export function getTerminalBundleId(): string | null;
```

#### Sentinel Apps

- **定义位置**：`src/external-stubs/computer-use-sentinel-apps.ts`
- **内容**：Terminal、Finder、System Settings 等敏感应用
- **用途**：权限对话框特殊提示（如 "您确定要授权 Claude 控制终端吗？"）

#### 显示解析

```typescript
// autoResolve 流程
1. cu.apps.findWindowDisplays(allowedBundleIds)
2. 找到目标应用窗口所在的显示器
3. 未找到时回退到主显示器
4. 记录 displayResolvedForApps（避免反复解析）
```

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| allowlistBundleIds | string[] | 允许的应用 bundleId 列表 |
| autoResolve | boolean | 是否自动解析显示器 |
| doHide | boolean? | 是否实际隐藏（预览用） |

| 输出 | 类型 | 说明 |
|------|------|------|
| hidden | string[] | 被隐藏的 bundleId 列表 |
| activated | string | undefined | 被激活的应用 bundleId |

#### 会话/显示/锁状态

- **会话状态**：`hiddenDuringTurn` 存入 `appState.computerUseMcpState`
- **显示状态**：`displayResolvedForApps` 存入 session context
- **锁状态**：不直接访问

#### unhide 超时与失败降级

```typescript
// cleanup.ts
const UNHIDE_TIMEOUT_MS = 5000;

const unhide = unhideComputerUseApps([...hidden]).catch(...);
const timeout = withResolvers<void>();
const timer = setTimeout(timeout.resolve, UNHIDE_TIMEOUT_MS);
await Promise.race([unhide, timeout.promise]).finally(() => clearTimeout(timer));
```

- **超时 5s**：`unhide` 超时时不等待，继续后续清理（锁释放、ESC 注销）
- **失败降级**：`unhide` 抛错时仅记录日志，不阻塞

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **准备** | `resolvePrepareCapture()` / `prepareForAction()` → `drainRunLoop` 包装 |
| **执行** | Swift 侧 `prepareDisplay()` 隐藏非白名单应用 |
| **中止** | `drainRunLoop` 超时/Abort 传播 |
| **清理** | `cleanupComputerUseAfterTurn()` 调用 `unhideComputerUseApps()`，5s 超时 |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| `prepareDisplay` 抛错 | 窗口操作失败 | 记录警告，继续动作执行 |
| `unhide` 超时/失败 | 5s 未完成或抛错 | 记录日志，继续释放锁/注销热键 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| `prepareDisplay` `drainRunLoop` 包装 | 避免窗口事件堆积/闪烁 |
| 5s unhide 超时 | 避免 abort 路径被挂起 |
| Swift `unhide` 继续后台运行 | 不阻塞 CLI，即使超时 |
| 终端 Surrogate Host | 终端不被隐藏，不被截图 |

#### 源码测试证据

- **源码**：`src/utils/computerUse/executor.ts`（`prepareForAction`/`resolvePrepareCapture`）、`cleanup.ts`（unhide 超时）
- **测试**：`tests/computerUseBackends.test.ts` 覆盖 `prepareForAction`、`hiddenDuringTurn` 状态管理
- **证据**：第 4.7 节 Surrogate Host、Sentinel Apps、显示解析

---

### 4.8 权限隐私模块

#### 真实入口签名/关键类型

```typescript
// hostAdapter.ts
ensureOsPermissions(): Promise<OsPermissionState>;

// 来自 external-stubs
type CuGrantFlags = {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  systemKeyCombos: boolean;
};

type CuSubGates = {
  pixelValidation: boolean;
  clipboardPasteMultiline: boolean;
  mouseAnimation: boolean;
  hideBeforeAction: boolean;
  autoTargetDisplay: boolean;
  clipboardGuard: boolean;
};
```

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| 无（权限检查来自 Swift 侧） | - | `cu.tcc.checkAccessibility()`、`cu.tcc.checkScreenRecording()` |

| 输出 | 类型 | 说明 |
|------|------|------|
| `OsPermissionState` | Union | `{granted: true}` 或带 accessibility/screenRecording 布尔 |

#### 会话/显示/锁状态

- **会话状态**：`allowedApps`、`grantFlags`、`userDeniedBundleIds` 存入 session context
- **显示状态**：不直接访问
- **锁状态**：不直接访问

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **准备** | `ensureOsPermissions()` → `cu.tcc.checkAccessibility()` + `checkScreenRecording()` |
| **执行** | 工具调用前 `def checkPermissions` |
| **中止** | 不适用 |
| **清理** | 不适用 |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| `tcc_denied` | Accessibility 或 Screen Recording 缺失 | 结构化错误向上传播 |
| 目标应用未授权 | 精确 bundleId 检查失败 | 拒绝执行 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| 精确 bundleId 匹配 | 非前缀，避免误授权 |
| 剪贴板通过 pbpaste/pbcopy | 无 Electron clipboard，CLI 适配 |
| 子门控细粒度控制 | 各功能可单独关 |

#### 源码测试证据

- **源码**：`src/utils/computerUse/hostAdapter.ts`（`ensureOsPermissions`）、`src/external-stubs/computer-use-types.ts`
- **测试**：`tests/computerUseBackends.test.ts` 覆盖 TCC 检查、精确授权、子门控
- **证据**：第 4.8 节权限标志与子门控

---

### 4.9 回合清理模块

#### 真实入口签名/关键类型

```typescript
// src/utils/computerUse/cleanup.ts
export async function cleanupComputerUseAfterTurn(
  ctx: Pick<
    ToolUseContext,
    'getAppState' | 'setAppState' | 'sendOSNotification'
  >
): Promise<void>;

const UNHIDE_TIMEOUT_MS = 5000;
```

#### 输入输出

| 输入 | 类型 | 说明 |
|------|------|------|
| ctx.getAppState | () => AppState | 读取 `hiddenDuringTurn` |
| ctx.setAppState | (updater) => void | 清空 `hiddenDuringTurn` |
| ctx.sendOSNotification | (notification) => void | 发 exit 通知 |

| 输出 | 类型 | 说明 |
|------|------|------|
| 无 | - | 仅副作用 |

#### 会话/显示/锁状态

- **会话状态**：读取/清空 `appState.computerUseMcpState.hiddenDuringTurn`
- **显示状态**：不直接访问
- **锁状态**：检查 `isLockHeldLocally()` 零 syscall 快速路径

#### 准备/执行/中止/清理流程

| 阶段 | 流程 |
|------|------|
| **调用位置** | 1. 自然回合结束（stopHooks.ts）；2. 流式中止（query.ts）；3. 工具执行中止（query.ts） |
| **执行** | 1. `unhideComputerUseApps()` + 5s 超时；2. Zavora backend `close()`；3. `unregisterEscHotkey()`；4. `releaseComputerUseLock()` |
| **中止** | 不适用（本身就是中止处理） |
| **幂等** | 各步骤相互隔离，一步失败不影响其余 |

#### 错误与安全

| 错误类型 | 触发条件 | 处理 |
|----------|----------|------|
| `unhide` 超时/失败 | `cleanupComputerUseAfterTurn` 继续 |
| `closeComputerUseBackend` 失败 | 记录日志，继续后续清理 |
| `unregisterEscHotkey` 失败 | `try/catch` 吞错，继续释放锁 |
| 各步骤隔离 | 一步失败不阻塞其余 |

#### 设计取舍/备选

| 选项 | 取舍 |
|------|------|
| 三调用点归一 | 统一自然结束与中止清理路径 |
| 零 syscall `isLockHeldLocally()` 预检 | 非 CU 回合不碰磁盘 |
| 动态 import | 非 CU 回合不加载 native 模块 |
| 各步骤隔离 | unhide 失败不阻塞锁释放 |

#### 源码测试证据

- **源码**：`src/utils/computerUse/cleanup.ts`
- **测试**：`tests/computerUseBackends.test.ts` 覆盖三调用点、幂等清理
- **证据**：第 4.9 节三调用点与隔离清理

---

## 5. 失败语义与工程取舍

### 5.1 回合结束清理

`cleanupComputerUseAfterTurn` 在三个位置调用：
1. 自然回合结束（`stopHooks.ts`）
2. 流式期间中止（`query.ts`）
3. 工具执行期间中止（`query.ts`）

清理步骤：
1. **Unhide**：恢复隐藏的应用，5s 超时
2. **Close Backend**：Zavora 后端关闭
3. **Unregister Hotkey**：取消注册 ESC 热键
4. **Release Lock**：释放文件锁

### 5.2 退出清理

`registerLockCleanup` 注册进程退出时的清理，确保锁被释放。

### 5.3 损坏恢复

- 锁文件解析失败视为过期
- PID 不存在（进程已死）视为过期
- 即使 unhide 失败也继续释放锁

### 5.4 失败传播与工程取舍

| 触发条件 | 语义与清理 | 调用方可见结果 |
|----------|----------|------------|
| Accessibility 或 Screen Recording 缺失 | 在执行截图/输入前结束，不尝试绕过 TCC | 返回结构化 `tcc_denied` |
| 目标应用未授权或指针下应用未授权 | 精确 bundle ID 检查在 prepare/input 前拒绝 | 返回权限工具错误，不执行桌面动作 |
| Native Helper 请求超过 30s 或收到 abort | 请求取消并向上传播；Escape 用户事件中止当前控制器 | 结构化工具错误或保留 Abort 语义 |
| 输入序列中途失败 | executor 逆序释放已成功按下的键/修饰键，drag 释放鼠标按钮 | 原始错误向上传播，尽量避免卡键 |
| 锁文件损坏、PID 死亡或锁过期 | 视为可回收并删除重试；活锁持有者不被抢占 | 获取锁或返回持锁提示 |
| unhide、后端 close 或热键清理失败 | 各清理步骤相互隔离，仍继续释放文件锁 | 记录清理错误，回合不被清理异常二次阻断 |

工程取舍：文件锁带来过期判断和异常清理成本，但提供跨进程互斥；JSON Lines 牺牲二进制效率换取可调试协议；`drainRunLoop` 增加 30s 调用边界，却避免 CLI 中窗口事件堆积；严格 schema 与精确授权减少误操作面，也要求后端能力演进时同步更新类型和验证。

## 6. 现状验收标准

1. 分别选择 Native 和 Zavora 后端，工具枚举必须来自各自 catalog/schema；Native 路径不得隐式依赖 Zavora，结构化错误和 `isError` 必须在 wrapper 中保留。
2. 给定缺少任一 TCC 权限组合，Native 必须在截图或输入前返回 `tcc_denied`；未授权目标、大小写变体和指针下未授权应用均不得触发 prepare 或输入。
3. 给定多显示器截图，normalized 与 pixel 坐标转换必须保留显示原点，截图结果必须包含真实图片 block 并记录尺寸、缩放和显示元数据；`targetImageSize` 同时遵守宽高与总像素上限。
4. 给定 `holdKey`、带修饰键 click 或 drag 中途失败，必须只释放已成功按下的键并按逆序清理，鼠标按钮最终释放；错误不得被清理异常吞掉。
5. 给定用户 ESC 与模型合成 ESC，前者必须 abort，后者经 `notifyExpectedEscape` 豁免；热键注册失败和注销路径不得泄漏监听器。
6. 给定自然结束、流式中止和工具中止三种路径，必须依次尝试 unhide、后端关闭、热键注销和锁释放；即使 unhide 失败，锁仍须释放。
7. 给定损坏锁文件、死亡 PID 和活跃其他会话，前两者可按过期恢复，最后一种必须拒绝并发控制并报告持有者。

## 7. 代码与测试证据

| 设计陈述 | 代码证据 | 测试证据 |
|----------|----------|----------|
| 双后端、坐标、授权、TCC、截图与结构化错误 | `src/utils/computerUse/hostAdapter.ts`、`mcpServer.ts`、`wrapper.tsx`、`executor.ts` | `tests/computerUseBackends.test.ts` 覆盖 Native/Zavora 工厂、显示原点、全部 TCC 组合、精确授权、独立剪贴板/组合键门控、截图元数据和 Abort 边界；`computerUseWrapper.test.ts` 覆盖结果转换 |
| Native Helper JSON Lines 与输入/截图转发 | `nativeHelper.ts`、`swiftLoader.ts`、`inputLoader.ts`、`drainRunLoop.ts` | `tests/computerUseNativeHelper.test.ts` 覆盖平台检测、鼠标键盘 Unicode、Swift 方法转发、热键事件及响应/事件/abort/close 协议 |
| 输入失败清理与有界 runloop drain | `executor.ts`、`drainRunLoop.ts` | `tests/computerUseExecutor.test.ts` 覆盖 holdKey 部分失败、逆序释放、drag 失败释放、click 修饰键清理及并发 capture |
| 锁、ESC 与回合清理 | `computerUseLock.ts`、`escHotkey.ts`、`cleanup.ts` | 相关单元和共享测试提供局部证据；真实多进程锁竞争、用户 ESC 与 macOS 桌面 unhide 仍需独立桌面环境验收 |
| 原生构建与敏感应用边界 | `native/OpenComputerUseHelper.swift`、`native/build.sh`、`appNames.ts` | `computerUseBackends.test.ts` 验证 sentinel catalog 和严格 schema；Swift 二进制真实 TCC 行为不能由 mock 测试替代 |

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/computer-use.yaml)

| 文件分组 | 主拥有职责 | 相关子系统与边界 |
|----------|----------|----------------|
| `src/utils/computerUse/executor.ts`、`hostAdapter.ts`、`mcpServer.ts` | 平台无关执行、宿主适配与 MCP 工具服务 | SessionContext 连接 AppState、权限对话框与会话锁 |
| `nativeHelper.ts`、`swiftLoader.ts`、`inputLoader.ts`、`drainRunLoop.ts` | Native 动态加载、JSON Lines、输入与 runloop | Swift/Rust 实现位于 native helper，不由 TypeScript 层复制 |
| `computerUseLock.ts`、`escHotkey.ts`、`cleanup.ts` | 互斥、用户中止和资源释放 | query/stopHooks 提供三个回合结束调用点 |
| `wrapper.tsx`、`toolRendering.tsx`、`gates.ts`、`common.ts`、`setup.ts` | 结果转换、渲染、门控、共享类型与设置 | 外部 `computer-use-*` stubs 定义可替换后端和类型边界 |
| `native/OpenComputerUseHelper.swift`、`native/build.sh` | macOS 原生截图、输入、权限与应用控制 | 需要 macOS/TCC 实机验证 |

测试文件由 `tests/computerUseBackends.test.ts`、`computerUseExecutor.test.ts`、`computerUseNativeHelper.test.ts` 和 `computerUseWrapper.test.ts` 覆盖。外部存根包括 `computer-use-types.ts`、`computer-use-native.ts`、`computer-use-mcp.ts`、`computer-use-swift.ts`、`computer-use-input.ts` 与 `computer-use-sentinel-apps.ts`。

## 9. 改进建议

1. **真实桌面验收分层**：将 mock 已覆盖的协议/权限不变量与 macOS TCC、窗口隐藏、ESC、剪贴板恢复和多显示器实机测试分开报告，避免以单元测试冒充桌面可用性。
2. **锁恢复可观测性**：记录锁过期、损坏解析和 PID 回收原因，并提供只读诊断命令，减少异常退出后的排查成本。
3. **清理结果聚合**：为 unhide、close、hotkey、lock 四步分别记录结果，在锁释放成功但应用恢复失败时给出明确警告。
4. **后端能力协商**：将 Native/Zavora 的 ESC、截图过滤、平台与输入能力显式暴露为 capability，而不是依赖调用方假设。
5. **取消与超时测试**：补充 30s helper 超时、runloop 取消、锁竞争和重复 cleanup 的故障注入，验证幂等和无资源泄漏。
