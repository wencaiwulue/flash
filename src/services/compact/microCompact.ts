import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../../tools/WebSearchTool/prompt.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { SHELL_TOOL_NAMES } from '../../utils/shell/shellToolUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { notifyCacheDeletion } from '../api/promptCacheBreakDetection.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import {
  clearCompactWarningSuppression,
  suppressCompactWarning,
} from './compactWarningState.js'
import {
  getTimeBasedMCConfig,
  type TimeBasedMCConfig,
} from './timeBasedMCConfig.js'

// Inline from utils/toolResultStorage.ts — importing that file pulls in
// sessionStorage → utils/messages → services/api/errors, completing a
// circular-deps loop back through this file via promptCacheBreakDetection.
// Drift is caught by a test asserting equality with the source-of-truth.
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

const IMAGE_MAX_TOKEN_SIZE = 2000

// Only compact these tools
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

// ============================================================================
// Session-scoped Microcompact API (NEW)
// ============================================================================

export type CacheEditsBlock = {
  type: 'cache_edits'
  edits: Array<{ type: 'delete'; cache_reference: string }>
}

export type PinnedCacheEdits = {
  userMessageIndex: number
  block: CacheEditsBlock
}

export type PendingCacheEdits = {
  trigger: 'auto'
  deletedToolIds: string[]
  // Baseline cumulative cache_deleted_input_tokens from the previous API response,
  // used to compute the per-operation delta (the API value is sticky/cumulative)
  baselineCacheDeletedTokens: number
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    pendingCacheEdits?: PendingCacheEdits
  }
}

/**
 * Session-scoped cached microcompact state.
 */
export class CachedMicrocompactState {
  readonly registeredTools = new Set<string>()
  readonly toolOrder: string[] = []
  readonly deletedRefs = new Set<string>()
  readonly pinnedEdits: PinnedCacheEdits[] = []
  pendingCacheEdits: CacheEditsBlock | null = null

  reset(): void {
    this.registeredTools.clear()
    this.toolOrder.length = 0
    this.deletedRefs.clear()
    this.pinnedEdits.length = 0
    this.pendingCacheEdits = null
  }
}

/**
 * Session-scoped microcompact service.
 */
export class MicrocompactSession {
  readonly cachedState: CachedMicrocompactState
  private readonly model: string
  private cachedModule: typeof import('./cachedMicrocompact.js') | undefined

  constructor(model?: string) {
    this.cachedState = new CachedMicrocompactState()
    this.model = model ?? getMainLoopModel()
  }

  get pendingCacheEdits(): CacheEditsBlock | null {
    return this.cachedState.pendingCacheEdits
  }

  get pinnedCacheEdits(): PinnedCacheEdits[] {
    return this.cachedState.pinnedEdits
  }

  consumePendingCacheEdits(): CacheEditsBlock | null {
    const edits = this.cachedState.pendingCacheEdits
    this.cachedState.pendingCacheEdits = null
    return edits
  }

  pinCacheEdits(userMessageIndex: number, block: CacheEditsBlock): void {
    this.cachedState.pinnedEdits.push({ userMessageIndex, block })
  }

  markToolsSentToAPI(): void {
    if (this.cachedModule && feature('CACHED_MICROCOMPACT')) {
      this.cachedModule.markToolsSentToAPI(this.cachedState as any)
    }
  }

  reset(): void {
    this.cachedState.reset()
  }

  async microcompactMessages(
    messages: Message[],
    toolUseContext?: ToolUseContext,
    querySource?: QuerySource,
  ): Promise<MicrocompactResult> {
    // Clear suppression flag at start of new microcompact attempt
    clearCompactWarningSuppression()

    // Time-based trigger runs first and short-circuits
    const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
    if (timeBasedResult) {
      // Reset cached state when time-based compaction runs since the
      // server cache is cold and edits would be invalid
      this.cachedState.reset()
      return timeBasedResult
    }

    // Only run cached MC for the main thread to prevent forked agents
    // (session_memory, prompt_suggestion, etc.) from registering their
    // tool_results in global cachedMCState
    if (
      feature('CACHED_MICROCOMPACT') &&
      isMainThreadSource(querySource)
    ) {
      return await this.cachedMicrocompactPath(messages, querySource)
    }

    // No compaction for contexts without cached MC (external builds,
    // unsupported models, non-main-thread sources)
    return { messages }
  }

  private async getCachedModule(): Promise<
    typeof import('./cachedMicrocompact.js')
  > {
    if (!this.cachedModule) {
      this.cachedModule = await import('./cachedMicrocompact.js')
    }
    return this.cachedModule
  }

  private async cachedMicrocompactPath(
    messages: Message[],
    querySource: QuerySource | undefined,
  ): Promise<MicrocompactResult> {
    const mod = await this.getCachedModule()
    const state = this.cachedState
    const config = mod.getCachedMCConfig()

    // Skip if model isn't supported
    if (!mod.isModelSupportedForCacheEditing(this.model)) {
      return { messages }
    }

    const compactableToolIds = new Set(collectCompactableToolIds(messages))
    // Second pass: register tool results grouped by user message
    for (const message of messages) {
      if (message.type === 'user' && Array.isArray(message.message.content)) {
        const groupIds: string[] = []
        for (const block of message.message.content) {
          if (
            block.type === 'tool_result' &&
            compactableToolIds.has(block.tool_use_id) &&
            !state.registeredTools.has(block.tool_use_id)
          ) {
            mod.registerToolResult(state as any, block.tool_use_id)
            groupIds.push(block.tool_use_id)
          }
        }
        mod.registerToolMessage(state as any, groupIds)
      }
    }

    const toolsToDelete = mod.getToolResultsToDelete(state as any)

    if (toolsToDelete.length > 0) {
      // Create and queue the cache edits block for the API layer
      const cacheEdits = mod.createCacheEditsBlock(state as any, toolsToDelete)
      if (cacheEdits) {
        state.pendingCacheEdits = cacheEdits
      }

      logForDebugging(
        `Cached MC deleting ${toolsToDelete.length} tool(s): ${toolsToDelete.join(', ')}`,
      )

      logEvent('tengu_cached_microcompact', {
        toolsDeleted: toolsToDelete.length,
        deletedToolIds: toolsToDelete.join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        activeToolCount: state.toolOrder.length - state.deletedRefs.size,
        triggerType:
          'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        threshold: config.triggerThreshold,
        keepRecent: config.keepRecent,
      })

      suppressCompactWarning()

      // Notify cache break detection that cache reads will legitimately drop
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        notifyCacheDeletion(querySource ?? 'repl_main_thread')
      }

      // Return messages unchanged - cache_reference and cache_edits are added at API layer
      const lastAsst = messages.findLast(m => m.type === 'assistant')
      const baseline =
        lastAsst?.type === 'assistant'
          ? ((
              lastAsst.message.usage as unknown as Record<
                string,
                number | undefined
              >
            )?.cache_deleted_input_tokens ?? 0)
          : 0

      return {
        messages,
        compactionInfo: {
          pendingCacheEdits: {
            trigger: 'auto',
            deletedToolIds: toolsToDelete,
            baselineCacheDeletedTokens: baseline,
          },
        },
      }
    }

    return { messages }
  }
}

// ============================================================================
// Shared helpers (used by both session-scoped and legacy APIs)
// ============================================================================

function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}

function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}

function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (!block.content) {
    return 0
  }

  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }

  // Array of TextBlockParam | ImageBlockParam | DocumentBlockParam
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + roughTokenCountEstimation(item.text)
    } else if (item.type === 'image' || item.type === 'document') {
      // Images/documents are approximately 2000 tokens regardless of format
      return sum + IMAGE_MAX_TOKEN_SIZE
    }
    return sum
  }, 0)
}

export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0

  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue
    }

    if (!Array.isArray(message.message.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (block.type === 'text') {
        totalTokens += roughTokenCountEstimation(block.text)
      } else if (block.type === 'tool_result') {
        totalTokens += calculateToolResultTokens(block)
      } else if (block.type === 'image' || block.type === 'document') {
        totalTokens += IMAGE_MAX_TOKEN_SIZE
      } else if (block.type === 'thinking') {
        totalTokens += roughTokenCountEstimation(block.thinking)
      } else if (block.type === 'redacted_thinking') {
        totalTokens += roughTokenCountEstimation(block.data)
      } else if (block.type === 'tool_use') {
        totalTokens += roughTokenCountEstimation(
          block.name + jsonStringify(block.input ?? {}),
        )
      } else {
        totalTokens += roughTokenCountEstimation(jsonStringify(block))
      }
    }
  }

  return Math.ceil(totalTokens * (4 / 3))
}

/**
 * Check whether the time-based trigger should fire for this request.
 *
 * Returns the measured gap (minutes since last assistant message) when the
 * trigger fires, or null when it doesn't (disabled, wrong source, under
 * threshold, no prior assistant, unparseable timestamp).
 */
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}

function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) {
    return null
  }

  let tokensSaved = 0
  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    let touched = false
    const newContent = message.message.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        tokensSaved += calculateToolResultTokens(block)
        touched = true
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  if (tokensSaved === 0) {
    return null
  }

  logEvent('tengu_time_based_microcompact', {
    gapMinutes: Math.round(gapMinutes),
    gapThresholdMinutes: config.gapThresholdMinutes,
    toolsCleared: clearSet.size,
    toolsKept: keepSet.size,
    keepRecent: config.keepRecent,
    tokensSaved,
  })

  logForDebugging(
    `[TIME-BASED MC] gap ${Math.round(gapMinutes)}min > ${config.gapThresholdMinutes}min, cleared ${clearSet.size} tool results (~${tokensSaved} tokens), kept last ${keepRecent}`,
  )

  suppressCompactWarning()

  return { messages: result }
}

// ============================================================================
// Legacy compatibility layer (backward compatibility)
// DEPRECATED: Use MicrocompactSession class instead
// ============================================================================

let cachedMCModule: typeof import('./cachedMicrocompact.js') | null =
  feature('CACHED_MICROCOMPACT') ? require('./cachedMicrocompact.js') : null
let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null =
  null
let pendingCacheEdits: CacheEditsBlock | null = null

// Singleton legacy session for backward compatibility
let legacySession: MicrocompactSession | undefined

function getLegacySession(): MicrocompactSession {
  if (!legacySession) {
    legacySession = new MicrocompactSession()
  }
  return legacySession
}

async function getCachedMCModule(): Promise<
  typeof import('./cachedMicrocompact.js')
> {
  if (!feature('CACHED_MICROCOMPACT')) {
    throw new Error('Cached microcompact is not available in this build')
  }
  if (!cachedMCModule) {
    cachedMCModule = require('./cachedMicrocompact.js')
  }
  return cachedMCModule as typeof import('./cachedMicrocompact.js')
}

function ensureCachedMCState(): import('./cachedMicrocompact.js').CachedMCState {
  if (!cachedMCState && cachedMCModule) {
    cachedMCState = cachedMCModule.createCachedMCState()
  }
  if (!cachedMCState) {
    throw new Error(
      'cachedMCState not initialized — getCachedMCModule() must be called first',
    )
  }
  return cachedMCState
}

export function consumePendingCacheEdits(): CacheEditsBlock | null {
  const edits = pendingCacheEdits
  pendingCacheEdits = null
  return edits
}

export function getPinnedCacheEdits(): PinnedCacheEdits[] {
  if (!cachedMCState) {
    return []
  }
  return (cachedMCState as any).pinnedEdits ?? []
}

export function pinCacheEdits(
  userMessageIndex: number,
  block: CacheEditsBlock,
): void {
  if (cachedMCState) {
    (cachedMCState as any).pinnedEdits?.push({ userMessageIndex, block })
  }
}

export function markToolsSentToAPIState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.markToolsSentToAPI(cachedMCState)
  }
}

export function resetMicrocompactState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.resetCachedMCState(cachedMCState)
  }
  pendingCacheEdits = null
}

export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // This uses the old module-level state logic for backward compatibility
  clearCompactWarningSuppression()

  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    resetMicrocompactState()
    return timeBasedResult
  }

  if (
    feature('CACHED_MICROCOMPACT') &&
    isMainThreadSource(querySource)
  ) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model)
    ) {
      const state = ensureCachedMCState()
      const config = mod.getCachedMCConfig()

      const compactableToolIds = new Set(collectCompactableToolIds(messages))
      for (const message of messages) {
        if (
          message.type === 'user' &&
          Array.isArray(message.message.content)
        ) {
          const groupIds: string[] = []
          for (const block of message.message.content) {
            if (
              block.type === 'tool_result' &&
              compactableToolIds.has(block.tool_use_id) &&
              !state.registeredTools.has(block.tool_use_id)
            ) {
              mod.registerToolResult(state, block.tool_use_id)
              groupIds.push(block.tool_use_id)
            }
          }
          mod.registerToolMessage(state, groupIds)
        }
      }

      const toolsToDelete = mod.getToolResultsToDelete(state)
      if (toolsToDelete.length > 0) {
        const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
        if (cacheEdits) {
          pendingCacheEdits = cacheEdits
        }

        logForDebugging(
          `Cached MC deleting ${toolsToDelete.length} tool(s): ${toolsToDelete.join(', ')}`,
        )

        logEvent('tengu_cached_microcompact', {
          toolsDeleted: toolsToDelete.length,
          deletedToolIds: toolsToDelete.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          activeToolCount: state.toolOrder.length - state.deletedRefs.size,
          triggerType:
            'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          threshold: config.triggerThreshold,
          keepRecent: config.keepRecent,
        })

        suppressCompactWarning()

        if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
          notifyCacheDeletion(querySource ?? 'repl_main_thread')
        }

        const lastAsst = messages.findLast(m => m.type === 'assistant')
        const baseline =
          lastAsst?.type === 'assistant'
            ? ((
                lastAsst.message.usage as unknown as Record<
                  string,
                  number | undefined
                >
              )?.cache_deleted_input_tokens ?? 0)
            : 0

        return {
          messages,
          compactionInfo: {
            pendingCacheEdits: {
              trigger: 'auto',
              deletedToolIds: toolsToDelete,
              baselineCacheDeletedTokens: baseline,
            },
          },
        }
      }
    }
  }

  return { messages }
}
