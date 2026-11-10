import { APIUserAbortError } from '@anthropic-ai/sdk'
import type { QuerySource } from '../../constants/querySource.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { executePreCompactHooks } from '../../utils/hooks.js'
import { isMediaSizeErrorMessage, isPromptTooLongMessage } from '../api/errors.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  compactConversation,
  type CompactionResult,
  stripImagesFromMessages,
} from './compact.js'
import { suppressCompactWarning } from './compactWarningState.js'
import { groupMessagesByApiRound } from './grouping.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'

export type ReactiveCompactAttempt = {
  hasAttempted: boolean
  querySource: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}

export type ReactiveCompactOutcome =
  | { ok: true; result: CompactionResult }
  | {
      ok: false
      reason: 'too_few_groups' | 'aborted' | 'exhausted' | 'error' | 'media_unstrippable'
    }

const defaultDependencies = {
  compact: compactConversation,
  preCompact: executePreCompactHooks,
  onSuccess(querySource: QuerySource) {
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    suppressCompactWarning()
  },
}

let dependencies = defaultDependencies

export function initReactiveCompact(
  overrides: Partial<typeof defaultDependencies> = {},
): void {
  dependencies = { ...defaultDependencies, ...overrides }
}

export function isReactiveCompactEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_REACTIVE_COMPACT)
}

export function isReactiveOnlyMode(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)
}

export function isWithheldPromptTooLong(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent | undefined,
): boolean {
  return (
    isReactiveCompactEnabled() &&
    message?.type === 'assistant' &&
    isPromptTooLongMessage(message)
  )
}

export function isWithheldMediaSizeError(
  message: AssistantMessage | SystemAPIErrorMessage | StreamEvent | undefined,
): boolean {
  return (
    isReactiveCompactEnabled() &&
    message?.type === 'assistant' &&
    isMediaSizeErrorMessage(message)
  )
}

function containsStrippableMedia(messages: Message[]): boolean {
  return messages.some(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return false
    }
    return message.message.content.some(block => {
      if (block.type === 'image' || block.type === 'document') return true
      return (
        block.type === 'tool_result' &&
        Array.isArray(block.content) &&
        block.content.some(item => item.type === 'image' || item.type === 'document')
      )
    })
  })
}

export async function tryReactiveCompact(
  attempt: ReactiveCompactAttempt,
): Promise<CompactionResult | null> {
  if (attempt.hasAttempted || attempt.aborted) return null
  if (attempt.querySource === 'compact' || attempt.querySource === 'session_memory') {
    return null
  }
  const hookResult = await dependencies.preCompact(
    { trigger: 'auto', customInstructions: null },
    attempt.cacheSafeParams.toolUseContext.abortController.signal,
  )
  const outcome = await reactiveCompactOnPromptTooLong(
    attempt.messages,
    attempt.cacheSafeParams,
    {
      customInstructions: hookResult.newCustomInstructions,
      trigger: 'auto',
    },
  )
  if (!outcome.ok) return null
  dependencies.onSuccess(attempt.querySource)
  const userDisplayMessage = [
    hookResult.userDisplayMessage,
    outcome.result.userDisplayMessage,
  ]
    .filter(Boolean)
    .join('\n')
  return {
    ...outcome.result,
    userDisplayMessage: userDisplayMessage || undefined,
  }
}

export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  options: {
    customInstructions: string | undefined
    trigger: 'manual' | 'auto'
  },
): Promise<ReactiveCompactOutcome> {
  if (cacheSafeParams.toolUseContext.abortController.signal.aborted) {
    return { ok: false, reason: 'aborted' }
  }
  if (groupMessagesByApiRound(messages).length < 2) {
    return { ok: false, reason: 'too_few_groups' }
  }
  const last = messages.at(-1)
  if (
    last?.type === 'assistant' &&
    isMediaSizeErrorMessage(last) &&
    !containsStrippableMedia(messages)
  ) {
    return { ok: false, reason: 'media_unstrippable' }
  }

  const stripped = stripImagesFromMessages(messages)
  try {
    const result = await dependencies.compact(
      stripped,
      cacheSafeParams.toolUseContext,
      { ...cacheSafeParams, forkContextMessages: stripped },
      true,
      options.customInstructions,
      options.trigger === 'auto',
      undefined,
      true,
    )
    return { ok: true, result }
  } catch (error) {
    if (
      error instanceof APIUserAbortError ||
      cacheSafeParams.toolUseContext.abortController.signal.aborted
    ) {
      return { ok: false, reason: 'aborted' }
    }
    logForDebugging(`Reactive compaction failed: ${String(error)}`)
    return {
      ok: false,
      reason:
        error instanceof Error && error.message.includes('Prompt is too long')
          ? 'exhausted'
          : 'error',
    }
  }
}
