import type { AssistantMessage } from '../types/message.js'

export async function classifyAndWriteState(
  _jobDirectory: string,
  _assistantMessages: AssistantMessage[],
): Promise<void> {
  throw new Error('Job classification is unavailable in this external build.')
}
