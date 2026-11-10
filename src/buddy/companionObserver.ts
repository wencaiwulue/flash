import type { Message } from '../types/message.js'

export async function fireCompanionObserver(
  _messages: Message[],
  _onReaction: (reaction: string) => void,
): Promise<void> {
  // Companion observation is internal-only in this build.
}
