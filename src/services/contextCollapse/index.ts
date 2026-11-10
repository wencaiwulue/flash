import type { QuerySource } from '../../constants/querySource.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'

export type ContextCollapseStats = {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: {
    totalSpawns: number
    totalErrors: number
    totalEmptySpawns: number
    emptySpawnWarningEmitted: boolean
    lastError?: string
  }
}

const EMPTY_STATS: ContextCollapseStats = {
  collapsedSpans: 0,
  collapsedMessages: 0,
  stagedSpans: 0,
  health: {
    totalSpawns: 0,
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
  },
}

export function isContextCollapseEnabled(): boolean {
  return false
}

export function initContextCollapse(): void {
  // Disabled: no background workers or persistent store are initialized.
}

export function resetContextCollapse(): void {
  // Disabled: there is no context-collapse state to reset.
}

export function getStats(): ContextCollapseStats {
  return EMPTY_STATS
}

export function subscribe(_listener: () => void): () => void {
  return () => {}
}

export async function applyCollapsesIfNeeded(
  messages: Message[],
  _toolUseContext: ToolUseContext,
  _querySource: QuerySource,
): Promise<{ messages: Message[] }> {
  return { messages }
}

export function isWithheldPromptTooLong(
  _message: AssistantMessage | SystemAPIErrorMessage | StreamEvent,
  _isPromptTooLongMessage: (message: AssistantMessage) => boolean,
  _querySource: QuerySource,
): boolean {
  return false
}

export function recoverFromOverflow(
  messages: Message[],
  _querySource: QuerySource,
): { messages: Message[]; committed: number } {
  return { messages, committed: 0 }
}
