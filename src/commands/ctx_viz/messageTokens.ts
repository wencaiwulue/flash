import type { Message } from '../../types/message.js'
import type { ContextData } from '../../utils/analyzeContext.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'

export type MessageTokenRow = {
  id: string
  role: string
  category: string
  tokens: number
}

function classify(message: Message): string | null {
  if (message.type === 'attachment') return 'attachment'
  if (message.type === 'user') {
    const content = message.message.content
    return Array.isArray(content) &&
      content.some(block => block.type === 'tool_result')
      ? 'tool-result'
      : 'user'
  }
  if (message.type === 'assistant') {
    return message.message.content.some(block => block.type === 'tool_use')
      ? 'tool-call'
      : 'assistant'
  }
  return null
}

function estimate(message: Message): number {
  if (message.type === 'attachment') {
    return roughTokenCountEstimation(JSON.stringify(message.attachment))
  }
  if (message.type === 'user' || message.type === 'assistant') {
    return roughTokenCountEstimation(JSON.stringify(message.message.content))
  }
  return 0
}

/** Allocate the shared /context message total without exporting message content. */
export function buildMessageTokenRows(
  messages: readonly Message[],
  totalTokens: number,
): MessageTokenRow[] {
  const candidates = messages.flatMap((message, index) => {
    const category = classify(message)
    if (!category) return []
    return [{
      id: 'uuid' in message ? message.uuid : `message-${index + 1}`,
      role: message.type,
      category,
      estimate: estimate(message),
    }]
  })
  if (candidates.length === 0) return []
  const estimateTotal = candidates.reduce((sum, row) => sum + row.estimate, 0)
  const total = Math.max(0, Math.round(totalTokens))
  const allocations = candidates.map((row, index) => {
    const weight = estimateTotal > 0 ? row.estimate / estimateTotal : 1 / candidates.length
    const exact = weight * total
    return { index, base: Math.floor(exact), fraction: exact - Math.floor(exact) }
  })
  let remainder = total - allocations.reduce((sum, row) => sum + row.base, 0)
  for (const row of [...allocations].sort((a, b) => b.fraction - a.fraction || a.index - b.index)) {
    if (remainder <= 0) break
    row.base++
    remainder--
  }
  return candidates.map(({ estimate: _estimate, ...row }, index) => ({
    ...row,
    tokens: allocations.find(allocation => allocation.index === index)!.base,
  }))
}

export type ContextVizExport = {
  schemaVersion: 1
  model: string
  totalTokens: number
  maxTokens: number
  categories: Array<{ name: string; tokens: number; deferred: boolean }>
  messages: MessageTokenRow[]
}

export function buildContextVizExport(
  data: ContextData,
  messages: MessageTokenRow[],
): ContextVizExport {
  return {
    schemaVersion: 1,
    model: data.model,
    totalTokens: data.totalTokens,
    maxTokens: data.maxTokens,
    categories: data.categories.map(category => ({
      name: category.name,
      tokens: category.tokens,
      deferred: category.isDeferred === true,
    })),
    messages,
  }
}
