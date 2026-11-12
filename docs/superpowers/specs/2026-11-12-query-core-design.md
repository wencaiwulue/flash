---
id: query-core
batch: 0
title: Query Core 对话与工具执行设计
date: 2026-11-12
status: draft
---

# Query Core 对话与工具执行设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Query Core 负责处理单轮或多轮对话的完整生命周期：从用户输入到模型响应，再到工具执行、错误处理、历史压缩和会话持久化。其需要解决的核心问题包括：

- **入口与职责边界**：有两条入口路径：
  - SDK 路径：`createSdkQuery()` → `ask()` → `QueryEngine.submitMessage()` → `query()`
  - 直接调用路径：可以直接调用 `ask()` 或直接调用 `query()`
- **用户消息提前持久化**：在模型响应到达前，用户消息必须已经写入 transcript，这样即使进程在等待 API 时被终止，`--resume` 也能找到该消息并继续。
- **失败时的可恢复性**：包括 prompt 过长、模型输出截断、工具执行异常、预算/轮次超限等多种失败场景，需要有明确的恢复路径或错误边界。
- **历史上下文管理**：包括 micro-compact、auto-compact、snip、context collapse 等多种历史压缩策略，它们在不同时机触发，有不同的持久化和恢复语义。
- **多轮对话的状态所有权**：`mutableMessages`、`readFileCache`、`permissionDenials`、`totalUsage` 等状态需要在多轮之间保持，但又要在不同 QueryEngine 实例之间隔离。

约束条件：
- 会话持久化是进程级全局配置，不能每个 query 单独设置；因此需要通过 lease 机制协调多个 query 的持久化需求。
- `QueryEngine` 与 `query()` 分层是因为前者管理跨轮次的状态，后者处理单轮次的模型/工具循环。
- 工具执行可以是流式的（StreamingToolExecutor）或批量的，两种路径需要统一的消息输出格式。

## 2. 设计理由与备选方案

### 2.1 提前持久化用户消息

**当前设计**：用户消息在调用 `query()` 之前就调用 `recordTranscript()` 写入。在非 bare 模式下，这是一个 await 调用；在 bare 模式下，则是 fire-and-forget。

**证据位置**：`src/QueryEngine.ts` 中 `recordTranscript(messages)` 的位置，在 `for await (const message of query(...))` 循环之前。

**为什么这样设计**：如果等到模型响应回来才写入 transcript，用户点击“停止”或进程被意外终止后，`getLastSessionLog()` 会看不到这条用户消息，`--resume` 也就无法恢复到该点。在 CLI/桌面应用场景中，这会造成“我明明发了消息但恢复时不见了”的糟糕体验。

**代价**：在非 bare 模式下，这会增加一次关键路径的磁盘 I/O。

**备选方案**：
- 备选 1：不提前写入，仅在内存中保留。代价是 crash 时不可恢复。
- 备选 2：总是 fire-and-forget。代价是用户立即 `--resume` 可能读到不完整的 transcript。
- 备选 3：写入但不 flush。代价是操作系统 crash 时可能丢失。

**为什么不采用备选**：备选 1 不符合 CLI/桌面应用的可靠性预期；备选 2/3 会造成时序依赖的不可恢复问题，且难以复现和调试。

### 2.2 Assistant 消息 fire-and-forget vs User/Compact await

**当前设计**：assistant 消息写入 transcript 时不 await（fire-and-forget），而 user 消息和 compact boundary 消息写入时需要 await；在 yield 最终 result 前，仅当 `CLAUDE_CODE_EAGER_FLUSH` 或 `CLAUDE_CODE_IS_COWORK` 为真时额外等待 `flushSessionStorage()`。

**证据位置**：`src/QueryEngine.ts` 的消息持久化注释和分支：assistant 调用 `void recordTranscript(messages)`，其他类型调用 `await recordTranscript(messages)`；result 前的 flush 注释明确说明桌面应用会在收到 result 后立即结束 CLI 进程。

**为什么这样设计**：这里不只是“减少等待”。模型流每个 content block 单独产出，最后一个 assistant 消息还会在后续 `message_delta` 中被补上 `usage/stop_reason`。如果每个 block 都等待写盘，就会阻塞 `ask()` generator，使后续 `message_delta` 无法及时被消费。当前写入队列保持顺序，并通过延迟 JSON 序列化让最后一次状态补充进入待写内容；因此 assistant 可以在不阻塞流式消费的情况下保持写入顺序和最终元数据。user/compact 则是需要明确持久化边界的消息，必须等待。

**为什么 result 前还要条件 flush**：源码注释指出桌面应用收到 result 后会立即结束 CLI 进程；在 eager/cowork 模式下不等待剩余写入会丢失这些消息。普通模式没有在这里无条件等待，这是持久性保证与退出延迟之间的取舍。

**代价**：如果进程在 assistant 消息 fire-and-forget 之后但在 flush 之前终止，该消息可能丢失。但这条损失是可接受的：因为用户消息已经提前持久化，恢复时可以从用户消息重新跑；且 assistant 消息是模型生成的，重新生成不会丢失用户输入。

### 2.3 QueryEngine 与 query 分层

**当前设计**：`QueryEngine` 类管理跨轮次的状态（`mutableMessages`、`readFileCache`、`permissionDenials`、`totalUsage` 等），每个 `submitMessage()` 调用一次 `query()` 函数，后者处理单轮次内部的模型-工具循环。

**证据位置**：`src/QueryEngine.ts` 的类注释直接写明“一个 QueryEngine 对应一个 conversation，每次 `submitMessage()` 是同一对话中的新 turn，消息、文件缓存和 usage 跨 turn 保留”。`src/query.ts` 的 `query()` 则接受 `QueryParams`，通过 `queryLoop()` 在一次调用内推进模型/工具迭代。

**为什么这样设计**：跨轮次状态需要在同一对话的多次 `submitMessage()` 之间保留；单次调用内的恢复计数、compact 跟踪和 transition 只服务当前模型/工具循环。`ask()` 因此只需组装配置并转发 `submitMessage()` 的消息，不必另建一套会话状态。

**设计推断**：`query()` 以参数和 `deps` 接收依赖、以 async generator 返回内部消息和 `Terminal`，也使直接调用方能够复用循环并测试恢复分支，而不构造 UI。这里只推断该结构带来的复用价值，不虚构其最初提取时间。

### 2.4 Withheld recoverable errors（可恢复错误不立即 yield）

**当前设计**：`prompt_too_long`、`max_output_tokens`、media size errors 等可恢复错误在生成时被 withhold，不立即 yield 给调用方；只有在尝试恢复失败后才会 yield 出来。

**证据位置**：见 `src/query.ts` 中 `isWithheldPromptTooLong()`、`isWithheldMediaSizeError()`、`isWithheldMaxOutputTokens()` 的判断，以及后续的恢复逻辑（context collapse drain、reactive compact、max tokens 重试）。

**为什么这样设计**：`isWithheldMaxOutputTokens()` 的源码注释给出了直接原因：过早把中间错误 yield 给 cowork/desktop 等 SDK 调用方，会让它们在收到 `error` 字段后终止会话，导致恢复循环虽然还在运行却已没有消费者。对 prompt-too-long 和 media 错误采用相同的延迟暴露边界，是同一恢复原则在其他可恢复错误上的应用。

**代价**：错误发生和最终 yield 之间有延迟；如果恢复过程本身出错，调试链路会更长。

### 2.5 Tombstone 消息

**当前设计**：当发生 streaming fallback（模型降级）时，之前已经 yield 的部分 assistant 消息通过 `tombstone` 消息来标记删除。

**证据位置**：见 `src/query.ts` 中 fallback 分支对 `yield { type: 'tombstone', message }` 的使用。

**为什么这样设计**：降级发生时，已经输出的部分消息（特别是含 thinking 的）对新模型可能无效；但直接使用 `query()` 的 UI/调用方可能已经处理了这些消息。tombstone 提供撤回信号，避免把旧模型的部分输出与新模型结果混成同一次响应。

**不同调用层的处理**：`src/query.ts` 的注释说明 tombstone 用于从 UI 和 transcript 移除孤立消息；`QueryEngine.submitMessage()` 收到 tombstone 时则在 switch 中直接跳过，不把它加入 `mutableMessages`、不持久化，也不经 `normalizeMessage()` 继续向 SDK yield。阅读 SDK 路径时不能把“query 产生 tombstone”误写成“SDK 一定收到 tombstone”。

### 2.6 Error watermark（错误水印）

**当前设计**：`error_during_execution` 返回的 errors 数组，以本轮开始前的最后一条内存错误为界（watermark），只包含本轮新增的错误。

**证据位置**：见 `src/QueryEngine.ts` 中 `const errorLogWatermark = getInMemoryErrors().at(-1)` 和后续 `getInMemoryErrors().slice(start)` 的使用。

**为什么这样设计**：`getInMemoryErrors()` 是进程全局的环形缓冲区。如果不设 watermark，上一轮或无关代码的错误会被误当作本轮失败的原因，造成诊断信息噪声。

### 2.7 流式工具执行（StreamingToolExecutor 可选门控 + runTools 备选）

**当前设计**：工具执行可以是流式的或批量的：
- 当 `config.gates.streamingToolExecution` 启用时：使用 `StreamingToolExecutor`，收到 `tool_use` 后立即开始执行工具，结果完成后立即 yield；abort 时通过 `getRemainingResults()` 获取 synthetic tool_result
- 否则：使用 `runTools()`，等完整 assistant 消息结束后，批量执行所有工具；abort 时通过 `yieldMissingToolResultBlocks()` 获取 synthetic tool_result

**证据位置**：见 `src/query.ts` 中 `useStreamingToolExecution` 的门控判断、`StreamingToolExecutor` 的初始化和使用，以及 fallback 时对 `discard()` 和重建的调用。

**为什么这样设计（设计推断）**：流式路径让长耗时工具的结果更早进入消息流，不必等整批工具结束；非流式路径保留原有的批量执行边界。代码能证明两条路径及其门控存在，但“兼容性”和“便于测试”只是结构收益，不能当作已证实的历史动机。

**代价**：实现更复杂，需要处理部分执行后 abort 的情况；工具之间的依赖关系需要更仔细处理。

### 2.8 清理与 Lease

**当前设计**：会话持久化配置是进程级全局的，通过 `acquireSessionPersistence()` 获取 lease 并引用计数；lease 结构包含 `persistSession`、`previousDisabled`、`users` 三个字段；多个 query 同时活跃时，必须有一致的 `persistSession` 值。

**证据位置**：见 `src/utils/sdkQuery.ts` 中 `activePersistenceLease`、`acquireSessionPersistence()` 和 cleanup 中调用 `releasePersistence()` 的逻辑。

**为什么这样设计**：`QueryEngine` 使用的 `setSessionPersistenceDisabled()` 等是全局状态，不能每个 query 单独设置不同的值。lease 机制确保同一时间只有一组设置生效，且在最后一个使用者退出时恢复之前的值。

### 2.9 DAG Recovery（有向无环图恢复）

**当前设计**：`recoverOrphanedParallelToolResults()` 恢复并行的 assistant sibling 消息和对应的 tool results，单 parent 遍历无法找到这些分支。
- 分组：以 `apiMessageId`（assistant 消息的 `message.id`）分组 sibling
- 锚点：以链上最后一个该组的消息为锚点
- 排序：按 `timestamp` 稳定排序

**证据位置**：见 `src/utils/sessionChainRecovery.ts` 中 `recoverOrphanedParallelToolResults()` 的实现，以及 `tests/sessionChainRecovery.test.ts` 中的验证。

**为什么这样设计**：流式输出中，一个 API `message.id` 可以对应多个 `Message`（每个 content block 一个），它们是 sibling 关系，共享同一个 `apiMessageId`，但有不同的 `uuid`。单 parent 反向遍历只能找到其中一条链，其他 sibling 及其 tool results 会被遗漏，导致恢复的对话不完整。以 `apiMessageId` 分组，可以恢复整个并行分支。

## 3. 目标与非目标

### 3.1 目标

- **提供统一的对话执行入口**：两条路径并存：
  - SDK 路径：`createSdkQuery()` → `ask()` → `QueryEngine.submitMessage()` → `query()`
  - 直接调用路径：可直接调用 `ask()` 或直接调用 `query()`
- **保证会话可恢复**：用户消息提前持久化，compact boundary 正确 flush，DAG 恢复完整，即使进程意外终止也能继续。
- **处理多种失败场景**：prompt 过长、max output tokens、工具错误、预算超限、轮次超限、abort 等，都有明确的语义和恢复/退出路径。
- **管理历史上下文**：集成 micro-compact、auto-compact、snip、context collapse，按需压缩历史以保持在 token 限制内。
- **支持可选流式工具执行**：允许工具在收到 `tool_use` 后立即执行，结果立即输出，减少用户可见延迟。
- **隔离查询状态**：`mutableMessages`、`readFileCache`、`permissionDenials`、`totalUsage` 等状态由 `QueryEngine` 封装，不同实例之间互不干扰。

### 3.2 非目标

- **不负责 SDK 协议细节**：SDK 消息类型、序列化、远程控制等属于 `sdkQuery.ts` / `sdkSessionConversation.ts` / `sdkSessions.ts` 的范围，本层只处理核心对话逻辑。
- **不重新实现模型 API 客户端**：调用 Claude API 的部分由 `claude.ts` 等负责，本层只消费其 async generator。
- **不管理 CLI UI 状态**：ink 组件、AppState 中的 UI 相关部分不属于 query core 的范围。
- **不保证每个 assistant 消息都持久化**：assistant 消息是 fire-and-forget 的，可能在 crash 时丢失（但用户消息已提前持久化，可恢复）。

## 4. 架构、模块与数据流

### 4.1 入口与职责边界

| 层 | 职责 | 关键函数/类 | 主要输入 | 主要输出 |
|---|---|---|---|---|
| 1 | SDK 入口 | `createSdkQuery()` | `prompt`/AsyncIterable、`options` | `InternalQuery` async generator |
| 2 | 单次查询包装 | `ask()` | `prompt`、配置、工具 | `SDKMessage` async generator |
| 3 | 跨轮次状态管理 | `QueryEngine.submitMessage()` | `prompt`、配置 | `SDKMessage` async generator |
| 4 | 单轮模型-工具循环 | `query()` | `messages`、`systemPrompt`、工具 | `Message`/`StreamEvent` async generator |

两个核心边界的真实签名为：

```typescript
QueryEngine.submitMessage(
  prompt: string | ContentBlockParam[],
  options?: { uuid?: string; isMeta?: boolean },
): AsyncGenerator<SDKMessage, void, unknown>

query(params: QueryParams): AsyncGenerator<
  StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
>
```

`QueryParams` 不只是消息数组。它同时传入 `systemPrompt`、`userContext/systemContext`、权限回调、`toolUseContext`、`querySource`，以及可选的 fallback、max output override、maxTurns、cache 写入开关、task budget 和测试依赖 `deps`。因此模型/工具循环的替换点主要是参数和依赖注入，而不是修改全局 SDK 状态。

`QueryEngineConfig` 按职责分为四组：

| 配置组 | 关键字段 | 设计作用 |
|---|---|---|
| 会话初始状态 | `initialMessages`、`readFileCache`、`abortController` | 决定恢复起点、文件缓存和取消所有权 |
| 执行依赖 | `tools`、`commands`、`mcpClients`、`agents`、`canUseTool`、`get/setAppState` | 将工具、命令、权限和共享状态注入，而非在类中重新发现 |
| 行为与上限 | system prompt 配置、model/fallback、`maxTurns`、`maxBudgetUsd`、`taskBudget`、`jsonSchema` | 控制模型行为、终止条件和结构化输出 |
| 输出与恢复钩子 | `includePartialMessages`、`replayUserMessages`、`setSDKStatus`、`orphanedPermission`、`snipReplay` | 控制 SDK 可见消息以及特定恢复/回放路径 |

**证据位置**：
- `createSdkQuery()` 位于 `src/utils/sdkQuery.ts`
- `ask()` 位于 `src/QueryEngine.ts`
- `QueryEngine.submitMessage()` 位于 `src/QueryEngine.ts`
- `query()` 位于 `src/query.ts`

### 4.2 完整控制流（带输入输出）

```text
用户输入 (string | ContentBlockParam[])
  ↓
QueryEngine.submitMessage()
  ├─ pre-query: processUserInput() —— 处理 slash 命令，返回 shouldQuery=false 时直接返回
  ├─ 用户消息提前持久化: await recordTranscript(messages)
  ├─ yield buildSystemInitMessage() —— 工具、模型、权限模式等信息
  ├─ if (!shouldQuery): yield 本地命令结果，return
  └─ for await (const message of query(...)):
        ├─ 收到模型响应 (assistant/stream_event)
        │   ├─ 如果是 withheld 错误 (prompt_too_long/max_output_tokens/media_error):
        │   │   ├─ 尝试 context collapse drain (若可用且之前没试过)
        │   │   ├─ 尝试 reactive compact (若可用且之前没试过)
        │   │   ├─ 尝试 max tokens escalation (若启用且之前没试过)
        │   │   └─ 若恢复失败: yield withheld error，return
        │   ├─ 检测 tool_use: set needsFollowUp=true
        │   ├─ StreamingToolExecutor (若启用): 立即开始执行工具
        │   └─ yield 消息 (tombstone 除外)
        ├─ 执行工具 (runTools() 或 StreamingToolExecutor.getRemainingResults())
        │   ├─ 每个 tool_result: yield user message
        │   ├─ 收集附件 (attachments): yield attachment message
        │   └─ stop hooks: 可能产生更多 progress/attachment 消息
        ├─ 检查终止条件:
        │   ├─ max turns exceeded → yield max_turns_reached attachment，return
        │   ├─ max budget exceeded → yield result error，return
        │   ├─ structured output retries exceeded → yield result error，return
        │   ├─ abort → yield interruption (若需要)，return
        │   └─ !needsFollowUp → 检查 stop hooks，return 或继续
        ├─ 检查历史压缩:
        │   ├─ snip (若启用且需要)
        │   ├─ micro-compact (若需要)
        │   ├─ context collapse (若启用且需要)
        │   └─ auto-compact (若启用且需要)
        └─ 下一轮迭代: state = { messages: [...messages, assistant, tool_results, ...], ... }

最终结果:
  - 成功: yield result message (type='result', subtype='success')
  - 失败: yield result message (subtype='error_during_execution'/'error_max_turns'/...)
  - 清理: flushSessionStorage()，cleanupClients()，runCleanupFunctions()
```

**证据位置**：见 `QueryEngine.submitMessage()` 和 `query()` 的完整实现。

### 4.3 状态所有权表

| 状态 | 位置 | 可变性 | 作用域 | 说明 |
|---|---|---|---|---|
| `mutableMessages` | `QueryEngine` | mutable | 跨轮次 | 对话历史，每次 `submitMessage()` 追加 |
| `readFileCache` / `readFileState` | `QueryEngine` | mutable | 跨轮次 | 文件读取缓存，减少重复磁盘 I/O |
| `permissionDenials` | `QueryEngine` | mutable | 跨轮次 | 本轮/历史权限拒绝记录，最终 yield 给 SDK |
| `totalUsage` | `QueryEngine` | mutable | 跨轮次 | 累计 token 用量 |
| `discoveredSkillNames` | `QueryEngine` | mutable | 本轮 | 本轮发现的技能名称，每轮清空 |
| `loadedNestedMemoryPaths` | `QueryEngine` | mutable | 跨轮次 | 已加载的嵌套记忆路径 |
| `abortController` | `QueryEngine` | mutable | 跨轮次 | 可复用的 abort 控制器，用于 `interrupt()` |
| `autoCompactTracking` | `query()` state | mutable | 本轮 | 自动压缩跟踪状态（是否已压缩、轮次计数等） |
| `maxOutputTokensRecoveryCount` | `query()` state | mutable | 本轮 | max tokens 恢复尝试次数，限制在 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` 内 |
| `hasAttemptedReactiveCompact` | `query()` state | mutable | 本轮 | 是否已尝试 reactive compact，防止无限循环 |
| `maxOutputTokensOverride` | `query()` state | mutable | 本轮 | max tokens 覆盖值（escalation 时设为 `ESCALATED_MAX_TOKENS`） |
| `pendingToolUseSummary` | `query()` state | mutable | 本轮次内部迭代 | 待处理的工具使用 summary Promise，下一次迭代 yield |
| `stopHookActive` | `query()` state | mutable | 本轮 | stop hook 是否已激活，防止重复执行 |
| `turnCount` | `query()` state | mutable | 单次 query 调用 | 从 1 开始，在继续下一轮模型/工具迭代时递增；达到 `maxTurns` 时决定终止，并用于 `max_turns_reached` 附件 |
| `transition` | `query()` state | mutable | 本轮 | 记录上一次 continue 的原因，用于测试/诊断 |
| `taskBudgetRemaining` | `queryLoop()` 闭包 | mutable | 单次 query 调用内跨 compact | 初始为 `undefined`；仅在 `params.taskBudget` 存在且 compact 发生时，用最后一次响应的上下文窗口扣减剩余预算；不放入 `State`，也不跨 `submitMessage()` |

**为什么分层**：
- 跨轮次状态放在 `QueryEngine`：同一对话的多次 `submitMessage()` 需要共享历史、缓存、权限记录和用量。
- 本轮次状态放在 `query()` 内部 `state` 对象：单轮内部的循环迭代不需要污染跨轮次状态，也更容易保证每轮的干净初始化。
- `taskBudgetRemaining` 放在闭包：task budget 需要跨 compact 边界保留，但不需要跨 `submitMessage()` 调用（新的用户输入开始新的 task budget）。

### 4.4 Compact boundary 后数组裁剪与 GC

**当前设计**：当收到 compact boundary 消息时，`QueryEngine` 会对 `mutableMessages` 和局部 `messages` 数组进行裁剪，只保留 compact boundary 之后的消息，让之前的内容可以被 GC。

**证据位置**：`src/QueryEngine.ts` 中 compact boundary 处理分支的 `mutableMessages.splice(0, mutableBoundaryIdx)` 和 `messages.splice(0, localBoundaryIdx)`。

**为什么这样设计**：compact 之后，之前的历史不再需要参与后续 API 调用（`getMessagesAfterCompactBoundary()` 已经处理了裁剪），保留它们只会占用内存。裁剪让这些大数组可以被 GC，避免长期运行的 SDK 会话内存无限增长。

### 4.5 Query helpers 具体行为

#### normalizeMessage

- 输入类型为 assistant：转换为 SDK assistant message，但跳过空消息和纯 `SYNTHETIC_MESSAGES` 的消息
- 输入类型为 progress（agent_progress/skill_progress）：先 normalize 内部 message，按类型产出 assistant/user
- 输入类型为 progress（bash_progress/powershell_progress）：受 throttling 控制（30秒一次），仅在 `CLAUDE_CODE_REMOTE` 或 `CLAUDE_CODE_CONTAINER_ID` 启用时发送；用 `parentToolUseId` 作为 key；`MAX_TOOL_PROGRESS_TRACKING_ENTRIES` 做 LRU 限制
- 输入类型为 user：转换为 SDK user message
- 其他类型：不 yield

**证据位置**：`src/utils/queryHelpers.ts`

#### handleOrphanedPermission

- 检查 permission 对应的 tool_use 是否已经在 mutableMessages 中存在（避免重复执行）
- 如果不存在：push assistant 消息，persist，yield SDK 消息
- wrapped canUseTool 直接返回 permission 结果，不再次询问
- 调用 runTools 执行工具，push/yield tool results

**证据位置**：`src/utils/queryHelpers.ts`

#### extractReadFilesFromMessages

- 第一遍：从 assistant 消息中找到 Read/Write/Edit 的 tool_use：
  - Read：记录 file path，但仅当没有 offset/limit 时
  - Write：记录 file path + content
  - Edit：仅记录 file path（因为 input 没有结果内容）
- 第二遍：从 user 消息中找到对应 tool_use_id 的 tool_result：
  - Read：提取 content，strip ansi，strip line numbers，strip system-reminder blocks；跳过以 `FILE_UNCHANGED_STUB` 开头的
  - Write：直接从 tool_use input 取 content
  - Edit：从当前磁盘读取（因为 tool_result 只有 snippet），同时取 mtime
- 构建 FileStateCache，大小限制在 `ASK_READ_FILE_STATE_CACHE_SIZE`

**证据位置**：`src/utils/queryHelpers.ts`

### 4.6 Max output tokens 两级恢复路径

**第一级：escalation**

- 条件：`maxOutputTokensOverride === undefined`、`!process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS`、feature flag `tengu_otk_slot_v1` 启用
- 动作：设置 `maxOutputTokensOverride = ESCALATED_MAX_TOKENS`，直接 continue 重试同一请求，不注入 meta 消息

**第二级：multi-turn recovery**

- 条件：`maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`（3）
- 动作：注入 meta user 消息，让模型“从截断处继续”，`maxOutputTokensRecoveryCount += 1`
- 恢复耗尽：yield withheld error 消息

**证据位置**：`src/query.ts` escalation 分支和 recovery 分支

## 5. 失败语义与工程取舍

### 5.1 Abort 语义

**行为**：
- `QueryEngine.interrupt()` 调用 `abortController.abort()`。
- 模型调用端检测到 `signal.aborted` 停止生成。
- 工具执行端检测到 `signal.aborted`：
  - 若使用 `StreamingToolExecutor`，`getRemainingResults()` 会为未完成/排队的工具生成 synthetic tool_result（interrupted）。
  - 若使用 `runTools()`，`yieldMissingToolResultBlocks()` 生成 interrupted 消息。
- （可选）yield 用户中断消息，除非 `signal.reason === 'interrupt'`。
- Chicago MCP：若为 main thread 且 feature 启用，调用 `cleanupComputerUseAfterTurn()`。

**证据位置**：见 `query()` 中两处 `signal.aborted` 检查（模型之后、工具之后），以及相关 cleanup 逻辑。

**取舍**：选择生成 synthetic tool_result 而不是什么都不做，是为了保持消息历史的完整性（每个 tool_use 有对应 tool_result），避免后续恢复时出现无对应结果的 tool_use。

### 5.2 模型错误语义

| 错误类型 | 处理方式 | 是否 withhold | 恢复路径 |
|---|---|---|---|
| prompt_too_long | 特殊处理 | 是 | context collapse drain → reactive compact → 失败 |
| max_output_tokens | 特殊处理 | 是 | escalation → 多轮恢复 → 失败 |
| media size error | 特殊处理 | 是 | reactive compact → 失败 |
| 其他 API 错误 | yield assistant error message | 否 | 无（直接返回） |
| ImageSizeError / ImageResizeError | yield assistant error message | 否 | 无（直接返回） |
| FallbackTriggeredError | 切换 fallback model 重试 | - | 重试（tombstone 之前部分结果，discard 工具，重建 executor，strip thinking signatures） |

**证据位置**：见 `src/query.ts` 中 try/catch 块、fallback 分支、以及 `!needsFollowUp` 下的 withheld 错误处理。

### 5.3 工具错误语义

- 工具执行错误不中止整个对话：错误作为 `tool_result` 的一部分返回给模型，由模型决定下一步。
- 权限拒绝不中止整个对话：拒绝作为工具结果返回，同时记录到 `permissionDenials` 供 SDK 最终报告。
- 工具执行可以被 abort：生成 interrupted tool_result，对话可以选择继续或结束。

**证据位置**：见 `runTools()` 和 `StreamingToolExecutor` 中的错误处理，以及 `QueryEngine` 中 `wrappedCanUseTool` 对 denials 的记录。

### 5.4 Max turns / Max budget / Structured output retries 语义

| 限制 | 检查位置 | 触发后行为 |
|---|---|---|
| `maxTurns` | `query()` 在下一次迭代前检查并产生 `max_turns_reached` 附件；`QueryEngine` 消费该附件 | QueryEngine 产出 `error_max_turns` result 并返回 |
| `maxBudgetUsd` | QueryEngine 循环，每条消息后 | 立即 yield error result |
| structured output retries | QueryEngine 循环，user 消息后 | 超过 `MAX_STRUCTURED_OUTPUT_RETRIES` 后 yield error |

**证据位置**：见 `QueryEngine.submitMessage()` 中 `maxBudgetUsd` 和 structured output 检查，以及 `query()` 中 `maxTurns` 检查。

**取舍**：`maxBudgetUsd` 在每条消息后检查（而不是只在轮次结束时），是因为单个 assistant 消息或工具调用附件可能产生大量费用，需要及时止损。

### 5.5 Fallback 语义

- 当 `FallbackTriggeredError` 抛出时，切换到 `fallbackModel` 重试。
- 之前已经 yield 的部分 assistant 消息通过 tombstone 撤回。
- 之前已经开始执行的工具被 discard，`StreamingToolExecutor` 重新初始化。
- thinking signature blocks 被 strip（因为不同模型的签名不兼容）。
- 记录 analytics event `tengu_model_fallback_triggered`。
- yield system message 通知用户发生了降级。

**证据位置**：见 `query()` 中 `FallbackTriggeredError` catch 分支。

### 5.6 清理语义

- 正常结束：`finally` 块清理 MCP clients、run cleanup functions、flush session storage、release persistence lease。
- Abort/异常：同样的清理路径执行。
- Generator.return()：调用 cleanup，返回。
- 多个 query 共享同一 persistence lease：引用计数，最后一个释放时恢复原设置。

**证据位置**：
- 见 `createSdkQuery()` 中 `query.return` 的覆盖和 `cleanup()` 函数。
- 见 `src/utils/sdkQuery.ts` 中 `acquireSessionPersistence()` 和 `releasePersistence()`。

### 5.7 并发与隔离

- **MCP clients/tools**：每个 `createSdkQuery()` 有自己的 MCP 连接，不与其他 query 共享。
- **FileStateCache**：每个 `QueryEngine` 有自己的 `readFileState`，通过 `cloneFileStateCache()` 初始化，避免相互污染。
- **MutableMessages**：每个 `QueryEngine` 有自己的 `mutableMessages`，不同实例隔离。
- **Persistence lease**：进程级全局，引用计数，同一时间所有活跃 query 必须有一致的 `persistSession` 设置。

**证据位置**：见 `QueryEngine` 构造函数中的 `cloneFileStateCache()`，`createSdkQuery()` 中的 MCP 连接创建，以及 `acquireSessionPersistence()` 的检查。

### 5.8 性能取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 用户消息提前持久化 | await（非 bare）/ fire-and-forget（bare） | 关键路径 I/O | crash 可恢复 |
| Assistant 消息持久化 | fire-and-forget | 可能丢失（可恢复） | 不阻塞流式输出 |
| Streaming tool execution | 可选（门控） | 实现复杂度 | 更低的用户可见延迟 |
| Snip 在 microcompact/autocompact 前执行 | 是，两者不互斥 | 增加一次 snip 投影和边界处理 | `snipTokensFreed` 传给 autocompact，使阈值计算反映 snip 已移除的 token；仅看 protected-tail assistant 的 usage 看不到这部分减少 |
| Eager flush | 可选（环境变量控制） | 更多 I/O | 桌面/cowork 场景下更高的持久性 |

## 6. 现状验收标准

| 验收项 | 设计行为 | 证据位置 |
|---|---|---|
| 用户消息提前持久化 | 用户消息在调用 `query()` 之前就调用 `recordTranscript()` 写入 transcript；非 bare 模式下是 await 调用 | `src/QueryEngine.ts` |
| Withheld 错误恢复 | prompt_too_long、max_output_tokens、media size errors 被 withhold，先尝试恢复，失败后才 yield | `src/query.ts` |
| Max output tokens 两级恢复 | 先尝试 escalation（覆盖 max output tokens），再尝试最多 3 次多轮恢复 | `src/query.ts` |
| Max turns 执行 | `query()` 在超过上限时终止并产生 `max_turns_reached`；`QueryEngine` 将其转换为 `error_max_turns` result，不进入下一次模型/工具迭代 | `src/QueryEngine.ts`, `src/query.ts` |
| Max budget 执行 | 在 `QueryEngine` 中每条消息后检查，超出后立即返回 | `src/QueryEngine.ts` |
| Abort 语义 | abort 发生时，每个 tool_use 有对应的 synthetic tool_result | `src/query.ts` |
| Tombstone 在 fallback 时产生 | 降级发生时，对已输出的 assistant 消息 yield tombstone | `src/query.ts` |
| Compact boundary 数组裁剪 | 收到 compact boundary 后，裁剪 `mutableMessages` 和 `messages` 数组，允许 GC | `src/QueryEngine.ts` |
| 错误水印范围正确性 | `error_during_execution` 的 errors 以本轮开始前 watermark 为界，只包含本轮错误 | `src/QueryEngine.ts` |
| Persistence lease 引用计数与隔离 | lease 引用计数协调多个 query，最后一个释放时恢复原设置 | `src/utils/sdkQuery.ts` |

## 7. 代码与测试证据

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/QueryEngine.ts` | `QueryEngine`、`ask()` | 跨轮次状态管理、SDK 消息规范化、提前持久化 |
| `src/query.ts` | `query()`、`queryLoop()` | 单轮模型-工具循环、恢复逻辑、历史压缩集成 |
| `src/utils/queryHelpers.ts` | `isResultSuccessful()`、`normalizeMessage()`、`handleOrphanedPermission()`、`extractReadFilesFromMessages()` | 辅助函数：结果判定、消息转换、权限处理、缓存回填 |

### 7.2 现有测试场景证明

| 测试文件 | 测试场景 | 证明的不变量 |
|---|---|---|
| `tests/sdkQueryLifecycle.test.ts` | `query.return` runs cleanup and session flush exactly once | cleanup 在 generator.return 上被调用一次；flush 被调用一次；多次 return 不会重复调用 |
| `tests/sdkSessions.test.ts` | lists/reads/mutates/forks sessions without CLI state | session storage 不依赖 CLI AppState |
| `tests/sdkSessions.test.ts` | recovers parallel assistant branches before SDK conversion and pagination | DAG recovery 正确恢复并行 sibling 和 tool results；sibling 插在最后 anchor 之后 |
| `tests/sessionChainRecovery.test.ts` | recovers siblings after last on-chain anchor with stable order and no unrelated groups | `recoverOrphanedParallelToolResults` 按 API message.id 分组，按 timestamp 稳定排序，不混入不相关分组；recovered count 正确；第二次调用（seen 全量）recovered count 为 0 |
| `tests/reactiveCompact.test.ts` | detects PTL and media-size errors with a runtime kill switch | `isWithheldPromptTooLong/isWithheldMediaSizeError` 正确检测；feature flag 可以禁用 |
| `tests/reactiveCompact.test.ts` | strips media and calls shared compactor without duplicate PreCompact | `reactiveCompactOnPromptTooLong` 可以 strip media，调用 compactor |
| `tests/reactiveCompact.test.ts` | maps too-few-groups, abort, exhausted outcomes | 各种 outcome 正确映射 |
| `tests/reactiveCompact.test.ts` | merges hook messages and performs success cleanup once | `tryReactiveCompact` 合并 hook 消息，只调用一次 onSuccess cleanup；hasAttempted=true 时不再尝试 |

### 7.3 未覆盖行为（基于代码阅读）

- 完整的多 turn QueryEngine 场景
- error watermark 在环形缓冲区 wrap-around 情况下的边界行为
- maxBudgetUsd 在中间消息触发的场景
- structured output retries 逻辑
- StreamingToolExecutor 与 runTools 两条路径的产出消息等价性
- compact boundary 数组裁剪后的 GC 行为

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/query-core.yaml)

### 8.1 本 spec 主拥有的文件

- `src/QueryEngine.ts`
- `src/query.ts`
- `src/utils/queryHelpers.ts`

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/sdkQuery.ts` → 见 `sdk-query-sessions` spec
- `src/utils/sdkSessionConversation.ts` → 见 `sdk-query-sessions` spec
- `src/utils/sessionChainRecovery.ts` → 见 `sdk-query-sessions` spec
- `src/services/compact/` → 见 `compact` spec
- `src/services/contextCollapse/` → 见 `context-collapse` spec
- `src/utils/permissions/` → 见 `permissions` spec

## 9. 改进建议

### P1

#### 9.1.1 结构化错误原因与错误码

**触发场景**：当前 `error_during_execution` 的 errors 数组是字符串列表，且开头有一行 `[ede_diagnostic] result_type=...` 的诊断文本；SDK 调用方难以程序化判断具体失败原因（是 prompt_too_long？工具错误？权限？还是其他？）。

**证据位置**：`src/QueryEngine.ts` 中 `errors` 数组的构建。

**建议方向**：定义结构化错误枚举/类型，包含错误码、原因、可能的修复建议；诊断信息作为单独字段，不混入 errors 数组。

**回归风险**：低-中等 —— 可以保持向后兼容，在现有字段旁新增结构化字段，或通过版本化处理。

**验收方式**：编写测试验证每种失败场景都有对应的错误码，且诊断信息可单独获取。

**工作量**：M

**置信度**：已证实（基于代码阅读）

---

### P2

#### 9.2.1 Persistence lease 的错误信息可操作性

**触发场景**：当两个 query 尝试使用不同的 `persistSession` 值时，抛出的错误是通用的；调用方难以知道是哪两个 query、各自的设置是什么、谁先创建的。

**证据位置**：`src/utils/sdkQuery.ts` 中 `acquireSessionPersistence()` 的检查。

**建议方向**：在错误信息中包含第一个 query 的创建栈、设置、以及第二个 query 的设置，帮助定位冲突来源。

**回归风险**：低 —— 仅改进错误信息。

**验收方式**：构造冲突场景，验证错误信息包含足够细节。

**工作量**：S

**置信度**：已证实（基于代码阅读）

---

#### 9.2.2 历史压缩决策的可观测性

**触发场景**：当前 autocompact/snip/collapse 的决策过程对 SDK 调用方不透明；调试上下文问题时，难以知道为什么触发/没触发、节省了多少 token、是否可以调整阈值等。

**证据位置**：`src/query.ts` 中 compact/snip/collapse 的调用点，缺乏统一的决策轨迹记录。

**建议方向**：在 SDK 消息流中增加可选的系统事件（system subtype='compact_decision'/'snip_decision' 等），包含触发原因、token 变化、阈值等信息；由调用方选择是否接收。

**回归风险**：低 —— 可选功能，默认不发送。

**验收方式**：测试启用决策事件后，各压缩决策都有对应的事件产出，包含预期字段。

**工作量**：M

**置信度**：设计推断
