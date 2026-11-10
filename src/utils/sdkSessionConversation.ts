import { randomUUID } from 'crypto'
import type {
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '../entrypoints/sdk/coreTypes.js'
import type {
  SDKSession,
  SDKSessionOptions,
} from '../entrypoints/sdk/runtimeTypes.js'
import { createSdkQuery, UserMessageChannel } from './sdkQuery.js'
import { loadSdkSessionTranscript } from './sdkSessions.js'
import { resolveSessionFilePath } from './sessionStoragePortable.js'
import type { Message } from '../types/message.js'

class LocalSdkSession implements SDKSession {
  readonly #channel = new UserMessageChannel()
  readonly #query: ReturnType<typeof createSdkQuery>
  readonly #background: Promise<void>
  readonly #messages: SDKMessage[] = []
  #sessionId: string | undefined
  readonly #waiters = new Set<() => void>()
  #closed = false
  #error: unknown

  constructor(
    options: SDKSessionOptions,
    resume?: {
      id: string
      load: Promise<{ projectDir?: string; messages: Message[] }>
    },
  ) {
    this.#sessionId = resume?.id
    this.#query = createSdkQuery({
      prompt: this.#channel.iterate(),
      options: { model: options.model, env: options.env },
      ...(resume
        ? {
            session: {
              id: resume.id,
              projectDir: resume.load.then(result => result.projectDir),
            },
            initialMessages: resume.load.then(result => result.messages),
          }
        : {}),
    })
    this.#background = this.consume()
  }

  get sessionId(): string {
    if (!this.#sessionId) {
      throw new Error('Session ID is not available before the first message')
    }
    return this.#sessionId
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.#query) {
        if ('session_id' in message && message.session_id) {
          this.#sessionId = message.session_id
        }
        this.#messages.push(message)
        this.notify()
      }
    } catch (error) {
      this.#error = error
      this.notify()
    }
  }

  private notify(): void {
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }

  async send(message: string | SDKUserMessage): Promise<void> {
    if (this.#closed) throw new Error('Session is closed')
    this.#channel.push(
      typeof message === 'string'
        ? {
            type: 'user',
            message: { role: 'user', content: message },
            parent_tool_use_id: null,
            session_id: this.#sessionId ?? '',
            uuid: randomUUID(),
          }
        : message,
    )
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      const message = this.#messages.shift()
      if (message) {
        yield message
        if (message.type === 'result') return
        continue
      }
      if (this.#error !== undefined) throw this.#error
      if (this.#closed) return
      await new Promise<void>(resolve => this.#waiters.add(resolve))
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.notify()
    this.#channel.close()
    void this.#query.interrupt()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close()
    await this.#background
  }
}

export function createSdkSession(options: SDKSessionOptions): SDKSession {
  return new LocalSdkSession(options)
}

export function resumeSdkSession(
  sessionId: string,
  options: SDKSessionOptions,
): SDKSession {
  return new LocalSdkSession(options, {
    id: sessionId,
    load: (async () => {
      const resolved = await resolveSessionFilePath(sessionId)
      if (!resolved) throw new Error(`Session not found: ${sessionId}`)
      const messages = await loadSdkSessionTranscript(sessionId, {
        dir: resolved.projectPath,
      })
      return { projectDir: resolved.projectPath, messages }
    })(),
  })
}

export async function promptSdkSession(
  text: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  const session = createSdkSession(options)
  await session.send(text)
  try {
    for await (const message of session.stream()) {
      if (message.type === 'result') return message
    }
    throw new Error('Session ended without a result')
  } finally {
    await session[Symbol.asyncDispose]()
  }
}
