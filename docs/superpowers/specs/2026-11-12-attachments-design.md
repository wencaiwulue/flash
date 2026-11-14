---
id: attachments
batch: 2
title: Attachments 附件、图片与上下文注入设计
date: 2026-11-12
status: draft
---

# Attachments 附件、图片与上下文注入设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要将多种非结构化上下文注入对话，面临以下约束：
- 用户输入中的 @文件引用、粘贴的图片、IDE 选中内容需要统一处理
- 目录列表、任务提醒、动态技能、相关记忆等多种类型需要支持
- 30+ 种附件类型需要统一的接口
- 图片粘贴需要验证、调整大小、Base64 编码
- 内存文件层级注入（nested memory）需要去重和缓存
- 相关记忆需要智能预取，与模型执行并发
- 权限与隐私控制需要严格：文件路径需要权限检查，图片需要权限 0o600
- 1 秒全局超时限制，避免阻塞用户交互
- MCP 资源引用需要验证和处理
- 日期变更需要作为附件追加（不修改已缓存前缀）

## 2. 设计理由与备选方案

### 决策 2.1：单个附件类型失败不阻塞整体

**实际机制：** 每个附件类型在 `maybe()` 包装器中独立执行，捕获所有异常并返回空数组，不影响其他附件。`maybe()` 内部采样 5% 的遥测记录（成功/失败、耗时、附件大小）。

**为什么采用：**
- 附件是增强而非核心功能，降级体验优于完全失败
- 遥测可观测失败率，单独优化问题类型
- 用户仍可获得其他有用上下文

**备选方案及不采用原因：**
- 任一附件失败则整体失败（抛错）：用户体验差
- 区分关键/非关键附件，关键失败则整体失败：复杂度增加

**代价：** 部分上下文可能缺失而无显式反馈；需要依赖日志和遥测发现问题

**证据：** `src/utils/attachments.ts: maybe() 函数`

---

### 决策 2.2：1 秒全局超时限制

**实际机制：** `getAttachments()` 创建 `AbortController`，设置 1 秒超时，所有附件处理共享此超时。超时后放弃剩余未完成的附件。

**为什么采用：**
- 避免慢速附件阻塞主交互流程（用户可察觉延迟）
- 快速失败让模型优先响应用户核心输入
- 大多数附件类型可在 1 秒内完成

**备选方案及不采用原因：**
- 无超时，等待所有附件完成：用户体验差
- 每个附件类型独立超时：复杂度高

**代价：** 某些慢速附件（如大目录列表）可能偶尔缺失

**证据：** `src/utils/attachments.ts: AbortController + setTimeout(1000)`

---

### 决策 2.3：双重缓存去重（nested memory）

**实际机制：**
- `loadedNestedMemoryPaths`（不可驱逐，Set）：防止同一对话中重复注入同一 CLAUDE.md
- `readFileState`（LRU，可驱逐）：提供跨函数/跨回合去重，并跟踪文件变更

**为什么采用：**
- 两者互补：LRU 容量有限但必要，不可驱逐集合保证会话内一致性
- 避免重复注入相同内容浪费 token

**备选方案及不采用原因：**
- 仅依赖 readFileState（LRU）：可能被驱逐导致重复注入
- 仅依赖 loadedNestedMemoryPaths：无法跟踪文件变更

**证据：** `src/utils/attachments.ts: memoryFilesToAttachments() 检查`

---

### 决策 2.4：仅 ENOENT 从 readFileState 驱逐

**实际机制：** `getChangedFiles()` 仅在 `isENOENT(error)` 时从 `readFileState` 删除文件，其他错误（如原子保存临时 ENOENT、权限波动）保留缓存。

**为什么采用：**
- 编辑器原子保存（tmp→rename）会导致瞬时 ENOENT/权限错误，不应驱逐
- 永久保留会导致内存泄漏和 stale 数据
- ENOENT 是文件真删除的可靠信号

**备选方案及不采用原因：**
- 任何错误都驱逐：太激进，用户体验差
- 永不驱逐，永久保留：内存泄漏和 stale 数据

**代价：** 极少见情况下（文件真删除后立即恢复）可能错过变更

**证据：** `src/utils/attachments.ts: getChangedFiles() 错误处理`

---

### 决策 2.5：相关记忆异步预取

**实际机制：** `startRelevantMemoryPrefetch()` 启动预取，与模型/工具执行并发；预取句柄支持 `Symbol.dispose()` 自动清理；预取检查 `isAutoMemoryEnabled()`、`tengu_moth_copse` gate、单字提示跳过、已浮现记忆大小限制。

**为什么采用：**
- 记忆检索可能涉及昂贵的相似度计算，异步化消除阻塞
- 利用模型推理和工具执行的“空闲”时间预取
- 自动清理防止内存泄漏

**备选方案及不采用原因：**
- 同步检索，阻塞回合：用户体验差
- 完全不预取，仅在首次需要时检索：可能延迟

**代价：** 复杂度增加（需要管理预取句柄生命周期）；若在完成前消费可能仍需等待

**证据：** `src/utils/attachments.ts: startRelevantMemoryPrefetch()、MemoryPrefetch 类型`

---

### 决策 2.6：PDF 引用而非内联大文件

**实际机制：** `tryGetPDFReference()` 检查页数或估算大小，超过阈值返回引用而非内联；阈值基于页数（优先）或大小估算（~100KB/页）。

**为什么采用：**
- PDF 可能很大，轻松消耗整个上下文窗口
- 引用告知模型存在及其元数据，模型可显式读取需要的部分

**备选方案及不采用原因：**
- 总是内联 PDF：上下文窗口溢出
- 从不内联 PDF：小 PDF 体验差

**证据：** `src/utils/attachments.ts: tryGetPDFReference()、generateFileAttachment()`

---

### 决策 2.7：日期变更作为附件而非修改前缀

**实际机制：** `getDateChangeAttachments()` 作为附件追加日期变更消息，而非修改 `getUserContext()` 返回的前缀（避免缓存失效）；`messages[0]` 有意保留旧日期供参考。

**为什么采用：**
- 避免破坏 prompt caching（修改前缀会使整个会话缓存失效）
- 日期变更是低频率事件，作为附件追加足够

**备选方案及不采用原因：**
- 修改 getUserContext 返回的日期，使缓存失效：缓存浪费

**证据：** `src/utils/attachments.ts: getDateChangeAttachments()`

---

### 决策 2.8：结构化协议消息不从邮箱标记已读

**实际机制：** `getTeammateMailboxAttachments()` 过滤 `isStructuredProtocolMessage()`，仅标记非结构化邮箱消息为已读；结构化消息留给专用处理器（如 useInboxPoller）。

**为什么采用：**
- 协议消息（权限请求/响应、关闭等）需要由专门处理器处理
- 附件系统不应“消费”这些消息，否则专用处理器看不到它们
- 过滤确保两者可共存：人工消息作为附件，协议消息走专用路径

**证据：** `src/utils/attachments.ts: getTeammateMailboxAttachments() 过滤`

---

### 决策 2.9：图片大小双重检查（resize + validation）

**实际机制：**
- 粘贴时：`maybeResizeAndDownsampleImageBuffer()` 调整大小和下采样
- API 边界：`validateImagesForAPI()` 再次检查并抛出 `ImageSizeError`
- 关键常量：`IMAGE_MAX_WIDTH`、`IMAGE_MAX_HEIGHT`、`IMAGE_TARGET_RAW_SIZE`、`API_IMAGE_MAX_BASE64_SIZE`

**为什么采用：**
- resize 是主动优化，处理大多数常见情况
- validation 是安全网，捕获任何边缘情况（如 resize 后的意外增长）
- 分层防御比单层更可靠

**证据：** `src/utils/imageValidation.ts`、`src/utils/imagePaste.ts`

---

### 决策 2.10：计划/自动模式提醒按用户轮次计数

**实际机制：** `getPlanModeAttachmentTurnCount()` 仅计算非 meta、非 tool result 的用户消息；`PLAN_MODE_ATTACHMENT_CONFIG` 定义 `TURNS_BETWEEN_ATTACHMENTS` 和 `FULL_REMINDER_EVERY_N_ATTACHMENTS`。

**为什么采用：**
- 工具循环中可能产生大量 assistant/tool 消息，不应触发提醒
- 用户轮次是用户实际交互频率的真实反映
- 避免用户输入一次后，工具循环产生 100 条消息时频繁提醒

**证据：** `src/utils/attachments.ts: getPlanModeAttachmentTurnCount()`

---

### 决策 2.11：图片存储使用 sessionId + 随机值 + 0o600 权限

**实际机制：**
- 磁盘路径：`~/.claude/image-cache/<sessionId>/<imageId>.<ext>`
- 内存缓存：`storedImagePaths` Map<number, string>
- 文件权限：0o600（仅用户可读写）
- 旧文件清理：`MAX_STORED_IMAGE_PATHS = 200`

**为什么采用：**
- 防止敏感图片泄露
- session 隔离避免跨会话冲突
- 限制防止无限增长

**证据：** `src/utils/imageStore.ts`

---

## 3. 目标与非目标

### 目标

#### 状态与生命周期

- **模块级状态：**
  - `sentSkillNames`（Map<string, Set<string>>）：已发送技能名称
  - `pasteStore`：粘贴文本持久化（跨会话）
  - `imageStore`：图片存储（会话级）
  - `loadedNestedMemoryPaths`：嵌套记忆已加载路径（Set，不可驱逐）
  - `lastEmittedDate`：最后发送的日期
- **持久化：**
  - 粘贴文本：`~/.claude/paste-cache/<hash>.txt`
  - 图片：`~/.claude/image-cache/<sessionId>/<imageId>.<ext>`
- **重置：** 无显式重置（会话级状态自然结束）

#### 接口与数据

- **主要入口：**
  - `getAttachments()`：获取所有附件
  - `getAttachmentMessages()`：获取附件消息（AsyncGenerator）
  - `createAttachmentMessage()`：创建单个附件消息
  - `startRelevantMemoryPrefetch()`：启动相关记忆预取
  - `extractAtMentionedFiles()`：提取 @文件引用
  - `extractMcpResourceMentions()`：提取 MCP 资源引用
- **数据结构：**
  - `Attachment` 联合类型（30+ 种）
  - `PastedContent`：粘贴内容（文本/图片）
  - `MemoryPrefetch`：预取句柄

#### 执行与环境

- **调用位置：** 每个模型回合之前
- **forked agent 使用：** 无（主进程执行）
- **注入点：** 作为 attachment 类型的消息注入对话

#### 依赖边界

- **上游依赖：** 权限系统（文件路径检查）、记忆系统（相关记忆）、MCP 系统（MCP 资源）、插件系统（动态技能）
- **下游依赖：** 文件系统（读文件）、git（gitignore 检查）、MCP 客户端（MCP 资源）
- **不拥有：** 文件内容、记忆内容、MCP 资源内容（仅引用）

### 非目标

- 不处理工具结果（工具本身负责）
- 不修改已缓存的系统前缀（仅追加附件）
- 不保证所有附件都成功（单个失败不阻塞整体）
- 不提供通用文件编辑器（由专用工具负责）

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

**主要入口：**
```typescript
async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]>;

async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): AsyncGenerator<AttachmentMessage, void>;

function createAttachmentMessage(attachment: Attachment): AttachmentMessage;

function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined;
```

**Attachment 联合类型（30+ 种）：**
```typescript
type Attachment =
  // 文件相关
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | { type: 'directory'; path: string; content: string; displayPath: string }
  | { type: 'edited_text_file'; filename: string; snippet: string }
  | { type: 'edited_image_file'; filename: string; content: FileReadToolOutput }
  // IDE 相关
  | { type: 'selected_lines_in_ide'; ideName: string; lineStart: number; lineEnd: number; filename: string; content: string; displayPath: string }
  | { type: 'opened_file_in_ide'; filename: string }
  // 任务与提醒
  | { type: 'todo_reminder'; content: TodoList; itemCount: number }
  | { type: 'task_reminder'; content: Task[]; itemCount: number }
  // 记忆与上下文
  | { type: 'nested_memory'; path: string; content: MemoryFileInfo; displayPath: string }
  | { type: 'relevant_memories'; memories: Array<{ path: string; content: string; mtimeMs: number; header?: string; limit?: number }> }
  // 技能与代理
  | { type: 'dynamic_skill'; skillDir: string; skillNames: string[]; displayPath: string }
  | { type: 'skill_listing'; content: string; skillCount: number; isInitial: boolean }
  | { type: 'skill_discovery'; skills: Array<{ name: string; description: string; shortId?: string }>; signal: DiscoverySignal; source: 'native' | 'aki' | 'both' }
  | AgentMentionAttachment
  // 命令与队列
  | { type: 'queued_command'; prompt: string | Array<ContentBlockParam>; source_uuid?: UUID; imagePasteIds?: number[]; commandMode?: string; origin?: MessageOrigin; isMeta?: boolean }
  // 模式与状态
  | { type: 'plan_mode'; reminderType: 'full' | 'sparse'; isSubAgent?: boolean; planFilePath: string; planExists: boolean }
  | { type: 'plan_mode_reentry'; planFilePath: string }
  | { type: 'plan_mode_exit'; planFilePath: string; planExists: boolean }
  | { type: 'auto_mode'; reminderType: 'full' | 'sparse' }
  | { type: 'auto_mode_exit' }
  | { type: 'pen_mode_enter' }
  | { type: 'pen_mode_exit' }
  // MCP 与集成
  | { type: 'mcp_resource'; server: string; uri: string; name: string; description?: string; content: ReadResourceResult }
  | { type: 'command_permissions'; allowedTools: string[]; model?: string }
  // 诊断与系统
  | { type: 'diagnostics'; files: DiagnosticFile[]; isNew: boolean }
  | { type: 'critical_system_reminder'; content: string }
  | { type: 'output_style'; style: string }
  // 任务与状态
  | { type: 'task_status'; taskId: string; taskType: TaskType; status: TaskStatus; description: string; deltaSummary: string | null; outputFilePath?: string }
  // 异步与钩子
  | AsyncHookResponseAttachment
  | HookAttachment
  // Token 与预算
  | { type: 'token_usage'; used: number; total: number; remaining: number }
  | { type: 'budget_usd'; used: number; total: number; remaining: number }
  | { type: 'output_token_usage'; turn: number; session: number; budget: number | null }
  // 结构化输出
  | { type: 'structured_output'; data: unknown }
  // 团队与协作
  | TeammateMailboxAttachment
  | TeamContextAttachment
  // 调用的技能
  | { type: 'invoked_skills'; skills: Array<{ name: string; path: string; content: string }> }
  // 验证与提醒
  | { type: 'verify_plan_reminder' }
  // 限制与状态
  | { type: 'max_turns_reached'; maxTurns: number; turnCount: number }
  | { type: 'current_session_memory'; content: string; path: string; tokenCount: number }
  // 团队与关闭
  | { type: 'teammate_shutdown_batch'; count: number }
  // 压缩与效率
  | { type: 'compaction_reminder' }
  | { type: 'context_efficiency' }
  // 日期变更
  | { type: 'date_change'; newDate: string }
  // 深层思考
  | { type: 'ultrathink_effort'; level: 'high' }
  // 延迟工具与代理
  | { type: 'deferred_tools_delta'; addedNames: string[]; addedLines: string[]; removedNames: string[] }
  | { type: 'agent_listing_delta'; addedTypes: string[]; addedLines: string[]; removedTypes: string[]; isInitial: boolean; showConcurrencyNote: boolean }
  | { type: 'mcp_instructions_delta'; addedNames: string[]; addedBlocks: string[]; removedNames: string[] }
  // 伴侣介绍
  | { type: 'companion_intro'; name: string; species: string }
  // Bagel 控制台
  | { type: 'bagel_console'; errorCount: number; warningCount: number; sample: string };
```

### 4.2 模块设计卡

#### 模块 1：getAttachments 主协调器

**真实入口签名与关键类型：**
```typescript
async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]>

async function maybe<A>(
  label: string,
  fn: () => Promise<A[]>
): Promise<A[]>
```

**输入输出：**
- **输入**：用户输入、工具上下文、IDE 选择、排队命令、历史消息、查询源、选项
- **输出**：过滤后的 Attachment 数组（移除 undefined/null）
- **快速路径**：`CLAUDE_CODE_DISABLE_ATTACHMENTS` 或 `SIMPLE` 环境变量 → 仅返回 queued_command 附件

**附件与缓存状态：**
- **全局超时**：1000ms 超时 AbortController
- **模块级状态**：无（每次调用独立）
- **工具上下文依赖**：`toolUseContext.abortController`、`toolUseContext.readFileState`、`toolUseContext.loadedNestedMemoryPaths`、`toolUseContext.nestedMemoryAttachmentTriggers`

**解析/并行处理/注入/失效流程：**
```
1. 快速路径检查（禁用附件环境变量）
   └─ 是 → 仅返回 queued_command 附件
   └─ 否 → 继续

2. 创建 AbortController，设置 1000ms 超时
   └─ setTimeout(1000ms, ac.abort)
   └─ 所有附件处理共享此 Controller

3. 步骤 1：处理用户输入附件（并行）
   ├─ maybe('at_mentioned_files') → processAtMentionedFiles()
   ├─ maybe('mcp_resources') → processMcpResourceAttachments()
   ├─ maybe('agent_mentions') → processAgentMentions()
   └─ maybe('skill_discovery') → getTurnZeroSkillDiscovery()
   └─ Promise.all() 等待完成
   └─ 触发 nestedMemoryAttachmentTriggers

4. 步骤 2：处理线程安全附件（并行）
   ├─ maybe('queued_commands') → getQueuedCommandAttachments()
   ├─ maybe('date_change') → getDateChangeAttachments()
   ├─ maybe('ultrathink_effort') → getUltrathinkEffortAttachment()
   ├─ maybe('deferred_tools_delta') → getDeferredToolsDeltaAttachment()
   ├─ maybe('agent_listing_delta') → getAgentListingDeltaAttachment()
   ├─ maybe('mcp_instructions_delta') → getMcpInstructionsDeltaAttachment()
   ├─ maybe('companion_intro') → getCompanionIntroAttachment()
   ├─ maybe('changed_files') → getChangedFiles()
   ├─ maybe('nested_memory') → getNestedMemoryAttachments()
   ├─ maybe('dynamic_skill') → getDynamicSkillAttachments()
   ├─ maybe('skill_listing') → getSkillListingAttachments()
   ├─ maybe('plan_mode') → getPlanModeAttachments()
   ├─ maybe('plan_mode_exit') → getPlanModeExitAttachment()
   ├─ maybe('auto_mode') → getAutoModeAttachments()
   ├─ maybe('auto_mode_exit') → getAutoModeExitAttachment()
   ├─ maybe('todo_reminders') → getTodoReminderAttachments()
   ├─ maybe('teammate_mailbox') → getTeammateMailboxAttachments()
   ├─ maybe('team_context') → getTeamContextAttachment()
   ├─ maybe('agent_pending_messages') → getAgentPendingMessageAttachments()
   ├─ maybe('critical_system_reminder') → getCriticalSystemReminderAttachment()
   ├─ maybe('compaction_reminder') → getCompactionReminderAttachment()
   └─ maybe('context_efficiency') → getContextEfficiencyAttachment()
   └─ Promise.all() 并行执行

5. 步骤 3：主线程专有附件（并行，仅 if isMainThread）
   ├─ maybe('ide_selection') → getSelectedLinesFromIDE()
   ├─ maybe('ide_opened_file') → getOpenedFileFromIDE()
   ├─ maybe('output_style') → getOutputStyleAttachment()
   ├─ maybe('diagnostics') → getDiagnosticAttachments()
   ├─ maybe('lsp_diagnostics') → getLSPDiagnosticAttachments()
   ├─ maybe('unified_tasks') → getUnifiedTaskAttachments()
   ├─ maybe('async_hook_responses') → getAsyncHookResponseAttachments()
   ├─ maybe('token_usage') → getTokenUsageAttachment()
   ├─ maybe('budget_usd') → getMaxBudgetUsdAttachment()
   ├─ maybe('output_token_usage') → getOutputTokenUsageAttachment()
   └─ maybe('verify_plan_reminder') → getVerifyPlanReminderAttachment()
   └─ Promise.all() 并行执行

6. 步骤 4：等待所有附件完成，clearTimeout
   └─ 清除超时定时器

7. 步骤 5：合并并过滤结果
   └─ [...userAttachmentResults, ...threadAttachmentResults, ...mainThreadAttachmentResults]
   └─ filter(a => a !== undefined && a !== null)
```

**错误与隐私：**
- **错误处理**：每个 maybe() 内部 try/catch，返回 []，不影响其他附件
- **隐私**：通过 `isFileReadDenied()` 检查文件权限
- **遥测采样**：5% 采样率记录 `tengu_attachment_compute_duration`
- **超时处理**：AbortController 1000ms 后放弃剩余附件

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 全局超时 vs 每个附件独立超时 | 全局 1000ms 超时 | 某些慢速附件可能缺失 | 用户体验一致，避免阻塞 |
| maybe() 包装器 vs 抛出错误 | maybe() 返回 [] | 失败无声无息 | 单个附件失败不阻塞整体 |
| 三步并行结构 vs 串行 | 三步并行（用户输入→线程安全→主线程） | 复杂度稍高 | 最大化并行度，减少总耗时 |

**源码/测试证据：**
- 源码：`src/utils/attachments.ts:748-1012`
- 关键常量：无（内联 1000ms）
- 测试：无独立测试，通过集成测试间接验证

---

#### 模块 2：@文件引用解析器

**真实入口签名与关键类型：**
```typescript
function extractAtMentionedFiles(content: string): string[]
function parseAtMentionedFileLines(mention: string): {
  filename: string
  lineStart?: number
  lineEnd?: number
}
async function processAtMentionedFiles(
  input: string,
  toolUseContext: ToolUseContext
): Promise<Attachment[]>
async function generateFileAttachment(
  absoluteFilename: string,
  toolUseContext: ToolUseContext,
  successEvent: string,
  errorEvent: string,
  mode: 'at-mention' | 'read-tool',
  options?: { offset?: number; limit?: number }
): Promise<Attachment | null>
```

**输入输出：**
- **输入**：用户输入字符串（包含 @ 引用）
- **输出**：FileAttachment | PDFReferenceAttachment | AlreadyReadFileAttachment | directory 附件 | null
- **支持语法**：
  - `@filename.txt`：简单文件引用
  - `@"file with spaces.txt"`：带空格文件
  - `@file.txt#L10`：单行引用
  - `@file.txt#L10-20`：范围引用

**附件与缓存状态：**
- **触发嵌套记忆**：`toolUseContext.nestedMemoryAttachmentTriggers.add(absoluteFilename)`
- **PDF 阈值**：`PDF_AT_MENTION_INLINE_THRESHOLD`（页数优先，否则 ~100KB/页估算）
- **已读缓存**：`toolUseContext.readFileState` → AlreadyReadFileAttachment

**解析/并行处理/注入/失效流程：**
```
1. extractAtMentionedFiles(input)
   ├─ 匹配正则：/(^|\s)@"([^"]+)"/g 和 /(^|\s)@([^\s]+)\b/g
   ├─ 跳过 agent 引用（如 @"code-reviewer (agent)")
   ├─ 去重
   └─ 返回文件名数组

2. 并行 processAtMentionedFiles()
   └─ Promise.all(files.map(async file => ...))

3. 每个文件处理流程
   ├─ parseAtMentionedFileLines() 解析行范围
   ├─ expandPath() → 绝对路径
   ├─ isFileReadDenied() 权限检查
   │  └─ 是 → 返回 null
   │  └─ 否 → 继续
   ├─ stat() 检查是目录还是文件
   │  ├─ 目录 → readdir()，MAX_DIR_ENTRIES=1000 截断
   │  │  └─ 返回 { type: 'directory', path, content, displayPath }
   │  └─ 文件 → generateFileAttachment()
   │     ├─ PDF 检查（仅 at-mention 模式）
   │     │  ├─ getPDFPageCount() 获取页数
   │     │  └─ 超过阈值 → PDFReferenceAttachment
   │     ├─ 已读缓存检查（仅 at-mention 模式）
   │     │  └─ 未修改 → AlreadyReadFileAttachment
   │     ├─ FileReadTool 读取文件
   │     └─ 出错时尝试截断版本
   └─ 返回 Attachment 或 null
```

**错误与隐私：**
- **权限检查**：`isFileReadDenied()` 拒绝访问敏感路径
- **错误隔离**：单个文件解析失败不影响其他文件
- **事件记录**：`tengu_at_mention_extracting_filename_success` / `tengu_at_mention_extracting_filename_error`

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 两种引用格式（带引号/不带引号） | 都支持 | 解析逻辑稍复杂 | 用户体验友好 |
| 目录列出限制 | MAX_DIR_ENTRIES=1000 | 大目录被截断 | 避免超大附件 |
| PDF 引用 vs 内联 | 阈值判断 | 大 PDF 需要显式读取 | 避免上下文窗口溢出 |

**源码/测试证据：**
- 源码：`src/utils/attachments.ts:2765-2860` (extract/parse)、`src/utils/attachments.ts:1903-1973` (process)
- 关键常量：`src/constants/apiLimits.ts:PDF_AT_MENTION_INLINE_THRESHOLD`
- 测试：无独立测试

---

#### 模块 3：图片粘贴与缩放处理器

**真实入口签名与关键类型：**
```typescript
// imagePaste.ts
export async function hasImageInClipboard(): Promise<boolean>
export async function getImageFromClipboard(): Promise<ImageWithDimensions | null>
export async function tryReadImageFromPath(
  text: string
): Promise<(ImageWithDimensions & { path: string }) | null>
export function isImageFilePath(text: string): boolean
export function asImageFilePath(text: string): string | null

// imageResizer.ts
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string
): Promise<ResizeResult>

// imageValidation.ts
export function validateImagesForAPI(messages: unknown[]): void
export class ImageSizeError extends Error

// 关键常量
IMAGE_MAX_WIDTH = 2000
IMAGE_MAX_HEIGHT = 2000
IMAGE_TARGET_RAW_SIZE = 3750000  // 3.75MB raw
API_IMAGE_MAX_BASE64_SIZE = 5242880  // 5MB base64
```

**输入输出：**
- **输入**：剪贴板图片、拖拽文件路径
- **输出**：`ImageBlockParam` 类型（base64 编码，已缩放）
- **支持格式**：PNG、JPEG、GIF、WebP、BMP（自动转为 PNG）

**附件与缓存状态：**
- **图片存储**：`~/.claude/image-cache/<sessionId>/<imageId>.<ext>`，权限 0o600
- **内存缓存**：`storedImagePaths: Map<number, string>`，`MAX_STORED_IMAGE_PATHS=200`
- **PastedContent**：`{ id, type, content, mediaType?, filename?, dimensions?, sourcePath? }`

**解析/并行处理/注入/失效流程：**
```
1. 剪贴板检测
   ├─ macOS 优先：原生 NSPasteboard（~0.03ms 检查，~5ms 读取）
   │  ├─ feature('NATIVE_CLIPBOARD_IMAGE') + tengu_collage_kaleidoscope gate
   │  └─ image-processor-napi 模块
   └─ 回退：osascript / xclip / wl-paste / PowerShell

2. 图片读取
   ├─ macOS：原生读取 PNG 字节，CoreGraphics 缩放到 IMAGE_MAX_WIDTH/HEIGHT
   ├─ 其他平台：临时文件 → 读取 → 删除
   └─ BMP 检测 → Sharp 转换为 PNG

3. 缩放处理（maybeResizeAndDownsampleImageBuffer）
   ├─ Sharp 读取 metadata 获取尺寸
   ├─ 检查：raw size ≤ 3.75MB && width ≤ 2000 && height ≤ 2000
   │  └─ 满足 → 直接返回
   ├─ 尺寸超限 → 等比例缩放到 ≤ 2000×2000
   ├─ 大小超限：
   │  ├─ PNG 先尝试 PNG 压缩（compressionLevel:9, palette:true）
   │  └─ 仍超限 → JPEG 压缩（80→60→40→20 质量梯度）
   └─ 返回 ResizeResult：{ buffer, mediaType, dimensions? }

4. API 边界验证（validateImagesForAPI）
   ├─ 检查 base64 长度 ≤ 5MB
   └─ 超限 → 抛出 ImageSizeError

5. 队列命令构建（buildImageContentBlocks）
   ├─ 过滤 isValidImagePaste()
   ├─ maybeResizeAndDownsampleImageBlock() 再次确保大小
   └─ 构建 ImageBlockParam 数组
```

**错误与隐私：**
- **图片权限**：0o600 仅用户可读写
- **错误分类**：`ERROR_TYPE_MODULE_LOAD`、`ERROR_TYPE_PROCESSING`、`ERROR_TYPE_PIXEL_LIMIT`、`ERROR_TYPE_MEMORY`、`ERROR_TYPE_TIMEOUT`、`ERROR_TYPE_VIPS`、`ERROR_TYPE_PERMISSION`
- **事件**：`tengu_image_api_validation_failed`
- **BMP 转换**：自动处理 WSL2 Windows BMP 复制

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 原生 vs osascript | 优先原生，失败回退 | 代码复杂度 | macOS 性能提升 300×（5ms vs 1.5s） |
| 尺寸限制 2000×2000 | 等比例缩放 | 细节损失 | 避免超大像素处理 |
| JPEG 质量梯度 | 80→60→40→20 | 多次尝试 | 在质量和大小间平衡 |
| 双重检查（resize+validation） | resize+validation | 冗余 | 分层防御更可靠 |
| base64 直接检查 | 检查编码后长度 | 不是原始大小 | 与 API 限制精确匹配 |

**源码/测试证据：**
- 源码：`src/utils/imagePaste.ts`、`src/utils/imageResizer.ts`、`src/utils/imageValidation.ts`、`src/utils/imageStore.ts`
- 关键常量：`src/constants/apiLimits.ts:IMAGE_MAX_WIDTH`、`IMAGE_MAX_HEIGHT`、`IMAGE_TARGET_RAW_SIZE`、`API_IMAGE_MAX_BASE64_SIZE`
- 测试：无独立测试

---

#### 模块 4：相关记忆预取器

**真实入口签名与关键类型：**
```typescript
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  consumedOnIteration: number
  [Symbol.dispose](): void
}

export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext
): MemoryPrefetch | undefined

async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>
): Promise<Attachment[]>

export function collectSurfacedMemories(
  messages: ReadonlyArray<Message>
): { paths: Set<string>; totalBytes: number }

export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal
): Promise<Array<{
  path: string
  content: string
  mtimeMs: number
  header: string
  limit?: number
}>>

export function memoryHeader(path: string, mtimeMs: number): string

export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache
): Attachment[]

// 关键常量
const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 4096
const RELEVANT_MEMORIES_CONFIG = { MAX_SESSION_BYTES: 60 * 1024 }
```

**输入输出：**
- **输入**：历史消息数组、工具上下文
- **输出**：`MemoryPrefetch` 句柄（可选）或 undefined
- **记忆格式**：`{ type: 'relevant_memories', memories: Array<{ path, content, mtimeMs, header?, limit? }> }`

**附件与缓存状态：**
- **Gate 检查**：`isAutoMemoryEnabled()` + `tengu_moth_copse` 特征 flag
- **已浮现路径**：`collectSurfacedMemories(messages)` → Set<string> + totalBytes
- **会话上限**：60KB totalBytes，超限停止预取
- **注入后标记**：`filterDuplicateMemoryAttachments()` 将路径写入 `readFileState` 去重

**解析/并行处理/注入/失效流程：**
```
1. startRelevantMemoryPrefetch() gate 检查
   ├─ isAutoMemoryEnabled() → false → 返回 undefined
   ├─ tengu_moth_copse → false → 返回 undefined
   ├─ 找最后一条非 meta 用户消息 → 无 → 返回 undefined
   ├─ 提取用户消息文本 → 单字提示（无空格）→ 返回 undefined
   ├─ collectSurfacedMemories() → totalBytes ≥ 60KB → 返回 undefined
   └─ 全部通过 → 继续

2. 创建预取句柄
   ├─ createChildAbortController(toolUseContext.abortController)
   ├─ 启动 getRelevantMemoryAttachments()（不 await）
   ├─ 返回 MemoryPrefetch：{ promise, settledAt: null, consumedOnIteration: -1, [Symbol.dispose] }
   └─ promise.finally() 设置 settledAt = Date.now()

3. getRelevantMemoryAttachments() 执行
   ├─ 检查是否 @ 提到 agent → 是 → 搜索该 agent memory dir
   │  └─ 否 → 搜索 auto memory dir
   ├─ findRelevantMemories() 并行搜索所有 dir
   ├─ 过滤已在 readFileState 或 alreadySurfaced 的路径
   ├─ 取前 5 条
   └─ readMemoriesForSurfacing() 读取内容

4. readMemoriesForSurfacing() 处理
   ├─ readFileInRange(0, MAX_MEMORY_LINES, MAX_MEMORY_BYTES, { truncateOnByteLimit: true })
   ├─ 截断 → 添加提示："This memory file was truncated..."
   ├─ memoryHeader() 构建 header（预计算，避免 prompt cache 失效）
   └─ 返回 { path, content, mtimeMs, header, limit? }

5. 使用时（query.ts）
   ├─ await handle.promise（若需要）
   ├─ filterDuplicateMemoryAttachments() 过滤并标记到 readFileState
   └─ using 语句结束 → Symbol.dispose() → controller.abort()
   └─ 记录 tengu_memdir_prefetch_collected 事件
```

**错误与隐私：**
- **Abort 处理**：`isAbortError()` 检查，忽略取消错误
- **记忆去重**：双重去重（alreadySurfaced Set + readFileState）
- **Header 预计算**：避免每次渲染重新计算 `memoryFreshnessText()` 导致 prompt cache 失效
- **Symbol.dispose 清理**：自动取消未完成预取，防止内存泄漏

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 预取时机 | 每个用户回合启动 | 可能浪费计算 | 与模型推理并行，零阻塞 |
| 会话字节上限 | 60KB | 长会话后期停止 | 控制 token 消耗 |
| 单字提示跳过 | 无空格不预取 | 某些短查询无记忆 | 避免无意义计算 |
| MemoryPrefetch disposable | Symbol.dispose | 稍新的 JS 特性 | 自动生命周期管理 |
| header 预计算 | 创建时计算好 | 稍多内存 | 避免 prompt cache 失效 |
| 标记时机 | filterDuplicateMemoryAttachments 时 | 预取时不标记 | 避免自引用过滤失效 |

**源码/测试证据：**
- 源码：`src/utils/attachments.ts:2204-2549`
- 关键常量：`src/utils/attachments.ts:272-291`
- 测试：无独立测试

---

#### 模块 5：嵌套 CLAUDE.md 注入器

**真实入口签名与关键类型：**
```typescript
async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext
): Promise<Attachment[]>

async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext }
): Promise<Attachment[]>

export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string
): { nestedDirs: string[]; cwdLevelDirs: string[] }

export function memoryFilesToAttachments(
  memoryFiles: MemoryFileInfo[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string
): Attachment[]

// 关键状态
toolUseContext.loadedNestedMemoryPaths: Set<string>  // 不可驱逐
toolUseContext.readFileState: FileStateCache  // LRU 可驱逐
toolUseContext.nestedMemoryAttachmentTriggers: Set<string>  // 触发路径
```

**输入输出：**
- **输入**：触发文件路径（来自 @ 引用或 IDE 打开文件）
- **输出**：`{ type: 'nested_memory', path, content, displayPath }` 附件数组
- **处理顺序**：Managed/User 条件 → nested dirs CLAUDE.md → cwd-level 条件

**附件与缓存状态：**
- **双重去重**：`loadedNestedMemoryPaths`（不可驱逐 Set）+ `readFileState`（LRU）
- **触发器收集**：`processAtMentionedFiles()` 和 `getOpenedFileFromIDE()` 写入 `nestedMemoryAttachmentTriggers`
- **部分内容标记**：`contentDiffersFromDisk` → `readFileState` 标记 `isPartialView: true`

**解析/并行处理/注入/失效流程：**
```
1. getNestedMemoryAttachments() 检查触发器
   ├─ nestedMemoryAttachmentTriggers 为空 → 返回 []
   └─ 否则，对每个 trigger 路径调用 getNestedMemoryAttachmentsForFile()

2. getNestedMemoryAttachmentsForFile() 处理单个路径
   ├─ pathInAllowedWorkingPath() 权限检查 → 否 → 返回 []
   ├─ Phase 1：getManagedAndUserConditionalRules() 处理条件规则
   ├─ Phase 2：getDirectoriesToProcess() 获取目录列表
   │  ├─ nestedDirs：CWD → targetPath 之间的目录（CLAUDE.md + 无条件 + 条件）
   │  └─ cwdLevelDirs：根 → CWD 的目录（仅条件）
   ├─ Phase 3：getMemoryFilesForNestedDirectory() 处理 nestedDirs
   │  └─ 可选跳过 Project/Local（tengu_paper_halyard gate）
   ├─ Phase 4：getConditionalRulesForCwdLevelDirectory() 处理 cwdLevelDirs
   └─ 每阶段后调用 memoryFilesToAttachments()

3. memoryFilesToAttachments() 转换并去重
   ├─ for each memoryFile
   │  ├─ loadedNestedMemoryPaths.has() → 已加载 → 跳过
   │  ├─ readFileState.has() → 已读取 → 跳过
   │  ├─ 创建 nested_memory 附件
   │  ├─ loadedNestedMemoryPaths.add(path)
   │  ├─ readFileState.set(path, { content, timestamp, isPartialView })
   │  │  └─ contentDiffersFromDisk → 缓存 rawContent
   │  └─ hasInstructionsLoadedHook() → 执行 InstructionsLoaded 钩子
   └─ 返回 Attachment[]
```

**错误与隐私：**
- **权限检查**：`pathInAllowedWorkingPath()` 拒绝敏感路径
- **钩子执行**：InstructionsLoaded 钩子用于审计/可观测
- **去重保证**：loadedNestedMemoryPaths 不可驱逐 → 同一会话不会重复注入

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 双重去重结构 | Set + LRU | 状态复杂度 | 会话一致性 + 跨回合去重 |
| 触发器收集 | 两步（用户输入先处理） | 协调稍复杂 | nested_memory 能看到 @ 引用的文件 |
| 四阶段处理顺序 | Managed/User → nested → cwd-level | 需严格按序 | 优先级符合用户期望 |
| isPartialView 标记 | 缓存原始内容 | 稍多内存 | Edit/Write 知道需要重新读取 |

**源码/测试证据：**
- 源码：`src/utils/attachments.ts:1665-2202`
- 关键状态：`toolUseContext.loadedNestedMemoryPaths`、`toolUseContext.readFileState`
- 测试：无独立测试

---

#### 模块 6：变更文件检测器

**真实入口签名与关键类型：**
```typescript
export async function getChangedFiles(
  toolUseContext: ToolUseContext
): Promise<Attachment[]>

// 关键状态
toolUseContext.readFileState: FileStateCache  // { path → { content, timestamp, offset?, limit?, isPartialView? } }
```

**输入输出：**
- **输入**：`readFileState` 中的文件路径列表
- **输出**：
  - `{ type: 'edited_text_file', filename, snippet }`（文本变更）
  - `{ type: 'edited_image_file', filename, content }`（图片变更）
  - `null`（未变更或出错）
- **变更检测**：mtime > readFileState 中的 timestamp

**附件与缓存状态：**
- **缓存失效**：仅 `isENOENT(error)` 时从 `readFileState` 删除文件
- **其他错误**：原子保存临时 ENOENT、权限波动 → 保留缓存
- **部分文件跳过**：`readFileState.limit` 存在 → 不检测变更（避免误导性 diff）

**解析/并行处理/注入/失效流程：**
```
1. getChangedFiles() 获取 readFileState 中所有路径
   ├─ cacheKeys(readFileState) → 空 → 返回 []
   └─ 否则，Promise.all(filePaths.map(async path => ...))

2. 每个路径并行处理
   ├─ normalizedPath = expandPath(path)
   ├─ isFileReadDenied() → 是 → 返回 null
   ├─ getFileModificationTimeAsync() → mtime
   ├─ mtime ≤ fileState.timestamp → 未变更 → 返回 null
   ├─ FileReadTool.validateInput() → 否 → 返回 null
   └─ FileReadTool.call() 重新读取

3. 文本文件处理
   ├─ result.data.type === 'text'
   ├─ getSnippetForTwoFileDiff(oldContent, newContent) → snippet
   ├─ snippet === ''（无实际变更）→ 返回 null
   └─ 返回 { type: 'edited_text_file', filename, snippet }

4. 图片文件处理
   ├─ result.data.type === 'image'
   ├─ readImageWithTokenBudget() 重新读取
   └─ 返回 { type: 'edited_image_file', filename, content }

5. 错误处理
   ├─ catch (error)
   ├─ isENOENT(error) → readFileState.delete(path) → 返回 null
   └─ 其他错误 → 返回 null（保留缓存）
```

**错误与隐私：**
- **仅 ENOENT 驱逐**：避免编辑器原子保存导致的频繁缓存失效
- **权限检查**：`isFileReadDenied()` 二次检查
- **事件**：无专门事件（通过 FileReadTool 内部事件）

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 仅 ENOENT 驱逐 vs 任何错误 | 仅 ENOENT | 罕见情况下可能 stale | 避免原子保存抖动 |
| mtime 检查 vs 哈希比较 | mtime | 时钟回绕可能漏检 | 性能好，无需读取文件 |
| 空 snippet 跳过 | 无变更不返回 | 需计算 diff | 避免噪音附件 |
| 部分文件不检测 | limit 存在跳过 | 部分变更不通知 | 避免误导性 diff |

**源码/测试证据：**
- 源码：`src/utils/attachments.ts:2072-2169`
- 关键函数：`isENOENT(error)`（来自 `src/utils/errors.ts`）
- 测试：无独立测试

---

#### 模块 7：MCP 资源引用处理器

**真实入口签名与关键类型：**
```typescript
function extractMcpResourceMentions(content: string): string[]

async function processMcpResourceAttachments(
  input: string,
  toolUseContext: ToolUseContext
): Promise<Attachment[]>

// Attachment 类型
| { type: 'mcp_resource'; server: string; uri: string; name: string; description?: string; content: ReadResourceResult }
```

**输入输出：**
- **输入**：用户输入字符串（格式 `@server:uri`）
- **输出**：`mcp_resource` 附件数组
- **提取正则**：`/(^|\s)@([^\s]+:[^\s]+)\b/g`

**附件与缓存状态：**
- **MCP 客户端**：`toolUseContext.options.mcpClients`
- **MCP 资源**：`toolUseContext.options.mcpResources`（用于获取 name/description）
- **无缓存**：每次都重新读取资源

**解析/并行处理/注入/失效流程：**
```
1. extractMcpResourceMentions(input)
   ├─ 匹配 @server:uri 格式
   ├─ 去重
   └─ 返回 mention 数组

2. processMcpResourceAttachments() 并行处理
   └─ Promise.all(mentions.map(async mention => ...))

3. 单个 mention 处理
   ├─ split(':') → serverName + uri
   ├─ 找 mcpClients.find(c => c.name === serverName)
   │  └─ 未找到或未连接 → 记录事件 → 返回 null
   ├─ 找 mcpResources[serverName]?.find(r => r.uri === uri)
   │  └─ 未找到 → 记录事件 → 返回 null
   ├─ client.client.readResource({ uri })
   │  └─ 出错 → 记录事件 → 返回 null
   └─ 返回 { type: 'mcp_resource', server, uri, name, description?, content }
```

**错误与隐私：**
- **错误隔离**：单个资源失败不影响其他
- **事件记录**：`tengu_at_mention_mcp_resource_success` / `tengu_at_mention_mcp_resource_error`
- **权限**：MCP 资源权限由 MCP 服务器管理

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 无缓存 vs 缓存 | 每次重新读取 | 可能重复读取 | 始终获取最新内容 |
| 先找资源信息再读取 | 两步 | 稍多 round-trip | 能提供 name/description |

**源码/测试证据：**
- 源码：`src/utils/attachments.ts:2800-2860` (extract)、`src/utils/attachments.ts:2004-2070` (process)
- 测试：无独立测试

---

#### 模块 8：技能附件发现与列表

**真实入口签名与关键类型：**
```typescript
// 技能列表
const sentSkillNames: Map<string, Set<string>>  // agentId → skill names
let suppressNext: boolean = false

export function resetSentSkillNames(): void
export function suppressNextSkillListing(): void
export function filterToBundledAndMcp(commands: Command[]): Command[]

async function getSkillListingAttachments(
  toolUseContext: ToolUseContext
): Promise<Attachment[]>

// 动态技能
async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext
): Promise<Attachment[]>

// 关键常量
const FILTERED_LISTING_MAX = 30

// Attachment 类型
| { type: 'dynamic_skill'; skillDir: string; skillNames: string[]; displayPath: string }
| { type: 'skill_listing'; content: string; skillCount: number; isInitial: boolean }
| { type: 'skill_discovery'; skills: Array<{ name, description, shortId? }>; signal: DiscoverySignal; source: 'native' | 'aki' | 'both' }
```

**输入输出：**
- **技能列表输入**：`getSkillToolCommands()` + `getMcpSkillCommands()`
- **技能列表输出**：`skill_listing` 附件（格式化到上下文窗口预算内）
- **动态技能输入**：`toolUseContext.dynamicSkillDirTriggers` Set
- **动态技能输出**：`dynamic_skill` 附件（skillDir + skillNames）

**附件与缓存状态：**
- **已发送技能**：`sentSkillNames` Map（key 为 agentId，空字符串为主线程）
- **抑制下次**：`suppressNext`（用于 --resume 时避免重复发送）
- **动态技能触发器**：`toolUseContext.dynamicSkillDirTriggers`（由文件操作写入）

**解析/并行处理/注入/失效流程：**
```
1. getSkillListingAttachments() 处理
   ├─ 检查是否有 SkillTool → 无 → 返回 []
   ├─ getSkillToolCommands(cwd) 获取本地技能
   ├─ getMcpSkillCommands() 获取 MCP 技能
   ├─ uniqBy 合并去重
   ├─ feature('EXPERIMENTAL_SKILL_SEARCH') → filterToBundledAndMcp()
   │  ├─ 仅保留 bundled + MCP
   │  └─ 超过 FILTERED_LISTING_MAX → 仅保留 bundled
   ├─ agentId 获取/创建 sentSkillNames Set
   ├─ suppressNext → 标记所有为已发送 → 返回 []
   ├─ 过滤已发送技能 → newSkills
   ├─ newSkills 为空 → 返回 []
   ├─ 标记 newSkills 为已发送
   ├─ formatCommandsWithinBudget(newSkills, contextWindowTokens) 格式化
   └─ 返回 { type: 'skill_listing', content, skillCount, isInitial }

2. getDynamicSkillAttachments() 处理
   ├─ dynamicSkillDirTriggers 为空 → 返回 []
   ├─ Promise.all(triggers.map(async skillDir => ...))
   │  ├─ readdir(skillDir) 获取目录项
   │  ├─ 过滤目录/符号链接
   │  ├─ Promise.all(candidates.map(async name => stat(skillDir/name/SKILL.md)))
   │  └─ 返回 { skillDir, skillNames: names that exist }
   ├─ 对每个结果，skillNames 非空 → 创建 dynamic_skill 附件
   ├─ dynamicSkillDirTriggers.clear()
   └─ 返回附件数组
```

**错误与隐私：**
- **动态技能目录错误**：读取目录失败 → 忽略该目录，返回空 skillNames
- **日志**：`logForDebugging()` 记录发送的技能数量
- **无隐私问题**：仅技能元数据（name/description），不包含内容

**设计取舍/备选：**
| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 按 agentId 隔离 sentSkillNames | Map key 为 agentId | 稍多状态 | 子代理获得自己的 turn-0 列表 |
| suppressNext 机制 | resume 时抑制 | 稍复杂 | 避免重复注入已在 transcript 中的列表 |
| 技能搜索时过滤列表 | bundled+MCP，超 30 仅 bundled | 某些技能不显示 | 避免截断，turn-0 无 gap |
| 动态技能触发器 | Set 收集 | 需协调写入时机 | 文件操作后自动发现新技能 |

**源码/测试证据：**
- 源码：`src/utils/attachments.ts:2611-2860`
- 关键常量：`src/utils/attachments.ts:2649` (FILTERED_LISTING_MAX)
- 测试：无独立测试

---

### 4.3 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|-----|-----------|---------|-------------|----------------|
| `attachments.ts` | `sentSkillNames`、`loadedNestedMemoryPaths`、`lastEmittedDate` | `getAttachments()`、`getAttachmentMessages()`、`startRelevantMemoryPrefetch()` | 实际文件读取、图片处理 | 调用各子模块函数 |
| `imagePaste.ts` | 无（纯函数） | `isImageFilePath()`、`asImageFilePath()`、`tryReadImageFromPath()`、`hasImageInClipboard()`、`getImageFromClipboard()` | 图片存储、验证 | 返回 `PastedContent` |
| `imageStore.ts` | `storedImagePaths`（Map）、`MAX_STORED_IMAGE_PATHS` | `storeImage()`、`storeImages()`、`getStoredImagePath()`、`clearStoredImagePaths()`、`cleanupOldImageCaches()` | 图片处理 | 存储和检索图片 |
| `imageValidation.ts` | 无（纯函数） | `validateImagesForAPI()`、`ImageSizeError` | 图片处理 | 验证 API 图片大小 |
| `pasteStore.ts` | 无（纯函数） | `hashPastedText()`、`storePastedText()`、`retrievePastedText()`、`cleanupOldPastes()` | 图片处理 | 持久化粘贴文本 |
| `config.ts`（PastedContent） | 无（类型定义） | 类型定义 | 运行时逻辑 | `PastedContent`、`HistoryEntry` 类型 |

### 4.2 模块与状态所有权

| 模块 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|------|-----------|---------|-------------|----------------|
| `attachments.ts` | `sentSkillNames`、`loadedNestedMemoryPaths`、`lastEmittedDate` | `getAttachments()`、`getAttachmentMessages()`、`startRelevantMemoryPrefetch()` | 实际文件读取、图片处理 | 调用各子模块函数 |
| `imagePaste.ts` | 无（纯函数） | `isImageFilePath()`、`asImageFilePath()`、`tryReadImageFromPath()`、`hasImageInClipboard()`、`getImageFromClipboard()` | 图片存储、验证 | 返回 `PastedContent` |
| `imageStore.ts` | `storedImagePaths`（Map）、`MAX_STORED_IMAGE_PATHS` | `storeImage()`、`storeImages()`、`getStoredImagePath()`、`clearStoredImagePaths()`、`cleanupOldImageCaches()` | 图片处理 | 存储和检索图片 |
| `imageValidation.ts` | 无（纯函数） | `validateImagesForAPI()`、`ImageSizeError` | 图片处理 | 验证 API 图片大小 |
| `pasteStore.ts` | 无（纯函数） | `hashPastedText()`、`storePastedText()`、`retrievePastedText()`、`cleanupOldPastes()` | 图片处理 | 持久化粘贴文本 |
| `config.ts`（PastedContent） | 无（类型定义） | 类型定义 | 运行时逻辑 | `PastedContent`、`HistoryEntry` 类型 |

### 4.3 主控制流

#### getAttachments 主流程

```
getAttachments(input, toolUseContext, ideSelection, queuedCommands, messages, querySource, options)
  ↓
快速禁用路径检查（CLAUDE_CODE_DISABLE_ATTACHMENTS 或 SIMPLE）
  ├─ 是 → 仅返回 queued_command 附件
  └─ 否 → 继续
  ↓
创建 AbortController（1 秒超时）
  ↓
步骤 1：处理用户输入附件（并行）
  ├─ maybe(at_mentioned_files): processAtMentionedFiles()
  ├─ maybe(mcp_resources): processMcpResourceAttachments()
  ├─ maybe(agent_mentions): processAgentMentions()
  └─ maybe(skill_discovery): skillSearchModules.prefetch.getTurnZeroSkillDiscovery()
  ↓
等待用户输入附件完成（用于 nested_memory 触发器）
  ↓
步骤 2：处理线程安全附件（并行）
  ├─ maybe(queued_commands)
  ├─ maybe(date_change)
  ├─ maybe(ultrathink_effort)
  ├─ maybe(deferred_tools_delta)
  ├─ maybe(agent_listing_delta)
  ├─ maybe(mcp_instructions_delta)
  ├─ maybe(companion_intro)
  ├─ maybe(changed_files)
  ├─ maybe(nested_memory)
  ├─ maybe(dynamic_skill)
  ├─ maybe(skill_listing)
  ├─ maybe(plan_mode)
  ├─ maybe(plan_mode_exit)
  ├─ maybe(auto_mode)
  ├─ maybe(auto_mode_exit)
  ├─ maybe(todo_reminder)
  ├─ maybe(teammate_mailbox)
  ├─ maybe(team_context)
  ├─ maybe(agent_pending_messages)
  ├─ maybe(critical_system_reminder)
  ├─ maybe(compaction_reminder)
  └─ maybe(context_efficiency)
  ↓
步骤 3：主线程专有附件（并行，if isMainThread）
  ├─ maybe(ide_selection)
  ├─ maybe(ide_opened_file)
  ├─ maybe(output_style)
  ├─ maybe(diagnostics)
  ├─ maybe(lsp_diagnostics)
  ├─ maybe(unified_tasks)
  ├─ maybe(async_hook_responses)
  ├─ maybe(token_usage)
  ├─ maybe(budget_usd)
  ├─ maybe(output_token_usage)
  └─ maybe(verify_plan_reminder)
  ↓
步骤 4：等待所有附件完成
  ↓
步骤 5：合并并过滤结果（移除 undefined/null）
  ↓
返回 Attachment[]
```

#### maybe() 包装器流程

```
maybe(label, fn)
  ↓
const startTime = Date.now()
  ↓
try {
  const result = await fn()
  const duration = Date.now() - startTime
  if (Math.random() < 0.05) {
    const attachmentSizeBytes = result.filter(a => a).reduce((total, a) => total + JSON.stringify(a).length, 0)
    logEvent('tengu_attachment_compute_duration', { label, duration_ms: duration, attachment_size_bytes, attachment_count: result.length })
  }
  return result
} catch (e) {
  const duration = Date.now() - startTime
  if (Math.random() < 0.05) {
    logEvent('tengu_attachment_compute_duration', { label, duration_ms: duration, error: true })
  }
  logError(e)
  logAntError(`Attachment error in ${label}`, e)
  return []  // 单个附件失败不阻止其他附件
}
```

#### 图片粘贴处理流程

```
用户粘贴图片
  ↓
检测剪贴板内容（hasImageInClipboard）
  ↓
读取剪贴板图片（getImageFromClipboard）
  ├─ macOS 原生路径（NSPasteboard）
  ├─ macOS AppleScript 回退
  ├─ Linux xclip/wl-paste
  └─ Windows PowerShell
  ↓
BMP 检测 → 转换为 PNG
  ↓
获取图片尺寸
  ↓
调整大小与下采样（maybeResizeAndDownsampleImageBuffer）
  ├─ 检查宽高限制（IMAGE_MAX_WIDTH/HEIGHT）
  ├─ 检查原始大小（IMAGE_TARGET_RAW_SIZE）
  └─ 必要时转换为 JPEG 压缩
  ↓
Base64 编码
  ↓
创建 PastedContent（分配 id）
  ↓
存储到 pasteStore（可选持久化）
  ↓
存储到 imageStore（会话级缓存）
  ↓
构建 ImageBlockParam
  ↓
附加到 queued_command 附件
```

#### @文件引用处理流程

```
processAtMentionedFiles(input, toolUseContext)
  ↓
extractAtMentionedFiles(input)
  ├─ 提取两种格式：@"path with spaces.txt" 和 @path.txt
  ├─ 支持行范围语法：@file.txt#L10-20
  └─ 去重
  ↓
for each file（并行）
  ↓
parseAtMentionedFileLines(mention)
  ↓
absoluteFilename = expandPath(filename)
  ↓
权限检查：isFileReadDenied(absoluteFilename)
  ├─ 是 → 返回 null
  └─ 否 → 继续
  ↓
stats = await stat(absoluteFilename)
  ├─ 是目录 → 读取目录列表（限制 MAX_DIR_ENTRIES）
  └─ 是文件 → generateFileAttachment()
  ↓
generateFileAttachment()
  ├─ 权限检查（再次）
  ├─ 大文件预检查（仅 at-mention 模式）
  ├─ PDF 引用检测（仅 at-mention 模式）
  ├─ 已读缓存检查（仅 at-mention 模式）
  ├─ 验证并读取文件（FileReadTool）
  └─ 出错时尝试截断版本
  ↓
返回 Attachment[]
```

#### 相关记忆预取流程

```
startRelevantMemoryPrefetch(messages, toolUseContext)
  ↓
检查 gate：isAutoMemoryEnabled()、tengu_moth_copse
  └─ 任一 false → 返回 undefined
  ↓
lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  └─ 无 → 返回 undefined
  ↓
input = getUserMessageText(lastUserMessage)
  └─ 单字提示 → 返回 undefined
  ↓
surfaced = collectSurfacedMemories(messages)
  └─ totalBytes >= MAX_SESSION_BYTES → 返回 undefined
  ↓
controller = createChildAbortController(toolUseContext.abortController)
  ↓
promise = getRelevantMemoryAttachments(...).catch(e => ...)
  ↓
handle = {
  promise,
  settledAt: null,
  consumedOnIteration: -1,
  [Symbol.dispose](): void
}
  ↓
promise.finally(() => { handle.settledAt = Date.now() })
  ↓
返回 handle
```

#### 嵌套记忆注入流程

```
getNestedMemoryAttachments(toolUseContext, triggerFilePath)
  ↓
权限检查：pathInAllowedWorkingPath(triggerFilePath)
  └─ 否 → 返回 []
  ↓
处理 Managed/User 条件规则
  ↓
处理 nested 目录（CWD → target）：CLAUDE.md + 无条件 + 条件规则
  ↓
处理 CWD 级目录（根 → CWD）：仅条件规则
  ↓
memoryFilesToAttachments(memoryFiles, toolUseContext, triggerFilePath)
  ├─ for each memoryFile
  │  ├─ 双重去重检查：loadedNestedMemoryPaths、readFileState
  │  ├─ 创建 nested_memory 附件
  │  ├─ 缓存原始内容（区别于注入的处理后内容）
  │  └─ 触发 InstructionsLoaded 钩子（审计/可观测）
  └─ 返回 Attachment[]
```

#### 团队邮箱附件流程

```
getTeammateMailboxAttachments(toolUseContext)
  ↓
检查：isAgentSwarmsEnabled()、USER_TYPE === 'ant'
  └─ 否 → 返回 []
  ↓
viewedTeammate = getViewedTeammateTask(appState)
  ↓
解析 agentName
  ↓
步骤 1：读取文件邮箱，过滤结构化协议消息
  ↓
步骤 2：读取 AppState.inbox（仅在主线程查看领导时）
  ↓
步骤 3：合并并去重（使用 from+timestamp+text 前缀作为 key）
  ↓
步骤 4：折叠每个代理的多个 idle 通知（仅保留最新）
  ↓
步骤 5：构建附件后再标记已读（防止消息丢失）
  ↓
步骤 6：仅标记非结构化邮箱消息为已读
  ↓
步骤 7：处理 shutdown_approval 消息（团队领导）
  ↓
步骤 8：标记 AppState.inbox 消息为已处理
  ↓
返回 Attachment[]
```

### 4.4 数据结构与持久化

**PastedContent 结构：**
```typescript
type PastedContent = {
  id: number;  // 序列数字 ID
  type: 'text' | 'image';
  content: string;
  mediaType?: string;  // 例如 'image/png', 'image/jpeg'
  filename?: string;  // 附件槽中图片的显示名称
  dimensions?: ImageDimensions;
  sourcePath?: string;  // 拖入终端的图片原始文件路径
};

interface HistoryEntry {
  display: string;
  pastedContents: Record<number, PastedContent>;
}
```

**持久化位置：**
- 粘贴文本：`~/.claude/paste-cache/<hash>.txt`（跨会话）
- 图片：`~/.claude/image-cache/<sessionId>/<imageId>.<ext>`（会话级，权限 0o600）
- 无其他持久化（状态都是会话级）

**关键常量：**
- `IMAGE_MAX_WIDTH`、`IMAGE_MAX_HEIGHT`：图片最大宽高
- `IMAGE_TARGET_RAW_SIZE`：图片目标原始大小
- `API_IMAGE_MAX_BASE64_SIZE`：API 限制的 base64 大小
- `MAX_DIR_ENTRIES`：目录列表最大条目
- `MAX_MEMORY_LINES = 200`：每个记忆最大行数
- `MAX_MEMORY_BYTES = 4096`：每个记忆 4KB 限制
- `RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES = 60 * 1024`：每会话最多 60KB 相关记忆
- `PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS`：计划模式提醒间隔
- `PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS`：完整提醒频率

### 4.5 跨子系统依赖

| 上游输入 | 下游副作用 | 相关 spec |
|---------|-----------|---------|
| 权限系统 | 文件路径权限检查 | permissions |
| 记忆系统 | 相关记忆、嵌套记忆 | memory |
| MCP 系统 | MCP 资源引用 | mcp |
| 插件系统 | 动态技能 | (plugin system) |
| git | gitignore 检查 | git |
| 文件系统 | 文件读取、目录列表 | (core) |
| LSP 系统 | LSP 诊断 | lsp |
| 团队系统 | 团队邮箱、团队上下文 | (team system) |

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---------|---------|-----------------|--------------|--------------|--------------|
| 单个附件类型失败 | `maybe()` 包装器 | 内部捕获，返回 [] | 否（下次重试） | 无 | 用户无感知，仅该附件缺失 |
| 全局超时（1 秒） | `AbortController.abort()` | 内部捕获，放弃剩余 | 否（下次重试） | 无 | 用户无感知，仅超时附件缺失 |
| 文件权限拒绝 | `isFileReadDenied()` | 内部跳过，返回 null | 否 | 无 | 该文件附件缺失 |
| PDF 太大 | `tryGetPDFReference()` 超过阈值 | 返回引用而非内联 | 否 | 无 | 用户看到 PDF 引用，模型可选择读取 |
| 图片太大超过 API 限制 | `validateImagesForAPI()` | 抛出 `ImageSizeError` | 否 | 无 | 调用方需处理错误 |
| 相关记忆预取被取消 | `AbortSignal.aborted` | 内部捕获，返回 [] | 否 | `Symbol.dispose()` 清理 | 用户无感知 |
| 嵌套记忆已加载 | `loadedNestedMemoryPaths.has()` | 内部跳过 | 否 | 无 | 无重复注入 |
| 文件已读且未修改 | `readFileState` 检查 | 返回 `AlreadyReadFileAttachment` | 否 | 无 | 避免重复读取相同内容 |
| 文件变更（非 ENOENT） | `getChangedFiles()` mtime 检查 | 返回 `EditedTextFileAttachment` 或 `EditedImageFileAttachment` | 否 | 无 | 用户看到变更部分 |
| 文件真删除（ENOENT） | `getChangedFiles()` `isENOENT(error)` | 从 `readFileState` 删除 | 否 | 删除缓存项 | 下次不再显示已删除文件 |

**工程取舍：**

| 取舍 | 当前选择 | 代价 | 收益 |
|-----|---------|-----|-----|
| 单个失败 vs 整体失败 | 单个失败不阻塞整体 | 部分上下文可能缺失 | 降级体验优于完全失败 |
| 1 秒全局超时 vs 无超时 | 1 秒全局超时 | 某些慢速附件可能偶尔缺失 | 避免阻塞用户交互 |
| 双重去重 vs 单一去重 | loadedNestedMemoryPaths + readFileState | 复杂度稍高 | 会话内一致性 + 跨回合去重 |
| 仅 ENOENT 驱逐 vs 任何错误驱逐 | 仅 ENOENT 驱逐 | 极少见情况下可能错过变更 | 避免原子保存瞬时错误导致频繁驱逐 |
| 异步预取 vs 同步检索 | 异步预取 | 复杂度增加，生命周期管理 | 利用模型推理空闲时间，零阻塞 |
| PDF 引用 vs 总是内联 | 超过阈值返回引用 | 大 PDF 需要显式读取 | 避免上下文窗口溢出 |
| 日期变更作为附件 vs 修改前缀 | 作为附件追加 | 前缀保留旧日期 | 避免破坏 prompt caching |
| 结构化消息不从邮箱标记已读 vs 全部标记 | 仅非结构化标记已读 | 需要协调两个系统 | 避免专用处理器看不到协议消息 |
| 图片大小双重检查 vs 单次检查 | resize + validation | 稍冗余 | 分层防御更可靠 |
| 计划提醒按用户轮次 vs 按消息总数 | 按用户轮次 | 需要过滤非用户消息 | 避免工具循环频繁触发提醒 |
| 图片权限 0o600 vs 默认权限 | 0o600 | 需要显式设置 | 防止敏感图片泄露 |

## 6. 现状验收标准

1. **给定** 一个慢速附件类型和一个快速附件类型，**当** `getAttachments()` 被调用且慢速附件超时（1 秒）时，**必须** 返回快速附件而跳过慢速附件，**不得** 抛出异常。
2. **给定** 一个附件类型失败，**当** 其他附件类型成功时，**必须** 返回成功的附件，**不得** 受失败附件影响。
3. **给定** 同一 CLAUDE.md 文件，**当** 在同一对话中多次注入时，**必须** 去重（仅第一次注入）。
4. **给定** 已读文件，**当** 文件未修改时，**必须** 返回 `AlreadyReadFileAttachment`；**当** 文件修改时，**必须** 返回变更差异。
5. **给定** 编辑器原子保存导致瞬时 ENOENT，**当** `getChangedFiles()` 检测到时，**不得** 从 `readFileState` 驱逐该文件。
6. **给定** 用户粘贴图片，**当** 图片超过尺寸限制时，**必须** 调整大小和下采样；**当** 仍超过 API 限制时，**必须** 抛出 `ImageSizeError`。
7. **给定** 日期变更，**当** `getDateChangeAttachments()` 被调用时，**必须** 作为附件追加，**不得** 修改 `messages[0]`（已缓存前缀）。
8. **给定** 团队邮箱中的结构化协议消息，**当** `getTeammateMailboxAttachments()` 处理时，**不得** 标记为已读（留给专用处理器）。
9. **给定** 用户输入 @file.txt#L10-20，**当** `extractAtMentionedFiles()` 处理时，**必须** 提取该文件并仅包含指定行范围。
10. **给定** PDF 文件，**当** 超过阈值时，**必须** 返回 `PDFReferenceAttachment` 而非内联内容。

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---------|---------|----------------|---------|
| 单个附件类型失败不阻塞整体 | `src/utils/attachments.ts: maybe() 函数` | 无专门测试 | 仅检查代码实现 |
| 1 秒全局超时限制 | `src/utils/attachments.ts: AbortController + setTimeout(1000)` | 无专门测试 | 仅检查代码实现 |
| 双重缓存去重（nested memory） | `src/utils/attachments.ts: memoryFilesToAttachments() 检查` | 无专门测试 | 仅检查代码实现 |
| 仅 ENOENT 从 readFileState 驱逐 | `src/utils/attachments.ts: getChangedFiles() 错误处理` | 无专门测试 | 仅检查代码实现 |
| 相关记忆异步预取 | `src/utils/attachments.ts: startRelevantMemoryPrefetch()、MemoryPrefetch 类型` | 无专门测试 | 仅检查代码实现 |
| PDF 引用而非内联大文件 | `src/utils/attachments.ts: tryGetPDFReference()、generateFileAttachment()` | 无专门测试 | 仅检查代码实现 |
| 日期变更作为附件而非修改前缀 | `src/utils/attachments.ts: getDateChangeAttachments()` | 无专门测试 | 仅检查代码实现 |
| 结构化协议消息不从邮箱标记已读 | `src/utils/attachments.ts: getTeammateMailboxAttachments() 过滤` | 无专门测试 | 仅检查代码实现 |
| 图片大小双重检查（resize + validation） | `src/utils/imageValidation.ts`、`src/utils/imagePaste.ts` | 无专门测试 | 仅检查代码实现 |
| 计划/自动模式提醒按用户轮次计数 | `src/utils/attachments.ts: getPlanModeAttachmentTurnCount()` | 无专门测试 | 仅检查代码实现 |
| 图片存储权限 0o600 | `src/utils/imageStore.ts` | 无专门测试 | 仅检查代码实现 |
| 图片路径包含 uid + 随机值 | `src/utils/imageStore.ts` | 无专门测试 | 仅检查代码实现 |
| 粘贴文本持久化（跨会话） | `src/utils/pasteStore.ts` | 无专门测试 | 仅检查代码实现 |

### 7.1 现有相关测试

虽然没有专门的 attachments 测试文件，但其他测试可能间接使用附件系统：

| 测试文件 | 可能相关的功能 | 说明 |
|---|---|---|
| 多个集成测试 | 可能使用 @文件引用、粘贴等功能 | 但这些测试不专门验证附件系统本身 |

### 7.2 未覆盖行为（基于代码阅读）

- 附件系统无专门独立测试文件
- 单个附件失败不阻塞整体的错误隔离测试缺失
- 1 秒全局超时的边界测试缺失
- 双重缓存去重的竞态条件测试缺失
- 相关记忆异步预取的并发测试缺失
- PDF 引用阈值的边界测试缺失
- 没有外部 live 验证测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/attachments.yaml)

| 分组 | 主拥有职责 | 相关测试或共享证据 | 不拥有的相邻文件 |
|-----|-----------|------------------|----------------|
| attachments-core | `getAttachments()`、`maybe()`、主流程协调 | 无 |  |
| attachments-image-paste | 图片粘贴、剪贴板读取、尺寸调整 | 无 |  |
| attachments-image-store | 图片存储、缓存清理、权限 0o600 | 无 |  |
| attachments-image-validation | 图片 API 边界验证 | 无 |  |
| attachments-paste-store | 粘贴文本持久化（跨会话） | 无 |  |
| attachments-file | `@文件引用`、`generateFileAttachment()`、PDF 引用 | 无 |  |
| attachments-memory | `nested_memory`、`relevant_memories`、预取 | 无 |  |
| attachments-skill | `dynamic_skill`、`skill_listing`、`skill_discovery` | 无 |  |
| attachments-plan-auto | `plan_mode`、`auto_mode` 提醒 | 无 |  |
| attachments-team | `teammate_mailbox`、`team_context` | 无 |  |
| attachments-mcp | `mcp_resource` | 无 |  |

**相关子系统：**
- permissions：文件路径权限检查
- memory：相关记忆、嵌套记忆
- lsp：LSP 诊断
- mcp：MCP 资源
- git：gitignore 检查
- team system：团队邮箱、团队上下文

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 附件系统无专门测试覆盖（第 7 节） | 添加核心路径单元测试：maybe() 错误隔离、超时、去重、图片处理、PDF 引用、日期变更 | 低（新增测试） | 测试覆盖主要场景 | M | 已证实 |
| P2 | 1 秒全局超时可能导致某些有用附件偶尔缺失 | 考虑分层超时：关键附件快速完成，非关键附件可后台续传并在下回合注入 | 中（需要管理状态跨回合） | 慢速附件不超时，在下回合成功注入 | M | 设计推断 |
| P1 | 相关记忆预取无可见性，用户不知道是否在运行 | 考虑添加遥测或调试日志，记录预取是否启动、是否完成、是否被消费 | 低（仅新增日志） | 预取行为可观测 | S | 已证实 |
| P2 | 失败事件可能有多个会话的重试延迟 | 添加失败事件文件过期机制：删除超过 N 天的失败事件文件 | 低（仅删除旧文件） | 旧文件被自动清理 | S | 设计推断 |
| P2 | 图片路径长度限制（Unix socket 路径限制 ~100 字节） | 考虑使用更短的路径或随机值长度 | 低（仅路径格式） | 路径不超过系统限制 | S | 设计推断 |
| P3 | 当前仅支持 Linux glibc 远程目标 | 考虑扩展到 musl libc（Alpine）或 BSD/macOS 远程目标 | 中（需要新增目标支持和测试） | 可以在 Alpine Linux 或 macOS 远程上运行 | L | 设计推断 |
| P3 | 单次 scp 传输大文件在弱网下可能慢或失败 | 考虑使用 rsync 或分块传输与校验 | 中（需要额外依赖或更复杂部署） | 大文件在弱网下可以可靠部署 | M | 设计推断 |
