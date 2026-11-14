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

---

### 模块设计卡 1：事件契约与入口模块 (`src/services/analytics/index.ts`)

#### 真实入口签名与关键类型

```typescript
// 编译期类型标记：防止未验证字符串泄露
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

// 内部事件队列类型
type QueuedEvent = {
  eventName: string
  metadata: LogEventMetadata
  async: boolean
}

// 真实 LogEventMetadata 不允许直接传入未标记字符串
type LogEventMetadata = { [key: string]: boolean | number | undefined }

export interface AnalyticsSink {
  logEvent(eventName: string, metadata: LogEventMetadata): void
  logEventAsync(eventName: string, metadata: LogEventMetadata): Promise<void>
}
```

#### 输入输出

| 入口 | 输入 | 输出 | 副作用 |
|---|---|---|---|
| `logEvent(name, meta)` | 事件名、元数据（无未标记字符串） | void | sink 已附加则转发，否则入队 |
| `logEventAsync(name, meta)` | 事件名、元数据 | Promise&lt;void&gt; | 同上，异步版本 |
| `attachAnalyticsSink(sink)` | AnalyticsSink 实现 | void | 替换全局 sink，异步重放队列 |
| `stripProtoFields(meta)` | 带 `_PROTO_` 的元数据 | 过滤后的元数据 | 无（返回新对象，原对象不变） |

#### 事件与队列状态

| 状态项 | 类型 | 初始化 | 变更时机 | 访问方式 |
|---|---|---|---|---|
| `eventQueue` | `QueuedEvent[]` | `[]` | sink 未附加时调用 `logEvent()`/`logEventAsync()`；重放后清空 | 内部私有 |
| `sink` | `AnalyticsSink \| null` | `null` | `attachAnalyticsSink()` 调用时设置 | 内部私有 |

队列行为：
- sink 为 null 时，所有事件入队，标记同步/异步
- `attachAnalyticsSink()` 后，通过 `queueMicrotask()` 异步重放
- ant 用户在重放前触发 `analytics_sink_attached` 事件记录队列长度

#### 构造/过滤/导出/关闭流程

**构造流程**：
- 模块无显式初始化函数，状态在闭包中创建
- 无循环依赖：仅依赖自身状态

**过滤流程**：
- `stripProtoFields()`：遍历键，以 `_PROTO_` 开头的删除
- 无 `_PROTO_` 键时返回原引用，否则返回新对象

**导出流程**：
- 不做实际导出，仅转发给 sink
- sink 路由到具体后端

**关闭流程**：
- 无关闭函数，`_resetForTesting()` 仅用于测试重置

#### 错误与隐私

| 维度 | 设计 |
|---|---|
| 错误处理 | 无异常抛出，队列静默处理；sink 错误由 sink 自身处理 |
| 隐私边界 | 类型系统防止未验证字符串；`stripProtoFields()` 作为单一控制点 |
| 数据泄露防护 | 队列在内存中，进程退出后丢失（无持久化） |

#### 设计取舍与备选

| 决策 | 取舍 | 备选方案 | 不选理由 |
|---|---|---|---|
| 队列与 sink 分离 | 模块无依赖，避免循环依赖；但早期事件可能延迟发送 | 要求先初始化 sink | 早期事件会丢失；增加耦合 |
| 类型标记用 `never` | 编译期检查，无运行时开销；但需要开发者显式转换 | 运行时检查 | 性能开销；容易漏过 |
| `queueMicrotask()` 异步重放 | 不阻塞启动；但事件发送延后 | 同步重放 | 阻塞启动路径 |
| `attachAnalyticsSink()` 幂等 | 允许多处调用；但无错误提示重复调用 | 重复调用抛错 | 增加调用方复杂度 |

#### 源码测试证据

- 源码位置：`src/services/analytics/index.ts`
- 覆盖证据：[Coverage](../../architecture/coverage/telemetry.yaml)
- 现有测试：无专门单元测试；`tests/antTraceCommand.test.ts` 间接验证某些路径
- 缺口：队列重放、幂等行为无测试

---

### 模块设计卡 2：采样与 GrowthBook 模块 (`src/services/analytics/sink.ts`, `src/services/analytics/firstPartyEventLogger.ts`)

#### 真实入口签名与关键类型

```typescript
// sink.ts
const DATADOG_GATE_NAME = 'tengu_log_datadog_events'
let isDatadogGateEnabled: boolean | undefined = undefined

// firstPartyEventLogger.ts
// （实际代码中引用，详细实现在独立文件中）
```

#### 输入输出

| 入口 | 输入 | 输出 | 副作用 |
|---|---|---|---|
| `initializeAnalyticsGates()` | 无 | void | 更新 `isDatadogGateEnabled` 缓存 |
| `initializeAnalyticsSink()` | 无 | void | 调用 `attachAnalyticsSink()` 附加路由 sink |
| `shouldSampleEvent(name)` | 事件名 | `number \| null`（采样率） | 可能更新采样配置缓存 |
| `logEventImpl(name, meta)` | 事件名、元数据 | void | 采样通过则转发到 Datadog 和 1P |

#### 事件与队列状态

| 状态项 | 类型 | 初始化 | 变更时机 | 访问方式 |
|---|---|---|---|---|
| `isDatadogGateEnabled` | `boolean \| undefined` | `undefined` | `initializeAnalyticsGates()` 调用时设置 | 内部私有 |

Feature Gates 状态：
- 启动时用缓存值（`checkStatsigFeatureGate_CACHED_MAY_BE_STALE`）
- `initializeAnalyticsGates()` 从服务器更新
- killswitch 可独立禁用：`isSinkKilled('datadog')`

#### 构造/过滤/导出/关闭流程

**构造流程**：
- `initializeAnalyticsGates()`：从 GrowthBook 读取门控状态
- `initializeAnalyticsSink()`：附加路由 sink

**过滤流程**：
1. 采样：`shouldSampleEvent()` → 0 则丢弃；否则加 `sample_rate` 元数据
2. Datadog 门控：`shouldTrackDatadog()` → false 则跳过 Datadog
3. Proto 字段：`stripProtoFields()` 后才发往 Datadog
4. 1P 接收完整 payload（含 `_PROTO_*`）

**导出流程**：
- sink 路由模式：`logEventImpl()` → 并发调用 `trackDatadogEvent()` 和 `logEventTo1P()`
- `logEventAsyncImpl()` 仅是同步版本包装（当前无实际异步 sink）

**关闭流程**：
- 无独立关闭，依赖各 sink 自身关闭

#### 错误与隐私

| 维度 | 设计 |
|---|---|
| Feature Disabled 行为 | Datadog 门控关闭时静默跳过；killswitch 激活时也跳过 |
| 错误处理 | sink 路由不抛错，各 sink 自行处理错误 |
| 隐私保护 | `_PROTO_*` 仅发往 1P，Datadog 自动过滤 |

#### 设计取舍与备选

| 决策 | 取舍 | 备选方案 | 不选理由 |
|---|---|---|---|
| 早期事件用缓存门控 | 不丢失数据；但可能用旧配置 | 等待门控初始化 | 阻塞启动 |
| 采样在 sink 层统一做 | 单一控制点；但所有事件先进入系统 | 各 sink 自己采样 | 重复逻辑；不一致行为 |
| 异步实现同步包装 | 接口向后兼容；但名称误导 | 移除异步接口 | 破坏性变更 |

#### 源码测试证据

- 源码位置：`src/services/analytics/sink.ts`、`src/services/analytics/firstPartyEventLogger.ts`
- 现有测试：无专门单元测试

---

### 模块设计卡 3：工具名称消毒与元数据模块 (`src/services/analytics/metadata.ts`)

#### 真实入口签名与关键类型

```typescript
// 消毒入口
export function sanitizeToolNameForAnalytics(
  toolName: string
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

// 详细工具名开关
export function isToolDetailsLoggingEnabled(): boolean
export function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined
): boolean

// MCP 工具详情提取
export function mcpToolDetailsForAnalytics(
  toolName: string,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined
): {
  mcpServerName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  mcpToolName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}
export function extractMcpToolDetails(toolName: string): {
  serverName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  mcpToolName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} | undefined

// Skill 名提取
export function extractSkillName(
  toolName: string,
  input: unknown
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined

// 元数据格式化
export function getEventMetadata(options?: EnrichMetadataOptions): Promise<EventMetadata>
export function to1PEventFormat(
  metadata: EventMetadata,
  userMetadata: CoreUserData,
  additionalMetadata?: Record<string, unknown>
): FirstPartyEventLoggingMetadata
```

#### 输入输出

| 入口 | 输入 | 输出 | 副作用 |
|---|---|---|---|
| `sanitizeToolNameForAnalytics(name)` | 原始工具名 | 消毒后的工具名（类型标记） | 无 |
| `isAnalyticsToolDetailsLoggingEnabled(type, url)` | MCP 服务器类型、URL | boolean | 无 |
| `mcpToolDetailsForAnalytics(name, type, url)` | 完整工具名、服务器类型、URL | 可选服务器名+工具名对象 | 无 |
| `getEventMetadata(options)` | 可选模型、betas、附加元数据 | 丰富后的事件元数据 | 无（memoized 部分可能缓存） |
| `to1PEventFormat(meta, userMeta, addMeta)` | 核心元数据、用户元数据、附加元数据 | 1P 格式元数据 | 无 |

#### 事件与队列状态

| 状态项 | 类型 | 初始化 | 变更时机 | 访问方式 |
|---|---|---|---|---|
| `buildEnvContext` memoize | 内部 | 首次调用 | 永不（进程级缓存） | 内部私有 |
| `prevCpuUsage` / `prevWallTimeMs` | `NodeJS.CpuUsage \| null` / `number \| null` | `null` / `null` | `buildProcessMetrics()` 每次调用更新 | 内部私有 |

工具名称消毒策略：
- 格式：`mcp__<server>__<tool>` → 拆分为 `serverName` + `mcpToolName`
- 默认消毒为 `mcp_tool`（除非满足以下任一条件）：
  - 入口点为 `local-agent`（Cowork）
  - MCP 服务器类型为 `claudeai-proxy`
  - MCP 服务器 URL 在官方注册表中
  - 是内置 MCP 服务器（如 `computerUse`，feature-gated）
- OTel 工具详情单独开关：`OTEL_LOG_TOOL_DETAILS=1`

#### 构造/过滤/导出/关闭流程

**构造流程**：
- 模块无显式初始化，纯函数为主
- `buildEnvContext()`、`getModelBetas()` 等用 memoize 缓存

**过滤流程**：
1. 工具名消毒：`sanitizeToolNameForAnalytics()` → MCP 工具默认变 `mcp_tool`
2. 文件扩展名限制：`getFileExtensionForAnalytics()` → 超长扩展名变 `other`
3. 工具输入截断：`extractToolInputForTelemetry()` → 字符串、嵌套深度、集合大小均有上限
4. 内部键过滤：`truncateToolInputValue()` → 跳过 `_` 开头的键

**1P 格式化流程**：
1. 转换 `envContext` 为 snake_case，与 proto 类型匹配
2. 转换核心字段为 snake_case
3. 映射用户元数据（GitHub Actions 元数据放入 env）
4. 构建 `auth` 对象（仅 account_uuid/organization_uuid）
5. 附加 `rh`（仓库哈希）、`is_assistant_mode` 等

**关闭流程**：
- 无独立关闭，memoized 缓存进程生命周期内保留

#### 错误与隐私

| 维度 | 设计 |
|---|---|
| 隐私边界 | 类型标记要求显式验证；工具名默认消毒；文件扩展名限制长度；工具输入截断 |
| `_PROTO_` 字段路由 | 不在此模块处理（由 index/stripProtoFields 和 exporter 处理） |
| 错误处理 | `buildProcessMetrics()` 捕获异常返回 undefined；其余纯函数无异常 |

#### 设计取舍与备选

| 决策 | 取舍 | 备选方案 | 不选理由 |
|---|---|---|---|
| MCP 工具名默认消毒 | 保护隐私；但损失一些分析数据 | 默认记录详细名 | 隐私风险过高 |
| 多条件开关详细名 | 精确控制；但逻辑复杂 | 简单 on/off | 不够灵活 |
| `to1PEventFormat()` 用生成类型约束 | 编译期检查 proto 匹配；但修改 proto 需要重新生成 | 手写类型 | 容易与 proto 漂移 |
| memoize 缓存 envContext | 性能优化；但配置变更不刷新 | 每次重新计算 | 启动性能下降 |

#### 源码测试证据

- 源码位置：`src/services/analytics/metadata.ts`
- 现有测试：`tests/antTraceCommand.test.ts` 间接验证消毒逻辑
- 缺口：各消毒条件组合、文件扩展名处理、工具输入截断无专门测试

---

### 模块设计卡 4：失败重试与持久化模块 (`src/services/analytics/firstPartyEventLoggingExporter.ts`)

#### 真实入口签名与关键类型

```typescript
export class FirstPartyEventLoggingExporter implements LogRecordExporter {
  constructor(options?: {
    timeout?: number
    maxBatchSize?: number
    skipAuth?: boolean
    batchDelayMs?: number
    baseBackoffDelayMs?: number
    maxBackoffDelayMs?: number
    maxAttempts?: number
    path?: string
    baseUrl?: string
    isKilled?: () => boolean
    schedule?: (fn: () => Promise<void>, delayMs: number) => () => void
  })

  // 核心接口
  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void
  shutdown(): Promise<void>
  forceFlush(): Promise<void>

  // 测试用
  async getQueuedEventCount(): Promise<number>
}

// 内部类型
type FirstPartyEventLoggingEvent = {
  event_type: 'ClaudeCodeInternalEvent' | 'GrowthbookExperimentEvent'
  event_data: unknown
}
```

#### 输入输出

| 入口 | 输入 | 输出 | 副作用 |
|---|---|---|---|
| `export(logs, callback)` | OTel LogRecord 数组、回调 | void（异步） | 成功则发送；失败则持久化到磁盘 + 调度重试 |
| `shutdown()` | 无 | Promise&lt;void&gt; | 停止重试，强制刷新 |
| `forceFlush()` | 无 | Promise&lt;void&gt; | 等待待处理导出完成 |

#### 事件与队列状态

| 状态项 | 类型 | 初始化 | 变更时机 | 访问方式 |
|---|---|---|---|---|
| `pendingExports` | `Promise<void>[]` | `[]` | `export()` 加入；完成后移除 | 内部私有 |
| `isShutdown` | `boolean` | `false` | `shutdown()` 设为 true | 内部私有 |
| `attempts` | `number` | `0` | 每次失败递增；成功重置为 0 | 内部私有 |
| `isRetrying` | `boolean` | `false` | 重试开始设为 true；结束设为 false | 内部私有 |
| `cancelBackoff` | `(() => void) \| null` | `null` | 调度重试时设置；重置时取消 | 内部私有 |
| `lastExportErrorContext` | `string \| undefined` | `undefined` | 失败时记录；成功清除 | 内部私有 |

持久化文件格式：
- 位置：`~/.claude/telemetry/1p_failed_events.<sessionId>.<batchUuid>.json`
- 格式：JSON Lines（每行一个事件对象）
- 多会话隔离：sessionId 区分；batchUuid 区分同会话不同进程

重试策略：
- 二次退避：`baseBackoffDelayMs * attempts^2`
- 默认 base: 500ms，max: 30s，maxAttempts: 8
- 成功后立即检查/重试剩余队列
- 启动时自动重放上会话失败文件

#### 构造/过滤/导出/关闭流程

**构造流程**：
1. 根据 `process.env.ANTHROPIC_BASE_URL` 选择 baseUrl（staging/prod）
2. 设置默认配置（timeout 10s, maxBatchSize 200, etc.）
3. 后台调用 `retryPreviousBatches()` 加载上会话失败文件

**过滤/转换流程**（`transformLogsToEvents()`）：
1. 筛选事件：仅处理 `instrumentationScope.name === 'com.anthropic.claude_code.events'`
2. GrowthBook 实验事件特殊处理
3. 普通事件：提取 `core_metadata`、`user_metadata`、`event_metadata`
4. 调用 `to1PEventFormat()` 转换
5. **`_PROTO_` 字段提取**：从 `additional` 中提取 `_PROTO_skill_name`、`_PROTO_plugin_name`、`_PROTO_marketplace_name` 到 proto 顶层字段
6. **防御性过滤**：剩余 `additional` 调用 `stripProtoFields()` 清除所有 `_PROTO_*`
7. 序列化为 `ClaudeCodeInternalEvent.toJSON()`

**发送流程**：
1. 检查 `isKilled()` → 激活则抛错中止
2. 分块：每块 `maxBatchSize` 个事件
3. 每块发送：
   - 检查信任状态/令牌过期决定是否带认证
   - 失败且是 401 则重试无认证
   - 失败则短路剩余块，全部入失败队列
4. 全部成功 → `resetBackoff()` → 立即 `retryFailedEvents()`
5. 失败 → `appendEventsToFile()` → `scheduleBackoffRetry()`

**重试流程**（`retryFailedEvents()`）：
1. 加载当前会话失败文件
2. `attempts >= maxAttempts` → 删除文件，返回
3. 发送 → 成功则删除文件，继续循环；失败则保存剩余，调度重试

**关闭流程**：
1. `shutdown()` → `isShutdown = true`，`resetBackoff()`，`forceFlush()`
2. `forceFlush()` → 等待 `pendingExports` 全部完成

#### 错误与隐私

| 维度 | 设计 |
|---|---|
| 错误隔离 | 1P 失败不影响 Datadog/OTel；失败块短路但不影响已成功块 |
| 认证降级 | 401 自动重试无认证；信任未建立/令牌过期跳过认证 |
| 持久化隐私 | 失败文件在用户本地 `~/.claude/telemetry/`，不上传 |
| killswitch | `isKilled()` 每次 POST 检查，激活则停止发送但退避定时器继续 |

#### 设计取舍与备选

| 决策 | 取舍 | 备选方案 | 不选理由 |
|---|---|---|---|
| 追加式持久化 | 原子性好；但文件可能累积 | 覆盖式写入 | 崩溃风险丢失数据 |
| 二次退避 | 服务端过载时保护；但恢复时不够快 | 固定间隔 | 过载时雪上加霜 |
| 最大尝试限制 | 防止无限重试；但可能丢失事件 | 无限重试 | 磁盘空间耗尽风险 |
| 批量短路 | 快速失败；但后续块未尝试发送 | 继续尝试剩余块 | 浪费资源 |
| 防御性 stripProtoFields | 防止未来 `_PROTO_*` 泄露；但重复工作 | 依赖调用方过滤 | 容易遗漏 |

#### 源码测试证据

- 源码位置：`src/services/analytics/firstPartyEventLoggingExporter.ts`
- 现有测试：无专门单元测试
- 缺口：持久化、重试策略、认证降级、killswitch 行为均无测试

---

### 模块设计卡 5：日志与 OTel 导出模块 (`src/utils/telemetry/instrumentation.ts`)

#### 真实入口签名与关键类型

```typescript
// 公共入口
export function bootstrapTelemetry(): void
export function isTelemetryEnabled(): boolean
export async function initializeTelemetry(): Promise<Meter>
export async function flushTelemetry(): Promise<void>

// 内部解析
export function parseExporterTypes(value: string | undefined): string[]

// 配置常量
const DEFAULT_METRICS_EXPORT_INTERVAL_MS = 60000
const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 5000
const DEFAULT_TRACES_EXPORT_INTERVAL_MS = 5000
```

#### 输入输出

| 入口 | 输入 | 输出 | 副作用 |
|---|---|---|---|
| `bootstrapTelemetry()` | 无 | void | 从 `ANT_OTEL_*` 复制环境变量（ant 构建）；设置默认 temporality=delta |
| `initializeTelemetry()` | 无 | Promise&lt;Meter&gt; | 设置全局 LoggerProvider/MeterProvider/TracerProvider；注册 cleanup |
| `flushTelemetry()` | 无 | Promise&lt;void&gt; | 强制刷新 metrics/logs/traces |

#### 事件与队列状态

| 状态项 | 存储位置 | 类型 | 访问方式 |
|---|---|---|---|
| `LoggerProvider` | `bootstrap/state.ts` | `LoggerProvider \| undefined` | `getLoggerProvider()` / `setLoggerProvider()` |
| `MeterProvider` | `bootstrap/state.ts` | `MeterProvider \| undefined` | `getMeterProvider()` / `setMeterProvider()` |
| `TracerProvider` | `bootstrap/state.ts` | `TracerProvider \| undefined` | `getTracerProvider()` / `setTracerProvider()` |
| 事件 Logger | `bootstrap/state.ts` | `Logger \| undefined` | `getEventLogger()` / `setEventLogger()` |

环境变量驱动：
- 启用开关：`CLAUDE_CODE_ENABLE_TELEMETRY=1`
- 导出器选择：`OTEL_METRICS_EXPORTER`、`OTEL_LOGS_EXPORTER`、`OTEL_TRACES_EXPORTER`（逗号分隔，`none` 禁用）
- 协议：`OTEL_EXPORTER_OTLP_PROTOCOL`（grpc/http/json/http/protobuf）
- 端点：`OTEL_EXPORTER_OTLP_ENDPOINT`
- 头部：`OTEL_EXPORTER_OTLP_HEADERS`

动态导入优化：
- `getOtlpReaders()`、`getOtlpLogExporters()`、`getOtlpTraceExporters()` 内部动态 `import()` 导出器
- 避免加载未使用的导出器（如 grpc 约 700KB）

BigQuery 指标：
- 启用条件：API 客户、C4E 企业用户、团队用户
- 导出间隔：5 分钟（硬编码）

Beta 追踪：
- 独立代码路径，使用 `BETA_TRACING_ENDPOINT`
- 与常规 OTel 不互斥（metrics 仍设置）

#### 构造/过滤/导出/关闭流程

**构造流程**：
1. `bootstrapTelemetry()`：环境变量预处理
2. `initializeTelemetry()`：
   - 移除 console 导出器（如果 `getHasFormattedOutput()` 为 true，避免破坏 SDK 通道）
   - 设置 diag logger（仅 ERROR 级别）
   - 初始化 Perfetto tracing（独立）
   - 构建 resource（service name/version、host arch、os、env、WSL version）
   - 检查 beta tracing → 启用则走独立路径
   - 创建 MeterProvider + 配置 reader（OTel/BigQuery）
   - telemetry 启用则创建 LoggerProvider
   - telemetry+enhanced 启用则创建 TracerProvider
   - 注册 shutdown cleanup

**导出流程**：
- OTel BatchLogRecordProcessor/BatchSpanProcessor/PeriodicExportingMetricReader 自动按间隔导出
- Proxy/mTLS 支持：`getOTLPExporterConfig()` 提供 HttpAgentFactory
- 动态头部：`otelHeadersHelper` 配置时每次刷新头部

**关闭流程**：
1. `shutdownTelemetry()`（cleanup 回调）：
   - 结束 active interaction span
   - 调用各 provider `.shutdown()`
   - 超时保护：`CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS`（默认 2000ms）
2. `beforeExit` 事件：force flush logs/traces
3. `exit` 事件：最后尝试 force flush

#### 错误与隐私

| 维度 | 设计 |
|---|---|
| 超时保护 | 初始化/关闭/flush 均有超时，不无限阻塞 |
| 错误隔离 | OTel 失败不影响主功能；shutdown 错误忽略 |
| 隐私边界 | 不处理具体事件内容，仅作为传输管道；事件隐私由 analytics 层保证 |
| Feature Disabled | `CLAUDE_CODE_ENABLE_TELEMETRY` 未设置则完全跳过 OTel 设置（仅内部 BigQuery 可能启用） |

#### 设计取舍与备选

| 决策 | 取舍 | 备选方案 | 不选理由 |
|---|---|---|---|
| 动态导入导出器 | 减少启动包大小；但首次加载有轻微延迟 | 静态导入所有 | 包体积膨胀约 1.2MB |
| state.ts 存储 provider | 避免循环依赖；但需要 getter/setter | 单例模块 | 循环依赖风险 |
| 独立 beta tracing 路径 | 灵活实验；但代码重复 | 统一路径 | 增加常规路径复杂度 |
| cleanup 注册关闭 | 集中管理；但依赖 registry 正常工作 | 手动关闭 | 容易遗漏 |

#### 源码测试证据

- 源码位置：`src/utils/telemetry/instrumentation.ts`
- 现有测试：无专门单元测试
- 缺口：动态导入、超时行为、proxy/mTLS 配置无测试

---

### 模块设计卡 6：生成类型边界模块 (`src/types/generated/events_mono/`)

#### 真实入口签名与关键类型

```typescript
// 从 proto 生成的类型示例
import { ClaudeCodeInternalEvent } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import { GrowthbookExperimentEvent } from '../../types/generated/events_mono/growthbook/v1/growthbook_experiment_event.js'

// 关键使用点
// metadata.ts: to1PEventFormat() 返回类型与 proto 匹配
// firstPartyEventLoggingExporter.ts: ClaudeCodeInternalEvent.toJSON() 序列化
```

#### 输入输出

生成文件仅提供类型定义和序列化函数，无运行时状态。

#### 事件与队列状态

无状态，纯类型/函数定义。

#### 构造/过滤/导出/关闭流程

**生成流程**（外部）：
- 从 monorepo proto 定义生成
- 命令：`bun run generate:proto`
- **不宣称**生成过程已验证隐私行为

**使用流程**：
1. `to1PEventFormat()`：构造时类型检查字段与 proto 匹配
2. `FirstPartyEventLoggingExporter`：调用生成的 `.toJSON()` 序列化
3. 生成的 `.toJSON()` 静默丢弃未知字段（防止漂移时崩溃）

**边界定位**：
- 生成文件是**协议边界**，不是实现边界
- 手动代码**不得修改**生成文件
- 修改协议需要：更新 proto → 重新生成 → 更新使用方

#### 错误与隐私

| 维度 | 设计 |
|---|---|
| 隐私声明 | **不宣称**未测试隐私行为已验证 |
| 漂移防护 | 类型系统防止字段不匹配；`.toJSON()` 静默丢弃未知字段 |
| 错误处理 | 生成代码无运行时错误处理（类型安全前提下） |

#### 设计取舍与备选

| 决策 | 取舍 | 备选方案 | 不选理由 |
|---|---|---|---|
| proto 作为单一事实源 | 跨语言一致；但需要生成步骤 | 手写类型 + JSON Schema | 容易漂移；维护成本高 |
| 生成类型仅作边界 | 清晰分离；但修改流程较长 | 直接手写 | 与后端 proto 不一致风险 |
| `.toJSON()` 静默丢弃未知 | 向后兼容；但无声数据丢失 | 抛错 | 生产环境崩溃风险 |

#### 源码测试证据

- 源码位置：`src/types/generated/events_mono/`
- 现有测试：无专门测试
- 缺口：生成类型与实际使用匹配性无测试

---

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
| 事件队列化等待 sink | `src/services/analytics/index.ts:68-123` | 无直接测试 | 未找到专门的队列化测试 |
| 类型标记防止敏感数据 | `src/services/analytics/index.ts:19-33` | 无直接测试 | 类型标记主要在编译时起作用，无运行时测试 |
| `_PROTO_` 字段过滤 | `src/services/analytics/index.ts:45-58` + `firstPartyEventLoggingExporter.ts:719-725` | 无直接测试 | `_PROTO_` 字段提取和过滤逻辑无专门测试 |
| 失败事件持久化 + 二次退避 | `src/services/analytics/firstPartyEventLoggingExporter.ts:38-517` | 无直接测试 | 持久化和重试逻辑无专门测试 |
| Datadog 允许列表 + 批处理 | `src/services/analytics/datadog.ts:19-317` | 无直接测试 | Datadog 导出逻辑无专门测试 |
| OTLP 动态导入 | `src/utils/telemetry/instrumentation.ts:3-11` | 无直接测试 | 动态导入逻辑无专门测试 |
| 工具名称消毒策略 | `src/services/analytics/metadata.ts:69-128` | `tests/antTraceCommand.test.ts` 验证了 MCP 工具名称被消毒为 `mcp_tool`，同时过滤了敏感属性 | antTrace 测试主要验证本地追踪导出，不是专门的遥测消毒测试 |
| 生成类型边界 | `src/types/generated/events_mono/` | 无直接测试 | 生成类型仅作为类型边界，无运行时测试 |

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

### 7.2 现有相关测试

| 测试文件 | 覆盖内容 | 说明 |
|---|---|---|
| `tests/antTraceCommand.test.ts` | 验证了 MCP 工具名称被消毒为 `mcp_tool`，敏感属性被过滤 | 这是本地追踪命令的测试，间接验证了消毒逻辑 |

### 7.3 未覆盖行为（基于代码阅读）

- telemetry 核心功能无专门测试文件
- 真实网络条件下的重试测试缺失
- 隐私边界测试（`_PROTO_` 字段过滤、工具名称消毒）无专门用例
- 启动性能测试（队列化不阻塞）缺失
- 跨子系统集成测试缺失
- 没有外部 live 验证测试

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
| P2 | 已证实测试缺口大（第 7 节无测试） | 补充核心路径单元测试：队列、重试、PII 过滤、消毒 | 低（新增测试） | 每个核心模块有对应测试文件，覆盖主要路径和边界情况 | M | 设计推断 |
| P2 | 失败事件可能永远保留（用户不再使用同一 sessionId） | 添加文件过期机制：删除超过 N 天的失败事件文件 | 低（只删除旧文件） | 旧文件被自动清理 | S | 设计推断 |
| P2 | BigQuery 指标仅 5 分钟间隔，无法调整 | 考虑添加配置或自适应间隔 | 中（改变现有行为） | 可配置间隔生效 | S | 设计推断 |
| P2 | 遥测初始化仍在启动路径 | 考虑进一步延迟或后台化初始化 | 中（时序变化） | 启动更快，事件不丢失 | M | 设计推断 |
| P3 | 类型标记使用 `as` 转换，容易出错 | 考虑提供 helper 函数 `verifiedString()`，封装验证逻辑 | 低（只新增 helper，不改变现有代码） | 开发者使用 helper 而非直接 `as` | S | 设计推断 |
| P3 | killswitch 激活后仍继续重试（只是每次失败） | 考虑 killswitch 激活后暂停重试，直到下次启动或 killswitch 解除 | 中（改变重试逻辑） | killswitch 激活后不浪费资源重试 | M | 设计推断 |
