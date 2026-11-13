---
id: sdk-query-sessions
batch: 0
title: SDK Query、Session、控制面与 Checkpoint 设计
date: 2026-11-12
status: draft
---

# SDK Query、Session、控制面与 Checkpoint 设计

## 1. 问题与约束

SDK 调用方需要的不只是发送一个 prompt。可靠的查询还包括异步输入输出、权限与控制请求、会话恢复、上下文读取、任务停止，以及按消息恢复文件状态。若这些能力各自维护状态，模型消息、持久化消息和文件快照会失去同一 UUID 的对应关系，取消和恢复也无法形成一致的生命周期。

本功能将这些接口放在同一设计中，因为它们共享三条约束：
- **消息身份**：query、session transcript 和 checkpoint 都以 user message UUID 关联
- **生命周期一致性**：创建、流式输出、控制、停止、恢复和回滚必须经过同一 query/session 状态
- **恢复语义分离但配套**：session 恢复对话，checkpoint 恢复该消息对应的文件状态；两者需要协调，但不能合并成一次不透明的全量恢复

## 2. 设计理由与备选方案

### 公开 API 分层设计

**设计**：SDK 公开 API 分为两层
- 上层：`query()`、`unstable_v2_createSession()`、`listSessions()` 等
- 下层：内部实现模块 `sdkQuery.ts`、`sdkSessions.ts`、`sdkControl.ts`

**备选方案**：
- 单一层 API → 不采用，内部实现细节会暴露给用户
- 三层以上 → 不采用，过度设计

**选择理由**：
- 清晰的公开/内部边界
- 内部实现可独立演进，不影响公开 API
- 便于测试和维护

### 异步输入输出与 UserMessageChannel

**设计**：使用 `UserMessageChannel` 统一处理一次性字符串输入和异步流输入。

**备选方案**：
- 分别提供两套 API → 不采用，用户体验不一致
- 使用回调而非 AsyncGenerator → 不采用，不符合现代 JS 习惯

**选择理由**：
- 统一的输入模型，用户体验一致
- AsyncGenerator 符合现代 JS 异步模式
- 内置队列支持背压

### 持久化 Lease 机制

**设计**：会话持久化是进程全局状态，通过引用计数 Lease 管理。

**备选方案**：
- 每个 query 独立配置 → 不采用，QueryEngine 内部难以支持交错持久化
- 完全禁用并发 queries → 不采用，过度限制使用场景

**选择理由**：
- 限制最小化，仅限制不同 persistSession 值的并发
- 引用计数确保正确清理
- 明确的错误信息告知用户限制

**证据**：`sdkQueryLifecycle.test.ts` 验证了多次 `return()` 只执行一次清理

### parentUuid DAG 恢复

**设计**：使用 `recoverOrphanedParallelToolResults()` 纯函数恢复并行 assistant 分支。

**备选方案**：
- 单 parentUuid 链表遍历 → 不采用，会丢失同一 API 消息的其他 content block 分支
- 存储时展开 DAG → 不采用，存储格式复杂

**选择理由**：
- 纯函数，易于测试
- 保持存储格式简单
- 完整恢复并行分支

**证据**：`sdkSessions.test.ts` 验证了恢复顺序与分页行为

### Session 分叉时不复制文件快照

**设计**：`forkSession()` 创建新会话时，复制 transcript 但不复制文件快照。

**备选方案**：
- 复制所有快照 → 不采用，磁盘空间膨胀，分叉变慢
- 惰性复制 → 不采用，实现复杂度高

**选择理由**：
- 分叉快速，磁盘空间占用小
- 简单可靠
- 分叉通常是为了探索不同方向，不需要完整历史快照

**证据**：fork 测试验证只复制 transcript

### 控制面直接委托现有生产实现

**设计**：所有 SDK 控制方法都直接委托给现有生产实现，不引入影子状态。

**备选方案**：
- 复制生产逻辑 → 不采用，逻辑漂移风险
- 中间层抽象 → 不采用，过度设计

**选择理由**：
- 行为与 CLI 一致
- 避免逻辑重复和漂移
- 利用现有生产测试覆盖

**证据**：`sdkControls.test.ts` 验证了 null 键删除与模型元数据通知

## 3. 目标与非目标

### 目标

- 提供可结束、可中断、可恢复的异步 query 生命周期
- 复用同一消息转换与持久化规则，避免 CLI 与 SDK 行为漂移
- 让控制方法直接操作现有生产状态，不引入影子状态
- 按消息精确关联文件快照和回滚，同时提供无副作用 dry run

### 非目标

- 不重新实现模型传输协议，不把 remote-control 当作 query 默认实现
- 不把 CLI UI 状态复制到 SDK，不把 session 恢复等同于文件系统回滚
- 不用全局 checkpoint 配置共享不同 query 的快照

## 4. 架构、模块与数据流

### 公开 API 层级

```
┌─────────────────────────────────────────────────────────┐
│         Public API (agentSdkTypes.ts)                   │
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

### 内部接口边界

| 模块 | 设计职责 | 公开边界 | 内部依赖 |
|---|---|---|---|
| `agentSdkTypes.ts` | 类型聚合与公开 API 重导出 | 所有公开类型与函数 | `sdkQuery.ts`、`sdkSessionConversation.ts`、`sdkSessions.ts` |
| `sdkQuery.ts` | 创建异步 query，串联消息 channel、控制请求、权限和清理 | `createSdkQuery()` 工厂函数 | `QueryEngine.ask`、`sdkControl.ts`、`fileCheckpointing.ts` |
| `sdkSessionConversation.ts` | 会话包装器，管理后台消费流 | `createSdkSession()`、`resumeSdkSession()`、`promptSdkSession()` | `sdkQuery.ts`、`sdkSessions.ts` |
| `sdkSessions.ts` | 读取、列表、重命名、标记、分叉 JSONL session | `listSdkSessions()`、`getSdkSessionMessages()` 等 | `sessionChainRecovery.ts`、`sessionStoragePortable.ts` |
| `sessionChainRecovery.ts` | 恢复并行 assistant 分支与工具结果 | `recoverOrphanedParallelToolResults()` | 纯函数，无外部依赖 |
| `sdkControl.ts` | 上下文使用、标志/设置、停止任务、重载插件 | `getSdkContextUsage()`、`applySdkFlagSettings()` 等 | `bootstrap/state.ts`、`settings/settings.ts`、`plugins/refresh.ts` |
| `FileCheckpointing` | 按 userMessageId 注册、等待并恢复文件快照 | `FileCheckpointing` 类 | `fileHistory.ts` |

关键原则：所有内部模块都不依赖 CLI 应用状态（`AppState`）之外的 CLI 特有结构，`sdkSessions.ts` 与 `sessionChainRecovery.ts` 甚至不读取 `AppState`，确保 SDK 会话访问器在 CLI 未启动时也可运行。

### 异步输入输出数据流

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

### Query 完整控制流

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

### Session 架构

`SDKSession` 是对 `createSdkQuery()` 的轻量级包装器，内部维护独立的后台消费流：

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
  private async consume(): Promise<void>;
}
```

### parentUuid DAG 结构

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

### DAG 恢复算法

`recoverOrphanedParallelToolResults()` 是纯函数，输入：
- `messages: Map<UUID, T>`：所有消息按 UUID 索引
- `chain: T[]`：从叶节点回溯的主链
- `seen: Set<UUID>`：已在主链中的消息

输出：
- 完整 `chain` 包含所有并行分支
- `recoveredCount`：恢复的消息数

算法步骤：
1. 从主链收集所有 API message ID → anchor point（anchor = 同一 API ID 在主链上的最后一条消息）
2. 收集：按 API ID 分组的所有 assistant 消息、按 assistant UUID 分组的所有 tool result 消息
3. 对每个组，找出不在 seen 中的孤儿
4. 按 timestamp 稳定排序
5. 插入到 anchor point 之后

## 5. 失败语义与工程取舍

### UserMessageChannel 错误与关闭边界

| 操作 | 行为 | 后续操作 |
|---|---|---|
| `push()` 在 `close()` 后 | 抛出 `Error("Cannot stream input after the query closes")` | 不可用 |
| `fail(error)` | 关闭 channel，存储错误 | `iterate()` 会抛出错误 |
| `query.return()` | 触发完整清理流程 | `close()` 安全幂等 |
| `query.interrupt()` | 中止 AbortController，触发模型循环中断 | 仍需调用 `return()` 完成清理 |

### Query 清理保证

| 退出路径 | `cleanupClients` | `runCleanupFunctions` | `flushSessionStorage` | `releasePersistence` |
|---|---|---|---|---|
| 正常 `for await` 完成 | ✓ | ✓ | ✓ | ✓ |
| `query.return()` | ✓ | ✓ | ✓ | ✓ |
| `query.return()` 多次调用 | 仅第一次 | 仅第一次 | 仅第一次 | 仅第一次 |
| 迭代器抛出错误 | ✓ | ✓ | ✓ | ✓ |
| `query.interrupt()` | 需配合 `return()` | 需配合 `return()` | 需配合 `return()` | 需配合 `return()` |

### 工程取舍

- **全局 Lease vs 独立配置**：选择全局 Lease，QueryEngine 内部难以支持交错持久化
- **不复制快照 vs 完整分叉**：选择不复制，分叉快速且磁盘空间占用小
- **纯函数 DAG 恢复 vs 存储展开**：选择纯函数，存储格式简单
- **直接委托 vs 中间抽象**：选择直接委托，避免逻辑漂移

## 6. 现状验收标准

### Query 接口

- `Query` 必须实现 `AsyncGenerator<SDKMessage, void>`
- 必须提供 `interrupt()`、`setPermissionMode()`、`setModel()`、`setMaxThinkingTokens()` 等控制方法
- 必须提供 `supportedCommands()`、`supportedModels()`、`mcpServerStatus()`、`accountInfo()` 等状态查询方法
- 必须提供 `rewindFiles()` 支持 dry run
- 必须提供 `streamInput()` 支持异步流输入

### Session 接口

- `SDKSession` 必须提供 `send()`、`stream()`、`close()` 方法
- 必须实现 `Symbol.asyncDispose`
- 必须提供 `listSessions()`、`getSessionInfo()`、`getSessionMessages()`、`renameSession()`、`tagSession()`、`forkSession()` 等访问器

### Session 恢复

- 必须正确恢复并行 assistant 分支
- 必须正确处理分页
- 分叉时必须复制 transcript 但不复制文件快照

### 控制面

- 所有控制方法必须直接委托给现有生产实现
- `applySdkFlagSettings()` 必须删除 null 键
- 模型变化必须更新 override 和 metadata

## 7. 代码与测试证据

### 状态所有权

| 状态 | 所有者 | 访问边界 | 持久化 |
|---|---|---|---|
| `activePersistenceLease` | `sdkQuery.ts` | 模块级私有 | 否 |
| `UserMessageChannel.queue` | 每个 Query 实例 | Query 内部 | 否 |
| `FileCheckpointing.#pendingSnapshots` | 每个 Query 实例 | Query 内部 | 否 |
| `LocalSdkSession.#messages` | 每个 Session 实例 | Session 内部 | 否 |
| session JSONL 文件 | 文件系统 | `sdkSessions.ts` + `sessionStoragePortable.ts` | 是 |
| 文件历史快照 | 文件系统 | `fileHistory.ts` | 是 |

### 现有测试覆盖

| 测试文件 | 覆盖能力 |
|---|---|
| `sdkQueryLifecycle.test.ts` | `query.return()` 清理执行一次 |
| `sdkSessions.test.ts` | 列出/读取/重命名/标记/分叉会话 |
| `sdkSessions.test.ts` | 恢复并行 assistant 分支 |
| `sdkSessions.test.ts` | 不恢复无关联分支 |
| `sdkSessions.test.ts` | 消息分页 |
| `sdkControls.test.ts` | 读取 usage/settings、重载插件、停止任务 |
| `sdkControls.test.ts` | 删除 null 标志、模型元数据通知 |
| `sdkRewind.test.ts` | 文件回滚与 dry run |
| `sdkMcp.test.ts` | MCP 服务器管理 |
| `sdkRemoteControl.test.ts` | 远程控制桥接 |
| `sdkCron.test.ts` | Cron 任务调度 |

### 隔离性验证

- `sdkSessions.ts` 不读取 `AppState` ✓
- `sessionChainRecovery.ts` 是纯函数 ✓
- DAG 恢复不读取 analytics 或 CLI UI 状态 ✓
- 控制面不复制生产状态逻辑 ✓

## 8. 文件覆盖与相关子系统

本设计的覆盖率文件位于 [Coverage](../../architecture/coverage/sdk-query-sessions.yaml)。

### 相关文件

- `src/entrypoints/agentSdkTypes.ts`：公开 API 类型与重导出
- `src/entrypoints/sdk/sdkQuery.ts`：Query 创建与生命周期
- `src/entrypoints/sdk/sdkSessionConversation.ts`：Session 包装器
- `src/entrypoints/sdk/sdkSessions.ts`：Session 访问器
- `src/entrypoints/sdk/sessionChainRecovery.ts`：DAG 恢复算法
- `src/entrypoints/sdk/sdkControl.ts`：控制面方法
- `src/entrypoints/sdk/fileCheckpointing.ts`：文件快照与回滚

### 相关子系统

- SDK Type Generation：SDK 类型生成
- Session Persistence：会话持久化
- File History：文件历史与回滚

## 9. 改进建议

### 短期改进（<1个月）

1. **明确 `interrupt()` 与 `return()` 的组合契约**：当前设计要求调用 `interrupt()` 后仍需调用 `return()` 完成清理，但这容易被误用。建议在 `interrupt()` 内部启动清理但仍允许 `return()` 安全调用。

2. **增加超时机制**：`UserMessageChannel` 和 MCP 连接当前没有超时配置，可能导致查询挂起。建议添加可配置的超时选项。

3. **改进并发 query 限制**：当前仅限制 `persistSession` 不同的并发，建议实现真正的交错持久化支持，或提供更明确的错误恢复路径。

### 中期改进（1-3个月）

1. **Session 分叉时可选复制快照**：为需要完整分叉体验的用户提供 `copySnapshots: boolean` 选项，默认保持当前行为（不复制）。

2. **快照 Promise 持久化**：当前 `#pendingSnapshots` 仅存在于内存中，如果在快照创建完成前进程崩溃，`rewindFiles()` 无法等待。建议将 pending 状态也写入磁盘。

3. **查询上下文快照**：允许用户在任意点保存查询上下文（不仅是用户消息边界），支持更细粒度的回滚。

### 长期探索（>3个月）

1. **分布式 Session 存储**：探索将 session JSONL 存储在数据库或云存储中，支持跨设备会话同步。

2. **增量快照**：当前文件快照是全量的，建议实现增量快照以减少存储空间和 I/O。

3. **SDK 进程隔离**：当前 SDK 在同一进程中运行，建议提供可选的子进程隔离模式，提高稳定性。
