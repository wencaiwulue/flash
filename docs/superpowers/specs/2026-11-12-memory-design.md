---
id: memory
batch: 3
title: Memory 记忆加载、提取与同步设计
date: 2026-11-12
status: draft
---

# Memory 记忆加载、提取与同步设计

本文档是对当前记忆系统实现的回溯性设计说明，包括记忆类型、目录结构、索引截断、记忆加载与检索、提取/团队同步/自动整理（autoDream）、并发写入与失败隔离、隐私边界。

## 1. 问题与约束

Claude Code 需要记忆用户偏好、项目上下文、团队共享信息，同时保证：

- 记忆不保存可从当前项目派生的内容（代码模式、架构、git 历史、文件结构）
- 记忆索引大小有限制（避免占用过多上下文 token）
- 团队记忆同步有安全边界（防止路径遍历、symlink 逃逸）
- 自动提取与主代理写入不冲突
- 支持用户手动整理和团队同步

### 调用方与责任边界

- **上游**：query.ts 主循环、ClaudeMD 系统（用于注入记忆到上下文）、各种命令（/remember、/dream、/summary 等）
- **本层**：记忆系统核心（memdir）、Session Memory、Extract Memories、Team Memory Sync、Auto Dream
- **下游**：文件系统（存储记忆）、Claude API（提取/整理记忆）、GitHub（团队记忆的仓库标识）

### 约束条件

- 记忆类型限于 4 种：user（用户信息）、feedback（反馈/行为指南）、project（项目信息）、reference（外部资源引用）
- 不保存可从当前项目状态派生的内容：代码模式、架构、git 历史、文件结构等
- 记忆索引（MEMORY.md）有硬性限制：最多 200 行，最多 25,000 字节
- 团队记忆同步有大小限制：单个文件最多 250,000 字节，PUT 体最多 200,000 字节
- 团队记忆有隐私边界：team 目录是共享的，auto 目录是私有的

### Feature Gates 与 Disabled 机制

- **build-time gates**：`feature('TEAMMEM')`（团队记忆）、`feature('KAIROS')`（KAIROS 长会话模式的每日日志）
- **runtime gates**：`tengu_passport_quail`（启用 extractMemories 自动提取）、`tengu_onyx_plover`（启用 autoDream 自动整理）、`tengu_bramble_lintel`（extractMemories 运行间隔）、`tengu_coral_fern`（启用搜索过去上下文）、`tengu_moth_copse`（跳过索引编辑）、`tengu_slate_thimble`（非交互会话启用 extractMemories）、`tengu_session_memory`（启用 Session Memory）
- **环境变量**：`CLAUDE_CODE_DISABLE_AUTO_MEMORY`（禁用自动记忆）、`CLAUDE_CODE_SIMPLE`（--bare 模式，禁用自动记忆）、`CLAUDE_CODE_REMOTE`（远程模式）、`CLAUDE_CODE_REMOTE_MEMORY_DIR`（远程记忆目录）、`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`（Cowork 路径覆盖）
- **用户配置**：`autoMemoryEnabled`（全局配置，可禁用自动记忆）、`autoMemoryDirectory`（配置记忆目录）

## 2. 设计理由与备选方案

### 记忆类型限定为 4 种，而非开放式集合

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 仅允许 `user`、`feedback`、`project`、`reference` 4 种类型，每种类型有明确的使用场景、范围指南和示例 |
| **为什么采用** | 限定类型提供了清晰的使用指南，避免记忆类型泛滥，帮助模型和用户形成一致的预期；不同类型有不同的共享策略：user 始终私有，feedback 默认私有但可共享给团队，project/reference 通常共享给团队 |
| **备选方案及不采用原因** | 开放式类型系统：类型会变得混乱，模型和用户会创建任意类型，导致记忆难以管理和检索；更少的类型（2 种）：粒度太粗，无法区分不同隐私边界和使用场景 |
| **代价** | 某些边缘场景可能需要的类型不在这 4 种之中，需要用户适应现有分类 |
| **证据** | `src/memdir/memoryTypes.ts`（MEMORY_TYPES、TYPES_SECTION_INDIVIDUAL、TYPES_SECTION_COMBINED 等） |

### 记忆索引（MEMORY.md）有双重截断（行 + 字节）

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | MEMORY.md 先按 200 行截断，再按 25,000 字节截断（在最后一个换行处切），截断时追加警告说明 |
| **为什么采用** | 行截断：保证索引在合理长度，避免占用太多上下文 token；字节截断：防止单个超长行（即使在 200 行内）占用过多 token；行优先：保持自然的条目边界，避免切在单个条目中间 |
| **备选方案及不采用原因** | 仅行截断：单个超长行会绕过限制，占用大量 token；仅字节截断：可能切在条目中间，破坏完整性；更高限制（如 500 行/100KB）：占用过多上下文 token |
| **代价** | 大型记忆库的索引会被截断，用户可能看不到完整索引 |
| **证据** | `src/memdir/memdir.ts`（truncateEntrypointContent 函数，MAX_ENTRYPOINT_LINES=200，MAX_ENTRYPOINT_BYTES=25000） |

### 团队记忆使用路径验证 + symlink 深度解析（realpathDeepestExisting），而非仅字符串前缀检查

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 验证路径包含三个层次：1）字符串前缀检查（快速拒绝明显遍历）；2）null 字节、URL 编码遍历、Unicode 规范化攻击检测；3）symlink 解析（对最深已存在祖先调用 realpath），验证真实路径是否在 team 目录内；团队记忆文件写入前先 validateTeamMemWritePath，远程条目写入前先 validateTeamMemKey |
| **为什么采用** | 仅字符串前缀检查易被 symlink 绕过：攻击者可在 team 内存放指向 ~/.ssh 的 symlink，然后写入 team/symlink/authorized_keys；realpathDeepestExisting 处理目标文件不存在的情况（我们可能正要创建它），对最深已存在祖先调用 realpath；多层验证提供纵深防御 |
| **备选方案及不采用原因** | 仅字符串前缀检查：不安全，易被 symlink 绕过；完全禁止 symlink：不灵活，用户可能需要在团队记忆内存放 symlink；每次都 realpath 整个路径：目标文件不存在时会失败（ENOENT） |
| **代价** | 实现复杂，有多层检查和错误处理 |
| **证据** | `src/memdir/teamMemPaths.ts`（PathTraversalError、validateTeamMemWritePath、validateTeamMemKey、realpathDeepestExisting、isRealPathWithinTeamDir 等） |

### extractMemories 与主代理互斥（检查 hasMemoryWritesSince），而非并行工作

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | extractMemories 在运行前先检查：自上次提取以来，主代理是否写入过记忆文件；如果是，则跳过本次提取，只前进 cursor 到最后一条消息；这样避免了重复工作和潜在冲突 |
| **为什么采用** | 主代理已经写入记忆，说明它已经在思考和保存，不需要 forked agent 重复提取；减少 token 消耗和延迟；避免两个代理同时编辑同一记忆文件的潜在冲突 |
| **备选方案及不采用原因** | 始终运行：浪费 token 和时间，重复工作；尝试合并两个代理的写入：复杂，容易出错 |
| **代价** | 如果主代理写入记忆但不完整，extractMemories 不会补充 |
| **证据** | `src/services/extractMemories/extractMemories.ts`（hasMemoryWritesSince 函数、runExtraction 中的检查） |

### autoDream 使用三级门（时间 → 会话数 → 锁）和扫描节流，而非固定调度

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 门顺序（从快到慢）：1）时间：自上次整理 ≥ minHours（默认 24h）；2）扫描节流：如果时间门通过但会话数不足，10 分钟内不再扫描；3）会话数：有 ≥ minSessions（默认 5 个）自上次整理以来被修改；4）锁：获取独占锁，避免多个进程同时整理；KAIROS 模式禁用 autoDream（改用磁盘 skill 的 dream） |
| **为什么采用** | 时间门：保证不会太频繁整理；会话数门：保证有足够新内容值得整理；锁：避免并发冲突；扫描节流：避免在时间门通过但会话数不足时，每轮都扫描会话目录（浪费 stat 调用） |
| **备选方案及不采用原因** | 每轮都检查：浪费 stat 调用；固定调度（如每天凌晨 2 点）：不考虑用户实际使用模式，可能在用户活跃时运行；无锁：并发整理可能导致冲突 |
| **代价** | 如果会话数增长很慢，可能需要很长时间才会触发整理 |
| **证据** | `src/services/autoDream/autoDream.ts`（isGateOpen、isForced、getConfig、SESSION_SCAN_INTERVAL_MS=10*60*1000、三级门检查） |

### 团队记忆同步采用乐观锁（ETag + If-Match）+ 冲突时探测 hashes 而非完全重拉，而非悲观锁或 last-write-wins

| 决策维度 | 说明 |
|---------|-----|
| **实际机制** | 拉取时：使用 ETag 进行条件 GET，304 Not Modified 时跳过；推送时：使用 If-Match 带上已知 ETag，412 Precondition Failed 时：1）用 ?view=hashes 快速获取服务器当前各条目的 hash（不下载内容）；2）刷新本地 serverChecksums；3）重新计算 delta（自然排除服务器已有的相同内容）；4）重试；最多重试 MAX_CONFLICT_RETRIES=2 次 |
| **为什么采用** | 乐观锁在低并发场景下性能好，无需提前获取锁；冲突时探测 hashes 而非完全重拉：节省带宽和时间（只下载 hashes，不下载内容）；本地覆盖服务器：冲突时本地编辑优先，避免用户刚做的修改被静默丢弃 |
| **备选方案及不采用原因** | 悲观锁：需要提前获取锁，增加延迟，锁释放问题复杂；简单 last-write-wins：可能静默丢弃用户的本地修改；冲突时完全重拉：浪费带宽（下载所有内容，而我们只需要 hashes 来计算 delta） |
| **代价** | 冲突时需要额外的一轮探测 hashes 请求 |
| **证据** | `src/services/teamMemorySync/index.ts`（pushTeamMemory 函数中的 412 处理、fetchTeamMemoryHashes 函数） |

## 3. 目标与非目标

### 目标

#### 状态与生命周期

- **模块级状态**：autoDream：closure-scoped（inside initAutoDream），包含 lastSessionScanAt；extractMemories：closure-scoped（inside initExtractMemories），包含 lastMemoryMessageUuid、inProgress、turnsSinceLastExtraction、pendingContext、inFlightExtractions；Session Memory：module-level（lastMemoryMessageUuid）；teamMemPaths：无（纯函数，状态由调用方传入 SyncState）
- **持久化**：记忆存储在文件系统：auto 记忆在 auto 目录，team 记忆在 auto/team 子目录；Session Memory：存储在会话目录的 .session-memory.md；autoDream：lock 文件和 lastConsolidatedAt 存储在 auto 目录；team 记忆 SyncState（lastKnownChecksum、serverChecksums、serverMaxEntries）：会话级，不持久化
- **重置**：extractMemories：initExtractMemories 创建新 closure；autoDream：initAutoDream 创建新 closure；Session Memory：resetLastMemoryMessageUuid（测试用）

#### 接口与数据

- **主要入口**：memdir：loadMemoryPrompt（加载记忆提示）、buildMemoryPrompt（构建记忆提示，用于 agent）、buildMemoryLines（构建记忆行为指南）、truncateEntrypointContent（截断 MEMORY.md）、ensureMemoryDirExists（确保记忆目录存在）、buildSearchingPastContextSection（构建搜索过去上下文部分）；paths：isAutoMemoryEnabled（检查自动记忆是否启用）、getAutoMemPath（获取 auto 记忆目录）、getAutoMemEntrypoint（获取 auto 记忆索引）、isAutoMemPath（检查路径是否在 auto 记忆目录）、getAutoMemDailyLogPath（获取 KAIROS 模式下的每日日志路径）；teamMemPaths：isTeamMemoryEnabled（检查团队记忆是否启用）、getTeamMemPath（获取 team 记忆目录）、getTeamMemEntrypoint（获取 team 记忆索引）、isTeamMemPath（检查路径是否在 team 记忆目录）、validateTeamMemWritePath（验证团队记忆写入路径）、validateTeamMemKey（验证团队记忆键）；memoryTypes：MEMORY_TYPES、parseMemoryType、TYPES_SECTION_INDIVIDUAL、TYPES_SECTION_COMBINED、WHAT_NOT_TO_SAVE_SECTION、MEMORY_DRIFT_CAVEAT、WHEN_TO_ACCESS_SECTION、TRUSTING_RECALL_SECTION、MEMORY_FRONTMATTER_EXAMPLE；Session Memory：initSessionMemory（初始化，注册 hook）、shouldExtractMemory（检查是否应该提取）、manuallyExtractSessionMemory（手动提取，/summary 命令用）；extractMemories：initExtractMemories（初始化）、executeExtractMemories（执行提取）、drainPendingExtraction（等待进行中的提取完成）、createAutoMemCanUseTool（创建记忆提取用的工具权限）；teamMemorySync：isTeamMemorySyncAvailable（检查团队记忆同步是否可用）、pullTeamMemory（拉取团队记忆）、pushTeamMemory（推送团队记忆）、syncTeamMemory（双向同步）、createSyncState（创建同步状态）、hashContent（计算内容 hash）、batchDeltaByBytes（按字节批量 delta）；autoDream：initAutoDream（初始化）、executeAutoDream（执行自动整理）
- **数据结构**：teamMemorySync.SyncState：{ lastKnownChecksum, serverChecksums, serverMaxEntries }；teamMemorySync.TeamMemoryData：{ content: { entries: { [path]: string }, entryChecksums?: { [path]: string } }, checksum?: string }；memdir.EntrypointTruncation：{ content, lineCount, byteCount, wasLineTruncated, wasByteTruncated }

#### 执行与环境

- **调用位置**：loadMemoryPrompt：从系统 prompt 加载流程调用；executeExtractMemories：从 stopHooks 调用（每次查询结束）；executeAutoDream：从 stopHooks 调用（每次查询结束）；initSessionMemory/initExtractMemories/initAutoDream：启动时初始化；teamMemorySync：从 team memory watcher 调用（文件变化时），或从相关命令调用
- **forked agent 使用**：extractMemories：使用 runForkedAgent，querySource='extract_memories'，skipTranscript=true，maxTurns=5，工具权限受限于 createAutoMemCanUseTool（仅读 Bash，仅记忆目录写）；Session Memory：使用 runForkedAgent，querySource='session_memory'，仅允许 Edit 特定记忆文件；autoDream：使用 runForkedAgent，querySource='auto_dream'，skipTranscript=true，工具权限受限于 createAutoMemCanUseTool
- **注入点**：记忆内容通过系统 prompt 或 user 上下文注入；extractMemories/autoDream 可通过 appendSystemMessage 附加 "Saved N memories" 消息

#### 依赖边界

- **上游依赖**：query-core（消息传递、abortController、forked agent）；ClaudeMD（记忆文件缓存 clearMemoryFileCaches）；GrowthBook（feature gates，通过 getFeatureValue_CACHED_MAY_BE_STALE）；Analytics（logEvent）；Git（getGithubRepo 用于 team memory 同步）；OAuth（团队记忆同步需要 first-party OAuth）
- **下游依赖**：文件系统（fs，通过 getFsImplementation）；Claude API（提取/整理记忆用 runForkedAgent 调用）；GitHub（团队记忆同步使用 repo slug 标识）
- **不拥有**：会话 transcript（会话存储拥有）；skills（skills 系统拥有）；settings（settings 系统拥有）

### 非目标

- 不替代 query-core 的对话管理
- 不处理 SDK 协议细节
- 不提供通用 token 统计（由 utils/tokens.ts 处理）
- 不重新发明 Claude API 客户端
- 不做记忆内容的语义合并（仅文件级覆盖/追加）
- 不支持记忆的分支/版本控制（git 已提供版本控制）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// memdir
function loadMemoryPrompt(): Promise<string | null>
function buildMemoryPrompt(params: { displayName: string; memoryDir: string; extraGuidelines?: string[] }): string
function buildMemoryLines(displayName: string, memoryDir: string, extraGuidelines?: string[], skipIndex?: boolean): string[]
function truncateEntrypointContent(raw: string): EntrypointTruncation
function ensureMemoryDirExists(memoryDir: string): Promise<void>
function buildSearchingPastContextSection(autoMemDir: string): string[]

// paths
function isAutoMemoryEnabled(): boolean
function getAutoMemPath(): string
function getAutoMemEntrypoint(): string
function isAutoMemPath(absolutePath: string): boolean
function getAutoMemDailyLogPath(date?: Date): string

// teamMemPaths
function isTeamMemoryEnabled(): boolean
function getTeamMemPath(): string
function getTeamMemEntrypoint(): string
function isTeamMemPath(filePath: string): boolean
async function validateTeamMemWritePath(filePath: string): Promise<string>
async function validateTeamMemKey(relativeKey: string): Promise<string>

// memoryTypes
const MEMORY_TYPES: readonly ['user', 'feedback', 'project', 'reference']
function parseMemoryType(raw: unknown): MemoryType | undefined
const TYPES_SECTION_INDIVIDUAL: readonly string[]
const TYPES_SECTION_COMBINED: readonly string[]
const WHAT_NOT_TO_SAVE_SECTION: readonly string[]
const MEMORY_DRIFT_CAVEAT: string
const WHEN_TO_ACCESS_SECTION: readonly string[]
const TRUSTING_RECALL_SECTION: readonly string[]
const MEMORY_FRONTMATTER_EXAMPLE: readonly string[]

// Session Memory
function initSessionMemory(): void
function shouldExtractMemory(messages: Message[]): boolean
async function manuallyExtractSessionMemory(messages: Message[], toolUseContext: ToolUseContext): Promise<ManualExtractionResult>
function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn

// extractMemories
function initExtractMemories(): void
async function executeExtractMemories(context: REPLHookContext, appendSystemMessage?: AppendSystemMessageFn): Promise<void>
async function drainPendingExtraction(timeoutMs?: number): Promise<void>
function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn

// teamMemorySync
function isTeamMemorySyncAvailable(): boolean
function createSyncState(): SyncState
function hashContent(content: string): string
function batchDeltaByBytes(delta: Record<string, string>): Array<Record<string, string>>
async function pullTeamMemory(state: SyncState, options?: { skipEtagCache?: boolean }): Promise<{ success: boolean; filesWritten: number; entryCount: number; notModified?: boolean; error?: string }>
async function pushTeamMemory(state: SyncState): Promise<TeamMemorySyncPushResult>
async function syncTeamMemory(state: SyncState): Promise<{ success: boolean; filesPulled: number; filesPushed: number; error?: string }>

// autoDream
function initAutoDream(): void
async function executeAutoDream(context: REPLHookContext, appendSystemMessage?: AppendSystemMessageFn): Promise<void>
```

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|-----|----------|---------|------------|----------------|
| `memdir/memoryTypes.ts` | 无（纯常量/函数） | 定义记忆类型、解析类型、提供提示文本片段 | 记忆存储/检索/同步 | 被 memdir.ts、teamMemPrompts.ts 使用 |
| `memdir/paths.ts` | 无（纯函数，使用 memoize 缓存 getAutoMemPath） | 检查自动记忆是否启用、计算记忆目录、验证路径是否在记忆目录 | 记忆内容管理、团队记忆 | 被 memdir.ts、extractMemories.ts、autoDream.ts、teamMemPaths.ts、文件系统权限检查使用 |
| `memdir/teamMemPaths.ts` | 无（纯函数） | 检查团队记忆是否启用、计算团队记忆目录、验证团队记忆路径（含 symlink 解析） | 记忆内容管理、团队记忆同步 | 被 teamMemPrompts.ts、teamMemorySync.ts、文件系统权限检查使用 |
| `memdir/memdir.ts` | 无（纯函数） | 构建记忆提示、截断索引、确保目录存在、构建搜索过去上下文部分 | 记忆提取、同步、整理 | 被系统提示加载、extractMemories.ts、autoDream.ts 使用 |
| `services/SessionMemory/sessionMemory.ts` | lastMemoryMessageUuid（module-level） | 初始化注册 hook、检查是否应该提取、手动提取、创建记忆文件专用工具权限 | 记忆存储到 auto 目录、团队记忆 | 被系统提示加载、/summary 命令使用 |
| `services/extractMemories/extractMemories.ts` | closure-scoped inside initExtractMemories：lastMemoryMessageUuid、hasLoggedGateFailure、inProgress、turnsSinceLastExtraction、pendingContext、inFlightExtractions | 初始化、执行提取、等待进行中的提取、创建记忆提取用工具权限 | Session Memory、团队记忆同步、autoDream | 被 stopHooks 调用，使用 memdir.ts、paths.ts |
| `services/teamMemorySync/index.ts` | 无（状态由调用方传入 SyncState） | 拉取、推送、双向同步、创建同步状态、计算内容 hash、按字节批量 delta | 记忆提取、整理 | 被 team memory watcher、相关命令调用，使用 teamMemPaths.ts、secretScanner.ts |
| `services/autoDream/autoDream.ts` | closure-scoped inside initAutoDream：lastSessionScanAt | 初始化、执行自动整理 | 记忆提取、团队记忆同步 | 被 stopHooks 调用，使用 memdir.ts、paths.ts、extractMemories.ts（createAutoMemCanUseTool） |

### 4.3 主控制流

#### 记忆加载（loadMemoryPrompt）

```
系统提示加载
  ↓
loadMemoryPrompt
  ├─ 检查是否启用 KAIROS 且 isAutoMemoryEnabled → buildAssistantDailyLogPrompt
  ├─ 否则检查 feature('TEAMMEM') 且 isTeamMemoryEnabled → buildCombinedMemoryPrompt
  ├─ 否则检查 isAutoMemoryEnabled → buildMemoryLines
  ├─ 否则返回 null
  ↓
确保记忆目录存在（ensureMemoryDirExists）
  ↓
计数日志（logMemoryDirCounts）
  ↓
返回提示字符串（注入到系统提示或用户上下文）
```

#### 记忆提取（executeExtractMemories）

```
查询结束，stopHooks 触发
  ↓
executeExtractMemories
  ├─ 检查 gate（tengu_passport_quail）、auto memory 启用、非远程模式
  ├─ 检查是否有 agentId（子 agent，跳过）
  ├─ 检查 inProgress → 是则设置 pendingContext，等待
  ↓
runExtraction
  ├─ 检查 hasMemoryWritesSince → 是则跳过，前进 cursor
  ├─ 检查 turnsSinceLastExtraction（tengu_bramble_lintel，默认 1 轮提取一次）
  ├─ scanMemoryFiles 获取现有记忆 → formatMemoryManifest
  ├─ buildExtractAutoOnlyPrompt 或 buildExtractCombinedPrompt
  ├─ runForkedAgent（extract_memories，maxTurns=5，skipTranscript=true）
  ├─ 前进 cursor 到最后一条消息
  ├─ extractWrittenPaths 提取写入的路径
  ├─ 如有写入且 appendSystemMessage 存在 → append "Saved N memories"
  ├─ 如有 pendingContext → 递归运行尾随提取
```

#### 团队记忆同步（syncTeamMemory）

```
watcher 触发或手动命令
  ↓
syncTeamMemory
  ↓
pullTeamMemory（skipEtagCache=true，完整拉取）
  ├─ 检查 OAuth 可用、有 git repo
  ├─ fetchTeamMemory（带 ETag 条件 GET）
  ├─ writeRemoteEntriesToLocal（验证每个路径，跳过内容相同的）
  ├─ 刷新 serverChecksums 从服务器返回的 entryChecksums
  ├─ 如有文件写入 → clearMemoryFileCaches
  ↓
pushTeamMemory
  ├─ 检查 OAuth 可用、有 git repo
  ├─ readLocalTeamMemory（扫描 secrets，跳过含 secrets 的文件，按 serverMaxEntries 截断）
  ├─ 计算 localHashes
  ├─ [冲突重试循环（最多 MAX_CONFLICT_RETRIES=2 次）]
  │   ├─ 计算 delta（localHash != serverChecksum 的条目）
  │   ├─ delta 为空 → 直接返回
  │   ├─ batchDeltaByBytes 切分成 PUT 体 ≤ 200KB 的批次
  │   ├─ 逐个批次 uploadTeamMemory（带 If-Match）
  │   ├─ 成功 → 更新 serverChecksums 和 lastKnownChecksum
  │   └─ 412 冲突 → fetchTeamMemoryHashes（仅 hashes），刷新 serverChecksums，重试
  └─ 返回结果（可能含 skippedSecrets）
```

#### Auto Dream（executeAutoDream）

```
查询结束，stopHooks 触发
  ↓
executeAutoDream
  ↓
runAutoDream（inside closure）
  ├─ 检查 gate（KAIROS 禁用、远程模式禁用、auto memory 禁用、tengu_onyx_plover 禁用 → 跳过）
  ├─ 检查时间门：readLastConsolidatedAt，hoursSince ≥ minHours（默认 24）
  ├─ 检查扫描节流：距 lastSessionScanAt ≥ 10 分钟
  ├─ 检查会话门：listSessionsTouchedSince，≥ minSessions（默认 5）且排除当前会话
  ├─ tryAcquireConsolidationLock → 获取失败则跳过
  ├─ registerDreamTask（注册后台任务，显示 UI）
  ├─ buildConsolidationPrompt（带会话列表提示）
  ├─ runForkedAgent（auto_dream，skipTranscript=true，带 abortController，onMessage 回调跟踪进度）
  ├─ completeDreamTask（标记任务完成）
  ├─ 如有文件改动且 appendSystemMessage 存在 → append "Improved N memories"
  └─ 失败 → rollbackConsolidationLock（rewind mtime 以便重试）
```

#### Session Memory（extractSessionMemory）

```
postSamplingHook 触发
  ↓
extractSessionMemory
  ├─ 检查 querySource 是 repl_main_thread（仅主线程）
  ├─ 检查 gate（tengu_session_memory）
  ├─ 初始化 config（initSessionMemoryConfigIfNeeded）
  ├─ shouldExtractMemory
  │   ├─ 初始化阈值检查：tokenCount ≥ minimumMessageTokensToInit
  │   ├─ 或更新阈值检查：token 增长 ≥ minimumTokensBetweenUpdate，或 toolCalls ≥ toolCallsBetweenUpdates
  │   └─ 且最后一轮无 tool calls（安全提取点）
  ↓
setupSessionMemoryFile
  ├─ 确保目录存在
  ├─ 如文件不存在 → 写入模板
  ├─ 清除文件缓存，读取当前内容
  ↓
buildSessionMemoryUpdatePrompt
  ↓
runForkedAgent（session_memory，仅允许 Edit 该文件）
  ↓
更新 lastSummarizedMessageId（如安全）
```

### 4.4 数据结构与持久化

```typescript
// 团队记忆同步状态
interface SyncState {
  lastKnownChecksum: string | null
  serverChecksums: Map<string, string> // path → sha256:hex
  serverMaxEntries: number | null // 从结构化 413 学习到的服务器限制
}

// 记忆索引截断结果
interface EntrypointTruncation {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

// 团队记忆数据（服务器响应）
interface TeamMemoryData {
  content: {
    entries: { [path]: string }
    entryChecksums?: { [path]: string }
  }
  checksum?: string
}

// Session Memory 配置
interface SessionMemoryConfig {
  minimumMessageTokensToInit: number
  minimumTokensBetweenUpdate: number
  toolCallsBetweenUpdates: number
}

// 记忆类型
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
```

持久化位置：
- **auto 记忆**：getAutoMemPath() → 通常 ~/.claude/projects/{sanitized-git-root}/memory/，含 MEMORY.md 索引和各个主题文件
- **team 记忆**：getTeamMemPath() → auto 目录下的 team/ 子目录，同样含 MEMORY.md 和主题文件
- **Session Memory**：getSessionMemoryPath() → 会话目录下的 .session-memory.md
- **autoDream lock/lastConsolidatedAt**：auto 目录下的 .auto-dream.lock 和 .auto-dream-last
- **KAIROS 每日日志**：auto 目录下的 logs/{YYYY}/{MM}/{YYYY-MM-DD}.md

### 4.5 模块设计卡片

#### 4.5.1 memdir 类型与路径模块

**入口签名与关键类型**
```typescript
// src/memdir/paths.ts
function isAutoMemoryEnabled(): boolean
function getAutoMemPath(): string  // memoized, returns ~/.claude/projects/{sanitized-git-root}/memory/
function getAutoMemEntrypoint(): string  // MEMORY.md full path
function isAutoMemPath(absolutePath: string): boolean  // prefix check
function getAutoMemDailyLogPath(date?: Date): string  // KAIROS mode only

// src/memdir/memoryTypes.ts
const MEMORY_TYPES: readonly ['user', 'feedback', 'project', 'reference']
type MemoryType = (typeof MEMORY_TYPES)[number]
function parseMemoryType(raw: unknown): MemoryType | undefined

const TYPES_SECTION_INDIVIDUAL: readonly string[]
const TYPES_SECTION_COMBINED: readonly string[]
const WHAT_NOT_TO_SAVE_SECTION: readonly string[]
const MEMORY_FRONTMATTER_EXAMPLE: readonly string[]
```

**输入输出**
- **输入**：配置（settings.json）、环境变量、git root
- **输出**：规范化的记忆目录绝对路径（带 trailing separator）
- **错误处理**：返回 undefined 或 false 而不是抛出；验证拒绝相对路径、根路径、UNC 路径、null byte

**状态与文件布局**
- **模块状态**：无持久状态，仅 `getAutoMemPath()` 有 closure memoization（key: projectRoot）
- **文件布局**：
  ```
  {memory-root}/
    MEMORY.md  [索引，200行/25KB双截断]
    *.md       [主题记忆文件，带 frontmatter]
    team/      [团队记忆子目录，TEAMMEM feature only]
    logs/      [KAIROS 模式每日日志]
      {YYYY}/
        {MM}/
          {YYYY-MM-DD}.md
  ```

**加载流程**
1. `isAutoMemoryEnabled()` 优先级检查：
   - `CLAUDE_CODE_DISABLE_AUTO_MEMORY` → 禁用
   - `CLAUDE_CODE_SIMPLE` → 禁用
   - `CLAUDE_CODE_REMOTE` 且无 `CLAUDE_CODE_REMOTE_MEMORY_DIR` → 禁用
   - `settings.autoMemoryEnabled` → 尊重
   - 默认 → 启用
2. `getAutoMemPath()` 解析：
   - `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` → 优先
   - `policy/local/userSettings.autoMemoryDirectory` → 其次
   - `{memoryBase}/projects/{sanitized-git-root}/memory/` → 默认
3. `validateMemoryPath()` 安全检查：绝对路径、长度 ≥3、非 drive-root、非 UNC、无 null byte

**并发与失败隔离**
- **并发安全**：memoization 使用 projectRoot 作为 key，测试可独立 init
- **失败降级**：路径验证失败返回 undefined，记忆系统不加载而不崩溃整个应用
- **无锁**：纯路径计算，无共享可变状态

**隐私与信任边界**
- **路径验证**：`isAutoMemPath()` 仅检查前缀，不解析 symlink（权限检查快速路径）
- **配置来源隔离**：projectSettings 不能覆盖 autoMemoryDirectory（防止恶意仓库）
- **覆盖模式**：Cowork 路径覆盖时，`isAutoMemPath()` 返回 true 但写权限不豁免

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 记忆目录位置 | git root 而非 cwd | 同一仓库的不同 cwd 共享记忆 | 记忆与代码库绑定，而不是与启动位置绑定 |
| 路径 memoization | closure memoize（projectRoot key） | 测试需注意隔离 | 避免每 turn 重复解析（collapseReadSearchGroups 高频调用） |
| 路径分隔符 | 强制 normalize('NFC') + 统一 trailing separator | 需注意跨平台 | 前缀匹配可靠 |

**源码测试证据**
- 源码：`src/memdir/paths.ts`、`src/memdir/memoryTypes.ts`
- 测试：**待补充**
- 证据边界：仅验证路径合法性，不验证目录可写（后续 `ensureMemoryDirExists()` 处理）

---

#### 4.5.2 MEMORY.md 索引与截断模块

**入口签名与关键类型**
```typescript
// src/memdir/memdir.ts
const ENTRYPOINT_NAME = 'MEMORY.md'
const MAX_ENTRYPOINT_LINES = 200
const MAX_ENTRYPOINT_BYTES = 25_000

type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

function truncateEntrypointContent(raw: string): EntrypointTruncation

function ensureMemoryDirExists(memoryDir: string): Promise<void>
```

**输入输出**
- **输入**：原始 MEMORY.md 字符串（可能很大）
- **输出**：截断后的字符串 + 元数据（实际行数、字节数、哪个截断生效）
- **警告消息**：追加 `\n\n> WARNING: MEMORY.md is {reason}...`

**状态与文件布局**
- **模块状态**：无
- **文件布局**：MEMORY.md 位于记忆根目录，无 frontmatter，纯条目列表
- **条目格式**：`- [Title] (topic-file.md) — one-line hook`（使用实际文件名，注意空格避免链接检查）

**截断流程**
1. **Trim**：移除首尾空白
2. **行截断优先**：
   - 超过 200 行 → 取前 200 行
3. **字节截断其次**：
   - 超过 25,000 字节 → 在最后一个换行处切分
   - 无换行时直接在 25,000 字节切分
4. **追加警告**：说明原因并建议保持条目简短

**并发与失败隔离**
- **纯函数**：无副作用，可安全并发调用
- **失败开放**：截断不抛出，过长时优雅降级（带警告）
- **幂等**：同一输入重复调用产生相同输出

**隐私与信任边界**
- **内容不解析**：仅按行/字节截断，不解释条目标题或链接
- **警告不注入**：警告消息是固定模板，无用户输入插值
- **不修改原文件**：截断仅在内存中进行，用于 prompt 注入，不写回磁盘

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 截断顺序 | 行优先 → 字节优先 | 长条目可能被字节截断 | 保持条目完整性优先 |
| 字节截断位置 | 最后一个换行处 | 可能比 25KB 略小 | 避免切在单个条目中间 |
| 截断阈值 | 200行/25KB | 大型仓库记忆索引不全 | 控制 prompt token 占用（p99 当时正好） |
| 截断行为 | 头截断 | 新条目不可见 | 实现简单，与 git log --oneline 一致 |

**源码测试证据**
- 源码：`src/memdir/memdir.ts`（`truncateEntrypointContent`、`ensureMemoryDirExists`）
- 测试：**待补充**
- 证据边界：仅处理 MEMORY.md，不处理其他记忆文件

---

#### 4.5.3 记忆检索与注入模块

**入口签名与关键类型**
```typescript
// src/memdir/memdir.ts
async function loadMemoryPrompt(): Promise<string | null>
function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string
function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex?: boolean
): string[]
function buildSearchingPastContextSection(autoMemDir: string): string[]

// 提示常量
const DIR_EXISTS_GUIDANCE: string
const DIRS_EXIST_GUIDANCE: string
```

**输入输出**
- **输入**：无（从环境/配置隐式获取）
- **输出**：完整的记忆提示字符串，或 null（记忆禁用）
- **提示结构**：
  1. 记忆系统介绍
  2. 记忆类型说明
  3. 不保存的内容
  4. 保存方法
  5. 何时访问
  6. 信任与验证
  7. MEMORY.md 内容（截断后）
  8. 搜索过去上下文（tengu_coral_fern gate）

**状态与文件布局**
- **模块状态**：无持久状态
- **缓存**：系统 prompt section 缓存（loadMemoryPrompt 本身不缓存）
- **ClaudeMD 集成**：通过 `clearMemoryFileCaches()` 与 ClaudeMD 文件缓存协调

**检索流程**
1. **特性门检查**：
   - KAIROS 激活 → `buildAssistantDailyLogPrompt()`（每日日志模式）
   - TEAMMEM 启用且团队记忆可用 → `buildCombinedMemoryPrompt()`（双目录）
   - 仅 auto 记忆 → `buildMemoryLines()`（单目录）
   - 禁用 → 返回 null
2. **目录确保**：调用 `ensureMemoryDirExists()`（递归 mkdir，吞 EEXIST）
3. **日志计数**：异步 `logMemoryDirCounts()`（不阻塞）
4. **提示构建**：同步读取 MEMORY.md 并截断，拼接所有指导文本

**并发与失败隔离**
- **异步与同步分离**：目录确保/日志计数是异步，提示构建是同步
- **目录创建失败**：吞 EACCES/EPERM/EROFS，继续返回提示（模型稍后写失败是可见的）
- **MEMORY.md 不存在**：继续返回提示（带空索引说明）
- **无锁**：文件读取是同步的，但仅读一次，无竞争窗口

**隐私与信任边界**
- **team 目录隔离**：团队记忆位于 `auto/team/` 子目录，与私有记忆明确分开
- **类型隐私标注**：user 类型始终私有，feedback 默认私有
- **不保存可推导内容**：明确提示不要保存代码模式、git history、文件结构
- **验证要求**：记忆中的函数/文件主张在推荐前要验证当前状态

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| MEMORY.md 读取 | sync readFileSync | 启动时阻塞（很短） | prompt 构建同步，可缓存 |
| 提示注入位置 | 系统 prompt / 用户上下文 | 不同模式位置不同 | 灵活适应 KAIROS/TEAMMEM |
| dir exists 指导 | 硬编码在提示中 | 提示略长 | 模型不用浪费 turn 检查/创建目录 |

**源码测试证据**
- 源码：`src/memdir/memdir.ts`（`loadMemoryPrompt`、`buildMemoryPrompt`、`buildMemoryLines`）
- 测试：**待补充**
- 证据边界：仅负责构建提示字符串，不负责模型如何使用它

---

#### 4.5.4 extractMemories 自动提取模块

**入口签名与关键类型**
```typescript
// src/services/extractMemories/extractMemories.ts
function initExtractMemories(): void  // call once at startup
async function executeExtractMemories(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn
): Promise<void>
async function drainPendingExtraction(timeoutMs?: number): Promise<void>
function createAutoMemCanUseTool(memoryDir: string): CanUseToolFn

// 内部状态（closure-scoped inside initExtractMemories）
let lastMemoryMessageUuid: string | undefined
let inProgress: boolean
let turnsSinceLastExtraction: number
let pendingContext: { context, appendSystemMessage? } | undefined
const inFlightExtractions: Set<Promise<void>>
```

**输入输出**
- **输入**：REPLHookContext（完整 messages 数组）
- **输出**：无返回值，可能通过 appendSystemMessage 追加 "Saved N memories"
- **副作用**：写入记忆目录文件，更新 lastMemoryMessageUuid

**状态与文件布局**
- **closure 状态**：每个 initExtractMemories() 创建新 closure（测试隔离）
- **持久光标**：lastMemoryMessageUuid 仅在内存中，会话重启重新处理
- **不持久状态**：inProgress、pendingContext、inFlightExtractions 都是 transient

**提取流程**
1. **门检查**：
   - tengu_passport_quail gate → 禁用则跳过
   - isAutoMemoryEnabled() → 禁用则跳过
   - 远程模式 → 跳过
   - agentId 存在（子 agent）→ 跳过
2. **并发控制**：
   - inProgress → 保存 pendingContext，等待尾随提取
3. **主代理互斥检查**：
   - `hasMemoryWritesSince(messages, lastMemoryMessageUuid)` → true 则前进 cursor 并跳过
4. **节流检查**：
   - tengu_bramble_lintel gate（默认 1 轮提取一次）→ 未满足则跳过
5. **构建提取提示**：
   - `scanMemoryFiles()` 获取现有记忆 → `formatMemoryManifest()`
   - `buildExtractAutoOnlyPrompt()` 或 `buildExtractCombinedPrompt()`
6. **运行 forked agent**：
   - `runForkedAgent(extract_memories, skipTranscript=true, maxTurns=5)`
   - 工具权限：`createAutoMemCanUseTool()`（只读 Bash，仅记忆目录可写）
7. **更新 cursor**：lastMemoryMessageUuid = last message uuid
8. **尾随提取**：pendingContext 存在则递归运行

**并发与失败隔离**
- **inProgress 标志**：防止并发提取运行
- **pendingContext 合并**：多次调用合并为一次尾随提取
- **inFlightExtractions 追踪**：`drainPendingExtraction()` 等待所有进行中提取
- **错误吞掉**：提取失败仅记录日志，不传播到主循环
- **cursor 仅在成功时前进**：失败时 cursor 保持原样，下次重试
- **尾随提取跳过节流**：确保合并的工作最终被处理

**隐私与信任边界**
- **skipTranscript=true**：forked agent 的对话不保存到会话 transcript
- **工具权限限制**：
  - Read/Grep/Glob：允许
  - Bash：仅只读命令（ls/find/grep/cat/stat/wc/head/tail）
  - FileEdit/FileWrite：仅记忆目录内路径
  - 其他：拒绝
- **不访问敏感文件**：权限限制确保 fork 不能读取 ~/.ssh 等

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 与主代理互斥 | hasMemoryWritesSince 检查 | 主代理写不完整时不会补充 | 避免重复工作，无冲突 |
| 状态封装 | closure-scoped inside initExtractMemories | 调用方必须记得 init | 测试自然隔离 |
| 工具权限 | CanUseTool 动态检查 | 实现复杂 | 安全约束严格执行 |
| 尾随提取 | 递归 runExtraction | 可能级联但不深（通常一次） | 多次调用合并，不遗漏工作 |

**源码测试证据**
- 源码：`src/services/extractMemories/extractMemories.ts`、`src/services/extractMemories/prompts.ts`
- 测试：**待补充**
- 证据边界：仅负责提取，不负责记忆质量或相关性

---

#### 4.5.5 SessionMemory 会话记忆模块

**入口签名与关键类型**
```typescript
// src/services/SessionMemory/sessionMemory.ts
function initSessionMemory(): void  // call once at startup
function shouldExtractMemory(messages: Message[]): boolean
async function manuallyExtractSessionMemory(
  messages: Message[],
  toolUseContext: ToolUseContext
): Promise<ManualExtractionResult>
function createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn

// 内部状态
let lastMemoryMessageUuid: string | undefined  // module-level

// 配置类型
type SessionMemoryConfig = {
  minimumMessageTokensToInit: number
  minimumTokensBetweenUpdate: number
  toolCallsBetweenUpdates: number
}
```

**输入输出**
- **输入**：完整 Message 数组（整个会话历史）
- **输出**：manualExtract 返回 success/error + memoryPath
- **副作用**：写入 `.session-memory.md`，可能更新 lastSummarizedMessageId

**状态与文件布局**
- **module 状态**：lastMemoryMessageUuid（仅在内存，测试可 reset）
- **会话文件**：`{projectDir}/.session-memory.md`（每项目单独）
- **配置持久化**：SessionMemoryConfig 从 tengu_sm_config gate 获取（cached）
- **不持久光标**：lastSummarizedMessageId 会话重启重置

**提取流程**
1. **门检查**：
   - querySource !== repl_main_thread（子 agent）→ 跳过
   - tengu_session_memory gate → 禁用则跳过
   - isAutoCompactEnabled() → 禁用则跳过
   - 远程模式 → 跳过
2. **阈值检查**（`shouldExtractMemory`）：
   - **初始化阈值**：tokenCount ≥ minimumMessageTokensToInit
   - **更新阈值**：token 增长 ≥ minimumTokensBetweenUpdate，或 toolCalls ≥ toolCallsBetweenUpdates
   - **安全点**：最后一轮无 tool calls（避免孤儿 tool_result）
3. **设置文件**：
   - 确保目录存在
   - 文件不存在 → 写入模板
   - 清除缓存，读取当前内容
4. **构建提示**：`buildSessionMemoryUpdatePrompt()`
5. **运行 forked agent**：
   - `runForkedAgent(session_memory)`
   - 工具权限：`createMemoryFileCanUseTool()`（仅 Edit 该文件）
   - 独立上下文，不污染父状态
6. **更新光标**：安全时（无 pending tool calls）设置 lastSummarizedMessageId

**并发与失败隔离**
- **sequential 装饰器**：防止并发提取运行
- **独立子上下文**：`createSubagentContext()` 避免污染父缓存
- **异常传播**：manualExtract 抛出异常（用户可见），自动提取仅记录日志
- **光标仅在安全时更新**：避免截断 pending tool calls

**隐私与信任边界**
- **会话本地**：`.session-memory.md` 位于项目目录，不与团队同步
- **工具权限极端限制**：仅允许 Edit 单一文件，完全没有 Read/Write/Bash
- **不保存敏感信息**：与 auto 记忆相同的类型约束

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 状态位置 | module-level（非 closure） | 测试需显式 reset | 简化 init（不用传递 state） |
| 双重阈值 | token + toolCall，任一满足 | 逻辑略复杂 | 适应不同会话模式（对话密集 vs 操作密集） |
| 安全点要求 | 最后一轮无 tool calls | 可能延迟提取 | 避免孤儿 tool_result，状态一致 |
| 工具权限 | 仅 Edit 单文件 | 模型无法读取现有内容（需先通过提示注入） | 安全边界最小化 |

**源码测试证据**
- 源码：`src/services/SessionMemory/sessionMemory.ts`、`src/services/SessionMemory/prompts.ts`、`src/services/SessionMemory/sessionMemoryUtils.ts`
- 测试：**待补充**
- 证据边界：仅负责会话级记忆，不负责长期记忆提取

---

#### 4.5.6 teamMemorySync 团队记忆同步模块

**入口签名与关键类型**
```typescript
// src/memdir/teamMemPaths.ts
function isTeamMemoryEnabled(): boolean
function getTeamMemPath(): string
function getTeamMemEntrypoint(): string
function isTeamMemPath(filePath: string): boolean
async function validateTeamMemWritePath(filePath: string): Promise<string>
async function validateTeamMemKey(relativeKey: string): Promise<string>
class PathTraversalError extends Error {}

// src/services/teamMemorySync/index.ts
type SyncState = {
  lastKnownChecksum: string | null
  serverChecksums: Map<string, string>
  serverMaxEntries: number | null
}
function createSyncState(): SyncState
function isTeamMemorySyncAvailable(): boolean
function hashContent(content: string): string
function batchDeltaByBytes(delta: Record<string, string>): Array<Record<string, string>>
async function pullTeamMemory(
  state: SyncState,
  options?: { skipEtagCache?: boolean }
): Promise<{ success, filesWritten, entryCount, notModified?, error? }>
async function pushTeamMemory(state: SyncState): Promise<TeamMemorySyncPushResult>
async function syncTeamMemory(state: SyncState): Promise<{ success, filesPulled, filesPushed, error? }>

// 常量
const TEAM_MEMORY_SYNC_TIMEOUT_MS = 30_000
const MAX_FILE_SIZE_BYTES = 250_000
const MAX_PUT_BODY_BYTES = 200_000
const MAX_RETRIES = 3
const MAX_CONFLICT_RETRIES = 2
```

**输入输出**
- **输入**：SyncState（调用方拥有，线程隔离）
- **输出**：success/error + 文件计数
- **网络请求**：GET/PUT `/api/claude_code/team_memory?repo={owner/repo}`

**状态与文件布局**
- **SyncState 所有权**：调用方创建并持有，无 module-level 可变状态
- **持久化位置**：`{autoMemPath}/team/`（auto 记忆的子目录）
- **服务器状态**：ETag、entryChecksums 缓存在 SyncState（会话级，不持久化）
- **学习的服务器限制**：serverMaxEntries 在 413 响应后缓存到 SyncState

**同步流程**

**Pull 流程**（服务器 → 本地）：
1. **先决条件**：OAuth 可用、git repo 存在
2. **条件 GET**：带 If-None-Match（ETag）
3. **304 处理**：Not Modified → 无写入
4. **404 处理**：服务器无数据 → 清除 serverChecksums
5. **路径验证**：每个 key 通过 `validateTeamMemKey()`（sanitize + symlink 解析）
6. **去重写入**：内容与本地相同 → 跳过（保持 mtime，不触发 watcher）
7. **刷新 checksums**：从响应 entryChecksums 更新 serverChecksums
8. **清除缓存**：有写入 → `clearMemoryFileCaches()`

**Push 流程**（本地 → 服务器）：
1. **先决条件**：OAuth 可用、git repo 存在
2. **读取本地**：`readLocalTeamMemory()`
   - 扫描 secrets（`scanForSecrets()`）→ 含秘密的文件跳过，记录 skippedSecrets
   - 超过 250KB 的文件跳过
   - 按 serverMaxEntries 截断（如果已学习）
3. **计算本地哈希**：`hashContent()` 每个文件
4. **冲突重试循环**（最多 MAX_CONFLICT_RETRIES=2）：
   - **delta 计算**：localHash !== serverChecksum 的条目
   - **批量切分**：`batchDeltaByBytes()` 分成 ≤200KB PUTs
   - **乐观锁上传**：带 If-Match
   - **成功**：更新 serverChecksums 和 lastKnownChecksum
   - **412 冲突**：
     - `fetchTeamMemoryHashes()`（仅 hashes，无内容）
     - 刷新 serverChecksums
     - 重试
   - **413 条目超限**：
     - 解析 extra_details.max_entries
     - 缓存到 serverMaxEntries
     - 推送失败（下次截断）
5. **返回结果**：含 skippedSecrets（如果有）

**Sync 流程**（双向）：
1. `pullTeamMemory(skipEtagCache=true)`（完整拉取，服务器优先）
2. `pushTeamMemory()`（本地优先，冲突时覆盖服务器）

**路径验证流程**（`validateTeamMemWritePath` / `validateTeamMemKey`）：
1. **字符串前缀检查**：快速拒绝明显遍历
2. **Null byte 检查**：拒绝
3. **URL 编码遍历检查**：decode 后检查
4. **Unicode 规范化检查**：NFKC 后检查
5. **Symlink 解析**：`realpathDeepestExisting()`（目标不存在时解析最深祖先）
6. **真实路径包含检查**：`isRealPathWithinTeamDir()`
7. **抛 PathTraversalError** 或返回 resolvedPath

**并发与失败隔离**
- **状态隔离**：SyncState 由调用方拥有，多个 watcher 可独立同步
- **重试机制**：网络错误最多重试 MAX_RETRIES=3 次（带 backoff）
- **冲突重试**：412 最多重试 MAX_CONFLICT_RETRIES=2 次
- **部分提交安全**：批量上传时，前序批次成功后更新 serverChecksums，失败时从失败处继续
- **秘密扫描失败开放**：含秘密的文件跳过，其他文件继续上传
- **413 学习但失败**：学习 serverMaxEntries，但本次推送失败（用户需手动清理）

**隐私与信任边界**
- **深度路径验证**：symlink 解析确保不能逃出 team 目录
- **密钥扫描**：推送前扫描所有文件，含 gitleaks patterns 的文件跳过不上传
- **仅团队类型**：user 类型记忆始终不应在 team 目录（提示层约束）
- **隔离验证**：`validateTeamMemWritePath()` 在写入时验证，`isTeamMemPath()` 仅前缀检查（权限快速路径）
- **服务器访问控制**：repo 级别权限，同一 org 的协作成员可访问

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 状态位置 | SyncState 调用方拥有 | 调用方需管理 state | 测试隔离，多 watcher 可独立同步 |
| 同步语义 | pull-first，server-wins on pull，local-wins on push | 队友的推送可能被覆盖 | 用户的本地修改不会静默丢失 |
| 乐观锁 | ETag + If-Match | 412 时需额外 hashes 请求 | 无锁等待，低并发场景性能好 |
| 冲突解决 | 本地覆盖服务器 | 可能丢失队友修改 | 简单可预测，用户可见性高 |
| 批量切分 | 200KB PUT body | 大 delta 需多次请求 | 避免网关 413 |
| 秘密扫描 | 推送前本地扫描 | 推送略慢 | 秘密永远不离开机器 |
| symlink 验证 | realpathDeepestExisting | 实现复杂 | 安全处理目标不存在的情况 |

**源码测试证据**
- 源码：`src/memdir/teamMemPaths.ts`、`src/services/teamMemorySync/index.ts`、`src/services/teamMemorySync/secretScanner.ts`、`src/services/teamMemorySync/types.ts`
- 测试：**待补充**
- 证据边界：仅同步 team 目录，不涉及 auto 目录；仅处理 markdown 文件，不处理二进制

---

#### 4.5.7 autoDream 自动整理模块

**入口签名与关键类型**
```typescript
// src/services/autoDream/autoDream.ts
function initAutoDream(): void  // call once at startup
async function executeAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn
): Promise<void>

// 内部状态（closure-scoped inside initAutoDream）
let lastSessionScanAt: number

// 配置
type AutoDreamConfig = { minHours: number; minSessions: number }
const DEFAULTS: AutoDreamConfig = { minHours: 24, minSessions: 5 }
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000  // 10min

// src/services/autoDream/consolidationLock.ts
async function readLastConsolidatedAt(): Promise<number>
async function listSessionsTouchedSince(since: number): Promise<string[]>
async function tryAcquireConsolidationLock(): Promise<number | null>
async function rollbackConsolidationLock(priorMtime: number | null): Promise<void>
```

**输入输出**
- **输入**：REPLHookContext
- **输出**：无返回值，可能通过 appendSystemMessage 追加 "Improved N memories"
- **副作用**：修改记忆文件，更新 .auto-dream-last、.auto-dream-lock

**状态与文件布局**
- **closure 状态**：lastSessionScanAt（仅在内存，会话重启重置）
- **持久锁文件**：`.auto-dream-lock`（mtime 用于获取锁）
- **持久时间戳**：`.auto-dream-last`（最后整理时间）
- **无其他持久状态**：会话列表每次重新扫描

**整理流程**
1. **门检查**（从快到慢）：
   - KAIROS 激活 → 跳过（使用磁盘 skill dream）
   - 远程模式 → 跳过
   - auto 记忆禁用 → 跳过
   - tengu_onyx_plover gate → 禁用则跳过
2. **时间门**：
   - `readLastConsolidatedAt()` → 小时数 ≥ minHours（默认 24h）
3. **扫描节流**：
   - 距上次会话扫描 < 10min → 跳过（避免每 turn stat 会话目录）
   - 更新 lastSessionScanAt
4. **会话门**：
   - `listSessionsTouchedSince(lastConsolidatedAt)`
   - 排除当前会话
   - 会话数 ≥ minSessions（默认 5）→ 继续
5. **获取锁**：
   - `tryAcquireConsolidationLock()` → 获取失败则跳过
   - 返回 priorMtime（用于失败回滚）
6. **注册后台任务**：`registerDreamTask()`（UI 可见进度）
7. **构建提示**：`buildConsolidationPrompt()`（含会话列表）
8. **运行 forked agent**：
   - `runForkedAgent(auto_dream, skipTranscript=true)`
   - 工具权限：`createAutoMemCanUseTool()`（与 extractMemories 相同）
   - 带 abortController（用户可取消）
   - onMessage 回调更新 DreamTask 进度
9. **完成任务**：`completeDreamTask()`
10. **追加消息**：有文件改动时 append "Improved N memories"

**失败回滚流程**：
- 用户取消（abortController.signal.aborted）→ DreamTask 已处理，无回滚
- 其他错误 → `rollbackConsolidationLock(priorMtime)`（rewind mtime，时间门很快重试）

**并发与失败隔离**
- **三级门 + 扫描节流**：从快到慢，避免不必要的 stat
- **锁机制**：`tryAcquireConsolidationLock()` 防止多进程/多实例并发整理
- **closure 状态隔离**：`initAutoDream()` 创建新 closure，测试独立
- **错误吞掉**：整理失败仅记录日志，不传播到主循环
- **锁回滚**：失败时 rewind mtime，时间门很快重试
- **后台任务取消**：用户可从 UI 取消，abortController 立即停止 forked agent

**隐私与信任边界**
- **skipTranscript=true**：forked agent 的对话不保存到会话 transcript
- **工具权限与 extractMemories 相同**：只读 Bash，仅记忆目录可写
- **仅整理 auto 记忆**：team 记忆不触及（避免与团队同步冲突）
- **会话列表仅 id**：提示中仅包含会话 id，不包含内容（fork 自行读取）

**设计取舍与备选**
| 取舍 | 当前选择 | 代价 | 收益 |
|------|----------|------|------|
| 门顺序 | 时间 → 扫描节流 → 会话 → 锁 | 会话不足时浪费一次 stat | 快速路径最常见（时间未到） |
| 扫描节流 | 10min | 会话达标后可能延迟最多 10min | 避免时间门通过但会话不足时每 turn stat |
| 状态封装 | closure-scoped inside initAutoDream | 调用方必须记得 init | 测试自然隔离 |
| 锁机制 | mtime-based（无 flock） | NFS 上可能不可靠 | 无需处理锁文件泄漏 |
| 失败回滚 | rewind mtime | 可能频繁重试 | 扫描节流是 backoff |
| KAIROS 禁用 | 使用磁盘 skill dream | 两套整理逻辑 | KAIROS 模式记忆范式不同（append-only logs） |

**源码测试证据**
- 源码：`src/services/autoDream/autoDream.ts`、`src/services/autoDream/config.ts`、`src/services/autoDream/consolidationLock.ts`、`src/services/autoDream/consolidationPrompt.ts`
- 测试：**待补充**
- 证据边界：仅整理，不负责验证整理质量；仅处理 auto 记忆，不处理 team 记忆

### 4.6 跨子系统依赖

- **query-core spec**：消息传递、abortController、forked agent、stopHooks/postSamplingHooks
- **ClaudeMD spec**：记忆文件注入上下文、clearMemoryFileCaches
- **Analytics spec**：tengu_memdir_loaded、tengu_memdir_disabled、tengu_team_memdir_disabled、tengu_extract_memories_fired、tengu_extract_memories_skipped_direct_write、tengu_extract_memories_extraction、tengu_extract_memories_error、tengu_extract_memories_coalesced、tengu_team_mem_sync_pull、tengu_team_mem_sync_push、tengu_team_mem_secret_skipped、tengu_team_mem_entries_capped、tengu_auto_dream_fired、tengu_auto_dream_completed、tengu_auto_dream_failed、tengu_session_memory_init、tengu_session_memory_gate_disabled、tengu_session_memory_extraction、tengu_session_memory_manual_extraction 等
- **Git spec**：getGithubRepo（团队记忆同步用）
- **OAuth spec**：团队记忆同步身份验证

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|--------|--------|-----------------|--------------|--------------|--------------|
| extractMemories 主代理已写入记忆 | hasMemoryWritesSince | 内部跳过，前进 cursor | 否（直接跳到下一轮） | cursor 前进，无其他清理 | 无可见结果，extractMemories 跳过 |
| extractMemories 进行中时新调用到来 | inProgress 检查 | pendingContext 设置，尾随提取 | 否（当前完成后尾随一次） | pendingContext 在尾随后清空 | 无可见结果，被合并到尾随提取 |
| team memory 拉取网络超时/错误 | fetchTeamMemory | 返回 success=false，含 errorType | 是，最多 MAX_RETRIES=3 次 | 无 | pullTeamMemory 返回 success=false，error 说明原因 |
| team memory 推送 412 冲突 | uploadTeamMemory 检查 412 | 内部探测 hashes，重试 | 是，最多 MAX_CONFLICT_RETRIES=2 次 | serverChecksums 刷新，无其他清理 | pushTeamMemory 返回 conflict=true 或成功（重试后） |
| team memory 推送结构化 413（条目超限） | uploadTeamMemory 解析 413 响应 | 学习 serverMaxEntries，当前推送失败 | 否（下次推送会截断到 serverMaxEntries） | serverMaxEntries 保存到 SyncState | pushTeamMemory 返回 errorCode='team_memory_too_many_entries'，serverMaxEntries 设好 |
| team memory 本地文件含 secrets | readLocalTeamMemory 调用 scanForSecrets | 内部跳过该文件，记录 skippedSecrets | 否（跳过不上传） | 无 | pushTeamMemory/syncTeamMemory 返回 skippedSecrets 列表（如有） |
| team memory 路径验证失败（遍历/symlink 逃出） | validateTeamMemWritePath/validateTeamMemKey | 抛出 PathTraversalError | 否 | 无 | 该条目被跳过，或异常向上传播 |
| autoDream 获取锁失败 | tryAcquireConsolidationLock 返回 null | 内部跳过 | 否（下一轮再试） | 无 | 无可见结果，autoDream 跳过 |
| autoDream 被用户中止 | abortController.signal.aborted | 内部返回 | 否 | DreamTask 标记为 killed，无 lock 回滚（kill 已回滚） | 后台任务显示为 killed |
| autoDream 失败（其他错误） | runForkedAgent 抛出 | 内部捕获，记录日志 | 否（但 lock 会 rollback mtime，时间门会很快重试） | rollbackConsolidationLock（rewind mtime），DreamTask 标记为 failed | 后台任务显示为 failed |
| MEMORY.md 超大，双截断 | truncateEntrypointContent | 内部截断，追加警告 | 否 | 无 | 提示中的 MEMORY.md 含警告，说明被截断 |
| Session Memory 初始化失败 | setupSessionMemoryFile | 异常向上传播 | 否 | 无 | /summary 命令返回 error |

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| team memory 路径验证：symlink 解析仅对最深已存在祖先 | realpathDeepestExisting | 实现复杂 | 安全地处理目标文件不存在的情况（我们可能正要创建它），同时防止 symlink 逃出 |
| extractMemories 状态：closure-scoped inside initExtractMemories | 不是模块级，每次 initExtractMemories 创建新 closure | 调用方需要记得 init（或测试忘记 init 会得到旧状态） | 测试自然隔离，每个测试可 init 新 closure |
| autoDream 扫描节流：10 分钟 | SESSION_SCAN_INTERVAL_MS=10*60*1000 | 会话数刚达标时，可能最多等 10 分钟才触发 | 避免时间门通过但会话数不足时，每轮都 stat 会话目录（大量无用 IO） |
| team memory 推送：本地覆盖服务器（412 时刷新 hashes 后重试，本地仍有的条目会覆盖） | pushTeamMemory 冲突解决策略 | 可能覆盖队友的修改 | 用户刚做的本地修改不会被静默丢弃（用户可见性更高） |
| team memory 拉取：服务器覆盖本地 | pullTeamMemory 总是服务器写入本地 | 可能覆盖本地未推送的修改 | 简单可预测，双向 sync 先拉后推，本地修改会在 push 时送出 |
| 记忆索引：双截断（行优先） | truncateEntrypointContent，先 200 行再 25KB | 某些大索引会被截断 | 既保持自然条目边界，又防止单个超长行占用过多 token |
| extractMemories 与主代理互斥 | hasMemoryWritesSince 检查 | 主代理写入不完整时，extractMemories 不会补充 | 节省 token 和时间，避免冲突和重复工作 |

## 6. 现状验收标准

1. **给定**一个非空 MEMORY.md，**当**调用 truncateEntrypointContent 时，**必须**按 200 行和 25KB 双截断，且追加相应警告
2. **给定**一个 team 记忆目录内的 symlink 指向外部，**当**调用 validateTeamMemWritePath 写入该 symlink 下的文件时，**必须**抛出 PathTraversalError
3. **给定**主代理刚写入记忆文件，**当** executeExtractMemories 运行时，**必须**跳过提取且前进 cursor
4. **给定** team 记忆服务器返回 412，**当** pushTeamMemory 运行时，**必须**探测 ?view=hashes、刷新 serverChecksums、重试最多 2 次
5. **给定**本地文件含 secret pattern，**当** readLocalTeamMemory 扫描时，**必须**跳过该文件且记录到 skippedSecrets
6. **给定** autoDream 时间门通过但会话数不足，**当** executeAutoDream 连续调用时，**必须**前 10 分钟内只扫描一次
7. **给定** Session Memory 达到 token/toolCall 阈值且最后一轮无 tool calls，**当** postSamplingHook 触发时，**必须**运行 extractSessionMemory

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 记忆类型限定为 4 种，带明确使用指南 | `src/memdir/memoryTypes.ts`（MEMORY_TYPES、TYPES_SECTION_INDIVIDUAL、TYPES_SECTION_COMBINED、WHAT_NOT_TO_SAVE_SECTION 等） | 需补充测试 | 不包含其他类型的支持 |
| MEMORY.md 双截断（行优先） | `src/memdir/memdir.ts`（truncateEntrypointContent，MAX_ENTRYPOINT_LINES=200，MAX_ENTRYPOINT_BYTES=25000） | 需补充测试 | 不包含智能截断（如按相关性排序） |
| 团队记忆路径验证（含 symlink 解析） | `src/memdir/teamMemPaths.ts`（validateTeamMemWritePath、validateTeamMemKey、realpathDeepestExisting、isRealPathWithinTeamDir、PathTraversalError） | 需补充测试 | 不包含 Windows 特定路径的完全测试 |
| extractMemories 与主代理互斥 | `src/services/extractMemories/extractMemories.ts`（hasMemoryWritesSince、runExtraction 中的检查） | 需补充测试 | 不包含主代理写入后 extractMemories 补充缺失部分 |
| extractMemories 并发控制（inProgress/pendingContext） | `src/services/extractMemories/extractMemories.ts`（inProgress 检查、pendingContext 设置、尾随提取递归） | 需补充测试 | 不包含大量并发调用的压力测试 |
| team memory 乐观锁+冲突探测 hashes | `src/services/teamMemorySync/index.ts`（pushTeamMemory 中的 412 处理、fetchTeamMemoryHashes） | 需补充测试 | 不包含真实 GitHub 仓库的端到端同步测试 |
| team memory secret 扫描 | `src/services/teamMemorySync/secretScanner.ts`（scanForSecrets，patterns 来自 gitleaks） | 需补充测试 | 不包含所有可能 secret pattern 的穷举测试 |
| team memory 批量 delta（按字节） | `src/services/teamMemorySync/index.ts`（batchDeltaByBytes，MAX_PUT_BODY_BYTES=200000） | 需补充测试 | 不包含超大 delta 的性能测试 |
| autoDream 三级门+扫描节流 | `src/services/autoDream/autoDream.ts`（isGateOpen、时间门、扫描节流 SESSION_SCAN_INTERVAL_MS=10min、会话数门、锁、DEFAULTS={minHours:24, minSessions:5}） | 需补充测试 | 不包含真实会话历史的端到端整理测试 |
| autoDream lock rollback | `src/services/autoDream/consolidationLock.ts`（tryAcquireConsolidationLock、rollbackConsolidationLock） | 需补充测试 | 不包含进程崩溃后锁恢复测试 |
| Session Memory 阈值检查 | `src/services/SessionMemory/sessionMemory.ts`（shouldExtractMemory、tokenCount 工具调用计数、最后一轮无 tool calls 检查） | 需补充测试 | 不包含真实会话的端到端提取测试 |
| 记忆目录路径解析（git root/override/settings） | `src/memdir/paths.ts`（getAutoMemPath、getAutoMemPathOverride、getAutoMemPathSetting、validateMemoryPath、getAutoMemBase 用 findCanonicalGitRoot） | 需补充测试 | 不包含所有配置组合的测试 |

### 未覆盖

- 记忆系统专门测试文件缺失
- 真实 GitHub 仓库团队记忆同步端到端测试
- 大量并发调用压力测试
- 所有 secret pattern 穷举测试
- 真实会话历史 autoDream 端到端测试
- Windows 特定路径团队记忆验证测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/memory.yaml)

### 本 spec 主拥有的文件组

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|----------|------------------|----------------|
| memdir-core | 记忆类型、索引截断、路径解析、提示构建 | 需补充 | src/query.ts（query-core） |
| session-memory | Session Memory 提取、阈值检查、hook 注册 | 需补充 | src/services/compact/（上下文压缩） |
| extract-memories | 自动记忆提取、并发控制、工具权限 | 需补充 | src/commands/（/remember 等命令） |
| team-memory-sync | 团队记忆拉取/推送/同步、路径验证、secret 扫描、乐观锁 | 需补充 | src/commands/（团队记忆命令） |
| auto-dream | 自动记忆整理、三级门、锁管理 | 需补充 | src/tasks/DreamTask/（任务 UI） |

### 相关子系统

- **query-core spec**：消息传递、forked agent、stopHooks/postSamplingHooks
- **ClaudeMD spec**：记忆文件注入上下文、clearMemoryFileCaches
- **Git spec**：getGithubRepo（团队记忆同步用）
- **OAuth spec**：团队记忆同步身份验证
- **Analytics spec**：记忆系统各类事件记录
- **Permissions spec**：记忆文件读写权限验证（isAutoMemPath、isTeamMemPath）

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|-------|---------------|---------|---------|--------|-------|-------|
| P2 | 记忆系统无专门测试文件，当前所有测试都是集成的 | 补充记忆系统单元测试：truncateEntrypointContent 边界情况、team memory 路径验证（含 symlink 遍历攻击）、extractMemories 并发控制、autoDream 门逻辑、secret 扫描 | 低（仅新增测试） | 每个核心模块有对应测试文件，覆盖主要路径和边界情况 | M | 设计推断 |
| P1 | team memory 路径验证不一致：读取/权限检查 isTeamMemPath (src/memdir/teamMemPaths.ts:214-220) 仅做字符串前缀检查，不解析 symlink；写入路径验证 validateTeamMemWritePath/validateTeamMemKey (src/memdir/teamMemPaths.ts:228-256, 265-284) 做完整 symlink 解析。读取路径检查用于 memoryFileDetection、sessionFileAccessHooks、teamMemoryOps（写入前检查），写入路径检查用于 teamMemorySync 写入远程内容。不一致可能导致：通过 symlink 读取 team 目录外文件，或 isTeamMemPath 允许写入但 validateTeamMemWritePath 拒绝。 | 统一路径验证：读取/权限检查也使用完整 symlink 解析验证，或明确区分读取/写入边界并在 spec 中记录差异 | 中（需要修改权限检查逻辑，确保读取路径也安全） | 读取和写入路径验证一致，symlink 逃出 team 目录的操作被明确拒绝 | S | 待运行验证 |
| P2 | extractMemories 与主代理互斥，但主代理可能写入不完整 | 增加 "部分提取" 模式：主代理写入了但仍有新内容时，extractMemories 补充缺失部分 | 中（需要协调两个代理的写入，避免冲突） | 测试主代理写入部分记忆后，extractMemories 补充剩余部分 | M | 设计推断 |
| P2 | MEMORY.md 截断是简单头截断，不考虑相关性或 freshness | 截断时优先保留近期/相关条目，或按文件名前缀分组，保留每个组的前几个 | 中（需要读取所有条目元数据，排序） | 测试大型 MEMORY.md 截断后仍包含最近修改的条目 | M | 设计推断 |
| P2 | team memory 冲突时仅本地覆盖服务器，无合并提示 | 冲突时先提示用户，说明哪些文件有冲突，让用户选择拉取/覆盖/合并 | 中（需要 UI 交互） | 冲突时用户收到明确提示，可选择操作 | M | 设计推断 |
| P2 | autoDream 仅整理 auto 记忆，不整理 team 记忆 | 扩展 autoDream 支持团队记忆整理（注意锁/并发） | 中（需要协调团队记忆同步和 autoDream） | 测试 autoDream 整理团队记忆，且与团队记忆同步不冲突 | L | 设计推断 |
| P2 | Session Memory 仅用于压缩，未集成到记忆系统 | 将 Session Memory 与 auto/team 记忆集成，如可从中提取持久记忆 | 中（需要定义边界和流程） | 测试 Session Memory 内容被提取到 auto 记忆 | M | 设计推断 |
