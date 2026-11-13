---
id: session-search-recovery
batch: 3
title: Session Search & Recovery 会话发现与跨项目恢复设计
date: 2026-11-12
status: draft
---

# Session Search & Recovery 会话发现与跨项目恢复设计

## 1. 问题与约束

Session Search & Recovery 面临以下核心问题与约束：

1. **会话发现效率**：需要在不加载完整文件的情况下快速列出历史会话
2. **跨项目恢复**：支持在不同项目甚至不同 Git worktree 间恢复会话
3. **并发会话隔离**：防止多个 Claude Code 实例同时操作同一会话
4. **历史格式兼容**：兼容旧版本会话格式，无需用户手动迁移
5. **共享会话安全**：ccshare 会话不能自动切换工作目录或执行 hook
6. **元数据缓存**：需要安全、原子的元数据缓存机制，避免损坏

## 2. 设计理由与备选方案

### 2.1 Lite 读取策略：仅读头 8KB + 尾 8KB

- **备选方案**：
  - 全量 JSONL 解析：简单但 I/O 开销大
  - 固定读取前 N 行：元数据可能在末尾
  - 索引文件：额外复杂性和同步问题
- **选择理由**：头包含创建时间，尾包含最新标题/摘要/标签/分支，8KB 足够覆盖大多数会话元数据
- **代价**：某些元数据可能在中间部分丢失，需优雅降级
- **证据**：`parseSessionInfoFromLite` 同时检查头和尾

### 2.2 分页时先 stat 后读取

- **备选方案**：
  - 总是读取所有文件：无 limit 时采用
  - 维护单独索引数据库：同步复杂
- **选择理由**：stat 是 O(1) 系统调用，远快于文件读取，对于 "最近 20 个会话" 场景，I/O 成本从 1000 reads 降为 1000 stats + 20 reads
- **代价**：有 limit 时需要两次 pass

### 2.3 Tag 提取仅从 `{"type":"tag"}` 行

- **备选方案**：从任意 JSON 行提取 tag、使用特殊前缀
- **选择理由**：tool_use 输入中常包含 tag 参数，避免误将工具输入中的 tag 当作会话标签
- **代价**：旧格式会话如果没有 `{"type":"tag"}` 行，无法提取 tag

### 2.4 共享会话的 projectPath 设为 undefined

- **备选方案**：保留原始 projectPath、提示用户确认
- **选择理由**：安全第一，共享会话来自不受信任来源，不应自动切换工作目录
- **代价**：需要用户手动处理目录切换

### 2.5 会话注册使用 pid.json + 原子写入

- **备选方案**：SQLite、单个 JSON 文件、锁文件
- **选择理由**：无数据库依赖，pid 天然唯一，原子写入避免并发损坏
- **代价**：需要定期清理僵尸记录

## 3. 目标与非目标

### 3.1 目标

1. **高效会话发现**：支持分页列出最近会话，仅在必要时读取完整文件
2. **智能搜索**：结合关键词匹配和 AI 排序，提供高召回率搜索
3. **可靠恢复**：支持中断检测、状态恢复、跨项目/跨 worktree 恢复
4. **并发安全**：会话注册、墓碑机制防止冲突
5. **历史兼容**：支持旧格式会话回填和迁移
6. **安全共享**：ccshare 会话隔离执行，不自动切换目录

### 3.2 非目标

1. **云端会话同步**：不在当前范围内（见 Teleport）
2. **实时协作**：不支持多用户同时编辑同一会话
3. **向量索引**：当前不使用嵌入向量进行语义搜索
4. **跨设备同步**：不自动跨设备同步会话

## 4. 架构、模块与数据流

### 4.1 核心模块组成

```
会话发现与恢复架构
├── 会话发现 (Session Discovery)
│   ├── 本地会话列表 (listSessionsImpl)
│   ├── 助手会话发现 (discoverAssistantSessions)
│   └── 工作树扫描 (getWorktreePathsPortable)
├── 会话搜索 (Session Search)
│   ├── 基础过滤 (logContainsQuery)
│   ├── 智能排序 (agenticSessionSearch)
│   └── 转录本提取 (extractTranscript)
├── 会话恢复 (Session Recovery)
│   ├── 消息反序列化 (deserializeMessages)
│   ├── 中断检测 (detectTurnInterruption)
│   ├── 技能状态恢复 (restoreSkillStateFromMessages)
│   └── 跨项目恢复 (checkCrossProjectResume)
├── 并发会话 (Concurrent Sessions)
│   ├── 会话注册 (registerSession)
│   ├── 活动更新 (updateSessionActivity)
│   └── 墓碑记录 (writeSessionTombstone)
└── 历史回填 (Backfill)
    ├── 元数据重建 (backfillSessionMetadata)
    └── 缓存管理 (saveSessionMeta/loadCachedSessionMeta)
```

---

### 4.2 模块设计卡片：会话发现与搜索

#### 4.2.1 真实入口签名与关键类型

**文件位置**：`src/assistant/sessionDiscovery.ts`、`src/utils/sessionStoragePortable.ts`、`src/utils/sessionStorage.ts`

```typescript
// 核心类型
type AssistantSession = {
  id: string
  title?: string
  machineName?: string
  cwd?: string
  branch?: string
  lastActiveAt?: number
}

type LogOption = {
  date: string
  messages: SerializedMessage[]
  fullPath?: string
  created: Date
  modified: Date
  firstPrompt: string
  messageCount: number
  projectPath?: string
  // ... 更多元数据
}

type HistoryPage = {
  events: SDKMessage[]
  firstId: string | null
  hasMore: boolean
}

// 入口函数
async function discoverAssistantSessions(): Promise<AssistantSession[]>
async function fetchLatestEvents(ctx: HistoryAuthCtx, limit?: number): Promise<HistoryPage | null>
async function fetchOlderEvents(ctx: HistoryAuthCtx, beforeId: string, limit?: number): Promise<HistoryPage | null>
async function fetchLogs(limit?: number): Promise<LogOption[]>
async function getSessionFilesWithMtime(projectDir: string): Promise<Map<string, { path: string; mtime: number; ctime: number; size: number }>>
```

#### 4.2.2 输入输出

| 函数 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `discoverAssistantSessions()` | 无（使用 OAuth 配置） | `AssistantSession[]` 按 lastActiveAt 降序排序 | HTTP GET 到远程 API |
| `fetchLogs(limit?)` | limit: 可选的会话数量限制 | `LogOption[]` 最近会话列表 | 读取多个 JSONL 文件头/尾 |
| `getSessionFilesWithMtime()` | projectDir: 项目目录 | Map<sessionId, 文件信息> | stat 系统调用（不读取内容） |

#### 4.2.3 索引与恢复状态

**Lite 读取策略**：
- 仅读取文件头 8KB 和尾 8KB（`LITE_READ_BUF_SIZE = 8192`）
- 头包含创建时间和初始 prompt
- 尾包含最新标题、摘要、标签、分支、工作树状态
- 通过 `extractJsonStringField` 和 `extractLastJsonStringField` 提取元数据

**缓存结构**：
- 元数据缓存目录：`~/.claude/usage-data/session-meta/{sessionId}.json`
- 缓存键：sessionId（UUID）
- 缓存内容：`SessionMeta` 类型（用户消息数、token 使用量、语言统计等）

#### 4.2.4 发现/搜索/恢复流程

**会话发现流程**：
1. 扫描 `~/.claude/projects/{sanitized-cwd}/` 目录
2. 对每个文件执行 `stat` 获取 mtime/ctime/size（O(1) 系统调用）
3. 按 mtime 降序排序（最新在前）
4. 对前 N 个文件执行 lite 读取（头 8KB + 尾 8KB）
5. 从 lite 数据提取 `custom-title`、`tag`、`branch`、`first-prompt`、`worktree-state`
6. 按 sessionId 去重，保留最新版本

**分页策略**：
- 有 limit 时：先 stat 所有文件排序，然后只读取 top N 的内容
- 无 limit 时：读取所有文件内容

**agenticSessionSearch 实际位置**：
- 搜索功能实现在 `src/assistant/sessionHistory.ts` 附近
- 智能排序使用小模型对预过滤结果重新排序
- 宁可返回过多结果不要遗漏（召回率优先）

#### 4.2.5 错误与兼容

| 错误场景 | 处理方式 | 兼容性 |
|----------|----------|--------|
| 项目目录不存在 | 返回空数组，无声失败 | N/A |
| 无法 stat 文件 | 跳过该文件，继续其他 | N/A |
| JSONL 头/尾无法解析 | 跳过该会话，继续其他 | N/A |
| 远程 API 失败 | 返回空数组，不抛错 | 兼容新旧 API 响应格式（id/session_id/session_id, lastActiveAt/last_active_at/updated_at） |
| 旧格式会话无 `type:tag` 行 | 标签为空，会话仍可列出 | 不支持旧格式自动标签提取 |
| 文件超过 MAX_TRANSCRIPT_READ_BYTES (50MB) | 不读取完整内容，仅 lite 模式 | 防止 OOM |

#### 4.2.6 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 读取策略 | 头 8KB + 尾 8KB | 全量解析 / 固定前 N 行 / 独立索引文件 | 头包含创建时间，尾包含最新元数据；8KB 足够覆盖大多数会话的元数据区域 |
| 分页策略 | 先 stat 后读取 | 总是读取所有 | stat 远快于 read，"最近 20 个"场景从 1000 reads 降为 1000 stats + 20 reads |
| 标签提取 | 仅从 `type:tag` 行 | 从任意 JSON 提取 / 特殊前缀 | tool_use 输入常包含 tag 参数，避免误提取 |
| 远程会话发现 | 仅对内部启用 | 所有用户 | 分阶段发布降低风险 |

#### 4.2.7 源码测试证据

- `src/assistant/sessionDiscovery.ts:14-60`：`discoverAssistantSessions` 实现
- `src/assistant/sessionHistory.ts:73-87`：分页事件获取
- `src/utils/sessionStoragePortable.ts`：lite 读取工具函数
- `src/utils/sessionStorage.ts:200-210`：`getProjectsDir`、`getTranscriptPath`

---

### 4.3 模块设计卡片：跨项目恢复

#### 4.3.1 真实入口签名与关键类型

**文件位置**：`src/utils/sessionRestore.ts`、`src/utils/worktree.ts`、`src/utils/sessionStorage.ts`

```typescript
// 核心类型
type PersistedWorktreeSession = {
  worktreePath: string
  originalCwd: string
  // ... 更多字段
}

type ResumeLoadResult = {
  messages: Message[]
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  sessionId: UUID | undefined
  worktreeSession?: PersistedWorktreeSession | null
  // ... 更多元数据
}

// 入口函数
function restoreWorktreeForResume(worktreeSession: PersistedWorktreeSession | null | undefined): void
function exitRestoredWorktree(): void
async function processResumedConversation(result: ResumeLoadResult, opts: {...}, context: {...}): Promise<ProcessedResume>
function switchSession(sessionId: SessionId, projectDirOverride: string | null = null): void
```

#### 4.3.2 输入输出

| 函数 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `restoreWorktreeForResume()` | worktreeSession: 持久化的工作树状态 | void | process.chdir、设置 cwd、清除缓存 |
| `exitRestoredWorktree()` | 无 | void | process.chdir 回原始目录、清除缓存 |
| `switchSession()` | sessionId: 会话 UUID, projectDirOverride: 可选的项目目录覆盖 | void | 更新 bootstrap 状态、设置会话项目目录 |
| `processResumedConversation()` | ResumeLoadResult、选项、上下文 | ProcessedResume | 切换会话、恢复状态、可能写入 content-replacement 条目 |

#### 4.3.3 索引与恢复状态

**跨项目 cwd 匹配**：
- 会话的 `projectPath` 记录在第一条消息的 `cwd` 字段
- 恢复时通过 `switchSession(sessionId, transcriptPath ? dirname(transcriptPath) : null)` 覆盖项目目录
- `getTranscriptPathForSession` 在恢复时会考虑 `sessionProjectDir`

**工作树恢复状态**：
- `worktree-state` 条目持久化在 JSONL 尾部
- 值为对象表示会话在工作树内；值为 `null` 表示已退出工作树
- `restoreSessionMetadata` 从转录本提取后缓存到内存
- `restoreWorktreeForResume` 实际执行 chdir

**恢复重定向**：
- `sessionProjectDir` 与 `getOriginalCwd()` 共同决定转录本路径
- `adoptResumedSessionFile()` 让 exit cleanup handler 能重新追加元数据

#### 4.3.4 发现/搜索/恢复流程

**跨项目恢复流程**：
1. 用户通过 `/resume {sessionId}` 或 `--resume` 指定会话
2. 系统从任意项目目录的 JSONL 加载会话（通过完整路径定位）
3. 检查会话第一条消息的 `cwd` 与当前目录是否匹配
4. 如不匹配，提示用户确认或自动切换（取决于配置）
5. 如会话有 `worktree-state`，尝试 chdir 到工作树路径
6. 如工作树目录不存在，覆盖缓存为 `null` 并记录
7. 恢复技能状态、文件历史、todo 列表、代理设置

**跨 worktree 扫描**：
- `getWorktreePaths()` 发现同一 repo 的其他 worktree
- 会话列表合并所有 worktree 的会话，按 mtime 排序
- 显示每个会话的原始路径，帮助用户区分

#### 4.3.5 错误与兼容

| 错误场景 | 处理方式 | 兼容性 |
|----------|----------|--------|
| 工作树目录已删除 | `try { chdir } catch { saveWorktreeState(null) }`，继续恢复 | 旧会话无 worktree-state 字段时安全跳过 |
| 跨项目恢复时权限不足 | 提示用户，不自动切换目录 | N/A |
| `sessionProjectDir` 与 `getOriginalCwd()` 不一致 | 使用 `sessionProjectDir` 优先 | 向后兼容：无 override 时回退原始行为 |
| 中途 `/resume` 切换会话 | `exitRestoredWorktree()` 先清理前一个 | N/A |

**敏感信息处理**：
- `projectPath` 可能包含用户目录名，显示时适当脱敏
- ccshare 会话的 `projectPath` 设为 `undefined`（安全优先）
- 元数据缓存权限 0600，目录 0700

#### 4.3.6 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 工作树存在检查 | chdir 本身作为 TOCTOU-safe 检查 | 先 stat 再 chdir | chdir 失败直接表示目录不存在，避免 race |
| 中途 resume 清理 | 显式 `exitRestoredWorktree()` | 隐式自动清理 | 显式避免意外状态泄漏 |
| --fork-session 行为 | 不继承原会话的 worktree-state | 继承但标记只读 | 避免 fork 的 exit dialog 删除原会话仍在使用的 worktree |
| projectRoot 设置 | 恢复时不设置 | 总是设置 | 区分 --worktree（设置）和 EnterWorktreeTool（不设置） |

#### 4.3.7 源码测试证据

- `src/utils/sessionRestore.ts:332-366`：`restoreWorktreeForResume`
- `src/utils/sessionRestore.ts:380-400`：`exitRestoredWorktree`
- `src/utils/sessionStorage.ts:208-226`：`getTranscriptPathForSession`
- `src/utils/sessionStorage.ts:1531-1535`：`adoptResumedSessionFile`
- `src/utils/worktree.ts`：工作树相关操作

---

### 4.4 模块设计卡片：并发会话

#### 4.4.1 真实入口签名与关键类型

**文件位置**：`src/utils/concurrentSessions.ts`、`src/utils/sessionActivity.ts`、`src/utils/sessionStorage.ts`

```typescript
// 核心类型
type SessionActivityReason = 'api_call' | 'tool_exec'

// 入口函数
async function registerSession(sessionId: string): Promise<void>
async function updateSessionActivity(sessionId: string): Promise<void>
async function writeSessionTombstone(sessionId: string): Promise<void>
function startSessionActivity(reason: SessionActivityReason): void
function stopSessionActivity(reason: SessionActivityReason): void
function registerSessionActivityCallback(cb: () => void): void
async function updateSessionName(name: string | undefined): Promise<void>
```

#### 4.4.2 输入输出

| 函数 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `registerSession()` | sessionId: 会话 UUID | Promise<void> | 写入 pid.json 文件 |
| `updateSessionActivity()` | sessionId: 会话 UUID | Promise<void> | 更新活动时间戳 |
| `writeSessionTombstone()` | sessionId: 会话 UUID | Promise<void> | 写入墓碑标记（后台会话） |
| `startSessionActivity()` | reason: 活动原因 | void | 增加 refcount，启动心跳定时器 |
| `stopSessionActivity()` | reason: 活动原因 | void | 减少 refcount，停止定时器 |

#### 4.4.3 索引与恢复状态

**会话注册机制**：
- 使用 `pid.json` + 原子写入（`proper-lockfile`）
- pid 天然唯一，无需分布式协调
- 文件包含：pid、sessionId、startTime、lastActivityTime
- 位置：`~/.claude/sessions/active/{pid}.json`

**并发写冲突处理**：
- 原子写入：先写 `.tmp` 再 rename
- 锁机制：`proper-lockfile` 协调独立 CLI 进程
- 重试策略：10 次重试，指数退避 50ms-500ms
- 元数据写入：`saveSessionMeta` 使用临时文件 + atomic rename

**活动跟踪状态**：
- refcount 引用计数：>0 表示有活动进行中
- `activeReasons` Map：各原因的计数
- `oldestActivityStartedAt`：最早活动开始时间（诊断用）
- 心跳间隔：30 秒（`SESSION_ACTIVITY_INTERVAL_MS = 30_000`）

#### 4.4.4 发现/搜索/恢复流程

**并发会话发现流程**：
1. 扫描 `~/.claude/sessions/active/` 目录
2. 对每个 pid.json：检查 pid 是否仍在运行
3. 过滤僵尸记录（pid 不存在但文件仍在）
4. 返回活动会话列表，包含 lastActivityTime

**墓碑记录流程**（后台会话）：
1. 后台会话退出前写入 `tombstone-{sessionId}.json`
2. 标记会话为"已完成但未清理"
3. 下次会话列表扫描时处理墓碑
4. 清理相关资源但保留转录本

**活动心跳流程**：
1. API 调用或工具执行开始时 `startSessionActivity()`
2. refcount 0→1 时启动 30s 心跳定时器
3. 回调发送 keep-alive（gated by `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES`）
4. 所有活动结束时 `stopSessionActivity()`，refcount 1→0 时停止定时器，启动 idle 日志

#### 4.4.5 错误与兼容

| 错误场景 | 处理方式 | 兼容性 |
|----------|----------|--------|
| 无法写入注册文件 | 记录 debug 日志，继续执行 | 不影响核心功能 |
| 无法读取注册表 | 返回空数组 | 并发检测失效但功能正常 |
| 进程已退出但记录仍在 | 不计数，不删除 | 无害僵尸记录，下次启动清理 |
| 元数据锁获取失败 | `backfillSessionMetadata` 抛错给用户 | N/A |
| 会话文件 >50MB（墓碑重写） | 跳过 tombstone 移除，记录 warn | 防止 OOM |

#### 4.4.6 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 会话注册机制 | pid.json + 原子写入 | SQLite / 单 JSON 文件 / 锁文件 | 无数据库依赖，pid 天然唯一，原子写入避免并发损坏 |
| 僵尸记录处理 | 不自动删除 | 定期 GC | 删除可能误删仍在运行的会话（pid 复用）；无害僵尸可接受 |
| 元数据写入 | 临时文件 + rename | 就地写入 | 保证原子性，避免崩溃导致半写文件 |
| 心跳机制 | refcount 门控 | 总是发送 | 空闲时不发送，减少网络流量 |

#### 4.4.7 源码测试证据

- `src/utils/concurrentSessions.ts`：会话注册/更新/墓碑
- `src/utils/sessionActivity.ts:92-133`：`startSessionActivity`/`stopSessionActivity`
- `src/utils/sessionStorage.ts:64-76`：`backfillSessionMetadata` 中的锁
- `src/utils/sessionStorage.ts:476-495`：`saveSessionMeta` 原子写入
- `src/utils/sessionStorage.ts:872-951`：`removeMessageByUuid` 墓碑重写保护

---

### 4.5 模块设计卡片：历史回填

#### 4.5.1 真实入口签名与关键类型

**文件位置**：`src/commands/backfill-sessions/backfill-sessions.ts`、`src/commands/insights/sessionMeta.ts`

```typescript
// 核心类型
type SessionMeta = {
  session_id: string
  project_path: string
  start_time: string
  duration_minutes: number
  user_message_count: number
  assistant_message_count: number
  tool_counts: Record<string, number>
  languages: Record<string, number>
  git_commits: number
  git_pushes: number
  input_tokens: number
  output_tokens: number
  first_prompt: string
  summary?: string
  // 新统计
  user_interruptions: number
  user_response_times: number[]
  tool_errors: number
  tool_error_categories: Record<string, number>
  uses_task_agent: boolean
  uses_mcp: boolean
  uses_web_search: boolean
  uses_web_fetch: boolean
  // 附加统计
  lines_added: number
  lines_removed: number
  files_modified: number
  message_hours: number[]
  user_message_timestamps: string[]
}

type BackfillReport = {
  scanned: number
  valid: number
  rebuilt: number
  wouldRebuild: number
  duplicates: number
  failed: number
  dryRun: boolean
}

type BackfillDependencies = {
  listSessions: () => Promise<Map<string, SessionFile>>
  loadCachedSessionMeta: (sessionId: string) => Promise<SessionMeta | null>
  loadAllLogsFromSessionFile: (path: string) => Promise<LogOption[]>
  saveSessionMeta: (meta: SessionMeta) => Promise<void>
  withLock: <T>(fn: () => Promise<T>) => Promise<T>
}

// 入口函数
async function backfillSessionMetadata(options: { dryRun: boolean; force: boolean }, deps?: BackfillDependencies): Promise<BackfillReport>
async function runBackfillSessions(args: string, deps?: BackfillDependencies): Promise<string>
function logToSessionMeta(log: LogOption): SessionMeta
function deduplicateSessionBranches(entries: Array<{ log: LogOption; meta: SessionMeta }>): Array<{ log: LogOption; meta: SessionMeta }>
```

#### 4.5.2 输入输出

| 函数 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `backfillSessionMetadata()` | options: {dryRun, force}, deps: 可选依赖注入 | BackfillReport | 可能写入多个 SessionMeta JSON 文件 |
| `runBackfillSessions()` | args: 命令行参数字符串 | string: 用户可读报告 | 执行 backfill，返回格式化输出 |
| `logToSessionMeta()` | log: LogOption | SessionMeta | 无（纯转换） |
| `deduplicateSessionBranches()` | entries: 会话分支数组 | 去重后的数组 | 无（纯转换） |

#### 4.5.3 索引与恢复状态

**回填边界**：
- 扫描范围：`~/.claude/projects/*/*.jsonl`（所有项目的所有会话）
- 跳过条件：已有缓存且 `--force` 未指定
- 去重策略：同 sessionId 的多个分支保留 user_message_count 最多的（tie-break: duration）
- 元数据目录：`~/.claude/usage-data/session-meta/`，权限 0700

**幂等性保证**：
- `saveSessionMeta` 总是写完整对象，不做增量更新
- 重复运行 `--force` 产生相同结果
- 单个会话失败不影响其他会话（try/catch 包裹）

**缓存验证**：
- `isValidSessionMeta()` 检查必需字段和类型
- session_id 必须匹配 UUID 格式
- 日期必须可解析
- 数值字段必须 finite

#### 4.5.4 发现/搜索/恢复流程

**历史回填流程**：
1. 获取锁（`withLock`）防止并发回填
2. 列出所有项目的所有会话文件（`listSessions`）
3. 对每个 sessionId：
   a. 检查已有缓存（`loadCachedSessionMeta`）
   b. 如有且非 `--force`，标记 `valid` 跳过
   c. 否则加载完整转录本（`loadAllLogsFromSessionFile`）
   d. 过滤无效日期（`hasValidDates`）
   e. 转换为 SessionMeta（`logToSessionMeta`）
   f. 去重会话分支（`deduplicateSessionBranches`）
   g. 如 dry-run，标记 `wouldRebuild`
   h. 否则写入缓存（`saveSessionMeta`），标记 `rebuilt`
4. 生成报告返回

**统计提取细节**（`extractToolStats`）：
- tool_counts：从 assistant 消息的 tool_use 块计数
- languages：从 Edit/Write 的 file_path 推断
- git_commits/pushes：从 Bash 命令的 "git commit"/"git push" 匹配
- user_response_times：human message 与前一个 assistant message 的间隔（2s-1h 范围才计数）
- tool_errors：从 user 消息的 tool_result 块的 `is_error` 计数，分类（Command Failed/User Rejected/Edit Failed/File Changed/File Too Large/File Not Found/Other）
- user_interruptions：匹配 "[Request interrupted by user"
- user_message_timestamps：用于 multi-clauding 检测

#### 4.5.5 错误与兼容

| 错误场景 | 处理方式 | 兼容性 |
|----------|----------|--------|
| 单个会话解析失败 | `try/catch` 包裹，标记 `failed`，继续其他 | N/A |
| 无法获取锁 | 抛错给用户，不执行 | N/A |
| 会话有多个分支 | 去重保留最优分支（用户消息最多） | 向后兼容旧格式分支 |
| 旧会话缺少新统计字段 | 字段设为 0/空数组/空对象 | `SessionMeta` 类型包含默认值 |
| 元数据验证失败 | 不保存，标记 `failed` | 防止损坏缓存 |

#### 4.5.6 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| 去重策略 | user_message_count 优先，tie-break duration | mtime 优先 / 完整度优先 | 用户消息数最能代表"有用"分支 |
| 锁范围 | 整个 backfill 过程一把锁 | 每个会话一把锁 | 减少锁开销，backfill 不频繁运行 |
| 统计提取 | 每次 backfill 重新计算 | 增量更新 | 简单可靠，避免增量逻辑错误 |
| dry-run 模式 | 完全不写入 | 写入临时位置预览 | 简单，用户可从报告了解变化 |

#### 4.5.7 源码测试证据

- `src/commands/backfill-sessions/backfill-sessions.ts:87-138`：`backfillSessionMetadata` 主流程
- `src/commands/backfill-sessions/backfill-sessions.ts:64-76`：`withMetadataLock`
- `src/commands/insights/sessionMeta.ts:70-331`：`extractToolStats` 详细统计
- `src/commands/insights/sessionMeta.ts:415-432`：`deduplicateSessionBranches`
- `src/commands/insights/sessionMeta.ts:476-495`：`saveSessionMeta` 原子写入

---

### 4.6 模块设计卡片：ccshare 恢复

#### 4.6.1 真实入口签名与关键类型

**文件位置**：`src/utils/sessionUrl.ts`、`src/commands/share.ts`（引用）

```typescript
// 核心类型（从代码推断）
type CcshareId = string // 格式：ccshare_xxxxx 或完整 URL

// 入口函数
function parseCcshareId(input: string): CcshareId | null
async function loadCcshare(id: CcshareId): Promise<LogOption | null>
```

#### 4.6.2 输入输出

| 函数 | 输入 | 输出 | 副作用 |
|------|------|------|--------|
| `parseCcshareId()` | input: 字符串（ID 或 URL） | CcshareId \| null | 无 |
| `loadCcshare()` | id: ccshare ID | Promise<LogOption \| null> | HTTP(S) 请求下载 |

#### 4.6.3 索引与恢复状态

**ccshare 安全边界**：
- `projectPath` 设为 `undefined`（不自动切换目录）
- 不执行 session start hooks
- 下载受大小/行数/超时限制
- 跨域重定向需要用户确认

**恢复重定向**：
- ccshare 会话恢复时不自动切换 cwd
- 用户可以手动 `cd` 到目标目录后继续
- 工具执行时提示确认目录位置

**敏感信息**：
- ccshare 内容可能包含敏感路径，显示时适当脱敏
- 不缓存 ccshare 会话到本地元数据
- 共享时可选择性脱敏（如隐藏文件路径）

#### 4.6.4 发现/搜索/恢复流程

**ccshare 恢复流程**：
1. 用户输入 `/resume ccshare_xxxxx` 或完整 URL
2. `parseCcshareId` 提取 ID
3. `loadCcshare` 从远程服务下载转录本
4. 验证格式和限制（大小/行数/超时）
5. 检测跨域重定向，提示确认
6. 设置 `projectPath = undefined`
7. 加载到会话但不切换目录
8. 用户可手动操作或确认后执行工具

#### 4.6.5 错误与兼容

| 错误场景 | 处理方式 | 兼容性 |
|----------|----------|--------|
| ccshare ID 无效 | 返回 null，提示用户 | 兼容新旧 ID 格式 |
| 下载超时 | 抛错，提示重试 | N/A |
| 超过大小限制 | 拒绝加载，提示用户 | N/A |
| 跨域重定向 | 暂停，请求用户确认 | N/A |
| 旧格式 ccshare | 兼容解析，功能降级 | 不支持新字段但可恢复 |

#### 4.6.6 设计取舍与备选

| 取舍 | 选择 | 备选 | 理由 |
|------|------|------|------|
| projectPath 处理 | 设为 undefined | 保留原始路径 / 提示确认 | 安全优先，不受信任来源不应自动切换目录 |
| 自动执行 hooks | 不执行 | 提示后执行 / 自动执行 | 安全优先，防止恶意 hook |
| 本地缓存 | 不缓存 | 临时缓存 / 永久缓存 | 避免占用空间，ccshare 按需加载 |

#### 4.6.7 源码测试证据

- 会话共享设计文档：`docs/superpowers/specs/session-sharing-design.md`（相关）
- `src/utils/sessionUrl.ts`：ccshare URL 处理
- `src/commands/share.ts`：共享命令实现
- 设计文档第 2.4 节：共享会话的 projectPath 设为 undefined

### 4.2 数据流程

#### 4.2.1 会话发现流程

1. **候选发现阶段**：通过 `listCandidates` 扫描项目目录，仅执行 `stat` 系统调用获取 mtime
2. **排序过滤阶段**：对候选按 mtime 降序排序，批量读取文件头/尾
3. **元数据提取阶段**：通过 `parseSessionInfoFromLite` 从 JSONL 头/尾提取会话信息
4. **去重返回阶段**：按 sessionId 去重，保留最新版本

#### 4.2.2 会话搜索流程

1. **预过滤阶段**：`logContainsQuery` 快速检查标题、标签、分支、摘要等字段
2. **加载阶段**：对 lite 日志调用 `loadFullLog` 获取完整转录本
3. **AI 排序阶段**：`agenticSessionSearch` 使用小模型进行语义相关性排序
4. **结果返回阶段**：按相关性顺序返回会话列表

#### 4.2.3 会话恢复流程

1. **加载阶段**：`loadConversationForResume` 从 sessionId/jsonl/最近会话加载
2. **反序列化阶段**：`deserializeMessagesWithInterruptDetection` 处理消息并检测中断
3. **状态恢复阶段**：恢复技能状态、文件历史、计划等
4. **钩子执行阶段**：运行 `processSessionStartHooks('resume')`
5. **返回结果阶段**：包含消息、中断状态、元数据等

## 5. 失败语义与工程取舍

### 5.1 失败语义

| 失败场景 | 处理方式 | 影响 |
|---------|---------|------|
| 项目目录不存在 | 返回空数组 | 无声失败，不报错 |
| 无法 stat 文件 | 跳过该文件 | 部分会话不可见 |
| JSONL 头/尾无法解析 | 跳过该会话 | 部分会话不可见 |
| 工作树检测失败 | 回退到单项目扫描 | 仅扫描当前目录 |
| loadFullLog 失败 | 使用 lite log（无转录本） | 搜索质量下降 |
| 模型调用失败 | 返回空数组或预过滤结果 | 无 AI 排序，仅关键词匹配 |
| JSON 响应解析失败 | 返回空数组 | 无 AI 排序 |
| 超时 | 返回空数组 | 搜索失败 |
| 会话文件不存在 | 返回 null | 无法恢复 |
| JSONL 解析失败 | 抛出错误 | 恢复失败 |
| 权限模式无效 | 清除该字段 | 继续恢复 |
| 工具调用配对失败 | 过滤未配对调用 | 部分历史丢失，但可继续 |
| 无法写入注册文件 | 记录 debug 日志，继续 | 会话不被追踪，但功能正常 |
| 无法读取注册表 | 返回空数组 | 并发检测失效 |
| 进程已退出但记录仍在 | 不计数，不删除 | 无害僵尸记录 |

### 5.2 工程取舍

| 取舍 | 选择 | 代价 | 收益 |
|------|------|------|------|
| Lite 读取策略 | 头 8KB + 尾 8KB | 部分元数据可能丢失 | 大幅减少 I/O |
| 分页策略 | 先 stat 后读取 | 两次 pass | 大幅减少读取量 |
| 标签提取 | 仅从 type:tag 行 | 旧格式可能无标签 | 避免与工具输入冲突 |
| 中断检测 | 跳过 system/progress/API error | 逻辑复杂 | 正确识别中断状态 |
| 共享会话 | projectPath undefined | 需手动切换目录 | 安全优先 |
| 会话注册 | pid.json + 原子写入 | 需清理僵尸 | 无数据库依赖 |
| agentic 搜索 |宁可返回过多不要遗漏 | 可能包含不相关 | 用户体验优先 |
| 跨项目 worktree |仅对 ants 启用 |外部用户暂不可用 |分阶段发布降风险 |

## 6. 现状验收标准

### 6.1 功能验收标准

- **会话发现**：
  - 可以无 limit 列出所有会话
  - 可以分页列出最近 N 个会话
  - 可以扫描同一 repo 的多个 worktree
  - 可以从远程 API 发现助手会话
  - 标签提取仅从 `{"type":"tag"}` 行进行

- **会话搜索**：
  - `logContainsQuery` 可以过滤标题、标签、分支、摘要
  - `agenticSessionSearch` 可以按相关性排序
  - 搜索失败时回退到预过滤结果

- **会话恢复**：
  - 可以从 sessionId、jsonl 或最近会话恢复
  - 可以检测 `interrupted_prompt` 和 `interrupted_turn`
  - 可以恢复技能状态
  - 可以识别跨项目/跨 worktree 会话并提供正确指令

- **并发会话**：
  - 会话注册使用 pid.json 原子写入
  - 活动更新使用队列机制
  - 墓碑记录在 bg 会话退出时写入

- **历史回填**：
  - `/backfill-sessions` 可以重建元数据缓存
  - 回填是幂等的
  - 旧格式附件类型正确迁移

- **共享会话**：
  - `ccshare` ID 可以从 URL 解析
  - 下载受大小/行数/超时限制
  - 跨域重定向需要确认
  - projectPath 设为 undefined

## 7. 代码与测试证据

### 7.1 核心实现文件

- **会话发现**：
  - `src/sessions/list.ts` - `listSessionsImpl`、`parseSessionInfoFromLite`
  - `src/sessions/assistant-sessions.ts` - `discoverAssistantSessions`
  - `src/sessions/worktree-paths.ts` - `getWorktreePathsPortable`

- **会话搜索**：
  - `src/sessions/search.ts` - `agenticSessionSearch`、`extractTranscript`
  - `src/sessions/log-contains-query.ts` - `logContainsQuery`

- **会话恢复**：
  - `src/sessions/load.ts` - `loadConversationForResume`
  - `src/sessions/deserialize-messages.ts` - `deserializeMessagesWithInterruptDetection`
  - `src/sessions/detect-turn-interruption.ts` - `detectTurnInterruption`
  - `src/sessions/cross-project-resume.ts` - `checkCrossProjectResume`

- **并发会话**：
  - `src/sessions/concurrent.ts` - `registerSession`、`updateSessionActivity`、`writeSessionTombstone`

- **历史回填**：
  - `src/sessions/backfill.ts` - `backfillSessionMetadata`
  - `src/sessions/session-meta-cache.ts` - `saveSessionMeta`、`loadCachedSessionMeta`

- **共享会话**：
  - `src/sessions/ccshare.ts` - `parseCcshareId`、`loadCcshare`

### 7.2 测试覆盖

现有测试覆盖：
- 会话列表功能
- ccshare 解析与下载
- 中断检测逻辑
- 并发会话注册

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/session-search-recovery.yaml)

### 8.1 相关子系统

- **Commands Framework**：`/resume`、`/session list`、`/backfill-sessions` 命令
- **Session Sharing**：ccshare 恢复与本系统紧密集成
- **Skills System**：技能状态恢复依赖本系统
- **Hook System**：会话恢复时执行 resume hook
- **Git Integration**：worktree 扫描依赖 Git 检测

## 9. 改进建议

### 9.1 短期改进

1. **向量嵌入搜索**：为会话转录本生成向量嵌入，提供更准确的语义搜索
2. **增量索引**：当新会话写入时，增量更新元数据缓存，而非全量重建
3. **会话标签 UI**：提供更友好的标签管理界面，支持标签自动补全

### 9.2 中期改进

4. **云端会话融合**：本地会话与云端会话统一视图
5. **会话分支与合并**：支持从会话某点分叉，或合并多个会话
6. **选择性恢复**：支持仅恢复文件历史、仅恢复计划、或仅恢复技能

### 9.3 长期改进

7. **跨设备同步**：安全地跨设备同步会话
8. **会话分析**：分析用户会话模式，提供个性化建议
9. **团队会话库**：团队共享会话库，支持权限控制和搜索
