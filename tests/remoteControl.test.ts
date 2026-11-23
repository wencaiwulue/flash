import '../src/runtimeMacros.js'
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  SessionsWebSocket,
  type SessionsWebSocketCallbacks,
} from '../src/remote/SessionsWebSocket.js'
import {
  RemoteSessionManager,
  type RemoteSessionCallbacks,
  type RemoteSessionConfig,
} from '../src/remote/RemoteSessionManager.js'
import {
  convertSDKMessage,
  isSessionEndMessage,
  isSuccessResult,
  getResultText,
} from '../src/remote/sdkMessageAdapter.js'
import type {
  SDKAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
  SDKMessage,
} from '../src/entrypoints/agentSdkTypes.js'

// --- Manual Timer Mock ---

interface Timer {
  id: number
  callback: () => void
  delay: number
  startTime: number
}

let currentTime = 0
let nextTimerId = 1
let timeouts: Map<number, Timer> = new Map()
let intervals: Map<number, Timer> = new Map()

const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval

function mockTimers() {
  currentTime = 0
  nextTimerId = 1
  timeouts.clear()
  intervals.clear()

  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const id = nextTimerId++
    timeouts.set(id, { id, callback, delay: delay || 0, startTime: currentTime })
    return id as unknown as NodeJS.Timeout
  }) as unknown as typeof setTimeout

  globalThis.clearTimeout = ((id: NodeJS.Timeout) => {
    timeouts.delete(id as unknown as number)
  }) as unknown as typeof clearTimeout

  globalThis.setInterval = ((callback: () => void, delay: number) => {
    const id = nextTimerId++
    intervals.set(id, { id, callback, delay: delay || 0, startTime: currentTime })
    return id as unknown as NodeJS.Timeout
  }) as unknown as typeof setInterval

  globalThis.clearInterval = ((id: NodeJS.Timeout) => {
    intervals.delete(id as unknown as number)
  }) as unknown as typeof clearInterval
}

function restoreTimers() {
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
}

function advanceTimersBy(ms: number) {
  const targetTime = currentTime + ms

  while (true) {
    const nextTimeout = Array.from(timeouts.values()).sort(
      (a, b) => (a.startTime + a.delay) - (b.startTime + b.delay)
    )[0]

    if (!nextTimeout || nextTimeout.startTime + nextTimeout.delay > targetTime) {
      break
    }

    timeouts.delete(nextTimeout.id)
    currentTime = nextTimeout.startTime + nextTimeout.delay
    nextTimeout.callback()
  }

  currentTime = targetTime
}

// --- Mock WebSocket ---

class MockWebSocket {
  readyState = 0 // CONNECTING
  sentData: string[] = []
  closed = false
  closeCode?: number
  closeReason?: string
  url: string
  options: unknown
  private listeners: Record<string, Set<(...args: unknown[]) => void>> = {}

  constructor(url: string, options: unknown) {
    this.url = url
    this.options = options
    mockWebSocketInstances.push(this)
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void) {
    if (!this.listeners[type]) {
      this.listeners[type] = new Set()
    }
    this.listeners[type].add(listener)
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void) {
    this.listeners[type]?.delete(listener)
  }

  on(type: string, listener: (...args: unknown[]) => void) {
    this.addEventListener(type, listener)
  }

  off(type: string, listener: (...args: unknown[]) => void) {
    this.removeEventListener(type, listener)
  }

  private emit(type: string, ...args: unknown[]) {
    if (this.listeners[type]) {
      for (const listener of this.listeners[type]) {
        listener(...args)
      }
    }
  }

  send(data: string) {
    this.sentData.push(data)
  }

  close(code?: number, reason?: string) {
    this.closed = true
    this.closeCode = code
    this.closeReason = reason
    this.readyState = 3 // CLOSED
    this.emit('close', { code: code ?? 1000, reason: reason ?? '' })
  }

  ping() {
    this.emit('pong')
  }

  simulateOpen() {
    this.readyState = 1 // OPEN
    this.emit('open')
  }

  simulateMessage(data: string) {
    this.emit('message', { data })
  }

  simulateError(error?: Error) {
    this.emit('error', error ?? new Error('WebSocket error'))
  }

  simulateClose(code: number, reason = '') {
    this.readyState = 3
    this.emit('close', { code, reason })
  }
}

let mockWebSocketInstances: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket
globalThis.WebSocket = function (...args: unknown[]) {
  return new MockWebSocket(args[0] as string, args[1]) as unknown as WebSocket
} as unknown as typeof WebSocket

// --- Mock other dependencies ---

mock.module('../src/utils/proxy.js', () => ({
  getWebSocketProxyUrl: () => undefined,
  getWebSocketProxyAgent: () => undefined,
}))

mock.module('../src/utils/mtls.js', () => ({
  getWebSocketTLSOptions: () => undefined,
}))

mock.module('../src/constants/oauth.js', () => ({
  getOauthConfig: () => ({
    BASE_API_URL: 'https://api.anthropic.com',
  }),
}))

mock.module('ws', () => MockWebSocket)

// --- Tests for sdkMessageAdapter ---

describe('sdkMessageAdapter', () => {
  test('convertSDKMessage converts assistant message completely', () => {
    const msgId = 'msg_test123'
    const model = 'claude-3-opus'
    const uuid = crypto.randomUUID()
    const msg: SDKAssistantMessage = {
      type: 'assistant',
      message: {
        type: 'message',
        role: 'assistant',
        id: msgId,
        model,
        content: [
          { type: 'text', text: 'Hello, how can I help?' },
        ],
      },
      uuid,
    } as const

    const result = convertSDKMessage(msg)
    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('assistant')
      expect(result.message.uuid).toBe(uuid)
      if ('message' in result.message && typeof result.message.message === 'object') {
        const inner = result.message.message as { id: string; model: string }
        expect(inner.id).toBe(msgId)
        expect(inner.model).toBe(model)
      }
    }
  })

  test('convertSDKMessage converts system init message completely', () => {
    const uuid = crypto.randomUUID()
    const model = 'claude-3-opus'
    const msg: SDKSystemMessage = {
      type: 'system',
      subtype: 'init',
      model,
      uuid,
    } as const

    const result = convertSDKMessage(msg)
    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('system')
      expect(result.message.uuid).toBe(uuid)
      expect('subtype' in result.message && result.message.subtype).toBe('informational')
      expect('content' in result.message && typeof result.message.content).toBe('string')
    }
  })

  test('convertSDKMessage converts system compact boundary message completely', () => {
    const uuid = crypto.randomUUID()
    const msg: SDKSystemMessage = {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        summary_start_idx: 100,
        summary_end_idx: 200,
        last_idx: 250,
      },
      uuid,
    } as const

    const result = convertSDKMessage(msg)
    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('system')
      expect(result.message.uuid).toBe(uuid)
      expect('subtype' in result.message && result.message.subtype).toBe('compact_boundary')
    }
  })

  test('convertSDKMessage converts error result message completely', () => {
    const uuid = crypto.randomUUID()
    const errorMsg = 'Something went wrong'
    const msg: SDKResultMessage = {
      type: 'result',
      subtype: 'error',
      errors: [errorMsg],
      uuid,
    } as const

    const result = convertSDKMessage(msg)
    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('system')
      expect(result.message.uuid).toBe(uuid)
      expect('level' in result.message && result.message.level).toBe('warning')
      expect('content' in result.message && typeof result.message.content).toBe('string')
    }
  })

  test('convertSDKMessage ignores success result message', () => {
    const uuid = crypto.randomUUID()
    const msg: SDKResultMessage = {
      type: 'result',
      subtype: 'success',
      result: 'Done',
      uuid,
    } as const

    const result = convertSDKMessage(msg)
    expect(result.type).toBe('ignored')
  })

  test('convertSDKMessage converts tool progress message completely', () => {
    const uuid = crypto.randomUUID()
    const toolName = 'write_to_file'
    const elapsed = 2
    const toolUseId = 'toolu_123'
    const msg: SDKToolProgressMessage = {
      type: 'tool_progress',
      tool_name: toolName,
      elapsed_time_seconds: elapsed,
      tool_use_id: toolUseId,
      uuid,
    } as const

    const result = convertSDKMessage(msg)
    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('system')
      expect(result.message.uuid).toBe(uuid)
      expect('toolUseID' in result.message && result.message.toolUseID).toBe(toolUseId)
    }
  })

  test('convertSDKMessage ignores auth_status message', () => {
    const msg = { type: 'auth_status', status: 'ok' } as const
    const result = convertSDKMessage(msg as unknown as SDKMessage)
    expect(result.type).toBe('ignored')
  })

  test('convertSDKMessage ignores unknown message types', () => {
    const msg = { type: 'some_unknown_type' } as const
    const result = convertSDKMessage(msg as unknown as SDKMessage)
    expect(result.type).toBe('ignored')
  })

  test('isSessionEndMessage detects result messages', () => {
    expect(isSessionEndMessage({ type: 'result' } as unknown as SDKMessage)).toBe(true)
    expect(isSessionEndMessage({ type: 'assistant' } as unknown as SDKMessage)).toBe(false)
    expect(isSessionEndMessage({ type: 'system' } as unknown as SDKMessage)).toBe(false)
  })

  test('isSuccessResult correctly identifies success vs error', () => {
    expect(isSuccessResult({ type: 'result', subtype: 'success' } as unknown as SDKResultMessage)).toBe(true)
    expect(isSuccessResult({ type: 'result', subtype: 'error' } as unknown as SDKResultMessage)).toBe(false)
  })

  test('getResultText extracts result text correctly', () => {
    expect(getResultText({ type: 'result', subtype: 'success', result: 'all done' } as unknown as SDKResultMessage)).toBe('all done')
    expect(getResultText({ type: 'result', subtype: 'error' } as unknown as SDKResultMessage)).toBeNull()
  })

  test('convertSDKMessage converts user message with convertToolResults', () => {
    const uuid = crypto.randomUUID()
    const timestamp = '2024-01-01T00:00:00Z'
    const msg: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_123', content: 'Result content' },
        ],
      },
      uuid,
      timestamp,
    } as const

    const result = convertSDKMessage(msg, { convertToolResults: true })
    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('user')
      expect(result.message.uuid).toBe(uuid)
    }
  })

  test('convertSDKMessage converts user text message with convertUserTextMessages', () => {
    const uuid = crypto.randomUUID()
    const timestamp = '2024-01-01T00:00:00Z'
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: 'Hello, world' },
      uuid,
      timestamp,
    } as const

    const result = convertSDKMessage(msg, { convertUserTextMessages: true })
    expect(result.type).toBe('message')
    if (result.type === 'message') {
      expect(result.message.type).toBe('user')
      expect(result.message.uuid).toBe(uuid)
    }
  })
})

// --- Tests for SessionsWebSocket ---

describe('SessionsWebSocket', () => {
  beforeEach(() => {
    mockWebSocketInstances = []
    mockTimers()
  })

  afterEach(() => {
    restoreTimers()
  })

  test('connects and calls onConnected, starts ping interval', async () => {
    const onConnected = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected,
      onClose: mock(() => {}),
      onError: mock(() => {}),
      onReconnecting: mock(() => {}),
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    void ws.connect()
    // Simulate WebSocket opening
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))

    expect(onConnected).toHaveBeenCalledTimes(1)
    expect(ws.isConnected()).toBe(true)
  })

  test('forwards messages to onMessage callback', async () => {
    const receivedMessages: unknown[] = []
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: (msg: unknown) => receivedMessages.push(msg),
      onConnected: mock(() => {}),
      onClose: mock(() => {}),
      onError: mock(() => {}),
      onReconnecting: mock(() => {}),
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))

    const testMessage = { type: 'assistant', message: { content: [] } }
    mockWebSocketInstances[0].simulateMessage(JSON.stringify(testMessage))

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]).toEqual(testMessage)
  })

  test('4003 (unauthorized) is permanent failure, no reconnect', async () => {
    const onClose = mock(() => {})
    const onReconnecting = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected: mock(() => {}),
      onClose,
      onError: mock(() => {}),
      onReconnecting,
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))

    mockWebSocketInstances[0].simulateClose(4003, 'Unauthorized')

    expect(onReconnecting).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(ws.isConnected()).toBe(false)
  })

  test('close() cleans up WebSocket and pending reconnect', async () => {
    const onClose = mock(() => {})
    const onReconnecting = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected: mock(() => {}),
      onClose,
      onError: mock(() => {}),
      onReconnecting,
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))

    // Close while connected
    ws.close()

    expect(mockWebSocketInstances[0].closed).toBe(true)
    expect(ws.isConnected()).toBe(false)
  })

  test('normal close calls onReconnecting and schedules reconnect with 2000ms delay', async () => {
    const onReconnecting = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected: mock(() => {}),
      onClose: mock(() => {}),
      onError: mock(() => {}),
      onReconnecting,
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))

    mockWebSocketInstances[0].simulateClose(1000, 'Normal closure')

    expect(onReconnecting).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(1)
    const timeout = Array.from(timeouts.values())[0]
    expect(timeout.delay).toBe(2000)
  })

  test('normal reconnect exhausts MAX_RECONNECT_ATTEMPTS=5 and calls onClose', async () => {
    const onReconnecting = mock(() => {})
    const onConnected = mock(() => {})
    const onClose = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected,
      onClose,
      onError: mock(() => {}),
      onReconnecting,
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    // First connection succeeds
    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    expect(onConnected).toHaveBeenCalledTimes(1)

    // First close triggers reconnect 1
    onReconnecting.mockClear()
    mockWebSocketInstances[0].simulateClose(1000, 'Normal closure')
    expect(onReconnecting).toHaveBeenCalledTimes(1)

    // Now drive all 5 reconnect attempts, each time closing without opening
    for (let attempt = 1; attempt <= 5; attempt++) {
      const instanceCountBefore = mockWebSocketInstances.length
      advanceTimersBy(2000)
      await new Promise(resolve => originalSetTimeout(resolve, 0))

      // Strict: new socket must exist for every attempt except the final exhaustion
      if (attempt <= 5) {
        expect(mockWebSocketInstances.length).toBe(instanceCountBefore + 1)
        mockWebSocketInstances[mockWebSocketInstances.length - 1].simulateClose(1000, 'Connection failed')
        await new Promise(resolve => originalSetTimeout(resolve, 0))
      }
    }

    // Strict: exactly 5 onReconnecting calls (initial + 4 more)
    expect(onReconnecting).toHaveBeenCalledTimes(5)
    // Strict: exactly 6 WebSocket instances (initial + 5 reconnect attempts)
    expect(mockWebSocketInstances.length).toBe(6)
    // After 5 attempts, final onClose should be called exactly once
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(0)
  })

  test('4001 uses MAX_SESSION_NOT_FOUND_RETRIES=3 with increasing delays', async () => {
    const onReconnecting = mock(() => {})
    const onConnected = mock(() => {})
    const onClose = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected,
      onClose,
      onError: mock(() => {}),
      onReconnecting,
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    // First connection
    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    expect(onConnected).toHaveBeenCalledTimes(1)

    // First 4001
    mockWebSocketInstances[0].simulateClose(4001, 'Session not found')
    expect(onReconnecting).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(1)
    expect(Array.from(timeouts.values())[0].delay).toBe(2000 * 1)

    // Attempt 1
    advanceTimersBy(2000)
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    if (mockWebSocketInstances.length > 1) {
      mockWebSocketInstances[1].simulateClose(4001, 'Session not found')
      await new Promise(resolve => originalSetTimeout(resolve, 0))
    }
    expect(onReconnecting).toHaveBeenCalledTimes(2)
    expect(timeouts.size).toBe(1)
    expect(Array.from(timeouts.values())[0].delay).toBe(2000 * 2)

    // Attempt 2
    advanceTimersBy(4000)
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    if (mockWebSocketInstances.length > 2) {
      mockWebSocketInstances[2].simulateClose(4001, 'Session not found')
      await new Promise(resolve => originalSetTimeout(resolve, 0))
    }
    expect(onReconnecting).toHaveBeenCalledTimes(3)
    expect(timeouts.size).toBe(1)
    expect(Array.from(timeouts.values())[0].delay).toBe(2000 * 3)

    // Attempt 3 - final
    advanceTimersBy(6000)
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    if (mockWebSocketInstances.length > 3) {
      mockWebSocketInstances[3].simulateClose(4001, 'Session not found')
      await new Promise(resolve => originalSetTimeout(resolve, 0))
    }

    // After 3 attempts, final onClose
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(0)
  })

  test('4001 counter resets after successful reconnect', async () => {
    const onReconnecting = mock(() => {})
    const onConnected = mock(() => {})
    const onClose = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected,
      onClose,
      onError: mock(() => {}),
      onReconnecting,
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    onConnected.mockClear()

    // First 4001
    mockWebSocketInstances[0].simulateClose(4001, 'Session not found')
    expect(onReconnecting).toHaveBeenCalledTimes(1)
    expect(timeouts.size).toBe(1)
    expect(Array.from(timeouts.values())[0].delay).toBe(2000 * 1)

    // Allow reconnect to succeed
    advanceTimersBy(2000)
    expect(mockWebSocketInstances.length).toBe(2)
    mockWebSocketInstances[1].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    expect(onConnected).toHaveBeenCalledTimes(1)

    // Next 4001 should start at 2000ms again
    onReconnecting.mockClear()
    mockWebSocketInstances[1].simulateClose(4001, 'Session not found')
    expect(timeouts.size).toBe(1)
    expect(Array.from(timeouts.values())[0].delay).toBe(2000 * 1)
  })

  test('reconnect() forces reconnect with 500ms delay', async () => {
    const onConnected = mock(() => {})
    const callbacks: SessionsWebSocketCallbacks = {
      onMessage: mock(() => {}),
      onConnected,
      onClose: mock(() => {}),
      onError: mock(() => {}),
      onReconnecting: mock(() => {}),
    }

    const ws = new SessionsWebSocket(
      'test-session-id',
      'test-org-uuid',
      () => 'test-token',
      callbacks,
    )

    void ws.connect()
    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    expect(onConnected).toHaveBeenCalledTimes(1)
    onConnected.mockClear()

    ws.reconnect()

    expect(timeouts.size).toBe(1)
    expect(Array.from(timeouts.values())[0].delay).toBe(500)

    advanceTimersBy(500)
    expect(mockWebSocketInstances.length).toBe(2)
    mockWebSocketInstances[1].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))
    expect(onConnected).toHaveBeenCalledTimes(1)
  })
})

// --- Tests for RemoteSessionManager onClose mapping ---

describe('RemoteSessionManager', () => {
  beforeEach(() => {
    mockWebSocketInstances = []
    mockTimers()
  })

  afterEach(() => {
    restoreTimers()
  })

  test('SessionsWebSocket onClose maps to RemoteSessionManager onDisconnected', async () => {
    const onDisconnected = mock(() => {})
    const onReconnecting = mock(() => {})
    const config: RemoteSessionConfig = {
      sessionId: 'test-session',
      getAccessToken: () => 'token',
      orgUuid: 'org-uuid',
    }
    const callbacks: RemoteSessionCallbacks = {
      onMessage: mock(() => {}),
      onPermissionRequest: mock(() => {}),
      onDisconnected,
      onReconnecting,
    }

    const manager = new RemoteSessionManager(config, callbacks)
    manager.connect()

    expect(mockWebSocketInstances.length).toBe(1)
    mockWebSocketInstances[0].simulateOpen()
    await new Promise(resolve => originalSetTimeout(resolve, 0))

    // Verify mapping with permanent failure (no reconnect)
    mockWebSocketInstances[0].simulateClose(4003, 'Unauthorized')

    expect(onDisconnected).toHaveBeenCalledTimes(1)
  })
})

// --- Restore original globals ---

afterAll(() => {
  globalThis.WebSocket = originalWebSocket
  restoreTimers()
})
