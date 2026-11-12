import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'

const connect = mock((_options: unknown) => {})
const logForDebugging = mock((_message: string, _options?: unknown) => {})

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = []
  readonly url: string

  constructor(url: string) {
    super()
    this.url = url
    FakeWebSocket.instances.push(this)
  }
}

mock.module('react-devtools-core', () => ({ connectToDevTools: connect }))
mock.module('ws', () => ({ default: FakeWebSocket }))
mock.module('../src/utils/debug.ts', () => ({ logForDebugging }))

const { connectToDevTools } = await import('../src/ink/devtools.ts')
const originalNodeEnv = process.env.NODE_ENV

beforeEach(() => {
  connect.mockClear()
  logForDebugging.mockClear()
  FakeWebSocket.instances = []
  process.env.NODE_ENV = 'development'
})

afterAll(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  mock.restore()
})

describe('Ink React DevTools connection', () => {
  test('really calls react-devtools-core in development', () => {
    connectToDevTools()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://localhost:8097')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect.mock.calls[0]?.[0]).toMatchObject({
      websocket: FakeWebSocket.instances[0],
      retryConnectionDelay: 2000,
    })
  })

  test('reports refused connections with an actionable debug diagnostic', () => {
    connectToDevTools()
    expect(() =>
      FakeWebSocket.instances[0]?.emit(
        'error',
        new Error('connect ECONNREFUSED'),
      ),
    ).not.toThrow()
    expect(logForDebugging).toHaveBeenCalledTimes(1)
    expect(logForDebugging.mock.calls[0]?.[0]).toContain(
      'npx react-devtools',
    )
  })

  test('contains synchronous initialization failures', () => {
    connect.mockImplementationOnce(() => {
      throw new Error('connection rejected')
    })
    expect(() => connectToDevTools()).not.toThrow()
    expect(logForDebugging.mock.calls[0]?.[0]).toContain(
      'connection rejected',
    )
  })

  test('does not connect in production and reconciler retains a dev-only dynamic import', async () => {
    process.env.NODE_ENV = 'production'
    connectToDevTools()
    expect(connect).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)

    const reconciler = await readFile(
      new URL('../src/ink/reconciler.ts', import.meta.url),
      'utf8',
    )
    expect(reconciler).toContain(
      "if (process.env.NODE_ENV === 'development')",
    )
    expect(reconciler).toContain("void import('./devtools.js')")
    expect(reconciler).toContain('.catch((error: unknown) =>')
  })
})
