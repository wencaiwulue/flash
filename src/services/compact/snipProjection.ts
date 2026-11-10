import type { Message, SystemSnipBoundaryMessage } from '../../types/message.js'

export function isSnipBoundaryMessage(
  message: Message,
): message is SystemSnipBoundaryMessage {
  return message.type === 'system' && message.subtype === 'snip_boundary'
}

/** Keep scrollback after the latest boundary and never expose internal markers. */
export function projectSnippedView<T extends Message>(messages: T[]): T[] {
  const boundary = messages.findLastIndex(isSnipBoundaryMessage)
  return messages
    .slice(boundary >= 0 ? boundary : 0)
    .filter(message => message.type !== 'system' || message.subtype !== 'snip_marker')
}
