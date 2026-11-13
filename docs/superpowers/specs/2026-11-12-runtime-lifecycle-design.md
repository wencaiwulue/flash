---
id: runtime-lifecycle
batch: 7
title: Runtime Lifecycle 取消、清理与进程退出设计
date: 2026-11-12
status: draft
---

# Runtime Lifecycle 取消、清理与进程退出设计

## 1. 问题与约束

Runtime Lifecycle 是 Claude Code 的底层运行时管理系统，面临的约束包括：

- 需要提供内存安全的取消信号传递机制
- 保证进程退出时终端状态一致性
- 支持跨平台进程存活检测
- 实现可观测的活动时间统计
- 处理孤儿进程检测（macOS 终端关闭撤销 TTY 文件描述符而非发送 SIGHUP）
- 处理 Bun 信号处理 bug
- 避免内存泄漏（AbortController 层次结构、定时器等）
- 提供幂等的清理注册机制
- 实现旧文件定期清理
- 支持 SDK 模式下的空闲超时自动退出
- 跟踪用户与 CLI 活动并分别统计活跃时间
- 处理未捕获异常与 Promise 拒绝

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 使用 WeakRef 实现父子取消层次 | `createChildAbortController` 使用 WeakRef 绑定父子，子 abort 时自动清理父监听器 | 父不持有子，子不持有父，避免内存泄漏；显式 `unlink()` 需要用户代码配合，容易遗漏；FinalizationRegistry 执行不确定 | 显式 `unlink()`/`destroy()` API（需要用户配合，容易遗漏）、FinalizationRegistry（执行不确定） | 需要 ES2021；WeakRef 在 GC 前仍保持引用一段时间（不可预测） | `createChildAbortController` 实现与注释 |
| 不使用 AbortSignal.timeout() | 使用 setTimeout + clearTimeout，cleanup 时立即释放 | Bun 的 `AbortSignal.timeout()` 定时器延迟回收，造成约 2.4KB/次的原生内存泄漏 | AbortSignal.timeout()（Bun 下泄漏） | 代码略多；失去 "reason is TimeoutError" 类型区分 | `createCombinedAbortSignal` 注释与实现 |
| failsafe 定时器先恢复终端再强制退出 | failsafe 回调先运行 `cleanupTerminalModes()` 和 `printResumeHint()` | 终端状态破损是最严重的用户可见问题（需要用户运行 reset），即使清理挂起（如 MCP 连接阻塞），也应该先让终端恢复正常 | 直接强制退出（终端状态可能破损）、先等待清理完成再恢复（清理挂起时终端不可用） | 稍微复杂的定时器回调 | gracefulShutdown failsafe 设置 |
| Ink 卸载由我们调用而非 signal-exit | 显式调用 `inst.unmount()` 然后 `detachForShutdown()` | 避免双重 EXIT_ALT_SCREEN 导致光标位置错误；保证 resume 提示写在正确的 buffer（main 而非 alt）；显式控制顺序比依赖 signal-exit 回调顺序更可靠 | 让 Ink 的 signal-exit 回调处理（双重 EXIT_ALT_SCREEN，光标位置错误） | 与 Ink 内部实现耦合 | cleanupTerminalModes 实现与注释 |
| npm 缓存清理不使用 cacache.verify() | 流式读取索引，按包分组保留最近 N 个（默认 5 个）并删除超过 1 天的旧条目 | `cacache.verify()` 是 O(所有 blob)，大缓存需 60+ 秒，我们只需要删除 Anthropic 包，不需要验证整个缓存；完整性问题罕见，且 npm install 会自动修复 | cacache.verify()（太慢） | 重新实现部分 cacache 逻辑；不做完整性检查 | cleanupNpmCacheForAnthropicPackages 实现与注释 |
| 进程身份使用开始时间而非创建时间哈希 | Linux 使用 `/proc/<pid>/stat` 字段 22（starttime）；BSD/macOS 使用 `ps -o lstart=`；同时检测僵尸进程 | 命令行/环境可被操纵，且不同进程可能相同；创建时间戳在某些系统上只有 1 秒精度，容易碰撞；starttime 是内核调度元数据，不可伪造且重用间隔长 | 通过启动命令行 + 环境哈希生成标识（可被操纵）、创建时间戳（精度低，易碰撞） | Windows 暂不支持；jiffies 精度随 HZ 变化 | processIdentity.ts 实现 |
| 孤儿检测使用间隔检查而非 TTY 挂起信号 | 30 秒间隔检查 `stdout.writable`/`stdin.readable` | macOS 终端关闭行为是撤销 FD，不发送信号；SIGTTOU/SIGTTIN 只在后台进程尝试写/读时产生，不可靠；30 秒是可接受的折中（比无限孤儿好） | poll/select with timeout（不可靠）、SIGTTOU/SIGTTIN 捕获（不可靠） | 最多 30 秒延迟检测；轻微轮询开销 | setupGracefulShutdown 孤儿检测部分 |
| 清理注册表使用 Set 而非数组 | `Set<() => Promise<void>>`，自动去重，O(1) 插入/删除，并行 Promise.all 执行 | 自动去重（同一函数多次注册无害）；O(1) 插入/删除；当前设计要求清理函数独立、无顺序依赖；并行 Promise.all 比串行更快退出 | 数组（无去重，O(n) 插入/删除）、Map<id, fn>（增加复杂度） | 无法保证执行顺序（当前是并行） | cleanupRegistry.ts 实现 |
| 活动管理器 CLI 重叠时强制结束旧操作 | 检测到 operationId 已存在时先 endCLIActivity | 重复 start 通常表示组件崩溃/unmount 未清理，旧操作已实际上结束；宁可低估活跃时间，不要高估（metrics 保守）；嵌套计数会增加复杂度，当前不需要 | 忽略第二次 start（状态不准确）、抛出错误（容易崩溃）、嵌套计数（增加复杂度） | 可能低估时间；丢失嵌套信息 | ActivityManager.startCLIActivity 实现与注释 |
| 终端 disable 序列无条件发送 | 不检查是否支持，全部发送 | 终端检测复杂且容易出错（尤其是 tmux/screen/ssh 链）；不支持的序列被静默忽略（这是终端设计的一部分）；跟踪启用状态需要维护状态机，增加复杂度和出错可能；遗漏禁用序列后果严重（终端破损） | 按 termcap/terminfo 能力发送（检测复杂，易出错）、跟踪我们启用了什么（需要状态机，增加复杂度） | 可能写入少量终端忽略的字节 | cleanupTerminalModes 注释 |

## 3. 目标与非目标

### 目标
- 提供内存安全的取消层次结构，通过 AbortController 实现从父到子的安全取消信号传递
- 保证进程退出时终端状态一致性，恢复终端模式
- 支持跨平台进程存活检测，提供进程身份验证
- 实现可观测的活动时间统计，分别跟踪用户与 CLI 活动
- 提供幂等的清理注册机制
- 实现旧文件定期清理
- 支持 SDK 模式下的空闲超时自动退出
- 处理孤儿进程检测（macOS）
- 记录未捕获异常与 Promise 拒绝用于容器可观测性

### 非目标
- 不定义特定业务的清理逻辑（由各业务模块负责）
- 不替换 async_hooks 或 domain
- 不处理 crash dump 生成
- 不处理 query、SDK、daemon 的具体业务清理流程（仅关注通用生命周期基础设施）

## 4. 架构、模块与数据流

### 模块设计卡：AbortController / 组合信号

#### 真实入口签名与关键类型
```typescript
// src/utils/abortController.ts
export function createAbortController(maxListeners?: number): AbortController
export function createChildAbortController(parent: AbortController, maxListeners?: number): AbortController

// src/utils/combinedAbortSignal.ts
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number }
): { signal: AbortSignal; cleanup: () => void }
```

#### 输入输出
| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `createAbortController` | `maxListeners?: number`（默认 50） | `AbortController` | 带监听器限制的标准 AbortController |
| `createChildAbortController` | `parent: AbortController, maxListeners?: number` | `AbortController` | 父 abort 时子自动 abort，子不影响父 |
| `createCombinedAbortSignal` | `signal?: AbortSignal, opts?: { signalB?: AbortSignal, timeoutMs?: number }` | `{ signal: AbortSignal, cleanup: () => void }` | 组合多个信号与超时，返回 cleanup 释放资源 |

#### 取消与清理状态
- **父子关系**：使用 `WeakRef` 双向弱引用，父不持有子，子不持有父，避免内存泄漏
- **Abort Reason 传播**：子控制器继承父信号的 `reason`，子自身 abort 时可独立设置 reason
- **监听器自动清理**：子 abort 时触发 `removeAbortHandler` 清理父信号上的监听器；`{ once: true }` 保证父 abort 后监听器自动移除
- **组合信号释放**：`createCombinedAbortSignal.cleanup()` 显式移除两个信号的 `abort` 监听器 + `clearTimeout`
- **超时实现**：不使用 `AbortSignal.timeout()`（Bun 下泄漏），改用 `setTimeout + clearTimeout` 立即释放

#### 注册/取消/清理/退出流程
```
createChildAbortController(parent):
  1. 父已 abort → 立即 abort 子并返回
  2. 否则创建子控制器
  3. WeakRef(parent) + WeakRef(child) + bind(propagateAbort)
  4. 父信号 addEventListener('abort', handler, { once: true })
  5. 子信号 addEventListener('abort', removeAbortHandler.bind(weakParent, weakHandler), { once: true })

createCombinedAbortSignal(signal, { signalB, timeoutMs }):
  1. 任一输入已 abort → 立即 abort 组合信号，返回空 cleanup
  2. 否则创建组合控制器
  3. 如有 timeoutMs → setTimeout(abortCombined, timeoutMs) 并 unref
  4. signal / signalB 各 addEventListener('abort', abortCombined)
  5. 返回 { signal: combined.signal, cleanup }

cleanup():
  - clearTimeout（如有）
  - signal.removeEventListener('abort', abortCombined)
  - signalB.removeEventListener('abort', abortCombined)
```

#### 错误与平台边界
- **监听器超限**：静默允许（Node.js 默认行为），不抛错不警告
- **Bun 泄漏规避**：不使用 `AbortSignal.timeout()`，改用 setTimeout + clearTimeout
- **GC 不确定性**：WeakRef 引用在 GC 前仍存活，依赖 `{ once: true }` 兜底

#### 设计取舍/备选
| 取舍 | 采用方案 | 备选方案 | 代价/收益 |
|------|----------|----------|-----------|
| 父子引用 | WeakRef 双向弱引用 | 显式 unlink/destroy API | 用户无需手动 unlink；ES2021+ 要求 |
| 超时实现 | setTimeout + clearTimeout | AbortSignal.timeout() | 代码略多；避免 Bun 下 ~2.4KB/次原生内存泄漏 |
| 监听器清理 | { once: true } + 子 abort 时清理 | 无自动清理 | 无内存泄漏；FinalizationRegistry 执行不确定不可用 |

#### 源码测试证据
- `src/utils/abortController.ts`：实现文件，含 `propagateAbort`、`removeAbortHandler` 模块级函数避免闭包分配
- `src/utils/combinedAbortSignal.ts`：组合信号实现，注释明确说明 Bun 泄漏问题
- 无单元测试覆盖此模块

---

### 模块设计卡：Cleanup Registry

#### 真实入口签名与关键类型
```typescript
// src/utils/cleanupRegistry.ts
export function registerCleanup(cleanupFn: () => Promise<void>): () => void
export async function runCleanupFunctions(): Promise<void>

const cleanupFunctions: Set<() => Promise<void>>  // 全局集合
```

#### 输入输出
| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `registerCleanup` | `cleanupFn: () => Promise<void>` | `unregister: () => void` | 注册清理函数，返回反注册函数 |
| `runCleanupFunctions` | 无 | `Promise<void>` | 并行执行所有已注册清理函数 |

#### 取消与清理状态
- **幂等注册**：`Set` 自动去重，同一函数多次注册无害
- **幂等清理**：反注册函数可多次调用，`Set.delete()` 不存在元素无副作用
- **并行执行**：`Promise.all(Array.from(cleanupFunctions).map(fn => fn()))` 无顺序保证
- **错误隔离**：单个清理函数抛错不影响其他函数继续执行（在 `gracefulShutdown` 上层 catch）

#### 注册/取消/清理/退出流程
```
registerCleanup(fn):
  1. cleanupFunctions.add(fn)
  2. 返回 () => cleanupFunctions.delete(fn)

runCleanupFunctions():
  1. Array.from(cleanupFunctions) 捕获当前快照
  2. 并行 map(fn => fn())
  3. await Promise.all()
```

#### 错误与平台边界
- **清理错误**：`runCleanupFunctions` 不 catch 错误，由 `gracefulShutdown` 外层静默忽略
- **无超时**：单个清理函数可阻塞，由 `gracefulShutdown` 的 2 秒超时总控
- **无顺序**：当前设计要求清理函数独立、无依赖关系

#### 设计取舍/备选
| 取舍 | 采用方案 | 备选方案 | 代价/收益 |
|------|----------|----------|-----------|
| 数据结构 | Set<PromiseFn> | 数组 / Map<id, fn> | O(1) 插入删除；自动去重；无顺序保证 |
| 执行策略 | Promise.all 并行 | 串行执行 | 更快退出；无顺序依赖要求 |
| 错误处理 | 上层 catch | 每个函数单独 try/catch | 简单；单个失败不影响整体 |

#### 源码测试证据
- `src/utils/cleanupRegistry.ts`：完整实现，仅 26 行
- 无单元测试覆盖此模块

---

### 模块设计卡：Graceful Shutdown

#### 真实入口签名与关键类型
```typescript
// src/utils/gracefulShutdown.ts
export function setupGracefulShutdown(): void  // memoize 单例
export async function gracefulShutdown(
  exitCode?: number,
  reason?: ExitReason,
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
    finalMessage?: string
  }
): Promise<void>
export function gracefulShutdownSync(exitCode?: number, reason?: ExitReason, options?: {...}): void
export function isShuttingDown(): boolean
export function resetShutdownState(): void  // 仅用于测试
export function getPendingShutdownForTesting(): Promise<void> | undefined

type ExitReason = 'user_initiated' | 'timeout' | 'error' | 'other'  // 来自 agentSdkTypes
let shutdownInProgress: boolean
let failsafeTimer: NodeJS.Timeout | undefined
let orphanCheckInterval: NodeJS.Timeout | undefined
let resumeHintPrinted: boolean
```

#### 输入输出
| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `setupGracefulShutdown` | 无 | `void` | 安装信号处理器，memoize 单例 |
| `gracefulShutdown` | `exitCode?, reason?, options?` | `Promise<void>` | 异步优雅关闭，内部调用 forceExit |
| `gracefulShutdownSync` | 同上 | `void` | 同步入口，启动异步 shutdown 并设置 process.exitCode |
| `isShuttingDown` | 无 | `boolean` | 查询关闭状态 |
| `forceExit` | `exitCode: number` | `never` | 强制退出，处理 dead PTY |

#### 取消与清理状态
- **幂等关闭**：`shutdownInProgress` 标志防止重入
- **Failsafe 定时器**：预算 = max(5s, SessionEnd 预算 + 3.5s headroom)，优先恢复终端再强制退出
- **Bun 信号 Bug 修复**：注册永不取消的 `onExit(() => {})` 保持 signal-exit v4 emitter count > 0，避免 `unload()` 调用 `removeListener` 重置内核 sigaction
- **孤儿检测**：macOS 终端关闭撤销 TTY FD 不发 SIGHUP，30 秒间隔检测 `stdout.writable` / `stdin.readable`
- **Stall Detector Disabled**：无内部 stall 检测，依赖 failsafe 兜底
- **终端恢复优先**：`cleanupTerminalModes()` + `printResumeHint()` 在任何 async 操作前执行

#### 注册/取消/清理/退出流程
```
setupGracefulShutdown():
  1. onExit(() => {})  // 固定 Bun 信号 bug
  2. SIGINT → gracefulShutdown(0)（跳过 print mode）
  3. SIGTERM → gracefulShutdown(143)
  4. SIGHUP → gracefulShutdown(129)（非 Windows）
  5. macOS TTY → 30s 间隔检测 stdout.writable（跳过 scroll drain）
  6. uncaughtException / unhandledRejection → 记录日志不接管退出

gracefulShutdown(exitCode, reason, options):
  1. 幂等检查 shutdownInProgress
  2. 解析 SessionEnd 超时预算
  3. 安装 failsafe 定时器
  4. cleanupTerminalModes() 同步执行（先 Ink unmount + detachForShutdown，再发送所有 disable 序列）
  5. printResumeHint() 同步执行（仅一次，仅交互 + 持久化启用）
  6. runCleanupFunctions()（2 秒超时）
  7. executeSessionEndHooks(reason, { signal, timeoutMs })
  8. profileReport()
  9. logEvent('tengu_cache_eviction_hint')
  10. analytics flush（500ms 超时）
  11. options.finalMessage → writeSync(2)
  12. forceExit(exitCode)

cleanupTerminalModes():
  1. writeSync(1, DISABLE_MOUSE_TRACKING)  // 最先，给终端 round-trip 时间
  2. Ink inst.unmount()（如有 alt screen）→ 避免双重 EXIT_ALT_SCREEN
  3. drainStdin()
  4. detachForShutdown()  // 标记 unmounted，避免 signal-exit 回调再次执行
  5. 无条件发送所有 disable 序列（MODIFY_OTHER_KEYS, KITTY_KEYBOARD, DFE, DBP, SHOW_CURSOR, CLEAR_ITERM2_PROGRESS, CLEAR_TAB_STATUS, CLEAR_TERMINAL_TITLE）
  6. 所有错误静默忽略

forceExit(exitCode):
  1. clearTimeout(failsafeTimer)
  2. drainStdin()（最后一次，捕获清理期间到达的鼠标事件）
  3. try process.exit(exitCode)
  4. catch（dead PTY EPERM/EIO）→ process.kill(pid, SIGKILL)
```

#### 错误与平台边界
- **Dead PTY**：`process.exit()` 在 Bun 下抛 EPERM/EIO，回退到 SIGKILL（不 flush）
- **终端 write 错误**：`cleanupTerminalModes` / `printResumeHint` 所有 write 错误静默忽略
- **Windows**：无 SIGHUP，无孤儿检测；`process.title = ''` 清除标题
- **Print mode**：`-p/--print` 注册自己的 SIGINT 处理器，setup 跳过
- **Test mode**：`process.exit` 可能 mock 抛错/返回，特殊处理

#### 设计取舍/备选
| 取舍 | 采用方案 | 备选方案 | 代价/收益 |
|------|----------|----------|-----------|
| 终端恢复顺序 | 先 cleanupTerminalModes/printResumeHint，再 async 清理 | 先清理再恢复 | 用户可见性优先；避免清理挂起时终端卡住 |
| Ink 卸载 | 显式调用 inst.unmount() + detachForShutdown() | 依赖 signal-exit 回调 | 避免双重 EXIT_ALT_SCREEN 光标位置错误 |
| Disable 序列 | 无条件全部发送 | 按 termcap 能力检测发送 | 简单可靠；不支持的序列被终端静默忽略 |
| Failsafe 动作 | 先恢复终端再强制退出 | 直接强制退出 | 终端状态破损是最严重用户问题 |
| Analytics flush | 500ms 超时 | 无超时 | 丢失分析可接受；挂起退出不可接受 |
| Bun 信号 bug | 固定 onExit no-op | 自行管理信号 | 与第三方库行为耦合；保证信号正确传递 |
| 孤儿检测 | 30s poll stdout.writable | SIGTTOU/SIGTTIN、poll/select | macOS 上可靠；轻微轮询开销 |

#### 源码测试证据
- `src/utils/gracefulShutdown.ts`：完整实现，530 行
- 无单元测试覆盖此模块

---

### 模块设计卡：Idle Timeout / Activity

#### 真实入口签名与关键类型
```typescript
// src/utils/idleTimeout.ts
export function createIdleTimeoutManager(isIdle: () => boolean): {
  start: () => void
  stop: () => void
}

// src/utils/activityManager.ts
export class ActivityManager {
  static getInstance(): ActivityManager
  static resetInstance(): void
  static createInstance(options?: ActivityManagerOptions): ActivityManager
  recordUserActivity(): void
  startCLIActivity(operationId: string): void
  endCLIActivity(operationId: string): void
  async trackOperation<T>(operationId: string, fn: () => Promise<T>): Promise<T>
  getActivityStates(): { isUserActive: boolean; isCLIActive: boolean; activeOperationCount: number }
}

type ActivityManagerOptions = {
  getNow?: () => number
  getActiveTimeCounter?: typeof getActiveTimeCounterImpl
}

private activeOperations: Set<string>
private lastUserActivityTime: number
private lastCLIRecordedTime: number
private isCLIActive: boolean
private readonly USER_ACTIVITY_TIMEOUT_MS = 5000  // 5 秒
```

#### 输入输出
| 函数/方法 | 输入 | 输出 | 说明 |
|-----------|------|------|------|
| `createIdleTimeoutManager` | `isIdle: () => boolean` | `{ start, stop }` | 创建空闲超时管理器 |
| `ActivityManager.recordUserActivity` | 无 | `void` | 记录用户活动，累积时间（仅 CLI 非活动时） |
| `ActivityManager.startCLIActivity` | `operationId: string` | `void` | 开始 CLI 活动，重叠时强制结束旧操作 |
| `ActivityManager.endCLIActivity` | `operationId: string` | `void` | 结束 CLI 活动，记录时间 |
| `ActivityManager.trackOperation` | `operationId, fn: Promise<T>` | `Promise<T>` | 包裹函数自动 start/end |
| `ActivityManager.getActivityStates` | 无 | `{ isUserActive, isCLIActive, activeOperationCount }` | 查询当前状态 |

#### 取消与清理状态
- **空闲超时配置**：环境变量 `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY`（毫秒），无效则禁用
- **超时重置**：`start()` 清除现有 timer 重新计时，`lastIdleTime` 记录起始点
- **超时检查**：触发时验证 `isIdle() && idleDuration >= delayMs`，双重确认
- **CLI 重叠操作**：`startCLIActivity` 检测到已存在 operationId 时先 `endCLIActivity`，宁可低估不要高估
- **用户活动超时窗口**：5 秒内的连续活动累积时间，超期间隔不计入
- **CLI 优先**：CLI 活动期间不记录用户活动时间

#### 注册/取消/清理/退出流程
```
createIdleTimeoutManager(isIdle):
  - 解析 CLAUDE_CODE_EXIT_AFTER_STOP_DELAY
  - 无效则 start/stop 为空操作
  - 有效则：
    start(): clearTimeout + lastIdleTime = now + setTimeout(delayMs)
      触发时：检查 isIdle() && idleDuration >= delayMs → gracefulShutdownSync()
    stop(): clearTimeout

ActivityManager 生命周期：
  单例模式：getInstance() 惰性创建
  recordUserActivity():
    - CLI 非活动 && lastUserActivityTime !== 0 → 计算与上次间隔
    - 间隔 < 5s → add(间隔, { type: 'user' })
    - 更新 lastUserActivityTime
  startCLIActivity(operationId):
    - 已存在 → 先 endCLIActivity
    - add 到 activeOperations
    - 从空变非空 → isCLIActive = true + lastCLIRecordedTime = now
  endCLIActivity(operationId):
    - 从 Set 中 delete
    - 变空 → 计算与 lastCLIRecordedTime 间隔 → add(间隔, { type: 'cli' }) → isCLIActive = false
```

#### 错误与平台边界
- **环境变量解析**：`parseInt` 失败或 `<= 0` 则禁用
- **activeTimeCounter 可选**：`getActiveTimeCounter()` 可能返回 `undefined`，此时不记录时间
- **无持久化**：活动时间仅内存统计，进程退出丢失
- **幂等 end**：`endCLIActivity` 不存在的 operationId 无副作用

#### 设计取舍/备选
| 取舍 | 采用方案 | 备选方案 | 代价/收益 |
|------|----------|----------|-----------|
| 重叠操作处理 | 强制结束旧操作 | 忽略第二次 start、抛错、嵌套计数 | 简单；宁可低估不要高估 metrics |
| 用户时间窗口 | 5 秒连续累积 | 每次活动单独记录、无超时 | 合理；避免闲置时间计入 |
| CLI 优先级 | CLI 活动期间不记录用户时间 | 同时记录、用户优先 | CLI 活动时用户等待不算用户主动操作 |
| 空闲管理器 | 回调 `isIdle()` 注入判断 | 硬编码判断逻辑 | 灵活；SDK 模式可自定义判断 |

#### 源码测试证据
- `src/utils/idleTimeout.ts`：空闲超时实现，54 行
- `src/utils/activityManager.ts`：活动管理器实现，165 行
- 无单元测试覆盖此模块

---

### 模块设计卡：Process Identity

#### 真实入口签名与关键类型
```typescript
// src/utils/processIdentity.ts
export type ProcessIdentity = {
  state: 'running' | 'not_found' | 'unknown'
  token?: string
}

export async function getProcessIdentity(pid: number): Promise<ProcessIdentity>
export async function getProcessStartToken(pid: number): Promise<string | undefined>
export async function matchesProcessStartToken(pid: number, expected: string): Promise<boolean>
```

#### 输入输出
| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `getProcessIdentity` | `pid: number` | `Promise<ProcessIdentity>` | 获取进程身份状态与 token |
| `getProcessStartToken` | `pid: number` | `Promise<string \| undefined>` | 便捷方法，仅返回 token |
| `matchesProcessStartToken` | `pid: number, expected: string` | `Promise<boolean>` | 验证进程是否与预期 token 匹配 |

#### 取消与清理状态
- **PID 验证**：`pid <= 1` 或非安全整数 → `{ state: 'not_found' }`
- **存活探测**：`process.kill(pid, 0)` 检查
  - `ESRCH` → not found
  - `EPERM` → unknown（存在但无权限）
  - 其他错误 → unknown
- **僵尸检测**：Linux 从 `/proc/${pid}/stat` 检查状态字段是否为 'Z'；BSD/macOS 从 `ps -o stat=` 检查是否以 'Z' 开头；Windows 无僵尸检测 → false
- **Windows 限制**：`process.kill(pid, 0)` 可用，但 start token 获取不支持 → token undefined，state unknown/running/not_found 仅基于 kill 0 + 无僵尸检查

#### 注册/取消/清理/退出流程
```
getProcessIdentity(pid):
  1. pid <= 1 或非安全整数 → not_found
  2. try process.kill(pid, 0)
     - ESRCH → not_found
     - EPERM → unknown
     - 其他错误 → unknown
  3. check isZombie(pid) → true → not_found
  4. 获取 start token:
     - Linux: /proc/${pid}/stat → 提取字段 22（comm 后第 19 字段）
     - Windows: undefined
     - 其他: ps -o lstart= -p ${pid} → 压缩空白
  5. token 存在 → { state: 'running', token }
     否则 → { state: 'unknown' }

isZombie(pid):
  - Linux: /proc/${pid}/stat → 字段 3 == 'Z'
  - Windows: false
  - 其他: ps -o stat= -p ${pid} → 以 'Z' 开头

linuxStartToken(pid):
  - 读取 /proc/${pid}/stat
  - 找到最后一个 ')'，从其后分割字段
  - comm 后字段索引从 0 开始，starttime 是第 19 个（原字段 22）
```

#### 错误与平台边界
- **Windows 限制**：无 start token 支持，无法可靠检测 PID 重用；无僵尸检测
- **Linux comm 解析**：小心处理 comm 中的空格/括号，从最后一个 ')' 后分割避免错误
- **ps 超时**：2 秒超时，避免挂起
- **token 格式**：Linux 是 jiffies 数字（精度随 HZ 变化）；BSD/macOS 是日期时间字符串
- **PID 重用**：start token 不可伪造且重用间隔长，比命令行/环境/创建时间可靠

#### 设计取舍/备选
| 取舍 | 采用方案 | 备选方案 | 代价/收益 |
|------|----------|----------|-----------|
| 进程标识 | starttime 令牌 | 命令行/环境哈希、创建时间戳 | 不可伪造；重用间隔长；Windows 暂不支持 |
| 僵尸处理 | 僵尸视为 not_found | 视为 running | 僵尸不会执行任何操作 |
| 权限处理 | EPERM 视为 unknown | 视为 running | 保守；存在但无法确定是否是目标进程 |
| Linux 解析 | 从最后一个 ')' 分割 | 简单空格分割 | 正确处理 comm 中的空格/括号 |

#### 源码测试证据
- `src/utils/processIdentity.ts`：完整实现，93 行
- 无单元测试覆盖此模块

---

### 核心模块

```typescript
// 取消系统
createAbortController(maxListeners?: number): AbortController  // 带监听器限制的控制器
createChildAbortController(parent: AbortController): AbortController  // 弱引用父子绑定
createCombinedAbortSignal(options: {
  signals?: AbortSignal[]
  timeout?: number
}): { signal: AbortSignal; cleanup: () => void }  // 组合信号与超时

// 清理注册表
registerCleanup(cleanupFn: () => Promise<void>): () => void  // 注册清理函数，返回反注册函数
runCleanupFunctions(): Promise<void>  // 运行所有清理函数

// 旧文件清理
cleanupOldFiles(cutoffDate?: Date): Promise<void>  // 清理过期缓存、日志、会话等
convertFileNameToDate(filename: string): Date  // 解析文件名中的时间戳
cleanupNpmCacheForAnthropicPackages(): Promise<void>  // 清理 npm 缓存中的 Anthropic 包

// 进程退出
gracefulShutdown(
  exitCode?: number,
  reason?: ExitReason,
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
    finalMessage?: string
  }
): Promise<void>  // 优雅关闭
forceExit(exitCode: number): never  // 强制退出
cleanupTerminalModes(): void  // 清理终端模式

// 超时与活动状态
createIdleTimeoutManager(isIdle: () => boolean): {
  start: () => void
  stop: () => void
}  // 空闲超时管理器
class ActivityManager {
  static getInstance(): ActivityManager
  static resetInstance(): void
  static createInstance(options?: ActivityManagerOptions): ActivityManager
  recordUserActivity(): void
  startCLIActivity(operationId: string): void
  endCLIActivity(operationId: string): void
  async trackOperation<T>(operationId: string, fn: () => Promise<T>): Promise<T>
  getActivityStates(): { isUserActive: boolean; isCLIActive: boolean; activeOperationCount: number }
}  // 活动管理器

// 进程存活检测
isProcessRunning(pid: number): boolean  // 检测进程是否存活
getProcessIdentity(pid: number): Promise<ProcessIdentity | undefined>  // 获取进程身份
matchesProcessStartToken(pid: number, expected: string): Promise<boolean>  // 匹配进程开始时间令牌
getAncestorPidsAsync(pid: string | number, maxDepth?: number): Promise<number[]>  // 获取祖先 PID
getAncestorCommandsAsync(pid: string | number, maxDepth?: number): Promise<string[]>  // 获取祖先命令
getChildPids(pid: string | number): number[]  // 获取子 PID
```

### 主控制流

#### Graceful Shutdown 流程
```
信号触发（SIGINT/SIGTERM/SIGHUP）或显式调用 gracefulShutdown()
  ↓
幂等检查（shutdownInProgress 标志防止重入）
  ↓
计算超时预算（从 SessionEnd hooks 配置读取）
  ↓
安装 failsafe 定时器（预算 = max(5s, hook 预算 + 3.5s headroom)）
  ↓
立即退出 alt 屏幕并打印 resume 提示（用户可见性优先）
  ↓
运行清理函数（2 秒超时）
  ↓
运行 SessionEnd hooks（总体预算 + 每 hook 超时）
  ↓
启动性能报告
  ↓
缓存逐出提示事件
  ↓
分析 flush（500ms 超时）
  ↓
可选 finalMessage
  ↓
强制退出
```

#### Failsafe 回调流程
```
failsafe 定时器触发
  ↓
先运行 cleanupTerminalModes()（保证终端状态恢复）
  ↓
再运行 printResumeHint()（保证用户看到 resume 提示）
  ↓
然后强制退出
```

#### 孤儿检测流程（macOS）
```
进程启动
  ↓
如果 platform !== 'win32' 且 stdin.isTTY:
  设置 30 秒间隔检测
  orphanCheckInterval.unref()
  ↓
每次检测:
  如果 getIsScrollDraining(): 跳过（滚动时不检测）
  如果 !stdout.writable 或 !stdin.readable:
    clearInterval(orphanCheckInterval)
    void gracefulShutdown(129)
```

## 5. 失败语义与工程取舍

| 失败场景 | 处理方式 | 工程取舍 |
|---|---|---|
| 清理函数抛出错误 | Promise.all 继续执行其他清理函数，不中断整体流程 | 单个清理失败不影响其他清理，尽可能清理 |
| SessionEnd hooks 超时 | 总体预算控制，超时后继续后续步骤 | 避免单个 hook 阻塞整个退出流程 |
| failsafe 定时器触发 | 先恢复终端再强制退出 | 用户可见性优先，终端状态破损比部分清理未完成更严重 |
| `process.exit()` 在 dead PTY 下抛出 EPERM/EIO（Bun） | 回退到 `process.kill(process.pid, 'SIGKILL')`，不尝试 flush | 保证进程能退出，即使终端不可用 |
| Bun 信号处理 bug（`process.removeListener()` 重置内核 sigaction） | 使用 `signal-exit` 并注册一个永不取消的 no-op 回调，保持 v4 的内部 emitter count > 0，从而避免 `unload()` 被调用 | 与第三方库行为耦合，但保证信号处理正确 |
| macOS 终端关闭撤销 TTY FD（不发送 SIGHUP） | 30 秒间隔检查 `stdout.writable`/`stdin.readable` | 最多 30 秒延迟检测，比无限孤儿好；轻微轮询开销 |
| AbortController 监听器超过限制 | 静默允许（Node.js 默认行为），但设置合理默认值（50）避免警告 | 平衡安全性和可用性 |
| 旧文件删除单个失败 | 记录日志，继续删除其他文件 | 单个文件失败不影响整体清理 |
| npm 缓存索引读取失败 | 记录日志，跳过清理 | 避免缓存清理导致崩溃 |
| 未捕获异常/Promise 拒绝 | 记录用于容器可观测性和分析，不接管退出（保持 Node 默认行为） | 不改变默认行为，只增加可观测性 |

## 6. 现状验收标准

- AbortController 父子关系正确使用 WeakRef，父不持有子，子不持有父
- 子 abort 时自动清理父监听器
- `createCombinedAbortSignal` 正确组合多个信号和超时，cleanup 正确释放资源
- 清理注册表正确去重，反注册功能正常
- `gracefulShutdown` 按正确顺序执行，用户可见性优先
- failsafe 定时器正确触发，先恢复终端再强制退出
- `cleanupTerminalModes` 正确发送所有 disable 序列，无条件
- `forceExit` 正确处理 dead PTY 下的 EPERM/EIO
- 孤儿检测（macOS）正确工作，终端关闭后 30 秒内触发 gracefulShutdown
- `ActivityManager` 正确分别统计用户与 CLI 活动，重叠时强制结束旧操作
- 进程存活检测正确工作，僵尸进程正确识别
- 旧文件清理正确按 cutoffDate 过滤，错误容忍
- npm 缓存清理正确流式读取索引，按包分组保留最近 N 个

## 7. 代码与测试证据

### 现有实现
- `src/utils/abortController.ts`: AbortController 层次结构实现
- `src/utils/cleanupRegistry.ts`: 清理注册表实现
- `src/utils/cleanupOldFiles.ts`: 旧文件清理实现
- `src/utils/gracefulShutdown.ts`: 优雅关闭实现
- `src/utils/processIdentity.ts`: 进程身份实现
- `src/utils/activityManager.ts`: 活动管理器实现
- `src/utils/idleTimeout.ts`: 空闲超时实现

### 未覆盖测试
- AbortController 父子关系内存泄漏测试
- `createCombinedAbortSignal` 各种组合场景测试
- `gracefulShutdown` 超时和 failsafe 场景测试
- `cleanupTerminalModes` 各种终端类型测试
- `ActivityManager` 重叠操作、用户/CLI 活动时间统计测试
- 进程存活检测各种平台、僵尸进程、PID 重用场景测试
- 旧文件清理各种 cutoffDate、错误场景测试
- npm 缓存清理各种缓存大小、包分布场景测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/runtime-lifecycle.yaml)

相关子系统：
- ink: 提供终端 UI 和 alt screen 管理
- hooks: 提供 SessionEnd hooks
- telemetry: 接收未捕获异常/Promise 拒绝事件
- analytics: 接收活动时间统计
- performance: 接收性能报告
- settings: 可能配置 worktree 相关清理

## 9. 改进建议

1. 增加更细粒度的清理函数执行顺序控制（优先级、依赖关系）
2. 实现 Windows 进程身份支持（当前仅 Linux/BSD/macOS）
3. 增加 AbortController 层次结构的性能监控（监听器数量、内存使用）
4. 实现更智能的空闲超时策略（考虑用户活动模式、任务状态）
5. 增加进程树操作工具（终止整个进程树、挂起/恢复进程树）
6. 实现清理函数执行时间限制，避免单个清理函数阻塞太久
7. 增加更详细的活动时间统计（按操作类型、模块分类）
8. 实现终端状态快照功能，方便调试终端模式问题
9. 增加孤儿检测的可配置性（检测间隔、启用/禁用）
10. 实现更健壮的 npm 缓存清理（处理损坏的索引、权限问题）
