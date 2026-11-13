---
id: context-compaction
batch: 1
title: Context Compaction 历史压缩与溢出恢复设计
date: 2026-11-12
status: draft
---

# Context Compaction 历史压缩与溢出恢复设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

当对话历史增长超过模型上下文窗口的90%时，用户会遇到`prompt too long`错误，导致对话无法继续；当历史更长时，即使压缩本身也会因prompt过长而失败。同时，工具结果（尤其是shell输出、grep结果、文件内容）会占用大量token，而大部分历史对话的完整细节在后续轮次中不再需要。

### 调用方与职责边界
- **上游**: query.ts的主循环、QueryEngine.submitMessage()
- **本层**: 7种压缩机制的协调与执行
- **下游**: Claude API（用于生成摘要）、sessionStorage（用于持久化）

### 约束条件
- 7种压缩机制有明确的优先级：microcompact → snip → context collapse → autocompact → reactive compact → session memory compact → manual compact
- feature gates分多个层级：build-time (`feature()`)、runtime (`getFeatureValue()`)、环境变量 (`CLAUDE_*`)、用户配置
- context collapse使用模块级全局状态（`collapseStore`），在forked agents中需避免污染主状态
- 压缩API调用本身也可能触发`prompt too long`，需要重试策略

### Feature Gates 与 Disabled 机制
- **build-time gates**: `feature('CACHED_MICROCOMPACT')`、`feature('CONTEXT_COLLAPSE')`、`feature('REACTIVE_COMPACT')`、`feature('PROMPT_CACHE_BREAK_DETECTION')`、`feature('KAIROS')`
- **runtime gates**: `tengu_compact_cache_prefix`、`tengu_cobalt_raccoon`、`tengu_compact_streaming_retry`
- **环境变量**:
  - `CLAUDE_CONTEXT_COLLAPSE` (默认true)
  - `CLAUDE_REACTIVE_COMPACT` (默认true)
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
  - `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  - `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`
  - `DISABLE_COMPACT` (禁用所有压缩)
  - `DISABLE_AUTO_COMPACT` (仅禁用autocompact)
- **用户配置**: `autoCompactEnabled` (全局配置)

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 7种压缩机制分层，而非单一方案 | microcompact清理工具结果 → context collapse后台渐变 → autocompact完整摘要 → reactive compact错误恢复 | 不同场景适用不同策略：microcompact零延迟、context collapse低干扰、autocompact最彻底 | 单一完整压缩：延迟太高，频繁打断用户；单一裁剪：丢失太多上下文 | 实现复杂度高，状态管理分散 | src/services/compact/ 下7个模块；src/services/contextCollapse/ 下4个模块 |
| context collapse使用非阻塞spawn + staging + 溢出commit | token>90%时后台spawn summarizer；完成后staged；仅当真正溢出时才commit并project | 避免在正常对话路径上插入延迟；staged状态不影响当前投影；仅在紧急时才真正变更历史 | 阻塞式summarize：用户可见延迟高；立即commit：用户可能注意到历史突然变化 | 状态机复杂：spawned/staged/committed多状态；generation计数器防过期 | src/services/contextCollapse/index.ts:228-317 (applyCollapsesIfNeeded), 187-226 (commitStaged) |
| reactive compact使用strip-images + PTL重试循环 | 先strip images/documents替换为[image]/[document]；若仍PTL，truncate最旧API-round groups | 图片/doc占用大量token，通常压缩摘要不需要；PTL重试是最后逃生门 | 直接压缩：图片可能导致压缩本身PTL | 有损：图片/doc永久丢失；压缩仍可能失败（MAX_PTL_RETRIES=3次） | src/services/compact/compact.ts:145-209 (stripImagesFromMessages), 243-291 (truncateHeadForPTLRetry), 457-498 (PTL重试循环) |
| compact boundary后数组裁剪+GC | QueryEngine收到compact boundary时，裁剪mutableMessages和局部messages数组，仅保留边界后的内容 | 避免压缩后历史仍在内存中累积，防止长期运行会话OOM | 保留完整历史：内存无限增长，长会话变慢 | 需要正确维护preserved segment的parent UUID链；重放时需从session storage重建 | src/QueryEngine.ts (compact boundary处理分支，见query-core spec) |
| autocompact circuit breaker防止死循环 | consecutiveFailures计数，达到MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES(=3)时停止尝试 | 避免在上下文 irrecoverably over limit时，每轮都尝试注定失败的压缩 | 无限制重试：浪费API调用，延迟每轮对话 | 用户可能不知道为什么autocompact停止工作；需手动触发 | src/services/compact/autoCompact.ts:260-265 (circuit breaker), 341-349 (failure计数) |
| post-compaction重建工作上下文，而非仅保留摘要 | 重新注入附件：最近读取的文件、plan、invoked skills、工具delta；清空readFileState但立即恢复关键文件；执行sessionStart hooks | 纯摘要会丢失模型执行后续任务所需的状态，造成"失忆" | 仅保留摘要：模型需要重新问问题/重新读文件，用户体验差 | post-compaction token预算仍可能紧张；需要平衡恢复多少上下文 | src/services/compact/compact.ts:526-602 (附件重建), 344-347 (postCompactCleanup) |
| microcompact分两条路径：cached MC vs time-based MC | cached MC: cache_edits API删除工具结果，保留缓存前缀；time-based MC: 长时间gap后直接content-clear旧工具结果 | cached MC性能最优（不重写前缀）；time-based MC处理缓存过期场景 | 仅cached MC: 缓存过期时仍发送完整旧结果；仅time-based MC: 始终修改消息，破坏缓存 | cached MC仅支持主线程、特定模型；time-based MC直接修改消息内容 | src/services/compact/microCompact.ts:257-296 (microcompactMessages), 450-533 (time-based路径) |

## 3. 目标与非目标

### 目标

#### 状态与生命周期
- **模块级状态**: `collapseStore` (context collapse)、`cachedMCState` (cached microcompact)、`dependencies` (可注入测试)
- **持久化**: context collapse commits和staged snapshot写入session storage；恢复时用`restoreFromEntries()`重建
- **重置**: `resetContextCollapse()`、`resetMicrocompactState()`用于测试和清理

#### 接口与数据
- **主要入口**:
  - `compactConversation()` / `partialCompactConversation()`: 完整/部分压缩
  - `autoCompactIfNeeded()`: 自动触发
  - `microcompactMessages()`: 微压缩
  - `tryReactiveCompact()` / `reactiveCompactOnPromptTooLong()`: 错误恢复
  - `applyCollapsesIfNeeded()` / `recoverFromOverflow()`: context collapse
- **返回类型**: `CompactionResult` (含boundaryMarker、summaryMessages、attachments、hookResults、messagesToKeep、userDisplayMessage)

#### 执行与环境
- **调用位置**: query.ts主循环、recover withheld错误分支、/compact命令
- **forked agent使用**: compact/session_memory/marble_origami源禁用autocompact/context collapse，避免死锁和状态污染
- **注入点**: `initContextCollapse()`、`initReactiveCompact()`支持依赖注入用于测试

#### 依赖边界
- **上游依赖**: query-core（消息传递、abort controller、toolUseContext）、token统计（`tokenCountWithEstimation`）
- **下游依赖**: Claude API（生成摘要）、sessionStorage（持久化）、hooks系统（preCompact/postCompact/sessionStart）
- **不拥有**: query-core的QueryEngine/mutableMessages、SDK消息转换、通用token统计

### 非目标
- 不替代query-core的对话管理
- 不处理SDK协议细节
- 不提供通用token统计（由utils/tokens.ts处理）
- 不重新实现Claude API客户端

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 核心压缩
async function compactConversation(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact?: boolean,
  recompactionInfo?: RecompactionInfo,
  skipPreCompactHooks?: boolean
): Promise<CompactionResult>

// 部分压缩（保留前缀或后缀）
async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from' // 'from'=保留前缀, 'up_to'=保留后缀
): Promise<CompactionResult>

// 自动压缩触发
async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number
): Promise<{ wasCompacted: boolean; compactionResult?: CompactionResult; consecutiveFailures?: number }>

// 微压缩
async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource
): Promise<MicrocompactResult>

// 响应式压缩（PTL恢复）
async function tryReactiveCompact(
  attempt: ReactiveCompactAttempt
): Promise<CompactionResult | null>

async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  options: { customInstructions?: string; trigger: 'manual' | 'auto' }
): Promise<ReactiveCompactOutcome>

// Context Collapse
async function applyCollapsesIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  querySource: QuerySource
): Promise<{ messages: Message[] }>

function recoverFromOverflow(
  messages: Message[],
  querySource: QuerySource
): { messages: Message[]; committed: number }

function projectView<T extends Message>(messages: T[]): T[] // 应用committed collapses
```

### 4.2 模块设计卡

#### 4.2.1 AutoCompact 模块

**真实入口签名与关键类型**
```typescript
// 公共入口
export function isAutoCompactEnabled(): boolean
export function getAutoCompactThreshold(model: string): number
export function getEffectiveContextWindowSize(model: string): number
export function calculateTokenWarningState(
  tokenUsage: number,
  model: string
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
}
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0
): Promise<boolean>
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}>

// 关键类型
export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  turnId: string
  consecutiveFailures?: number
}

// 配置常量
const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

**输入输出**
- 输入：完整消息列表、toolUseContext、cacheSafeParams、querySource、tracking状态、snipTokensFreed
- 输出：{wasCompacted, compactionResult?, consecutiveFailures?}
- snipTokensFreed：从token计数中减去该值，避免snip后仍触发autocompact

**状态与持久化**
- 无模块级状态（除了可注入的dependencies用于测试）
- 状态通过tracking参数由调用方（query.ts）传递
- circuit breaker状态：consecutiveFailures计数在tracking中维护

**触发/压缩/恢复流程**
1. **触发决策**：shouldAutoCompact()
   - Feature gate检查：DISABLE_COMPACT/DISABLE_AUTO_COMPACT
   - Query source过滤：禁用session_memory/compact/marble_origami
   - Reactive-only检查：tengu_cobalt_raccoon启用时跳过
   - Context collapse检查：启用时跳过（让collapse管理）
   - Token计算：tokenCountWithEstimation(messages) - snipTokensFreed
   - 阈值比较：token >= getAutoCompactThreshold(model)
2. **执行压缩**：autoCompactIfNeeded()
   - Circuit breaker检查：consecutiveFailures >= 3 → 跳过
   - 先尝试session memory compact（实验性）
   - 调用compactConversation(isAutoCompact=true)
   - 成功：reset consecutiveFailures=0，执行post-compact cleanup
   - 失败：increment consecutiveFailures，仅记录log
3. **调用方处理**：
   - 成功：buildPostCompactMessages替换历史
   - 失败：下次循环继续尝试（直到circuit breaker触发）

**取消与失败**
- 用户ESC：APIUserAbortError向上传播，不计入consecutiveFailures
- 压缩失败：consecutiveFailures递增，达到3次触发circuit breaker
- Circuit breaker：静默跳过，无用户可见提示
- Post-compact清理：总是执行，无论成功失败

**设计取舍与备选**
- 取：snipTokensFreed阈值传递 → 避免snip后立即触发压缩
- 取：circuit breaker防止死循环 → 代价是用户不知道为什么停止
- 舍：无时间衰减reset机制 → 改进建议见第9章
- 备选：单一阈值vs比例 → 当前固定13k buffer

**源码证据**
- src/services/compact/autoCompact.ts:72-91 (阈值计算)
- src/services/compact/autoCompact.ts:160-239 (shouldAutoCompact)
- src/services/compact/autoCompact.ts:241-351 (autoCompactIfNeeded)
- tests/contextCollapse.test.ts (间接验证与collapse的互斥)

---

#### 4.2.2 MicroCompact 模块

**真实入口签名与关键类型**
```typescript
// 公共入口
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource
): Promise<MicrocompactResult>
export function consumePendingCacheEdits(): import('./cachedMicrocompact.js').CacheEditsBlock | null
export function getPinnedCacheEdits(): import('./cachedMicrocompact.js').PinnedCacheEdits[]
export function pinCacheEdits(
  userMessageIndex: number,
  block: import('./cachedMicrocompact.js').CacheEditsBlock
): void
export function markToolsSentToAPIState(): void
export function resetMicrocompactState(): void
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined
): { gapMinutes: number; config: TimeBasedMCConfig } | null

// 关键类型
export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}
type PendingCacheEdits = {
  trigger: 'auto'
  deletedToolIds: string[]
  baselineCacheDeletedTokens: number
}

// 可压缩工具白名单
const COMPACTABLE_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])
```

**输入输出**
- 输入：消息列表、toolUseContext、querySource
- 输出：MicrocompactResult（可能修改后的消息 + pending cache edits）
- 两条路径优先级：time-based → cached

**状态与持久化**
- 模块级状态（仅ant-build）：
  - cachedMCState：CachedMCState（工具注册、已删除、pinned edits）
  - pendingCacheEdits：单次请求临时状态，消费后清空
- 状态重置：time-based触发后resetMicrocompactState()
- 无持久化（依赖sessionStorage存储完整历史）

**触发/压缩/恢复流程**
1. **Time-based路径（优先）**
   - evaluateTimeBasedTrigger：检查querySource、last assistant消息时间gap
   - collectCompactableToolIds：收集白名单工具
   - keepRecent N个，清空其余内容为"[Old tool result content cleared]"
   - log tengu_time_based_microcompact
   - resetMicrocompactState()（缓存已失效）
   - notifyCacheDeletion()
2. **Cached路径（fallback）**
   - 检查feature(CACHED_MICROCOMPACT)、配置enabled、模型支持、主thread
   - collectCompactableToolIds + registerToolResult/registerToolMessage
   - getToolResultsToDelete：根据triggerThreshold和keepRecent决定
   - createCacheEditsBlock、设置pendingCacheEdits
   - log tengu_cached_microcompact
   - suppressCompactWarning()
   - notifyCacheDeletion()
   - 返回原始消息（cache edits由API层应用）
3. **API层消费**：
   - consumePendingCacheEdits()获取并附加到请求
   - markToolsSentToAPIState()标记已发送

**取消与失败**
- 无取消机制（同步操作）
- cached路径失败：回退到不压缩
- time-based失败：继续尝试cached路径

**设计取舍与备选**
- 取：两条路径分离 → time-based适合长gap，cached适合短间隔
- 取：time-based直接修改消息 + reset缓存 → 代价是缓存失效
- 舍：cached仅主thread可用 → 避免forked agent污染全局状态
- 备选：统一cache edits路径 → 当前time-based仍用content-clear

**源码证据**
- src/services/compact/microCompact.ts:257-296 (microcompactMessages主入口)
- src/services/compact/microCompact.ts:309-403 (cachedMicrocompactPath)
- src/services/compact/microCompact.ts:426-533 (time-based路径)
- src/services/compact/cachedMicrocompact.ts (cached实现)

---

#### 4.2.3 ReactiveCompact 模块

**真实入口签名与关键类型**
```typescript
// 公共入口
export function isReactiveCompactEnabled(): boolean
export function isReactiveOnlyMode(): boolean
export function isWithheldPromptTooLong(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent | undefined
): boolean
export function isWithheldMediaSizeError(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent | undefined
): boolean
export async function tryReactiveCompact(
  attempt: ReactiveCompactAttempt
): Promise<CompactionResult | null>
export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  options: { customInstructions?: string; trigger: 'manual' | 'auto' }
): Promise<ReactiveCompactOutcome>

// 依赖注入（测试用）
export function initReactiveCompact(
  overrides: Partial<typeof defaultDependencies> = {}
): void

// 关键类型
export type ReactiveCompactAttempt = {
  hasAttempted: boolean
  querySource: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}
type ReactiveCompactOutcome =
  | { ok: true; result: CompactionResult }
  | { ok: false; reason: 'too_few_groups' | 'aborted' | 'exhausted' | 'error' | 'media_unstrippable' }
```

**输入输出**
- 输入：ReactiveCompactAttempt（消息、状态、cacheSafeParams）
- 输出：CompactionResult | null（成功返回结果，失败返回null）
- Outcome reason映射：too_few_groups/aborted/exhausted/error/media_unstrippable

**状态与持久化**
- 无模块级状态（除了可注入dependencies）
- 尝试状态由调用方（query.ts）维护在ReactiveCompactAttempt中
- hasAttempted防止重复尝试

**触发/压缩/恢复流程**
1. **错误检测**：isWithheldPromptTooLong/isWithheldMediaSizeError
   - 检查message.type === 'assistant' && isApiErrorMessage
   - 检查CLAUDE_REACTIVE_COMPACT环境变量
2. **tryReactiveCompact入口**（query.ts withheld分支调用）
   - 检查hasAttempted/aborted/querySource过滤
   - 执行preCompact hooks
   - 调用reactiveCompactOnPromptTooLong
   - 成功：dependencies.onSuccess() → setLastSummarizedMessageId、runPostCompactCleanup、suppressCompactWarning
   - 合并hook userDisplayMessage
3. **reactiveCompactOnPromptTooLong核心**
   - 检查signal.aborted → aborted
   - 检查groupMessagesByApiRound(messages).length >= 2 → too_few_groups
   - 检查media error且无strippable media → media_unstrippable
   - stripImagesFromMessages()（user消息中的image→"[image]"）
   - 调用compactConversation(skipPreCompactHooks=true)
   - 捕获PTL错误 → exhausted
   - 捕获其他错误 → error
4. **调用方处理**：
   - 成功：用压缩后的历史重试
   - 失败：继续处理原始withheld错误

**取消与失败**
- 用户ESC：检查signal.aborted → reason=aborted
- 压缩API PTL：truncateHeadForPTLRetry()在compactConversation内部处理
- 无重试机制（单次尝试）
- hasAttempted防止重复尝试

**设计取舍与备选**
- 取：先strip images再压缩 → 避免压缩本身因图片PTL
- 取：skipPreCompactHooks=true → tryReactiveCompact已执行过
- 舍：无渐进式策略（如先strip tool results）→ 改进建议见第9章
- 备选：多次重试不同策略 → 当前单次

**源码证据**
- src/services/compact/reactiveCompact.ts:68-186 (所有入口)
- src/services/compact/reactiveCompact.ts:102-132 (tryReactiveCompact)
- src/services/compact/reactiveCompact.ts:134-186 (reactiveCompactOnPromptTooLong)
- tests/reactiveCompact.test.ts:49-168 (完整测试覆盖)

---

#### 4.2.4 Context Collapse 模块

**真实入口签名与关键类型**
```typescript
// 公共入口
export function isContextCollapseEnabled(): boolean
export function initContextCollapse(
  overrides: Partial<ContextCollapseDependencies> = {}
): void
export function resetContextCollapse(): void
export function getStats(): ContextCollapseStats
export function subscribe(listener: () => void): () => void
export async function applyCollapsesIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  querySource: QuerySource
): Promise<{ messages: Message[] }>
export function isWithheldPromptTooLong(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent,
  isPromptTooLongMessage: (message: AssistantMessage) => boolean,
  querySource: QuerySource
): boolean
export function recoverFromOverflow(
  messages: Message[],
  querySource: QuerySource
): { messages: Message[]; committed: number }

// 依赖注入（测试用）
export type ContextCollapseDependencies = {
  tokenCount(messages: Message[]): number
  contextWindow(model: string): number
  summarize(messages: Message[], context: ToolUseContext): Promise<string>
  recordCommit(commit: {...}): Promise<void>
  recordSnapshot(snapshot: {...}): Promise<void>
}

// 状态（模块级全局）
let generation: number
let activeSpawn: Promise<void> | undefined
const collapseStore: {
  committed: Array<{
    collapseId: string
    summaryUuid: string
    summaryContent: string
    summary: string
    firstArchivedUuid: string
    lastArchivedUuid: string
    summaryMessage: UserMessage
    archived: Message[]
  }>
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
    messages: Message[]
  }>
  nextId: number
  armed: boolean
  lastSpawnTokens: number
  health: {
    totalSpawns: number
    totalErrors: number
    totalEmptySpawns: number
    emptySpawnWarningEmitted: boolean
    lastError?: string
  }
}
```

**输入输出**
- 输入：消息列表、toolUseContext、querySource
- 输出：projectView后的消息列表
- recoverFromOverflow输出：{messages: projected, committed: number}

**状态与持久化**
- 模块级全局状态：collapseStore、generation、activeSpawn
- 持久化到sessionStorage：
  - ContextCollapseCommitEntry（每个commit）
  - ContextCollapseSnapshotEntry（staged状态快照）
- 恢复：restoreFromEntries(commits, snapshot)
- generation计数器防止过期spawn提交

**触发/压缩/恢复流程**
1. **applyCollapsesIfNeeded主流程**（每轮query开始调用）
   - 检查enabled和querySource（禁用marble_origami/compact/session_memory）
   - projectView应用已committed collapses
   - 计算token ratio = tokens / effectiveContextWindow
   - 决策：
     - ratio < 0.9 → 返回projected
     - ratio >= 0.9但lastSpawnTokens后增长<5k → 返回
     - ratio >= 0.9且有activeSpawn：
       - ratio >= 0.95 → await activeSpawn
       - 否则直接返回
     - ratio >= 0.9无activeSpawn → selectCollapseSpan → startSpawn
       - ratio >= 0.95 → await spawn后返回
       - 否则立即返回projected
2. **startSpawn后台摘要**
   - increment generation，设置armed=true
   - 异步调用summarize()（runForkedAgent marble_origami）
   - generation检查：中间reset则丢弃结果
   - summary为空：记录health.totalEmptySpawns，不commit
   - 否则：commitStaged()
     - 生成collapseId（数字递增，pad16位）
     - 创建summary message（meta user，<collapsed id="...">...</collapsed>）
     - 存入collapseStore.committed
     - recordCommit持久化
     - persistSnapshot持久化staged状态
   - finally：设置armed=false、lastSpawnTokens、persistSnapshot、notifyListeners
3. **recoverFromOverflow紧急恢复**（PTL时调用）
   - commit所有staged collapses（内存同步，持久化异步）
   - 返回projectView后的消息
4. **projectView投影**
   - 遍历消息，对每个committed collapse
   - 找到firstArchivedUuid和lastArchivedUuid之间的消息
   - 替换为summaryMessage

**取消与失败**
- Reset：resetContextCollapse() → generation++，丢弃所有pending结果
- Empty summary：记录health.totalEmptySpawns，不commit
- Generation过期：静默丢弃spawn结果
- Persistence失败：记录health.totalErrors/lastError，内存状态仍有效
- Summarize失败：记录error，不commit

**设计取舍与备选**
- 取：模块级全局状态 → 简单，无需传递；代价：多会话不安全
- 取：generation防过期 → 避免reset后旧spawn提交
- 取：staged + commit分离 → 非阻塞，用户可控何时真正应用
- 取：90% spawn / 95% await → 低干扰 + 紧急保护
- 备选：状态由QueryEngine拥有 → 改进建议见第9章
- 备选：threshold可配置 → 当前硬编码

**源码证据**
- src/services/contextCollapse/index.ts:284-317 (applyCollapsesIfNeeded)
- src/services/contextCollapse/index.ts:228-282 (startSpawn)
- src/services/contextCollapse/index.ts:187-226 (commitStaged)
- src/services/contextCollapse/operations.ts:11-61 (projectView/selectCollapseSpan)
- src/services/contextCollapse/store.ts:36-90 (collapseStore)
- src/services/contextCollapse/persist.ts:12-44 (restoreFromEntries)
- tests/contextCollapse.test.ts:38-194 (完整测试)

**collapse drain与reactive compact的区别**
- collapse drain：主动后台渐进，staged状态不影响当前投影，仅PTL时commit所有
- reactive compact：被动PTL后触发，执行完整压缩替换历史，更彻底但更 disruptive
- 互斥：collapse启用时autocompact禁用，两者不同时用

---

#### 4.2.5 Partial Compact & Preserved Segments 模块

**真实入口签名与关键类型**
```typescript
// 公共入口
export async function partialCompactConversation(
  allMessages: Message[],
  pivotIndex: number,
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  userFeedback?: string,
  direction: PartialCompactDirection = 'from' // 'from'=保留前缀, 'up_to'=保留后缀
): Promise<CompactionResult>

// 辅助函数
export function annotateBoundaryWithPreservedSegment(
  boundary: SystemCompactBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: readonly Message[] | undefined
): SystemCompactBoundaryMessage

// CompactionResult中的preserved segment元数据
interface CompactMetadata {
  preservedSegment?: {
    headUuid: string
    anchorUuid: string // 'from'方向=boundary uuid, 'up_to'方向=last summary uuid
    tailUuid: string
  }
  preCompactDiscoveredTools?: string[]
  // ... 其他字段
}
```

**输入输出**
- 输入：完整消息列表、pivotIndex、direction、userFeedback
- 输出：CompactionResult（boundary带preservedSegment元数据）
- direction='from'：summarize [pivotIndex..end)，keep [0..pivotIndex)
- direction='up_to'：summarize [0..pivotIndex)，keep [pivotIndex..end)

**状态与持久化**
- 无模块级状态
- Preserved segment元数据存储在compact boundary的compactMetadata中
- Session存储时，preserved消息的parentUuid保持原样
- 恢复时：loader使用anchorUuid修复消息chain

**触发/压缩/恢复流程**
1. **消息分割**
   - 'from'：messagesToSummarize = [pivotIndex..end), messagesToKeep = [0..pivotIndex)（保留progress）
   - 'up_to'：messagesToSummarize = [0..pivotIndex), messagesToKeep = [pivotIndex..end)（过滤progress/old boundaries/summaries）
2. **摘要生成**
   - getPartialCompactPrompt(customInstructions, direction)
   - streamCompactSummary（支持cache sharing，fallback到直接stream）
   - PTL时truncateHeadForPTLRetry（最多3次）
3. **附件重建**
   - createPostCompactFileAttachments：跳过messagesToKeep中已存在的Read结果
   - getDeferredToolsDeltaAttachment：diff against messagesToKeep
   - getAgentListingDeltaAttachment：diff against messagesToKeep
   - getMcpInstructionsDeltaAttachment：diff against messagesToKeep
4. **Boundary注解**
   - 'from'：anchorUuid = boundary.uuid（preserved prefix在前）
   - 'up_to'：anchorUuid = last summary uuid（preserved suffix在后）
   - annotateBoundaryWithPreservedSegment(boundary, anchorUuid, messagesToKeep)
     - headUuid = messagesToKeep[0].uuid
     - tailUuid = messagesToKeep[-1].uuid
5. **Post-compact消息构建**
   - [boundaryMarker, ...summaryMessages, ...messagesToKeep, ...attachments, ...hookResults]

**取消与失败**
- 用户ESC：APIUserAbortError向上传播
- PTL：truncateHeadForPTLRetry()，最多3次
- 无summary：抛出错误
- 完整保留：messagesToKeep原样返回

**设计取舍与备选**
- 取：preserved segment的parentUuid不变 + anchor注解 → 避免重新分配UUID
- 取：'from'保留old boundaries/summaries → backward scan仍能找到
- 取：'up_to'过滤old boundaries/summaries → stale boundary不会干扰新summary
- 舍：messagesToKeep中的Read结果跳过重建 → 节省token
- 备选：双向保留 → 当前仅单向

**源码证据**
- src/services/compact/compact.ts:779-1132 (partialCompactConversation)
- src/services/compact/compact.ts:349-366 (annotateBoundaryWithPreservedSegment)
- src/services/compact/compact.ts:1422-1471 (createPostCompactFileAttachments with preserved messages)

---

#### 4.2.6 压缩机制选择顺序

```
1. MicroCompact（每轮query前，最轻量）
   ├─ Time-based MC（长gap时清空旧工具结果）
   └─ Cached MC（cache edits API删除工具结果，保留缓存）

2. Context Collapse（每轮query开始，非阻塞渐进）
   ├─ 90% token：后台spawn summarizer，不阻塞
   ├─ 95% token：await spawn完成
   └─ PTL时：recoverFromOverflow drain all staged

3. AutoCompact（每轮query结束，proactive完整压缩）
   ├─ Token >= effectiveWindow - 13k
   ├─ 先尝试session memory compact
   └─ 调用compactConversation()

4. ReactiveCompact（PTL时，最后逃生门）
   ├─ strip images
   └─ 调用compactConversation()

5. Manual Compact（用户触发/[compact]命令）
   ├─ full compact
   └─ partial compact（prefix/suffix保留）
```

**互斥关系**
- Context Collapse启用时 → AutoCompact禁用（shouldAutoCompact返回false）
- Reactive-only模式（tengu_cobalt_raccoon）→ AutoCompact禁用
- MicroCompact与其他兼容（仅清理工具结果，不改变历史结构）

**Feature-Disabled分支**
```typescript
// Build-time gates（dead code elimination）
feature('CACHED_MICROCOMPACT')
feature('CONTEXT_COLLAPSE')
feature('REACTIVE_COMPACT')
feature('PROMPT_CACHE_BREAK_DETECTION')
feature('KAIROS')

// Runtime gates
tengu_cobalt_raccoon（reactive-only）
tengu_compact_cache_prefix（prompt cache sharing）
tengu_compact_streaming_retry（streaming retry）

// Environment variables
CLAUDE_CONTEXT_COLLAPSE（默认true）
CLAUDE_REACTIVE_COMPACT（默认true）
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
CLAUDE_CODE_AUTO_COMPACT_WINDOW
CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
DISABLE_COMPACT（禁用所有）
DISABLE_AUTO_COMPACT（仅禁用autocompact）

// User config
autoCompactEnabled（全局配置）
```

**Compact Boundary Flush与DAG Relink**
- **Compact boundary flush**：QueryEngine收到boundary时，裁剪mutableMessages数组，仅保留boundary后的内容
- **DAG relink**：preserved segment的parentUuid保持原样，通过boundary的preservedSegment元数据中的anchorUuid重建chain
  - 加载时：preserved[0].parentUuid → anchorUuid（boundary或summary）
  - 锚点选择：'from'方向用boundary，'up_to'方向用last summary

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `compact.ts` | 无（纯函数+注入依赖） | `compactConversation()`/`partialCompactConversation()`、`stripImagesFromMessages()`、`truncateHeadForPTLRetry()`、附件重建 | 触发决策、历史管理、持久化 | 输入messages，返回`CompactionResult`；调用`runForkedAgent()`或直接`queryModelWithStreaming()` |
| `autoCompact.ts` | `dependencies`（可注入）、阈值配置 | `shouldAutoCompact()`、`autoCompactIfNeeded()`、阈值计算、circuit breaker | 实际压缩执行、PTL恢复 | 调用`compactConversation()`或`trySessionMemoryCompaction()`；返回`wasCompacted`标志 |
| `microCompact.ts` | `cachedMCState`（模块级）、`pendingCacheEdits`（模块级） | `microcompactMessages()`、cached MC路径、time-based MC路径、`consumePendingCacheEdits()`、`resetMicrocompactState()` | 完整对话摘要、溢出恢复 | 返回`MicrocompactResult`（可能包含pending cache edits供API层使用） |
| `reactiveCompact.ts` | `dependencies`（可注入） | `isWithheldPromptTooLong()`、`isWithheldMediaSizeError()`、`tryReactiveCompact()`、`reactiveCompactOnPromptTooLong()` | 预防式压缩、token阈值管理 | 调用`compactConversation()`；与query.ts的withheld错误分支集成 |
| `contextCollapse/index.ts` | `dependencies`（可注入）、`generation`（模块级）、`activeSpawn`（模块级） | `applyCollapsesIfNeeded()`、`recoverFromOverflow()`、`initContextCollapse()`、`resetContextCollapse()`、`isContextCollapseEnabled()`、后台spawn、staging、commit | 完整历史压缩、工具清理、PTL恢复 | 调用`summarize()`依赖（默认用`runForkedAgent()`）；返回projected messages |
| `contextCollapse/store.ts` | `collapseStore`（模块级全局） | `getCollapseStats()`、`resetCollapseStore()`、`subscribeToCollapses()`、`notifyCollapseListeners()` | 投影、span选择、持久化 | 被index.ts和operations.ts导入使用 |
| `contextCollapse/operations.ts` | 无（纯函数） | `projectView()`、`selectCollapseSpan()`、`findMessageSpan()` | 状态管理、持久化、summarization | 输入messages + collapseStore，返回projected messages/span |
| `contextCollapse/persist.ts` | 无 | `restoreFromEntries()` | summarization、投影、状态管理 | 从session storage entries重建collapseStore |

### 4.3 主控制流

#### Proactive Auto-Compact 流
```
query.ts 主循环每轮结束
  ↓
shouldAutoCompact(messages, model, querySource, snipTokensFreed)
  ├─ 检查DISABLE_COMPACT/DISABLE_AUTO_COMPACT/用户配置
  ├─ 检查querySource过滤（session_memory/compact/marble_origami禁用）
  ├─ 检查feature gates（tengu_cobalt_raccoon/reactive-only或CONTEXT_COLLAPSE启用时禁用）
  ├─ 计算token count - snipTokensFreed
  └─ 对比阈值（effectiveContextWindow - 13,000 = AUTOCOMPACT_BUFFER_TOKENS）
  ↓ (返回true)
autoCompactIfNeeded(..., tracking, ...)
  ├─ 检查circuit breaker (consecutiveFailures >= 3)
  ├─ 先尝试trySessionMemoryCompaction()（实验性）
  │   └─ 成功→直接返回，跳过legacy compact
  └─ 调用compactConversation(..., isAutoCompact=true, ...)
      ├─ 执行preCompact hooks
      ├─ stripImagesFromMessages() / stripReinjectedAttachments()
      ├─ streamCompactSummary()
      │   ├─ 优先尝试cached prefix共享（runForkedAgent）
      │   ├─ 失败fallback到直接streaming
      │   └─ PTL时truncateHeadForPTLRetry()（最多3次）
      ├─ 清空readFileState/loadedNestedMemoryPaths
      ├─ 并行重建附件：最近文件、plan、invoked skills、工具delta、agent状态
      ├─ 执行sessionStart hooks
      ├─ 标记post-compaction（notifyCompaction/markPostCompaction）
      ├─ 写入KAIROS transcript segment（若启用）
      ├─ 执行postCompact hooks
      └─ 返回CompactionResult
  ↓
runPostCompactCleanup(querySource)
setLastSummarizedMessageId(undefined)
  ↓
query.ts: 收到CompactionResult，buildPostCompactMessages()替换历史
  ↓
QueryEngine: 收到compact boundary，裁剪mutableMessages数组
```

#### Context Collapse 流
```
每轮query开始
  ↓
applyCollapsesIfNeeded(messages, toolUseContext, querySource)
  ├─ 检查isContextCollapseEnabled()和querySource过滤
  ├─ 先projectView()应用已committed collapses
  ├─ 检查token比例：
  │   ├─ <90% → 直接返回projected messages
  │   ├─ ≥90%但<95%且有activeSpawn → 不等，返回当前projection
  │   ├─ ≥95%且有activeSpawn → await activeSpawn，返回新projection
  │   └─ ≥90%无activeSpawn → 启动新spawn
  ├─ selectCollapseSpan(messages)
  │   ├─ 需要至少6条消息
  │   └─ 避免切断tool_use→tool_result对
  ├─ startSpawn(span, context, tokens, risk=ratio)
  │   ├─ increment generation计数器
  │   ├─ set armed=true
  │   ├─ 异步调用summarize()（默认用runForkedAgent marble_origami）
  │   ├─ 若generation变化（中间有reset），丢弃结果
  │   ├─ 若summary为空，记录totalEmptySpawns，不commit
  │   ├─ 否则commitStaged()
  │   │   ├─ 生成collapseId（数字递增，pad到16位）
  │   │   ├─ 创建summary message（meta user message，内容<collapsed id="...">...</collapsed>）
  │   │   ├─ 存入collapseStore.committed
  │   │   ├─ 从staged中移除
  │   │   ├─ 调用recordCommit()持久化
  │   │   └─ persistSnapshot()
  │   └─ finally: set armed=false, lastSpawnTokens=tokens, persistSnapshot(), notify listeners
  └─ 若≥95%，await spawn完成再返回；否则立即返回当前projection
  ↓
（后续轮次继续累积）
  ↓
若真正遇到prompt too long错误
  ↓
recoverFromOverflow(messages, querySource)
  ├─ 检查启用状态和querySource
  ├─ 对所有staged collapse执行commitStaged()（同步内存状态，异步持久化）
  └─ 返回projectView(messages) + committed计数
```

#### Reactive Compact 恢复流
```
query.ts 收到assistant message
  ↓
isWithheldPromptTooLong(message) 或 isWithheldMediaSizeError(message)
  ↓ (true)
tryReactiveCompact(attempt)
  ├─ 检查hasAttempted/aborted/querySource过滤
  ├─ 执行preCompact hooks
  └─ 调用reactiveCompactOnPromptTooLong()
      ├─ 检查aborted
      ├─ 检查至少2个API-round groups
      ├─ 检查media error时是否有strippable media
      ├─ stripImagesFromMessages()
      ├─ 调用compactConversation(..., skipPreCompactHooks=true)
      └─ 映射失败原因：too_few_groups/aborted/exhausted/error/media_unstrippable
  ↓ (成功)
dependencies.onSuccess(querySource):
  - setLastSummarizedMessageId(undefined)
  - runPostCompactCleanup(querySource)
  - suppressCompactWarning()
  ↓
合并hook userDisplayMessage，返回结果
  ↓
query.ts: 用压缩后的历史重试
```

#### Microcompact 流
```
query.ts 发送请求前
  ↓
microcompactMessages(messages, toolUseContext, querySource)
  ├─ clearCompactWarningSuppression()
  ├─ 先尝试time-based MC
  │   ├─ evaluateTimeBasedTrigger()
  │   │   ├─ 检查enabled和主thread source
  │   │   ├─ 找last assistant message
  │   │   └─ 计算gapMinutes > threshold
  │   ├─ collectCompactableToolIds()（仅特定工具：Read/shell/grep/glob/web/search/fetch/Edit/Write）
  │   ├─ 保留最近N个（keepRecent），清空其余
  │   ├─ 直接修改message content为"[Old tool result content cleared]"
  │   ├─ log tengu_time_based_microcompact
  │   ├─ resetMicrocompactState()（因缓存已无效）
  │   └─ notifyCacheDeletion()
  │   └─ 返回修改后的messages
  ├─ 若time-based未触发，尝试cached MC
  │   ├─ 检查feature('CACHED_MICROCOMPACT')、配置enabled、模型支持、主thread source
  │   ├─ collectCompactableToolIds()
  │   ├─ registerToolResult()/registerToolMessage()到cachedMCState
  │   ├─ getToolResultsToDelete()（根据triggerThreshold和keepRecent）
  │   ├─ 若有要删除：
  │   │   ├─ createCacheEditsBlock()
  │   │   ├─ 设置pendingCacheEdits（供API层使用）
  │   │   ├─ log tengu_cached_microcompact
  │   │   ├─ suppressCompactWarning()
  │   │   └─ notifyCacheDeletion()
  │   └─ 返回原messages（cache edits在API层应用）
  └─ 否则返回原messages
  ↓
API层: consumePendingCacheEdits()获取cache edits并附加到请求
```

### 4.4 数据结构与持久化

#### Context Collapse Store
```typescript
const collapseStore = {
  committed: Array<{
    collapseId: string // 16位数字字符串，如"0000000000000001"
    summaryUuid: string
    summaryContent: string // "<collapsed id=\"...\">...</collapsed>"
    summary: string
    firstArchivedUuid: string
    lastArchivedUuid: string
    summaryMessage: UserMessage
    archived: Message[] // 仅在内存中重建，不持久化
  }>
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
    messages: Message[]
  }>
  nextId: number
  armed: boolean
  lastSpawnTokens: number
  health: {
    totalSpawns: number
    totalErrors: number
    totalEmptySpawns: number
    emptySpawnWarningEmitted: boolean
    lastError?: string
  }
}

// 持久化entry类型（session storage）
type ContextCollapseCommitEntry = {
  type: 'marble-origami-commit'
  sessionId: string
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}

type ContextCollapseSnapshotEntry = {
  type: 'marble-origami-snapshot'
  sessionId: string
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}

// restoreFromEntries(commits, snapshot)重建状态
```

#### Cached Microcompact State
```typescript
interface CachedMCState {
  toolOrder: string[] // tool_use ID按注册顺序
  toolMessageMap: Map<number, string[]> // message index → tool IDs
  deletedRefs: Set<string>
  pinnedEdits: Array<{ userMessageIndex: number; block: CacheEditsBlock }>
}

interface CacheEditsBlock {
  type: 'cache_edits'
  cache_edits: Array<{
    type: 'tool_result_delete'
    tool_use_id: string
  }>
}

// pendingCacheEdits: 单次请求的临时状态，消费后清空
// pinnedEdits: 跨请求持久化，用于cache hits时重发
```

#### Compaction Result
```typescript
interface CompactionResult {
  boundaryMarker: SystemMessage // compact boundary
  summaryMessages: UserMessage[] // 摘要消息
  attachments: AttachmentMessage[] // post-compact附件
  hookResults: HookResultMessage[] // sessionStart hooks结果
  messagesToKeep?: Message[] // partial compact保留的段
  userDisplayMessage?: string
  preCompactTokenCount?: number
  postCompactTokenCount?: number // compact API调用的总token
  truePostCompactTokenCount?: number // 结果上下文的估算token
  compactionUsage?: ReturnType<typeof getTokenUsage>
}
```

#### Preserved Segment Metadata
```typescript
// compact boundary上的元数据，用于恢复parent UUID链
interface CompactMetadata {
  preservedSegment?: {
    headUuid: string
    anchorUuid: string // boundary本身或最后一个summary，取决于partial方向
    tailUuid: string
  }
  preCompactDiscoveredTools?: string[]
  // ... 其他字段
}
```

### 4.5 跨子系统依赖

- **query-core spec**: 解释query.ts和QueryEngine如何调用压缩、compact boundary处理、withheld错误恢复
- **sdk-query-sessions spec**: 解释session storage持久化、恢复时UUID链重建
- **permissions spec**: 压缩时调用preCompact/postCompact hooks可能涉及权限
- **analytics spec**: `tengu_compact`/`tengu_cached_microcompact`/`tengu_time_based_microcompact`/`tengu_compact_ptl_retry`等事件
- **prompt-cache-break-detection spec**: `notifyCompaction()`/`notifyCacheDeletion()`调用

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 压缩API prompt too long | compact.ts streamCompactSummary循环 | 捕获，内部truncate重试 | 最多3次 (MAX_PTL_RETRIES) | 无特殊清理，重试时用truncated messages | 3次后抛出ERROR_MESSAGE_PROMPT_TOO_LONG |
| 压缩API其他错误 | compact.ts streamCompactSummary | 直接抛出 | 若启用tengu_compact_streaming_retry，最多2次 | 无 | 抛出异常；autocompact会记录consecutiveFailure |
| 用户abort压缩 | compact.ts检查signal.aborted | 抛出APIUserAbortError | 否 | 无 | 异常向上传播；autocompact不计入consecutiveFailure |
| summarizer返回空摘要 | contextCollapse index.ts startSpawn | 内部记录health.totalEmptySpawns/lastError | 否 | 不commit，丢弃结果 | projectView()不包含该collapse，无可见变化 |
| context collapse spawn generation过期 | contextCollapse index.ts startSpawn finally检查currentGeneration===generation | 静默丢弃结果 | 否 | 无 | 无可见变化 |
| reactive compact media_unstrippable | reactiveCompact.ts检查containsStrippableMedia | 返回outcome.ok=false, reason=media_unstrippable | 否 | 无 | 调用方继续处理withheld错误 |
| reactive compact too_few_groups | reactiveCompact.ts检查groupMessagesByApiRound(messages).length>=2 | 返回outcome.ok=false, reason=too_few_groups | 否 | 无 | 调用方继续处理withheld错误 |
| reactive compact exhausted | reactiveCompact.ts捕获compact的PTL错误 | 返回outcome.ok=false, reason=exhausted | 否 | 无 | 调用方继续处理withheld错误 |
| autocompact circuit breaker触发 | autoCompact.ts检查consecutiveFailures>=3 | 静默跳过 | 否（直到成功重置计数） | 无 | 返回wasCompacted=false，不尝试 |

### 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|---|
| context collapse状态位置 | 模块级全局变量 | 多会话/多agent环境下可能污染；需要generation防过期 | 简单，无需传递状态；恢复时可全局restoreFromEntries() |
| cached MC状态位置 | 模块级全局变量 | 非主线程调用需禁用；仅主会话有效 | API层无需传递状态 |
| post-compact附件预算限制 | POST_COMPACT_MAX_FILES_TO_RESTORE=5, POST_COMPACT_TOKEN_BUDGET=50,000, POST_COMPACT_MAX_TOKENS_PER_FILE=5,000, POST_COMPACT_MAX_TOKENS_PER_SKILL=5,000, POST_COMPACT_SKILLS_TOKEN_BUDGET=25,000 | 可能丢失一些有用上下文 | 避免压缩后立即再次触发压缩 |
| autocompact阈值 | effectiveContextWindow - 13,000 (AUTOCOMPACT_BUFFER_TOKENS) | 可能过早压缩，或太接近边界 | 预留buffer给system prompt/tools/user context，避免压缩后立即溢出 |
| reactive-only模式 | tengu_cobalt_raccoon gate禁用proactive autocompact | 用户可能更早遇到PTL | 减少不必要的压缩延迟，依赖reactive恢复 |
| time-based MC gap阈值 | 可配置，默认一段时间 | 时间gap不一定表示缓存过期 | 避免长时间会话后发送大量旧工具结果 |

## 6. 现状验收标准

1. **给定**对话历史token超过effectiveContextWindow - 13,000，**当**调用autoCompactIfNeeded()，**必须**触发compactConversation()，**并且**返回的CompactionResult包含boundaryMarker和summaryMessages，**不得**在无失败时连续3次以上跳过（circuit breaker）
2. **给定**对话历史token≥90% context window，**当**调用applyCollapsesIfNeeded()，**必须**启动后台summarizer spawn，**并且**在token≥95%时await其完成，**不得**在querySource=marble_origami时执行
3. **给定**有staged collapse，**当**调用recoverFromOverflow()，**必须**commit所有staged collapses，**并且**返回projectView()后的messages
4. **给定**对话包含tool_use→tool_result对，**当**调用selectCollapseSpan()，**必须**不切断该配对，**并且**至少保留最后5条消息
5. **给定**返回了assistant error message="Prompt is too long"，**当**调用isWithheldPromptTooLong(message)，**必须**返回true，**并且**tryReactiveCompact()尝试strip images和压缩
6. **给定**上次assistant message时间gap超过阈值，**当**调用microcompactMessages()，**必须**执行time-based MC清空旧工具结果，**并且**resetMicrocompactState()
7. **给定**partialCompactConversation(direction='from')，**当**生成结果，**必须**annotateBoundaryWithPreservedSegment()，anchorUuid为boundary的uuid

## 7. 代码与测试证据

### 核心模块（27个文件）
| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|---|
| compactConversation主流程 | src/services/compact/compact.ts:387-769 | tests/reactiveCompact.test.ts:66-131 (reactiveCompactOnPromptTooLong路径) | 不包含prompt cache sharing的fallback测试 |
| stripImagesFromMessages处理user/tool_result中的图片 | src/services/compact/compact.ts:145-209 | 无直接测试 | 无 |
| PTL重试循环truncate最旧API-round groups | src/services/compact/compact.ts:243-291, 457-498 | 无直接测试 | 仅验证truncate逻辑，未验证端到端重试 |
| post-compact附件重建 | src/services/compact/compact.ts:526-602 | 无直接测试 | 不包含skill truncation的端到端验证 |
| partialCompact支持前缀/后缀保留 | src/services/compact/compact.ts:779-1132 | 无直接测试 | 不包含preserved segment UUID链验证 |
| autocompact阈值计算与circuit breaker | src/services/compact/autoCompact.ts:72-91, 260-265 | 无直接测试 | 不包含tracking state的集成测试 |
| shouldAutoCompact多条件过滤 | src/services/compact/autoCompact.ts:160-238 | 无直接测试 | 不包含query-source=marble_origami的集成测试 |
| microcompact两条路径选择 | src/services/compact/microCompact.ts:257-296 | 无直接测试 | 不包含cached MC的端到端API测试 |
| time-based MC条件与内容清空 | src/services/compact/microCompact.ts:426-533 | 无直接测试 | 不包含实际timestamp gap测试 |
| cached MC注册与删除决策 | src/services/compact/microCompact.ts:308-404 | 无直接测试 | 不包含API层cache edits集成 |
| reactiveCompact错误检测与恢复映射 | src/services/compact/reactiveCompact.ts:68-186 | tests/reactiveCompact.test.ts:49-168 (isWithheld检测、media stripping、outcome映射) | 不包含与query.ts withheld分支的集成测试 |
| applyCollapsesIfNeeded 90%/95%阈值行为 | src/services/contextCollapse/index.ts:284-317 | tests/contextCollapse.test.ts:38-91 (blocking/non-blocking行为) | 不包含真实API summarization |
| startSpawn generation防过期 | src/services/contextCollapse/index.ts:228-282 | tests/contextCollapse.test.ts:38-91 (generation计数器未直接验证) | 不包含并发reset测试 |
| commitStaged同步内存+异步持久化 | src/services/contextCollapse/index.ts:187-226 | tests/contextCollapse.test.ts:120-168 (持久化+恢复) | 不包含持久化失败的降级处理 |
| projectView应用committed collapses | src/services/contextCollapse/operations.ts:11-29 | tests/contextCollapse.test.ts:120-168 (恢复后projection) | 不包含summary message已存在时的幂等性 |
| selectCollapseSpan不切断tool-use/result | src/services/contextCollapse/operations.ts:44-61 | tests/contextCollapse.test.ts:170-185 (tool-use/result配对边界) | 不包含多对嵌套场景 |
| restoreFromEntries重建状态 | src/services/contextCollapse/persist.ts:12-44 | tests/contextCollapse.test.ts:120-168 (恢复路径) | 不包含部分entries损坏场景 |
| collapseStore状态结构 | src/services/contextCollapse/store.ts:36-90 | tests/contextCollapse.test.ts:38-91 (stats验证) | 无 |
| cachedMicrocompact工具注册/删除 | src/services/compact/cachedMicrocompact.ts | 无直接测试 | 不包含API集成 |
| cachedMCConfig配置获取 | src/services/compact/cachedMCConfig.ts | 无直接测试 | 不包含GrowthBook集成 |
| timeBasedMCConfig配置获取 | src/services/compact/timeBasedMCConfig.ts | 无直接测试 | 不包含GrowthBook集成 |
| sessionMemoryCompact路径 | src/services/compact/sessionMemoryCompact.ts | 无直接测试 | 不包含端到端session memory集成 |
| prompt构建 | src/services/compact/prompt.ts | 无直接测试 | 不包含摘要质量验证 |
| grouping API-round分组 | src/services/compact/grouping.ts | 无直接测试 | 不包含边界case验证 |
| compactWarningState警告抑制 | src/services/compact/compactWarningState.ts | 无直接测试 | 不包含UI集成 |
| postCompactCleanup清理 | src/services/compact/postCompactCleanup.ts | 无直接测试 | 不包含清理后的状态验证 |

### 测试场景
| 测试文件 | 测试场景 | 证明的不变量 |
|---|---|---|---|
| tests/contextCollapse.test.ts:38-91 | commit summary above blocking threshold, idempotent | collapseStore.collapsedSpans计数正确；summarize仅调用1次；recordCommit/recordSnapshot被调用 |
| tests/contextCollapse.test.ts:66-91 | non-blocking spawn at 90%, project after completion | 初始调用返回原长度；summary完成后第二次调用返回压缩后长度 |
| tests/contextCollapse.test.ts:93-105 | track empty summaries without committing placeholder | totalEmptySpawns增加；collapsedSpans不变；lastError记录"empty summary" |
| tests/contextCollapse.test.ts:107-118 | withhold prompt-too-long only outside summarizer itself | isWithheldPromptTooLong对marble_origami源返回false |
| tests/contextCollapse.test.ts:120-168 | restore commits and drain staged snapshot on overflow | restoreFromEntries正确重建状态；recoverFromOverflow commit staged；projectView正确应用 |
| tests/contextCollapse.test.ts:170-185 | not split tool-use/result at span boundary | selectCollapseSpan选择的边界不在tool-use/result之间 |
| tests/contextCollapse.test.ts:187-194 | notify subscribers and reset all state | subscribe监听到通知；reset后stats归零 |
| tests/reactiveCompact.test.ts:49-61 | detect PTL and media-size errors with runtime kill switch | isWithheldPromptTooLong/isWithheldMediaSizeError正确检测；CLAUDE_REACTIVE_COMPACT=0禁用 |
| tests/reactiveCompact.test.ts:66-87 | strip media and call shared compactor without duplicate PreCompact | reactiveCompactOnPromptTooLong正确strip media；调用compact时skipPreCompactHooks=true |
| tests/reactiveCompact.test.ts:89-108 | map too-few-groups/abort/exhausted outcomes | outcome reason正确映射 |
| tests/reactiveCompact.test.ts:133-168 | merge hook messages and perform success cleanup once | tryReactiveCompact合并hook userDisplayMessage；仅调用1次onSuccess；hasAttempted=true时不重试 |

### 证据边界
- 所有测试均使用mock依赖（summarize/recordCommit/recordSnapshot/compact等），无真实API调用
- 无长会话压力测试
- 无并发/多agent测试
- 无持久化损坏恢复测试
- 无端到端query.ts集成测试（仅单元测试）

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/context-compaction.yaml)

### Coverage分组概览

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|---|---|---|---|
| compact-core | compactConversation/partialCompactConversation/streamCompactSummary/prompt构建/附件重建 | tests/reactiveCompact.test.ts (间接使用) | src/query.ts (由query-core拥有) |
| auto-compact | shouldAutoCompact/autoCompactIfNeeded/阈值计算/circuit breaker | 无直接测试 | src/QueryEngine.ts (由query-core拥有) |
| micro-compact | microcompactMessages/cachedMicrocompact/timeBasedMC/工具注册与删除 | 无直接测试 | src/utils/tokens.ts (通用token统计) |
| reactive-compact | reactiveCompactOnPromptTooLong/tryReactiveCompact/错误检测 | tests/reactiveCompact.test.ts | src/query.ts的withheld分支 (由query-core拥有) |
| context-collapse | applyCollapsesIfNeeded/recoverFromOverflow/project/commit/store/persist | tests/contextCollapse.test.ts | src/utils/sessionStorage.ts (通用持久化) |
| session-memory-compact | trySessionMemoryCompaction | 无直接测试 | src/services/SessionMemory/ (由其他spec拥有) |
| compact-test | 压缩相关专门测试 | tests/contextCollapse.test.ts, tests/reactiveCompact.test.ts | 其他测试文件 |

### 相关子系统
- **query-core spec**: 压缩入口调用、compact boundary处理、withheld错误恢复
- **sdk-query-sessions spec**: 持久化、恢复时UUID链重建
- **analytics spec**: 压缩事件记录
- **prompt-cache-break-detection spec**: 缓存删除通知

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|---|
| P0 | context collapse使用模块级全局状态，多会话/多agent环境下不安全；src/services/contextCollapse/index.ts的generation防过期机制脆弱 | 将collapseStore改为由QueryEngine或SessionContext拥有，而非模块级全局 | 中-高：需修改所有使用点；恢复路径需传递状态 | 编写多会话并发测试验证状态隔离 | M | 已证实（代码结构明显） |
| P0 | microcompact使用模块级全局cachedMCState，非主线程被禁用；src/services/compact/microCompact.ts:257-296检查isMainThreadSource | 将cachedMCState绑定到QueryEngine或会话上下文 | 中：需修改API层消费pendingCacheEdits的方式 | 编写子agent调用microcompact不污染主状态的测试 | M | 已证实（代码结构明显） |
| P1 | autocompact circuit breaker仅在连续失败时触发，无reset机制除了成功；src/services/compact/autoCompact.ts:260-265, 341-349 | 增加时间衰减：若最后一次失败很久以前，允许重试；或在用户手动压缩成功后重置 | 低：仅修改计数逻辑 | 测试circuit breaker在时间窗口后或手动压缩后重置 | S | 已证实（代码逻辑） |
| P1 | reactive compact仅strip images，不尝试其他渐进式策略（如先strip tool results、先snip等）；src/services/compact/reactiveCompact.ts:157-170 | 构建渐进式恢复阶梯：先strip media → 再strip旧tool results → 再snip → 最后full compact | 中：需协调多种策略，避免无限循环 | 测试不同PTL场景下各策略依次尝试 | M | 已证实（当前代码路径简单） |
| P1 | time-based MC直接修改message content为静态字符串，与cached MC路径不一致；src/services/compact/microCompact.ts:479-496 | time-based MC也使用cache_edits API（若模型支持），或保持统一content-clear但不reset cachedMCState | 低-中：需区分是否仍有有效缓存 | 测试time-based MC在长gap后执行，但缓存仍有效时的行为 | S | 已证实（代码差异明显） |
| P2 | autocompact threshold为固定13k buffer，未考虑模型实际context window大小；src/services/compact/autoCompact.ts:72-77 | 按比例而非固定token，如effectiveWindow的90-92% | 低：仅修改阈值计算 | 测试不同模型context window下阈值合理 | S | 已证实（代码逻辑） |
| P2 | post-compact附件选择策略简单（最近读取），未考虑相关性；src/services/compact/compact.ts:1422-1471 | 使用最近摘要中的file path/skill name来优先恢复相关附件 | 中：需解析摘要内容，可能不稳定 | 测试优先恢复摘要中提到的文件/技能的会话 | M | 设计推断 |
| P2 | compact失败错误信息不友好，尤其是PTL重试耗尽；src/services/compact/compact.ts:293-295 | 提供更具体的错误，说明尝试了什么、为什么失败、用户可做什么（如手动更早压缩） | 低：仅修改错误消息 | 验证错误消息包含足够上下文 | S | 已证实（当前消息简单） |
| P3 | 7种压缩机制的决策日志对用户不透明，调试困难；各模块分散记录 | 提供统一的压缩决策追踪，可选地暴露给SDK/UI | 低：仅新增追踪逻辑，默认关闭 | 验证启用决策追踪时，有足够详细的日志 | S | 设计推断 |

