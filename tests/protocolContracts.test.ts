/**
 * Protocol Contracts Tests
 *
 * Tests sandbox/bridge/tool API offline contracts.
 * Does NOT test private service wire compatibility or credentials.
 * Tests REAL API paths from the actual source modules.
 */

import { describe, expect, test } from 'bun:test'
import {
  assertLoopbackCdpEndpoint,
  DEFAULT_OPEN_CHROME_CDP_ENDPOINT,
  createIsolatedBrowserConfig,
  createOpenChromeConfig,
  type OpenChromeContext,
} from '../src/external-stubs/claude-for-chrome-mcp.ts'
import {
  OpenRunnerError,
  invalidRequest,
  isUuid,
  assertUuid,
  assertInteger,
  assertRfc3339,
  validateRelativeCwd,
  normalizeWorkInput,
  errorResponse,
  OPEN_RUNNER_PROTOCOL,
  OPEN_RUNNER_API_PREFIX,
  MAX_PROMPT_BYTES,
  DEFAULT_LEASE_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  PERMISSION_MODES,
  WORK_STATES,
  newId,
  contentHash,
  canonicalJson,
} from '../src/open-runner/protocol.ts'

describe('Open Chrome Protocol Contracts', () => {
  test('assertLoopbackCdpEndpoint validates URLs correctly', () => {
    // Valid loopback endpoints
    expect(() => assertLoopbackCdpEndpoint('http://127.0.0.1:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('http://[::1]:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('ws://127.0.0.1:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('wss://[::1]:9222')).not.toThrow()

    // localhost is NOT allowed - only explicit loopback IPs
    expect(() => assertLoopbackCdpEndpoint('http://localhost:9222')).toThrow()
    expect(() => assertLoopbackCdpEndpoint('ws://localhost:9222/devtools/page/123')).toThrow()

    // Invalid non-loopback endpoints - should throw
    expect(() => assertLoopbackCdpEndpoint('http://0.0.0.0:9222')).toThrow()
    expect(() => assertLoopbackCdpEndpoint('http://192.168.1.1:9222')).toThrow()

    // Invalid with userinfo - should throw
    expect(() => assertLoopbackCdpEndpoint('http://user:pass@127.0.0.1:9222')).toThrow()

    // Invalid protocol - should throw
    expect(() => assertLoopbackCdpEndpoint('file://127.0.0.1:9222')).toThrow()

    // Invalid with query params - should throw
    expect(() => assertLoopbackCdpEndpoint('http://127.0.0.1:9222?foo=bar')).toThrow()
  })

  test('DEFAULT_OPEN_CHROME_CDP_ENDPOINT is valid', () => {
    expect(DEFAULT_OPEN_CHROME_CDP_ENDPOINT).toBe('http://127.0.0.1:9222')
    expect(() => assertLoopbackCdpEndpoint(DEFAULT_OPEN_CHROME_CDP_ENDPOINT)).not.toThrow()
  })
})

describe('Sandbox/Bridge API Contracts (Real Exports)', () => {
  test('createIsolatedBrowserConfig has correct shape', () => {
    const config = createIsolatedBrowserConfig()
    expect(config).toBeDefined()
    expect(config.browser).toBeDefined()
    expect(config.browser?.isolated).toBe(true)
  })

  test('createIsolatedBrowserConfig accepts allowedOrigins', () => {
    const config = createIsolatedBrowserConfig({ allowedOrigins: ['https://example.com'] })
    expect(config.network?.allowedOrigins).toEqual(['https://example.com'])
  })

  test('createOpenChromeConfig requires valid OpenChromeContext', () => {
    const validContext: OpenChromeContext = {
      kind: 'chrome-cdp',
      serverName: 'test-server',
      logger: {
        silly: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      cdpEndpoint: 'http://127.0.0.1:9222',
      cdpTimeoutMs: 30000,
      initialPermissionMode: 'ask',
      onToolCallDisconnected: () => 'disconnected',
      trackEvent: () => {},
    }

    // Valid context works
    expect(() => createOpenChromeConfig(validContext)).not.toThrow()

    // Invalid kind throws
    expect(() => createOpenChromeConfig({ ...validContext, kind: 'invalid' as any })).toThrow()

    // Non-loopback endpoint throws
    expect(() =>
      createOpenChromeConfig({ ...validContext, cdpEndpoint: 'http://localhost:9222' })
    ).toThrow()

    // Negative timeout throws
    expect(() => createOpenChromeConfig({ ...validContext, cdpTimeoutMs: -1 })).toThrow()

    // Private extension fields throw (socketPath)
    expect(() =>
      createOpenChromeConfig({ ...validContext, socketPath: '/tmp/socket' } as any)
    ).toThrow()

    // Private extension fields throw (bridgeConfig)
    expect(() =>
      createOpenChromeConfig({ ...validContext, bridgeConfig: {} } as any)
    ).toThrow()
  })

  test('createOpenChromeConfig returns correct shape', () => {
    const context: OpenChromeContext = {
      kind: 'chrome-cdp',
      serverName: 'test-server',
      logger: {
        silly: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      cdpEndpoint: 'http://127.0.0.1:9222',
      cdpTimeoutMs: 30000,
      initialPermissionMode: 'ask',
      onToolCallDisconnected: () => 'disconnected',
      trackEvent: () => {},
    }

    const config = createOpenChromeConfig(context)
    expect(config.browser?.browserName).toBe('chromium')
    expect(config.browser?.isolated).toBe(false)
    expect(config.browser?.cdpEndpoint).toBe('http://127.0.0.1:9222')
    expect(config.browser?.cdpTimeout).toBe(30000)
  })
})

describe('Open Runner Protocol Contracts (Real Exports)', () => {
  test('constants have correct values', () => {
    expect(OPEN_RUNNER_PROTOCOL).toBe('open-runner-v1')
    expect(OPEN_RUNNER_API_PREFIX).toBe('/open-runner/v1')
    expect(MAX_PROMPT_BYTES).toBe(256 * 1024)
    expect(DEFAULT_LEASE_MS).toBe(30_000)
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(10_000)
  })

  test('PERMISSION_MODES and WORK_STATES have expected values', () => {
    expect(PERMISSION_MODES).toEqual(['default', 'acceptEdits', 'plan'])
    expect(WORK_STATES).toEqual([
      'queued',
      'leased',
      'running',
      'retry_wait',
      'succeeded',
      'failed',
      'cancelled',
    ])
  })

  test('OpenRunnerError has correct shape', () => {
    const err = new OpenRunnerError('INVALID_REQUEST', 'test message', 400, true, { foo: 'bar' })
    expect(err.name).toBe('OpenRunnerError')
    expect(err.code).toBe('INVALID_REQUEST')
    expect(err.message).toBe('test message')
    expect(err.status).toBe(400)
    expect(err.retryable).toBe(true)
    expect(err.details).toEqual({ foo: 'bar' })
  })

  test('invalidRequest creates correct OpenRunnerError', () => {
    const err = invalidRequest('bad request')
    expect(err instanceof OpenRunnerError).toBe(true)
    expect(err.code).toBe('INVALID_REQUEST')
    expect(err.message).toBe('bad request')
    expect(err.status).toBe(400)
  })

  test('isUuid validates UUIDs correctly', () => {
    expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid(null as any)).toBe(false)
    expect(isUuid(undefined as any)).toBe(false)
  })

  test('assertUuid throws for invalid UUIDs', () => {
    expect(() => assertUuid('550e8400-e29b-41d4-a716-446655440000', 'test')).not.toThrow()
    expect(() => assertUuid('not-a-uuid', 'test')).toThrow()
  })

  test('assertInteger validates integers correctly', () => {
    expect(assertInteger(42, 'test', 0, 100)).toBe(42)
    expect(assertInteger(0, 'test', 0, 100)).toBe(0)
    expect(assertInteger(100, 'test', 0, 100)).toBe(100)
    expect(() => assertInteger(-1, 'test', 0, 100)).toThrow()
    expect(() => assertInteger(101, 'test', 0, 100)).toThrow()
    expect(() => assertInteger(3.14, 'test', 0, 100)).toThrow()
    expect(() => assertInteger('not-a-number' as any, 'test', 0, 100)).toThrow()
  })

  test('assertRfc3339 validates timestamps correctly', () => {
    expect(assertRfc3339('2024-01-01T00:00:00Z', 'test')).toBe('2024-01-01T00:00:00Z')
    expect(() => assertRfc3339('not-a-timestamp', 'test')).toThrow()
  })

  test('validateRelativeCwd validates paths correctly', () => {
    expect(validateRelativeCwd('.')).toBe('.')
    expect(validateRelativeCwd('subdir')).toBe('subdir')
    expect(validateRelativeCwd('./subdir')).toBe('subdir')
    expect(validateRelativeCwd('subdir/')).toBe('subdir')

    // Absolute paths rejected
    expect(() => validateRelativeCwd('/absolute/path')).toThrow()

    // Paths with .. rejected
    expect(() => validateRelativeCwd('../parent')).toThrow()

    // Windows paths rejected
    expect(() => validateRelativeCwd('C:\\Windows')).toThrow()

    // Empty string rejected
    expect(() => validateRelativeCwd('')).toThrow()
  })

  test('normalizeWorkInput validates and normalizes input', () => {
    // Valid minimal input
    const input = normalizeWorkInput({
      prompt: 'test prompt',
      cwd: '.',
    })
    expect(input.prompt).toBe('test prompt')
    expect(input.cwd).toBe('.')
    expect(input.permission_mode).toBe('default')

    // Valid full input
    const fullInput = normalizeWorkInput({
      prompt: 'test prompt',
      cwd: 'subdir',
      model: 'test-model',
      permission_mode: 'acceptEdits',
      session_id: '550e8400-e29b-41d4-a716-446655440000',
    })
    expect(fullInput.model).toBe('test-model')
    expect(fullInput.permission_mode).toBe('acceptEdits')
    expect(fullInput.session_id).toBe('550e8400-e29b-41d4-a716-446655440000')

    // Prompt too long
    expect(() =>
      normalizeWorkInput({
        prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1),
        cwd: '.',
      })
    ).toThrow()

    // Invalid permission mode
    expect(() =>
      normalizeWorkInput({
        prompt: 'test',
        cwd: '.',
        permission_mode: 'invalid',
      })
    ).toThrow()

    // Invalid session ID
    expect(() =>
      normalizeWorkInput({
        prompt: 'test',
        cwd: '.',
        session_id: 'not-a-uuid',
      })
    ).toThrow()
  })

  test('newId generates valid UUIDs', () => {
    const id1 = newId()
    const id2 = newId()
    expect(isUuid(id1)).toBe(true)
    expect(isUuid(id2)).toBe(true)
    expect(id1).not.toBe(id2)
  })

  test('canonicalJson produces consistent output', () => {
    const obj = { b: 2, a: 1 }
    const json1 = canonicalJson(obj)
    const json2 = canonicalJson({ a: 1, b: 2 })
    expect(json1).toBe(json2)
    expect(json1).toContain('"a":1')
    expect(json1).toContain('"b":2')
  })

  test('contentHash produces deterministic hashes', () => {
    const obj = { test: 'data' }
    const hash1 = contentHash(obj)
    const hash2 = contentHash({ test: 'data' })
    expect(hash1).toBe(hash2)
    expect(typeof hash1).toBe('string')
    expect(hash1.length).toBe(64) // SHA-256 is 64 hex chars
  })

  test('errorResponse returns correct shape', () => {
    const err = new OpenRunnerError('TEST_ERROR', 'test error', 400, true, { detail: 'value' })
    const resp = errorResponse(err, 'test-request-id')
    expect(resp.protocol).toBe('open-runner-v1')
    expect(resp.error.code).toBe('TEST_ERROR')
    expect(resp.error.message).toBe('test error')
    expect(resp.error.retryable).toBe(true)
    expect(resp.error.details).toEqual({ detail: 'value' })
    expect(resp.request_id).toBe('test-request-id')
  })

  test('errorResponse wraps non-OpenRunnerErrors', () => {
    const err = new Error('generic error')
    const resp = errorResponse(err)
    expect(resp.error.code).toBe('INTERNAL_ERROR')
    expect(resp.error.retryable).toBe(true)
  })
})

describe('Disabled/Stub Branch Contracts (Real API)', () => {
  test('no private extension fields exported', async () => {
    const moduleExports = await import('../src/external-stubs/claude-for-chrome-mcp.ts')
    const exportKeys = Object.keys(moduleExports)

    // Should NOT export any private APIs
    const privateClaims = exportKeys.filter(key =>
      key.toLowerCase().includes('socket') ||
      key.toLowerCase().includes('private') ||
      key.toLowerCase().includes('native') ||
      key.toLowerCase().includes('bridgeconfig')
    )
    expect(privateClaims).toHaveLength(0)
  })
})

describe('Tool API Error Shapes (Real Protocol)', () => {
  test('OpenRunnerError supports retryAfterMs', () => {
    const err = new OpenRunnerError(
      'RATE_LIMITED',
      'too many requests',
      429,
      true,
      { retryAfter: '10s' },
      'req-123',
      10000
    )
    expect(err.retryAfterMs).toBe(10000)
    expect(err.requestId).toBe('req-123')
  })
})

describe('Retry Pattern Contracts (Real Protocol)', () => {
  test('OpenRunnerError retryable flag works correctly', () => {
    const retryable = new OpenRunnerError('SERVICE_UNAVAILABLE', 'retry later', 503, true)
    expect(retryable.retryable).toBe(true)

    const notRetryable = new OpenRunnerError('PERMISSION_DENIED', 'no access', 403, false)
    expect(notRetryable.retryable).toBe(false)
  })
})
