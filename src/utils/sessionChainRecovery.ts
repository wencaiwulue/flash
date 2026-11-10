import type { UUID } from 'crypto'

export type RecoverableTranscriptMessage = {
  type: string
  uuid: UUID
  parentUuid?: UUID | null
  timestamp?: string
  message?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function apiMessageId(message: RecoverableTranscriptMessage): string | undefined {
  if (message.type !== 'assistant') return undefined
  const id = asRecord(message.message)?.id
  return typeof id === 'string' && id ? id : undefined
}

function containsToolResult(message: RecoverableTranscriptMessage): boolean {
  if (message.type !== 'user' || !message.parentUuid) return false
  const content = asRecord(message.message)?.content
  return (
    Array.isArray(content) &&
    content.some(block => asRecord(block)?.type === 'tool_result')
  )
}

/**
 * Recover assistant content-block siblings and their tool results that a
 * single-parent walk cannot reach. This is pure so CLI resume and SDK reads can
 * share exactly the same DAG reconstruction without sharing analytics or CLI
 * session state.
 */
export function recoverOrphanedParallelToolResults<
  T extends RecoverableTranscriptMessage,
>(
  messages: Map<UUID, T>,
  chain: T[],
  seen: ReadonlySet<UUID>,
): { chain: T[]; recoveredCount: number } {
  const chainAssistants = chain.filter(message => apiMessageId(message))
  if (chainAssistants.length === 0) return { chain, recoveredCount: 0 }

  // Anchor = last on-chain member of each sibling group. chainAssistants is
  // already in chain order, so later iterations overwrite → last wins.
  const anchorByMsgId = new Map<string, T>()
  for (const assistant of chainAssistants) {
    anchorByMsgId.set(apiMessageId(assistant)!, assistant)
  }

  // Tool results are indexed by parentUuid: insertMessageChain writes the
  // source assistant UUID there, and --fork-session retains that parent link.
  const siblingsByMsgId = new Map<string, T[]>()
  const toolResultsByAssistant = new Map<UUID, T[]>()
  for (const message of messages.values()) {
    const msgId = apiMessageId(message)
    if (msgId) {
      const group = siblingsByMsgId.get(msgId)
      if (group) group.push(message)
      else siblingsByMsgId.set(msgId, [message])
    } else if (containsToolResult(message)) {
      const group = toolResultsByAssistant.get(message.parentUuid!)
      if (group) group.push(message)
      else toolResultsByAssistant.set(message.parentUuid!, [message])
    }
  }

  // Splice after the last on-chain member so each group stays contiguous for
  // API normalization and every recovered result follows its tool_use.
  const processedGroups = new Set<string>()
  const inserts = new Map<UUID, T[]>()
  let recoveredCount = 0
  for (const assistant of chainAssistants) {
    const msgId = apiMessageId(assistant)!
    if (processedGroups.has(msgId)) continue
    processedGroups.add(msgId)

    const group = siblingsByMsgId.get(msgId) ?? [assistant]
    const orphanedSiblings = group.filter(sibling => !seen.has(sibling.uuid))
    const orphanedToolResults: T[] = []
    for (const member of group) {
      const results = toolResultsByAssistant.get(member.uuid)
      if (!results) continue
      for (const result of results) {
        if (!seen.has(result.uuid)) orphanedToolResults.push(result)
      }
    }
    if (orphanedSiblings.length === 0 && orphanedToolResults.length === 0) {
      continue
    }

    // Stable sort preserves JSONL write order when timestamps are equal or absent.
    const byTimestamp = (a: T, b: T) =>
      (a.timestamp ?? '').localeCompare(b.timestamp ?? '')
    orphanedSiblings.sort(byTimestamp)
    orphanedToolResults.sort(byTimestamp)

    const recovered = [...orphanedSiblings, ...orphanedToolResults]
    recoveredCount += recovered.length
    inserts.set(anchorByMsgId.get(msgId)!.uuid, recovered)
  }

  if (recoveredCount === 0) return { chain, recoveredCount: 0 }

  const result: T[] = []
  for (const message of chain) {
    result.push(message)
    const toInsert = inserts.get(message.uuid)
    if (toInsert) result.push(...toInsert)
  }
  return { chain: result, recoveredCount }
}
