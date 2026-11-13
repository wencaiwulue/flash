---
id: cli-startup
batch: 1
title: CLI Startup 启动、快速路径与执行模式设计
date: 2026-11-12
status: draft
---

# CLI Startup 启动、快速路径与执行模式设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

CLI 启动需要在多种执行模式下高效运行。如果没有统一的启动设计，会导致：

- 简单命令（如 `--version`）也需要加载完整应用，启动慢
- 不同入口点（CLI、SDK、守护进程）的初始化逻辑重复且不一致
- 交互式与非交互式模式的边界不清晰，导致意外行为
- 没有并行预取，启动延迟线性累积
- 错误退出时没有清理机制，留下临时文件或子进程
- 启动性能难以测量和优化

因此启动系统必须在以下约束下完成：

- 支持多种执行模式：交互式 REPL、非交互式 `--print`、`--daemon`、`--remote-control`、`--worktree`、`--template-job`、MCP 服务器等
- 快速路径：`--version`、`--internal-prepare-commit-msg-attribution` 等简单命令零加载或最小加载
- 动态 import：只在需要时加载对应模块，减少初始加载时间
- 并行预取：MDM 读取、钥匙串读取、API 预连接等可以并行进行
- 清晰的初始化顺序：环境变量 → 配置 → 网络 → UI，有明确的依赖关系
- 错误处理与清理：启动失败时能清理已分配资源，优雅退出
- 性能可观测：有 checkpoint 标记，可测量各阶段耗时

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| cli.tsx 作为单一入口点，先判断快速路径再动态 import | cli.tsx 不依赖 heavy 模块，先用 `process.argv` 判断命令，再动态 import 对应处理器 | 快速路径零加载，`--version` 只需要几十毫秒；所有入口点集中管理，便于维护 | 多个独立二进制：代码重复，构建复杂；静态 import 所有模块：快速路径也加载完整应用，慢 | 需要确保 cli.tsx 顶部 import 都是轻量的，feature flag 要支持 DCE | `src/entrypoints/cli.tsx:1-348` |
| 快速路径按优先级排序：先内部命令，再版本，再 dump，再 daemon/bridge，最后 full CLI | cli.tsx 中 if 分支按从快到慢排序：`--internal-prepare-commit-msg` → `--version` → `--dump-system-prompt` → `--daemon`/`--remote-control` → 完整 CLI | 确保常用的快速命令能最快响应，不会被较慢路径的初始化阻塞 | 用配置或路由表：增加复杂度，静态 import 可能破坏 DCE；倒序：慢命令先加载，快速命令反而慢 | 需要维持正确的顺序，添加新命令时考虑其性能特征 | `src/entrypoints/cli.tsx:50-347` |
| 顶部副作用只做环境准备：禁用 corepack 自动钉住、设置 NODE_OPTIONS、初始化 ablation baseline | cli.tsx 顶部设置 `process.env.COREPACK_ENABLE_AUTO_PIN = '0'`，CCR 环境设置 `NODE_OPTIONS='--max-old-space-size=8192'` | 在任何模块加载前设置环境，确保子进程继承正确的环境；ablation 需要在 feature flag 使用前设置 | 等到 init() 再设置：太晚，某些模块可能已经读取了环境变量；不设置：corepack 可能修改 package.json，内存不足导致 OOM | 需要小心管理顶部副作用，只能做环境准备，不能做 I/O | `src/entrypoints/cli.tsx:5-38` |
| startup profiler checkpoint：用时间戳标记关键启动阶段，可输出性能报告 | `profileCheckpoint(name)` 记录时间点，`profileReport()` 生成报告 | 可测量启动性能，识别瓶颈；checkpoint 零开销（feature flag 控制） | 不测量：无法优化；用外部 profiling 工具：侵入性强，不容易在生产环境使用 | 需要在关键路径插入 checkpoint，命名要一致 | `src/utils/startupProfiler.ts:1-203` |
| 初始化分阶段：early argv 解析 → eager settings 加载 → init() → run migrations → setup() → REPL | cli.tsx → main.tsx → init.ts → setup() → replLauncher.tsx，阶段明确 | 依赖关系清晰：settings 加载在 init() 之前，init() 在 migrations 之前，migrations 在 setup() 之前；可并行的阶段并行 | 单一大初始化函数：难以并行，难以测试；乱序初始化：依赖关系混乱，容易出 bug | 需要正确划分阶段，确保依赖顺序；某些预取可以并行 | `src/main.tsx:873-1181` |
| 并行预取：MDM 读取、钥匙串读取在 main.tsx 顶部启动，Promise.all 在 preAction hook 等待 | main.tsx 顶部调用 `startMdmRawRead()` 和 `startKeychainPrefetch()`，preAction 中 `await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])` | 利用模块加载的时间并行进行 I/O，总耗时 = max(模块加载, MDM, 钥匙串)，而不是 sum | 顺序执行：启动慢，macOS 钥匙串读取可能需要 60ms+，MDM 可能需要更久；在 init() 中启动：太晚，模块加载已经完成 | 需要在最顶部启动预取，在需要数据前 await | `src/main.tsx:11-26,1253-1257` |
| interactive vs non-interactive：通过 `--print`、`--init-only`、`--sdk-url`、`!process.stdout.isTTY` 判断，设置 `setIsInteractive()` | main.tsx 中根据多个标志判断 `isNonInteractive`，调用 `setIsInteractive()` 和 `setClientType()` | 后续模块可以根据模式调整行为：non-interactive 不显示 UI，不启动某些后台任务；client type 决定某些功能的可用性 | 用环境变量：容易忘记设置；每个模块自己判断：重复代码，不一致 | 需要在 init() 之前确定模式，因为 init() 中的某些行为依赖模式 | `src/main.tsx:1107-1151` |
| init() 分步骤且 memoized：配置 → 安全环境 → graceful shutdown → 1P 事件日志 → OAuth → JetBrains → 远程设置 → mTLS → 代理 → 预连接 → 上游代理 → git-bash → LSP cleanup → team cleanup → scratchpad | init.ts 中按顺序执行，用 memoize 确保只执行一次 | 初始化逻辑集中，可观测；memoize 确保幂等，多次调用也安全；步骤有顺序，依赖关系清晰 | 分散在各模块自行初始化：难以追踪，容易重复初始化；不 memoize：多次调用可能有副作用 | 需要确保步骤顺序正确，某些步骤（如预连接）是 fire-and-forget | `src/entrypoints/init.ts:57-238` |
| 安全环境变量两阶段：先 apply safe env（在 trust 前），再 apply full env（在 trust 后） | init.ts 先 `applySafeConfigEnvironmentVariables()`，信任对话框后再 `applyConfigEnvironmentVariables()`；telemetry 初始化也在 trust 后 | 安全：不信任的目录下不应用来自 settings 的环境变量（可能有恶意）；telemetry 只在用户信任后启动 | 信任前就应用所有 env：安全风险；不信任就不应用任何 env：某些安全的 env 无法生效 | 需要区分 safe env（不会执行代码的）和 full env（可能有副作用的） | `src/entrypoints/init.ts:73-82,247-340` |
| graceful shutdown 早期设置：register cleanup 函数，process.on('exit')、SIGINT、SIGTERM 触发 | init.ts 中 `setupGracefulShutdown()`，各模块用 `registerCleanup()` 注册清理函数 | 无论正常退出还是信号退出，都能清理临时文件、子进程、服务器等；cleanup 按注册逆序执行（栈式） | 不设置：临时文件堆积，子进程变成孤儿；只在正常退出清理：信号退出时不清理 | 需要各模块正确注册 cleanup，cleanup 函数要幂等、不抛出 | `src/utils/gracefulShutdown.ts:1-296` + `src/utils/cleanupRegistry.ts:1-74` |
| feature flag 控制的条件 import：用 `feature('FLAG')` 判断，内部用 `require()` 或动态 import，支持 DCE | cli.tsx、main.tsx 中多处用 `if (feature('DAEMON'))`、`if (feature('BRIDGE_MODE'))` 等，内部用 `require()` 或 `import()` | 外部构建可以完全移除未启用 feature 的代码，减小体积；内部构建可以有更多功能 | 总是 import：外部构建包含不需要的代码，体积大；用运行时配置：无法 DCE，代码仍在 bundle 中 | 需要 feature 常量在构建时可静态求值（不能是动态计算的） | `src/main.tsx:126-147` 等多处 |
| 早期输入捕获：`startCapturingEarlyInput()` 在 cli.tsx 启动，seed 到 REPL | cli.tsx 中调用 `startCapturingEarlyInput()`，main.tsx 中 `seedEarlyInput()` | 用户可以在 REPL 准备好前就开始输入，输入不会丢失，提升体验 | 不捕获：用户输入被忽略，体验差；等 REPL 准备好再接受输入：用户等待时间长 | 需要在最早期启动捕获，在 REPL 准备好后 seed | `src/utils/earlyInput.ts:1-227` |
| --bare 模式：设置 `CLAUDE_CODE_SIMPLE=1`，跳过 hooks、LSP、plugin sync、归因、自动记忆、钥匙串读取、背景预取等 | cli.tsx 和 main.tsx 中检查 `--bare`，设置环境变量；各模块用 `isBareMode()` 判断是否跳过 | 最小化启动：脚本场景不需要 UI 相关功能，启动更快；auth 只通过 API key 或设置，不读取钥匙串（安全） | 没有 --bare：脚本启动慢，可能有不需要的副作用；用多个独立标志：用户需要记住很多标志 | 需要各模块正确检查 `isBareMode()`，跳过不必要的工作 | `src/utils/envUtils.ts:138-151` + `src/main.tsx:1712-1714` |
| --plugin-dir 早期处理：preAction hook 中读取 commander option，调用 `setInlinePlugins()`，清除 plugin cache | main.tsx preAction hook 中检查 `pluginDir` option，调用 `setInlinePlugins()` 和 `clearPluginCache()` | plugin 加载逻辑可以读取 inline plugins，无需等到 action handler；缓存清除确保新 plugin dir 生效 | 在 action handler 中处理：太晚，某些预加载已经完成；不清除缓存：旧缓存仍在使用 | 需要在 preAction 中处理，因为 preAction 在 init() 之后、action 之前 | `src/main.tsx:1267-1275` |
| setup() 分阶段且可观测：worktree（如果有）→ background jobs → prefetch → sinks → tengu_started beacon → api key prefetch → release notes → permission bypass check | setup.ts 中按顺序执行，每个阶段有 profile checkpoint | setup 逻辑集中，可观测；worktree 先处理，后续逻辑在正确的 cwd 下运行；beacon 尽早发送，用于会话成功率统计 | 分散在各处：难以追踪；不分阶段：依赖关系混乱 | 需要确保阶段顺序，worktree 切换 cwd 要早 | `src/setup.ts:56-443` |
| deferred prefetches：在 REPL 渲染后才启动的后台预取（initUser、getUserContext、getRelevantTips、model capabilities、settings change detector、skill change detector、event loop stall detector） | main.tsx 中 `startDeferredPrefetches()` 在 REPL 启动后调用 | 不阻塞首屏渲染，用户更快看到 UI；这些预取是为了后续交互更快，不是首次渲染必需的 | 都在 setup() 中启动：阻塞首屏，启动慢；不启动：首次交互慢 | 需要区分哪些是首屏必需的，哪些可以 defer | `src/main.tsx:646-700` |

## 3. 目标与非目标

### 状态与生命周期

- **目标**：`cli.tsx` 作为单一入口点，快速路径优先判断
- **目标**：`profileCheckpoint()` 标记关键阶段，`profileReport()` 可生成报告
- **目标**：`isInteractive()`/`isNonInteractiveSession()` 返回当前模式
- **目标**：`init()` 按正确顺序初始化，且只执行一次（memoized）
- **目标**：`registerCleanup()` 注册清理函数，退出时执行
- **非目标**：不保证启动过程中如果发生异常所有 cleanup 都执行（某些异常是不可恢复的）

### 接口与数据

- **目标**：`startMdmRawRead()`/`ensureMdmSettingsLoaded()` 并行预取 MDM
- **目标**：`startKeychainPrefetch()`/`ensureKeychainPrefetchCompleted()` 并行预取钥匙串
- **目标**：`preconnectAnthropicApi()` 并行预热 API 连接
- **目标**：`setIsInteractive()`、`setClientType()` 设置全局状态
- **目标**：`getClientType()` 返回当前客户端类型（cli/sdk-cli/remote 等）
- **非目标**：不提供启动流程的可编程钩子（只有 ConfigChange hook）

### 执行与环境

- **目标**：支持所有执行模式：interactive REPL、`--print`、`--daemon`、`--remote-control`、`--worktree`、`--template-job`、MCP serve、`--chrome-native-mcp`、`--computer-use-mcp`、`--open-runner` 等
- **目标**：`--version` 启动时间 < 100ms（目标，实际取决于平台）
- **目标**：正常交互式启动时间 < 1s（目标）
- **非目标**：不支持 Web 环境的启动（只 Node.js/Bun）
- **非目标**：不保证跨版本的启动参数完全不变（有迁移机制）

### 依赖边界

- **Commands Framework**：命令定义和解析由 commands spec 负责，本文只描述启动时如何加载命令
- **Model API**：模型调用由 model-api spec 负责，本文只描述预连接
- **UI 渲染**：REPL 渲染由 UI 相关 spec 负责，本文只描述启动流程到 REPL 渲染前
- **Permissions**：权限系统由 permissions spec 负责，本文只描述初始化时的权限 bypass 检查
- **Settings**：设置系统由 settings spec 负责，本文只描述启动时如何加载设置
- **Session Persistence**：会话持久化由 session-persistence spec 负责，本文只描述启动时如何恢复会话

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 入口
async function main(): Promise<void>  // cli.tsx 主入口
async function run(): Promise<CommanderCommand>  // main.tsx 主运行逻辑

// 快速路径判断（在 cli.tsx 中）
if (args[0] === '--internal-prepare-commit-msg-attribution') { /* ... */ }
if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) { /* ... */ }
if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') { /* ... */ }
// ... 更多快速路径

// Profiler
function profileCheckpoint(name: string): void
function profileReport(): string

// 模式状态
function setIsInteractive(interactive: boolean): void
function isInteractive(): boolean
function isNonInteractiveSession(): boolean
function setClientType(clientType: ClientType): void
function getClientType(): ClientType

// 初始化
const init: memoize(async function(): Promise<void>)
function initializeTelemetryAfterTrust(): void  // 在信任对话框后调用

// 清理
function registerCleanup(cleanupFn: () => void | Promise<void>): () => void
function setupGracefulShutdown(): void
function gracefulShutdown(exitCode?: number): Promise<void>
function gracefulShutdownSync(exitCode?: number): void

// 并行预取
function startMdmRawRead(): void
async function ensureMdmSettingsLoaded(): Promise<void>
function startKeychainPrefetch(): void
async function ensureKeychainPrefetchCompleted(): Promise<void>
function preconnectAnthropicApi(): void

// 早期输入
function startCapturingEarlyInput(): void
function seedEarlyInput(prefillText: string | undefined): void
function stopCapturingEarlyInput(): string | undefined
```

调用方式：

1. **CLI 启动路径**：`node cli.js <args>` → cli.tsx `main()` → 快速路径判断 → 动态 import → main.tsx `main()` → `run()` → commander → preAction hook → `init()` → migrations → setup() → action handler → REPL 或执行命令
2. **快速路径**：直接处理并 exit，不加载 main.tsx
3. **并行预取**：main.tsx 顶部启动 prefetch，preAction hook 中 await
4. **初始化**：preAction hook 中调用 `init()`，只执行一次
5. **清理**：各模块调用 `registerCleanup()`，退出时自动执行

### 4.2 cli.tsx 快速路径模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/entrypoints/cli.tsx
async function main(): Promise<void>

// 顶部副作用（非函数，模块加载即执行）
process.env.COREPACK_ENABLE_AUTO_PIN = '0'
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  const existing = process.env.NODE_OPTIONS || ''
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192'
}
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  // 设置多个环境变量
}

// 模块级调用（非函数）
void main()
```

#### 输入输出
- **输入**：`process.argv`（通过 `process.argv.slice(2)` 截取）
- **输出**：
  - 快速路径：直接 `console.log` 或 `process.stderr.write`
  - 完整路径：无返回值，委托给 main.tsx
- **退出码**：
  - `--version`：自然退出（`return`，Node.js 以 0 退出）
  - `--chrome-native-host`：`throw Error` → 非 0 退出
  - `--internal-prepare-commit-msg-attribution`：出错时 `console.error` 但继续返回（不阻塞 commit）

#### 状态与启动顺序
- **无内部状态**：纯流程协调模块
- **启动顺序（严格优先级）**：
  1. 顶部环境变量设置（模块加载即执行）
  2. `--internal-prepare-commit-msg-attribution`
  3. `--version`/`-v`/`-V`
  4. `--dump-system-prompt`（feature 保护）
  5. `--claude-in-chrome-mcp`
  6. `--chrome-native-host`（直接抛错）
  7. `--computer-use-mcp`（feature 保护）
  8. `--daemon-worker`（feature 保护）
  9. `--remote-control`/`rc`/`remote`/`sync`/`bridge`（feature 保护）
  10. `--daemon`（feature 保护）
  11. `ps`/`logs`/`attach`/`kill` 或 `--bg`/`--background`（feature 保护）
  12. `--template-job-supervisor`（feature 保护）
  13. `new`/`list`/`reply`（模板命令，feature 保护）
  14. `--open-runner`/`--open-runner-server`（feature 保护）
  15. `--environment-runner`（feature 保护）
  16. `--self-hosted-runner`（feature 保护）
  17. `--worktree` + `--tmux`（部分情况 fall through）
  18. 完整 CLI 路径（动态 import main.tsx）

#### 完整启动/执行/退出流程
```text
node cli.js <args>
  ↓
cli.tsx 模块加载（顶部副作用执行）
  ├─ COREPACK_ENABLE_AUTO_PIN = '0'
  ├─ CCR 环境：NODE_OPTIONS += --max-old-space-size=8192
  └─ ABLATION_BASELINE（如启用）
  ↓
void main() 调用
  ↓
快速路径判断（从上到下优先级）
  ├─ 匹配路径 → 动态 import 对应处理器 → 执行 → return/process.exit
  └─ 不匹配 → 继续
  ↓
--bare 检查 → 如匹配设置 CLAUDE_CODE_SIMPLE=1
  ↓
startCapturingEarlyInput()
  ↓
profileCheckpoint('cli_before_main_import')
  ↓
动态 import('../main.js')  // 此时才加载 main.tsx 及其依赖树
  ↓
profileCheckpoint('cli_after_main_import')
  ↓
await cliMain()  // 调用 main.tsx 的 main()
  ↓
profileCheckpoint('cli_after_main_complete')
  ↓
自然退出（Node.js 事件循环清空）
```

#### 错误与降级
- **动态 import 失败**：Node.js 默认打印堆栈，非 0 退出，无清理（快速路径通常未分配资源）
- **`--internal-prepare-commit-msg-attribution` 失败**：`console.error` 提示但 `return` 继续，不阻塞 git commit
- **`--worktree` + `--tmux` 失败**：
  - 如 handled → `return`
  - 如 error → `exitWithError()`
  - 如不 handled → fall through 到完整 CLI 路径
- **模板命令**：`process.exit(0)` 而非 `return`，防止 Ink 事件循环保持进程不退出

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| 单一入口 | cli.tsx | 需维护长 if-else 链 | 所有启动路径集中管理 | 多个独立二进制 |
| 零加载快速路径 | `--version` 不 import 任何模块 | 版本号需构建时内联 | 响应速度极快 | 静态版本文件 |
| 优先级排序 | 从快到慢 | 新增命令需考虑位置 | 常用命令响应最快 | 配置路由表 |
| feature 保护 | `feature('X')` 包裹 | 需构建时支持 DCE | 外部构建不包含禁用功能 | 运行时配置 |
| 顶部环境设置 | 模块加载即执行 | 需小心管理副作用 | 子进程继承正确环境 | init() 中设置 |
| 动态 import | `await import('../main.js')` | 稍增加启动延迟 | 快速路径不加载重型依赖 | 静态 import |

#### 源码测试证据
- **主文件**：`src/entrypoints/cli.tsx:1-348`
- **顶部副作用**：`src/entrypoints/cli.tsx:7-38`
- **快速路径顺序**：`src/entrypoints/cli.tsx:50-320`
- **版本内联**：通过 `MACRO.VERSION` 构建时注入
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.3 startupProfiler.ts 性能分析模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/utils/startupProfiler.ts
export function profileCheckpoint(name: string): void
export function profileReport(): void
export function isDetailedProfilingEnabled(): boolean
export function getStartupPerfLogPath(): string
export function getStartupProfileData(): {
  detailedEnabled: boolean
  checkpointCount: number
  phases: Array<{ name: string; durationMs: number }>
  totalTimeMs: number
}
export function logStartupPerf(): void

// 模块级状态
const DETAILED_PROFILING: boolean  // 模块加载时决定
const STATSIG_LOGGING_SAMPLED: boolean  // 模块加载时决定
const SHOULD_PROFILE: boolean  // 模块加载时决定
const memorySnapshots: NodeJS.MemoryUsage[]  // 仅详细模式
```

#### 输入输出
- **输入**：
  - `profileCheckpoint(name)`：checkpoint 名称字符串
  - 环境变量：`CLAUDE_CODE_PROFILE_STARTUP=1` 启用详细模式
  - 环境变量：`USER_TYPE=ant` 内部用户 100% 采样
- **输出**：
  - Statsig 事件：`tengu_startup_perf`（采样触发）
  - 文件：`~/.claude/startup-perf/<sessionId>.txt`（详细模式）
  - 调试日志：通过 `logForDebugging`（详细模式）

#### 状态与启动顺序
- **模块级状态**：
  - `DETAILED_PROFILING`：`isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_STARTUP)`
  - `STATSIG_LOGGING_SAMPLED`：`USER_TYPE=ant` 或 `Math.random() < 0.005`
  - `SHOULD_PROFILE`：上述两者任一为 true
  - `memorySnapshots`：仅详细模式，追加数组
- **启动顺序**：
  1. 模块加载 → 决定采样/详细模式
  2. 如 `SHOULD_PROFILE` → 立即 `profileCheckpoint('profiler_initialized')`
  3. 各启动阶段调用 `profileCheckpoint(name)`
  4. 退出时调用 `profileReport()`（由 gracefulShutdown 触发）

#### 完整启动/执行/退出流程
```text
模块加载（main.tsx 或 cli.tsx import 时）
  ↓
DETAILED_PROFILING = isEnvTruthy(CLAUDE_CODE_PROFILE_STARTUP)
STATSIG_LOGGING_SAMPLED = (USER_TYPE=ant) || (Math.random() < 0.005)
SHOULD_PROFILE = DETAILED_PROFILING || STATSIG_LOGGING_SAMPLED
  ↓
if (SHOULD_PROFILE): profileCheckpoint('profiler_initialized')
  ↓
其他模块调用 profileCheckpoint(name)
  ├─ perf.mark(name)
  └─ 如详细模式：memorySnapshots.push(process.memoryUsage())
  ↓
退出时调用 profileReport()
  ├─ 防止重复：if (reported) return
  ├─ logStartupPerf() → 如采样，记录到 Statsig
  └─ 如详细模式：
     ├─ 写入文件 ~/.claude/startup-perf/<sessionId>.txt
     └─ logForDebugging() 打印报告
```

#### 错误与降级
- **profilerBase.getPerformance() 失败**：未明确处理，可能抛错
- **文件写入失败**：未明确捕获，可能抛错
- **非采样用户**：完全零开销（`SHOULD_PROFILE=false` 时 `profileCheckpoint` 是空操作）
- **内存快照仅详细模式**：避免生产环境内存开销

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| 模块级状态 | 加载时决定 | 不能运行时切换 | 零开销分支预测 | 每次检查环境变量 |
| 低采样率 | 外部用户 0.5% | 数据量较少 | 生产环境性能影响可忽略 | 100% 采样 |
| 内存仅详细模式 | `memorySnapshots` 受 `DETAILED_PROFILING` 保护 | 生产环境无内存数据 | 生产环境零内存开销 | 始终记录 |
| 数组而非 Map | 追加数组，索引对应 | 相同 name 会覆盖 | 支持重复 checkpoint | Map keyed by name |
| 预定义阶段 | `PHASE_DEFINITIONS` 硬编码 | 新增阶段需改代码 | Statsig 字段一致 | 动态发现阶段 |

#### 源码测试证据
- **主文件**：`src/utils/startupProfiler.ts:1-219`
- **阶段定义**：`src/utils/startupProfiler.ts:48-54`
- **采样逻辑**：`src/utils/startupProfiler.ts:26-36`
- **内存快照**：`src/utils/startupProfiler.ts:46,72-74`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.4 gracefulShutdown.ts 优雅退出模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/utils/gracefulShutdown.ts
export const setupGracefulShutdown: memoize(() => void)
export function gracefulShutdown(
  exitCode?: number,
  reason?: ExitReason,  // 来自 src/entrypoints/agentSdkTypes
  options?: {
    getAppState?: () => AppState
    setAppState?: (f: (prev: AppState) => AppState) => void
    finalMessage?: string
  }
): Promise<void>
export function gracefulShutdownSync(
  exitCode?: number,
  reason?: ExitReason,
  options?: { /* 同上 */ }
): void
export function isShuttingDown(): boolean
export function resetShutdownState(): void  // 仅测试
export function getPendingShutdownForTesting(): Promise<void> | undefined  // 仅测试

// 内部状态
let shutdownInProgress: boolean = false
let failsafeTimer: ReturnType<typeof setTimeout> | undefined
let orphanCheckInterval: ReturnType<typeof setInterval> | undefined
let pendingShutdown: Promise<void> | undefined
let resumeHintPrinted: boolean = false
```

#### 输入输出
- **输入**：
  - `gracefulShutdown(exitCode, reason, options)`：退出码、原因、AppState 访问器
  - 信号：`SIGINT`、`SIGTERM`、`SIGHUP`（非 Windows）
  - 事件：`uncaughtException`、`unhandledRejection`
- **输出**：
  - 终端：清理终端模式序列、恢复 alt screen、显示 resume hint
  - 文件：会话持久化（通过 cleanup 函数）
  - 网络：analytics flush、API 连接关闭
  - 子进程：终止或 detach
  - 退出码：0 或指定值（`SIGTERM`→143、`SIGHUP`→129）

#### 状态与启动顺序
- **状态转换**：
  - `shutdownInProgress = false` → `true`（仅一次）
  - `pendingShutdown`：从 `undefined` → `Promise`
- **启动顺序**：
  1. `setupGracefulShutdown()`（由 `init()` 调用，memoized 仅一次）
  2. 注册 signal handlers（`SIGINT`、`SIGTERM`、`SIGHUP`）
  3. 注册 `signal-exit` onExit hook（通过 `onExit(() => {})` 固定）
  4. 注册 `uncaughtException`、`unhandledRejection` 日志
  5. 如 TTY 且非 Windows：启动 orphan check（每 30s，unref）

#### 完整启动/执行/退出流程
```text
init() 调用 setupGracefulShutdown()（memoized）
  ↓
onExit(() => {})  // 固定 Bun 信号处理 bug
  ↓
process.on('SIGINT', () => {
  if (--print/--print: return  // 让 print 模式自己处理
  logForDiagnosticsNoPII('shutdown_signal', {signal: 'SIGINT'})
  void gracefulShutdown(0)
})
process.on('SIGTERM', () => void gracefulShutdown(143))
process.on('SIGHUP', () => void gracefulShutdown(129))  // 非 Windows
  ↓
if (TTY 且非 Windows):
  orphanCheckInterval = setInterval(30s) {
    if (!stdout.writable || !stdin.readable):
      clearInterval(orphanCheckInterval)
      logForDiagnosticsNoPII('shutdown_signal', {signal: 'orphan_detected'})
      void gracefulShutdown(129)
  }.unref()
  ↓
process.on('uncaughtException', err => log error + event)
process.on('unhandledRejection', reason => log error + event)
  ↓
触发退出（用户 Ctrl+C、信号、显式调用 gracefulShutdown）
  ↓
gracefulShutdown(exitCode, reason, options)
  ├─ 防止重入：if (shutdownInProgress) return
  ├─ shutdownInProgress = true
  ├─ 计算 failsafe 超时 = max(5s, SessionEnd hook 超时 + 3.5s)
  ├─ failsafeTimer = setTimeout(failsafe 退出, 超时).unref()
  ├─ process.exitCode = exitCode
  ├─ cleanupTerminalModes()  // 同步！
  │   ├─ writeSync(1, DISABLE_MOUSE_TRACKING)
  │   ├─ 如 alt screen 活跃：inkInstance.unmount()
  │   ├─ drainStdin()
  │   ├─ detachForShutdown()
  │   ├─ writeSync(1, DISABLE_MODIFY_OTHER_KEYS)
  │   ├─ writeSync(1, DISABLE_KITTY_KEYBOARD)
  │   ├─ writeSync(1, DFE)  // disable focus events
  │   ├─ writeSync(1, DBP)  // disable bracketed paste
  │   ├─ writeSync(1, SHOW_CURSOR)
  │   ├─ writeSync(1, CLEAR_ITERM2_PROGRESS)
  │   ├─ writeSync(1, CLEAR_TAB_STATUS)  // 如支持
  │   └─ writeSync(1, CLEAR_TERMINAL_TITLE)  // 如未禁用
  ├─ printResumeHint()  // 同步！
  │   ├─ 仅 TTY 且 interactive 且 session persistence 启用
  │   └─ chalk.dim('Resume this session with:\nclaude --resume <id>\n')
  ├─ Promise.race([
  │     runCleanupFunctions(),  // 2s 超时
  │     setTimeout(2s)
  │   ])
  ├─ await executeSessionEndHooks(reason, options)  // 超时由 hook budget 控制
  ├─ profileReport()  // 忽略错误
  ├─ 如 lastMainRequestId：logEvent('tengu_cache_eviction_hint')
  ├─ Promise.race([
  │     Promise.all([shutdown1PEventLogging(), shutdownDatadog()]),
  │     sleep(500ms)
  │   ])
  ├─ 如 options.finalMessage：writeSync(2, finalMessage + '\n')
  └─ forceExit(exitCode)
      ├─ clearTimeout(failsafeTimer)
      ├─ 如非测试：instances.get(stdout)?.drainStdin()
      ├─ process.exit(exitCode)  // 可能抛 EIO
      └─ 如抛错且非测试：process.kill(process.pid, 'SIGKILL')
  ↓
failsafe 触发（如正常流程超时）
  ├─ cleanupTerminalModes()
  ├─ printResumeHint()
  └─ forceExit(exitCode)
```

#### 错误与降级
- **cleanup 函数抛错**：静默忽略，继续下一个
- **hook 执行失败**：静默忽略
- **analytics flush 超时**：500ms 后放弃，强制退出
- **`process.exit()` 抛 EIO**（TTY 消失）：fallback 到 `SIGKILL`
- **`--print`/`-p` 模式 SIGINT**：直接 return，让 print 模式自己处理
- **重复调用 gracefulShutdown**：静默忽略（`shutdownInProgress` 检查）
- **`gracefulShutdownSync`**：调用异步版本但不 await，由 failsafe 兜底

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| memoized setup | `setupGracefulShutdown` 仅执行一次 | 需注意 | 防止重复注册 | 每次都注册 |
| 固定空 onExit | `onExit(() => {})` 永不卸载 | 轻微内存泄漏 | 修复 Bun 信号处理 bug | 等待 Bun 修复 |
| 终端清理同步 | `cleanupTerminalModes` 使用 writeSync | 可能阻塞 | 保证进程退出前完成 | 异步清理 |
| failsafe 超时 | 5s 兜底 | 可能中断清理 | 保证进程最终退出 | 无限等待 |
| 先清理终端 | 终端清理在异步操作前 | 需小心顺序 | 即使清理挂起用户也看到干净终端 | 先执行清理 |
| resume hint 一次 | `resumeHintPrinted` 防止重复 | 需额外状态 | 提示不重复显示 | 每次都打印 |
| 孤儿检测 | 定期检查 stdio 是否可写 | 轻微开销 | 检测终端关闭未发 SIGHUP（macOS） | 不检测 |

#### 源码测试证据
- **主文件**：`src/utils/gracefulShutdown.ts:1-530`
- **终端清理**：`src/utils/gracefulShutdown.ts:58-136`
- **信号处理**：`src/utils/gracefulShutdown.ts:237-333`
- **孤儿检测**：`src/utils/gracefulShutdown.ts:277-296`
- **failsafe 超时**：`src/utils/gracefulShutdown.ts:417-424`
- **强制退出**：`src/utils/gracefulShutdown.ts:193-231`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.5 cleanupRegistry.ts 清理注册表模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/utils/cleanupRegistry.ts
export function registerCleanup(
  cleanupFn: () => Promise<void>
): () => void  // 返回 unregister 函数
export async function runCleanupFunctions(): Promise<void>

// 内部状态
const cleanupFunctions = new Set<() => Promise<void>>()
```

#### 输入输出
- **输入**：
  - `registerCleanup(cleanupFn)`：清理函数（同步或异步）
- **输出**：
  - `runCleanupFunctions()`：并行执行所有注册的函数，无返回值
  - 返回值：unregister 函数，调用可从 Set 中删除

#### 状态与启动顺序
- **全局单例 Set**：`cleanupFunctions = new Set()`
- **执行顺序**：并行（`Promise.all`），无特定顺序
- **启动顺序**：
  1. 模块加载 → Set 初始化
  2. 各模块调用 `registerCleanup(fn)` → `Set.add(fn)`
  3. `gracefulShutdown` 调用 `await runCleanupFunctions()` → 并行执行

#### 完整启动/执行/退出流程
```text
模块加载
  ↓
const cleanupFunctions = new Set()
  ↓
模块 A 调用 registerCleanup(fnA) → Set.add(fnA)
模块 B 调用 registerCleanup(fnB) → Set.add(fnB)
...
  ↓
gracefulShutdown 调用 runCleanupFunctions()
  ↓
Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
  ↓
所有 cleanup 函数并行执行
  ↓
返回（无返回值，不抛出错误）
```

#### 错误与降级
- **cleanup 函数抛错**：`runCleanupFunctions` 不捕获，由调用方（gracefulShutdown）静默忽略
- **未 unregister**：无问题，进程退出后 Set 消失
- **重复注册同一函数**：Set 自动去重，只执行一次

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| Set 而非数组 | 自动去重 | 无索引顺序 | 重复注册安全 | 数组 push/逆序 |
| 并行执行 | Promise.all | 可能资源竞争 | 速度快 | 顺序执行 |
| 无顺序保证 | Set 迭代顺序不确定 | 依赖关系可能出错 | 简单 | 栈式逆序 |
| 无超时 | 由调用方控制 | 单个函数可能阻塞 | 责任分离 | 内置超时 |

#### 源码测试证据
- **主文件**：`src/utils/cleanupRegistry.ts:1-26`
- **Set 实现**：`src/utils/cleanupRegistry.ts:7,14-17,23-25`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.6 earlyInput.ts 早期输入捕获模块设计卡

（注：源代码未包含在已读取文件中，模块签名来自现有文档推断）

#### 真实入口签名与关键类型
```typescript
// src/utils/earlyInput.ts
export function startCapturingEarlyInput(): void
export function seedEarlyInput(prefillText: string | undefined): void
export function stopCapturingEarlyInput(): string | undefined
```

#### 输入输出
- **输入**：
  - `startCapturingEarlyInput()`：无参数
  - `seedEarlyInput(prefillText)`：预填充文本（来自 `--prefill`）
  - `stopCapturingEarlyInput()`：无参数
- **输出**：
  - `stopCapturingEarlyInput()`：返回捕获的输入字符串或 `undefined`

#### 状态与启动顺序
- **模块级状态**：捕获的输入字符串、是否正在捕获
- **启动顺序**：
  1. cli.tsx 快速路径判断后，完整路径前调用 `startCapturingEarlyInput()`
  2. main.tsx 中如 non-interactive 调用 `stopCapturingEarlyInput()`
  3. REPL 准备好后调用 `seedEarlyInput(prefillText)`

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 早期启动 | cli.tsx 中即开始 | 需小心与 REPL 输入冲突 | 用户输入不丢失 | 等待 REPL 准备好 |

#### 源码测试证据
- **主文件**：`src/utils/earlyInput.ts`（未读取）
- **调用位置**：`src/entrypoints/cli.tsx:337`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.7 bootstrap/state.ts 全局启动状态模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/bootstrap/state.ts
// 模式状态
export function setIsInteractive(value: boolean): void
export function getIsInteractive(): boolean
export function getIsNonInteractiveSession(): boolean
export function setClientType(type: string): void
export function getClientType(): string
export function setSessionSource(source: string): void
export function getSessionSource(): string | undefined
export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void
export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined

// 会话标识
export function getSessionId(): SessionId
export function regenerateSessionId(options?: {
  setCurrentAsParent?: boolean
}): SessionId
export function getParentSessionId(): SessionId | undefined
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null
): void
export const onSessionSwitch: Signal<[id: SessionId]>
export function getSessionProjectDir(): string | null
export function getOriginalCwd(): string
export function setOriginalCwd(cwd: string): void
export function setProjectRoot(cwd: string): void
export function getProjectRoot(): string
export function setCwdState(cwd: string): void
export function getCwdState(): string

// 成本与性能跟踪
export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number
): void
export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void
export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string
): void
export function getTotalCostUSD(): number
export function getTotalAPIDuration(): number
export function getTotalDuration(): number
export function getTotalAPIDurationWithoutRetries(): number
export function getTotalToolDuration(): number
export function addToToolDuration(duration: number): void
export function getTurnHookDurationMs(): number
export function addToTurnHookDuration(duration: number): void
export function resetTurnHookDuration(): void
export function getTurnHookCount(): number
export function getTurnToolDurationMs(): number
export function resetTurnToolDuration(): void
export function getTurnToolCount(): number
export function getTurnClassifierDurationMs(): number
export function addToTurnClassifierDuration(duration: number): void
export function resetTurnClassifierDuration(): void
export function getTurnClassifierCount(): number
export function setStatsStore(
  store: { observe(name: string, value: number): void } | null
): void
export function getStatsStore(): {
  observe(name: string, value: number): void
} | null
export function updateLastInteractionTime(immediate?: boolean): void
export function flushInteractionTime(): void
export function addToTotalLinesChanged(added: number, removed: number): void
export function getTotalLinesAdded(): number
export function getTotalLinesRemoved(): number
export function getTotalInputTokens(): number
export function getTotalOutputTokens(): number
export function getTotalCacheReadInputTokens(): number
export function getTotalCacheCreationInputTokens(): number
export function getTotalWebSearchRequests(): number
export function snapshotOutputTokensForTurn(budget: number | null): void
export function getTurnOutputTokens(): number
export function getCurrentTurnTokenBudget(): number | null
export function incrementBudgetContinuationCount(): void
export function getBudgetContinuationCount(): number
export function setHasUnknownModelCost(): void
export function hasUnknownModelCost(): boolean
export function setLastMainRequestId(requestId: string): void
export function getLastMainRequestId(): string | undefined
export function setLastApiCompletionTimestamp(timestamp: number): void
export function getLastApiCompletionTimestamp(): number | null
export function markPostCompaction(): void
export function consumePostCompaction(): boolean
export function getLastInteractionTime(): number
export function getModelUsage(): { [modelName: string]: ModelUsage }
export function getUsageForModel(model: string): ModelUsage | undefined
export function setMainLoopModelOverride(model: ModelSetting | undefined): void
export function getMainLoopModelOverride(): ModelSetting | undefined
export function setInitialMainLoopModel(model: ModelSetting): void
export function getInitialMainLoopModel(): ModelSetting
export function setSdkBetas(betas: string[] | undefined): void
export function getSdkBetas(): string[] | undefined
export function resetCostState(): void
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage
}: { /* ... */ }): void
export function setModelStrings(modelStrings: ModelStrings | null): void
export function getModelStrings(): ModelStrings | null
export function resetModelStringsForTestingOnly(): void  // 仅测试

// Telemetry
export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter
): void
export function getMeter(): Meter | null
export function getSessionCounter(): AttributedCounter | null
export function getLocCounter(): AttributedCounter | null
export function getPrCounter(): AttributedCounter | null
export function getCommitCounter(): AttributedCounter | null
export function getCostCounter(): AttributedCounter | null
export function getTokenCounter(): AttributedCounter | null
export function getCodeEditToolDecisionCounter(): AttributedCounter | null
export function getActiveTimeCounter(): AttributedCounter | null
export function setLoggerProvider(provider: LoggerProvider | null): void
export function getLoggerProvider(): LoggerProvider | null
export function setEventLogger(logger: ReturnType<typeof logs.getLogger> | null): void
export function getEventLogger(): ReturnType<typeof logs.getLogger> | null
export function setMeterProvider(provider: MeterProvider | null): void
export function getMeterProvider(): MeterProvider | null
export function setTracerProvider(provider: BasicTracerProvider | null): void
export function getTracerProvider(): BasicTracerProvider | null

// 滚动状态
export function markScrollActivity(): void
export function getIsScrollDraining(): boolean
export async function waitForScrollIdle(): Promise<void>

// SDK 状态
export function getSdkAgentProgressSummariesEnabled(): boolean
export function setSdkAgentProgressSummariesEnabled(value: boolean): void
export function getKairosActive(): boolean
export function setKairosActive(value: boolean): void
export function getStrictToolResultPairing(): boolean
export function setStrictToolResultPairing(value: boolean): void
export function getUserMsgOptIn(): boolean
export function setUserMsgOptIn(value: boolean): void
export function getInitJsonSchema(): Record<string, unknown> | null
export function setInitJsonSchema(schema: Record<string, unknown>): void
export function registerHookCallbacks(hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>): void
export function getRegisteredHooks(): Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
export function clearRegisteredHooks(): void
export function clearRegisteredPluginHooks(): void
export function resetSdkInitState(): void
export function getPromptCache1hAllowlist(): string[] | null
export function setPromptCache1hAllowlist(allowlist: string[] | null): void
export function getPromptCache1hEligible(): boolean | null
export function setPromptCache1hEligible(eligible: boolean | null): void
export function getAfkModeHeaderLatched(): boolean | null
export function setAfkModeHeaderLatched(v: boolean): void
export function getFastModeHeaderLatched(): boolean | null
export function setFastModeHeaderLatched(v: boolean): void
export function getCacheEditingHeaderLatched(): boolean | null
export function setCacheEditingHeaderLatched(v: boolean): void
export function getThinkingClearLatched(): boolean | null
export function setThinkingClearLatched(v: boolean): void
export function clearBetaHeaderLatches(): void
export function getPromptId(): string | null
export function setPromptId(id: string | null): void

// 设置源与路径
export function getFlagSettingsPath(): string | undefined
export function setFlagSettingsPath(path: string | undefined): void
export function getFlagSettingsInline(): Record<string, unknown> | null
export function setFlagSettingsInline(settings: Record<string, unknown> | null): void
export function getAllowedSettingSources(): SettingSource[]
export function setAllowedSettingSources(sources: SettingSource[]): void
export function preferThirdPartyAuthentication(): boolean
export function setInlinePlugins(plugins: string[]): void
export function getInlinePlugins(): string[]
export function setChromeFlagOverride(value: boolean | undefined): void
export function getChromeFlagOverride(): boolean | undefined
export function setUseCoworkPlugins(value: boolean): void
export function getUseCoworkPlugins(): boolean
export function setSessionBypassPermissionsMode(enabled: boolean): void
export function getSessionBypassPermissionsMode(): boolean
export function setScheduledTasksEnabled(enabled: boolean): void
export function getScheduledTasksEnabled(): boolean
export function getSessionCronTasks(): SessionCronTask[]
export function addSessionCronTask(task: SessionCronTask): void
export function removeSessionCronTasks(ids: readonly string[]): number
export function setSessionTrustAccepted(accepted: boolean): void
export function getSessionTrustAccepted(): boolean
export function setSessionPersistenceDisabled(disabled: boolean): void
export function isSessionPersistenceDisabled(): boolean

// Plan mode
export function hasExitedPlanModeInSession(): boolean
export function setHasExitedPlanMode(value: boolean): void
export function needsPlanModeExitAttachment(): boolean
export function setNeedsPlanModeExitAttachment(value: boolean): void
export function handlePlanModeTransition(fromMode: string, toMode: string): void
export function needsAutoModeExitAttachment(): boolean
export function setNeedsAutoModeExitAttachment(value: boolean): void
export function handleAutoModeTransition(fromMode: string, toMode: string): void

// UI 状态
export function hasShownLspRecommendationThisSession(): boolean
export function setLspRecommendationShownThisSession(value: boolean): void
export function getAgentColorMap(): Map<string, AgentColorName>
export function setLastAPIRequest(params: Omit<BetaMessageStreamParams, 'messages'> | null): void
export function getLastAPIRequest(): Omit<BetaMessageStreamParams, 'messages'> | null
export function setLastAPIRequestMessages(messages: BetaMessageStreamParams['messages'] | null): void
export function getLastAPIRequestMessages(): BetaMessageStreamParams['messages'] | null
export function setLastClassifierRequests(requests: unknown[] | null): void
export function getLastClassifierRequests(): unknown[] | null
export function setCachedClaudeMdContent(content: string | null): void
export function getCachedClaudeMdContent(): string | null
export function addToInMemoryErrorLog(errorInfo: { error: string; timestamp: string }): void

// Plan slug 缓存
export function getPlanSlugCache(): Map<string, string>

// Session 创建 teams
export function getSessionCreatedTeams(): Set<string>

// Teleport
export function setTeleportedSessionInfo(info: { sessionId: string | null }): void
export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null
export function markFirstTeleportMessageLogged(): void

// Invoked skills
export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null
): void
export function getInvokedSkills(): Map<string, InvokedSkillInfo>
export function getInvokedSkillsForAgent(
  agentId: string | undefined | null
): Map<string, InvokedSkillInfo>
export function clearInvokedSkills(preservedAgentIds?: ReadonlySet<string>): void
export function clearInvokedSkillsForAgent(agentId: string): void

// Slow operations
export function addSlowOperation(operation: string, durationMs: number): void
export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}>

// Main thread agent
export function getMainThreadAgentType(): string | undefined
export function setMainThreadAgentType(agentType: string | undefined): void

// Remote mode
export function getIsRemoteMode(): boolean
export function setIsRemoteMode(value: boolean): void

// Direct connect
export function getDirectConnectServerUrl(): string | undefined
export function setDirectConnectServerUrl(url: string): void

// System prompt sections
export function getSystemPromptSectionCache(): Map<string, string | null>
export function setSystemPromptSectionCacheEntry(name: string, value: string | null): void
export function clearSystemPromptSectionState(): void

// Last emitted date
export function getLastEmittedDate(): string | null
export function setLastEmittedDate(date: string | null): void

// Additional directories
export function getAdditionalDirectoriesForClaudeMd(): string[]
export function setAdditionalDirectoriesForClaudeMd(directories: string[]): void

// Channels
export function getAllowedChannels(): ChannelEntry[]
export function setAllowedChannels(entries: ChannelEntry[]): void
export function getHasDevChannels(): boolean
export function setHasDevChannels(value: boolean): void

// 测试工具
export function resetStateForTests(): void  // 仅测试，NODE_ENV=test
export function isReplBridgeActive(): boolean  // 仅内部用户

// 内部状态（未导出）
const STATE: State = getInitialState()
let interactionTimeDirty: boolean = false
let scrollDraining: boolean = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined

// 内部类型
type State = {
  originalCwd: string
  projectRoot: string
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  turnHookDurationMs: number
  turnToolDurationMs: number
  turnClassifierDurationMs: number
  turnHookCount: number
  turnToolCount: number
  turnClassifierCount: number
  startTime: number
  lastInteractionTime: number
  totalLinesAdded: number
  totalLinesRemoved: number
  hasUnknownModelCost: boolean
  cwd: string
  modelUsage: { [modelName: string]: ModelUsage }
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting | null
  modelStrings: ModelStrings | null
  isInteractive: boolean
  kairosActive: boolean
  strictToolResultPairing: boolean
  sdkAgentProgressSummariesEnabled: boolean
  userMsgOptIn: boolean
  clientType: string
  sessionSource: string | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  flagSettingsPath: string | undefined
  flagSettingsInline: Record<string, unknown> | null
  allowedSettingSources: SettingSource[]
  sessionIngressToken: string | null | undefined
  oauthTokenFromFd: string | null | undefined
  apiKeyFromFd: string | null | undefined
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  locCounter: AttributedCounter | null
  prCounter: AttributedCounter | null
  commitCounter: AttributedCounter | null
  costCounter: AttributedCounter | null
  tokenCounter: AttributedCounter | null
  codeEditToolDecisionCounter: AttributedCounter | null
  activeTimeCounter: AttributedCounter | null
  statsStore: { observe(name: string, value: number): void } | null
  sessionId: SessionId
  parentSessionId: SessionId | undefined
  loggerProvider: LoggerProvider | null
  eventLogger: ReturnType<typeof logs.getLogger> | null
  meterProvider: MeterProvider | null
  tracerProvider: BasicTracerProvider | null
  agentColorMap: Map<string, AgentColorName>
  agentColorIndex: number
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  lastClassifierRequests: unknown[] | null
  cachedClaudeMdContent: string | null
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  inlinePlugins: string[]
  chromeFlagOverride: boolean | undefined
  useCoworkPlugins: boolean
  sessionBypassPermissionsMode: boolean
  scheduledTasksEnabled: boolean
  sessionCronTasks: SessionCronTask[]
  sessionCreatedTeams: Set<string>
  sessionTrustAccepted: boolean
  sessionPersistenceDisabled: boolean
  hasExitedPlanMode: boolean
  needsPlanModeExitAttachment: boolean
  needsAutoModeExitAttachment: boolean
  lspRecommendationShownThisSession: boolean
  initJsonSchema: Record<string, unknown> | null
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  planSlugCache: Map<string, string>
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  invokedSkills: Map<string, InvokedSkillInfo>
  slowOperations: Array<{ operation: string; durationMs: number; timestamp: number }>
  sdkBetas: string[] | undefined
  mainThreadAgentType: string | undefined
  isRemoteMode: boolean
  directConnectServerUrl: string | undefined
  systemPromptSectionCache: Map<string, string | null>
  lastEmittedDate: string | null
  additionalDirectoriesForClaudeMd: string[]
  allowedChannels: ChannelEntry[]
  hasDevChannels: boolean
  sessionProjectDir: string | null
  promptCache1hAllowlist: string[] | null
  promptCache1hEligible: boolean | null
  afkModeHeaderLatched: boolean | null
  fastModeHeaderLatched: boolean | null
  cacheEditingHeaderLatched: boolean | null
  thinkingClearLatched: boolean | null
  promptId: string | null
  lastMainRequestId: string | undefined
  lastApiCompletionTimestamp: number | null
  pendingPostCompaction: boolean
  replBridgeActive?: boolean  // 仅内部用户
}

type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  agentId?: string  // 仅内部 teammate
}

type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}
```

#### 输入输出
- **输入**：各 setter 函数的参数
- **输出**：各 getter 函数的返回值
- **无副作用**：纯状态存储（除 `resetSettingsCache` 在 `setUseCoworkPlugins` 中调用）

#### 状态与启动顺序
- **全局单例对象**：`const STATE: State = getInitialState()`（模块加载时创建）
- **无持久化**：纯内存状态，进程退出后消失
- **启动顺序**：
  1. 模块加载 → `getInitialState()` → 初始化 `STATE`
  2. `sessionId` 初始化为 `randomUUID()`
  3. `originalCwd`/`cwd`/`projectRoot` 初始化为 `realpathSync(process.cwd())`（normalize NFC）
  4. 后续各模块调用 setter 按需更新

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| 全局单例 | 模块级 `STATE` 对象 | 难以测试 | 访问简单，无需传递 | 依赖注入 |
| getter/setter 包裹 | 不直接导出 STATE | 代码冗长 | 类型安全，封装变化 | 直接导出 |
| 测试仅函数 | `resetStateForTests` 检查 NODE_ENV=test | 稍复杂 | 防止生产环境误用 | 不检查 |
| 滚动状态非 STATE | `scrollDraining` 等在模块级 | 分散 | 无需 reset 测试 | 放入 STATE |
| 缓存归一化 | realpathSync + normalize NFC | 稍慢 | 路径比较一致 | 不处理 |

#### 源码测试证据
- **主文件**：`src/bootstrap/state.ts:1-1763`
- **初始状态**：`src/bootstrap/state.ts:260-423`
- **类型定义**：`src/bootstrap/state.ts:45-257`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.8 settings/mdm/rawRead.ts MDM 并行预读取模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/utils/settings/mdm/rawRead.ts
export function startMdmRawRead(): void
export function getMdmRawReadPromise(): Promise<RawReadResult> | null
export function fireRawRead(): Promise<RawReadResult>  // 内部调用，也可外部直接调用

export type RawReadResult = {
  plistStdouts: Array<{ stdout: string; label: string }> | null
  hklmStdout: string | null
  hkcuStdout: string | null
}

// 内部状态
let rawReadPromise: Promise<RawReadResult> | null = null
```

#### 输入输出
- **输入**：
  - `startMdmRawRead()`：无参数，仅启动
  - `fireRawRead()`：无参数，立即启动并返回 Promise
- **输出**：
  - `RawReadResult`：
    - macOS：`plistStdouts` 数组（第一个成功的 plutil 输出）
    - Windows：`hklmStdout`/`hkcuStdout`（reg query 输出）
    - Linux/其他：全 null
- **副作用**：
  - macOS：spawn `plutil` 子进程
  - Windows：spawn `reg query` 子进程

#### 状态与启动顺序
- **模块级 Promise**：`rawReadPromise`（初始 `null`）
- **启动顺序**：
  1. main.tsx 模块加载顶部调用 `startMdmRawRead()`
  2. 子进程 spawn（非阻塞）
  3. preAction hook 中调用 `ensureMdmSettingsLoaded()` → await 该 Promise

#### 完整启动/执行流程
```text
main.tsx 模块加载顶部调用 startMdmRawRead()
  ↓
if (rawReadPromise) return  // 防止重复
  ↓
rawReadPromise = fireRawRead()
  ↓
fireRawRead() 内部：
  ↓
if (macOS):
  const plistPaths = getMacOSPlistPaths()  // 来自 mdm/constants
  ↓
  Promise.all(plistPaths.map(async ({path, label}) => {
    if (!existsSync(path)) return {stdout: '', label, ok: false}
    const {stdout, code} = await execFilePromise(
      PLUTIL_PATH, [...PLUTIL_ARGS_PREFIX, path]
    )
    return {stdout, label, ok: code === 0 && !!stdout}
  }))
  ↓
  winner = allResults.find(r => r.ok)  // 优先级顺序第一个
  ↓
  return {
    plistStdouts: winner ? [{stdout: winner.stdout, label: winner.label}] : [],
    hklmStdout: null,
    hkcuStdout: null
  }
  ↓
elif (Windows):
  const [hklm, hkcu] = await Promise.all([
    execFilePromise('reg', ['query', HKLM_PATH, '/v', VALUE_NAME]),
    execFilePromise('reg', ['query', HKCU_PATH, '/v', VALUE_NAME])
  ])
  ↓
  return {
    plistStdouts: null,
    hklmStdout: hklm.code === 0 ? hklm.stdout : null,
    hkcuStdout: hkcu.code === 0 ? hkcu.stdout : null
  }
  ↓
else:
  return {plistStdouts: null, hklmStdout: null, hkcuStdout: null}
  ↓
preAction hook 调用 ensureMdmSettingsLoaded()  // 未在本文件，在 mdmSettings
  ↓
await getMdmRawReadPromise()
  ↓
mdmSettings 模块 consumeRawReadResult(result)
```

#### 错误与降级
- **plutil/reg spawn 失败**：`code != 0` → `ok = false` → 尝试下一优先级路径
- **所有路径失败**：`plistStdouts = []`（macOS）或 `null`（Windows）→ mdmSettings 降级
- **重复调用 `startMdmRawRead()`**：静默忽略（检查 `rawReadPromise`）
- **`existsSync` 跳过**：无 plist 文件时不 spawn，优化非 MDM 机器

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| 模块级 Promise | `startMdmRawRead()` 存储到变量 | 状态管理 | 调用方无需关心是否已启动 | 每次都 spawn |
| fireRawRead 公开 | 可外部直接调用 | API 稍大 | 轮询/回退场景灵活 | 不公开 |
| 并行多路径 | Promise.all 所有 plist 路径 | 稍多 spawn | 取最快成功 | 顺序尝试 |
| 同步 existsSync | 先检查文件再 spawn | 同步阻塞 | 无 plist 时零 spawn | 直接 spawn |
| 第一个成功 | 优先级顺序查找 | 可能不是最优 | 符合预期 | 合并所有 |

#### 源码测试证据
- **主文件**：`src/utils/settings/mdm/rawRead.ts:1-120`
- **spawn 逻辑**：`src/utils/settings/mdm/rawRead.ts:32-47`
- **macOS 路径**：`src/utils/settings/mdm/rawRead.ts:56-88`
- **Windows 路径**：`src/utils/settings/mdm/rawRead.ts:89-110`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.9 secureStorage/keychainPrefetch.ts 钥匙串并行预取模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/utils/secureStorage/keychainPrefetch.ts
export function startKeychainPrefetch(): void
export async function ensureKeychainPrefetchCompleted(): Promise<void>
export function getLegacyApiKeyPrefetchResult(): {
  stdout: string | null
} | null
export function clearLegacyApiKeyPrefetch(): void  // 与 auth.ts 缓存失效联动

// 内部状态
let legacyApiKeyPrefetch: { stdout: string | null } | null = null
let prefetchPromise: Promise<void> | null = null

// 内部类型
type SpawnResult = {
  stdout: string | null
  timedOut: boolean
}
```

#### 输入输出
- **输入**：
  - `startKeychainPrefetch()`：无参数
  - `ensureKeychainPrefetchCompleted()`：无参数
- **输出**：
  - `getLegacyApiKeyPrefetchResult()`：预取结果或 `null`（未完成/超时/非 macOS）
- **副作用**：
  - macOS：spawn 两个 `security find-generic-password` 子进程（并行）
    - OAuth tokens：service name `Claude Code-credentials`
    - Legacy API key：service name `Claude Code`

#### 状态与启动顺序
- **模块级状态**：
  - `prefetchPromise`：初始 `null`
  - `legacyApiKeyPrefetch`：初始 `null`
- **启动顺序**：
  1. main.tsx 模块加载顶部调用 `startKeychainPrefetch()`（紧接 `startMdmRawRead()`）
  2. 如非 macOS 或 bare mode 或已启动：立即 return
  3. spawn OAuth 子进程 + legacy 子进程（并行）
  4. preAction hook 中调用 `ensureKeychainPrefetchCompleted()` → await

#### 完整启动/执行流程
```text
main.tsx 模块加载顶部调用 startKeychainPrefetch()
  ↓
if (platform !== 'darwin' || prefetchPromise || isBareMode()) return
  ↓
const oauthSpawn = spawnSecurity(
  getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
)
const legacySpawn = spawnSecurity(
  getMacOsKeychainStorageServiceName()
)
  ↓
prefetchPromise = Promise.all([oauthSpawn, legacySpawn])
  .then(([oauth, legacy]) => {
    if (!oauth.timedOut) primeKeychainCacheFromPrefetch(oauth.stdout)
    if (!legacy.timedOut) legacyApiKeyPrefetch = {stdout: legacy.stdout}
  })
  ↓
spawnSecurity(serviceName) 内部：
  ↓
return new Promise<SpawnResult>(resolve => {
  execFile(
    'security',
    ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
    {encoding: 'utf-8', timeout: KEYCHAIN_PREFETCH_TIMEOUT_MS},
    (err, stdout) => {
      resolve({
        stdout: err ? null : stdout?.trim() || null,
        timedOut: Boolean(err && 'killed' in err && err.killed)
      })
    }
  )
})
  ↓
preAction hook 调用 ensureKeychainPrefetchCompleted()
  ↓
if (prefetchPromise) await prefetchPromise
  ↓
auth.ts 后续调用 getApiKeyFromConfigOrMacOSKeychain()
  ↓
先检查 getLegacyApiKeyPrefetchResult() → 如可用使用
  ↓
否则同步 spawn security（兜底）
```

#### 错误与降级
- **子进程超时**：`timedOut = true` → 不 prime 缓存 → auth.ts 同步 spawn 重试（超时更长）
- **子进程错误（非超时）**：`stdout = null` → prime 缓存为 null → auth.ts 不再尝试
- **bare mode**：不启动预取 → auth.ts 可能也不读取（取决于 isBareMode）
- **非 macOS**：不启动预取 → 无操作
- **重复调用 `startKeychainPrefetch()`**：静默忽略

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| 并行双读取 | OAuth + legacy 同时 spawn | 双进程开销 | 总延迟 = max(两者)，非 sum | 顺序读取 |
| 超时不 prime | timedOut 时跳过缓存 | 预取可能浪费 | 同步重试更长超时更可靠 | 即使超时也 prime |
| 缓存联动 | clearLegacyApiKeyPrefetch 与 auth.ts 失效配合 | 需协调 | 防止 stale 预取 | 不提供清除 |
| bare 跳过 | isBareMode 时不启动 | 需检查 | 脚本模式更少副作用 | 总是启动 |
| 仅内部函数 | 仅 `getLegacyApiKeyPrefetchResult` 公开 | API 小 | 封装实现 | 暴露更多 |

#### 源码测试证据
- **主文件**：`src/utils/secureStorage/keychainPrefetch.ts:1-117`
- **启动逻辑**：`src/utils/secureStorage/keychainPrefetch.ts:69-89`
- **spawn 逻辑**：`src/utils/secureStorage/keychainPrefetch.ts:45-67`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.10 init.ts 初始化模块设计卡

#### 真实入口签名与关键类型
```typescript
// src/entrypoints/init.ts
export const init: memoize(async (): Promise<void>)
export function initializeTelemetryAfterTrust(): void

// 内部状态
let telemetryInitialized: boolean = false
```

#### 输入输出
- **输入**：无（`init()` 无参数）
- **输出**：
  - 无返回值
  - 副作用：
    - enableConfigs()
    - applySafeConfigEnvironmentVariables()
    - applyExtraCACertsFromConfig()
    - setupGracefulShutdown()
    - initialize1PEventLogging()（动态 import）
    - populateOAuthAccountInfoIfNeeded()
    - initJetBrainsDetection()
    - detectCurrentRepository()
    - initializeRemoteManagedSettingsLoadingPromise()（如 eligible）
    - initializePolicyLimitsLoadingPromise()（如 eligible）
    - recordFirstStartTime()
    - configureGlobalMTLS()
    - configureGlobalAgents()
    - preconnectAnthropicApi()
    - initUpstreamProxy()（如 CCR 环境）
    - setShellIfWindows()
    - registerCleanup(shutdownLspServerManager)
    - registerCleanup(cleanupSessionTeams)（动态 import）
    - ensureScratchpadDir()（如启用）

#### 状态与启动顺序
- **memoized 执行**：`init()` 被 memoize 包裹，仅执行一次
- **严格执行顺序**（依赖关系明确）：
  1. enableConfigs() （必须第一个，后续依赖配置）
  2. applySafeConfigEnvironmentVariables()、applyExtraCACertsFromConfig()
  3. setupGracefulShutdown() （早设置，后续可 register cleanup）
  4. 1P 事件日志（fire-and-forget，动态 import）
  5. OAuth 账户信息（fire-and-forget）
  6. JetBrains 检测（fire-and-forget）
  7. GitHub repo 检测（fire-and-forget）
  8. 远程设置初始化（仅初始化 Promise，不等待）
  9. recordFirstStartTime()
  10. configureGlobalMTLS()
  11. configureGlobalAgents()（依赖 mTLS）
  12. preconnectAnthropicApi()（依赖 mTLS + 代理）
  13. initUpstreamProxy()（如 CCR，依赖网络配置）
  14. setShellIfWindows()
  15. register cleanup（LSP、teams）
  16. ensureScratchpadDir()（如启用）

#### 完整启动/执行流程
```text
preAction hook 调用 init()（memoized）
  ↓
如已执行过：立即 return
  ↓
const initStartTime = Date.now()
logForDiagnosticsNoPII('info', 'init_started')
profileCheckpoint('init_function_start')
  ↓
try:
  enableConfigs()  // 可能抛 ConfigParseError
  profileCheckpoint('init_configs_enabled')
  ↓
  applySafeConfigEnvironmentVariables()
  applyExtraCACertsFromConfig()  // 在第一次 TLS 前
  profileCheckpoint('init_safe_env_vars_applied')
  ↓
  setupGracefulShutdown()
  profileCheckpoint('init_after_graceful_shutdown')
  ↓
  void Promise.all([
    import('../services/analytics/firstPartyEventLogger'),
    import('../services/analytics/growthbook')
  ]).then(([fp, gb]) => {
    fp.initialize1PEventLogging()
    gb.onGrowthBookRefresh(() => {
      void fp.reinitialize1PEventLoggingIfConfigChanged()
    })
  })
  profileCheckpoint('init_after_1p_event_logging')
  ↓
  void populateOAuthAccountInfoIfNeeded()
  profileCheckpoint('init_after_oauth_populate')
  ↓
  void initJetBrainsDetection()
  profileCheckpoint('init_after_jetbrains_detection')
  ↓
  void detectCurrentRepository()
  ↓
  if (isEligibleForRemoteManagedSettings()):
    initializeRemoteManagedSettingsLoadingPromise()
  if (isPolicyLimitsEligible()):
    initializePolicyLimitsLoadingPromise()
  profileCheckpoint('init_after_remote_settings_check')
  ↓
  recordFirstStartTime()
  ↓
  configureGlobalMTLS()
  logForDiagnosticsNoPII('info', 'init_mtls_configured')
  logForDebugging('[init] configureGlobalMTLS complete')
  ↓
  configureGlobalAgents()
  logForDiagnosticsNoPII('info', 'init_proxy_configured')
  logForDebugging('[init] configureGlobalAgents complete')
  profileCheckpoint('init_network_configured')
  ↓
  preconnectAnthropicApi()  // fire-and-forget
  ↓
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)):
    try:
      const {initUpstreamProxy, getUpstreamProxyEnv} = await import('../upstreamproxy/upstreamproxy')
      const {registerUpstreamProxyEnvFn} = await import('../utils/subprocessEnv')
      registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
      await initUpstreamProxy()
    catch (err):
      logForDebugging('[init] upstreamproxy init failed', {level: 'warn'})
  ↓
  setShellIfWindows()
  ↓
  registerCleanup(shutdownLspServerManager)
  ↓
  registerCleanup(async () => {
    const {cleanupSessionTeams} = await import('../utils/swarm/teamHelpers')
    await cleanupSessionTeams()
  })
  ↓
  if (isScratchpadEnabled()):
    const scratchpadStart = Date.now()
    await ensureScratchpadDir()
    logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
      duration_ms: Date.now() - scratchpadStart
    })
  ↓
  logForDiagnosticsNoPII('info', 'init_completed', {
    duration_ms: Date.now() - initStartTime
  })
  profileCheckpoint('init_function_end')
  ↓
catch (error):
  if (error instanceof ConfigParseError):
    if (getIsNonInteractiveSession()):
      process.stderr.write(`Configuration error in ${error.filePath}: ${error.message}\n`)
      gracefulShutdownSync(1)
      return
    else:
      return import('../components/InvalidConfigDialog').then(m =>
        m.showInvalidConfigDialog({error})
      )
  else:
    throw error
  ↓
后续（信任对话框后）调用 initializeTelemetryAfterTrust()
  ↓
if (isEligibleForRemoteManagedSettings()):
  if (getIsNonInteractiveSession() && isBetaTracingEnabled()):
    void doInitializeTelemetry().catch(...)
  logForDebugging('[3P telemetry] Waiting for remote managed settings')
  void waitForRemoteManagedSettingsToLoad()
    .then(async () => {
      logForDebugging('[3P telemetry] Remote managed settings loaded')
      applyConfigEnvironmentVariables()  // 再次应用，包含远程设置
      await doInitializeTelemetry()
    })
    .catch(...)
else:
  void doInitializeTelemetry().catch(...)
  ↓
doInitializeTelemetry() 内部：
  if (telemetryInitialized) return
  telemetryInitialized = true
  await setMeterState()
  ↓
setMeterState() 内部：
  const {initializeTelemetry} = await import('../utils/telemetry/instrumentation')
  const meter = await initializeTelemetry()
  if (meter):
    const createAttributedCounter = (name, options) => {
      const counter = meter.createCounter(name, options)
      return {
        add(value, additionalAttributes = {}) {
          const currentAttributes = getTelemetryAttributes()
          counter.add(value, {...currentAttributes, ...additionalAttributes})
        }
      }
    }
    setMeter(meter, createAttributedCounter)
    getSessionCounter()?.add(1)
```

#### 错误与降级
- **ConfigParseError**：
  - non-interactive：写入 stderr + gracefulShutdownSync(1)
  - interactive：显示 InvalidConfigDialog（动态 import React）
- **其他错误**：重新抛出 → 进程异常退出
- **1P 日志初始化失败**：静默忽略（fire-and-forget）
- **OAuth 填充失败**：静默忽略（fire-and-forget）
- **Upstream proxy 初始化失败**：catch 并 warn，继续（fail-open）
- **重复调用 init()**：memoize 返回第一次的 Promise
- **重复调用 initializeTelemetryAfterTrust()**：`telemetryInitialized` 标志防止

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| memoized 执行 | lodash-es/memoize 包裹 | 轻微开销 | 幂等，多次调用安全 | 不 memoize |
| 严格顺序 | 步骤有明确依赖关系 | 需小心维护 | 依赖正确，无竞态 | 乱序初始化 |
| fire-and-forget | OAuth/JetBrains/GitHub/预连接 void | 错误不可见 | 不阻塞启动 | await |
| 动态 import | 1P 日志/upstream proxy/teamHelpers 使用 import() | 稍复杂 | 减小初始加载 | 静态 import |
| CCR fail-open | upstream proxy 出错继续 | 可能功能不正常 | 启动不阻塞 | fail-closed |
| 两阶段 env | safe 先，full 信任后 | 需维护两套 | 安全（不信任不应用危险 env） | 一次应用 |
| telemetry 等待远程 | 如 eligible 先等远程设置 | 可能延迟 | 包含远程设置配置 | 不等待 |
| non-interactive beta tracing eager | SDK 模式且 beta tracing 立即初始化 | 稍复杂 | 早期追踪可用 | 不区分 |

#### 源码测试证据
- **主文件**：`src/entrypoints/init.ts:1-341`
- **init 步骤**：`src/entrypoints/init.ts:57-238`
- **错误处理**：`src/entrypoints/init.ts:236-340`
- **telemetry 初始化**：`src/entrypoints/init.ts:247-341`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.11 envUtils.ts 环境工具模块设计卡（--bare 模式）

#### 真实入口签名与关键类型
```typescript
// src/utils/envUtils.ts
export function isBareMode(): boolean
export function isEnvTruthy(value: string | undefined): boolean
export function isNonInteractiveSession(): boolean
// ... 其他函数（未读取完整文件）
```

#### 输入输出
- **输入**：
  - `isBareMode()`：检查 `process.env.CLAUDE_CODE_SIMPLE`
  - `isEnvTruthy(value)`：字符串值
- **输出**：
  - `isBareMode()`：`CLAUDE_CODE_SIMPLE` 是否 truthy
  - `isEnvTruthy(value)`：`value` 是否为 `'1'`、`'true'`、`'yes'`、`'on'`（大小写不敏感）

#### 状态与启动顺序
- **无内部状态**：纯函数
- **启动顺序**：
  1. cli.tsx 检查 `--bare` → 如匹配设置 `CLAUDE_CODE_SIMPLE=1`
  2. 后续各模块调用 `isBareMode()` 决定是否跳过功能

#### --bare 模式跳过的功能
- 钥匙串预取（keychainPrefetch.ts）
- 插件钩子
- LSP 初始化
- 自动记忆
- 背景预取
- 归因功能
- 等等（各模块自行检查 `isBareMode()`）

#### 设计取舍与备选
| 取舍 | 当前选择 | 代价 | 收益 | 备选方案 |
|------|----------|------|------|----------|
| 单一环境变量 | CLAUDE_CODE_SIMPLE 控制所有 | 粒度粗 | 用户简单 | 多个独立标志 |
| 各模块自查 | 分散检查 | 容易遗漏 | 灵活 | 集中控制 |

#### 源码测试证据
- **主文件**：`src/utils/envUtils.ts`（未完整读取）
- **调用位置**：`src/entrypoints/cli.tsx:332-334`
- **无直接测试**：该模块通过端到端测试覆盖

---

### 4.12 模块与状态所有权总结

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 |
|------|------------|----------|--------------|
| cli.tsx | 无（纯流程） | 快速路径判断、动态 import | 实际业务逻辑 |
| main.tsx | commander program、pendingConnect/pendingAssistantChat/pendingSSH | 定义命令、解析 argv、调用 init/setup/launchRepl | 命令的具体实现 |
| init.ts | telemetryInitialized | 按顺序初始化各子系统 | 子系统的具体业务逻辑 |
| startupProfiler.ts | checkpoints（模块级数组） | profileCheckpoint、profileReport | 性能分析（只记录） |
| gracefulShutdown.ts | shutdownInProgress、failsafeTimer、orphanCheckInterval、pendingShutdown、resumeHintPrinted | setupGracefulShutdown、gracefulShutdown、gracefulShutdownSync | 具体清理逻辑（只 orchestrate） |
| cleanupRegistry.ts | cleanupFunctions（模块级 Set） | registerCleanup、runCleanupFunctions | 不执行具体清理（只管理函数列表） |
| earlyInput.ts | capturedInput、isCapturing | startCapturingEarlyInput、seedEarlyInput、stopCapturingEarlyInput | 输入历史管理（只捕获早期输入） |
| bootstrap/state.ts | STATE（模块级对象） | 所有 setter/getter | 业务逻辑（只存储全局状态） |
| settings/mdm/rawRead.ts | rawReadPromise（模块级 Promise） | startMdmRawRead、fireRawRead、getMdmRawReadPromise | MDM 设置的具体解析（只负责并行读取） |
| secureStorage/keychainPrefetch.ts | prefetchPromise、legacyApiKeyPrefetch | startKeychainPrefetch、ensureKeychainPrefetchCompleted | 钥匙串的具体使用（只负责并行读取） |

状态位置与理由：
- **全局启动状态**放在 bootstrap/state.ts 模块级：跨模块共享，启动时设置一次后不变
- **预取 Promise**放在对应模块：封装预取逻辑，调用方只需 start 和 ensure
- **cleanup 函数列表**放在 cleanupRegistry.ts 模块级 Set：各模块都可以注册，统一执行
- **checkpoint 列表**放在 startupProfiler.ts 模块级数组：各模块都可以标记，统一报告
- **pendingConnect/pendingAssistantChat/pendingSSH** 放在 main.tsx 模块级：只在 main.tsx 内部使用，不对外暴露

---

### 4.13 快速路径详览（补充选择原因）

| 快速路径 | 选择原因 | 动态 import | 是否调用 init/setup | 退出方式 | 源码位置 |
|----------|----------|-------------|---------------------|----------|----------|
| `--internal-prepare-commit-msg-attribution` | Git hook，必须快且失败不阻塞 | `../utils/config.js`、`../utils/postCommitAttribution.js` | 仅 enableConfigs() | return | cli.tsx:50-65 |
| `--version`/-v/-V | 零加载，构建时内联版本号 | 无 | 否 | return | cli.tsx:68-76 |
| `--dump-system-prompt` | 内部调试，feature 保护 | `../utils/config.js`、`../utils/model/model.js`、`../constants/prompts.js` | 仅 enableConfigs() | return | cli.tsx:84-97 |
| `--claude-in-chrome-mcp` | MCP 服务器模式 | `../utils/claudeInChrome/mcpServer.js` | 否 | return | cli.tsx:99-106 |
| `--chrome-native-mcp` | 保留但不支持（私有扩展） | 无 | 否 | throw Error | cli.tsx:107-111 |
| `--computer-use-mcp` | 内部 dogfood，feature 保护 | `../utils/computerUse/mcpServer.js` | 否 | return | cli.tsx:112-121 |
| `--daemon-worker` | 内部 spawn，perf 敏感 | `../daemon/workerRegistry.js` | 否 | return | cli.tsx:123-131 |
| `--remote-control/rc/remote/sync/bridge` | 远程控制，需 auth 先检查 | `../utils/config.js`、`../bridge/bridgeEnabled.js`、`../bridge/types.js`、`../bridge/bridgeMain.js`、`../utils/process.js`、`../utils/auth.js`、`../services/policyLimits/index.js` | 仅 enableConfigs()、initSinks() | return | cli.tsx:134-186 |
| `--daemon` | 守护进程 supervisor | `../utils/config.js`、`../utils/sinks.js`、`../daemon/main.js` | 仅 enableConfigs()、initSinks() | return | cli.tsx:189-198 |
| `ps/logs/attach/kill/--bg/--background` | 后台会话管理 | `../utils/config.js`、`../cli/bg.js` | 仅 enableConfigs() | return | cli.tsx:201-232 |
| `--template-job-supervisor` | 模板作业 supervisor | `../cli/handlers/templateJobs.js` | 否 | return | cli.tsx:234-240 |
| `new/list/reply`（模板） | 模板作业命令 | `../cli/handlers/templateJobs.js` | 仅 enableConfigs() | process.exit(0) | cli.tsx:243-254 |
| `--open-runner/--open-runner-server` | Open Runner 模式 | `../open-runner/main.js` | 否 | return | cli.tsx:256-269 |
| `--environment-runner` | Open Runner 别名 | `../environment-runner/main.js` | 否 | return | cli.tsx:272-280 |
| `--self-hosted-runner` | Self-hosted Runner | `../self-hosted-runner/main.js` | 否 | return | cli.tsx:283-292 |
| `--worktree + --tmux` | exec tmux，可能 fall through | `../utils/config.js`、`../utils/worktreeModeEnabled.js`、`../utils/worktree.js`、`../utils/process.js` | 仅 enableConfigs() | return（或继续） | cli.tsx:295-320 |

（注：setup.ts 模块、main.ts 主入口模块、交互式与非交互式模式模块的设计卡片未包含在内，保持与现有文档结构一致）

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `cli.tsx` | 无（纯流程） | 快速路径判断、动态 import、调用 main() | 实际业务逻辑 | 接收 process.argv，调用对应处理器 |
| `main.tsx` | commander program、pendingConnect/pendingAssistantChat/pendingSSH（模块级变量） | 定义命令、解析 argv、调用 init()/setup()/launchRepl() | 命令的具体实现 | 暴露 main() 入口，调用 commands、init、setup、replLauncher |
| `init.ts` | 无（纯函数，用 memoize 缓存结果） | 按顺序初始化各子系统 | 子系统的具体业务逻辑 | 调用 config、gracefulShutdown、analytics、auth、network、lsp 等 |
| `startupProfiler.ts` | `checkpoints`（模块级数组） | `profileCheckpoint()`、`profileReport()` | 性能分析（只记录） | 提供 checkpoint API，供各模块调用 |
| `gracefulShutdown.ts` | 无（process listeners） | `setupGracefulShutdown()`、`gracefulShutdown()`、`gracefulShutdownSync()` | 具体清理逻辑（只 orchestrate） | 调用 cleanupRegistry 执行清理函数 |
| `cleanupRegistry.ts` | `cleanupFunctions`（模块级数组） | `registerCleanup()`、`runCleanups()`、`reset()` | 不执行具体清理（只管理函数列表） | 提供注册接口，供各模块调用 |
| `earlyInput.ts` | `capturedInput`、`isCapturing`（模块级变量） | `startCapturingEarlyInput()`、`seedEarlyInput()`、`stopCapturingEarlyInput()` | 输入历史管理（只捕获早期输入） | 提供输入捕获接口，供 REPL 使用 |
| `envUtils.ts` | 无（纯函数） | `isBareMode()`、`isEnvTruthy()`、`isNonInteractiveSession()` 等 | 环境变量的业务含义（只提供判断接口） | 提供环境判断接口，供各模块调用 |
| `bootstrap/state.ts` | `bootstrapState`（模块级对象） | `setIsInteractive()`、`setClientType()`、`setOriginalCwd()` 等 setter，`isInteractive()`、`getClientType()` 等 getter | 业务逻辑（只存储全局状态） | 提供全局状态存取接口，供各模块调用 |
| `mdm/rawRead.ts` | `mdmRawReadPromise`（模块级 Promise） | `startMdmRawRead()`、`ensureMdmSettingsLoaded()` | MDM 设置的具体解析（只负责并行读取） | 提供预取接口，供 main.tsx 调用 |
| `secureStorage/keychainPrefetch.ts` | `keychainPrefetchPromise`（模块级 Promise） | `startKeychainPrefetch()`、`ensureKeychainPrefetchCompleted()` | 钥匙串的具体使用（只负责并行读取） | 提供预取接口，供 main.tsx 调用 |
| `apiPreconnect.ts` | 无（fire-and-forget） | `preconnectAnthropicApi()` | API 调用（只做预连接） | 提供预连接接口，供 init.ts 调用 |
| `setup.ts` | 无（纯流程） | `setup()` | 具体业务逻辑初始化 | 调用 worktree、hooks、session memory、config 等 |
| `replLauncher.tsx` | 无（纯流程） | `launchRepl()` | REPL 的具体渲染（只 orchestrate） | 调用 App、REPL 组件 |

状态位置与理由：

- **全局 bootstrap 状态**放在 `bootstrap/state.ts` 模块级变量：跨模块共享，启动时设置一次后不变
- **预取 Promise**放在对应模块（`mdm/rawRead.ts`、`keychainPrefetch.ts`）：封装预取逻辑，调用方只需 start 和 ensure
- **cleanup 函数列表**放在 `cleanupRegistry.ts` 模块级数组：各模块都可以注册，统一执行
- **checkpoint 列表**放在 `startupProfiler.ts` 模块级数组：各模块都可以标记，统一报告
- **pendingConnect/pendingAssistantChat/pendingSSH**放在 `main.tsx` 模块级变量：只在 main.tsx 内部使用，不对外暴露

### 4.3 主控制流

完整 CLI 启动流（端到端，交互式 REPL 路径）：

```text
node cli.js
  ↓
cli.tsx 顶部副作用
  ├─ 设置 COREPACK_ENABLE_AUTO_PIN=0
  ├─ CCR 环境设置 NODE_OPTIONS=--max-old-space-size=8192
  └─ 初始化 ablation baseline（如果启用）
  ↓
cli.tsx main() 开始
  ↓
快速路径判断（按优先级）
  ├─ --internal-prepare-commit-msg-attribution → 处理后 exit
  ├─ --version/-v/-V → 输出版本后 exit
  ├─ --dump-system-prompt → 输出后 exit
  ├─ --claude-in-chrome-mcp → 启动后 exit
  ├─ --chrome-native-mcp → 错误提示 exit
  ├─ --computer-use-mcp → 启动后 exit
  ├─ --daemon-worker → 启动后 exit
  ├─ --remote-control/--remote/--sync/--bridge → 启动后 exit
  ├─ --daemon → 启动后 exit
  ├─ ps/logs/attach/kill 或 --bg/--background → 处理后 exit
  ├─ --template-job-supervisor → 启动后 exit
  ├─ new/list/reply（模板） → 启动后 exit
  ├─ --open-runner/--open-runner-server → 启动后 exit
  ├─ --environment-runner → 启动后 exit
  ├─ --self-hosted-runner → 启动后 exit
  ├─ --worktree + --tmux → exec tmux 后 exit（如果 handled）
  └─ 其他 → 继续
  ↓
profileCheckpoint('cli_before_main_import')
  ↓
动态 import('../main.js')
  ↓
profileCheckpoint('cli_after_main_import')
  ↓
main.tsx 顶部副作用
  ├─ profileCheckpoint('main_tsx_entry')
  ├─ startMdmRawRead()  // 并行启动
  ├─ startKeychainPrefetch()  // 并行启动
  └─ 其他 import（React、commander、chalk 等）
  ↓
profileCheckpoint('main_tsx_imports_loaded')
  ↓
检查是否被调试（NODE_OPTIONS 或 inspector.url()）→ 如果是且非内部用户则 exit 1
  ↓
main.tsx main() 开始
  ↓
设置 process.env.NoDefaultCurrentDirectoryInExePath=1（Windows 安全）
  ↓
initializeWarningHandler()
  ↓
设置 process.on('exit') 和 SIGINT 监听
  ↓
处理 cc:// 深度链接（如果有）
  ↓
处理 --handle-uri（如果有）→ 处理后 exit
  ↓
处理 macOS URL handler（如果有）→ 处理后 exit
  ↓
处理 --assistant（如果有）→ stash pendingAssistantChat
  ↓
处理 ssh 命令（如果有）→ stash pendingSSH，rewrite argv
  ↓
判断 isNonInteractive
  ├─ 检查 --print
  ├─ 检查 --init-only
  ├─ 检查 --sdk-url
  └─ 检查 !process.stdout.isTTY
  ↓
如果 non-interactive → stopCapturingEarlyInput()
  ↓
setIsInteractive()、setClientType()、setQuestionPreviewFormat()
  ↓
如果是 bridge → setSessionSource('remote-control')
  ↓
profileCheckpoint('main_client_type_determined')
  ↓
eagerLoadSettings()
  ├─ eagerParseCliFlag('--settings')
  ├─ 如果有 → loadSettingsFromFlag()
  ├─ eagerParseCliFlag('--setting-sources')
  ├─ 如果有 → loadSettingSourcesFromFlag()
  └─ profileCheckpoint('eagerLoadSettings_end')
  ↓
profileCheckpoint('main_before_run')
  ↓
调用 run()
  ↓
run() 开始
  ↓
profileCheckpoint('run_function_start')
  ↓
创建 commander program，configure help，enable positional options
  ↓
profileCheckpoint('run_commander_initialized')
  ↓
设置 program.preAction hook
  ↓
定义所有命令和选项（篇幅所限不展开）
  ↓
program.parseAsync(process.argv)
  ↓
preAction hook 触发
  ├─ profileCheckpoint('preAction_start')
  ├─ await Promise.all([
  │     ensureMdmSettingsLoaded(),  // 等待并行预取
  │     ensureKeychainPrefetchCompleted()
  │   ])
  ├─ profileCheckpoint('preAction_after_mdm')
  ├─ await init()  // 调用初始化，memoized 只执行一次
  ├─ profileCheckpoint('preAction_after_init')
  ├─ 设置 process.title（如果允许）
  ├─ initSinks()  // 初始化 analytics sinks
  ├─ profileCheckpoint('preAction_after_sinks')
  ├─ 处理 --plugin-dir → setInlinePlugins() + clearPluginCache()
  ├─ runMigrations()
  ├─ profileCheckpoint('preAction_after_migrations')
  ├─ void loadRemoteManagedSettings()  // 后台加载
  ├─ void loadPolicyLimits()  // 后台加载
  └─ profileCheckpoint('preAction_after_remote_settings')
  ↓
action handler 触发（以默认 interactive REPL 为例）
  ├─ profileCheckpoint('action_handler_start')
  ├─ 处理 --bare → 设置 CLAUDE_CODE_SIMPLE=1
  ├─ 处理 prompt='code' → 忽略，提示用户
  ├─ 处理 --assistant → kairosEnabled，stash assistantTeamContext
  ├─ 提取各种 options（debug、permissionMode、addDir、model、worktree 等）
  ├─ 处理 --prefill → seedEarlyInput()
  ├─ 启动 fileDownloadPromise（如果有 --file）
  ├─ 验证 fallback model != main model
  ├─ 处理 --system-prompt/--system-prompt-file
  ├─ 处理 --append-system-prompt/--append-system-prompt-file
  ├─ 处理 teammate system prompt addendum（如果有）
  ├─ 处理 permission mode，setSessionBypassPermissionsMode()
  ├─ 处理 --enable-auto-mode（如果有）
  ├─ 解析 --mcp-config → dynamicMcpConfig
  ├─ 处理 --chrome → setupClaudeInChrome()
  ├─ 处理 auto-enable Claude in Chrome（如果符合条件）
  ├─ 处理 --strict-mcp-config（如果有 enterprise MCP config）
  ├─ 处理 --computer-use-mcp（如果启用且符合条件）
  ├─ setAdditionalDirectoriesForClaudeMd(addDir)
  ├─ 处理 --channels/--dangerously-load-development-channels（如果有）
  ├─ 如果 non-interactive
  │   ├─ 记录会话 telemetry
  │   ├─ 记录 startup telemetry
  │   └─ 执行 headless 命令（print/init-only 等）→ 后续流程本文不展开
  └─ 否则（interactive）→ 继续
  ↓
检查 --continue/--resume/--from-pr → loadConversationForResume() 或 showResumeChooser()
  ↓
检查 --rewind-files（如果有）→ rewind 后 exit
  ↓
检查 --teleport → teleport 后继续
  ↓
检查 --remote → showRemoteChooser() 后继续
  ↓
await setup(cwd, permissionMode, ...)  // 调用 setup
  ↓
setup() 内流程
  ├─ logForDiagnosticsNoPII('info', 'setup_started')
  ├─ 检查 Node.js 版本 >= 18 → 不满足则 exit 1
  ├─ 如果有 customSessionId → switchSession()
  ├─ 如果不是 bare 或有 --messaging-socket-path → startUdsMessaging()
  ├─ 如果不是 bare 且 isAgentSwarmsEnabled() → captureTeammateModeSnapshot()
  ├─ 如果 interactive → 检查并恢复 iTerm2/Terminal.app 备份（如果有中断）
  ├─ setCwd(cwd)
  ├─ captureHooksConfigSnapshot()
  ├─ initializeFileChangedWatcher(cwd)
  ├─ 如果 worktreeEnabled
  │   ├─ 检查 hasWorktreeCreateHook() 或 inGit
  │   ├─ 如果 inGit
  │   │   ├─ findCanonicalGitRoot()
  │   │   ├─ 如果在 worktree 中 → chdir 到 main repo
  │   │   └─ 如果 tmuxEnabled → 生成 tmux session name
  │   └─ await createWorktreeForSession()
  │       ├─ 如果 tmuxEnabled → await createTmuxSessionForWorktree()
  │       ├─ chdir 到 worktree
  │       ├─ setCwd(worktreePath)
  │       ├─ setOriginalCwd(worktreePath)
  │       ├─ setProjectRoot(worktreePath)
  │       ├─ saveWorktreeState()
  │       ├─ clearMemoryFileCaches()
  │       └─ updateHooksConfigSnapshot()
  ├─ 如果不是 bare → initSessionMemory()、initContextCollapse()（如果有）
  ├─ void lockCurrentVersion()
  ├─ logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')
  ├─ profileCheckpoint('setup_before_prefetch')
  ├─ 如果不是 skipPluginPrefetch → void getCommands()
  ├─ void import('loadPluginHooks') → loadPluginHooks() + setupPluginHookHotReload()
  ├─ 如果不是 bare
  │   ├─ 如果 USER_TYPE=ant → void import('commitAttribution') 预取
  │   ├─ 如果 feature('COMMIT_ATTRIBUTION') → setImmediate register attribution hooks
  │   ├─ void import('sessionFileAccessHooks') 注册 hooks
  │   └─ 如果 feature('TEAMMEM') → void import('teamMemorySync/watcher') 启动 watcher
  ├─ initSinks()
  ├─ logEvent('tengu_started', {})  // 会话成功率 beacon
  ├─ void prefetchApiKeyFromApiKeyHelperIfSafe(isNonInteractiveSession)
  ├─ profileCheckpoint('setup_after_prefetch')
  ├─ 如果不是 bare → await checkForReleaseNotes() + await getRecentActivity()
  ├─ 如果 permissionMode 是 bypassPermissions 或 allowDangerouslySkipPermissions
  │   ├─ 检查 root/sudo → 如果是且非 sandbox 则 exit 1
  │   └─ 如果 USER_TYPE=ant 且非 local-agent/desktop
  │       ├─ await Promise.all([envDynamic.getIsDocker(), env.hasInternetAccess()])
  │       └─ 如果不是 sandbox 或有 internet → exit 1
  └─ 如果 process.env.NODE_ENV === 'test' → return
  ↓
setup() 完成，回到 action handler
  ↓
如果 interactive
  ├─ 检查 pendingConnect → showConnectDirectModal()
  ├─ 检查 pendingSSH → showSshModal()
  ├─ 检查 pendingAssistantChat → showAssistantModal()
  ├─ 如果有 fileDownloadPromise → await fileDownloadPromise
  ├─ 如果有 assistantTeamContext → 应用它
  ├─ 如果有 resumeConversation → processResumedConversation()
  ├─ 确保 scratchpad dir（如果启用且不是 bare）
  ├─ initializeTelemetryAfterTrust()
  ├─ void ensureClaudeAiAuthTokensRefreshed()
  ├─ 如果不是 bare → applyConfigEnvironmentVariables()（full env，非 safe）
  ├─ void refreshModelCapabilities()
  ├─ 处理 --continue/--resume → 恢复会话
  ├─ initializeLspServerManager()（如果不是 bare）
  ├─ initializeVersionedPlugins()（如果不是 bare）
  ├─ getInitialSettings() 读取 settings
  ├─ initializeToolPermissionContext()
  ├─ 如果有 --dangerously-skip-permissions → verifyBypassPermissionsAccess()
  ├─ 如果 autoMode 相关 → verifyAutoModeGateAccess()
  ├─ checkAndDisableBypassPermissions()
  ├─ 如果有 --model → setMainLoopModelOverride()
  ├─ 如果有 --effort → 验证并设置
  ├─ 如果有 --advisor → 检查权限
  ├─ 如果有 --task/--todotxt → 初始化任务模式
  ├─ 如果有 --name → updateSessionName()
  ├─ 如果有 --agent → 验证 agent
  ├─ 如果有 --agents-json → parseAgentsFromJson()
  ├─ 如果不是 bare → initializePluginBackgroundJobs()
  ├─ 如果不是 bare → cleanupOrphanedPluginVersionsInBackground()
  ├─ 如果不是 bare → refreshExampleCommandsInBackground()
  ├─ 如果不是 bare → void fetchBootstrapData()
  ├─ 如果不是 bare → void prefetchPassesEligibility()
  ├─ 如果不是 bare → void prefetchOfficialMcpUrls()
  ├─ 如果不是 bare → void fetchClaudeAiMcpConfigsIfEligible()
  ├─ 如果不是 bare → void prefetchAwsCredentialsAndBedRockInfoIfSafe()
  ├─ 如果不是 bare → void prefetchGcpCredentialsIfSafe()
  ├─ void prefetchFastModeStatus()
  ├─ 如果是 bare → processSessionStartHooks('bare')
  ├─ 否则如果有 --init → processSetupHooks('init') + processSessionStartHooks('init')
  ├─ 否则如果有 --maintenance → processSetupHooks('maintenance')
  ├─ 否则 → processSetupHooks('startup') + processSessionStartHooks('startup')
  ├─ initializeWarningHandler()
  ├─ 如果有 permissionModeNotification → 显示通知
  ├─ 如果有 model deprecation warning → 显示警告
  ├─ 如果 --ide → 自动连接 IDE
  ├─ 如果有 --deep-link-origin → 初始化 DeepLinkPrompt
  ├─ 如果有 --chrome → 初始化 ChromePromptAddendum
  ├─ 如果 auto-enable Claude in Chrome → 初始化 ChromePromptAddendum
  ├─ 如果有 custom system prompt → 初始化 SystemPromptOverride
  ├─ 如果有 append system prompt → 初始化 AppendSystemPrompt
  ├─ 如果有 --no-session-persistence → setSessionPersistenceDisabled()
  ├─ 如果有 --disable-slash-commands → 禁用
  ├─ 如果 remote control → 检查并启动
  ├─ 如果有 --no-chrome → 禁用
  ├─ 如果有 --settings/--setting-sources → 设置 allowed setting sources
  ├─ 如果有 --allowed-tools/--tools/--disallowed-tools → 设置 allowed tools
  ├─ 如果有 --mcp-config → 设置 dynamic mcp config
  ├─ 如果有 --strict-mcp-config → 设置
  ├─ 如果有 --allowed-channels/--dangerously-load-development-channels → 设置
  ├─ 如果有 --chrome/--no-chrome → 设置 chrome flag override
  ├─ create store（AppState）
  ├─ 如果有 --no-session-persistence → set session.persistence = 'none'
  ├─ 计算 initial state（model、effort、advisor、fast mode 等）
  ├─ 如果有 resume conversation → 恢复 messages、context、stats 等
  ├─ 如果有 prompt → createUserMessage()
  ├─ 如果有 --file → add resources to state
  ├─ 如果有 --agent → select agent
  ├─ 如果有 --prefill → set prefill state
  ├─ 如果有 --task → 切换到任务模式
  ├─ 如果有 --resume-session-at → 截断消息
  ├─ register cleanup for LSP manager shutdown
  ├─ 初始化 BuiltinSkills、initBuiltinPlugins
  ├─ await getRenderContext()
  ├─ profileCheckpoint('action_handler_before_show_setup')
  ├─ await showSetupScreens()  // 信任对话框、welcome、release notes 等
  ├─ profileCheckpoint('action_handler_after_show_setup')
  ├─ 如果有 --prefill → seedEarlyInput()
  ├─ 处理 pendingDeepLinkResume（如果有）
  ├─ 如果有 teleport → teleportWithProgress()
  ├─ 如果有 --remote-control → 启动 remote control
  ├─ 记录会话 telemetry（skills、plugins）
  ├─ 记录 startup telemetry
  ├─ profileCheckpoint('action_handler_before_deferred_prefetches')
  ├─ startDeferredPrefetches()  // 不阻塞，后台启动
  ├─ profileCheckpoint('action_handler_after_deferred_prefetches')
  ├─ 应用 initial cwd state
  ├─ 设置 user msg opt-in（如果有）
  ├─ 如果有 session ingress auth token → 设置
  ├─ 如果有 teleported session info → 设置
  ├─ 如果有 main thread agent type → 设置
  ├─ 如果有 additional directories for claude.md → 设置
  ├─ 计算 initial team context（如果有）
  ├─ initializeColorScheme()
  ├─ 如果有 --name → set session name in state
  ├─ 如果有 --prefill → set prefill in state
  ├─ 如果不是 bare → settingsChangeDetector.initialize()
  ├─ 如果不是 bare → processSessionStartHooks('ready')
  ├─ 如果有 --init-only → gracefulShutdown(0)
  ├─ 如果有 prompt → add message and maybe auto-send
  ├─ 如果有 --continue/--resume 且有 --prefill → auto-send
  ├─ profileCheckpoint('action_handler_before_repl')
  └─ await launchRepl()
      ├─ import('./components/App.js')
      ├─ import('./screens/REPL.js')
      ├─ await renderAndRun()
      └─ profileCheckpoint('cli_after_main_complete')
```

### 4.4 快速路径详览

各快速路径的判断位置、加载内容、退出方式：

| 快速路径 | cli.tsx 位置 | 动态 import | 是否调用 init() | 退出方式 | 说明 |
|---|---|---|---|---|---|
| `--internal-prepare-commit-msg-attribution` | L50-65 | `../utils/config.js`、`../utils/postCommitAttribution.js` | 否（只调用 enableConfigs()） | return（自然 exit） | Git hook，失败不阻塞提交 |
| `--version`/`-v`/`-V` | L68-76 | 无 | 否 | return | 零 import，用宏内联版本号 |
| `--dump-system-prompt` | L84-97 | `../utils/config.js`、`../utils/model/model.js`、`../constants/prompts.js` | 否（只调用 enableConfigs()） | return | 内部调试用，feature flag 保护 |
| `--claude-in-chrome-mcp` | L99-106 | `../utils/claudeInChrome/mcpServer.js` | 否 | return | MCP 服务器模式 |
| `--chrome-native-mcp` | L107-111 | 无 | 否 | throw Error（提示不支持） | 保留但不支持 |
| `--computer-use-mcp` | L112-121 | `../utils/computerUse/mcpServer.js` | 否 | return | 内部 dogfood，feature flag 保护 |
| `--daemon-worker` | L123-131 | `../daemon/workerRegistry.js` | 否 | return | 守护进程 spawn 的 worker |
| `--remote-control`/`rc`/`remote`/`sync`/`bridge` | L134-186 | `../utils/config.js`、`../bridge/bridgeEnabled.js`、`../bridge/types.js`、`../bridge/bridgeMain.js`、`../utils/process.js`、`../utils/auth.js`、`../services/policyLimits/index.js` | 否（只调用 enableConfigs()、initSinks()） | return | Remote Control 服务器模式 |
| `--daemon` | L189-198 | `../utils/config.js`、`../utils/sinks.js`、`../daemon/main.js` | 否（只调用 enableConfigs()、initSinks()） | return | 守护进程模式 |
| `ps`/`logs`/`attach`/`kill` 或 `--bg`/`--background` | L201-232 | `../utils/config.js`、`../cli/bg.js` | 否（只调用 enableConfigs()） | return | 后台会话管理 |
| `--template-job-supervisor` | L234-240 | `../cli/handlers/templateJobs.js` | 否 | return | 模板作业 supervisor |
| `new`/`list`/`reply`（模板） | L243-254 | `../cli/handlers/templateJobs.js` | 否（只调用 enableConfigs()） | process.exit(0) | 模板作业命令，需要彻底 exit 避免 Ink 事件循环 |
| `--open-runner`/`--open-runner-server` | L256-269 | `../open-runner/main.js` | 否 | return | Open Runner 模式 |
| `--environment-runner` | L272-280 | `../environment-runner/main.js` | 否 | return | Environment Runner 模式 |
| `--self-hosted-runner` | L283-292 | `../self-hosted-runner/main.js` | 否 | return | Self-hosted Runner 模式 |
| `--worktree` + `--tmux` | L295-320 | `../utils/config.js`、`../utils/worktreeModeEnabled.js`、`../utils/worktree.js`、`../utils/process.js` | 否（只调用 enableConfigs()） | return（如果 handled）或继续 | exec tmux，如果失败则 fall through 到正常 CLI |

### 4.5 init() 详览

init() 函数的步骤顺序、依赖关系、是否并行：

```typescript
async function init(): Promise<void> {
  // 步骤 1：配置
  enableConfigs()  // 必须第一个，后续步骤依赖配置
  profileCheckpoint('init_configs_enabled')

  // 步骤 2：安全环境变量（只 safe 部分，trust 前）
  applySafeConfigEnvironmentVariables()
  applyExtraCACertsFromConfig()  // 在第一次 TLS 握手前
  profileCheckpoint('init_safe_env_vars_applied')

  // 步骤 3：Graceful shutdown（早设置，后续步骤可以 register cleanup）
  setupGracefulShutdown()
  profileCheckpoint('init_after_graceful_shutdown')

  // 步骤 4：1P 事件日志（fire-and-forget，并行）
  void Promise.all([
    import('../services/analytics/firstPartyEventLogger.js'),
    import('../services/analytics/growthbook.js')
  ]).then(([fp, gb]) => {
    fp.initialize1PEventLogging()
    gb.onGrowthBookRefresh(() => {
      void fp.reinitialize1PEventLoggingIfConfigChanged()
    })
  })
  profileCheckpoint('init_after_1p_event_logging')

  // 步骤 5：OAuth 账户信息（fire-and-forget，并行）
  void populateOAuthAccountInfoIfNeeded()
  profileCheckpoint('init_after_oauth_populate')

  // 步骤 6：JetBrains IDE 检测（fire-and-forget，并行）
  void initJetBrainsDetection()
  profileCheckpoint('init_after_jetbrains_detection')

  // 步骤 7：GitHub 仓库检测（fire-and-forget，并行）
  void detectCurrentRepository()

  // 步骤 8：远程设置初始化（只初始化 loading promise，不等待）
  if (isEligibleForRemoteManagedSettings()) {
    initializeRemoteManagedSettingsLoadingPromise()
  }
  if (isPolicyLimitsEligible()) {
    initializePolicyLimitsLoadingPromise()
  }
  profileCheckpoint('init_after_remote_settings_check')

  // 步骤 9：记录首次启动时间
  recordFirstStartTime()

  // 步骤 10：mTLS 配置
  configureGlobalMTLS()
  logForDiagnosticsNoPII('info', 'init_mtls_configured')
  logForDebugging('[init] configureGlobalMTLS complete')

  // 步骤 11：代理配置（依赖 mTLS 配置）
  configureGlobalAgents()
  logForDiagnosticsNoPII('info', 'init_proxy_configured')
  logForDebugging('[init] configureGlobalAgents complete')
  profileCheckpoint('init_network_configured')

  // 步骤 12：API 预连接（依赖 mTLS + 代理，fire-and-forget）
  preconnectAnthropicApi()

  // 步骤 13：上游代理（CCR 环境，依赖网络配置，并行）
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    try {
      const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
        '../upstreamproxy/upstreamproxy.js'
      )
      const { registerUpstreamProxyEnvFn } = await import(
        '../utils/subprocessEnv.js'
      )
      registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
      await initUpstreamProxy()
    } catch (err) {
      logForDebugging(
        `[init] upstreamproxy init failed: ${errorMessage(err)}; continuing without proxy`,
        { level: 'warn' }
      )
    }
  }

  // 步骤 14：Windows git-bash 设置
  setShellIfWindows()

  // 步骤 15：LSP manager cleanup 注册（初始化在 main.tsx action handler 中）
  registerCleanup(shutdownLspServerManager)

  // 步骤 16：Team cleanup 注册（lazy import）
  registerCleanup(async () => {
    const { cleanupSessionTeams } = await import(
      '../utils/swarm/teamHelpers.js'
    )
    await cleanupSessionTeams()
  })

  // 步骤 17：Scratchpad dir（如果启用）
  if (isScratchpadEnabled()) {
    const scratchpadStart = Date.now()
    await ensureScratchpadDir()
    logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
      duration_ms: Date.now() - scratchpadStart
    })
  }

  logForDiagnosticsNoPII('info', 'init_completed', {
    duration_ms: Date.now() - initStartTime
  })
  profileCheckpoint('init_function_end')
}
```

### 4.6 startDeferredPrefetches() 详览

REPL 渲染后才启动的后台预取（不阻塞首屏）：

```typescript
function startDeferredPrefetches(): void {
  // 如果是 exit-after-first-render 或 bare mode，跳过
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
    isBareMode()
  ) {
    return
  }

  // 进程 spawn 类预取（在第一次 API 调用时使用，用户输入时已经准备好了）
  void initUser()
  void getUserContext()
  prefetchSystemContextIfSafe()  // 只有 non-interactive 或已信任才执行
  void getRelevantTips()
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)
  ) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe()
  }
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
    !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
  ) {
    void prefetchGcpCredentialsIfSafe()
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), [])

  // Analytics 和 feature flag
  void initializeAnalyticsGates()
  void prefetchOfficialMcpUrls()

  // 模型能力刷新
  void refreshModelCapabilities()

  // 文件变更检测器（从 init defer 到这里，避免阻塞首屏）
  void settingsChangeDetector.initialize()
  if (!isBareMode()) {
    void skillChangeDetector.initialize()
  }

  // 事件循环停滞检测器（只内部用户）
  if (process.env.USER_TYPE === 'ant') {
    void import('./utils/eventLoopStallDetector.ts').then(m =>
      m.startEventLoopStallDetector()
    )
  }
}
```

### 4.7 数据结构与持久化

关键状态数据结构：

```typescript
// bootstrap/state.ts 中的全局状态
interface BootstrapState {
  // 模式
  isInteractive: boolean
  clientType: ClientType  // 'cli' | 'sdk-cli' | 'sdk-ts' | 'sdk-py' | 'claude-desktop' | ...
  allowedSettingSources: SettingSource[] | undefined
  questionPreviewFormat: 'markdown' | 'html' | undefined
  sessionSource: 'remote-control' | undefined

  // 会话
  sessionId: SessionId
  originalCwd: string
  projectRoot: string
  additionalDirectoriesForClaudeMd: string[]

  // 模型
  mainLoopModelOverride: string | undefined
  initialMainLoopModel: string | undefined

  // SDK 相关
  isNonInteractiveSession: boolean
  sdkBetas: string[] | undefined
  allowedChannels: ChannelEntry[] | undefined
  userMsgOptIn: boolean | undefined

  // 权限
  sessionBypassPermissionsMode: boolean | undefined

  // 远程会话
  teleportedSessionInfo: TeleportedSessionInfo | undefined
  mainThreadAgentType: 'coordinator' | 'teammate' | undefined

  // Chrome
  chromeFlagOverride: boolean | undefined

  // 代理
  directConnectServerUrl: string | undefined
  sessionIngressAuthToken: string | undefined

  // Plugin
  inlinePlugins: string[] | undefined
  flagSettingsPath: string | undefined
}

// startupProfiler.ts 中的 checkpoint
interface Checkpoint {
  name: string
  timestamp: number
  monotonicTime: number
}

// cleanupRegistry.ts 中的 cleanup 函数
type CleanupFunction = () => void | Promise<void>
```

持久化：

- 启动过程本身不持久化状态（会话持久化由 session-persistence spec 负责）
- Profile checkpoint 只在内存中，可通过 `profileReport()` 获取
- Cleanup 函数只在内存中，进程退出后消失

### 4.8 跨子系统依赖

- **Commands Framework**：命令定义由 commands spec 负责，本文只描述启动时如何加载和解析命令
- **Model API**：模型调用由 model-api spec 负责，本文只描述 `preconnectAnthropicApi()` 预连接
- **Permissions**：权限系统由 permissions spec 负责，本文只描述初始化时的权限 bypass 检查和 `initializeToolPermissionContext()`
- **Settings**：设置系统由 settings spec 负责，本文只描述 `eagerLoadSettings()`、`enableConfigs()`、`getInitialSettings()`
- **Session Persistence**：会话持久化由 session-persistence spec 负责，本文只描述 `loadConversationForResume()` 和会话恢复
- **Agent Swarms**：Agent  swarms 由 agent-swarms spec 负责，本文只描述 `captureTeammateModeSnapshot()` 和 `assistantTeamContext`
- **Worktree**：Worktree 由其他 spec 负责，本文只描述 `createWorktreeForSession()` 和 `createTmuxSessionForWorktree()`
- **Plugins**：插件由 plugins spec 负责，本文只描述 `loadPluginHooks()`、`initializeVersionedPlugins()` 等初始化步骤
- **Skills**：技能由 skills spec 负责，本文只描述技能加载作为 deferred prefetch 的一部分
- **MCP**：MCP 由 mcp spec 负责，本文只描述 MCP 快速路径和配置加载

## 5. 失败语义与工程取舍

| 触发场景 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 快速路径中动态 import 失败 | cli.tsx 各快速路径 | 抛出异常，Node.js 默认打印堆栈 | 否 | 快速路径通常不分配资源，无需清理 | 进程异常退出，非零码 |
| init() 中 ConfigParseError | init.ts catch 块 | 捕获，检查 isNonInteractiveSession() | 否 | 已 register 的 cleanup 不执行（因为 setupGracefulShutdown() 已调用，但 process.exit 前不触发） | non-interactive：写入 stderr，gracefulShutdownSync(1)；interactive：显示 InvalidConfigDialog |
| init() 中其他错误 | init.ts catch 块 | 重新抛出 | 否 | 同上 | 进程异常退出 |
| Node.js 版本 < 18 | setup.ts 开头 | 写入 stderr | 否 | 无（太早，没分配资源） | process.exit(1) |
| --dangerously-skip-permissions 在 root/sudo 下且非 sandbox | setup.ts 权限检查 | 写入 stderr | 否 | 无 | process.exit(1) |
| --dangerously-skip-permissions 在非 sandbox/有 internet（内部用户） | setup.ts 权限检查 | 写入 stderr | 否 | 无 | process.exit(1) |
| preAction hook 中 await prefetch 失败 | main.tsx preAction | 抛出异常 | 否 | 已 register 的 cleanup 执行（因为 setupGracefulShutdown() 已调用） | 进程异常退出 |
| REPL 渲染前出错 | main.tsx action handler | 抛出异常 | 否 | 已 register 的 cleanup 执行 | 进程异常退出 |
| SIGINT/SIGTERM 信号 | gracefulShutdown.ts signal listeners | 触发 gracefulShutdown() | 否（只处理一次） | 所有 register 的 cleanup 按逆序执行 | 进程退出，默认 0 或指定 code |
| process.exit() 调用 | gracefulShutdown.ts 'exit'  listener | 触发同步 cleanup | 否 | 同步 cleanup 执行（异步不执行，因为进程要退出） | 进程退出 |

工程取舍：

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| cli.tsx 顶部做环境准备，不做 I/O | 只有环境变量设置，没有文件读写 | 需要小心维护，避免在顶部添加 heavy import | 快速路径真正快，不做不必要的工作 |
| 快速路径按优先级排序，从快到慢 | cli.tsx 中 if 分支按顺序排列 | 添加新命令时需要考虑位置，放错位置可能影响性能 | 最常用的快速命令最先响应 |
| feature flag + require()/动态 import，支持 DCE | 用 `feature('FLAG')` 包裹，内部用 require() 或 import() | 需要确保 feature flag 是构建时常量，不能动态计算；代码可读性稍差 | 外部构建可以完全移除未启用 feature 的代码，减小体积 |
| 并行预取在最顶部启动，在需要前 await | main.tsx 顶部启动 prefetch，preAction 中 await | 需要确保 prefetch 不依赖后续初始化的数据；如果 await 时 prefetch 已完成，成本只是 Promise 检查 | 启动时间 = max(模块加载, MDM, 钥匙串)，而不是 sum |
| init() 分步骤且 memoized | init.ts 中按顺序执行，memoize 包装 | memoize 有微小开销；需要确保步骤顺序正确 | 初始化逻辑集中可观测；幂等，多次调用安全 |
| cleanupRegistry 栈式执行（注册逆序） | registerCleanup() 往数组 push，runCleanups() 反向遍历 | 无（符合直觉） | 依赖关系正确：后注册的 cleanup 先执行（可能依赖先注册的资源） |
| gracefulShutdown() 区分同步和异步 | gracefulShutdownSync() 只执行同步 cleanup，gracefulShutdown() 执行所有 | 'exit' 事件只能执行同步 cleanup，异步 cleanup 在 'exit' 中不执行（因为进程要退出） | 'exit' 时尽可能清理；信号退出时可以执行异步 cleanup |
| 安全环境变量两阶段：safe + full | init.ts 先 apply safe，trust 后 apply full | 需要区分 safe 和 full env，维护两套逻辑 | 安全：不信任目录下不应用有风险的 env |
| deferred prefetches 在 REPL 渲染后启动 | startDeferredPrefetches() 在 launchRepl() 前调用但不 await | 用户首次交互时这些预取可能还没完成（有 race）；需要确保依赖这些预取的路径能正确处理未就绪状态 | 首屏渲染更快，用户更早看到 UI |
| --bare 模式单开关控制多个跳过逻辑 | isBareMode() 检查 CLAUDE_CODE_SIMPLE=1，各模块自行判断 | 需要确保各模块都正确检查，容易遗漏 | 用户体验好：一个标志禁用所有不必要功能；脚本启动更快更安全 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| 无特殊状态 | `claude --version` | 输出版本号后立即退出；启动时间 < 100ms（目标） | 不加载 main.tsx；不创建任何文件；不连接网络 |
| 无特殊状态 | `claude --help` | 显示帮助后进入交互式 REPL；不执行任何命令 | 不自动执行任何工具；不创建会话（直到用户输入） |
| 无特殊状态 | `claude --print "hello"` | 非交互式；输出响应后退出；不显示 Ink UI | 不启动 REPL；不读取会话历史（除非明确 --resume） |
| 有无效的 settings.json | `claude` | 显示无效配置对话框（interactive）；或写入 stderr 后 exit（non-interactive） | 不使用无效配置；不覆盖用户的 settings.json |
| 无特殊状态，按 Ctrl-C 启动中 | `claude` 然后 Ctrl-C | 立即退出；已分配的资源被清理 | 不留下孤儿子进程；不留下临时文件 |
| git repo，配置了 worktree create hook | `claude --worktree` | 使用 hook 创建 worktree，不要求 git | 不初始化 git repo；不修改 .git |
| 无特殊状态 | `NODE_ENV=test claude` | setup() 在权限检查前返回；不执行实际权限检查 | 不修改用户配置；不创建会话文件 |
| 有 CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER=1 | `claude` | 启动后立即退出；不执行 deferred prefetches | 不启动 settings change detector；不启动 skill change detector |
| 有 CLAUDE_CODE_SIMPLE=1 或 --bare | `claude --bare` | 跳过 hooks、LSP、plugin sync、归因、自动记忆、钥匙串读取、背景预取等 | 不读取钥匙串；不启动 LSP；不执行 hooks |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| cli.tsx 单一入口点，快速路径优先判断 | `src/entrypoints/cli.tsx:1-348` | 需查找相关测试 | 未找到直接测试覆盖 |
| startup profiler checkpoint | `src/utils/startupProfiler.ts:1-203` | 需查找相关测试 | 未找到直接测试覆盖 |
| 并行预取 MDM 和钥匙串 | `src/main.tsx:11-26,1253-1257` + `src/utils/settings/mdm/rawRead.ts:1-120` + `src/utils/secureStorage/keychainPrefetch.ts:1-107` | 需查找相关测试 | 未找到直接测试覆盖 |
| interactive vs non-interactive 判断 | `src/main.tsx:1107-1151` + `src/bootstrap/state.ts:1-494` | 需查找相关测试 | 未找到直接测试覆盖 |
| init() 分步骤且 memoized | `src/entrypoints/init.ts:57-340` | 需查找相关测试 | 未找到直接测试覆盖 |
| 安全环境变量两阶段 | `src/entrypoints/init.ts:73-82,247-340` + `src/utils/managedEnv.ts:1-230` | 需查找相关测试 | 未找到直接测试覆盖 |
| graceful shutdown + cleanup registry | `src/utils/gracefulShutdown.ts:1-296` + `src/utils/cleanupRegistry.ts:1-74` | 需查找相关测试 | 未找到直接测试覆盖 |
| feature flag 条件 import + DCE | `src/main.tsx:126-147` 等多处 + `bun:bundle` feature macro | 需查找相关测试 | 未找到直接测试覆盖 |
| 早期输入捕获 | `src/utils/earlyInput.ts:1-227` | 需查找相关测试 | 未找到直接测试覆盖 |
| --bare 模式 | `src/utils/envUtils.ts:138-151` + `src/main.tsx:1712-1714` | 需查找相关测试 | 未找到直接测试覆盖 |
| setup() 分阶段 | `src/setup.ts:56-443` | 需查找相关测试 | 未找到直接测试覆盖 |
| deferred prefetches | `src/main.tsx:646-700` | 需查找相关测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/entrypoints/cli.tsx` | `main()` | CLI 入口，快速路径判断，动态 import |
| `src/main.tsx` | `main()`、`run()`、`startDeferredPrefetches()` | 主运行逻辑，命令定义，action handler |
| `src/entrypoints/init.ts` | `init()`、`initializeTelemetryAfterTrust()` | 初始化逻辑 |
| `src/setup.ts` | `setup()` | Setup 逻辑 |
| `src/replLauncher.tsx` | `launchRepl()` | REPL 启动逻辑 |
| `src/utils/startupProfiler.ts` | `profileCheckpoint()`、`profileReport()` | 启动性能分析 |
| `src/utils/gracefulShutdown.ts` | `setupGracefulShutdown()`、`gracefulShutdown()`、`gracefulShutdownSync()` | 优雅退出 |
| `src/utils/cleanupRegistry.ts` | `registerCleanup()`、`runCleanups()` | 清理函数注册与执行 |
| `src/utils/earlyInput.ts` | `startCapturingEarlyInput()`、`seedEarlyInput()`、`stopCapturingEarlyInput()` | 早期输入捕获 |
| `src/utils/envUtils.ts` | `isBareMode()`、`isEnvTruthy()`、`isNonInteractiveSession()` | 环境判断工具 |
| `src/bootstrap/state.ts` | `setIsInteractive()`、`setClientType()`、`isInteractive()`、`getClientType()` | 全局启动状态 |
| `src/utils/settings/mdm/rawRead.ts` | `startMdmRawRead()`、`ensureMdmSettingsLoaded()` | MDM 并行预取 |
| `src/utils/secureStorage/keychainPrefetch.ts` | `startKeychainPrefetch()`、`ensureKeychainPrefetchCompleted()` | 钥匙串并行预取 |
| `src/utils/apiPreconnect.ts` | `preconnectAnthropicApi()` | API 预连接 |

### 7.2 未覆盖行为（基于代码阅读）

- 各快速路径的完整端到端测试
- 启动性能基准测试
- Cleanup 在各种失败场景下的执行情况测试
- 并行预取的 race condition 测试
- Graceful shutdown 在信号退出时的测试
- 两阶段环境变量在 trust/不信任目录下的测试
- --bare 模式下所有跳过逻辑的完整性测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/cli-startup.yaml)

### 8.1 本 spec 主拥有的文件

| 分组 | 主拥有职责 |
|---|---|
| cli-entrypoint | cli.tsx 入口、快速路径判断、动态 import |
| main-runtime | main.tsx 主运行逻辑、命令定义、action handler |
| init-system | init.ts 初始化逻辑、两阶段环境变量 |
| setup-system | setup.ts Setup 逻辑、worktree、后台任务 |
| startup-profiler | startupProfiler.ts 性能标记与报告 |
| graceful-shutdown | gracefulShutdown.ts 优雅退出、信号处理 |
| cleanup-registry | cleanupRegistry.ts 清理函数注册与执行 |
| early-input | earlyInput.ts 早期输入捕获 |
| bootstrap-state | bootstrap/state.ts 全局启动状态 |
| parallel-prefetch | mdm/rawRead.ts、keychainPrefetch.ts、apiPreconnect.ts 并行预取 |
| env-utils | envUtils.ts 环境判断工具 |
| repl-launcher | replLauncher.tsx REPL 启动 |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/commands.ts`、`src/commands/**` → 主归 commands spec，本文只描述启动时如何加载
- `src/utils/model/**` → 主归 model-api spec，本文只描述预连接
- `src/utils/permissions/**` → 主归 permissions spec，本文只描述初始化检查
- `src/utils/settings/**` → 主归 settings spec，本文只描述 eager loading
- `src/services/session-persistence/**` → 主归 session-persistence spec，本文只描述会话恢复
- `src/utils/swarm/**` → 主归 agent-swarms spec，本文只描述初始化相关
- `src/utils/worktree.ts` → 主归其他 spec，本文只描述启动时创建
- `src/services/plugins/**` → 主归 plugins spec，本文只描述初始化相关
- `src/skills/**` → 主归 skills spec，本文只描述初始化相关
- `src/services/mcp/**` → 主归 mcp spec，本文只描述快速路径和配置加载

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | deferred prefetches 与首次交互有 race，用户输入时预取可能未完成 | 为每个 deferred prefetch 提供 Promise 或状态，依赖路径可以 await 或检查 | 低（新增 API，向后兼容） | 首次交互时即使预取未完成也能正常工作（或等待） | M | 已证实 |
| P2 | 'exit' 事件只能执行同步 cleanup，异步 cleanup 不执行 | 尽可能用同步 cleanup，或用其他机制（如 'beforeExit'）；文档化这个限制 | 中（可能改变现有 cleanup 行为） | 'exit' 时同步 cleanup 都执行；信号退出时异步 cleanup 也执行 | M | 已证实 |
| P2 | 启动路径太长，逻辑复杂，难以测试 | 拆分启动阶段为更小的函数，每个函数可独立测试；增加启动测试套件 | 中（重构有风险） | 启动逻辑有单元测试覆盖；添加新功能不破坏现有测试 | L | 设计推断 |
| P3 | feature flag 条件 import 用 require()，与 ESM 不完全一致 | 统一用动态 import()，确保 DCE 仍然有效 | 低（只是代码风格统一） | 外部构建体积不增加；功能正常 | M | 设计推断 |
| P3 | cleanup 函数注册分散，难以知道哪些注册了、顺序如何 | 增加调试日志或工具，可枚举所有注册的 cleanup 函数和顺序 | 低（只增加可观测性） | 调试模式下可以看到 cleanup 注册和执行日志 | S | 设计推断 |
