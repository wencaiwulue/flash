/**
 * Protocol Contracts Tests
 *
 * Tests sandbox/bridge/tool API offline contracts.
 * Does NOT test private service wire compatibility or credentials.
 */

import { describe, expect, test } from 'bun:test'
import { assertLoopbackCdpEndpoint } from '../src/external-stubs/claude-for-chrome-mcp.js'

describe('Open Chrome Protocol Contracts', () => {
  test('assertLoopbackCdpEndpoint validates URLs correctly', async () => {
    // Valid loopback endpoints
    expect(() => assertLoopbackCdpEndpoint('http://127.0.0.1:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('http://[::1]:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('ws://127.0.0.1:9222')).not.toThrow()
    expect(() => assertLoopbackCdpEndpoint('ws://[::1]:9222/')).not.toThrow()

    // Invalid non-loopback endpoints - should throw
    let threw = false
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
  })
})
