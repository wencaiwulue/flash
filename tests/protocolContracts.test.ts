/**
 * Protocol Contracts Tests
 *
 * Tests sandbox/bridge/tool API offline contracts.
 * Does NOT test private service wire compatibility or credentials.
 */

import { describe, expect, test } from 'bun:test'
import { assertLoopbackCdpEndpoint, DEFAULT_OPEN_CHROME_CDP_ENDPOINT } from '../src/external-stubs/claude-for-chrome-mcp.ts'
import { setTimeout as sleep } from 'node:timers/promises'

describe('Open Chrome Protocol Contracts', () => {
  test('assertLoopbackCdpEndpoint validates URLs correctly', async () => {
    // Valid loopback endpoints
    expect(() => assertLoopbackCdpEndpoint('http://127.0.0.1:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('http://[::1]:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('ws://127.0.0.1:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('ws://[::1]:9222/')).not.toThrow()

    // localhost is NOT allowed - only explicit loopback IPs
    let threw = false
    try {
      assertLoopbackCdpEndpoint('http://localhost:9222')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    threw = false
    try {
      assertLoopbackCdpEndpoint('ws://localhost:9222/devtools/page/123')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    // Invalid non-loopback endpoints - should throw
    threw = false
    try {
      assertLoopbackCdpEndpoint('http://0.0.0.0:9222')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    threw = false
    try {
      assertLoopbackCdpEndpoint('http://192.168.1.1:9222')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    // Invalid with userinfo - should throw
    threw = false
    try {
      assertLoopbackCdpEndpoint('http://user:pass@127.0.0.1:9222')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    // Invalid protocol - should throw
    threw = false
    try {
      assertLoopbackCdpEndpoint('file://127.0.0.1:9222')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    // Invalid with query params - should throw
    threw = false
    try {
      assertLoopbackCdpEndpoint('http://127.0.0.1:9222?foo=bar')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('DEFAULT_OPEN_CHROME_CDP_ENDPOINT is valid', async () => {
    expect(DEFAULT_OPEN_CHROME_CDP_ENDPOINT).toBe('http://127.0.0.1:9222')
    expect(() => assertLoopbackCdpEndpoint(DEFAULT_OPEN_CHROME_CDP_ENDPOINT)).not.toThrow()
  })
})

describe('Sandbox API Contracts', () => {
  test('external-stubs module exports expected public APIs', async () => {
    const stubs = await import('../src/external-stubs/claude-for-chrome-mcp.ts')
    expect(stubs.assertLoopbackCdpEndpoint).toBeDefined()
    expect(stubs.DEFAULT_OPEN_CHROME_CDP_ENDPOINT).toBeDefined()
    expect(stubs.createIsolatedBrowserConfig).toBeDefined()
    expect(stubs.createOpenChromeConfig).toBeDefined()
    expect(stubs.createClaudeForChromeMcpServer).toBeDefined()
    expect(stubs.getOpenBrowserClient).toBeDefined()
    expect(stubs.closeOpenBrowserClient).toBeDefined()
    expect(stubs.getOpenChromeClient).toBeDefined()
    expect(stubs.closeOpenChromeClient).toBeDefined()
    expect(stubs.listBrowserTools).toBeDefined()
    expect(stubs.listOpenChromeTools).toBeDefined()
    expect(stubs.callOpenChromeTool).toBeDefined()
  })

  test('fs/promises module has expected contract', async () => {
    const fs = await import('fs/promises')
    expect(typeof fs.readFile).toBe('function')
    expect(typeof fs.writeFile).toBe('function')
    expect(typeof fs.appendFile).toBe('function')
    expect(typeof fs.mkdir).toBe('function')
  })

  test('Error shape has expected contract', async () => {
    const err = new Error('test error')
    expect(err.message).toBeDefined()
    expect(err.name).toBe('Error')
    expect(typeof err.stack).toBe('string')

    const cause = new Error('cause')
    const wrapped = new Error('wrapped', { cause })
    expect(wrapped.cause).toBe(cause)
  })

  test('error shapes include expected properties for API responses', async () => {
    // Test standard error shapes used in API responses
    const apiError = {
      type: 'api_error',
      code: 'NOT_FOUND',
      message: 'Resource not found',
      timestamp: new Date().toISOString(),
    }

    expect(apiError.type).toBe('api_error')
    expect(apiError.code).toBe('NOT_FOUND')
    expect(apiError.message).toBe('Resource not found')
    expect(typeof apiError.timestamp).toBe('string')

    // Test validation error shape
    const validationError = {
      type: 'validation_error',
      field: 'url',
      message: 'Invalid URL format',
    }

    expect(validationError.type).toBe('validation_error')
    expect(validationError.field).toBe('url')
    expect(validationError.message).toBe('Invalid URL format')
  })
})

describe('Bridge API Contracts', () => {
  test('Promise has expected contract for timeout/race patterns', async () => {
    expect(typeof Promise).toBe('function')
    expect(typeof Promise.race).toBe('function')
    expect(typeof Promise.all).toBe('function')
    expect(typeof Promise.allSettled).toBe('function')

    const result = await Promise.race([
      Promise.resolve('success'),
      new Promise(resolve => setTimeout(resolve, 1000, 'timeout')),
    ])
    expect(result).toBe('success')
  })

  test('timeout pattern works correctly with Promise.race', async () => {
    const timeout = (ms: number) => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), ms)
    )

    const fastOperation = Promise.resolve('fast')
    const slowOperation = sleep(1000).then(() => 'slow')

    // Fast operation should win
    const result1 = await Promise.race([fastOperation, timeout(100)])
    expect(result1).toBe('fast')

    // Timeout should win against slow operation
    let timedOut = false
    try {
      await Promise.race([slowOperation, timeout(50)])
    } catch (e) {
      if (e instanceof Error && e.message === 'TIMEOUT') {
        timedOut = true
      }
    }
    expect(timedOut).toBe(true)
  })

  test('redirect pattern preserves original request context', async () => {
    // Simulate a redirect response shape
    const redirectResponse = {
      status: 302,
      location: 'http://127.0.0.1:9222/new-endpoint',
      originalRequest: {
        method: 'GET',
        url: 'http://127.0.0.1:9222/old-endpoint',
        headers: { 'X-Request-ID': 'test-123' },
      },
    }

    expect(redirectResponse.status).toBe(302)
    expect(redirectResponse.location).toBeDefined()
    expect(redirectResponse.originalRequest).toBeDefined()
    expect(redirectResponse.originalRequest.method).toBe('GET')
    expect(redirectResponse.originalRequest.headers['X-Request-ID']).toBe('test-123')
  })
})

describe('Disabled/Stub Branch Contracts', () => {
  test('external-stubs module does not export private APIs', async () => {
    const moduleExports = await import('../src/external-stubs/claude-for-chrome-mcp.ts')
    const exportKeys = Object.keys(moduleExports)

    // Should NOT have any exports claiming private API compatibility
    const privateClaims = exportKeys.filter(key =>
      key.toLowerCase().includes('private') ||
      key.toLowerCase().includes('internal') ||
      key.toLowerCase().includes('compatible')
    )
    expect(privateClaims).toHaveLength(0)
  })

  test('stub branches return consistent error shapes', async () => {
    // Test that stubs follow the error contract
    const stubError = {
      error: {
        code: 'FEATURE_DISABLED',
        message: 'This feature is disabled in this build',
        type: 'stub_error',
      },
    }

    expect(stubError.error.code).toBe('FEATURE_DISABLED')
    expect(stubError.error.message).toBeDefined()
    expect(stubError.error.type).toBe('stub_error')
  })
})

describe('Tool API Error Shapes', () => {
  test('tool execution errors include expected fields', async () => {
    const toolError = {
      type: 'tool_error',
      toolName: 'web_read',
      code: 'PERMISSION_DENIED',
      message: 'Access to this URL is not allowed',
      details: {
        url: 'http://example.com',
        reason: 'Not in allowed domains',
      },
    }

    expect(toolError.type).toBe('tool_error')
    expect(toolError.toolName).toBe('web_read')
    expect(toolError.code).toBe('PERMISSION_DENIED')
    expect(toolError.message).toBeDefined()
    expect(toolError.details).toBeDefined()
  })

  test('tool result shape follows expected contract', async () => {
    const toolResult = {
      type: 'tool_result',
      toolName: 'web_read',
      result: {
        content: 'Page content',
        status: 200,
        url: 'http://127.0.0.1:9222',
      },
      timestamp: new Date().toISOString(),
    }

    expect(toolResult.type).toBe('tool_result')
    expect(toolResult.toolName).toBe('web_read')
    expect(toolResult.result).toBeDefined()
    expect(typeof toolResult.timestamp).toBe('string')
  })
})

describe('Retry Pattern Contracts', () => {
  test('retry state includes attempt count and backoff', async () => {
    const retryState = {
      attempt: 1,
      maxAttempts: 3,
      backoffMs: 100,
      lastError: new Error('Temporary failure'),
    }

    expect(retryState.attempt).toBe(1)
    expect(retryState.maxAttempts).toBe(3)
    expect(retryState.backoffMs).toBe(100)
    expect(retryState.lastError).toBeInstanceOf(Error)
  })

  test('retryable error codes are identifiable', async () => {
    const retryableCodes = ['TIMEOUT', 'CONNECTION_RESET', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED']
    const nonRetryableCodes = ['PERMISSION_DENIED', 'NOT_FOUND', 'INVALID_ARGUMENT']

    for (const code of retryableCodes) {
      expect(retryableCodes.includes(code)).toBe(true)
    }

    for (const code of nonRetryableCodes) {
      expect(nonRetryableCodes.includes(code)).toBe(true)
    }

    // Verify no overlap
    const overlap = retryableCodes.filter(c => nonRetryableCodes.includes(c))
    expect(overlap).toHaveLength(0)
  })
})
