import type { Message } from '../../types/message.js'

export type SnipCompactResult = {
  messages: Message[]
  tokensFreed: number
  executed: boolean
  boundaryMessage?: Message
}

export const SNIP_NUDGE_TEXT =
  'Context-efficiency nudges are unavailable in this external build.'

export function isSnipRuntimeEnabled(): boolean {
  return false
}

export function shouldNudgeForSnips(_messages: Message[]): boolean {
  return false
}

export function isSnipMarkerMessage(_message: Message): boolean {
  return false
}

export function snipCompactIfNeeded(
  messages: Message[],
  _options?: { force?: boolean },
): SnipCompactResult {
  return { messages, tokensFreed: 0, executed: false }
}
