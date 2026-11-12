---
id: diagnostics
batch: 7
title: Diagnostics 诊断采集、调试与导出设计
date: 2026-11-12
status: draft
---

# Diagnostics 诊断采集、调试与导出设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要一套完整的诊断系统来解决以下问题：

- 调试日志分散：日志分散在各处，没有统一分类和过滤机制
- 性能问题难以定位：没有时间线和 checkpoint 来追踪性能瓶颈
- 错误无法回溯：错误发生后缺少上下文信息，难以复现和诊断
- 内存泄漏难以检测：没有 heap dump 和分析工具来识别内存问题
- 用户问题报告困难：缺少结构化诊断数据，用户报告问题时信息不完整
- 敏感信息泄露风险：诊断数据可能包含 API key、文件路径、用户代码等敏感信息，需要严格脱敏
- 性能开销问题：性能诊断不能影响正常使用，需要采样和可开关
- 启动早期错误丢失：错误日志 sink 可能还未初始化时就发生错误
- IDE 诊断追踪：需要支持 LSP 诊断基线对比，检测编辑后的新增问题
- 零默认开销：profiling 默认关闭，只有采样或显式开启时才产生开销

关键约束条件：

- 严格隐私边界：诊断导出绝不包含用户代码、文件路径、API key、prompts 等敏感信息；仅包含错误分类、时间戳、性能指标、内存使用、checkpoint 名称
- 多级别调试：支持 `--debug`、`--debug=category`、`--debug-file`、`--debug-to-stderr` 等多种调试模式
- 分层性能分析：启动 profiling（采样）、query profiling（可开关）、headless profiling（非交互）
- 内存诊断：支持 heap dump + 内存指标采集，诊断优先于 heap snapshot（因为 snapshot 可能崩溃）
- 错误隔离：错误日志独立存储，支持 sink 模式，启动前的错误先排队后处理
- IDE 诊断跟踪：支持 LSP 诊断基线对比，检测编辑后的新增问题

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|-----|---------|----------|---------------------|-----|------|
| 调试日志分类过滤 | `parseDebugFilter()` 解析 `--debug=pattern`，`extractDebugCategories()` 从消息提取分类，`shouldShowDebugMessage()` 判断 | 支持包含模式（`api,git`）和排除模式（`!mcp,!1p`）；从消息前缀提取分类如 `api: ...` 或 `[MCP] ...`；不支持混合模式 | 用户只想看某类日志时无需看全部；排除模式可屏蔽噪音；混合模式会造成歧义 | 需要在每个调试日志调用点正确标记分类，否则过滤无效 | `src/utils/debugFilter.ts:16-139` |
| 调试日志写入模式 | `immediateMode` vs 缓冲模式 | `isDebugMode()` 为 true 时用同步追加（保证崩溃时不丢失）；否则用 1 秒刷新缓冲（减少 I/O） | `--debug` 模式下需要立即看到日志；正常模式下缓冲减少开销 | 两种模式需要分别处理，增加复杂度 | `src/utils/debug.ts:155-196` |
| 错误日志 sink 模式 | `attachErrorLogSink()` 允许延迟初始化 | `logError()` 在 sink 未 attach 前先排队到 `errorQueue`，attach 后立即 drain；sink 提供 `logError`、`logMCPError`、`logMCPDebug`、路径获取 | 避免启动早期（sink 未初始化）的错误丢失；sink 可以独立替换（测试时用 mock） | 需要维护队列和 sink 两个路径，容易遗漏 | `src/utils/log.ts:82-135` |
| 诊断导出严格脱敏 | `sanitizeErrorForDiagnostics()` 只返回分类，不包含错误文本 | 先用 `redactSensitiveInfo()` 处理，然后只保留分类（`rate-limit`、`authentication`、`network`、`validation`、`permission`、`mcp`、`other`），不包含任何原始错误内容 | 防止诊断导出时泄露敏感信息（API key、用户代码、文件路径等） | 只能看到错误类型，无法看到具体错误细节，需要配合其他调试手段 | `src/commands/perf-issue/perf-issue.tsx:21-42` |
| 诊断导出用 `writeNewDiagnosticJson()` 只写新文件 | 用 `fs.open(path, 'wx', 0o600)` 原子性创建，避免覆盖现有诊断文件 | 防止误覆盖用户已保存的诊断报告 | 需要用户提供未使用的路径，或自动生成带时间戳的文件名 | `src/utils/diagnosticExport.ts:3-16` |
| Heap dump 先写诊断，后写 snapshot | `performHeapDump()` 顺序 | 先调用 `captureMemoryDiagnostics()` 并写入 JSON；再调用 `writeHeapSnapshot()`；诊断更可靠且体积小 | V8 heap snapshot 在大内存时可能崩溃或 OOM；先保存诊断至少能拿到内存指标 | 需要两次文件写入，但诊断很小，代价可接受 | `src/utils/heapDumpService.ts:214-278` |
| 内存诊断包含泄漏指标 | `captureMemoryDiagnostics()` 收集 detached contexts、active handles、file descriptors、smaps_rollup（Linux） | detached contexts 是 V8 泄漏的强信号；active handles 指示异步资源泄漏；file descriptors 指示资源泄漏；smaps_rollup 提供 Linux 详细内存分布 | 仅凭 heap snapshot 难以诊断 native 泄漏；需要多维度指标 | 需要读取 `/proc` 文件系统（Linux），跨平台差异大 | `src/utils/heapDumpService.ts:88-213` |
| 启动 profiling 采样决策 | 模块加载时决策一次 | `STATSIG_LOGGING_SAMPLED = process.env.USER_TYPE === 'ant' || Math.random() < 0.005`，决策一次后不变；profiling 始终对采样用户启用 | 采样收集性能数据，不影响大部分用户；ant 用户需要 100% 覆盖以诊断内部问题；随机决策一次避免模块 reload 时改变行为 | 采样用户的启动有轻微开销（但比全量 profiler 小） | `src/utils/startupProfiler.ts:29-36` |
| Query profiling 显式开关 | `CLAUDE_CODE_PROFILE_QUERY=1` 启用 | 默认关闭，用户显式启用时才记录 checkpoint 和内存；每个 query 结束可输出时间线和 phase breakdown | 避免每个 query 都产生开销；用户需要时才开启详细诊断 | 需要用户重启 CLI 启用，不够方便 | `src/utils/queryProfiler.ts:35-38` |
| Startup profiler 内存快照用数组 | `memorySnapshots: NodeJS.MemoryUsage[]` | checkpoint 可能重复触发（如 `loadSettingsFromDisk_start`），用 Map 会覆盖之前的 snapshot；数组按顺序记录，与 perf_hooks 的 mark 顺序一致 | 重复 checkpoint 名是合法的（同一阶段多次执行），需要分别记录每次的内存状态 | 需要同步维护 perf_hooks marks 和内存数组两个列表 | `src/utils/startupProfiler.ts:46-60` |
| IDE 诊断跟踪用 `_claude_fs_right` URI | `DiagnosticTrackingService` 对比 file:// 和 _claude_fs_right URI 的诊断 | IDE 对 Claude 修改的文件（_claude_fs_right）提供诊断；优先用 _claude_fs_right 的诊断检测新增问题；同时跟踪 baseline（编辑前）诊断 | 可以检测 Claude 编辑引入的新问题，而不是文件中已有的问题 | 需要处理两个 URI 体系，路径归一化复杂 | `src/services/diagnosticTracking.ts:30-284` |
| 诊断跟踪用 normalized path 做 key | `normalizeFileUri()` 去除协议前缀，用平台归一化路径 | Windows/macOS/Linux 路径格式不同；IDE 可能返回 file:// 或 _claude_fs_right:// 前缀；需要用统一 key 匹配 baseline | 同一文件的不同 URI 表示能正确匹配，避免 baseline 失效 | 需要在所有路径使用点调用 normalize，容易遗漏 | `src/services/diagnosticTracking.ts:78-97` |
| `/doctor` 检查多维度问题 | `getDoctorDiagnostic()` 包含安装类型、权限、多个安装、配置问题、上下文警告 | 一次性检查用户最常遇到的问题：多个安装冲突、PATH 配置、权限不足、自动更新状态、上下文大小超限、不可达权限规则 | 用户遇到问题时先跑 `/doctor`，能自助解决大部分常见问题 | 需要维护大量检查逻辑，跨平台差异大 | `src/utils/doctorDiagnostic.ts:514-625` |
| 安装检测用多方验证 | `getCurrentInstallationType()` 检查 bundled mode、环境、路径模式 | 先检查 NODE_ENV=development；再检查 bundled mode；再检查 npm 全局/本地路径；最后 fallback 到 unknown | 单一检测方式容易误判，多方验证更可靠 | 检测逻辑复杂，需要处理各种边缘情况 | `src/utils/doctorDiagnostic.ts:86-148` |
| 多个安装检测主动扫描 | `detectMultipleInstallations()` 检查 npm global、npm local、native、config | 扫描常见安装位置；区分 active 安装和 leftover 安装；对 leftover 提供卸载建议 | 用户可能同时安装多个版本而不自知，导致版本混乱 | 需要扫描多个位置，可能有 false positive | `src/utils/doctorDiagnostic.ts:205-315` |
| 上下文警告用 async 并行检查 | `checkContextWarnings()` 并行检查 CLAUDE.md、agent descriptions、MCP tools、不可达规则 | 各检查独立，并行执行更快；检查结果包含当前值、阈值、修复建议 | 同步检查会延迟 `/doctor` 响应 | 需要处理 Promise.all 的错误传播 | `src/utils/doctorContextWarnings.ts:246-265` |
| `/debug-tool-call` 只验证 schema | `inspectSavedInputSchema()` 用 Zod schema 验证，不调用 `call()` 或 `checkPermissions()` | 安全地检查历史工具调用的输入是否符合当前 schema；不会产生副作用（如再次执行文件修改或命令）；不会触发权限检查 | 用户想知道为什么工具调用失败时，不需要重新执行就能诊断 | 需要工具定义完整的 inputSchema，否则无法验证 | `tests/debugToolCallCommand.test.ts:62-82` |
| `/debug-tool-call` 配对 tool_use 和 tool_result | `collectToolCalls()` 按 ID 配对，支持多个 result | 同一 tool_use ID 可能有多个 tool_result（重试或多轮）；区分 success/error；计算 elapsed time | 完整呈现工具调用的生命周期 | 需要遍历整个消息历史，复杂度 O(n) | `tests/debugToolCallCommand.test.ts:46-60` |
| Headless profiler 只在非交互模式启用 | `getIsNonInteractiveSession()` 判断 | 非交互模式（`-p`、print mode）的性能问题更难诊断；交互模式有其他调试手段；避免交互模式下的额外开销 | 交互模式下无法使用 headless profiler | `src/utils/headlessProfiler.ts:62-68` |
| 错误分类用正则匹配 | `categorizeError()` 匹配错误文本中的关键词 | 快速将错误归类为常见类型，无需完整错误文本；即使错误被 redact 也能分类 | 分类可能不准确，依赖关键词匹配；新错误类型需要更新正则 | `src/commands/perf-issue/perf-issue.tsx:21-31` |
| 诊断日志明确禁止 PII | `logForDiagnosticsNoPII()` 明确禁止 PII，只接受 event 名和安全数据 | 诊断日志可能发送到环境管理器，必须确保无敏感信息；函数签名和注释明确强调这一点 | 调试信息有限，只能看到 event 流，看不到细节 | `src/utils/diagLogs.ts:26-57` |
| Error sink 用 JSONL 格式 | 每行一个 JSON 对象，支持逐行解析 | 即使文件被截断或部分损坏，也能解析剩余行；append 操作简单；无需重写整个文件 | JSONL 不直观，需要工具查看；没有人类可读格式 | `src/utils/errorLogSink.ts:250-261` |
| 诊断日志环境变量控制 | `CLAUDE_CODE_DIAGNOSTICS_FILE` 指定日志路径 | 环境管理器可以设置此变量来收集诊断；不设置时禁用诊断日志 | 需要外部设置才能启用 | `src/utils/diagLogs.ts:59-62` |
| Event loop stall detector 占位 | `startEventLoopStallDetector()` 当前返回禁用 | 为未来功能预留接口；当前未实现但 API 已定义 | 无功能，只是占位 | `src/utils/eventLoopStallDetector.ts:1-6` |

## 3. 目标与非目标

### 诊断采集

- **目标**：`logForDiagnosticsNoPII()` 记录无 PII 的诊断事件
- **目标**：`withDiagnosticsTiming()` 包装异步函数，记录开始/完成/失败事件和耗时
- **目标**：`errorLogSink` 记录错误和 MCP 日志到 JSONL 文件
- **目标**：`DiagnosticTrackingService` 跟踪 IDE 诊断变化，检测新增问题
- **非目标**：不收集用户代码、prompts、文件路径等 PII 到诊断导出

### 调试系统

- **目标**：`logForDebugging()` 按分类记录调试日志，支持过滤
- **目标**：`isDebugMode()`、`isDebugToStderr()`、`getDebugFilePath()` 检测调试模式
- **目标**：`enableDebugLogging()` 运行时启用调试日志
- **目标**：`parseDebugFilter()` 解析 `--debug=pattern`，支持包含/排除
- **目标**：`extractDebugCategories()` 从消息提取分类
- **目标**：`shouldShowDebugMessage()` 根据 filter 判断是否显示
- **非目标**：不提供远程调试服务器

### 性能分析

- **目标**：`startupProfiler` 记录启动 checkpoint，采样上报 Statsig
- **目标**：`queryProfiler` 记录 query 各阶段耗时，输出时间线
- **目标**：`headlessProfiler` 在非交互模式下记录性能指标
- **目标**：`getStartupProfileData()`、`getQueryProfileData()` 提供结构化性能数据
- **非目标**：不提供火焰图（但 checkpoint 可用于生成）

### 内存诊断

- **目标**：`performHeapDump()` 写入 heap snapshot 和诊断 JSON 到桌面
- **目标**：`captureMemoryDiagnostics()` 收集多维度内存指标
- **目标**：检测 detached contexts、active handles、FD 泄漏
- **非目标**：不自动分析 heap snapshot（需要外部工具如 Chrome DevTools）

### 诊断导出

- **目标**：`/perf-issue` 导出结构化诊断 JSON，包含启动/query checkpoint、错误分类、内存、MCP 数量
- **目标**：`writeNewDiagnosticJson()` 原子性创建新文件
- **目标**：`sanitizeErrorForDiagnostics()` 严格脱敏
- **非目标**：不自动上传诊断（用户手动分享）

### 工具调用调试

- **目标**：`/debug-tool-call` 列出历史工具调用，配对 tool_use/tool_result
- **目标**：`inspectSavedInputSchema()` 验证输入是否符合当前 schema
- **目标**：不实际执行工具，不触发权限检查
- **非目标**：不提供工具调用重放功能

### 医生检查

- **目标**：`/doctor` 检查安装类型、多个安装、配置问题、权限、自动更新状态
- **目标**：`checkContextWarnings()` 检查 CLAUDE.md、agent descriptions、MCP tools、不可达规则
- **目标**：提供明确的修复建议
- **非目标**：不自动修复问题（只提供建议）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 调试系统入口
function isDebugMode(): boolean
function isDebugToStderr(): boolean
function getDebugFilePath(): string | null
function enableDebugLogging(): boolean
function logForDebugging(message: string, options?: { level?: DebugLogLevel }): void
function getDebugFilter(): DebugFilter | null
function parseDebugFilter(filterString: string): DebugFilter | null
function shouldShowDebugMessage(message: string, filter: DebugFilter | null): boolean

// 错误日志入口
function logError(error: unknown): void
function logMCPError(serverName: string, error: unknown): void
function logMCPDebug(serverName: string, message: string): void
function attachErrorLogSink(sink: ErrorLogSink): void
function getInMemoryErrors(): Array<{ error: string; timestamp: string }>

// 诊断日志入口
function logForDiagnosticsNoPII(level: DiagnosticLogLevel, event: string, data?: Record<string, unknown>): void
function withDiagnosticsTiming<T>(event: string, fn: () => Promise<T>, getData?: (result: T) => Record<string, unknown>): Promise<T>

// 性能分析入口
function startQueryProfile(): void
function queryCheckpoint(name: string): void
function endQueryProfile(): void
function getQueryProfileData(): QueryProfileData
function getQueryProfileReport(): string

function profileCheckpoint(name: string): void
function profileReport(): void
function getStartupProfileData(): StartupProfileData
function getStartupPerfLogPath(): string

function headlessProfilerStartTurn(): void
function headlessProfilerCheckpoint(name: string): void
function logHeadlessProfilerTurn(): void

// 内存诊断入口
function performHeapDump(trigger?: 'manual' | 'auto-1.5GB', dumpNumber?: number): Promise<HeapDumpResult>
function captureMemoryDiagnostics(trigger: 'manual' | 'auto-1.5GB', dumpNumber?: number): Promise<MemoryDiagnostics>

// 诊断导出入口
function writeNewDiagnosticJson(path: string, value: unknown): Promise<void>
function buildPerfIssueReport(context: LocalJSXCommandContext, overrides?: Partial<PerfIssueDependencies>): PerfIssueReport
function sanitizeErrorForDiagnostics(error: string): { category: string }

// IDE 诊断跟踪入口
class DiagnosticTrackingService {
  static getInstance(): DiagnosticTrackingService
  initialize(mcpClient: MCPServerConnection): void
  reset(): void
  beforeFileEdited(filePath: string): Promise<void>
  getNewDiagnostics(): Promise<DiagnosticFile[]>
  static formatDiagnosticsSummary(files: DiagnosticFile[]): string
}

// 医生检查入口
function getDoctorDiagnostic(): Promise<DiagnosticInfo>
function checkContextWarnings(tools: Tool[], agentInfo: AgentDefinitionsResult | null, getToolPermissionContext: () => Promise<ToolPermissionContext>): Promise<ContextWarnings>
```

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要职责 | 不承担的职责 | 与其他模块的接口 |
|-----------|----------|---------|------------|----------------|
| `debug.ts` | `runtimeDebugEnabled`、`debugWriter`、`pendingWrite`、`hasFormattedOutput` | `logForDebugging`、`isDebugMode`、`enableDebugLogging`、`getDebugLogPath` | 日志分类过滤（委托给 debugFilter） | 提供调试日志入口，调用 bufferedWriter |
| `debugFilter.ts` | 无（纯函数） | `parseDebugFilter`、`extractDebugCategories`、`shouldShowDebugMessage` | 实际日志写入 | 被 debug.ts 调用 |
| `log.ts` | `inMemoryErrorLog`、`errorQueue`、`errorLogSink` | `logError`、`logMCPError`、`logMCPDebug`、`attachErrorLogSink`、`getInMemoryErrors` | 实际文件写入（委托给 errorLogSink） | 提供错误日志入口，queue 早期错误 |
| `errorLogSink.ts` | `logWriters` (Map 路径 → JsonlWriter) | `logError`、`logMCPError`、`logMCPDebug`、`getErrorsPath`、`getMCPLogsPath` | 错误分类（委托给 perf-issue） | 实现 ErrorLogSink 接口，写入 JSONL |
| `diagLogs.ts` | 无（纯函数） | `logForDiagnosticsNoPII`、`withDiagnosticsTiming` | 诊断数据的消费（由环境管理器负责） | 提供诊断日志入口，写入环境变量指定文件 |
| `diagnosticExport.ts` | 无（纯函数） | `writeNewDiagnosticJson` | 诊断数据的生成（委托给 perf-issue） | 原子性写入诊断 JSON |
| `startupProfiler.ts` | `memorySnapshots`、`reported` | `profileCheckpoint`、`profileReport`、`getStartupProfileData` | query profiling（独立模块） | 使用 perf_hooks，记录启动 checkpoint |
| `queryProfiler.ts` | `memorySnapshots`、`queryCount`、`firstTokenTime` | `startQueryProfile`、`queryCheckpoint`、`endQueryProfile`、`getQueryProfileData`、`getQueryProfileReport` | startup profiling（独立模块） | 使用 perf_hooks，记录 query checkpoint |
| `headlessProfiler.ts` | `currentTurnNumber` | `headlessProfilerStartTurn`、`headlessProfilerCheckpoint`、`logHeadlessProfilerTurn` | 交互模式 profiling | 仅在非交互模式启用，记录 turn 性能 |
| `heapDumpService.ts` | 无（纯函数） | `performHeapDump`、`captureMemoryDiagnostics` | heap snapshot 分析（需要外部工具） | 调用 v8.getHeapSnapshot()，写入桌面 |
| `doctorDiagnostic.ts` | 无（纯函数） | `getDoctorDiagnostic`、`getCurrentInstallationType`、`detectMultipleInstallations`、`detectConfigurationIssues` | 自动修复（只提供建议） | 检查安装配置，提供诊断和修复建议 |
| `doctorContextWarnings.ts` | 无（纯函数） | `checkContextWarnings`、`checkClaudeMdFiles`、`checkAgentDescriptions`、`checkMcpTools`、`checkUnreachableRules` | 自动修复（只提供建议） | 检查上下文问题，提供警告 |
| `diagnosticTracking.ts` | `baseline` (Map)、`rightFileDiagnosticsState` (Map)、`lastProcessedTimestamps` (Map)、`initialized`、`mcpClient` | `beforeFileEdited`、`getNewDiagnostics`、`reset`、`formatDiagnosticsSummary` | 诊断自动修复（只检测） | 通过 MCP 与 IDE 通信，获取诊断 |
| `commands/doctor/` | 无（命令 UI） | `/doctor` 命令界面 | 实际诊断逻辑（委托给 doctorDiagnostic） | 渲染 Doctor 组件 |
| `commands/perf-issue/` | 无（命令 UI） | `/perf-issue` 命令界面、`buildPerfIssueReport`、`sanitizeErrorForDiagnostics` | 诊断上传（用户手动） | 渲染 DiagnosticExportDialog 组件 |
| `commands/heapdump/` | 无（命令入口） | `/heapdump` 命令 | heap dump 分析（需要外部工具） | 调用 performHeapDump |
| `commands/debug-tool-call/` | 无（命令 UI） | `/debug-tool-call` 命令界面、`collectToolCalls`、`formatSavedToolCalls`、`inspectSavedInputSchema` | 工具调用重放（只验证） | 检查历史工具调用，验证 schema |

状态位置与理由：

- **调试状态**放在 `debug.ts` 模块级：`runtimeDebugEnabled` 需要在运行时改变；`debugWriter` 需要持久化以缓冲写入
- **错误队列**放在 `log.ts` 模块级：需要在 sink attach 前缓存错误
- **诊断跟踪状态**放在 `DiagnosticTrackingService` 单例：需要跨 query 保持 baseline，单例确保全局唯一
- **profiler 状态**放在各自模块级：startup/query/headless profiling 独立，互不干扰
- **内存快照**放在 `memorySnapshots` 数组：需要与 perf_hooks marks 顺序对应，支持重复 checkpoint 名

### 4.3 主控制流

#### 调试日志流程

```
启动时检查 --debug/--debug=pattern/--debug-file/--debug-to-stderr
    ↓
isDebugMode() = true → immediateMode（同步追加）
isDebugMode() = false → bufferedMode（1 秒刷新）
    ↓
logForDebugging("category: message", { level })
    ↓
extractDebugCategories(message) → ["category"]
    ↓
shouldShowDebugMessage(message, filter) → true/false
    ↓
true → 写入 debug log 文件或 stderr
false → 丢弃
    ↓
同时更新 latest symlink 指向当前 log
```

#### 错误日志流程

```
早期错误（sink 未 attach）
    ↓
push 到 errorQueue
    ↓
initializeErrorLogSink() 调用 attachErrorLogSink(sink)
    ↓
立即 drain errorQueue 到 sink
    ↓
后续错误直接调用 sink.logError()
    ↓
同时添加到 inMemoryErrorLog（最多 100 条）
    ↓
写入 ~/.claude/errors/{date}.jsonl
    ↓
MCP 错误/调试写入 ~/.claude/mcp-logs/{server}/{date}.jsonl
```

#### 启动 Profiling 流程

```
模块加载时决定采样：STATSIG_LOGGING_SAMPLED
    ↓
是 → 启用 profiling
否 → 无操作
    ↓
main.tsx 各阶段调用 profileCheckpoint("stage-name")
    ↓
如果是详细模式（CLAUDE_CODE_PROFILE_STARTUP=1），同时记录 memorySnapshots
    ↓
profileReport() 调用
    ↓
采样用户 → logEvent("tengu_startup_perf", metadata)
详细模式 → 写入 ~/.claude/startup-perf/{session}.txt + logForDebugging
```

#### Query Profiling 流程

```
CLAUDE_CODE_PROFILE_QUERY=1 时启用
    ↓
startQueryProfile() 清除之前 marks
    ↓
各阶段调用 queryCheckpoint("query_*")
    ↓
endQueryProfile() 记录结束
    ↓
getQueryProfileReport() 生成时间线 + phase breakdown
    ↓
包含 TTFT、pre-request overhead、网络延迟等关键指标
```

#### IDE 诊断跟踪流程

```
query 开始：handleQueryStart(clients)
    ↓
找到 connected IDE client → initialize()
    ↓
编辑文件前：beforeFileEdited(filePath)
    ↓
调用 IDE getDiagnostics(file://{filePath})
    ↓
保存到 baseline[normalizedPath]
    ↓
编辑后：getNewDiagnostics()
    ↓
获取 file:// 和 _claude_fs_right:// 的当前诊断
    ↓
对比 baseline，找出新增问题
    ↓
优先用 _claude_fs_right:// 的诊断（如果有）
    ↓
formatDiagnosticsSummary() 生成人类可读输出
```

#### `/perf-issue` 导出流程

```
用户运行 /perf-issue [path]
    ↓
buildPerfIssueReport() 收集：
    ├─ startup profile data
    ├─ query profile data（checkpoints 截断到最近 256）
    ├─ recent errors（最多 20 条，只保留分类）
    ├─ MCP server count
    └─ memory usage（rss/heapUsed/heapTotal/external/arrayBuffers）
    ↓
sanitizeErrorForDiagnostics() 对每个错误脱敏
    ↓
writeNewDiagnosticJson() 原子性创建文件（wx 模式）
    ↓
用户可以手动分享生成的 JSON
```

#### `/heapdump` 流程

```
用户运行 /heapdump
    ↓
captureMemoryDiagnostics("manual", 0)
    ├─ sessionId, timestamp, trigger
    ├─ memoryUsage, memoryGrowthRate
    ├─ v8HeapStats（detached contexts, malloced memory）
    ├─ v8HeapSpaces（如果可用）
    ├─ resourceUsage（maxRSS, CPU time）
    ├─ activeHandles, activeRequests, openFileDescriptors（如果可用）
    ├─ smaps_rollup（Linux 仅）
    └─ analysis.potentialLeaks
    ↓
写入 ~/Desktop/{sessionId}-diagnostics.json（先写，更可靠）
    ↓
writeHeapSnapshot() 写入 ~/Desktop/{sessionId}.heapsnapshot
    ├─ Node.js：stream pipeline 到文件
    └─ Bun：同步写入，然后 gc
    ↓
logEvent("tengu_heap_dump", { trigger, success })
```

#### `/doctor` 流程

```
用户运行 /doctor
    ↓
并行运行：
    ├─ getDoctorDiagnostic()
    │   ├─ getCurrentInstallationType()
    │   ├─ detectMultipleInstallations()
    │   ├─ detectConfigurationIssues()
    │   └─ check ripgrep status / check auto-update state
    └─ checkContextWarnings()
        ├─ checkClaudeMdFiles()
        ├─ checkAgentDescriptions()
        ├─ checkMcpTools()
        └─ checkUnreachableRules
    ↓
渲染 Doctor 组件，显示所有问题和修复建议
```

#### `/debug-tool-call` 流程

```
用户运行 /debug-tool-call [tool-use-id] [--validate]
    ↓
collectToolCalls(messages)
    ├─ 按 tool_use ID 分组
    ├─ 配对 tool_use 和 tool_result
    ├─ 支持多个 result
    └─ 计算 elapsed time
    ↓
如果提供 ID 且 --validate：
    ├─ inspectSavedInputSchema(toolCall, tool)
    └─ 用 Zod schema 验证输入
    ↓
formatSavedToolCalls() 格式化输出
    ├─ 显示工具名、输入、结果、耗时
    ├─ 截断大结果
    └─ 不实际执行
```

### 4.4 数据结构

#### 调试相关

```typescript
type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

type DebugFilter = {
  include: string[]
  exclude: string[]
  isExclusive: boolean  // true = exclude 模式
}
```

#### 错误相关

```typescript
type ErrorLogSink = {
  logError(error: Error): void
  logMCPError(serverName: string, error: unknown): void
  logMCPDebug(serverName: string, message: string): void
  getErrorsPath(): string
  getMCPLogsPath(serverName: string): string
}

type QueuedErrorEvent =
  | { type: 'error'; error: Error }
  | { type: 'mcpError'; serverName: string; error: unknown }
  | { type: 'mcpDebug'; serverName: string; message: string }
```

#### 性能分析相关

```typescript
type QueryProfileData = {
  enabled: boolean
  queryCount: number
  checkpoints: Array<{ name: string; startTimeMs: number; durationMs: number }>
  totalTimeMs: number
}

type StartupProfileData = {
  detailedEnabled: boolean
  checkpointCount: number
  phases: Array<{ name: string; durationMs: number }>
  totalTimeMs: number
}
```

#### 内存诊断相关

```typescript
type MemoryDiagnostics = {
  timestamp: string
  sessionId: string
  trigger: 'manual' | 'auto-1.5GB'
  dumpNumber: number
  uptimeSeconds: number
  memoryUsage: { heapUsed: number; heapTotal: number; external: number; arrayBuffers: number; rss: number }
  memoryGrowthRate: { bytesPerSecond: number; mbPerHour: number }
  v8HeapStats: { heapSizeLimit: number; mallocedMemory: number; peakMallocedMemory: number; detachedContexts: number; nativeContexts: number }
  v8HeapSpaces?: Array<{ name: string; size: number; used: number; available: number }>
  resourceUsage: { maxRSS: number; userCPUTime: number; systemCPUTime: number }
  activeHandles: number
  activeRequests: number
  openFileDescriptors?: number
  analysis: { potentialLeaks: string[]; recommendation: string }
  smapsRollup?: string
  platform: string
  nodeVersion: string
  ccVersion: string
}

type HeapDumpResult = {
  success: boolean
  heapPath?: string
  diagPath?: string
  error?: string
}
```

#### 诊断导出相关

```typescript
type PerfIssueReport = {
  schemaVersion: 1
  kind: 'claude-code-performance-diagnostics'
  generatedAt: string
  version: string
  platform: string
  arch: string
  runtimeVersion: string
  startup: StartupProfileData & { textReportAvailable: boolean }
  query: QueryProfileData
  recentErrors: Array<{ timestamp: string; category: string }>
  mcpServerCount: number
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number; arrayBuffersBytes: number }
}
```

#### IDE 诊断相关

```typescript
type Diagnostic = {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  source?: string
  code?: string
}

type DiagnosticFile = {
  uri: string
  diagnostics: Diagnostic[]
}
```

#### 医生检查相关

```typescript
type InstallationType = 'npm-global' | 'npm-local' | 'native' | 'package-manager' | 'development' | 'unknown'

type DiagnosticInfo = {
  installationType: InstallationType
  version: string
  installationPath: string
  invokedBinary: string
  configInstallMethod: InstallMethod | 'not set'
  autoUpdates: string
  hasUpdatePermissions: boolean | null
  multipleInstallations: Array<{ type: string; path: string }>
  warnings: Array<{ issue: string; fix: string }>
  recommendation?: string
  packageManager?: string
  ripgrepStatus: { working: boolean; mode: 'system' | 'builtin' | 'embedded'; systemPath: string | null }
}

type ContextWarning = {
  type: 'claudemd_files' | 'agent_descriptions' | 'mcp_tools' | 'unreachable_rules'
  severity: 'warning' | 'error'
  message: string
  details: string[]
  currentValue: number
  threshold: number
}

type ContextWarnings = {
  claudeMdWarning: ContextWarning | null
  agentWarning: ContextWarning | null
  mcpWarning: ContextWarning | null
  unreachableRulesWarning: ContextWarning | null
}
```

## 5. 失败语义与工程取舍

### 5.1 隐私边界

| 边界 | 如何执行 | 证据 |
|-----|---------|-----|
| 诊断导出无 PII | `sanitizeErrorForDiagnostics()` 只返回分类，不包含错误文本；先用 `redactSensitiveInfo()` 处理 | `src/commands/perf-issue/perf-issue.tsx:33-42` |
| 调试日志默认不记录（ant 用户例外） | `shouldLogDebugMessage()`：`USER_TYPE !== 'ant' && !isDebugMode()` 时不写入 | `src/utils/debug.ts:103-125` |
| 诊断日志明确禁止 PII | `logForDiagnosticsNoPII()` 注释和函数签名强调无 PII；只接受 event 名和安全 data | `src/utils/diagLogs.ts:14-25` |
| 错误日志不持久化（隐私模式） | `shouldPersistLocalLogs()`：禁用错误报告、essential traffic、Bedrock/Vertex/Foundry 时不写入 | `src/utils/errorLogSink.ts:112-121` |
| 文件权限 0o600 | 诊断文件、heap snapshot、debug log 都用 0o600 权限 | `src/utils/diagnosticExport.ts:10`、`src/utils/heapDumpService.ts:250` |

### 5.2 并发安全

| 问题 | 如何解决 | 证据 |
|-----|---------|-----|
| 错误 sink attach 前的错误丢失 | `errorQueue` 排队，attach 后立即 drain | `src/utils/log.ts:91-135` |
| 调试日志并发写入 | `createBufferedWriter()` 处理缓冲和刷新 | `src/utils/debug.ts:155-196` |
| 诊断跟踪单例 | `DiagnosticTrackingService.getInstance()` 确保全局唯一 | `src/services/diagnosticTracking.ts:44-49` |

### 5.3 错误处理

| 问题 | 如何处理 | 证据 |
|-----|---------|-----|
| Heap snapshot 崩溃 | 先写诊断 JSON，再写 snapshot；诊断至少能保留 | `src/utils/heapDumpService.ts:214-278` |
| 安全存储失败 | debug log 有 fallback，错误日志不阻塞主流程 | `src/utils/errorLogSink.ts:94-103` |
| IDE 诊断不可用 | `getNewDiagnostics()` 返回空数组，不阻塞 | `src/services/diagnosticTracking.ts:188-209` |
| 调试目录不存在 | 自动创建目录 | `src/utils/debug.ts:146-150`、`src/utils/errorLogSink.ts:94-103` |
| 诊断文件已存在 | `writeNewDiagnosticJson()` 用 `wx` 模式，不覆盖 | `src/utils/diagnosticExport.ts:3-16` |

### 5.4 工程取舍

| 取舍 | 选择 | 理由 | 代价 |
|-----|------|------|------|
| Heap dump 顺序 | 先写诊断，再写 snapshot | 诊断更可靠且体积小，snapshot 可能崩溃 | 需要两次文件写入 |
| 诊断脱敏策略 | 只保留错误分类 | 严格保护隐私，防止敏感信息泄露 | 只能看到错误类型，无法看到具体细节 |
| 调试写入模式 | immediateMode vs bufferedMode | 调试模式立即写入防丢失，正常模式缓冲减 I/O | 两种模式需要分别处理 |
| 启动 profiling | 采样决策一次 | 不影响大部分用户，ant 用户 100% 覆盖 | 采样用户有轻微开销 |
| 诊断跟踪 key | normalized path | 解决跨平台、多 URI 格式的匹配问题 | 需要在所有路径调用 normalize |
| 安装检测 | 多方验证 | 单一检测方式容易误判，多方验证更可靠 | 检测逻辑复杂，需要处理边缘情况 |
| 上下文警告 | async 并行 | 各检查独立，并行执行更快 | 需要处理 Promise.all 的错误传播 |
| Error sink 格式 | JSONL | 即使文件被截断也能解析剩余行，append 简单 | JSONL 不直观，需要工具查看 |

## 6. 现状验收标准

### 6.1 功能验收标准

- 调试日志分类过滤：`parseDebugFilter()` 正确解析包含/排除模式；`extractDebugCategories()` 正确从消息前缀提取分类；`shouldShowDebugMessage()` 正确判断是否显示
- 调试日志写入模式：`isDebugMode()` 为 true 时用同步追加；否则用 1 秒刷新缓冲
- 错误日志 sink 模式：`logError()` 在 sink 未 attach 前先排队到 `errorQueue`；attach 后立即 drain
- 诊断导出严格脱敏：`sanitizeErrorForDiagnostics()` 只返回分类，不包含错误文本；先用 `redactSensitiveInfo()` 处理
- 诊断导出用 `writeNewDiagnosticJson()` 只写新文件：用 `fs.open(path, 'wx', 0o600)` 原子性创建
- Heap dump 先写诊断，后写 snapshot：`performHeapDump()` 先调用 `captureMemoryDiagnostics()` 并写入 JSON；再调用 `writeHeapSnapshot()`
- 内存诊断包含泄漏指标：`captureMemoryDiagnostics()` 收集 detached contexts、active handles、file descriptors、smaps_rollup（Linux）
- 启动 profiling 采样决策：`STATSIG_LOGGING_SAMPLED` 在模块加载时决策一次
- Query profiling 显式开关：`CLAUDE_CODE_PROFILE_QUERY=1` 启用，默认关闭
- Startup profiler 内存快照用数组：`memorySnapshots` 按顺序记录，支持重复 checkpoint 名
- IDE 诊断跟踪用 `_claude_fs_right` URI：优先用 _claude_fs_right 的诊断检测新增问题
- 诊断跟踪用 normalized path 做 key：`normalizeFileUri()` 去除协议前缀，用平台归一化路径
- `/doctor` 检查多维度问题：`getDoctorDiagnostic()` 包含安装类型、权限、多个安装、配置问题、上下文警告
- 安装检测用多方验证：`getCurrentInstallationType()` 检查 bundled mode、环境、路径模式
- 多个安装检测主动扫描：`detectMultipleInstallations()` 检查 npm global、npm local、native、config
- 上下文警告用 async 并行检查：`checkContextWarnings()` 并行检查 CLAUDE.md、agent descriptions、MCP tools、不可达规则
- `/debug-tool-call` 只验证 schema：`inspectSavedInputSchema()` 用 Zod schema 验证，不调用 `call()` 或 `checkPermissions()`
- `/debug-tool-call` 配对 tool_use 和 tool_result：`collectToolCalls()` 按 ID 配对，支持多个 result
- Headless profiler 只在非交互模式启用：`getIsNonInteractiveSession()` 判断
- 错误分类用正则匹配：`categorizeError()` 匹配错误文本中的关键词
- 诊断日志明确禁止 PII：`logForDiagnosticsNoPII()` 明确禁止 PII，只接受 event 名和安全数据
- Error sink 用 JSONL 格式：每行一个 JSON 对象，支持逐行解析
- 诊断日志环境变量控制：`CLAUDE_CODE_DIAGNOSTICS_FILE` 指定日志路径
- 所有诊断文件权限 0o600：防止其他用户读取

### 6.2 行为验收标准

- 启动早期错误不丢失：sink attach 后立即 drain errorQueue
- Heap snapshot 崩溃时诊断已保存：先写诊断 JSON，再写 snapshot
- 诊断导出不含 PII：只包含错误分类、时间戳、性能指标、内存使用、checkpoint 名称
- 调试日志默认不记录（ant 用户例外）：`USER_TYPE !== 'ant' && !isDebugMode()` 时不写入
- IDE 诊断正确匹配 baseline：用 normalized path 做 key，支持 file:// 和 _claude_fs_right:// URI
- `/doctor` 并行检查，快速响应：`getDoctorDiagnostic()` 和 `checkContextWarnings()` 并行执行
- `/debug-tool-call` 不产生副作用：不实际执行工具，不触发权限检查
- 诊断文件不覆盖：`writeNewDiagnosticJson()` 用 `wx` 模式，已存在时失败

## 7. 代码与测试证据

### 7.1 关键代码证据

调试系统：
- `src/utils/debug.ts`：调试日志写入、模式切换
- `src/utils/debugFilter.ts`：分类过滤、模式解析

错误日志：
- `src/utils/log.ts`：错误日志入口、队列管理
- `src/utils/errorLogSink.ts`：JSONL 写入、文件管理

诊断日志：
- `src/utils/diagLogs.ts`：无 PII 诊断日志、计时包装

性能分析：
- `src/utils/startupProfiler.ts`：启动 checkpoint、采样上报
- `src/utils/queryProfiler.ts`：Query checkpoint、时间线生成
- `src/utils/headlessProfiler.ts`：非交互模式 profiling

内存诊断：
- `src/utils/heapDumpService.ts`：Heap dump、内存指标采集

诊断导出：
- `src/utils/diagnosticExport.ts`：原子性 JSON 写入
- `src/commands/perf-issue/perf-issue.tsx`：诊断报告生成、脱敏

IDE 诊断跟踪：
- `src/services/diagnosticTracking.ts`：DiagnosticTrackingService 单例、基线对比

医生检查：
- `src/utils/doctorDiagnostic.ts`：安装检测、配置检查
- `src/utils/doctorContextWarnings.ts`：上下文警告检查

工具调用调试：
- `src/commands/debug-tool-call/debug-tool-call.tsx`：历史调用检查、schema 验证

### 7.2 测试覆盖现状

现有测试：
- `tests/debugToolCallCommand.test.ts`：`collectToolCalls()` 配对测试；`inspectSavedInputSchema()` schema 验证测试

未覆盖场景：
- 调试日志分类过滤的完整路径测试
- 错误日志 sink queue+drain 的完整流程测试
- 诊断导出脱敏的边界条件测试
- 内存诊断指标采集的跨平台测试
- Startup/query/headless profiler 的完整流程测试
- IDE 诊断跟踪 baseline 对比的完整测试
- `/doctor` 多维度检查的完整测试
- `/perf-issue` 导出流程的完整测试
- `/heapdump` 流程的完整测试
- Event loop stall detector 的实现和测试（当前只是占位）
- 自动 heap dump 触发（`auto-1.5GB` trigger 已定义，但未自动触发）
- 交互模式 query profiler 动态开关（当前需要环境变量启用）
- Heap snapshot 自动分析（当前需要外部工具）
- 调试日志分类覆盖率检查（不是所有调试日志都有正确分类）

## 8. 文件覆盖与相关子系统

### 8.1 源文件覆盖

| 文件 | 主要职责 | 公开接口 |
|------|---------|---------|
| `src/utils/debug.ts` | 调试日志系统 | `isDebugMode()`、`logForDebugging()`、`enableDebugLogging()` |
| `src/utils/debugFilter.ts` | 调试日志分类过滤 | `parseDebugFilter()`、`shouldShowDebugMessage()` |
| `src/utils/log.ts` | 错误日志入口 | `logError()`、`attachErrorLogSink()` |
| `src/utils/errorLogSink.ts` | 错误日志 sink 实现 | `ErrorLogSink` 接口实现 |
| `src/utils/diagLogs.ts` | 诊断日志 | `logForDiagnosticsNoPII()`、`withDiagnosticsTiming()` |
| `src/utils/diagnosticExport.ts` | 诊断导出工具 | `writeNewDiagnosticJson()` |
| `src/utils/startupProfiler.ts` | 启动性能分析 | `profileCheckpoint()`、`profileReport()` |
| `src/utils/queryProfiler.ts` | Query 性能分析 | `startQueryProfile()`、`queryCheckpoint()` |
| `src/utils/headlessProfiler.ts` | 非交互模式 profiling | `headlessProfilerStartTurn()` |
| `src/utils/heapDumpService.ts` | 内存诊断 | `performHeapDump()`、`captureMemoryDiagnostics()` |
| `src/utils/doctorDiagnostic.ts` | 医生检查诊断 | `getDoctorDiagnostic()` |
| `src/utils/doctorContextWarnings.ts` | 上下文警告检查 | `checkContextWarnings()` |
| `src/utils/eventLoopStallDetector.ts` | Event loop stall 检测（占位） | `startEventLoopStallDetector()` |
| `src/services/diagnosticTracking.ts` | IDE 诊断跟踪 | `DiagnosticTrackingService` |
| `src/commands/doctor/doctor.tsx` | `/doctor` 命令 | 命令 UI |
| `src/commands/perf-issue/perf-issue.tsx` | `/perf-issue` 命令 | `buildPerfIssueReport()`、`sanitizeErrorForDiagnostics()` |
| `src/commands/heapdump/heapdump.ts` | `/heapdump` 命令 | 命令入口 |
| `src/commands/debug-tool-call/debug-tool-call.tsx` | `/debug-tool-call` 命令 | `collectToolCalls()`、`inspectSavedInputSchema()` |

### 8.2 相关子系统

- MCP 集成：`src/services/mcp/` 用于 IDE 诊断跟踪
- 会话存储：用于错误日志、调试日志、性能日志持久化
- 权限系统：`/doctor` 检查权限配置问题
- 工具系统：`/debug-tool-call` 检查历史工具调用
- Agent 系统：`checkContextWarnings()` 检查 agent descriptions
- Statsig：启动 profiling 采样上报
- IDE 扩展：通过 MCP 提供诊断数据

[Coverage](../../architecture/coverage/diagnostics.yaml)

## 9. 改进建议

### 9.1 短期改进

- 实现 Event loop stall detector：当前只是占位，需要实际实现
- 增加调试日志分类覆盖率：确保所有调试日志都有正确的分类前缀
- 为诊断系统增加完整的测试覆盖：特别是 profiler、诊断跟踪、医生检查等模块
- 实现自动 heap dump 触发：`auto-1.5GB` trigger 已定义，但未自动触发
- 增加 heap snapshot 基础分析：可以在诊断 JSON 中包含一些基础分析，而不只是原始 snapshot
- 增加交互模式 query profiler 动态开关：支持 `/profile` 命令动态启用，而不需要环境变量

### 9.2 中期改进

- 诊断上传机制：在用户明确同意的前提下，提供一键上传诊断到支持渠道的功能
- 火焰图生成：利用 checkpoint 数据自动生成火焰图，便于性能分析
- 历史诊断对比：支持对比不同时间点的诊断数据，识别性能退化
- 智能修复建议：在 `/doctor` 中增加一些可以自动修复的问题（如 PATH 配置）
- 实时性能仪表板：在交互模式下提供实时的性能指标显示
- 内存泄漏自动检测：利用 detached contexts、active handles 等指标自动检测和警告内存泄漏
- 调试日志搜索工具：提供命令行工具搜索和分析调试日志

### 9.3 长期考虑

- 分布式追踪：支持跨多组件、多服务的分布式追踪
- APM 集成：集成到主流 APM 系统（如 Datadog、New Relic）
- 机器学习异常检测：利用 ML 自动检测性能异常和错误模式
- 诊断即代码：允许用户编写自定义诊断检查
- 跨会话诊断关联：将相关会话的诊断数据关联起来，提供更完整的视图
- 性能预算：允许用户定义性能预算，超出时自动警告
- 诊断数据可视化：提供图形化界面查看诊断数据和性能指标
