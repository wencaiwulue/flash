import type { QuerySource } from '../../constants/querySource.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { CompactionResult } from './compact.js'

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

export function isReactiveCompactEnabled(): boolean {
  return false
}

export function isReactiveOnlyMode(): boolean {
  return false
}

export function isWithheldPromptTooLong(
  _message: AssistantMessage | SystemAPIErrorMessage | StreamEvent | undefined,
): boolean {
  return false
}

export function isWithheldMediaSizeError(
  _message: AssistantMessage | SystemAPIErrorMessage | StreamEvent | undefined,
): boolean {
  return false
}

export async function tryReactiveCompact(
  _attempt: ReactiveCompactAttempt,
): Promise<CompactionResult | null> {
  return null
}

export async function reactiveCompactOnPromptTooLong(
  _messages: Message[],
  _cacheSafeParams: CacheSafeParams,
  _options: {
    customInstructions: string | undefined
    trigger: 'manual' | 'auto'
  },
): Promise<ReactiveCompactOutcome> {
  throw new Error('Reactive compaction is unavailable in this external build.')
}
