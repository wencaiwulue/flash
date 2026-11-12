---
id: session-persistence
batch: 3
title: Session Persistence 会话记录、恢复与文件历史设计
date: 2026-11-12
status: draft
---

# Session Persistence 会话记录、恢复与文件历史设计

## 1. 问题与核心约束

会话持久化需要解决三个核心问题：
1. **原子写入与崩溃恢复**：进程崩溃时不丢失已确认消息，支持部分修复
2. **大文件高效读写**：会话可增长到数GB，需避免启动时全量解析
3. **DAG 结构保持**：并行工具调用产生的多分支需在恢复时完整重建

**关键约束**：
- 与 SDK `sdk-query-sessions` 共享底层存储格式，但职责分离
- 不重新实现文件检查点（属于 SDK 设计范围）
- 支持 `--resume`、`--fork`、`--continue` 等 CLI 用例

### 目标

- JSONL 追加写入，无原地改写（除 tombstone 移除外）
- 从崩溃中安全恢复：最新消息可能在队列中但未刷盘
- 大文件启动时仅读取头尾即可展示会话列表
- 支持消息 UUID 链的完整重建，包括并行分支

### 非目标

- 不改变文件检查点的现有实现（留待 SDK 设计文档）
- 不实现分布式会话同步
- 不提供实时多进程协作写入同一 session

## 2. JSONL 格式规范

### 2.1 物理存储结构

每个会话是单个 `.jsonl` 文件：
- 路径：`~/.claude/projects/<sanitized-project-path>/<session-id>.jsonl`
- 编码：UTF-8，LF 行结尾
- 权限：0o600（仅用户可读可写）
- 最大尺寸：无硬性限制，但 `MAX_TRANSCRIPT_READ_BYTES` 限制单次读取 50MB

**目录创建**：惰性创建，首次写入时递归创建父目录。

### 2.2 行类型设计

JSONL 中每行是一个独立 JSON 对象，由 `type` 字段区分：

| type | 说明 | 参与 parentUuid 链 | 持久化到远程 |
|------|-----|------------------|------------|
| `user` | 用户消息 | 是 | 是 |
| `assistant` | 助手消息 | 是 | 是 |
| `attachment` | 附件消息 | 是 | 是 |
| `system` | 系统消息（包括 compact_boundary） | 是 | 是 |
| `progress` | 进度消息（仅旧版本存在） | 否 | 否 |
| `custom-title` | 自定义会话标题 | 否 | 否 |
| `ai-title` | AI 生成标题 | 否 | 否 |
| `last-prompt` | 最后一条提示摘要 | 否 | 否 |
| `tag` | 会话标签 | 否 | 否 |
| `agent-name` | Agent 名称 | 否 | 否 |
| `agent-color` | Agent 颜色 | 否 | 否 |
| `agent-setting` | Agent 设置 | 否 | 否 |
| `mode` | 会话模式（coordinator/normal） | 否 | 否 |
| `worktree-state` | Worktree 状态 | 否 | 否 |
| `pr-link` | PR 链接 | 否 | 否 |
| `file-history-snapshot` | 文件历史快照 | 否 | 否 |
| `attribution-snapshot` | 归因快照 | 否 | 否 |
| `content-replacement` | 内容替换记录 | 否 | 否 |
| `marble-origami-commit` | 上下文折叠提交 | 否 | 否 |
| `marble-origami-snapshot` | 上下文折叠快照 | 否 | 否 |
| `queue-operation` | 队列操作 | 否 | 否 |

### 2.3 核心消息字段

所有参与链的消息（user/assistant/attachment/system）包含：

```typescript
type TranscriptMessage = {
  uuid: UUID;                    // 消息唯一 ID
  parentUuid: UUID | null;       // 前驱消息 ID，null 表示根
  logicalParentUuid?: UUID;      // 逻辑前驱（用于 compact boundary 跨越）
  isSidechain?: boolean;         // 是否为 sidechain（agent 子会话）
  teamName?: string;
  agentName?: string;
  promptId?: string;
  agentId?: string;
  // ... 消息内容字段（type-specific）
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  sessionId: UUID;
  version?: string;
  gitBranch?: string;
  slug?: string;
  timestamp: string;
};
```

**关键决策**：每条消息都写入完整 `sessionId`，而非仅在文件头写一次。

| 备选方案 | 代价 | 选择 | 证据 |
|---------|------|------|------|
| 文件头单次写入 sessionId | 崩溃时部分写入的文件难以识别 | 每条消息写入 sessionId | 代码中所有 TranscriptMessage 都包含 sessionId 字段 |
| 使用文件名推断 sessionId | fork 时需重命名且元数据丢失 | 每条消息自包含 | 代码显式在每条消息上 stamp sessionId |

### 2.4 parentUuid DAG 规则

- 除 root 外，每条消息都有 `parentUuid` 指向同一会话中的前一条消息
- `progress` 消息不参与链（`isChainParticipant()` 返回 false）
- 旧版本中已存在 progress 消息的，加载时通过 `progressBridge` 跨越
- `compact_boundary` 的 `parentUuid` 为 null，表示新链起点，但 `logicalParentUuid` 保留旧链引用

## 3. 写入队列与刷新机制

### 3.1 Project 类写入队列设计

`Project` 类管理当前会话的写入：

```typescript
class Project {
  // 每个文件独立队列
  private writeQueues = new Map<
    string,
    Array<{ entry: Entry; resolve: () => void }>
  >();
  
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private activeDrain: Promise<void> | null = null;
  private FLUSH_INTERVAL_MS = 100; // 远程模式下改为 10ms
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024; // 100MB
}
```

### 3.2 完整写入路径

```
调用方（如 insertMessageChain）
  ↓
appendEntry()
  ├─ [sessionFile 为 null] 存入 pendingEntries（惰性创建）
  ├─ [队列] enqueueWrite(filePath, entry) 返回 Promise
  └─ scheduleDrain()
       ↓
    [timer] setTimeout(FLUSH_INTERVAL_MS)
       ↓
    drainWriteQueue()
       ├─ 收集队列中所有条目
       ├─ 组装成 ≤100MB 的 chunk
       ├─ fsAppendFile（mkdir 按需递归创建）
       └─ resolve 所有等待的 Promise
```

### 3.3 flush() 保证

`flush()` 方法在清理/退出时调用，确保：
1. 取消待处理的 flush timer
2. 等待当前 activeDrain 完成
3. 立即执行剩余队列的 drain
4. 等待非队列跟踪操作（如 `removeMessageByUuid`）完成

**证据**：`sdkQueryLifecycle.test.ts` 验证多次 return() 只执行一次清理。

### 3.4 会话文件的惰性创建

会话文件在收到第一条 `user`/`assistant` 消息时才创建：
- 之前的元数据（custom-title, tag 等）存入 `pendingEntries`
- `materializeSessionFile()` 批量写入所有 pending 条目

**关键决策**：避免空会话文件（只有元数据）污染列表。

| 备选方案 | 代价 | 选择 | 证据 |
|---------|------|------|------|
| 立即创建文件 | 大量空会话在 `listSessions()` 中可见 | 惰性创建 | insertMessageChain 中检查 sessionFile 为 null 才 materialize |
| 在会话列表中过滤空会话 | 仍浪费磁盘空间和扫描时间 | 惰性创建 | 代码中 pendingEntries 在 materialize 前不落地 |

## 4. 恢复与分叉

### 4.1 加载路径：从 JSONL 到会话链

`loadTranscriptFile()` 步骤：

```
1. 读取文件头尾 64KB（readHeadAndTail）
   ├─ 提取 customTitle、tag、last-prompt 等元数据
   └─ 快速决定列表展示内容（不解析全文件）

2. 对 >5MB 的大文件，执行分块前向读取（readTranscriptForLoad）
   ├─ 定位最后一个 compact_boundary
   ├─ 截断到 boundary 之后（除非有 preservedSegment）
   ├─ 跳过 attribution-snapshot（仅保留最后一个）
   └─ 输出 postBoundaryBuf（避免全量解析）

3. 解析所有消息，构建 Map<UUID, TranscriptMessage>

4. 应用 preservedSegment（如果有）
   ├─ 定位 anchor point
   ├─ 恢复保存的 segment
   └─ 重新链接 parentUuid

5. 应用 snip removals（如果有）
   ├─ 删除指定 UUID 的消息
   └─ 重链接跨过删除区域的 parentUuid

6. 找到叶子消息（最晚时间戳的可见消息）

7. 从叶子回溯 root，构建 chain

8. 运行 recoverOrphanedParallelToolResults() 恢复并行分支
```

### 4.2 DAG 恢复算法

**问题**：单个 API `msg-*` ID 可能对应多条 assistant 消息（并行工具调用），单 parentUuid 遍历会丢失分支。

**算法输入**：
- `messages: Map<UUID, TranscriptMessage>`：所有消息
- `chain: TranscriptMessage[]`：从叶子回溯的主链
- `seen: Set<UUID>`：主链中的消息

**算法步骤**：

```typescript
// 1. 收集主链中所有 assistant 消息的 API message ID -> anchor
//    anchor = 同一 API ID 在主链上的最后一条消息
const anchorByMsgId = new Map<string, TranscriptMessage>();

// 2. 收集全量：
//    - siblingsByMsgId: API ID -> 所有相同 API ID 的 assistant 消息
//    - toolResultsByAssistant: assistant UUID -> 其 tool_result 消息

// 3. 对每个组，找出不在 seen 中的孤儿
// 4. 按 timestamp 稳定排序
// 5. 插入到 anchor point 之后
```

**证据**：`sessionChainRecovery.test.ts` 验证恢复顺序与无关联分支排除；`sdkSessions.test.ts` 验证分页时恢复结果一致。

### 4.3 Fork 语义

`forkSession()` 创建新会话：
- 新 `sessionId`
- 所有消息重新分配 UUID
- `parentUuid` 指向新链中的消息
- 保留 `forkedFrom` 元数据
- 复制 `content-replacement` 条目
- **不复制**文件历史快照

**关键决策**：分叉时不复制文件快照（与 SDK 设计一致）。

### 4.4 Crash 恢复边界

**崩溃场景与恢复行为**：

| 崩溃点 | 后果 | 恢复策略 |
|-------|------|---------|
| 消息 append 到队列后、flush 前 | 消息在内存中丢失 | 无（队列未持久化） |
| fsAppendFile 进行中 | 文件末尾可能有截断的 JSON 行 | loadTranscriptFile 跳过无效行 |
| reAppendSessionMetadata 进行中 | 元数据可能重复 | extractLastJsonStringField 取最后一个 |
| removeMessageByUuid 的 truncate 进行中 | 文件可能处于截断状态 | 下次启动从有效 JSON 行重建 |

**关键决策**：`removeMessageByUuid` 对不在末尾的消息，仅在文件 ≤50MB 时才重写。

| 备选方案 | 代价 | 选择 | 证据 |
|---------|------|------|------|
| 总是重写整个文件 | 大文件卡顿 | 50MB 阈值 | MAX_TOMBSTONE_REWRITE_BYTES 定义为 50MB |
| 永不重写，只 tombstone | 需解析器支持过滤 | 仅末尾 truncate + 大文件跳过 | removeMessageByUuid 中检查 fileSize |

## 5. 文件历史快照与 Rewind（边界说明）

**文件历史快照的核心流程**（但详细设计属于 SDK 覆盖范围）：

- 每个用户消息后创建快照：`fileHistoryMakeSnapshot(messageId)`
- 快照关联到 `messageId`（不是 UUID）
- Rewind 到某条消息时：`fileHistoryRewind(messageId)`
- Dry run 预览：`fileHistoryGetDiffStats(messageId)`

**边界说明**：
- 快照存储：`~/.claude/file-history/<session-id>/<hash>@v<version>`
- 会话分叉时不复制快照
- 会话恢复时不自动 rewind 文件系统（需显式调用）

**关键决策**：快照按 `messageId` 关联，不是按 UUID。

| 备选方案 | 代价 | 选择 | 证据 |
|---------|------|------|------|
| 按 UUID 关联 | Fork 时重新 UUID 导致快照孤立 | 按 messageId 关联 | fileHistory.ts 中 snapshot 记录 messageId |
| 按时间戳关联 | 难以与会话历史对齐 | 按 messageId 关联 | rewindFiles API 接受 userMessageId |

## 6. 并发边界

### 6.1 单进程内并发

- `Project` 类通过 `writeQueues` 按文件隔离写入
- `activeDrain` 确保一次只运行一个 drain
- `flushResolvers` 聚合等待 flush 的调用者

### 6.2 多进程并发

- JSONL 追加写入在大多数文件系统上是原子的（单 write 调用 ≤ PIPE_BUF）
- 元数据追加（custom-title 等）可能竞争：通过读取 tail 后再追加解决
- SDK 与 CLI 同时写入同一会话：最后一次追加的元数据获胜

**关键决策**：元数据条目不覆盖，只追加，读取时取最后一个。

| 备选方案 | 代价 | 选择 | 证据 |
|---------|------|------|------|
| 原地更新元数据 | 需复杂的锁或版本控制 | 追加 + 最后获胜 | extractLastJsonStringField 用于读取 customTitle/tag |
| 使用单独的 .meta.json 文件 | 文件数量加倍，原子性更难保证 | 单 JSONL 追加 | 代码中所有元数据都写入同一 .jsonl |

### 6.3 远程持久化并发

启用远程持久化时：
- `FLUSH_INTERVAL_MS` 从 100ms 降为 10ms
- 每条 transcript 消息通过 `sessionIngress.appendSessionLog()` 写入远程
- 失败时记录 `tengu_session_persistence_failed`，调用 `gracefulShutdownSync(1)`

## 7. 设计决策汇总

### 决策 1：JSONL 追加写入，无原地改写（除末尾 tombstone）

| 维度 | 说明 |
|-----|------|
| 选择 | 纯追加，仅在目标是最后一条消息时才 truncate 移除 |
| 备选 | 原地更新、数据库存储、单独索引文件 |
| 代价 | 文件可能有重复元数据；非末尾 tombstone 需重写（仅 ≤50MB） |
| 证据 | sessionStorage.ts 中 appendEntry 始终追加；removeMessageByUuid 仅处理末尾或小文件 |

### 决策 2：大文件启动时仅读头尾 64KB

| 维度 | 说明 |
|-----|------|
| 选择 | `LITE_READ_BUF_SIZE = 65536`，头尾各读 64KB |
| 备选 | 总是解析全量、构建单独索引文件、元数据存入 .meta.json |
| 代价 | 元数据需追加到末尾才能在列表中可见；reAppendSessionMetadata 需定期执行 |
| 证据 | sessionStoragePortable.ts 的 readHeadAndTail/readSessionLite；reAppendSessionMetadata 在 cleanup/compact 时调用 |

### 决策 3：元数据与消息共存在同一 JSONL，追加不覆盖

| 维度 | 说明 |
|-----|------|
| 选择 | custom-title、tag、last-prompt 等作为单独 type 行追加，读取取最后一个 |
| 备选 | 单独 .meta.json 文件、SQLite 数据库、文件头预留空间原地更新 |
| 代价 | 扫描列表时需解析更多行；reAppendSessionMetadata 增加文件大小 |
| 证据 | extractLastJsonStringField 实现；reAppendSessionMetadata 在 cleanup/compact/restore 时调用 |

### 决策 4：并行工具调用通过 recoverOrphanedParallelToolResults 恢复

| 维度 | 说明 |
|-----|------|
| 选择 | 加载时从叶子回溯主链，然后从 Map 中找回同一 API ID 的并行分支插入 |
| 备选 | 写入时就保持多链结构、引入专门的 fork 消息、把并行结果合并到一条消息 |
| 代价 | 加载时需额外扫描；需要消息中携带 API message ID |
| 证据 | sessionChainRecovery.ts 的 recoverOrphanedParallelToolResults；sdkSessions.test.ts 中的并行分支测试 |

### 决策 5：会话文件惰性创建（第一条 user/assistant 消息时）

| 维度 | 说明 |
|-----|------|
| 选择 | pendingEntries 暂存元数据，materializeSessionFile 在第一条 user/assistant 时写入 |
| 备选 | 立即创建文件、在列表中过滤空会话、首次写入时才分配 sessionId |
| 代价 | 退出时如果没有 user/assistant 消息，元数据会丢失 |
| 证据 | insertMessageChain 中的 materializeSessionFile 调用；pendingEntries 在 Project 类中 |

### 决策 6：compact_boundary 截断历史，但保留 preservedSegment

| 维度 | 说明 |
|-----|------|
| 选择 | 加载时定位最后一个 compact_boundary，截断到之后；有 preservedSegment 时恢复并重新链接 |
| 备选 | 永远保留全量、fork 时创建新文件、定期归档旧历史 |
| 代价 | 实现复杂度高；需处理 preservedSegment 的 parentUuid 重链接 |
| 证据 | readTranscriptForLoad 的截断逻辑；applyPreservedSegmentRelinks；snip removals 的类似处理 |

## 8. 覆盖范围

本设计的覆盖范围定义见 [Coverage](../../architecture/coverage/session-persistence.yaml)。

## 9. 开放问题与边界疑虑

1. **超大型会话（>1GB）的加载性能**：当前对 >5MB 文件执行分块读取，但未压缩，启动时间可能仍较长。考虑是否需要引入增量索引或二进制格式。

2. **多进程同时写入同一会话的元数据竞争**：当前策略是“最后追加获胜”，但如果 SDK 和 CLI 同时重命名会话，可能出现结果不可预测。考虑是否需要引入文件锁或乐观并发控制。

3. **removeMessageByUuid 对大文件的非末尾消息无操作**：用户可能期望删除历史消息后文件变小，但当前只对小文件重写。考虑是否需要后台压缩或显式的“清理会话历史”命令。

4. **progress 消息在旧会话中的处理**：当前通过 progressBridge 跨越，但如果 progress 消息非常多，加载时仍会解析它们。考虑是否需要在 compact 时完全移除。

5. **subagent 会话的存储位置**：当前放在 `<session-id>/subagents/<agent-id>.jsonl`，但 sessionId 改变时（如 fork），子会话路径不会更新。考虑是否需要在 fork 时复制或重链接子会话。
