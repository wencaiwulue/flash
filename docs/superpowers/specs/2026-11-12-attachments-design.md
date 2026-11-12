---
id: attachments
title: Attachments 附件、图片与上下文注入设计
date: 2026-11-12
status: draft
batch: 1
---

# Attachments 附件、图片与上下文注入设计

## 1. 概述

Attachments 系统是 Claude Code 中将各种非结构化上下文注入对话的核心机制。它负责处理用户输入中的 @文件引用、粘贴的图片、IDE 选中内容、目录列表、任务提醒、动态技能、相关记忆等各种形式的上下文信息，并将其转换为可被模型理解的消息附件。

### 1.1 设计目标

- **统一上下文注入**: 提供一致的接口处理各种类型的上下文信息
- **性能与并发性**: 使用异步预取和缓存机制确保响应速度
- **隐私与安全**: 严格遵守权限控制，防止敏感信息泄露
- **可扩展性**: 支持新附件类型的轻松添加
- **上下文窗口优化**: 智能截断和压缩以适应 token 限制

### 1.2 关键特性

- 30+ 种附件类型
- 异步预取机制
- 缓存失效检测
- 权限与隐私控制
- 图片自动调整大小与验证
- 内存文件层级注入
- 相关记忆智能检索

## 2. 附件类型系统

### 2.1 核心 Attachment 类型

```typescript
// src/utils/attachments.ts
export type Attachment =
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
  
  // 日期变化
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
  | { type: 'bagel_console'; errorCount: number; warningCount: number; sample: string }
```

### 2.2 文件相关附件类型

```typescript
export type FileAttachment = {
  type: 'file'
  filename: string
  content: FileReadToolOutput
  truncated?: boolean
  displayPath: string  // 相对于 CWD 的路径，用于稳定显示
}

export type CompactFileReferenceAttachment = {
  type: 'compact_file_reference'
  filename: string
  displayPath: string
}

export type PDFReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  displayPath: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  content: FileReadToolOutput
  truncated?: boolean
  displayPath: string
}
```

### 2.3 钩子与异步附件类型

```typescript
export type HookAttachment =
  | HookCancelledAttachment
  | { type: 'hook_blocking_error'; blockingError: HookBlockingError; hookName: string; toolUseID: string; hookEvent: HookEvent }
  | HookNonBlockingErrorAttachment
  | HookErrorDuringExecutionAttachment
  | HookSuccessAttachment
  | { type: 'hook_additional_context'; content: string[]; hookName: string; toolUseID: string; hookEvent: HookEvent }
  | HookSystemMessageAttachment
  | HookPermissionDecisionAttachment

export type AsyncHookResponseAttachment = {
  type: 'async_hook_response'
  processId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  response: SyncHookJSONOutput
  stdout: string
  stderr: string
  exitCode?: number
}
```

## 3. 图片粘贴与处理流程

### 3.1 PastedContent 数据结构

```typescript
// src/utils/config.ts
export type PastedContent = {
  id: number  // 序列数字 ID
  type: 'text' | 'image'
  content: string
  mediaType?: string  // 例如 'image/png', 'image/jpeg'
  filename?: string  // 附件槽中图片的显示名称
  dimensions?: ImageDimensions
  sourcePath?: string  // 拖入终端的图片原始文件路径
}

export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}
```

### 3.2 图片粘贴处理流程

```
用户粘贴图片
    ↓
检测剪贴板内容 (hasImageInClipboard)
    ↓
读取剪贴板图片 (getImageFromClipboard)
    ├─ macOS 原生路径 (NSPasteboard)
    ├─ macOS AppleScript 回退
    ├─ Linux xclip/wl-paste
    └─ Windows PowerShell
    ↓
BMP 检测 → 转换为 PNG
    ↓
获取图片尺寸
    ↓
调整大小与下采样 (maybeResizeAndDownsampleImageBuffer)
    ├─ 检查宽高限制 (IMAGE_MAX_WIDTH/HEIGHT)
    ├─ 检查原始大小 (IMAGE_TARGET_RAW_SIZE)
    └─ 必要时转换为 JPEG 压缩
    ↓
Base64 编码
    ↓
创建 PastedContent (分配 id)
    ↓
存储到 pasteStore (可选持久化)
    ↓
存储到 imageStore (会话级缓存)
    ↓
构建 ImageBlockParam
    ↓
附加到 queued_command 附件
```

### 3.3 图片验证与大小控制

```typescript
// src/utils/imageValidation.ts
export class ImageSizeError extends Error {
  constructor(
    oversizedImages: Array<{ index: number; size: number }>,
    maxSize: number
  )
}

export function validateImagesForAPI(messages: unknown[]): void {
  // 验证所有图片 base64 大小不超过 API_IMAGE_MAX_BASE64_SIZE
  // 抛出 ImageSizeError 包含所有超限图片的索引和大小
}
```

**关键常量** (src/constants/apiLimits.ts):
- `IMAGE_MAX_WIDTH`: 最大宽度
- `IMAGE_MAX_HEIGHT`: 最大高度
- `IMAGE_TARGET_RAW_SIZE`: 目标原始大小 (解码后)
- `API_IMAGE_MAX_BASE64_SIZE`: API 限制的 base64 大小

### 3.4 图片存储机制

```typescript
// src/utils/imageStore.ts
const IMAGE_STORE_DIR = 'image-cache'
const MAX_STORED_IMAGE_PATHS = 200

// 内存缓存 (会话级)
const storedImagePaths = new Map<number, string>()

// 磁盘存储结构
// ~/.claude/image-cache/{sessionId}/{imageId}.{ext}

export async function storeImage(content: PastedContent): Promise<string | null>
export async function storeImages(pastedContents: Record<number, PastedContent>): Promise<Map<number, string>>
export function getStoredImagePath(imageId: number): string | null
export function clearStoredImagePaths(): void
export async function cleanupOldImageCaches(): Promise<void>
```

### 3.5 文本粘贴处理

```typescript
// src/utils/pasteStore.ts
const PASTE_STORE_DIR = 'paste-cache'

// 持久化存储 (跨会话)
export function hashPastedText(content: string): string
export async function storePastedText(hash: string, content: string): Promise<void>
export async function retrievePastedText(hash: string): Promise<string | null>
export async function cleanupOldPastes(cutoffDate: Date): Promise<void>

// 磁盘存储结构
// ~/.claude/paste-cache/{hash}.txt
```

### 3.6 图片路径提取与验证

```typescript
// src/utils/imagePaste.ts
export function isImageFilePath(text: string): boolean
export function asImageFilePath(text: string): string | null
export async function tryReadImageFromPath(text: string): Promise<(ImageWithDimensions & { path: string }) | null>
```

支持的图片格式:
- PNG
- JPEG/JPG
- GIF
- WebP
- BMP (自动转换为 PNG)

## 4. 附件处理核心流程

### 4.1 getAttachments 主入口

```typescript
// src/utils/attachments.ts
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]> {
  // 快速禁用路径
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS) ||
      isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return getQueuedCommandAttachments(queuedCommands)
  }

  // 创建超时控制器 (1秒)
  const abortController = createAbortController()
  const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController)
  const context = { ...toolUseContext, abortController }

  // 步骤 1: 处理用户输入附件 (@文件等)
  const userInputAttachments = input ? [
    maybe('at_mentioned_files', () => processAtMentionedFiles(input, context)),
    maybe('mcp_resources', () => processMcpResourceAttachments(input, context)),
    maybe('agent_mentions', () => Promise.resolve(processAgentMentions(input, toolUseContext.options.agentDefinitions.activeAgents))),
    ...(feature('EXPERIMENTAL_SKILL_SEARCH') && skillSearchModules && !options?.skipSkillDiscovery ? [
      maybe('skill_discovery', () => skillSearchModules.prefetch.getTurnZeroSkillDiscovery(input, messages ?? [], context)),
    ] : []),
  ] : []

  // 等待用户输入附件完成 (用于 nested_memory 触发器)
  const userAttachmentResults = await Promise.all(userInputAttachments)

  // 步骤 2: 处理线程安全附件 (并行执行)
  const allThreadAttachments = [
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands)),
    maybe('date_change', () => Promise.resolve(getDateChangeAttachments(messages))),
    maybe('ultrathink_effort', () => Promise.resolve(getUltrathinkEffortAttachment(input))),
    maybe('deferred_tools_delta', () => Promise.resolve(getDeferredToolsDeltaAttachment(...))),
    maybe('agent_listing_delta', () => Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages))),
    maybe('mcp_instructions_delta', () => Promise.resolve(getMcpInstructionsDeltaAttachment(...))),
    ...(feature('BUDDY') ? [maybe('companion_intro', () => Promise.resolve(getCompanionIntroAttachment(messages)))] : []),
    maybe('changed_files', () => getChangedFiles(context)),
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    ...(feature('TRANSCRIPT_CLASSIFIER') ? [
      maybe('auto_mode', () => getAutoModeAttachments(messages, toolUseContext)),
      maybe('auto_mode_exit', () => getAutoModeExitAttachment(toolUseContext)),
    ] : []),
    maybe('todo_reminders', () => isTodoV2Enabled() ? getTaskReminderAttachments(messages, toolUseContext) : getTodoReminderAttachments(messages, toolUseContext)),
    ...(isAgentSwarmsEnabled() ? [
      ...(querySource === 'session_memory' ? [] : [maybe('teammate_mailbox', async () => getTeammateMailboxAttachments(toolUseContext))]),
      maybe('team_context', async () => getTeamContextAttachment(messages ?? [])),
    ] : []),
    maybe('agent_pending_messages', async () => getAgentPendingMessageAttachments(toolUseContext)),
    maybe('critical_system_reminder', () => Promise.resolve(getCriticalSystemReminderAttachment(toolUseContext))),
    ...(feature('COMPACTION_REMINDERS') ? [maybe('compaction_reminder', () => Promise.resolve(getCompactionReminderAttachment(messages ?? [], toolUseContext.options.mainLoopModel)))] : []),
    ...(feature('HISTORY_SNIP') ? [maybe('context_efficiency', () => Promise.resolve(getContextEfficiencyAttachment(messages ?? [])))] : []),
  ]

  // 步骤 3: 主线程专有附件 (并行执行)
  const mainThreadAttachments = isMainThread ? [
    maybe('ide_selection', async () => getSelectedLinesFromIDE(ideSelection, toolUseContext)),
    maybe('ide_opened_file', async () => getOpenedFileFromIDE(ideSelection, toolUseContext)),
    maybe('output_style', async () => Promise.resolve(getOutputStyleAttachment())),
    maybe('diagnostics', async () => getDiagnosticAttachments(toolUseContext)),
    maybe('lsp_diagnostics', async () => getLSPDiagnosticAttachments(toolUseContext)),
    maybe('unified_tasks', async () => getUnifiedTaskAttachments(toolUseContext)),
    maybe('async_hook_responses', async () => getAsyncHookResponseAttachments()),
    maybe('token_usage', async () => Promise.resolve(getTokenUsageAttachment(messages ?? [], toolUseContext.options.mainLoopModel))),
    maybe('budget_usd', async () => Promise.resolve(getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd))),
    maybe('output_token_usage', async () => Promise.resolve(getOutputTokenUsageAttachment())),
    maybe('verify_plan_reminder', async () => getVerifyPlanReminderAttachment(messages, toolUseContext)),
  ] : []

  // 步骤 4: 并行处理所有附件
  const [threadAttachmentResults, mainThreadAttachmentResults] = await Promise.all([
    Promise.all(allThreadAttachments),
    Promise.all(mainThreadAttachments),
  ])

  clearTimeout(timeoutId)

  // 步骤 5: 合并并过滤结果 (移除 undefined/null)
  return [
    ...userAttachmentResults.flat(),
    ...threadAttachmentResults.flat(),
    ...mainThreadAttachmentResults.flat(),
  ].filter((a): a is Attachment => a !== undefined && a !== null)
}
```

### 4.2 maybe 包装器与错误处理

```typescript
async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  const startTime = Date.now()
  try {
    const result = await f()
    const duration = Date.now() - startTime
    // 仅记录 5% 的事件以减少音量
    if (Math.random() < 0.05) {
      const attachmentSizeBytes = result
        .filter(a => a !== undefined && a !== null)
        .reduce((total, attachment) => total + jsonStringify(attachment).length, 0)
      logEvent('tengu_attachment_compute_duration', {
        label, duration_ms: duration, attachment_size_bytes: attachmentSizeBytes, attachment_count: result.length,
      })
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
}
```

**关键设计**:
- 每个附件类型独立错误隔离
- 1秒全局超时 (abortController)
- 采样遥测 (5%)
- 失败返回空数组而非抛错

### 4.3 附件消息生成

```typescript
export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  const attachments = await getAttachments(...)
  if (attachments.length === 0) return
  logEvent('tengu_attachments', { attachment_types: attachments.map(_ => _.type) })
  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

export function createAttachmentMessage(attachment: Attachment): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
```

## 5. @文件引用处理

### 5.1 提取与解析

```typescript
export function extractAtMentionedFiles(content: string): string[] {
  // 提取两种格式:
  // 1. 引号包裹: @"path with spaces.txt"
  // 2. 常规: @path.txt
  // 支持行范围语法: @file.txt#L10-20
  // 去重
}

export function parseAtMentionedFileLines(mention: string): {
  filename: string
  lineStart?: number
  lineEnd?: number
} {
  // 解析: file.txt#L10-20 → { filename: 'file.txt', lineStart: 10, lineEnd: 20 }
  // 或者: file.txt#L10 → { filename: 'file.txt', lineStart: 10, lineEnd: 10 }
  // 或者: file.txt#heading → { filename: 'file.txt' } (忽略非行范围)
}

async function processAtMentionedFiles(input: string, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input)
  if (files.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    files.map(async file => {
      try {
        const { filename, lineStart, lineEnd } = parseAtMentionedFileLines(file)
        const absoluteFilename = expandPath(filename)

        // 权限检查
        if (isFileReadDenied(absoluteFilename, appState.toolPermissionContext)) {
          return null
        }

        // 目录处理
        const stats = await stat(absoluteFilename)
        if (stats.isDirectory()) {
          const entries = await readdir(absoluteFilename, { withFileTypes: true })
          // 限制最大目录条目数 (MAX_DIR_ENTRIES)
          return { type: 'directory', path: absoluteFilename, content: names.join('\n'), displayPath: relative(getCwd(), absoluteFilename) }
        }

        // 文件处理
        return await generateFileAttachment(
          absoluteFilename, toolUseContext,
          'tengu_at_mention_extracting_filename_success',
          'tengu_at_mention_extracting_filename_error',
          'at-mention',
          { offset: lineStart, limit: lineEnd && lineStart ? lineEnd - lineStart + 1 : undefined },
        )
      } catch {
        logEvent('tengu_at_mention_extracting_filename_error', {})
      }
    }),
  )
  return results.filter(Boolean) as Attachment[]
}
```

### 5.2 generateFileAttachment 核心逻辑

```typescript
export async function generateFileAttachment(
  filename: string,
  toolUseContext: ToolUseContext,
  successEventName: string,
  errorEventName: string,
  mode: 'compact' | 'at-mention',
  options?: { offset?: number; limit?: number },
): Promise<FileAttachment | CompactFileReferenceAttachment | PDFReferenceAttachment | AlreadyReadFileAttachment | null> {
  const appState = toolUseContext.getAppState()

  // 步骤 1: 权限检查
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null
  }

  // 步骤 2: 大文件预检查 (仅 at-mention 模式)
  if (mode === 'at-mention' && !isFileWithinReadSizeLimit(filename, getDefaultFileReadingLimits().maxSizeBytes)) {
    const ext = parse(filename).ext.toLowerCase()
    if (!isPDFExtension(ext)) {
      return null  // 大的非 PDF 文件直接跳过
    }
  }

  // 步骤 3: PDF 引用检测 (仅 at-mention 模式)
  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename)
    if (pdfRef) return pdfRef
  }

  // 步骤 4: 已读缓存检查 (仅 at-mention 模式)
  const existingFileState = toolUseContext.readFileState.get(filename)
  if (existingFileState && mode === 'at-mention') {
    const mtimeMs = await getFileModificationTimeAsync(filename)
    // 检查时间戳一致性 (FileReadTool 存储 Date.now(), Edit/Write 存储 mtimeMs)
    if (existingFileState.timestamp <= mtimeMs && mtimeMs === existingFileState.timestamp) {
      // 文件未修改，返回已读附件
      return { type: 'already_read_file', filename, content: { ... }, displayPath: relative(getCwd(), filename) }
    }
  }

  // 步骤 5: 验证并读取文件
  const fileInput = { file_path: filename, offset, limit }
  const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
  if (!isValid.result) return null

  try {
    const result = await FileReadTool.call(fileInput, toolUseContext)
    logEvent(successEventName, {})
    return { type: 'file', filename, content: result.data, displayPath: relative(getCwd(), filename) }
  } catch (error) {
    // MaxFileReadTokenExceededError 或 FileTooLargeError: 尝试读取截断版本
    if (error instanceof MaxFileReadTokenExceededError || error instanceof FileTooLargeError) {
      return await readTruncatedFile()  // compact 模式返回引用，at-mention 模式返回截断版本
    }
    throw error
  }
}
```

### 5.3 PDF 引用处理

```typescript
export async function tryGetPDFReference(filename: string): Promise<PDFReferenceAttachment | null> {
  const ext = parse(filename).ext.toLowerCase()
  if (!isPDFExtension(ext)) return null

  try {
    const [stats, pageCount] = await Promise.all([
      getFsImplementation().stat(filename),
      getPDFPageCount(filename),
    ])
    const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))  // 无 pageCount 时按大小估算 (~100KB/页)

    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      return {
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath: relative(getCwd(), filename),
      }
    }
  } catch {
    // 失败回退到正常读取
  }
  return null
}
```

## 6. 相关记忆预取与检索

### 6.1 预取架构

```typescript
// src/utils/attachments.ts
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null  // Promise 完成时间
  consumedOnIteration: number  // 在第几次迭代被消费
  [Symbol.dispose](): void  // 自动清理
}

export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (!isAutoMemoryEnabled() || !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)) {
    return undefined
  }

  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) return undefined

  const input = getUserMessageText(lastUserMessage)
  if (!input || !/\s/.test(input.trim())) return undefined  // 单字提示不足

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) return undefined

  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(...).catch(e => {
    if (!isAbortError(e)) logError(e)
    return []
  })

  const handle: MemoryPrefetch = {
    promise, settledAt: null, consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
      logEvent('tengu_memdir_prefetch_collected', { ... })
    },
  }
  void promise.finally(() => { handle.settledAt = Date.now() })
  return handle
}
```

**设计决策**: 预取与主模型执行并发进行，在工具调用期间完成，零阻塞。

### 6.2 收集已呈现记忆

```typescript
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}
```

### 6.3 读取记忆用于呈现

```typescript
const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 4096  // 每个记忆 4KB 限制

export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<Array<{ path: string; content: string; mtimeMs: number; header: string; limit?: number }>> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath, 0, MAX_MEMORY_LINES, MAX_MEMORY_BYTES, signal,
          { truncateOnByteLimit: true },
        )
        const truncated = result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes
        const content = truncated
          ? result.content + `\n\n> This memory file was truncated... Use FileReadTool to view complete.`
          : result.content
        return {
          path: filePath, content, mtimeMs,
          header: memoryHeader(filePath, mtimeMs),
          limit: truncated ? result.lineCount : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter(r => r !== null)
}
```

### 6.4 重复过滤

```typescript
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(m => !readFileState.has(m.path))
      for (const m of filtered) {
        readFileState.set(m.path, { content: m.content, timestamp: m.mtimeMs, offset: undefined, limit: m.limit })
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}
```

### 6.5 配置常量

```typescript
export const RELEVANT_MEMORIES_CONFIG = {
  MAX_SESSION_BYTES: 60 * 1024,  // 每会话最多 60KB 相关记忆
} as const
```

## 7. 嵌套内存与 CLAUDE.md 层级注入

### 7.1 目录处理顺序

```typescript
export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  // nestedDirs: 从 originalCwd 到 targetPath 之间的目录 (CWD → target)
  // cwdLevelDirs: 从根到 originalCwd 的目录 (根 → CWD)
  // 两者都从父到子排序
}
```

**处理顺序**:
1. **Managed/User 条件规则** (匹配 targetPath)
2. **Nested 目录** (CWD → target): CLAUDE.md + 无条件 + 条件规则
3. **CWD 级目录** (根 → CWD): 仅条件规则

### 7.2 内存文件转附件

```typescript
function memoryFilesToAttachments(
  memoryFiles: MemoryFileInfo[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()

  for (const memoryFile of memoryFiles) {
    // 双重去重: loadedNestedMemoryPaths (不驱逐) + readFileState (LRU)
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) continue
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path),
      })
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)

      // 缓存原始内容 (区别于注入的处理后内容)
      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })

      // 触发 InstructionsLoaded 钩子 (审计/可观测)
      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs ? 'path_glob_match' : memoryFile.parent ? 'include' : 'nested_traversal'
        void executeInstructionsLoadedHook(memoryFile.path, memoryFile.type, loadReason, {
          globs: memoryFile.globs, triggerFilePath, parentFilePath: memoryFile.parent,
        })
      }
    }
  }

  return attachments
}
```

### 7.3 获取嵌套内存附件

```typescript
async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  // 步骤 1: 路径权限检查
  if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
    return []
  }

  // 步骤 2: 处理 Managed/User 条件规则
  const managedUserRules = await getManagedAndUserConditionalRules(filePath, processedPaths)
  attachments.push(...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath))

  // 步骤 3: 处理 nested 目录 (CWD → target)
  for (const dir of nestedDirs) {
    const memoryFiles = (await getMemoryFilesForNestedDirectory(dir, filePath, processedPaths))
      .filter(f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'))
    attachments.push(...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath))
  }

  // 步骤 4: 处理 CWD 级目录 (根 → CWD，仅条件规则)
  for (const dir of cwdLevelDirs) {
    const conditionalRules = (await getConditionalRulesForCwdLevelDirectory(dir, filePath, processedPaths))
      .filter(f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'))
    attachments.push(...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath))
  }
}
```

## 8. 变更文件检测与差异附件

### 8.1 getChangedFiles 逻辑

```typescript
export async function getChangedFiles(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const filePaths = cacheKeys(toolUseContext.readFileState)
  if (filePaths.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    filePaths.map(async filePath => {
      const fileState = toolUseContext.readFileState.get(filePath)
      if (!fileState) return null

      const normalizedPath = expandPath(filePath)
      if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) return null

      try {
        const mtimeMs = await getFileModificationTimeAsync(normalizedPath)
        if (mtimeMs <= fileState.timestamp) return null  // 未修改

        const fileInput = { file_path: normalizedPath, ...fileState.offset !== undefined && { offset: fileState.offset }, ...fileState.limit !== undefined && { limit: fileState.limit } }
        const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
        if (!isValid.result) return null

        const result = await FileReadTool.call(fileInput, toolUseContext)
        if (result.data.type === 'text') {
          // 文本文件: 计算差异片段
          const snippet = getSnippetForTwoFileDiff(fileState.content, result.data.file.content)
          if (snippet === '') return null  // 内容未变 (仅 mtime 变)
          return { type: 'edited_text_file', filename: normalizedPath, snippet }
        } else {
          // 图片/非文本文件: 重新读取并压缩
          try {
            const data = await readImageWithTokenBudget(normalizedPath)
            return { type: 'edited_image_file', filename: normalizedPath, content: data }
          } catch (compressionError) {
            logError(compressionError)
            logEvent('tengu_watched_file_compression_failed', { file: normalizedPath })
            return null
          }
        }
      } catch (error) {
        // 仅在 ENOENT 时驱逐 (文件真的被删除)
        // 瞬时错误 (原子保存竞争、权限波动) 不驱逐
        if (isENOENT(error)) {
          toolUseContext.readFileState.delete(filePath)
        }
        return null
      }
    }),
  )
  return results.filter(result => result != null) as Attachment[]
}
```

**关键设计**: 仅 ENOENT 驱逐，其他错误保留缓存以应对编辑器原子保存竞争。

## 9. MCP 资源引用

### 9.1 提取与处理

```typescript
export function extractMcpResourceMentions(content: string): string[] {
  // 提取格式: @server:resource/path
}

async function processMcpResourceAttachments(input: string, toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const resourceMentions = extractMcpResourceMentions(input)
  if (resourceMentions.length === 0) return []

  const mcpClients = toolUseContext.options.mcpClients || []
  const results = await Promise.all(
    resourceMentions.map(async mention => {
      const [serverName, ...uriParts] = mention.split(':')
      const uri = uriParts.join(':')  // URI 可能包含冒号

      const client = mcpClients.find(c => c.name === serverName)
      if (!client || client.type !== 'connected') return null

      const serverResources = toolUseContext.options.mcpResources?.[serverName] || []
      const resourceInfo = serverResources.find(r => r.uri === uri)
      if (!resourceInfo) return null

      try {
        const result = await client.client.readResource({ uri })
        return {
          type: 'mcp_resource',
          server: serverName, uri,
          name: resourceInfo.name || uri,
          description: resourceInfo.description,
          content: result,
        }
      } catch {
        logEvent('tengu_at_mention_mcp_resource_error', {})
        return null
      }
    }),
  )
  return results.filter(Boolean) as Attachment[]
}
```

## 10. 技能列表与动态技能

### 10.1 技能列表附件

```typescript
const sentSkillNames = new Map<string, Set<string>>()  // key: agentId

async function getSkillListingAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') return []

  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))) return []

  const cwd = getProjectRoot()
  const localCommands = await getSkillToolCommands(cwd)
  const mcpSkills = getMcpSkillCommands(toolUseContext.getAppState().mcp.commands)
  let allCommands = mcpSkills.length > 0 ? uniqBy([...localCommands, ...mcpSkills], 'name') : localCommands

  // 技能搜索启用时: 仅保留 bundled + MCP 以解决初始间隙
  if (feature('EXPERIMENTAL_SKILL_SEARCH') && skillSearchModules?.featureCheck.isSkillSearchEnabled()) {
    allCommands = filterToBundledAndMcp(allCommands)
  }

  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) { sent = new Set(); sentSkillNames.set(agentKey, sent) }

  // 恢复路径: 标记现有技能以避免重复发送
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) sent.add(cmd.name)
    return []
  }

  const newSkills = allCommands.filter(cmd => !sent.has(cmd.name))
  if (newSkills.length === 0) return []

  const isInitial = sent.size === 0
  for (const cmd of newSkills) sent.add(cmd.name)

  const contextWindowTokens = getContextWindowForModel(toolUseContext.options.mainLoopModel, getSdkBetas())
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens)

  return [{ type: 'skill_listing', content, skillCount: newSkills.length, isInitial }]
}
```

### 10.2 动态技能附件

```typescript
async function getDynamicSkillAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  if (toolUseContext.dynamicSkillDirTriggers && toolUseContext.dynamicSkillDirTriggers.size > 0) {
    // 并行: 读取所有技能目录
    const perDirResults = await Promise.all(
      Array.from(toolUseContext.dynamicSkillDirTriggers).map(async skillDir => {
        try {
          const entries = await readdir(skillDir, { withFileTypes: true })
          const candidates = entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name)
          // 并行: 检查所有候选技能目录
          const checked = await Promise.all(
            candidates.map(async name => {
              try {
                await stat(resolve(skillDir, name, 'SKILL.md'))
                return name
              } catch {
                return null
              }
            }),
          )
          return { skillDir, skillNames: checked.filter((n): n is string => n !== null) }
        } catch {
          return { skillDir, skillNames: [] }
        }
      }),
    )

    for (const { skillDir, skillNames } of perDirResults) {
      if (skillNames.length > 0) {
        attachments.push({
          type: 'dynamic_skill',
          skillDir, skillNames,
          displayPath: relative(getCwd(), skillDir),
        })
      }
    }

    toolUseContext.dynamicSkillDirTriggers.clear()
  }

  return attachments
}
```

## 11. 计划模式与自动模式附件

### 11.1 Plan Mode 附件

```typescript
const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

async function getPlanModeAttachments(...): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode !== 'plan') return []

  // 检查是否需要附加 (基于轮次计数，首回合总是附加)
  if (messages && messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } = getPlanModeAttachmentTurnCount(messages)
    if (foundPlanModeAttachment && turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS) {
      return []
    }
  }

  const attachments: Attachment[] = []

  // 检查重新进入
  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({ type: 'plan_mode_reentry', planFilePath })
    setHasExitedPlanMode(false)
  }

  // 决定完整/稀疏提醒
  const attachmentCount = countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount % PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1 ? 'full' : 'sparse'

  attachments.push({ type: 'plan_mode', reminderType, isSubAgent: !!toolUseContext.agentId, planFilePath, planExists: existingPlan !== null })
  return attachments
}

function getPlanModeAttachmentTurnCount(messages: Message[]): { turnCount: number; foundPlanModeAttachment: boolean } {
  let turnsSinceLastAttachment = 0
  let foundPlanModeAttachment = false
  // 反向遍历，仅计算用户轮次 (非 meta、非 tool result)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'user' && !message.isMeta && !hasToolResultContent(message.message.content)) {
      turnsSinceLastAttachment++
    } else if (message?.type === 'attachment' && (message.attachment.type === 'plan_mode' || message.attachment.type === 'plan_mode_reentry')) {
      foundPlanModeAttachment = true
      break
    }
  }
  return { turnCount: turnsSinceLastAttachment, foundPlanModeAttachment }
}
```

### 11.2 计划模式退出附件

```typescript
async function getPlanModeExitAttachment(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!needsPlanModeExitAttachment()) return []

  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode === 'plan') {
    setNeedsPlanModeExitAttachment(false)
    return []
  }

  setNeedsPlanModeExitAttachment(false)
  return [{ type: 'plan_mode_exit', planFilePath, planExists: existingPlan !== null }]
}
```

## 12. 团队邮箱与代理群附件

### 12.1 Teammate Mailbox 附件

```typescript
async function getTeammateMailboxAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!isAgentSwarmsEnabled()) return []
  if (process.env.USER_TYPE !== 'ant') return []

  const appState = toolUseContext.getAppState()
  const viewedTeammate = getViewedTeammateTask(appState)

  // 根据查看目标解析 agentName
  let agentName = viewedTeammate?.identity.agentName ?? envAgentName
  if (!agentName && teamLeadStatus && appState.teamContext) {
    // 团队领导: 使用领导名称
  }

  // 步骤 1: 读取文件邮箱 (过滤结构化协议消息)
  const allUnreadMessages = await readUnreadMessages(agentName, teamName)
  const unreadMessages = allUnreadMessages.filter(m => !isStructuredProtocolMessage(m.text))

  // 步骤 2: 读取 AppState.inbox (仅在主线程查看领导时)
  const pendingInboxMessages = viewedTeammate || isInProcessTeammate()
    ? []
    : appState.inbox.messages.filter(m => m.status === 'pending')

  // 步骤 3: 合并并去重 (使用 from+timestamp+text 前缀作为 key)
  const seen = new Set<string>()
  let allMessages: Array<{ from: string; text: string; timestamp: string; color?: string; summary?: string }> = []
  for (const m of [...unreadMessages, ...pendingInboxMessages]) {
    const key = `${m.from}|${m.timestamp}|${m.text.slice(0, 100)}`
    if (!seen.has(key)) { seen.add(key); allMessages.push(m) }
  }

  // 步骤 4: 折叠每个代理的多个 idle 通知 (仅保留最新)
  const idleAgentByIndex = new Map<number, string>()
  const latestIdleByAgent = new Map<string, number>()
  for (let i = 0; i < allMessages.length; i++) {
    const idle = isIdleNotification(allMessages[i].text)
    if (idle) { idleAgentByIndex.set(i, idle.from); latestIdleByAgent.set(idle.from, i) }
  }
  if (idleAgentByIndex.size > latestIdleByAgent.size) {
    allMessages = allMessages.filter((_m, i) => {
      const agent = idleAgentByIndex.get(i)
      if (agent === undefined) return true
      return latestIdleByAgent.get(agent) === i
    })
  }

  // 步骤 5: 构建附件后再标记已读 (防止消息丢失)
  const attachment: Attachment[] = [{ type: 'teammate_mailbox', messages: allMessages }]

  // 步骤 6: 仅标记非结构化邮箱消息为已读
  if (unreadMessages.length > 0) {
    await markMessagesAsReadByPredicate(agentName, m => !isStructuredProtocolMessage(m.text), teamName)
  }

  // 步骤 7: 处理 shutdown_approved 消息 (团队领导)
  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        // 从团队文件移除队友、取消任务分配、更新 AppState
      }
    }
  }

  // 步骤 8: 标记 AppState.inbox 消息为已处理
  if (pendingInboxMessages.length > 0) {
    const pendingIds = new Set(pendingInboxMessages.map(m => m.id))
    toolUseContext.setAppState(prev => ({
      ...prev, inbox: { messages: prev.inbox.messages.map(m => pendingIds.has(m.id) ? { ...m, status: 'processed' as const } : m) },
    }))
  }

  return attachment
}
```

### 12.2 Team Context 附件

```typescript
function getTeamContextAttachment(messages: Message[]): Attachment[] {
  // 仅在首回合注入 (无 assistant 消息时)
  const hasAssistantMessage = messages.some(m => m.type === 'assistant')
  if (hasAssistantMessage) return []

  return [{ type: 'team_context', agentId, agentName, teamName, teamConfigPath, taskListPath }]
}
```

## 13. 日期变更检测

```typescript
export function getDateChangeAttachments(messages: Message[] | undefined): Attachment[] {
  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()

  if (lastDate === null) {
    setLastEmittedDate(currentDate)
    return []
  }

  if (currentDate === lastDate) return []

  setLastEmittedDate(currentDate)

  // Assistant 模式: 刷入昨日会话记录 (供 /dream 技能使用)
  if (feature('KAIROS')) {
    if (getKairosActive() && messages !== undefined) {
      sessionTranscriptModule?.flushOnDateChange(messages, currentDate)
    }
  }

  return [{ type: 'date_change', newDate: currentDate }]
}
```

**关键设计**: 作为附件追加而非修改已缓存前缀，避免破坏 prompt caching。

## 14. 钩子与异步响应附件

### 14.1 异步钩子响应

```typescript
async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const responses = await checkForAsyncHookResponses()
  if (responses.length === 0) return []

  const attachments = responses.map(({ processId, response, hookName, hookEvent, toolName, pluginId, stdout, stderr, exitCode }) => ({
    type: 'async_hook_response', processId, hookName, hookEvent, toolName, response, stdout, stderr, exitCode,
  }))

  // 移除已发送的钩子
  if (responses.length > 0) {
    const processIds = responses.map(r => r.processId)
    removeDeliveredAsyncHooks(processIds)
  }

  return attachments
}
```

### 14.2 LSP 诊断附件

```typescript
async function getLSPDiagnosticAttachments(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  if (!toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))) return []

  try {
    const diagnosticSets = checkForLSPDiagnostics()
    if (diagnosticSets.length === 0) return []

    const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({ type: 'diagnostics', files, isNew: true }))

    // 清除已发送的诊断
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics()
    }

    return attachments
  } catch (error) {
    logError(new Error(`Failed to get LSP diagnostic attachments: ${toError(error).message}`))
    return []
  }
}
```

## 15. 设计决策与权衡

### 15.1 决策 1: 单个附件类型失败不阻塞整体

**备选方案**:
- A: 任一附件失败则整体失败 (抛错)
- B: 失败附件跳过，继续处理其他 (当前选择)
- C: 区分关键/非关键附件，关键失败则整体失败

**选择理由**:
- 附件是增强而非核心功能，降级体验优于完全失败
- 遥测可观测失败率，单独优化问题类型
- 用户仍可获得其他有用上下文

**代价**:
- 部分上下文可能缺失而无显式反馈
- 需要依赖日志和遥测发现问题

**证据**:
- `maybe()` 包装器捕获所有异常并返回 `[]`
- 5% 采样日志 `tengu_attachment_compute_duration` 包含 `error: true`

### 15.2 决策 2: 1秒全局超时限制

**备选方案**:
- A: 无超时，等待所有附件完成
- B: 每个附件类型独立超时
- C: 1秒全局超时 (当前选择)

**选择理由**:
- 防止慢速附件阻塞主交互流程 (用户可察觉延迟)
- 快速失败让模型优先响应用户核心输入
- 大多数附件类型可在 1秒内完成

**代价**:
- 某些慢速附件 (如大目录列表) 可能偶尔缺失
- 需要优化慢路径或预取

**证据**:
```typescript
const abortController = createAbortController()
const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController)
```

### 15.3 决策 3: 双重缓存去重 (nested_memory)

**备选方案**:
- A: 仅依赖 readFileState (LRU, 可驱逐)
- B: 仅依赖 loadedNestedMemoryPaths (不可驱逐)
- C: 两者结合 (当前选择)

**选择理由**:
- `loadedNestedMemoryPaths` 防止同一对话中重复注入同一 CLAUDE.md
- `readFileState` 提供跨函数/跨回合去重，并跟踪文件变更
- 两者互补: LRU 容量有限但必要，不可驱逐集合保证会话内一致性

**证据**:
```typescript
if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) continue
if (!toolUseContext.readFileState.has(memoryFile.path)) {
  // 添加并缓存
}
```

### 15.4 决策 4: 仅 ENOENT 从 readFileState 驱逐

**备选方案**:
- A: 任何错误都驱逐
- B: 仅 ENOENT 驱逐 (当前选择)
- C: 永不驱逐，永久保留

**选择理由**:
- 编辑器原子保存 (tmp→rename) 会导致瞬时 ENOENT/权限错误，不应驱逐
- 永久保留会导致内存泄漏和 stale 数据
- ENOENT 是文件真删除的可靠信号

**代价**:
- 极少见情况下 (文件真删除后立即恢复) 可能错过变更
- 需要依赖 mtime 检查处理边缘情况

**证据**:
```typescript
if (isENOENT(error)) {
  toolUseContext.readFileState.delete(filePath)
}
```

### 15.5 决策 5: 相关记忆异步预取

**备选方案**:
- A: 同步检索，阻塞回合
- B: 异步预取，与模型/工具执行并发 (当前选择)
- C: 完全不预取，仅在首次需要时检索

**选择理由**:
- 记忆检索可能涉及昂贵的相似度计算，异步化消除阻塞
- 利用模型推理和工具执行的"空闲"时间预取
- Symbol.dispose 自动清理，防止内存泄漏

**代价**:
- 复杂度增加 (需要管理预取句柄生命周期)
- 若在完成前消费可能仍需等待

**证据**:
```typescript
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  settledAt: number | null
  consumedOnIteration: number
  [Symbol.dispose](): void
}
```

### 15.6 决策 6: PDF 引用而非内联大文件

**备选方案**:
- A: 总是内联 PDF
- B: 大 PDF 返回引用 (当前选择)
- C: 从不内联 PDF

**选择理由**:
- PDF 可能很大，轻松消耗整个上下文窗口
- 引用告知模型存在及其元数据，模型可显式读取需要的部分
- 阈值基于页数 (优先) 或大小估算

**证据**:
```typescript
const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))
if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
  return { type: 'pdf_reference', ... }
}
```

### 15.7 决策 7: 日期变更作为附件而非修改前缀

**备选方案**:
- A: 修改 getUserContext 返回的日期，使缓存失效
- B: 追加 date_change 附件 (当前选择)

**选择理由**:
- 避免破坏 prompt caching (修改前缀会让整个会话缓存失效)
- 日期变更是低频率事件，作为附件追加足够
- 前缀仍保留旧日期供参考，模型可通过附件了解新日期

**证据**:
```typescript
// messages[0] intentionally keeps stale date
return [{ type: 'date_change', newDate: currentDate }]
```

### 15.8 决策 8: 结构化协议消息不从邮箱标记已读

**备选方案**:
- A: 所有消息都标记已读
- B: 结构化协议消息保留未读 (当前选择)

**选择理由**:
- 协议消息 (权限请求/响应、关闭等) 需要由 useInboxPoller 专门处理
- 附件系统不应"消费"这些消息，否则专用处理器看不到它们
- 过滤确保两者可共存: 人工消息作为附件，协议消息走专用路径

**证据**:
```typescript
const unreadMessages = allUnreadMessages.filter(m => !isStructuredProtocolMessage(m.text))
...
await markMessagesAsReadByPredicate(agentName, m => !isStructuredProtocolMessage(m.text), teamName)
```

### 15.9 决策 9: 图片大小双重检查 (resize + validation)

**备选方案**:
- A: 仅依赖 resize 保证不超限
- B: 仅依赖 API 边界验证
- C: 两者结合 (当前选择)

**选择理由**:
- resize 是主动优化，处理大多数常见情况
- validation 是安全网，捕获任何边缘情况 (如 resize 后的意外增长)
- 分层防御比单层更可靠

**证据**:
- `maybeResizeAndDownsampleImageBuffer` 在图片粘贴时调用
- `validateImagesForAPI` 在 API 边界调用，抛出 `ImageSizeError`

### 15.10 决策 10: 计划/自动模式提醒按用户轮次计数

**备选方案**:
- A: 按消息总数计数
- B: 按用户轮次计数 (当前选择)
- C: 按时间计数

**选择理由**:
- 工具循环中可能产生大量 assistant/tool 消息，不应触发提醒
- 用户轮次是用户实际交互频率的真实反映
- 避免用户输入一次后，工具循环产生 100 条消息时频繁提醒

**证据**:
```typescript
// 仅计算非 meta、非 tool result 的用户消息
if (message?.type === 'user' && !message.isMeta && !hasToolResultContent(message.message.content)) {
  turnsSinceLastAttachment++
}
```

## 16. 隐私与安全考虑

### 16.1 权限检查点

每个附件类型在适用时都会检查:
- `isFileReadDenied()`: 基于 deny/pattern 规则
- `pathInAllowedWorkingPath()`: 基于 allowed working path 配置
- `getAppState().toolPermissionContext`: 当前权限模式

### 16.2 内存文件内容差异处理

```typescript
toolUseContext.readFileState.set(memoryFile.path, {
  content: memoryFile.contentDiffersFromDisk
    ? (memoryFile.rawContent ?? memoryFile.content)  // 缓存原始磁盘内容
    : memoryFile.content,
  isPartialView: memoryFile.contentDiffersFromDisk,  // 标记为部分视图
})
```

**设计**: 注入模型的是处理后内容 (去除 HTML 注释、前置等)，但缓存原始磁盘内容以确保编辑功能正常工作。

### 16.3 图片文件权限 0o600

```typescript
await fh.writeFile(content.content, { encoding: 'base64' })  // mode: 0o600
```

**设计**: 缓存的图片文件权限设为仅用户可读写，防止敏感图片泄露。

## 17. 覆盖率与测试

覆盖率文件见: [Coverage](../../architecture/coverage/attachments.yaml)

## 18. 未来演进方向

1. **更智能的预取调度**: 基于历史使用模式预测哪些附件更可能被需要
2. **增量更新机制**: 仅发送变更部分而非完整附件
3. **优先级队列**: 关键附件优先处理/发送
4. **附件压缩**: 对大附件应用更激进的压缩/摘要
5. **持久化缓存**: 跨会话重用某些附件类型 (如技能列表)

