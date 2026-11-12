---
id: runtime-lifecycle
title: Runtime Lifecycle 取消、清理与进程退出设计
status: draft
batch: 7
---

# 1. 概述

Runtime Lifecycle 是 Claude Code 的底层运行时管理系统，负责：

- **取消传播**：通过 AbortController 层次结构实现从父到子的安全取消信号传递，同时避免内存泄漏
- **清理注册与幂等**：集中式清理函数注册机制，支持重复调用安全
- **进程退出**：信号处理、终端状态恢复、失败安全的强制退出
- **超时与活动状态**：SDK 模式下的空闲超时、用户与 CLI 活动跟踪
- **错误与平台边界**：跨平台进程状态检测、孤儿进程发现

本文档不包含 query、SDK、daemon 的具体业务清理流程，仅关注通用生命周期基础设施。

## 1.1 目标与非目标

**目标**：
- 提供内存安全的取消层次结构
- 保证进程退出时终端状态一致性
- 支持跨平台进程存活检测
- 实现可观测的活动时间统计

**非目标**：
- 定义特定业务的清理逻辑
- 替代 async_hooks 或 domain
- 处理 crash dump 生成

---

# 2. 术语与概念

| 术语 | 说明 |
|------|------|
| AbortController | Web API 标准，用于生成可取消的信号 |
| 子控制器 | 通过 createChildAbortController 创建，绑定到父控制器的生命周期 |
| WeakRef | ES2021 弱引用，避免保留已放弃的子对象 |
| 清理注册表 | cleanupRegistry，集中存储 shutdown 时运行的函数 |
| 孤儿进程 | 终端关闭后未收到 SIGHUP 继续运行的进程 |
| 活动时间 | 用户输入与 CLI 执行分别统计的活跃时间 |

---

# 3. 取消传播设计

## 3.1 层次结构与内存安全

取消系统基于三层设计：

1. **带监听器限制的控制器**（createAbortController）
2. **弱引用父子绑定**（createChildAbortController）
3. **组合信号与超时**（createCombinedAbortSignal）

### 3.1.1 监听器限制

默认设置 50 个监听器上限，避免 `MaxListenersExceededWarning`。这是因为一个父控制器可能有多个子控制器订阅其 abort 事件。

```typescript
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController
```

### 3.1.2 弱引用父子关系

子控制器通过 `WeakRef` 绑定到父控制器，有两个关键优势：

- **父不持有子**：如果子被丢弃（无其他引用），可被 GC，不会因为父仍在而泄漏
- **子不持有父**：清理监听器时使用弱引用，避免循环引用

```typescript
// propagateAbort 使用弱引用访问父子
function propagateAbort(
  this: WeakRef<AbortController>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref()
  weakChild.deref()?.abort(parent?.signal.reason)
}
```

### 3.1.3 自动清理监听器

当子被 abort（无论来自父还是独立调用）时，自动从父移除监听器，避免死监听器累积：

```typescript
// 子 abort 时清理父监听器
child.signal.addEventListener(
  'abort',
  removeAbortHandler.bind(weakParent, new WeakRef(handler)),
  { once: true },
)
```

## 3.2 组合信号与超时

`createCombinedAbortSignal` 支持：
- 最多两个输入信号
- 可选超时
- 返回 cleanup 函数移除监听器并清除定时器

### 3.2.1 Bun 定时器优化

在 Bun 下，`AbortSignal.timeout()` 创建的定时器会被延迟回收（直到超时触发），造成约 2.4KB/次的原生内存泄漏。因此内部使用 `setTimeout` + `clearTimeout` 实现，并在 cleanup 时立即释放。

```typescript
// 内部使用 setTimeout 而非 AbortSignal.timeout
if (timeoutMs !== undefined) {
  timer = setTimeout(abortCombined, timeoutMs)
  timer.unref?.()
}
```

### 3.2.2 快速路径

如果任一输入信号已 abort，立即 abort 组合信号并返回空 cleanup：

```typescript
if (signal?.aborted || signalB?.aborted) {
  combined.abort()
  return { signal: combined.signal, cleanup: () => {} }
}
```

---

# 4. 清理注册与幂等

## 4.1 清理注册表

`cleanupRegistry` 是一个独立模块，避免与 `gracefulShutdown` 形成循环依赖：

```typescript
const cleanupFunctions = new Set<() => Promise<void>>()

export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn)
}

export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
```

### 4.1.1 幂等注册

使用 `Set` 存储，同一函数重复注册无害，只运行一次。

### 4.1.2 反注册支持

`registerCleanup` 返回反注册函数，用于组件卸载时移除不再需要的清理逻辑。

## 4.2 旧文件清理

独立于 shutdown 的定期清理机制，用于删除过期缓存、日志、会话等：

- 按日期 cutoff 过滤（默认 30 天）
- 错误容忍：单个文件删除失败不中断整体
- 幂等：重复运行安全

### 4.2.1 清理范围

| 类别 | 位置 | 说明 |
|------|------|------|
| 消息/错误 | `CACHE_PATHS` | JSONL 日志 |
| MCP 日志 | `mcp-logs-*` | 按会话目录组织 |
| 会话 | `projectsDir` | `.jsonl`/`.cast`、工具结果、空目录 |
| 计划 | `plansDir` | 旧 plan markdown |
| 文件历史 | `file-history` | 带检查点的完整会话 |
| 会话环境 | `session-env` | 隔离环境目录 |
| 调试日志 | `debugDir` | 保留 `latest`  symlink |
| 图片缓存 | `imageStore` | 图片资源 |
| 粘贴 | `pasteStore` | 剪贴板历史 |
| 工作树 | `worktree` | 孤立 agent 工作树 |
| npm 缓存 | `~/.npm/_cacache` | Anthropic 包条目（仅 ant 用户） |

### 4.2.2 日期解析

文件名中的时间戳格式为 ISO 但 `:.` 被替换为 `-`，转换时恢复：

```typescript
export function convertFileNameToDate(filename: string): Date {
  const isoStr = filename
    .split('.')[0]!
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  return new Date(isoStr)
}
```

### 4.2.3 npm 缓存优化

不使用 `cacache.verify()`（完整缓存验证，O(所有 blob)，大缓存需 60+ 秒），而是流式读取索引，按包分组保留最近 N 个（默认 5 个）并删除超过 1 天的旧条目。

---

# 5. 进程退出设计

## 5.1 信号处理

### 5.1.1 处理的信号

| 信号 | 平台 | 行为 |
|------|------|------|
| SIGINT | 全部 | gracefulShutdown(0)，print 模式除外 |
| SIGTERM | 全部 | gracefulShutdown(143) |
| SIGHUP | 非 Win32 | gracefulShutdown(129) |

### 5.1.2 Bun 信号处理 bug 规避

Bun 中 `process.removeListener(sig, fn)` 即使仍有其他 JS 监听器也会重置内核 sigaction，导致信号回到默认行为（终止）。解决方案：使用 `signal-exit` 并注册一个永不取消的 no-op 回调，保持 v4 的内部 emitter count > 0，从而避免 `unload()` 被调用。

```typescript
// 固定 signal-exit v4
onExit(() => {})
```

### 5.1.3 孤儿进程检测（macOS）

macOS 关闭终端时会撤销 TTY 文件描述符而非发送 SIGHUP。通过 30 秒间隔检查 `stdout.writable` / `stdin.readable` 检测这种情况：

```typescript
if (process.platform !== 'win32' && process.stdin.isTTY) {
  orphanCheckInterval = setInterval(() => {
    if (getIsScrollDraining()) return // 滚动时跳过
    if (!process.stdout.writable || !process.stdin.readable) {
      clearInterval(orphanCheckInterval)
      void gracefulShutdown(129)
    }
  }, 30_000)
  orphanCheckInterval.unref()
}
```

## 5.2 Graceful Shutdown 流程

```typescript
export async function gracefulShutdown(
  exitCode = 0,
  reason: ExitReason = 'other',
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
    finalMessage?: string
  },
): Promise<void>
```

### 5.2.1 顺序保证

1. **幂等检查**：`shutdownInProgress` 标志防止重入
2. **计算超时预算**：从 SessionEnd hooks 配置读取
3. **安装 failsafe**：保证即使清理挂起也能退出
4. **立即退出 alt 屏幕并打印 resume 提示**：用户可见性优先
5. **运行清理函数**：2 秒超时
6. **运行 SessionEnd hooks**：总体预算 + 每 hook 超时
7. **启动性能报告**
8. **缓存逐出提示事件**
9. **分析 flush**：500ms 超时
10. **可选 finalMessage**
11. **强制退出**

### 5.2.2 Failsafe 定时器

预算 = max(5s, hook 预算 + 3.5s headroom)。Failsafe 运行时先执行 `cleanupTerminalModes()` 和 `printResumeHint()`，保证终端状态即使挂起也能恢复。

### 5.2.3 用户可见性优先

将 `cleanupTerminalModes()` 和 `printResumeHint()` 放在最前面，而不是等待异步清理完成。这样即使用户在清理时按 Ctrl+C 或系统触发 SIGKILL，用户也能看到 resume 提示且终端状态正常。

## 5.3 终端模式清理

使用同步 `writeSync` 保证在进程退出前完成：

```typescript
function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) return

  // 先禁用鼠标跟踪，给终端往返时间处理
  writeSync(1, DISABLE_MOUSE_TRACKING)

  // 通过 Ink 实例卸载退出 alt screen（而非直接写序列）
  // 这保证 Ink 知道自己已卸载，不会在 signal-exit 回调中再次运行
  const inst = instances.get(process.stdout)
  if (inst?.isAltScreenActive) {
    try {
      inst.unmount()
    } catch {
      writeSync(1, EXIT_ALT_SCREEN)
    }
  }

  // 再次 drain stdin
  inst?.drainStdin()

  // 标记为 detached，避免 signal-exit 再次卸载
  inst?.detachForShutdown()

  // 发送所有 disable 序列，无条件
  writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
  writeSync(1, DISABLE_KITTY_KEYBOARD)
  writeSync(1, DFE) // focus events
  writeSync(1, DBP) // bracketed paste
  writeSync(1, SHOW_CURSOR)
  writeSync(1, CLEAR_ITERM2_PROGRESS)
  if (supportsTabStatus()) writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS))
  if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
    // ... clear title
  }
}
```

### 5.3.1 为什么不直接写 EXIT_ALT_SCREEN

1. Ink 注册了自己的 `signal-exit` 回调，如果我们先写序列，Ink 的 unmount 会再次写，导致 DECRC 恢复光标到错误位置
2. Ink 的 unmount 需要 `altScreenActive` 标志为 true 来正确计算光标位置

### 5.3.2 为什么无条件发送所有 disable 序列

- 终端检测可能不正确（tmux/screen 等）
- 不支持的序列会被静默忽略
- 遗漏禁用会让终端处于破损状态

## 5.4 强制退出

处理 `process.exit()` 在 dead PTY 下可能抛出 EPERM/EIO 的情况（Bun）：

```typescript
function forceExit(exitCode: number): never {
  // 最后一次 drain stdin
  try {
    instances.get(process.stdout)?.drainStdin()
  } catch {}

  try {
    process.exit(exitCode)
  } catch (e) {
    // 在测试中，process.exit 被 mock 为抛出，重新抛出
    if ((process.env.NODE_ENV as string) === 'test') {
      throw e
    }
    // 回退到 SIGKILL，不尝试 flush
    process.kill(process.pid, 'SIGKILL')
  }
  // ... test mock 路径
}
```

---

# 6. 超时与活动状态

## 6.1 空闲超时（SDK 模式）

通过 `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY` 环境变量配置，在持续空闲指定时间后自动退出：

```typescript
export function createIdleTimeoutManager(isIdle: () => boolean): {
  start: () => void
  stop: () => void
}
```

- `isIdle` 回调由调用者提供，判断当前是否空闲
- `start()` / `stop()` 可重复调用，内部去重
- 超时触发时调用 `gracefulShutdownSync()`

## 6.2 活动管理器

`ActivityManager` 是单例，跟踪用户与 CLI 活动并分别统计活跃时间：

```typescript
export class ActivityManager {
  static getInstance(): ActivityManager
  static resetInstance(): void // 测试用
  static createInstance(options?: ActivityManagerOptions): ActivityManager // 测试用

  recordUserActivity(): void
  startCLIActivity(operationId: string): void
  endCLIActivity(operationId: string): void
  async trackOperation<T>(operationId: string, fn: () => Promise<T>): Promise<T>
  getActivityStates(): { isUserActive: boolean; isCLIActive: boolean; activeOperationCount: number }
}
```

### 6.2.1 用户活动超时

5 秒窗口，超过该间隔的用户输入不计入连续活跃时间。

### 6.2.2 CLI 活动重叠处理

使用 `Set<operationId>` 跟踪进行中的操作，重叠时仅记录一次时间，避免重复统计。如果同一个 `operationId` 再次 `startCLIActivity` 而未 `end`，会先强制结束旧的（宁可低估，不要高估）。

### 6.2.3 用户 vs CLI 优先级

当 CLI 活跃时，用户活动记录不增加用户时间，避免与 CLI 执行时间重复计算。

---

# 7. 错误与平台边界

## 7.1 进程存活检测

### 7.1.1 基本检测

使用 `process.kill(pid, 0)`（信号 0 探测）：

```typescript
export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
```

注意：EPERM（进程存在但属主不同）被报告为 NOT running，这对锁恢复是保守的（不会窃取活跃进程的锁）。

### 7.1.2 进程身份与开始时间

仅检查 PID 是不够的（PID 可重用）。`getProcessIdentity` 返回平台特定的开始时间令牌：

- **Linux**：`/proc/<pid>/stat` 字段 22（starttime），正确处理 comm 中包含空格/括号的情况
- **BSD/macOS**：`ps -o lstart=`，规范化空格
- **Win32**：暂不支持（返回 undefined）

同时检测僵尸进程（Linux: `stat` 字段 3 == 'Z'；BSD: `ps -o stat=` 以 'Z' 开头），僵尸视为 not found。

```typescript
export async function getProcessIdentity(pid: number): Promise<ProcessIdentity>
export async function matchesProcessStartToken(pid: number, expected: string): Promise<boolean>
```

### 7.1.3 进程树遍历

```typescript
export async function getAncestorPidsAsync(
  pid: string | number,
  maxDepth = 10,
): Promise<number[]>

export async function getAncestorCommandsAsync(
  pid: string | number,
  maxDepth = 10,
): Promise<string[]>

export function getChildPids(pid: string | number): number[]
```

跨平台实现：
- **Windows**：PowerShell `Get-CimInstance Win32_Process`
- **Unix**：`ps` / `pgrep`，使用空字节分隔命令行处理包含换行的命令

## 7.2 未捕获异常与 Promise 拒绝

记录用于容器可观测性和分析，不接管退出（保持 Node 默认行为）：

```typescript
process.on('uncaughtException', error => {
  logForDiagnosticsNoPII('error', 'uncaught_exception', { ... })
  logEvent('tengu_uncaught_exception', { ... })
})

process.on('unhandledRejection', reason => {
  logForDiagnosticsNoPII('error', 'unhandled_rejection', { ... })
  logEvent('tengu_unhandled_rejection', { ... })
})
```

---

# 8. 覆盖率

[Coverage](../../architecture/coverage/runtime-lifecycle.yaml)

---

# 9. 设计决策与备选方案

## 决策 1：使用 WeakRef 实现父子取消层次

| 维度 | 说明 |
|------|------|
| 现状 | 采用 WeakRef + WeakRef 绑定 |
| 备选 | 显式 `unlink()` / `destroy()` API；FinalizationRegistry |
| 选择 | WeakRef 方法 |
| 代价 | 需要 ES2021；WeakRef 在 GC 前仍保持引用一段时间（不可预测） |
| 证据 | `createChildAbortController` 实现与注释 |

**理由**：
- 显式 `unlink()` 需要用户代码配合，容易遗漏导致泄漏
- FinalizationRegistry 执行不确定，且仍需要 `WeakRef` 访问被终结对象
- 当前方案在子被 abort 时主动清理监听器，GC 只是兜底

## 决策 2：不使用 AbortSignal.timeout()

| 维度 | 说明 |
|------|------|
| 现状 | 使用 setTimeout + clearTimeout |
| 备选 | AbortSignal.timeout() |
| 选择 | 手动 setTimeout |
| 代价 | 代码略多；失去 "reason is TimeoutError" 类型区分 |
| 证据 | `createCombinedAbortSignal` 注释与实现 |

**理由**：
- Bun 下 AbortSignal.timeout() 定时器延迟回收（2.4KB/次泄漏）
- 可以通过其他方式传达 reason（例如调用方显式设置）

## 决策 3：failsafe 定时器先恢复终端再强制退出

| 维度 | 说明 |
|------|------|
| 现状 | failsafe 回调先运行 cleanupTerminalModes + printResumeHint |
| 备选 | 直接强制退出；先等待清理完成再恢复 |
| 选择 | 先恢复终端 |
| 代价 | 稍微复杂的定时器回调 |
| 证据 | gracefulShutdown failsafe 设置 |

**理由**：
- 终端状态破损是最严重的用户可见问题（需要用户运行 reset）
- 即使清理挂起（例如 MCP 连接阻塞），也应该先让终端恢复正常

## 决策 4：Ink 卸载由我们调用而非 signal-exit

| 维度 | 说明 |
|------|------|
| 现状 | 显式调用 `inst.unmount()` 然后 `detachForShutdown()` |
| 备选 | 让 Ink 的 signal-exit 回调处理 |
| 选择 | 显式卸载 |
| 代价 | 与 Ink 内部实现耦合 |
| 证据 | cleanupTerminalModes 实现与注释 |

**理由**：
- 避免双重 EXIT_ALT_SCREEN 导致光标位置错误
- 保证 resume 提示写在正确的 buffer（main 而非 alt）
- 显式控制顺序比依赖 signal-exit 回调顺序更可靠

## 决策 5：npm 缓存清理不使用 cacache.verify()

| 维度 | 说明 |
|------|------|
| 现状 | 流式读取索引，按包分组保留最近 N 个 |
| 备选 | cacache.verify() |
| 选择 | 手动索引遍历 |
| 代价 | 重新实现部分 cacache 逻辑；不做完整性检查 |
| 证据 | cleanupNpmCacheForAnthropicPackages 实现与注释 |

**理由**：
- cacache.verify() 是 O(所有 blob)，大缓存需 60+ 秒
- 我们只需要删除 Anthropic 包，不需要验证整个缓存
- 完整性问题罕见，且 npm install 会自动修复

## 决策 6：进程身份使用开始时间而非创建时间哈希

| 维度 | 说明 |
|------|------|
| 现状 | Linux 使用 starttime jiffies；BSD/macOS 使用 lstart |
| 备选 | 通过启动命令行 + 环境哈希生成标识；创建时间戳 |
| 选择 | 内核提供的开始时间字段 |
| 代价 | Windows 暂不支持；jiffies 精度随 HZ 变化 |
| 证据 | processIdentity.ts 实现 |

**理由**：
- 命令行/环境可被操纵，且不同进程可能相同
- 创建时间戳在某些系统上只有 1 秒精度，容易碰撞
- starttime 是内核调度元数据，不可伪造且重用间隔长

## 决策 7：孤儿检测使用间隔检查而非 TTY 挂起信号

| 维度 | 说明 |
|------|------|
| 现状 | 30 秒间隔检查 stdout.writable / stdin.readable |
| 备选 | poll/select with timeout；SIGTTOU/SIGTTIN 捕获 |
| 选择 | 间隔检查 |
| 代价 | 最多 30 秒延迟检测；轻微轮询开销 |
| 证据 | setupGracefulShutdown 孤儿检测部分 |

**理由**：
- macOS 终端关闭行为是撤销 FD，不发送信号
- SIGTTOU/SIGTTIN 只在后台进程尝试写/读时产生，不可靠
- 30 秒是可接受的折中（比无限孤儿好）

## 决策 8：清理注册表使用 Set 而非数组

| 维度 | 说明 |
|------|------|
| 现状 | Set<() => Promise<void>> |
| 备选 | 数组；Map<id, fn> |
| 选择 | Set |
| 代价 | 无法保证执行顺序（当前是并行） |
| 证据 | cleanupRegistry.ts 实现 |

**理由**：
- 自动去重（同一函数多次注册无害）
- O(1) 插入/删除
- 当前设计要求清理函数独立、无顺序依赖
- 并行 Promise.all 比串行更快退出

## 决策 9：活动管理器 CLI 重叠时强制结束旧操作

| 维度 | 说明 |
|------|------|
| 现状 | 检测到 operationId 已存在时先 endCLIActivity |
| 备选 | 忽略第二次 start；抛出错误；嵌套计数 |
| 选择 | 强制结束旧操作 |
| 代价 | 可能低估时间；丢失嵌套信息 |
| 证据 | ActivityManager.startCLIActivity 实现与注释 |

**理由**：
- 重复 start 通常表示组件崩溃/unmount 未清理，旧操作已实际上结束
- 宁可低估活跃时间，不要高估（metrics 保守）
- 嵌套计数会增加复杂度，当前不需要

## 决策 10：终端 disable 序列无条件发送

| 维度 | 说明 |
|------|------|
| 现状 | 不检查是否支持，全部发送 |
| 备选 | 按 termcap/terminfo 能力发送；跟踪我们启用了什么 |
| 选择 | 全部发送 |
| 代价 | 可能写入少量终端忽略的字节 |
| 证据 | cleanupTerminalModes 注释 |

**理由**：
- 终端检测复杂且容易出错（尤其是 tmux/screen/ssh 链）
- 不支持的序列被静默忽略（这是终端设计的一部分）
- 跟踪启用状态需要维护状态机，增加复杂度和出错可能
- 遗漏禁用序列后果严重（终端破损）
