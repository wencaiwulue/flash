import { randomUUID } from 'crypto'
import type {
  Message,
  SystemSnipBoundaryMessage,
  SystemSnipMarkerMessage,
} from '../../types/message.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { deriveShortMessageId, isCompactBoundaryMessage } from '../../utils/messages.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { isSnipBoundaryMessage } from './snipProjection.js'

export type SnipCompactResult = {
  messages: Message[]
  tokensFreed: number
  executed: boolean
  boundaryMessage?: Message
}

export const SNIP_NUDGE_TEXT =
  'Context has grown since the last reset. If older turns are no longer needed, use Snip with their [id:...] values to remove them while preserving recent work and tool-result pairs.'
export const SNIP_NUDGE_TOKEN_INTERVAL = 10_000
const MIN_RETAINED_MESSAGES = 4

export function isSnipRuntimeEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_HISTORY_SNIP)
}

export function isSnipMarkerMessage(
  message: Message,
): message is SystemSnipMarkerMessage {
  return message.type === 'system' && message.subtype === 'snip_marker'
}

export function createSnipMarkerMessage(
  messageIds: string[],
): SystemSnipMarkerMessage {
  return {
    type: 'system',
    subtype: 'snip_marker',
    content: `Snip requested for ${messageIds.length} message(s)`,
    level: 'info',
    messageIds,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
}

export function shouldNudgeForSnips(messages: Message[]): boolean {
  let lastReset = -1
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    if (
      isSnipBoundaryMessage(message) ||
      isCompactBoundaryMessage(message) ||
      isSnipMarkerMessage(message) ||
      (message.type === 'attachment' &&
        message.attachment.type === 'context_efficiency')
    ) {
      lastReset = i
    }
  }
  return (
    roughTokenCountEstimationForMessages(messages.slice(lastReset + 1)) >=
    SNIP_NUDGE_TOKEN_INTERVAL
  )
}

function expandToolPairs(messages: Message[], targets: Set<string>): void {
  let changed = true
  while (changed) {
    changed = false
    const assistantIds = new Set<string>()
    const parentAssistantUuids = new Set<string>()
    for (const message of messages) {
      if (!targets.has(message.uuid)) continue
      if (message.type === 'assistant') assistantIds.add(message.message.id)
      if (message.type === 'user' && message.sourceToolAssistantUUID) {
        parentAssistantUuids.add(message.sourceToolAssistantUUID)
      }
    }
    for (const message of messages) {
      if (targets.has(message.uuid)) continue
      const linked =
        (message.type === 'user' &&
          message.sourceToolAssistantUUID &&
          targets.has(message.sourceToolAssistantUUID)) ||
        (message.type === 'assistant' &&
          (assistantIds.has(message.message.id) ||
            parentAssistantUuids.has(message.uuid)))
      if (linked) {
        targets.add(message.uuid)
        changed = true
      }
    }
  }
}

export function resolveSnipTargets(
  messages: Message[],
  requestedIds: string[],
): { targets: Set<string>; invalidIds: string[] } {
  const protectedUuids = new Set<string>(
    messages.slice(-MIN_RETAINED_MESSAGES).map(message => message.uuid),
  )
  const targets = new Set<string>()
  const invalidIds: string[] = []
  for (const id of new Set(requestedIds)) {
    const matches = messages.filter(
      message =>
        !protectedUuids.has(message.uuid) &&
        (message.type === 'user' || message.type === 'assistant') &&
        deriveShortMessageId(message.uuid) === id,
    )
    if (matches.length === 0) invalidIds.push(id)
    for (const match of matches) targets.add(match.uuid)
  }
  expandToolPairs(messages, targets)
  const protectedLinked = new Set(
    [...targets].filter(uuid => protectedUuids.has(uuid)),
  )
  expandToolPairs(messages, protectedLinked)
  for (const uuid of protectedLinked) targets.delete(uuid)
  return { targets, invalidIds }
}

function automaticTargets(messages: Message[]): Set<string> {
  const targets = new Set<string>()
  for (const message of messages.slice(0, -MIN_RETAINED_MESSAGES)) {
    if (message.type === 'user' || message.type === 'assistant') {
      targets.add(message.uuid)
    }
  }
  expandToolPairs(messages, targets)
  const protectedUuids = new Set<string>(
    messages.slice(-MIN_RETAINED_MESSAGES).map(message => message.uuid),
  )
  const protectedLinked = new Set(
    [...targets].filter(uuid => protectedUuids.has(uuid)),
  )
  expandToolPairs(messages, protectedLinked)
  for (const uuid of protectedLinked) targets.delete(uuid)
  return targets
}

export function snipCompactIfNeeded(
  messages: Message[],
  options: { force?: boolean; messageIds?: string[] } = {},
): SnipCompactResult {
  if (!isSnipRuntimeEnabled()) {
    return { messages, tokensFreed: 0, executed: false }
  }
  const marker = messages.findLast(isSnipMarkerMessage)
  if (!options.force && !marker) {
    return { messages, tokensFreed: 0, executed: false }
  }
  const requestedIds = options.messageIds ?? marker?.messageIds
  const { targets, invalidIds } = requestedIds
    ? resolveSnipTargets(messages, requestedIds)
    : { targets: automaticTargets(messages), invalidIds: [] }
  if (targets.size === 0) {
    return { messages, tokensFreed: 0, executed: false }
  }

  const removed = messages.filter(
    message => targets.has(message.uuid) || message === marker,
  )
  if (removed.length === 0) {
    return { messages, tokensFreed: 0, executed: false }
  }
  const tokensFreed = roughTokenCountEstimationForMessages(removed)
  const boundary: SystemSnipBoundaryMessage = {
    type: 'system',
    subtype: 'snip_boundary',
    content: `Snipped ${removed.length} older message(s), freeing approximately ${tokensFreed} tokens${invalidIds.length > 0 ? `; ${invalidIds.length} ID(s) were not found` : ''}`,
    level: 'info',
    snippedCount: removed.length,
    snippedTokens: tokensFreed,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
  const firstRemoved = messages.findIndex(message => removed.includes(message))
  const result = messages.filter(message => !removed.includes(message))
  result.splice(Math.max(0, firstRemoved), 0, boundary)
  return { messages: result, tokensFreed, executed: true, boundaryMessage: boundary }
}
