---
id: telemetry
batch: 7
title: Telemetry 事件契约、导出与隐私边界设计
date: 2026-11-12
status: draft
---

# Telemetry 事件契约、导出与隐私边界设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要收集遥测数据来改进产品，同时需要严格保护用户隐私。主要约束包括：

- **多后端路由**：不同类型的用户（内部用户、API 客户、C4E 企业用户）需要不同的数据导出目标
- **事件路由**：事件需要在多个后端（Datadog、第一方事件日志、OTLP、BigQuery）之间路由
- **隐私保护**：敏感数据需要在类型系统级别防止意外发送
- **可靠重试**：失败的导出需要可靠地重试，同时避免无限重试
- **快速启动**：启动时需要尽快完成初始化，不阻塞用户交互
- **类型安全**：生成代码（`src/types/generated/`）作为类型边界，定义事件协议

### 调用方与责任边界

- **上游**：各种功能模块（工具调用、GrowthBook、模型使用等）
- **本层**：`logEvent()`/`logEventAsync()`、`attachAnalyticsSink()`、`initializeTelemetry()`、`flushTelemetry()`
- **下游**：Datadog、第一方事件日志 API、OTLP、BigQuery

### 实际约束

- **隐私边界**：敏感数据需要类型标记，不能直接发送；`_PROTO_` 前缀的字段路由到特权列
- **性能约束**：启动时不阻塞，事件队列化，懒加载 OTLP 导出器
- **可靠性约束**：失败事件持久化到磁盘，二次退避重试，最多 8 次
- **环境差异**：`NODE_ENV=production` 才发送 Datadog，内部用户 vs 外部用户路由不同

### Feature Gates 与 Disabled 机制

- 环境变量：`CLAUDE_CODE_ENABLE_TELEMETRY`（启用 OTLP）、`OTEL_LOG_TOOL_DETAILS`（记录详细工具名称）、`OTEL_EXPORTER_OTLP_*`（OTLP 配置）
- 用户配置：无（遥测配置主要通过环境变量）
- 内部检查：`hasTrust()`（检查是否是内部用户）、`getUserType()`（用户类型）

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 使用 OpenTelemetry 作为标准库，而非自定义遥测系统 | 系统基于 OpenTelemetry SDK 构建，使用其 `LoggerProvider`、`MeterProvider`、`TracerProvider` 接口，通过环境变量（`OTEL_*`）配置；内部事件先写入 OpenTelemetry 日志系统，然后由自定义导出器（`FirstPartyEventLoggingExporter`）导出到第一方 API | OpenTelemetry 是行业标准，提供统一的 API 和多种现成的导出器（OTLP、Prometheus、Console）；避免重复造轮子，减少维护成本；允许用户配置自己的 OTLP 端点进行第三方遥测；与内部现有工具链兼容 | 完全自定义遥测系统：灵活性高但维护成本大，无法利用标准工具；仅使用 StatsD/Datadog SDK：功能受限，无法支持多后端路由 | OpenTelemetry SDK 有一定的大小和复杂度；需要学习 OpenTelemetry 的概念和 API | `src/utils/telemetry/instrumentation.ts:1-999` |
| 类型标记防止敏感数据泄露 | 使用两个 never 类型作为标记：`AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`（标记已验证不含代码或文件路径的字符串）；`AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`（标记将路由到 PII 列的字段）；事件元数据类型强制要求字符串必须通过这些标记转换，否则类型错误 | 在编译时防止意外发送敏感数据（如文件路径、代码片段）；明确的审查点：开发者必须显式使用 `as` 转换，表示已手动验证；区分普通字段和 PII 字段，后者只发送到特定列 | 运行时过滤：性能开销，且可能漏过滤；代码审查依赖：容易出错，无法自动化 | 需要开发者理解并正确使用这些标记；有时需要额外的转换步骤 | `src/services/analytics/index.ts:19-33` |
| 事件队列化等待 sink 初始化 | 在 `attachAnalyticsSink()` 之前，事件被存储在内存队列（`eventQueue`）中；sink 附加后，通过 `queueMicrotask()` 异步批量发送队列中的事件，避免阻塞启动；`attachAnalyticsSink()` 是幂等的，多次调用无副作用 | 避免早期事件（如启动事件）丢失；保持模块无依赖：`index.ts` 不依赖其他模块，避免循环依赖；异步发送不阻塞用户交互 | 要求调用方先初始化 sink：容易出错，早期事件会丢失；同步发送：阻塞启动 | 内存占用：队列会暂时占用内存；复杂度增加：需要管理队列和 sink 状态 | `src/services/analytics/index.ts:68-123` |
| 失败事件持久化到磁盘 + 二次退避重试 | 失败的事件被追加写入到 `~/.claude/telemetry/1p_failed_events.<sessionId>.<batchUuid>.json` 文件（JSONL 格式）；下次启动时，自动重试先前批次的事件；重试使用二次退避策略：`base * attempts^2`，最大延迟 30 秒，最多 8 次；成功后立即重试队列中剩余事件 | 持久化确保进程崩溃或重启后事件不丢失；二次退避避免在服务端负载过大时进一步加重；立即重试健康端点尽快清空队列 | 仅内存重试：进程退出后事件丢失；固定间隔重试：在服务端恢复时不够快，在过载时不够慢；无限重试：可能永远保留过期数据 | 磁盘 I/O 开销；需要管理文件生命周期；用户可能看到多个会话的重试延迟 | `src/services/analytics/firstPartyEventLoggingExporter.ts:38-517` |
| 分离第一方日志、Datadog、OTLP 三个 sink，路由不同事件 | Datadog：仅发送特定事件（`DATADOG_ALLOWED_EVENTS`），仅在 `NODE_ENV=production` 且使用第一方 API 时启用，批量发送，默认 15 秒刷新间隔；第一方事件日志：使用 OpenTelemetry 日志系统，发送到 `/api/event_logging/batch`，支持认证降级（401 时重试无认证）；OTLP：用户可选，通过 `CLAUDE_CODE_ENABLE_TELEMETRY=1` 启用，支持 metrics/logs/traces，可配置自己的端点；BigQuery：仅 API 客户、C4E 企业用户、团队用户启用，5 分钟间隔发送指标 | 不同后端有不同的用途、成本和隐私要求；允许为不同用户组启用不同功能；失败隔离：一个 sink 失败不影响其他 sink | 单一 sink 发送所有事件：隐私和成本控制困难；完全独立的系统：代码重复，难以维护 | 复杂度增加：需要管理多个 sink 和路由；测试更复杂：需要测试多个组合 | `src/services/analytics/datadog.ts:1-999` + `src/services/analytics/firstPartyEventLoggingExporter.ts:38-517` + `src/utils/telemetry/instrumentation.ts:328-347` |
| `_PROTO_` 前缀标记 PII 字段，路由到特权列 | 元数据中以 `_PROTO_` 开头的字段（如 `_PROTO_skill_name`）在第一方导出器中被特殊处理：从 `additional_metadata` 中提取；提升到 proto 的特定字段（如 `skill_name`）；防御性地从 `additional_metadata` 中删除所有 `_PROTO_*` 字段；Datadog sink 在发送前也会调用 `stripProtoFields()` 过滤 | 确保 PII 只进入有访问控制的 BigQuery 列；单一控制点过滤：`stripProtoFields()` 保护所有非第一方 sink；防御性设计：防止未来添加的 `_PROTO_*` 字段意外泄露 | 直接在 proto 字段中传递：需要修改事件格式，破坏兼容性；完全不发送 PII：减少产品改进可用的数据 | 需要维护已知 `_PROTO_*` 字段的列表；字段名称有特殊含义，增加了理解成本 | `src/services/analytics/index.ts:45-58` + `src/services/analytics/firstPartyEventLoggingExporter.ts:719-725` |
| 工具名称消毒，仅在特定情况记录详细名称 | 默认：MCP 工具名称被消毒为 `mcp_tool`；仅在以下情况记录详细名称：入口点是 `local-agent`（Cowork）；MCP 服务器类型是 `claudeai-proxy`；MCP 服务器 URL 在官方注册表中；是内置 MCP 服务器（如 `computer-use`，feature-gated）；OTLP 工具详情通过 `OTEL_LOG_TOOL_DETAILS=1` 单独开关 | 保护用户隐私：自定义 MCP 服务器/工具名称可能泄露敏感信息；平衡产品需求：官方 MCP 可以安全记录用于分析；按 go/taxonomy 要求处理中等 PII | 总是记录：隐私风险高；从不记录：产品改进缺少数据 | 逻辑较复杂：需要多个检查；可能出现误报/漏报 | `src/services/analytics/metadata.ts:69-128` |
| 动态导入 OTLP 导出器，减少启动大小 | OTLP/Prometheus 导出器在协议 switch 内部动态 `import()`，而非静态导入；每个进程最多使用每个信号的一个协议变体，静态导入会加载所有 6 个（约 1.2MB） | 减少启动包大小：大部分用户不需要所有导出器；按需加载：只加载配置的导出器 | 代码稍复杂：需要异步加载；第一次加载有轻微延迟 | 代码稍复杂：需要异步加载；第一次加载有轻微延迟 | `src/utils/telemetry/instrumentation.ts:3-11` |
| 生成类型作为协议边界，手动代码不可修改 | `src/types/generated/` 包含从 proto 生成的类型（如 `ClaudeCodeInternalEvent`、`GrowthbookExperimentEvent`）；这些类型定义事件协议，用于：`to1PEventFormat()` 将内部元数据转换为生成格式；`FirstPartyEventLoggingExporter` 使用生成的 `toJSON()` 方法序列化；生成文件在 manifest 中被排除，coverage 也不包含它们 | 单一事实来源：proto 定义协议；类型安全：编译器验证字段匹配；防止漂移：生成代码确保与 proto 一致 | 手动编写类型：容易与 proto 不同步；无类型：运行时错误风险高 | 需要生成步骤：`bun run generate:proto`；修改协议需要同时更新 proto 和重新生成 | `src/types/generated/events_mono/` + `src/services/analytics/metadata.ts:818-828` |

## 3. 目标与非目标

### 目标

- **可靠的事件传递**：事件不丢失（队列化、持久化、重试）；失败隔离（一个 sink 失败不影响其他）；有序传递（尽量保持事件顺序）
- **隐私保护**：编译时防止敏感数据泄露；PII 只发送到特权列；用户可选择禁用第三方遥测
- **多后端支持**：第一方事件日志 API；Datadog（特定事件）；OTLP（用户配置）；BigQuery（客户指标）

### 非目标

- 不保证实时传递（允许批量和延迟）
- 不保证 exactly-once 传递（可能重复）
- 不适用于用户代码执行的数据（这由其他系统处理）
- 不支持任意自定义后端（用户可通过 OTLP 配置）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// analytics/index.ts
function logEvent(eventName: string, metadata: LogEventMetadata): void
function logEventAsync(eventName: string, metadata: LogEventMetadata): Promise<void>
function attachAnalyticsSink(sink: AnalyticsSink): void

interface LogEventMetadata {
  [key: string]: boolean | number | undefined | string & { __brand: never }
}

interface AnalyticsSink {
  logEvent(eventName: string, metadata: LogEventMetadata): void
  logEventAsync(eventName: string, metadata: LogEventMetadata): Promise<void>
}

// telemetry/instrumentation.ts
function initializeTelemetry(): Promise<void>
function flushTelemetry(): Promise<void>
```

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `analytics/index.ts` | `eventQueue`、`sink` | `logEvent()`、`logEventAsync()`、`attachAnalyticsSink()` | 实际导出逻辑 | 接受 `AnalyticsSink` 实现 |
| `analytics/metadata.ts` | 无（纯函数 + memoized） | `getEventMetadata()`、`to1PEventFormat()`、`sanitizeToolNameForAnalytics()` | 事件发送 | 返回结构化元数据对象 |
| `analytics/datadog.ts` | `logBatch`、`flushTimer`、`datadogInitialized` | `trackDatadogEvent()`、`initializeDatadog()`、`shutdownDatadog()` | 第一方事件导出 | 使用 `getEventMetadata()` |
| `analytics/firstPartyEventLoggingExporter.ts` | `pendingExports`、`isShutdown`、`attempts`、`isRetrying` | `export()`、`shutdown()`、`forceFlush()` | 元数据格式化 | 从 OpenTelemetry `ReadableLogRecord` 读取 |
| `analytics/sink.ts` | 无 | 路由事件到 Datadog 和第一方导出器 | 队列管理 | 实现 `AnalyticsSink` 接口 |
| `telemetry/instrumentation.ts` | `LoggerProvider`、`MeterProvider`、`TracerProvider`（存储在 state 中） | `initializeTelemetry()`、`flushTelemetry()`、`bootstrapTelemetry()` | 具体事件内容 | 设置全局 OpenTelemetry 提供者 |
| `types/generated/events_mono/` | 无（类型定义） | 提供事件协议类型 | 运行时逻辑 | 被 `to1PEventFormat()` 和导出器使用 |

状态设计理由：
- 队列和 sink 分离：允许早期事件排队等待 sink
- 导出器内部管理重试状态：封装复杂性
- OpenTelemetry 提供者存储在 state 中：便于关闭时刷新

复制与共享：
- 事件对象在 sink 之间只读共享
- 元数据通过值传递，不共享可变引用

重置与清理：
- `shutdownDatadog()`：刷新剩余日志并关闭
- `FirstPartyEventLoggingExporter.shutdown()`：停止重试，刷新待处理数据
- `flushTelemetry()`：在退出/切换用户前调用，防止数据泄露
- `_resetForTesting()`：仅用于测试，重置队列和 sink

### 4.3 主控制流

事件记录典型流程：

```text
logEvent(eventName, metadata)
  ├─ sink 已附加？
  │   ├─ 是 → sink.logEvent() → 路由到 Datadog/第一方导出器
  │   └─ 否 → push 到 eventQueue
  └─ 结束
```

Sink 附加与队列处理：

```text
attachAnalyticsSink(newSink)
  ├─ sink 已存在？→ 是 → 幂等返回
  └─ 否 → 设置 sink
      ├─ eventQueue 非空？
      │   └─ 是 → queueMicrotask() 中批量重放队列事件
      │       └─ 每个事件调用 sink.logEvent() / logEventAsync()
      └─ 结束
```

第一方事件导出流程：

```text
FirstPartyEventLoggingExporter.export(logs, resultCallback)
  ├─ 筛选事件日志（instrumentationScope.name = "com.anthropic.claude_code.events"）
  ├─ transformLogsToEvents()：转换为 FirstPartyEventLoggingEvent
  │   ├─ 检查是否是 GrowthBook 实验事件 → 特殊处理
  │   └─ 否则 → 提取 core_metadata、user_metadata、event_metadata
  │       └─ to1PEventFormat()：转换为 1P 格式
  │           ├─ 提取 _PROTO_* 字段到 proto 特定字段
  │           └─ stripProtoFields() 从 additional_metadata 删除剩余 _PROTO_*
  ├─ sendEventsInBatches()：分块发送
  │   ├─ 每块 → sendBatchWithRetry()
  │   │   ├─ isKilled()？→ 是 → 抛出错误
  │   │   ├─ hasTrust()？→ 否 → 跳过认证
  │   │   ├─ 尝试带认证发送 → 401？→ 重试无认证
  │   │   └─ 成功？→ 继续下一块
  │   └─ 任意失败 → 短路剩余块，全部标记为失败
  ├─ 失败？
  │   ├─ 是 → appendEventsToFile()：持久化到磁盘
  │   │       └─ scheduleBackoffRetry()：安排重试
  │   └─ 否 → resetBackoff()
  │       └─ 队列有事件？→ 是 → 立即 retryFailedEvents()
  └─ 调用 resultCallback()
```

重试失败事件（启动或退避触发）：

```text
retryFailedEvents()
  ├─ 加载当前批次文件
  ├─ attempts >= maxAttempts？→ 是 → 删除文件，返回
  └─ sendEventsInBatches()
      ├─ 成功 → 删除文件，resetBackoff()，继续循环检查新事件
      └─ 失败 → 保存剩余失败事件，scheduleBackoffRetry()
```

### 4.4 数据结构与持久化

事件队列（内存）：

```typescript
interface QueuedEvent {
  eventName: string
  metadata: LogEventMetadata
  async: boolean // 是否使用 logEventAsync
}

const eventQueue: QueuedEvent[] = []
```

失败事件文件（磁盘）：

- 位置：`~/.claude/telemetry/1p_failed_events.<sessionId>.<batchUuid>.json`
- 格式：JSONL（每行一个 JSON 对象）

```json
{"event_type":"ClaudeCodeInternalEvent","event_data":{...}}
{"event_type":"GrowthbookExperimentEvent","event_data":{...}}
```

第一方事件格式（proto 生成）：

```typescript
// 从 ClaudeCodeInternalEvent 生成
interface FirstPartyEventLoggingMetadata {
  env: EnvironmentMetadata // 环境信息（平台、版本等）
  process?: string // base64 编码的进程指标 JSON
  auth?: PublicApiAuth // 认证信息（account_uuid、organization_uuid）
  core: FirstPartyEventLoggingCoreMetadata // 核心元数据（session_id、model、user_type 等）
  additional: Record<string, unknown> // 额外元数据
}
```

Datadog 批处理（内存）：

```typescript
let logBatch: DatadogLog[] = [] // 待发送日志
let flushTimer: NodeJS.Timeout | null = null // 刷新定时器
const MAX_BATCH_SIZE = 100 // 最大批大小
const DEFAULT_FLUSH_INTERVAL_MS = 15000 // 默认刷新间隔
```

### 4.5 跨子系统依赖

| 依赖方向 | 模块 | 职责描述 | 主设计 spec |
|---|---|---|---|
| 上游 | GrowthBook | 实验事件记录 | （独立）|
| 上游 | 工具调用 | 记录工具使用事件 | tool-framework |
| 下游 | auth.ts | 获取认证信息和令牌 | auth |
| 下游 | config.ts | 获取用户 ID、信任状态 | settings |
| 下游 | bootstrap/state.ts | 存储 OpenTelemetry 提供者 | （核心）|

## 5. 失败语义与工程取舍

### 失败语义

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| sink 未附加时记录事件 | `logEvent()` / `logEventAsync()` | 无异常，加入队列 | 等待 sink 附加后自动重放 | 队列在内存中 | 调用方无感知 |
| Datadog 发送失败 | `flushLogs()` | 捕获 axios 错误，内部日志，不抛 | 不重试（已在批次中，下次刷新重试） | 批次被清空（因为已尝试发送） | 调用方无感知 |
| 第一方事件发送失败 | `sendBatchWithRetry()` | 捕获错误，存储到磁盘，安排重试 | 二次退避，最多 8 次 | 失败事件追加到文件 | `export()` 回调返回失败 |
| 最大重试次数达到 | `retryFailedEvents()` / `doExport()` | 内部日志，删除文件 | 不再重试 | 文件被删除 | 调用方无感知（事件被丢弃） |
| 认证失败（401） | `sendBatchWithRetry()` | 内部日志，自动重试无认证 | 一次无认证重试 | 无（认证降级） | 调用方无感知 |
| killswitch 激活 | `sendBatchWithRetry()` 开始 | 抛出错误，所有剩余块失败 | 退避定时器继续，检查 killswitch | 失败事件存储到磁盘 | 调用方无感知 |
| OpenTelemetry 关闭超时 | `shutdownTelemetry()` | 捕获超时错误，日志提示 | 不重试（进程正在退出） | 尽力刷新，超时放弃 | 用户看到提示消息（ant 仅） |

### 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 持久性 vs 性能 | 持久化防止丢失，但有磁盘 I/O 开销 | 磁盘 I/O 开销，需要管理文件生命周期 | 进程崩溃或重启后事件不丢失 |
| 重试 vs 丢弃 | 二次退避，最多 8 次，然后丢弃 | 用户可能看到多个会话的重试延迟 | 避免无限重试，平衡可靠性和资源 |
| 类型安全 vs 便利 | 类型标记防止敏感数据，但使用稍繁琐 | 需要开发者理解并正确使用标记，有时需要额外转换 | 编译时防止敏感数据泄露 |
| 多后端 vs 简单 | 分离三个 sink，路由不同事件 | 复杂度增加，需要管理多个 sink 和路由，测试更复杂 | 不同后端有不同的用途、成本和隐私要求，失败隔离 |
| OTLP 动态导入 vs 静态导入 | 动态导入，按需加载 | 代码稍复杂，需要异步加载，第一次加载有轻微延迟 | 减少启动包大小（大部分用户不需要所有导出器） |
| 生成类型 vs 手动类型 | 从 proto 生成类型，手动代码不可修改 | 需要生成步骤，修改协议需要同时更新 proto 和重新生成 | 单一事实来源，类型安全，防止漂移 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| sink 未附加 | 调用 logEvent() | 事件队列化 | 不能丢失事件 |
| sink 附加后 | 有队列化事件 | 自动重放 | 不能丢失队列事件 |
| 第一方事件发送失败 | 重试 | 持久化到磁盘，使用二次退避，最多 8 次 | 不能无限重试 |
| 事件元数据包含 `_PROTO_*` 字段 | 发送到 Datadog | 被 strip 掉 | 不能泄露 PII 到 Datadog |
| 事件元数据包含 `_PROTO_*` 字段 | 发送到第一方事件日志 | 被提升到 proto 特定字段，然后从 additional_metadata 删除 | 不能在 additional_metadata 中保留 `_PROTO_*` 字段 |
| MCP 工具名称不在允许列表 | 记录事件 | 被消毒为 `mcp_tool` | 不能泄露自定义 MCP 工具名称 |
| 记录事件后 | 调用 flushTelemetry() | 立即刷新所有待处理数据 | 不能丢失待处理数据 |
| 尝试在事件元数据中直接放入未标记字符串 | 编译 | 类型错误 | 不能编译通过 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 事件队列化等待 sink | `src/services/analytics/index.ts:68-123` | 需补充测试 | 未找到直接测试覆盖 |
| 类型标记防止敏感数据 | `src/services/analytics/index.ts:19-33` | 需补充测试 | 未找到直接测试覆盖 |
| `_PROTO_` 字段过滤 | `src/services/analytics/index.ts:45-58` + `firstPartyEventLoggingExporter.ts:719-725` | 需补充测试 | 未找到直接测试覆盖 |
| 失败事件持久化 + 二次退避 | `src/services/analytics/firstPartyEventLoggingExporter.ts:38-517` | 需补充测试 | 未找到直接测试覆盖 |
| Datadog 允许列表 + 批处理 | `src/services/analytics/datadog.ts:19-317` | 需补充测试 | 未找到直接测试覆盖 |
| OTLP 动态导入 | `src/utils/telemetry/instrumentation.ts:3-11` | 需补充测试 | 未找到直接测试覆盖 |
| 工具名称消毒策略 | `src/services/analytics/metadata.ts:69-128` | 需补充测试 | 未找到直接测试覆盖 |
| 生成类型边界 | `src/types/generated/events_mono/` | 需补充测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/services/analytics/index.ts` | `logEvent`、`logEventAsync`、`attachAnalyticsSink` | 事件队列、sink 接口、类型标记 |
| `src/services/analytics/metadata.ts` | `getEventMetadata`、`to1PEventFormat`、`sanitizeToolNameForAnalytics` | 元数据丰富、工具消毒、PII 字段处理 |
| `src/services/analytics/datadog.ts` | `trackDatadogEvent`、`initializeDatadog`、`shutdownDatadog` | Datadog 导出、批处理、用户桶 |
| `src/services/analytics/firstPartyEventLoggingExporter.ts` | `FirstPartyEventLoggingExporter`、`export`、`shutdown`、`forceFlush` | 第一方事件导出、持久化、重试 |
| `src/services/analytics/sink.ts` | sink 实现 | 事件路由 |
| `src/utils/telemetry/instrumentation.ts` | `initializeTelemetry`、`flushTelemetry`、`bootstrapTelemetry` | OpenTelemetry 初始化、配置 |
| `src/utils/telemetry/betaSessionTracing.ts` | Beta 会话追踪 | Beta 追踪（独立路径）|
| `src/utils/telemetry/perfettoTracing.ts` | Perfetto 本地追踪 | Perfetto 本地追踪 |
| `src/utils/telemetry/attributes.ts` | Telemetry 属性 | 遥测属性 |
| `src/types/generated/events_mono/` | 生成类型 | 事件协议类型 |

### 7.2 未覆盖行为（基于代码阅读）

- telemetry 专门测试文件缺失
- 真实网络条件下的重试测试
- 隐私边界测试（`_PROTO_` 字段过滤、工具名称消毒）
- 启动性能测试（队列化不阻塞）
- 跨子系统集成测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/telemetry.yaml)

### 8.1 本 spec 主拥有的文件组

| 分组 | 主拥有职责 |
|---|---|
| telemetry-core | Telemetry 核心工具 |

### 8.2 共享证据但由其他 spec 主拥有的文件

- （无直接 spec 依赖，多个 spec 使用遥测记录事件）

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 测试缺口大（第 7 节无测试） | 补充核心路径单元测试：队列、重试、PII 过滤、消毒 | 低（新增测试） | 每个核心模块有对应测试文件，覆盖主要路径和边界情况 | M | 设计推断 |
| P2 | 失败事件可能永远保留（用户不再使用同一 sessionId） | 添加文件过期机制：删除超过 N 天的失败事件文件 | 低（只删除旧文件） | 旧文件被自动清理 | S | 设计推断 |
| P2 | BigQuery 指标仅 5 分钟间隔，无法调整 | 考虑添加配置或自适应间隔 | 中（改变现有行为） | 可配置间隔生效 | S | 设计推断 |
| P2 | 遥测初始化仍在启动路径 | 考虑进一步延迟或后台化初始化 | 中（时序变化） | 启动更快，事件不丢失 | M | 设计推断 |
| P3 | 类型标记使用 `as` 转换，容易出错 | 考虑提供 helper 函数 `verifiedString()`，封装验证逻辑 | 低（只新增 helper，不改变现有代码） | 开发者使用 helper 而非直接 `as` | S | 设计推断 |
| P3 | killswitch 激活后仍继续重试（只是每次失败） | 考虑 killswitch 激活后暂停重试，直到下次启动或 killswitch 解除 | 中（改变重试逻辑） | killswitch 激活后不浪费资源重试 | M | 设计推断 |
