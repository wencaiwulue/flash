import type { Message } from '../../types/message.js'
import { collapseStore } from './store.js'

function uuidOf(message: Message): string | undefined {
  return 'uuid' in message && typeof message.uuid === 'string'
    ? message.uuid
    : undefined
}

/** Replay committed spans over full history. Already projected views are stable. */
export function projectView<T extends Message>(messages: T[]): T[] {
  let view: Message[] = [...messages]
  for (const commit of collapseStore.committed) {
    if (view.some(message => uuidOf(message) === commit.summaryUuid)) continue
    const first = view.findIndex(
      message => uuidOf(message) === commit.firstArchivedUuid,
    )
    const last = view.findIndex(
      message => uuidOf(message) === commit.lastArchivedUuid,
    )
    if (first < 0 || last < first) continue
    commit.archived = view.slice(first, last + 1)
    view = [
      ...view.slice(0, first),
      commit.summaryMessage,
      ...view.slice(last + 1),
    ]
  }
  return view as T[]
}

export function findMessageSpan(
  messages: Message[],
  startUuid: string,
  endUuid: string,
): Message[] | undefined {
  const start = messages.findIndex(message => uuidOf(message) === startUuid)
  const end = messages.findIndex(message => uuidOf(message) === endUuid)
  return start >= 0 && end >= start
    ? messages.slice(start, end + 1)
    : undefined
}

export function selectCollapseSpan(messages: Message[]): Message[] | undefined {
  if (messages.length < 6) return undefined
  let end = messages.length - 5
  while (end > 0) {
    const current = messages[end]!
    const next = messages[end + 1]!
    const currentHasToolUse =
      current.type === 'assistant' &&
      current.message.content.some(block => block.type === 'tool_use')
    const nextHasToolResult =
      next.type === 'user' &&
      Array.isArray(next.message.content) &&
      next.message.content.some(block => block.type === 'tool_result')
    if (!currentHasToolUse && !nextHasToolResult) break
    end--
  }
  return end > 0 ? messages.slice(0, end + 1) : undefined
}
