---
id: session-persistence
batch: 2
title: Session Persistence 会话记录、恢复与文件历史设计
date: 2026-11-12
status: draft
---

# Session Persistence 会话记录、恢复与文件历史设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

会话持久化需要解决三个核心问题：

- **原子写入与崩溃恢复**：进程崩溃时不丢失已确认消息，支持部分修复
- **大文件高效读写**：会话可增长到数GB，需避免启动时全量解析
- **DAG 结构保持**：并行工具调用产生的多分支需在恢复时完整重建

关键约束：

- 与 SDK `sdk-query-sessions` 共享底层存储格式，但职责分离
- 不重新实现文件检查点（属于 SDK 设计范围）
- 支持 `--resume`、`--fork`、`--continue` 等 CLI 用例

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| JSONL 追加写入，无原地改写（除末尾 tombstone） | sessionStorage.ts 中 appendEntry 始终追加；removeMessageByUuid 仅处理末尾或小文件 | 纯追加写入在大多数文件系统上是原子的（单 write 调用 ≤ PIPE_BUF）；避免大文件重写 | 文件头单次写入 sessionId：崩溃时部分写入的文件难以识别；使用文件名推断 sessionId：fork 时需重命名且元数据丢失 | 每条消息写入 sessionId，增加文件大小 | `src/utils/sessionStorage.ts:1-999` |
| 大文件启动时仅读头尾 64KB | `LITE_READ_BUF_SIZE = 65536`，头尾各读 64KB；extractLastJsonStringField 取最后一个元数据 | 快速决定列表展示内容（不解析全文件），避免几 GB 文件启动慢 | 总是解析全量：大文件启动慢；构建单独索引文件：复杂度高，索引可能损坏 | 元数据需追加到末尾才能在列表中可见；reAppendSessionMetadata 需定期执行 | `src/utils/sessionStoragePortable.ts:1-999` |
| 元数据与消息共存在同一 JSONL，追加不覆盖 | custom-title、tag、last-prompt 等作为单独 type 行追加，读取取最后一个 | 单一文件管理，原子性好；崩溃时部分写入只影响最后一行 | 单独 .meta.json 文件：文件数量加倍，原子性更难保证；原地更新元数据：需复杂锁或版本控制 | 扫描列表时需解析更多行；reAppendSessionMetadata 增加文件大小 | `src/utils/sessionStorage.ts:1-999` |
| 并行工具调用通过 recoverOrphanedParallelToolResults 恢复 | 加载时从叶子回溯主链，然后从 Map 中找回同一 API ID 的并行分支插入 | 单条消息 parentUuid 指向主链，但并行分支需要单独恢复算法 | 写入时就保持多链结构：复杂度高，难以兼容现有格式；引入专门 fork 消息：需要迁移旧会话 | 加载时需额外扫描；需要消息中携带 API message ID | `src/utils/sessionChainRecovery.ts:1-999` |
| 会话文件惰性创建（第一条 user/assistant 消息时） | pendingEntries 暂存元数据，materializeSessionFile 在第一条 user/assistant 时写入 | 避免空会话文件（只有元数据）污染列表；用户打开但没交互的会话不持久化 | 立即创建文件：大量空会话在 listSessions 中可见；在会话列表中过滤空会话：仍浪费磁盘空间和扫描时间 | 退出时如果没有 user/assistant 消息，元数据会丢失 | `src/utils/sessionStorage.ts:1-999` |
| compact_boundary 截断历史，但保留 preservedSegment | 加载时定位最后一个 compact_boundary，截断到之后；有 preservedSegment 时恢复并重新链接 | 控制上下文长度，避免每次加载全量历史；同时保留用户明确保留的片段 | 永远保留全量：大文件启动慢；fork 时创建新文件：磁盘占用高 | 实现复杂度高；需处理 preservedSegment 的 parentUuid 重链接 | `src/utils/sessionStorage.ts:1-999` |
| removeMessageByUuid 对不在末尾的消息，仅在文件 ≤ 50MB 时才重写 | `MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024`，超过该大小只标记 tombstone 不重写 | 大文件重写慢且占用 I/O；通过 tombstone 标记在加载时过滤 | 总是重写整个文件：大文件卡顿；永不重写只 tombstone：需解析器支持过滤，文件会越来越大 | 大文件删除非末尾消息后，文件不会立即变小 | `src/utils/sessionStorage.ts:1-999` |
| 文件历史快照按 messageId 关联，不是按 UUID | fileHistoryMakeSnapshot(messageId) 关联到 messageId；fork 时不复制文件历史快照 | fork 时重新 UUID 导致快照孤立；按 messageId 关联可以在 fork 后继续访问 | 按 UUID 关联：fork 时快照孤立；按时间戳关联：难以与会话历史对齐 | 需要消息同时携带 UUID 和 messageId | `src/utils/fileHistory.ts:1-999` |

## 3. 目标与非目标

### 目标

- JSONL 追加写入，无原地改写（除 tombstone 移除外）
- 从崩溃中安全恢复：最新消息可能在队列中但未刷盘
- 大文件启动时仅读取头尾即可展示会话列表
- 支持消息 UUID 链的完整重建，包括并行分支
- 支持 `--resume`、`--fork`、`--continue` 等 CLI 用例
- 元数据（custom-title、tag、last-prompt）追加不覆盖，读取取最后一个
- 会话文件惰性创建（第一条 user/assistant 消息时）
- 文件历史快照支持 rewind 到某个 messageId

### 非目标

- 不改变文件检查点的现有实现（留待 SDK 设计文档）
- 不实现分布式会话同步
- 不提供实时多进程协作写入同一 session
- 不保证 removeMessageByUuid 对大文件非末尾消息会立即缩小文件
- 不自动 rewind 文件系统（需显式调用 fileHistoryRewind）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 会话存储核心
class Project {
  appendEntry(entry: Entry): Promise<void>
  flush(): Promise<void>
  materializeSessionFile(): Promise<void>
}

// 会话存储工具
function loadTranscriptFile(sessionPath: string): Promise<LoadResult>
function saveTranscriptFile(sessionPath: string, transcript: Transcript): Promise<void>
function listSessions(): Promise<SessionListItem[]>
function forkSession(sessionId: string): Promise<Session>

// 文件历史
function fileHistoryMakeSnapshot(messageId: string): Promise<void>
function fileHistoryRewind(messageId: string): Promise<void>
function fileHistoryGetDiffStats(messageId: string): Promise<DiffStats>

// 会话链恢复
function recoverOrphanedParallelToolResults(
  messages: Map<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>
): TranscriptMessage[]
```

调用方式：

1. **启动路径**：`listSessions()` 读取头尾快速展示；用户选择会话后 `loadTranscriptFile()` 完整加载
2. **写入路径**：调用 `appendEntry()` 队列化写入，定期 flush 或显式调用 `flush()`
3. **Fork 路径**：调用 `forkSession()` 创建新会话，重新 UUID，保留 forkFrom 元数据
4. **Rewind 路径**：调用 `fileHistoryRewind(messageId)` 显式 rewind 文件系统

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `Project` | `writeQueues`、`flushTimer`、`activeDrain`、`pendingEntries`、`sessionFile` | `appendEntry`、`flush`、`materializeSessionFile` | SDK 查询会话 | 接收 `Entry`，返回 `Promise<void>` |
| `sessionStorage.ts` | 无（纯函数 + 文件 I/O） | `loadTranscriptFile`、`saveTranscriptFile`、`removeMessageByUuid`、`reAppendSessionMetadata` | 实际业务逻辑 | 读取/写入 JSONL 文件 |
| `sessionStoragePortable.ts` | 无（纯函数） | `readHeadAndTail`、`readSessionLite`、`extractLastJsonStringField` | 文件 I/O | 提供工具函数给 sessionStorage.ts |
| `sessionChainRecovery.ts` | 无（纯函数） | `recoverOrphanedParallelToolResults` | 实际会话加载 | 接收消息 Map 和主链，返回扩展链 |
| `fileHistory.ts` | 无（纯函数 + 文件 I/O） | `fileHistoryMakeSnapshot`、`fileHistoryRewind`、`fileHistoryGetDiffStats` | 实际文件检查点（SDK 负责） | 管理文件历史快照 |

### 4.3 主控制流

完整写入队列与 flush 流：

```text
调用方（如 insertMessageChain）
  ↓
appendEntry()
  ├─ [sessionFile 为 null] → 存入 pendingEntries（惰性创建）
  ├─ [队列] → enqueueWrite(filePath, entry) → 返回 Promise
  └─ scheduleDrain()
      ↓
  [timer] → setTimeout(FLUSH_INTERVAL_MS)
      ↓
  drainWriteQueue()
      ├─ 收集队列中所有条目
      ├─ 组装成 ≤ 100MB 的 chunk
      ├─ fsAppendFile（mkdir 按需递归创建）
      └─ resolve 所有等待的 Promise
```

会话加载与 DAG 恢复流：

```text
loadTranscriptFile()
  ↓
读取文件头尾 64KB（readHeadAndTail）
  ├─ 提取 customTitle、tag、last-prompt 等元数据
  └─ 快速决定列表展示内容（不解析全文件）
  ↓
对 > 5MB 的大文件，执行分块前向读取（readTranscriptForLoad）
  ├─ 定位最后一个 compact_boundary
  ├─ 截断到 boundary 之后（除非有 preservedSegment）
  ├─ 跳过 attribution-snapshot（只保留最后一个）
  └─ 输出 postBoundaryBuf（避免全量解析）
  ↓
解析所有消息，构建 Map<UUID, TranscriptMessage>
  ↓
应用 preservedSegment（如果有）
  ├─ 定位 anchor point
  ├─ 恢复保存的 segment
  └─ 重新链接 parentUuid
  ↓
应用 snip removals（如果有）
  ├─ 删除指定 UUID 的消息
  └─ 重链接跨过删除区域的 parentUuid
  ↓
找到叶子消息（最晚时间戳的可见消息）
  ↓
从叶子回溯 root，构建 chain
  ↓
运行 recoverOrphanedParallelToolResults() 恢复并行分支
```

### 4.4 数据结构与持久化

物理存储结构：

- 路径：`~/.claude/projects/<sanitized-project-path>/<session-id>.jsonl`
- 编码：UTF-8，LF 行结尾
- 权限：0o600（仅用户可读可写）
- 最大尺寸：无硬性限制，但 `MAX_TRANSCRIPT_READ_BYTES` 限制单次读取 50MB

JSONL 行类型设计：

| type | 说明 | 参与 parentUuid 链 | 持久化到远程 |
|---|---|---|---|
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

核心消息字段：

```typescript
type TranscriptMessage = {
  uuid: UUID                    // 消息唯一 ID
  parentUuid: UUID | null       // 前驱消息 ID，null 表示根
  logicalParentUuid?: UUID      // 逻辑前驱（用于 compact boundary 跨越）
  isSidechain?: boolean        // 是否为 sidechain（agent 子会话）
  teamName?: string
  agentName?: string
  promptId?: string
  agentId?: string
  sessionId: UUID              // 关键决策：每条消息都写入完整 sessionId
  version?: string
  gitBranch?: string
  slug?: string
  timestamp: string
}
```

文件历史快照存储：

- 位置：`~/.claude/file-history/<session-id>/<hash>@v<version>`
- 关联：按 `messageId` 关联，不是按 UUID
- Fork 策略：分叉时不复制文件历史快照

### 4.5 跨子系统依赖

- **SDK Query Sessions**：共享底层 JSONL 格式，但 SDK 负责查询会话，本文负责 CLI 会话持久化
- **File Checkpoint**：属于 SDK 设计范围，本文只描述文件历史快照边界
- **Hooks**：ConfigChange hook 由 hooks 系统触发，本文不涉及
- **Settings**：读取 settings 但不写入，本文只描述读取接口
- **Telemetry**：记录遥测事件，本文不涉及

## 5. 失败语义与工程取舍

### 失败语义

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 消息 append 到队列后、flush 前进程崩溃 | 进程终止 | 无（内存队列丢失） | 否（队列未持久化） | 内存队列丢失，已刷盘的消息保留 | 下一次启动看不到崩溃前未 flush 的消息 |
| fsAppendFile 进行中崩溃 | 进程终止 | 无（部分写入的行） | 否 | loadTranscriptFile 跳过无效行 | 下一次启动跳过无效行，之前的有效消息保留 |
| reAppendSessionMetadata 进行中崩溃 | 进程终止 | 无（重复元数据） | 否 | 读取时取最后一个元数据，重复的忽略 | 下一次启动正常读取，取最后一个元数据 |
| removeMessageByUuid 的 truncate 进行中崩溃 | 进程终止 | 无（文件可能处于截断状态） | 否 | 下次启动从有效 JSON 行重建 | 下一次启动正常重建，可能保留部分截断行但被跳过 |
| 文件历史快照创建失败 | fileHistoryMakeSnapshot | 记录日志，不抛出 | 否 | 无，保留之前的快照 | 调用方无感知，rewind 时使用之前的快照 |

### 工程取舍

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 每条消息写入完整 sessionId | 不是只在文件头写一次 | 增加文件大小，每条消息都重复 | 崩溃时部分写入的文件更容易识别；fork 时元数据更清晰 |
| 大文件启动时仅读头尾 64KB | 不是解析全量 | 元数据需追加到末尾才能在列表中可见；需要 reAppendSessionMetadata | 启动极快，几 GB 文件也能秒开 |
| 元数据追加不覆盖，读取取最后一个 | 不是原地更新 | 文件可能有重复元数据；需要定期 reAppendSessionMetadata | 并发安全；崩溃时部分写入不影响之前的元数据 |
| 并行分支加载时恢复，而不是写入时保持 | 不是写入时维护多链结构 | 加载时需额外扫描；需要消息中携带 API message ID | 兼容现有格式；实现复杂度可控 |
| 会话文件惰性创建 | 不是立即创建 | 退出时如果没有 user/assistant 消息，元数据会丢失 | 避免空会话文件污染列表；节省磁盘空间 |
| removeMessageByUuid 对大文件非末尾消息不重写 | 50MB 阈值 | 删除后文件不会立即变小；需要后台压缩 | 大文件操作快；用户体验好 |
| 文件历史快照按 messageId 关联 | 不是按 UUID | 需要消息同时携带 UUID 和 messageId | fork 时重新 UUID 不会导致快照孤立 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| 正常运行中 append 消息 | 调用 flush() | 消息持久化到 JSONL 文件 | 不能丢失已确认的消息 |
| 会话有并行工具调用 | 加载会话 | 并行分支被正确恢复 | 不能丢失并行工具结果 |
| 会话文件 > 5MB | listSessions() | 仅读取头尾快速展示 | 不能解析全量文件导致启动慢 |
| 用户修改会话标题 | append custom-title 行 | 读取时取最后一个标题 | 不能需要原地更新 |
| fork 会话 | 调用 forkSession() | 新会话有新 sessionId，保留 forkFrom 元数据 | 不能复制文件历史快照 |
| rewind 到某个 messageId | 调用 fileHistoryRewind() | 文件系统恢复到该 messageId 时的状态 | 不能自动 rewind（需显式调用） |
| removeMessageByUuid 删除末尾消息 | 调用 removeMessageByUuid() | 文件被 truncate，立即变小 | 不能保留 tombstone |
| removeMessageByUuid 删除大文件非末尾消息 | 调用 removeMessageByUuid() | 只标记 tombstone，不重写 | 不能阻塞用户操作 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| JSONL 追加写入，无原地改写 | `src/utils/sessionStorage.ts:1-999` | `tests/sessionChainRecovery.test.ts` | 未找到直接测试覆盖 |
| 大文件启动时仅读头尾 64KB | `src/utils/sessionStoragePortable.ts:1-999` | `tests/sessionChainRecovery.test.ts` | 未找到直接测试覆盖 |
| 元数据追加不覆盖，读取取最后一个 | `src/utils/sessionStorage.ts:1-999` + `extractLastJsonStringField` | 需查找相关测试 | 未找到直接测试覆盖 |
| 并行工具调用通过 recoverOrphanedParallelToolResults 恢复 | `src/utils/sessionChainRecovery.ts:1-999` | `tests/sessionChainRecovery.test.ts` | `tests/sessionChainRecovery.test.ts` 验证恢复顺序与无关联分支排除 |
| 会话文件惰性创建 | `src/utils/sessionStorage.ts:1-999` + `pendingEntries` + `materializeSessionFile` | 需查找相关测试 | 未找到直接测试覆盖 |
| compact_boundary 截断历史，但保留 preservedSegment | `src/utils/sessionStorage.ts:1-999` | 需查找相关测试 | 未找到直接测试覆盖 |
| removeMessageByUuid 对不在末尾的消息，仅在 ≤ 50MB 时才重写 | `src/utils/sessionStorage.ts:1-999` + `MAX_TOMBSTONE_REWRITE_BYTES` | 需查找相关测试 | 未找到直接测试覆盖 |
| 文件历史快照按 messageId 关联 | `src/utils/fileHistory.ts:1-999` | 需查找相关测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/utils/sessionStorage.ts` | `Project`、`appendEntry`、`flush`、`loadTranscriptFile`、`saveTranscriptFile`、`removeMessageByUuid`、`reAppendSessionMetadata` | 核心会话存储逻辑 |
| `src/utils/sessionStoragePortable.ts` | `readHeadAndTail`、`readSessionLite`、`extractLastJsonStringField` | 可移植会话存储工具 |
| `src/utils/sessionChainRecovery.ts` | `recoverOrphanedParallelToolResults` | 并行分支恢复算法 |
| `src/utils/fileHistory.ts` | `fileHistoryMakeSnapshot`、`fileHistoryRewind`、`fileHistoryGetDiffStats` | 文件历史快照管理 |
| `tests/sessionChainRecovery.test.ts` | 测试用例 | 会话链恢复测试 |
| `tests/sdkSessions.test.ts` | 测试用例 | SDK 会话测试，包括并行分支恢复 |
| `tests/sdkQueryLifecycle.test.ts` | 测试用例 | SDK 查询生命周期测试，验证多次 return() 只执行一次清理 |

### 7.2 未覆盖行为（基于代码阅读）

- 崩溃恢复的完整测试（进程崩溃后重启）
- 大文件（> 1GB）的加载性能测试
- 多进程并发写入同一会话的测试
- removeMessageByUuid 对大文件非末尾消息的处理
- reAppendSessionMetadata 的定期执行机制
- 文件历史快照与 SDK 文件检查点的完整边界测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/session-persistence.yaml)

### 8.1 本 spec 主拥有的文件组

| 分组 | 主拥有职责 |
|---|---|
| session-storage-core | 核心会话持久化，JSONL 写入队列与 flush |
| session-storage-portable | 可移植会话存储工具，JSONL 头尾读取、路径处理、轻量元数据提取 |
| file-history | 文件历史快照管理 |
| session-storage-tests | 会话持久化核心测试 |
| additional-files | 其他相关文件（commands、migrations、utils 等） |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/sdkQuerySessions.ts` → 主归 sdk-query-sessions spec，本文只描述共享格式边界
- `src/utils/fileCheckpoint.ts` → 主归 sdk-query-sessions spec，本文只描述文件历史快照边界
- `src/services/telemetry/*` → 主归 telemetry spec，本文不涉及

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P1 | 超大型会话（>1GB）的加载性能，当前对 >5MB 文件执行分块读取，但未压缩，启动时间可能仍较长 | 引入增量索引或二进制格式；或允许用户配置是否加载全量历史 | 中（需兼容现有 JSONL 格式） | 1GB 文件加载时间 < 1秒 | L | 设计推断 |
| P1 | 多进程同时写入同一会话的元数据竞争，当前策略是"最后追加获胜"，但如果 SDK 和 CLI 同时重命名会话，可能出现结果不可预测 | 引入文件锁或乐观并发控制（如版本号） | 中（需兼容现有无锁行为） | 两个进程同时追加元数据，结果可预测 | M | 设计推断 |
| P2 | removeMessageByUuid 对大文件的非末尾消息无操作，用户可能期望删除历史消息后文件变小，但当前只对小文件重写 | 增加后台压缩机制；或提供显式的"清理会话历史"命令 | 低（新增功能，不改变现有行为） | 用户可以触发压缩，大文件删除历史后变小 | M | 设计推断 |
| P2 | progress 消息在旧会话中的处理，当前通过 progressBridge 跨越，但如果 progress 消息非常多，加载时仍会解析它们 | 在 compact 时完全移除 progress 消息 | 低（只影响旧会话） | compact 后 progress 消息被清理 | S | 设计推断 |
| P3 | subagent 会话的存储位置，当前放在 `<session-id>/subagents/<agent-id>.jsonl`，但 sessionId 改变时（如 fork），子会话路径不会更新 | 在 fork 时复制或重链接子会话；或使用相对路径 | 低（影响有限） | fork 后子会话仍可访问 | M | 设计推断 |
