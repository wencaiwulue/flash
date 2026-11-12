---
id: sdk-query-sessions
batch: 0
title: SDK Query、Session、控制面与 Checkpoint 设计
date: 2026-11-12
status: draft
---

# SDK Query、Session、控制面与 Checkpoint 设计

## 1. 问题与为什么需要统一生命周期

SDK 调用方需要的不只是发送一个 prompt。可靠的查询还包括异步输入输出、权限与控制请求、会话恢复、上下文读取、任务停止，以及按消息恢复文件状态。若这些能力各自维护状态，模型消息、持久化消息和文件快照会失去同一 UUID 的对应关系，取消和恢复也无法形成一致的生命周期。

本功能将这些接口放在同一设计中，是因为它们共享三条约束：

- **消息身份**：query、session transcript 和 checkpoint 都以 user message UUID 关联。
- **生命周期一致性**：创建、流式输出、控制、停止、恢复和回滚必须经过同一 query/session 状态。
- **恢复语义分离但配套**：session 恢复对话，checkpoint 恢复该消息对应的文件状态；两者需要协调，但不能合并成一次不透明的全量恢复。

### 目标

- 提供可结束、可中断、可恢复的异步 query 生命周期。
- 复用同一消息转换与持久化规则，避免 CLI 与 SDK 行为漂移。
- 让控制方法直接操作现有生产状态，不引入影子状态。
- 按消息精确关联文件快照和回滚，同时提供无副作用 dry run。

### 非目标

- 不重新实现模型传输协议，不把 remote-control 当作 query 默认实现。
- 不把 CLI UI 状态复制到 SDK，不把 session 恢复等同于文件系统回滚。
- 不用全局 checkpoint 配置共享不同 query 的快照。

## 2. 公开 API 与内部实现边界

### 2.1 公开 API 层级

SDK 公开 API 分为两层：

```
┌─────────────────────────────────────────────────────────┐
│         Public API (agentSdkTypes.ts)                  │
│  ┌─────────────────────────────────────────────────┐  │
│  │  query() / unstable_v2_createSession()          │  │
│  │  listSessions() / getSessionMessages()          │  │
│  │  forkSession() / renameSession()                │  │
│  └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│         Internal Implementation                         │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐ │
│  │ sdkQuery.ts │  │sdkSessions.ts│  │ sdkControl.ts│ │
│  └─────────────┘  └─────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 2.2 关键公开接口签名

#### Query 接口

```typescript
export interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean }
  ): Promise<RewindFilesResult>;
  setMcpServers(
    servers: Record<string, McpServerConfig>
  ): Promise<McpSetServersResult>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
}
```

#### Session 接口

```typescript
export interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export function unstable_v2_createSession(
  options: SDKSessionOptions
): SDKSession;
export function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions
): SDKSession;
export async function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions
): Promise<SDKResultMessage>;
```

#### Session 访问器接口

```typescript
export async function listSessions(
  options?: ListSessionsOptions
): Promise<SDKSessionInfo[]>;
export async function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions
): Promise<SDKSessionInfo | undefined>;
export async function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions
): Promise<SessionMessage[]>;
export async function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions
): Promise<void>;
export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions
): Promise<void>;
export async function forkSession(
  sessionId: string,
  options?: ForkSessionOptions
): Promise<ForkSessionResult>;
```

### 2.3 内部接口边界

| 模块 | 设计职责 | 公开边界 | 内部依赖 |
|------|---------|---------|---------|
| `agentSdkTypes.ts` | 类型聚合与公开 API 重导出 | 所有公开类型与函数 | `sdkQuery.ts`、`sdkSessionConversation.ts`、`sdkSessions.ts` |
| `sdkQuery.ts` | 创建异步 query，串联消息 channel、控制请求、权限和清理 | `createSdkQuery()` 工厂函数 | `QueryEngine.ask`、`sdkControl.ts`、`fileCheckpointing.ts` |
| `sdkSessionConversation.ts` | 会话包装器，管理后台消费流 | `createSdkSession()`、`resumeSdkSession()`、`promptSdkSession()` | `sdkQuery.ts`、`sdkSessions.ts` |
| `sdkSessions.ts` | 读取、列表、重命名、标记、分叉 JSONL session | `listSdkSessions()`、`getSdkSessionMessages()` 等 | `sessionChainRecovery.ts`、`sessionStoragePortable.ts` |
| `sessionChainRecovery.ts` | 恢复并行 assistant 分支与工具结果 | `recoverOrphanedParallelToolResults()` | 纯函数，无外部依赖 |
| `sdkControl.ts` | 上下文使用、标志/设置、停止任务、重载插件 | `getSdkContextUsage()`、`applySdkFlagSettings()` 等 | `bootstrap/state.ts`、`settings/settings.ts`、`plugins/refresh.ts` |
| `FileCheckpointing` | 按 userMessageId 注册、等待并恢复文件快照 | `FileCheckpointing` 类 | `fileHistory.ts` |

关键原则：所有内部模块都不依赖 CLI 应用状态（`AppState`）之外的 CLI 特有结构，`sdkSessions.ts` 与 `sessionChainRecovery.ts` 甚至不读取 `AppState`，确保 SDK 会话访问器在 CLI 未启动时也可运行。

## 3. 异步输入输出与 UserMessageChannel

### 3.1 异步输入模型

SDK 支持两种输入模式：

1. **一次性字符串输入**：`query({ prompt: "hello" })`
2. **异步流输入**：`query({ prompt: asyncIterable })`

两种模式都统一通过 `UserMessageChannel` 内部队列化：

```typescript
export class UserMessageChannel {
  private queue: SDKUserMessage[] = [];
  private closed = false;
  private error: unknown;
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  push(message: SDKUserMessage): void;
  close(): void;
  fail(error: unknown): void;
  async *iterate(): AsyncGenerator<SDKUserMessage, void>;
}
```

### 3.2 完整数据流

```
┌─────────────┐
│ SDK Caller  │
└──────┬──────┘
       │ push()
       ▼
┌──────────────────────┐
│  UserMessageChannel  │
│  [queue, closed,     │
│   waiters]           │
└──────┬───────────────┘
       │ iterate()
       ▼
┌─────────────────────────────────┐
│  createSdkQuery.run() generator │
│  ┌───────────────────────────┐ │
│  │ fileCheckpointing.make-  │ │
│  │ Snapshot(userMsg.uuid)   │ │
│  └───────────┬───────────────┘ │
│              ▼                 │
│     ┌─────────────────┐        │
│     │  QueryEngine.ask│        │
│     │  (model loop)   │        │
│     └────────┬────────┘        │
└──────────────┼─────────────────┘
               │ yield
               ▼
       ┌───────────────┐
       │ SDK Output    │
       │ (async gen)   │
       └───────────────┘
```

### 3.3 错误与关闭边界

| 操作 | 行为 | 后续操作 |
|------|------|---------|
| `push()` 在 `close()` 后 | 抛出 `Error("Cannot stream input after the query closes")` | 不可用 |
| `fail(error)` | 关闭 channel，存储错误 | `iterate()` 会抛出错误 |
| `query.return()` | 触发完整清理流程（见第 4 节） | `close()` 安全幂等 |
| `query.interrupt()` | 中止 AbortController，触发模型循环中断 | 仍需调用 `return()` 完成清理 |

## 4. Query 生命周期与持久化 Lease

### 4.1 完整控制流：从创建到清理

```typescript
// 1. 调用方创建 query
const q = createSdkQuery({
  prompt: asyncIterable,
  options: { persistSession: true }
});

// 2. 首次调用初始化（懒加载）
await q.getSettings();
// 内部：
//   - acquireSessionPersistence(true)
//   - bootstrap/state 设置
//   - MCP 连接
//   - 工具池组装
//   - FileCheckpointing 实例化

// 3. 消费输出
for await (const msg of q) {
  // 处理消息
}

// 4. 显式结束（或通过 return() / Symbol.asyncDispose）
await q.return(undefined);
// 内部清理流程：
//   ├─ remoteController.stop() (if active)
//   ├─ cleanupClients(mcp clients)
//   ├─ runCleanupFunctions()
//   ├─ flushSessionStorage()
//   └─ releasePersistence()
```

### 4.2 持久化 Lease 机制

会话持久化是进程全局状态，通过引用计数 Lease 管理：

```typescript
let activePersistenceLease: {
  persistSession: boolean;
  previousDisabled: boolean;
  users: number;
} | undefined;

function acquireSessionPersistence(persistSession: boolean): () => void {
  // 验证兼容性：不同时支持不同 persistSession 值的并发 queries
  if (activePersistenceLease &&
      activePersistenceLease.persistSession !== persistSession) {
    throw new Error(
      "Concurrent SDK queries with different persistSession options are not supported"
    );
  }

  if (!activePersistenceLease) {
    const previousDisabled = isSessionPersistenceDisabled();
    activePersistenceLease = {
      persistSession,
      previousDisabled,
      users: 0
    };
    setSessionPersistenceDisabled(previousDisabled || !persistSession);
  }
  activePersistenceLease.users++;

  // 返回释放函数（幂等）
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const lease = activePersistenceLease;
    if (!lease || lease.persistSession !== persistSession) return;
    lease.users--;
    if (lease.users === 0) {
      setSessionPersistenceDisabled(lease.previousDisabled);
      activePersistenceLease = undefined;
    }
  };
}
```

**关键决策**：选择进程全局 Lease 而非每个 query 独立配置，原因：

| 备选方案 | 代价 | 选择 | 证据 |
|---------|------|------|------|
| 每个 query 独立配置 | QueryEngine 内部难以支持交错持久化 | 进程全局 Lease | `sdkQueryLifecycle.test.ts` 验证了多次 `return()` 只执行一次清理 |
| 完全禁用并发 queries | 过度限制使用场景 | 仅限制 `persistSession` 不同的并发 | 错误消息明确说明限制条件 |

### 4.3 清理保证表

| 退出路径 | `cleanupClients` | `runCleanupFunctions` | `flushSessionStorage` | `releasePersistence` |
|---------|-----------------|---------------------|---------------------|---------------------|
| 正常 `for await` 完成 | ✓ | ✓ | ✓ | ✓ |
| `query.return()` | ✓ | ✓ | ✓ | ✓ |
| `query.return()` 多次调用 | 仅第一次 | 仅第一次 | 仅第一次 | 仅第一次 |
| 迭代器抛出错误 | ✓ | ✓ | ✓ | ✓ |
| `query.interrupt()` | 需配合 `return()` | 需配合 `return()` | 需配合 `return()` | 需配合 `return()` |

## 5. Session 创建、恢复、分叉与 parentUuid DAG

### 5.1 Session 架构

`SDKSession` 是对 `createSdkQuery()` 的轻量级包装，内部维护独立的后台消费循环：

```typescript
class LocalSdkSession implements SDKSession {
  readonly #channel = new UserMessageChannel();
  readonly #query: ReturnType<typeof createSdkQuery>;
  readonly #background: Promise<void>;
  readonly #messages: SDKMessage[] = [];
  #sessionId: string | undefined;
  readonly #waiters = new Set<() => void>();
  #closed = false;
  #error: unknown;

  // 消费循环
  private async consume(): Promise<void> {
    try {
      for await (const message of this.#query) {
        if ("session_id" in message && message.session_id) {
          this.#sessionId = message.session_id;
        }
        this.#messages.push(message);
        this.notify();
      }
    } catch (error) {
      this.#error = error;
      this.notify();
    }
  }
}
```

### 5.2 parentUuid DAG 结构

会话持久化 JSONL 中的每条消息都包含：
- `uuid`：消息自身唯一 ID
- `parentUuid`：前驱消息 ID，构成链表
- 对于 assistant 消息，可能包含 `message.id`（API 返回的 msg-* ID）

并行工具调用的 DAG 恢复问题：单个 `parentUuid` 链表遍历会丢失同一 API 消息的其他 content block 分支。

```
原始 JSONL 顺序（写入顺序）：
  User (root)
    ├─ Assistant A (api: msg-parallel, parent: root)
    │  └─ ToolResult A (parent: A)
    └─ Assistant B (api: msg-parallel, parent: A)
       └─ ToolResult B (parent: B)

单 parent 遍历结果（只恢复一条分支）：
  User → A → ToolResult A → [B 丢失]

DAG 恢复后完整链条：
  User → A → B → ToolResult B → ToolResult A
```

### 5.3 DAG 恢复算法

`recoverOrphanedParallelToolResults()` 是纯函数，输入：
- `messages: Map<UUID, T>`：所有消息按 UUID 索引
- `chain: T[]`：从叶节点回溯的主链
- `seen: Set<UUID>`：已在主链中的消息

输出：
- 完整 `chain` 包含所有并行分支
- `recoveredCount`：恢复的消息数

算法步骤：

```typescript
// 1. 从主链收集所有 API message ID -> anchor point
//    anchor = 同一 API ID 在主链上的最后一条消息
const anchorByMsgId = new Map<string, T>();
for (const assistant of chainAssistants) {
  anchorByMsgId.set(apiMessageId(assistant)!, assistant);
}

// 2. 收集：
//    - 按 API ID 分组的所有 assistant 消息
//    - 按 assistant UUID 分组的所有 tool_result 消息
const siblingsByMsgId = new Map<string, T[]>();
const toolResultsByAssistant = new Map<UUID, T[]>();

// 3. 对每个组，找出不在 seen 中的孤儿
// 4. 按 timestamp 稳定排序
// 5. 插入到 anchor point 之后
```

**证据**：`sdkSessions.test.ts` 中的 `recovers parallel assistant branches` 测试用例验证了恢复顺序与分页行为。

### 5.4 Session 分叉语义

`forkSession()` 创建新会话，具有：
- 新的 `sessionId`
- 所有消息重新分配 UUID
- 保留 `parentUuid` 关系（指向新链中的消息）
- 保留 `forkedFrom` 元数据：`{ sessionId: sourceId, messageUuid: originalUuid }`
- 复制 `content-replacement` 条目
- **不复制**文件历史快照（设计决策：避免快照膨胀）

**关键决策**：分叉时不复制文件快照：

| 备选方案 | 代价 | 选择 | 证据 |
|---------|------|------|------|
| 复制所有快照 | 磁盘空间膨胀，分叉变慢 | 不复制 | fork 测试验证只复制 transcript |
| 惰性复制 | 实现复杂度高 | 不复制 | 设计文档明确说明 |

## 6. 控制面：复用生产状态

### 6.1 控制方法映射

所有 SDK 控制方法都直接委托给现有生产实现，不引入影子状态：

| SDK 方法 | 生产实现 | 附加行为 |
|---------|---------|---------|
| `getContextUsage()` | `collectContextData()` | 组装 messages/tools/state |
| `applyFlagSettings(settings)` | `setFlagSettingsInline()` | 删除 null 键，通知变更，模型变化更新 override + metadata |
| `getSettings()` | `getSettingsWithSources()` | 追加 `applied.model` 和 `applied.effort` |
| `stopTask(taskId)` | `stopTask()` | 透传 |
| `reloadPlugins()` | `refreshActivePlugins()` + `loadAllPluginsCacheOnly()` | 聚合 commands/agents/plugins/mcpServers |

### 6.2 applyFlagSettings 细节

```typescript
export function applySdkFlagSettings(settings: Record<string, unknown>): void {
  const previousModel = getMainLoopModel();
  const merged = { ...(getFlagSettingsInline() ?? {}), ...settings };
  // 删除 null 键：这是 SDK 清除设置的方式
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key];
  }
  setFlagSettingsInline(merged);
  settingsChangeDetector.notifyChange("flagSettings");

  // 模型变化特殊处理
  if ("model" in settings) {
    setMainLoopModelOverride(
      settings.model == null ? undefined : String(settings.model)
    );
  }
  const nextModel = getMainLoopModel();
  if (nextModel !== previousModel) {
    notifySessionMetadataChanged({ model: nextModel });
  }
}
```

**证据**：`sdkControls.test.ts` 验证了 null 键删除与模型元数据通知。

## 7. 代码与测试证据

### 7.1 状态所有权表

| 状态 | 所有者 | 访问边界 | 持久化 |
|------|--------|---------|-------|
| `activePersistenceLease` | `sdkQuery.ts` | 模块级私有 | 否 |
| `UserMessageChannel.queue` | 每个 Query 实例 | Query 内部 | 否 |
| `FileCheckpointing.#pendingSnapshots` | 每个 Query 实例 | Query 内部 | 否 |
| `LocalSdkSession.#messages` | 每个 Session 实例 | Session 内部 | 否 |
| session JSONL 文件 | 文件系统 | `sdkSessions.ts` + `sessionStoragePortable.ts` | 是 |
| 文件历史快照 | 文件系统 | `fileHistory.ts` | 是 |

### 7.2 现有测试覆盖场景

| 测试文件 | 覆盖能力 | 状态 |
|---------|---------|------|
| `sdkQueryLifecycle.test.ts` | `query.return()` 清理执行一次 | 现有测试 |
| `sdkSessions.test.ts` | 列出/读取/重命名/标记/分叉会话 | 现有测试 |
| `sdkSessions.test.ts` | 恢复并行 assistant 分支 | 现有测试 |
| `sdkSessions.test.ts` | 不恢复无关联分支 | 现有测试 |
| `sdkSessions.test.ts` | 消息分页 | 现有测试 |
| `sdkControls.test.ts` | 读取 usage/settings、重载插件、停止任务 | 现有测试 |
| `sdkControls.test.ts` | 删除 null 标志、模型元数据通知 | 现有测试 |
| `sdkRewind.test.ts` | 文件回滚与 dry run | 现有测试 |
| `sdkMcp.test.ts` | MCP 服务器管理 | 现有测试 |
| `sdkRemoteControl.test.ts` | 远程控制桥接 | 现有测试 |
| `sdkCron.test.ts` | Cron 任务调度 | 现有测试 |

### 7.3 隔离性验证

关键隔离边界需保持：
- `sdkSessions.ts` 不读取 `AppState` ✓
- `sessionChainRecovery.ts` 是纯函数 ✓
- DAG 恢复不读取 analytics 或 CLI UI 状态 ✓
- 控制面不复制生产状态逻辑 ✓

## 8. 覆盖范围

本设计的覆盖范围定义见 [Coverage](../../architecture/coverage/sdk-query-sessions.yaml)。

## 9. 改进建议

### 9.1 短期改进（<1个月）

1. **明确 `interrupt()` 与 `return()` 的组合契约**：当前设计要求调用 `interrupt()` 后仍需调用 `return()` 完成清理，但这容易被误用。考虑在 `interrupt()` 内部启动清理但仍允许 `return()` 安全调用。

2. **增加超时机制**：`UserMessageChannel` 和 MCP 连接当前没有超时配置，可能导致查询挂起。考虑添加可配置的超时选项。

3. **改进并发 query 限制**：当前仅限制 `persistSession` 不同的并发，可考虑实现真正的交错持久化支持，或提供更明确的错误恢复路径。

### 9.2 中期改进（1-3个月）

1. **Session 分叉时可选复制快照**：为需要完整分叉体验的用户提供 `copySnapshots: boolean` 选项，默认保持当前行为（不复制）。

2. **快照 Promise 持久化**：当前 `#pendingSnapshots` 仅存在于内存中，如果在快照创建完成前进程崩溃，`rewindFiles()` 无法等待。考虑将 pending 状态也写入磁盘。

3. **查询上下文快照**：允许用户在任意点保存查询上下文（不仅是用户消息边界），支持更细粒度的回滚。

### 9.3 长期探索（>3个月）

1. **分布式 Session 存储**：探索将 session JSONL 存储在数据库或云存储中，支持跨设备会话同步。

2. **增量快照**：当前文件快照是全量的，考虑实现增量快照以减少存储空间和 I/O。

3. **SDK 进程隔离**：当前 SDK 在同一进程中运行，考虑提供可选的子进程隔离模式，提高稳定性。
