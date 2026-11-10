import type { DangerousBackend } from './backends/dangerousBackend.js'

export type SessionManagerOptions = {
  idleTimeoutMs: number
  maxSessions: number
}

export class SessionManager {
  constructor(
    _backend: DangerousBackend,
    _options: SessionManagerOptions,
  ) {
    throw new Error('Direct-connect session management is unavailable in this build')
  }

  async destroyAll(): Promise<never> {
    throw new Error('Direct-connect session management is unavailable in this build')
  }
}
