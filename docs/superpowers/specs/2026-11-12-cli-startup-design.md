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
