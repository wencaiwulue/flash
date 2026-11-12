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
