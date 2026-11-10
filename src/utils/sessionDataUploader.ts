import type { Message } from '../types/message.js'

export type SessionTurnUploadResult = {
  uploaded: false
  reason: 'unavailable'
}

export type SessionTurnUploader = (
  messages: Message[],
) => Promise<SessionTurnUploadResult>

export function createSessionTurnUploader(): SessionTurnUploader {
  return async (_messages: Message[]) => ({
    uploaded: false,
    reason: 'unavailable',
  })
}
