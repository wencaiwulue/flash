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

---

### 模块设计卡：createSdkQuery/UserMessageChannel

**入口签名与关键类型**
```typescript
export function createSdkQuery({
  prompt: string | AsyncIterable<SDKUserMessage>,
  options?: InternalOptions,
  initialMessages?: Message[] | Promise<Message[]>,
  session?: { id: string; projectDir?: string | Promise<string | undefined> },
  remoteControlFactory?: typeof connectDaemonBridge,
  organizationUUID?: string,
}): InternalQuery

export class UserMessageChannel {
  push(message: SDKUserMessage): void
  close(): void
  fail(error: unknown): void
  iterate(): AsyncGenerator<SDKUserMessage, void>
}
```

**输入输出**
- 输入：字符串 prompt 或异步可迭代用户消息流，可选配置（工具、模型、权限、持久化、环境变量、MCP 服务器等）
- 输出：`InternalQuery` 异步生成器，产出 `SDKMessage` 流，附带控制方法（`interrupt()`、`setPermissionMode()`、`setModel()`、`getSettings()`、`rewindFiles()`、`streamInput()`、`close()` 等）

**状态所有权**
- `UserMessageChannel` 拥有私有状态：
  - `#queue: SDKUserMessage[]`：缓冲的用户消息队列
  - `#closed: boolean`：通道关闭标志
  - `#error: unknown`：失败时存储的错误
  - `#waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>`：等待新消息的 Promise 队列
- `createSdkQuery` 创建的闭包拥有：
  - `abortController: AbortController`：用于中断模型循环
  - `channel: UserMessageChannel`：输入通道实例
  - `setupPromise`： Promise<any>：懒加载初始化 Promise
  - `releasePersistence`：(()：：void)：| undefined：持久化租赁释放函数
  - `cleanupPromise`：：Promise<void> | undefined：确保清理只执行一次

**完整生命周期**
```
1. 工厂函数创建阶段
   ├─ 创建 AbortController
   ├─ 创建 UserMessageChannel
   ├─ 处理 prompt 输入：：
   │  ├─ 字符串 →：单条消息 push + close
   │  └─ AsyncIterable →：后台消费并 push
   └─ 返回增强的异步生成器对象

2. 懒加载初始化阶段（首次调用任一方时触发）
   ├─ acquireSessionPersistence(persistSession)
   ├─ 设置 bootstrap/state：（cwd：，clientType：，sessionSource：等）
   ├─ 处理 session：切换（：如提供）
   ├─ 应用环境变量
   ├─ 初始化 FileCheckpointing
   ├─ 连接 MCP：服务器
   ├─ 组装工具池
   └─ 初始化权限上下文

3. 消息消费阶段（run() 生成器）
   ├─ 等待并消费 channel.iterate() 中的用户消息
   ├─ 对每条非合成消息：：
   │  ├─ 调用 fileCheckpointing.makeSnapshot(userMsg.uuid)
   │  └─ 调用 QueryEngine.ask() 并 yield 结果
   └─ 正常结束或异常抛出

4. 清理阶段（finally 块或 return() 调用）
   ├─ 确保只执行一次（cleanupPromise）
   ├─ 停止 remoteController：（：如活跃）
   ├─ cleanupClients(MCP：连接：)
   ├─ runCleanupFunctions()
   ├─ flushSessionStorage()
   └─ releasePersistence()
```

**失败与清理**
- `push()` 在 `close()` 后抛出：`Error("Cannot stream input after the query closes")`
- `fail(error)`：：关闭通道，存储错误，`iterate()` 在队列耗尽后抛出该错误
- 多次调用 `return(undefined)` 安全，只有第一次执行实际清理
- `interrupt()`：：仅触发 `abortController.abort()`：仍需调用 `return()` 完成清理
- `close()`：：组合 `abort()` + `return()` 的便捷方法

**设计取舍与备选**
- 选择懒加载而非立即初始化：减少不必要的资源消耗，适应创建但从未消费的查询
- 选择 `UserMessageChannel` 封装而非直接暴露队列：：封装背压和错误传播逻辑
- 选择闭包隐藏内部状态而非类：减少公开表面，避免状态逃逸
- 备选：单一层 API →：拒绝：内部实现细节会暴露
- 备选：回调而非 AsyncGenerator →：拒绝：不符合现代 JS 习惯

**源码测试证据**
- `tests/sdkQueryLifecycle.test.ts`：验证多次 `return()`：只执行一次清理
- `tests/sdkRewind.test.ts`：验证与 `enableFileCheckpointing`：选项的交互
- 源码：：`src/utils/sdkQuery.ts`：，第 120-170 行：

---

### 模块设计卡：createSdkSession/resumeSdkSession

**入口签名与关键类型**
```typescript
export function createSdkSession(options: SDKSessionOptions): SDKSession
export function resumeSdkSession(sessionId: string, options: SDKSessionOptions): SDKSession
export async function promptSdkSession(
  text: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage>

interface SDKSession {
  readonly sessionId: string
  send(message: string | SDKUserMessage): Promise<void>
  stream(): AsyncGenerator<SDKMessage, void>
  close(): void
  [Symbol.asyncDispose](): Promise<void>
}

class LocalSdkSession implements SDKSession {
  readonly #channel = new UserMessageChannel()
  readonly #query: ReturnType<typeof createSdkQuery>
  readonly #background: Promise<void>
  readonly #messages: SDKMessage[] = []
  #sessionId: string | undefined
  readonly #waiters = new Set<() => void>()
  #closed = false
  #error: unknown
}
```

**输入输出**
- `createSdkSession` 输入：`SDKSessionOptions`：（model：、env：：等）
- `resumeSdkSession`：输入：`sessionId`： + 选项：
- 输出：`SDKSession`：实例，支持 `send()`/`stream()`/`close()`
- `promptSdkSession`：便捷方法：输入文本 +：选项，输出最终 `SDKResultMessage`

**状态所有权**
- `LocalSdkSession` 私有状态：
  - `#channel: UserMessageChannel`：输入通道
  - `#query: InternalQuery`：底层 query 实例
  - `#background: Promise<void>`：：后台消费循环 Promise
  - `#messages: SDKMessage[]`：已接收消息缓冲区
  - `#sessionId: string | undefined`：会话 ID：（从第一条含 session_id 的消息获取）：
  - `#waiters: Set<() => void>()：：等待新消息的 Promise resolve：函数集合
  - `#closed: boolean`：：会话关闭标志
  - `#error: unknown`：后台消费失败时的错误

**完整生命周期**
```
1. 创建阶段（：createSdkSession）
   ├─ 实例化 LocalSdkSession：
   ├─ 创建 UserMessageChannel
   ├─ 调用 createSdkQuery，传入 channel.iterate() 作为 prompt
   └─ 启动后台 consume()：循环

2. 恢复阶段（：resumeSdkSession）
   ├─ 调用 resolveSessionFilePath(sessionId)：定位会话文件
   ├─ 调用 loadSdkSessionTranscript()：加载历史消息
   └─ 同创建阶段，但传入 session 和 initialMessages 给 createSdkQuery

3. 交互阶段
   ├─ 调用 send(message)：：
   │  ├─ 检查 #closed，如关闭则抛出
   │  └─ push 到 #channel
   └─ 消费 stream()：：
      ├─ 从 #messages shift() 消息并 yield
      ├─ 如遇到 result 消息则 return
      ├─ 如 #error 存在则 throw
      ├─ 如 #closed 且消息为空则 return
      └─ 否则加入 #waiters 等待通知

4. 后台消费循环（consume()）
   ├─ for await (const msg of #query)
   │  ├─ 如消息含 session_id 则更新 #sessionId
   │  ├─ push 到 #messages
   │  └─ notify() 所有 waiters
   └─ 捕获错误，设置 #error，notify()

5. 关闭阶段
   ├─ close()：：
   │  ├─ 设置 #closed = true
   │  ├─ notify()：所有 waiters
   │  ├─ close()：#channel
   │  └─ interrupt()：#query
   └─ Symbol.asyncDispose()：：
      └─ 组合 close() + await #background
```

**失败与清理**
- `send()` 在 `close()` 后抛出
- 后台循环失败时，`stream()` 会抛出存储的错误
- `Symbol.asyncDispose()` 确保资源释放，支持 `using` 语法

**设计取舍与备选**
- 选择后台消费而非让调用方直接消费 query：简化 API，提供消息缓冲和会话 ID 捕获
- 选择仅在后台消费而非同时支持两种模式：避免状态同步复杂性
- 备选：`promptSdkSession` 可内联使用，不需要完整会话对象

**源码测试证据**
- `tests/sdkSessions.test.ts`：验证会话创建和分叉（间接覆盖）
- 源码：`src/utils/sdkSessionConversation.ts`：

---

### 模块设计卡：sdkSessions DAG 恢复

**入口签名与关键类型**
```typescript
// 会话访问器
export async function listSdkSessions(options?: {
  dir?: string
  limit?: number
  offset?: number
  includeWorktrees?: boolean
}): Promise<SDKSessionInfo[]>

export async function getSdkSessionInfo(
  sessionId: string,
  options?: { dir?: string },
): Promise<SDKSessionInfo | undefined>

export async function getSdkSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>

export async function renameSdkSession(
  sessionId: string,
  title: string,
  options?: { dir?: string },
): Promise<void>

export async function tagSdkSession(
  sessionId: string,
  tag: string | null,
  options?: { dir?: string },
): Promise<void>

export async function forkSdkSession(
  sessionId: string,
  options?: { dir?: string; upToMessageId?: string; title?: string },
): Promise<{ sessionId: string }>

export async function loadSdkSessionTranscript(
  sessionId: string,
  options?: { dir?: string },
): Promise<Message[]>

// DAG 恢复
export function recoverOrphanedParallelToolResults<T extends RecoverableTranscriptMessage>(
  messages: Map<UUID, T>,
  chain: T[],
  seen: ReadonlySet<UUID>,
): { chain: T[]; recoveredCount: number }

type RecoverableTranscriptMessage = {
  type: string;
  uuid: UUID;
  parentUuid?: UUID | null;
  timestamp?: string;
  message?: unknown;
}
```

**输入输出**
- `getSdkSessionMessages` 输入：`sessionId`： +：可选 offset/limit/includeSystemMessages：
- 输出：按正确顺序恢复的 `SessionMessage[]`：数组：
- `forkSdkSession` 输出：新 `sessionId`：所有消息重写 UUID，保持 parent 关系正确
- `recoverOrphanedParallelToolResults`：输入：消息 Map、主链、已见 Set；输出：完整链 + 恢复计数

**状态所有权**
- `listSdkSessions`/`getSdkSessionMessages`：纯函数，无持久状态，仅从文件系统读取
- `recoverOrphanedParallelToolResults`：纯函数，不修改输入，仅构建新数组
- `forkSdkSession`：：生成新 UUID，但保持分叉来源追踪（`forkedFrom`：元数据）

**完整生命周期（：消息读取与 DAG 恢复）**
```
1. getSdkSessionMessages(sessionId)
   ├─ validateUuid(sessionId)
   ├─ resolveSessionFilePath(sessionId, options.dir)
   └─ readTranscriptEntries(filePath)：：
      └─ 逐行解析 JSONL，过滤 isSidechain：条目

2. buildMainChain(entries)
   ├─ 构建 Map<UUID, entry> 索引
   ├─ 从最后一条（叶）：开始，通过 parentUuid 回溯到根
   ├─ 构建初始 chain 数组
   ├─ 收集 seen Set =：链上消息 UUID
   └─ 调用 recoverOrphanedParallelToolResults(messages, chain, seen)：

3. DAG 恢复算法
   ├─ 收集：链上 assistant 消息的 API message.id → anchor map
   │  (anchor = 同一 API ID 在主链上的最后一条消息)
   ├─ 分组：：
   │  ├─ 按 API message.id 分组所有 assistant 消息
   │  └─ 按 parentUuid 分组所有 tool result 消息
   ├─ 对每个 API 组：：
   │  ├─ 找出不在 seen 中的孤儿 sibling
   │  ├─ 找出对应 orphan tool results
   │  ├─ 按 timestamp 稳定排序
   │  └─ 插入到 anchor point 之后
   └─ 返回完整 chain + recoveredCount

4. 转换为 SDK 类型
   ├─ toSessionMessage(entry, fallbackSessionId)
   ├─ 过滤系统消息（如不 includeSystemMessages）
   └─ 应用 offset/limit 分页

5. forkSdkSession
   ├─ 读取源会话 entries 和 content-replacements
   ├─ 确定 cutoff（：如提供 upToMessageId）：
   ├─ 为每条消息生成新 UUID
   ├─ 重建 parentUuid 指向新 UUID
   ├─ 写入新 JSONL 文件（forkId.jsonl）
   └─ 返回 { sessionId: forkId }
```

**失败与清理**
- UUID：验证失败返回空数组/undefined
- 会话文件不存在返回空数组/undefined
- 无效 JSON 行被忽略（容忍部分写入）
- 分叉时消息 UUID 全部重写，避免与源会话冲突

**设计取舍与备选**
- 选择纯函数恢复而非存储时展开 DAG：保持存储格式简单，向后兼容
- 选择从叶回溯而非从根遍历：适应 JSONL 追加写入模式（最新消息在文件尾）
- 选择按 timestamp 稳定排序而非 JSONL 顺序：JSONL 顺序可能不确定
- 选择分叉时不复制文件快照：分叉快速，磁盘占用小
- 备选：全局消息 ID →：拒绝：UUID 已足够且无协调开销
- 备选：存储时预先计算完整链 →：拒绝：写入延迟增加

**源码测试证据**
- `tests/sdkSessions.test.ts`：验证：
  - 并行分支恢复
  - 不恢复无关联分支
  - 分页正确
  - 分叉时 UUID：重写
- `tests/sessionChainRecovery.test.ts`：验证纯函数恢复逻辑
- 源码：`src/utils/sdkSessions.ts`、`src/utils/sessionChainRecovery.ts`

---

### 模块设计卡：sdkControl

**入口签名与关键类型**
```typescript
type SdkAppStateContext = {
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
}

export async function getSdkContextUsage(
  context: SdkAppStateContext & {
    messages: Parameters<typeof collectContextData>[0]['messages']
    tools: Parameters<typeof collectContextData>[0]['options']['tools']
    systemPrompt?: string
    appendSystemPrompt?: string
  },
)

export function applySdkFlagSettings(settings: Record<string, unknown>): void

export function getSdkSettings(
  appState: AppState,
): ReturnType<typeof getSettingsWithSources> & {
  applied: { model: string; effort: string | null }
}

export async function stopSdkTask(
  taskId: string,
  context: SdkAppStateContext,
): Promise<void>

export async function reloadSdkPlugins(
  context: SdkAppStateContext & {
    cwd: string
    loadCommands: typeof getCommands
    mcpServers: McpServerStatus[]
    agents?: Parameters<typeof parseAgentsFromJson>[0]
  },
): Promise<SDKControlReloadPluginsResponse>
```

**输入输出**
- `applySdkFlagSettings`：：输入：键值对设置（`model`：、`effort`：等）；无输出
- `getSdkSettings`：：输出：带来源的设置 + 实际应用的 `{ model, effort }`
- `reloadSdkPlugins` 输出：：`{ commands, agents, plugins, mcpServers, error_count }`
- 所有函数都通过 `SdkAppStateContext`：间接访问/修改状态，而非直接依赖全局

**状态所有权**
- 模块无自身持久状态
- 通过 `getAppState()/setAppState()`：访问调用方提供的状态
- `applySdkFlagSettings`：：修改 `bootstrap/state`：中的全局标志设置
- 所有控制方法直接委托给现有生产实现（无影子状态）

**完整生命周期与控制方法到生产状态映射表**

|：SDK：控制方法 |：委托到生产实现：|：状态变更 |
|：|：|：|
| `getContextUsage()`：：|：`collectContextData()`：：|：只读 |
| `applyFlagSettings(settings)`：：| `setFlagSettingsInline()`、`setMainLoopModelOverride()`：：|：修改标志 + 模型覆盖 + `notifySessionMetadataChanged()`：|
| `getSettings()`：|：`getSettingsWithSources()`、`getMainLoopModel()`：：|：只读 |
| `setModel(model)`：|：`setMainLoopModelOverride()` + `notifySessionMetadataChanged()`：|：修改 `appState.mainLoopModel`：|
| `setMaxThinkingTokens(n)`：|：直接设置内部 `thinkingConfig`：|：修改 `setup.thinkingConfig`：|
| `setPermissionMode(mode)`：|：直接修改 `appState.toolPermissionContext.mode`：：|：修改权限模式
| `stopTask(taskId)`：|：`stopTask()`：|：修改任务状态
| `reloadPlugins()`：|：`refreshActivePlugins()`、`loadAllPluginsCacheOnly()`：：|：刷新插件 + 重载命令 + 重建工具池
| `supportedCommands()`：|：`getCommands()`：：|：只读 |
| `supportedModels()`：|：`getModelOptions()`：：|：只读 |
| `mcpServerStatus()`：：|：从 `appState.mcp.clients`：：映射 |：只读 |
| `accountInfo()`：|：从 `getOauthAccountInfo()`：：读取 |：只读 |

**`applyFlagSettings`：特殊行为**
```typescript
// 输入设置与现有设置合并
const merged = { ...getFlagSettingsInline(), ...settings }

// null 值表示删除
for (const key of Object.keys(merged)) {
  if (merged[key] === null) delete merged[key]
}

// 'model' 键触发特殊处理
if ('model' in settings) {
  setMainLoopModelOverride(settings.model == null ? undefined : String(settings.model))
}

// 模型变更时通知元数据变化
const nextModel = getMainLoopModel()
if (nextModel !== previousModel) {
  notifySessionMetadataChanged({ model: nextModel })
}
```

**失败与清理**
- `stopSdkTask`：传播 `stopTask()`：的错误（如任务不存在时 `code: 'not_found'`）
- `reloadSdkPlugins`：捕获插件错误，返回 `error_count`：而非抛出

**设计取舍与备选**
- 选择直接委托现有生产实现而非复制逻辑：避免行为漂移，利用现有测试覆盖
- 选择 `SdkAppStateContext`：间接访问而非全局：便于测试，状态可注入
- 选择 null 表示删除而非单独的 delete API：简化公开 API
- 备选：中间抽象层 →：拒绝，过度设计

**源码测试证据**
- `tests/sdkControls.test.ts`：验证：
  - null 键删除
  - 模型元数据通知
  - 上下文/设置/插件重载工作流
- 源码：`src/utils/sdkControl.ts`：

---

### 模块设计卡：FileCheckpointing

**入口签名与关键类型**
```typescript
export type UpdateFileHistoryState = (
  updater: (previous: FileHistoryState) => FileHistoryState,
) => void

// 共享 CLI/SDK 回滚逻辑
export async function rewindFileCheckpoint(
  userMessageId: UUID,
  state: FileHistoryState,
  updateFileHistoryState: UpdateFileHistoryState,
  dryRun: boolean,
): Promise<RewindFilesResult>

// 每个 Query 实例的快照簿记
export class FileCheckpointing {
  readonly #pendingSnapshots = new Map<string, Promise<void>>()
  readonly #getState: () => FileHistoryState
  readonly #updateState: UpdateFileHistoryState
  readonly #makeSnapshot: typeof fileHistoryMakeSnapshot

  constructor(
    getState: () => FileHistoryState,
    updateState: UpdateFileHistoryState,
    makeSnapshot = fileHistoryMakeSnapshot,
  )

  makeSnapshot(messageId: UUID): Promise<void>
  rewindFiles(
    userMessageId: string,
    options: { dryRun?: boolean } = {},
  ): Promise<RewindFilesResult>
}
```

**输入输出**
- `makeSnapshot(messageId)`：输入：用户消息 UUID；：输出：快照完成 Promise：
- `rewindFiles(userMessageId, { dryRun? })`：输出：：
  - `dryRun: true`：：`{ canRewind: true, filesChanged, insertions, deletions }`
  - `dryRun: false`：：`{ canRewind: true }`或 `{ canRewind: false, error }`

**状态所有权**
- `FileCheckpointing`：私有状态：
  - `#pendingSnapshots: Map<string, Promise<void>>`：：按消息 ID 跟踪进行中的快照
  - `#getState: () => FileHistoryState`：：状态读取器
  - `#updateState: UpdateFileHistoryState`：：状态更新器
- 关键设计：每个 Query 实例有自己的 `FileCheckpointing`：，：快照与查询生命周期绑定，但实际快照数据存储在共享 `appState.fileHistory` 中
- 全局 Lease 机制仅约束 `persistSession` 选项，不约束文件检查点（检查点始终可用）

**完整生命周期**
```
1. 实例化（createSdkQuery 初始化阶段）
   └─ new FileCheckpointing(() => appState.fileHistory, updater => ...)

2. 接收用户消息（createSdkQuery run() 阶段）
   ├─ 对非合成消息：
   │  └─ await fileCheckpointing.makeSnapshot(message.uuid)
   └─ 进入 QueryEngine.ask() 模型循环

3. makeSnapshot(messageId) 流程
   ├─ 检查 #pendingSnapshots 中是否已有该 ID
   │  ├─ 存在：返回现有 Promise（去重）
   │  └─ 不存在：创建新 Promise
   └─ 调用 fileHistoryMakeSnapshot(updateState, messageId)
      └─ （实际快照逻辑在 fileHistory.ts 中）

4. rewindFiles(userMessageId, { dryRun? }) 流程
   ├─ 检查 #pendingSnapshots 中该 ID 是否有进行中的快照
   │  └─ 存在：await 该 Promise（确保回滚到最新状态）
   └─ 调用 rewindFileCheckpoint()：：
      ├─ dryRun: true → fileHistoryGetDiffStats()
      └─ dryRun: false → fileHistoryRewind()

5. 清理阶段
   └─ 无特殊清理，#pendingSnapshots 随 Query 实例回收
```

**Checkpoint Dry-Run 与恢复结果分支**

| dryRun | 操作 | 返回 |
|---|---|---|
| `true` | 读取 `fileHistoryGetDiffStats()`，不修改文件 | `{ canRewind: true, filesChanged, insertions, deletions }` |
| `false` | 调用 `fileHistoryRewind()` 恢复文件 | 成功：`{ canRewind: true }`；失败：`{ canRewind: false, error }` |
| 检查点未启用 | 无操作 | `{ canRewind: false, error: "File rewinding is not enabled" }` |
| 消息 ID 未知 | 无操作 | `{ canRewind: false, error: "No file checkpoint found" }` |

**失败与清理**
- `makeSnapshot()`：错误存储在 Promise 中，`rewindFiles()`：会检查并返回该错误
- 同一 `messageId` 多次调用 `makeSnapshot()`：返回同一 Promise（幂等）
- `rewindFiles()`：先等待对应的快照完成，确保回滚到一致状态

**设计取舍与备选**
- 选择每个 Query 实例有自己的 `FileCheckpointing`：而非单例：：隔离并发查询的快照状态
- 选择 `#pendingSnapshots`：跟踪进行中的快照而非立即返回：确保 `rewindFiles()` 总能等待对应的快照
- 选择文件检查点独立于会话持久化：即使不持久化会话历史，也能回滚文件
- 备选：快照存储在会话 JSONL 中 →：拒绝：，文件快照很大且需要随机访问
- 备选：全局快照配置 →：拒绝：，查询间不应互相影响

**源码测试证据**
- `tests/sdkRewind.test.ts`：验证：
  - dryRun：不修改文件
  - rewind 等待异步快照
  - 按查询隔离启用/禁用状态
  - 检查点备份不启用会话持久化
- 源码：`src/utils/fileCheckpointing.ts`：

---

### 模块设计卡：Session Persistence Lease

**入口签名与关键类型**
```typescript
// 模块级私有状态
let activePersistenceLease:
  | {
      persistSession: boolean
      previousDisabled: boolean
      users: number
    }
  | undefined

function acquireSessionPersistence(persistSession: boolean): () => void
```

**输入输出**
- `acquireSessionPersistence(persistSession)`：：输入：布尔标志
- 输出：：释放函数 `() => void`：（幂等，可多次安全调用）
- 抛出：当存在活跃 lease 且 `persistSession` 值不同时

**状态所有权**
- 模块级私有单例状态：：
  - `activePersistenceLease`：：当前活跃的 lease（如存在）：
    - `persistSession: boolean`：当前 lease 的持久化设置
    - `previousDisabled: boolean`：获取 lease 前的 `isSessionPersistenceDisabled()` 值
    - `users: number`：：引用计数
- 关键约束：会话持久化是进程全局状态（QueryEngine 内部假设），因此 SDK 必须序列化不同 `persistSession` 值的并发查询

**完整生命周期**
```
1. acquireSessionPersistence(persistSession)
   ├─ 检查 activePersistenceLease 是否存在
   │  ├─ 存在且值不同 → throw Error
   │  ├─ 存在且值相同 → users++，返回释放函数
   │  └─ 不存在 → 创建新 lease
   ├─ 保存 previousDisabled = isSessionPersistenceDisabled()
   ├─ 设置 setSessionPersistenceDisabled(previousDisabled || !persistSession)
   ├─ users = 1
   └─ 返回释放函数

2. 释放函数 ()
   ├─ 检查已释放标志 → 如已释放直接返回
   ├─ users--
   ├─ if users === 0:
   │  ├─ 恢复 setSessionPersistenceDisabled(previousDisabled)
   │  └─ activePersistenceLease = undefined
   └─ 设置已释放标志
```

**失败与清理**
- 冲突时抛出：`Error("Concurrent SDK queries with different persistSession options are not supported because session persistence is process-global")`
- 释放函数幂等：多次调用安全
- `createSdkQuery`：在 `setupPromise` 失败路径中也调用 `releasePersistence?.()`
- 清理阶段总是调用 `releasePersistence()`（在 finally 块中）

**Async Input Backpressure / Close / Error 流程**

```
UserMessageChannel 背压与关闭语义：

push(message)
  ├─ if closed → throw "Cannot stream input after the query closes"
  ├─ queue.push(message)
  └─ notify() 所有 waiters

close()
  ├─ closed = true
  └─ notify() 所有 waiters

fail(error)
  ├─ this.error = error
  ├─ closed = true
  └─ notify() 所有 waiters

iterate() → AsyncGenerator
  loop:
    if queue not empty → yield queue.shift()
    else if error → throw error
    else if closed → return
    else → wait on new Promise(resolve => waiters.push({ resolve, reject }))
```

**Per-Turn Result 与底层 Query 生命周期**

```typescript
// SDKMessage 类型与 per-turn 边界
type SDKMessage =
  | SDKUserMessage      // 用户输入（包括合成）
  | SDKAssistantMessage // 模型输出（可能含 tool_use）
  | SDKToolResultMessage // 工具结果
  | SDKResultMessage    // turn 最终结果
  | SDKSystemMessage    // 系统事件（compact_boundary、task_progress 等）

// createSdkQuery run() 为每条用户消息产生一 "turn"
for await (const userMsg of channel.iterate()) {
  if (!userMsg.isSynthetic) {
    await fileCheckpointing.makeSnapshot(userMsg.uuid)
  }
  for await (const output of ask({
    prompt: userMsg.message.content,
    promptUuid: userMsg.uuid,
    /* ... */
  })) {
    yield output  // 所有模型消息、工具消息、最终 result
  }
}
// 最后一条 yield 通常是 type: 'result'
// 此后 userMsg 流关闭或失败
```

**设计取舍与备选**
- 选择全局 Lease 而非每个查询独立配置：QueryEngine 内部难以支持交错持久化
- 选择引用计数而非简单互斥：支持相同选项的并发查询
- 选择在首次调用时获取而非创建时：适应创建但从未初始化的查询
- 备选：完全禁用并发查询 →：拒绝：过度限制使用场景
- 备选：每个查询独立会话存储 →：拒绝：实现复杂且与现有 QueryEngine 架构不兼容

**源码测试证据**
- `tests/sdkRewind.test.ts`：验证并发选项冲突检测与状态恢复
- `tests/sdkQueryLifecycle.test.ts`：验证清理执行一次
- 源码：`src/utils/sdkQuery.ts`：，第 74-119 行

---

### 附加文件：sdkEventQueue 与 sdkHeapDumpMonitor

**职责说明**

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/utils/sdkEventQueue.ts` | SDK 事件队列，用于任务开始/进度/通知、会话状态变化 | 活跃 |
| `src/utils/sdkHeapDumpMonitor.ts` | SDK 内存监控存根 | 存根（`{ enabled: false }`）：

**sdkEventQueue 关键行为**
```typescript
type SdkEvent =
  | { type: 'system'：，subtype: 'task_started'，：... }
  | { type: 'system'：，subtype: 'task_progress'，：... }
  | { type: 'system'：，subtype: 'task_notification'，：... }
  | { type: 'system'：，subtype: 'session_state_changed'，：... }

const MAX_QUEUE_SIZE = 1000
const queue: SdkEvent[] = []

export function enqueueSdkEvent(event: SdkEvent): void
  // 仅在非交互模式下排队（TUI 模式下不消费）
  // 队列满时 shift 最旧事件（容量限制）

export function drainSdkEvents(): Array<SdkEvent & { uuid, session_id }>
  // 清空队列，为每条事件添加 uuid 和 session_id
  // 由 SDK 输出流定期调用

export function emitTaskTerminatedSdk(taskId, status, opts): void
  // 便捷函数发送 task_notification 事件
  // 用于不经过 XML 通知解析器的退出路径
```

**与 query-core/session-persistence 关系**
- `sdkEventQueue`：是附加层，不吞并或替代 session-persistence 核心
- 事件队列仅在 SDK/headless 模式下激活，TUI 模式下事件通过 XML 通知解析
- session-persistence 负责持久化消息历史，sdkEventQueue 负责临时运行时事件流
- 两者通过 `session_id`：关联，但独立存储和消费

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
