/**
 * Protocol Contracts Tests
 *
 * Tests sandbox/bridge/tool API offline contracts.
 * Does NOT test private service wire compatibility or credentials.
 */

import { describe, expect, test } from 'bun:test'
import { assertLoopbackCdpEndpoint, DEFAULT_OPEN_CHROME_CDP_ENDPOINT } from '../src/external-stubs/claude-for-chrome-mcp.ts'

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
})
