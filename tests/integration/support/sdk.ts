import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  SDKMessage,
  SDKResultSuccess,
  SDKUserMessage,
} from '../../../src/entrypoints/sdk/coreTypes.js'
import type {
  Options,
  Query,
} from '../../../src/entrypoints/sdk/runtimeTypes.js'
import { distSdkPath } from './dist-fixture.ts'
import {
  createMockAnthropic,
  MOCK_API_KEY,
  type MockAnthropic,
} from './mock-anthropic.ts'
import {
  createSandbox,
  type Sandbox,
  type SandboxOptions,
} from './sandbox.ts'

export type DistSdk = typeof import('../../../src/entrypoints/agentSdkTypes.js')
export type { MockAnthropic, Sandbox }

const DEFAULT_TIMEOUT_MS = 15_000

export async function loadDistSdk(): Promise<DistSdk> {
  const sdkPath = await distSdkPath()
  return import(pathToFileURL(sdkPath).href) as Promise<DistSdk>
}

export function userMessage(
  content: SDKUserMessage['message']['content'],
  sessionId = '',
): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  }
}

export interface UserInput {
  input: AsyncGenerator<SDKUserMessage, void>
  push(message: SDKUserMessage): void
  close(): void
  fail(error: unknown): void
}

export function createUserInput(): UserInput {
  const queue: SDKUserMessage[] = []
  const waiters: Array<{ resolve(): void; reject(error: unknown): void }> = []
  let closed = false
  let failure: unknown
  let failed = false

  const notify = () => {
    for (const waiter of waiters.splice(0)) {
      if (failed) waiter.reject(failure)
      else waiter.resolve()
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    notify()
  }
  async function* iterate(): AsyncGenerator<SDKUserMessage, void> {
    try {
      while (true) {
        if (failed) throw failure
        const message = queue.shift()
        if (message) {
          yield message
          continue
        }
        if (closed) return
        await new Promise<void>((resolve, reject) => {
          waiters.push({ resolve, reject })
        })
      }
    } finally {
      close()
    }
  }

  return {
    input: iterate(),
    push(message) {
      if (closed) throw new Error('Cannot push SDK input after close')
      queue.push(message)
      notify()
    },
    close,
    fail(error) {
      if (failed) return
      failed = true
      failure = error
      close()
    },
  }
}

export async function withDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms: ${label}`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remaining = Math.max(1, deadline - Date.now())
    const value = await withDeadline(
      Promise.resolve().then(predicate),
      'SDK condition predicate',
      remaining,
    )
    if (value) return value
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for SDK condition`)
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)))
  }
}

async function collectMessages(
  query: Query,
  timeoutMs: number,
): Promise<{ messages: SDKMessage[]; error: unknown }> {
  const messages: SDKMessage[] = []
  let error: unknown
  const deadline = Date.now() + timeoutMs
  try {
    while (true) {
      const next = await withDeadline(
        query.next(),
        'SDK query collection',
        Math.max(1, deadline - Date.now()),
      )
      if (next.done) break
      messages.push(next.value)
    }
  } catch (caught) {
    error = caught
  }
  return { messages, error }
}

export async function pauseAtResult(
  query: Query,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ messages: SDKMessage[]; result: SDKResultSuccess }> {
  const messages: SDKMessage[] = []
  const deadline = Date.now() + timeoutMs
  while (true) {
    const next = await withDeadline(
      query.next(),
      'SDK success result',
      Math.max(1, deadline - Date.now()),
    )
    if (next.done) throw new Error('SDK query ended before a success result')
    messages.push(next.value)
    if (next.value.type === 'result' && next.value.subtype === 'success') {
      return { messages, result: next.value }
    }
  }
}

export interface SdkHarness {
  sdk: DistSdk
  sandbox: Sandbox
  mock: MockAnthropic
  baseOptions: Options
  track<T extends Query>(query: T): T
  collect(query: Query, timeoutMs?: number): Promise<{ messages: SDKMessage[]; error: unknown }>
  waitFor<T>(predicate: () => T | Promise<T>, timeoutMs?: number): Promise<T>
  cleanup(): Promise<void>
}

export async function createSdkHarness(
  sandboxOptions: SandboxOptions = {},
): Promise<SdkHarness> {
  const sandbox = await createSandbox(sandboxOptions)
  let mock: MockAnthropic
  try {
    mock = await createMockAnthropic()
  } catch (error) {
    await sandbox.cleanup()
    throw error
  }

  const env: NonNullable<Options['env']> = { ...sandbox.env }
  // The in-process SDK applies only keys present in options.env. Explicitly
  // remove inherited API/config keys so it cannot fall back to real credentials.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) {
      env[key] = undefined
    }
  }
  Object.assign(env, {
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    CLAUDE_CONFIG_DIR: join(sandbox.home, '.claude'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_API_KEY: MOCK_API_KEY,
    ANTHROPIC_BASE_URL: mock.url,
    NODE_ENV: 'production',
    USER_TYPE: undefined,
    FORCE_VCR: undefined,
    VCR_RECORD: undefined,
    CLAUDE_CODE_TEST_FIXTURE_ROOT: undefined,
  })
  const baseOptions: Options = { cwd: sandbox.project, env }

  const previousEnv = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) previousEnv.set(key, process.env[key])
  const restoreEnv = () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const applyOfflineEnv = () => {
    for (const key of Object.keys(env)) {
      if (
        key === 'HOME' ||
        key === 'USERPROFILE' ||
        key === 'NODE_ENV' ||
        key === 'USER_TYPE' ||
        key === 'FORCE_VCR' ||
        key === 'VCR_RECORD' ||
        key.startsWith('ANTHROPIC_') ||
        key.startsWith('CLAUDE_')
      ) {
        const value = env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  const queries = new Set<Query>()
  let cleanupPromise: Promise<void> | undefined
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      const errors: unknown[] = []
      try {
        for (const query of queries) {
          try {
            if ('close' in query && typeof query.close === 'function') {
              await query.close('SDK integration harness cleanup')
            } else {
              await query.return(undefined)
            }
          } catch (error) {
            errors.push(error)
          }
        }
        queries.clear()
        try {
          await mock.stop()
        } catch (error) {
          errors.push(error)
        }
        try {
          await sandbox.cleanup()
        } catch (error) {
          errors.push(error)
        }
      } finally {
        restoreEnv()
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'SDK integration harness cleanup failed')
      }
    })()
    return cleanupPromise
  }

  try {
    applyOfflineEnv()
    const sdk = await loadDistSdk()
    return {
      sdk,
      sandbox,
      mock,
      baseOptions,
      track<T extends Query>(query: T): T {
        queries.add(query)
        return query
      },
      collect: (query, timeoutMs = DEFAULT_TIMEOUT_MS) => collectMessages(query, timeoutMs),
      waitFor,
      cleanup,
    }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
