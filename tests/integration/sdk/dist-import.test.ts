import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  createSdkHarness,
  createUserInput,
  loadDistSdk,
  pauseAtResult,
  userMessage,
} from '../support/sdk.ts'

describe('dist SDK', () => {
  test('loads the public API as named exports from dist/sdk.mjs', async () => {
    const sdk = await loadDistSdk()
    for (const name of [
      'query',
      'tool',
      'createSdkMcpServer',
      'listSessions',
      'getSessionMessages',
    ] as const) {
      expect(typeof sdk[name], name).toBe('function')
    }
  })

  test('collects a real query with isolated offline options', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const harness = await createSdkHarness()
    try {
      expect(harness.baseOptions.cwd).toBe(harness.sandbox.project)
      expect(harness.baseOptions.env?.HOME).toBe(harness.sandbox.home)
      expect(harness.baseOptions.env?.CLAUDE_CONFIG_DIR).toBe(join(harness.sandbox.home, '.claude'))
      expect(harness.baseOptions.env?.ANTHROPIC_API_KEY).toBe('mock-key')
      expect(harness.baseOptions.env?.ANTHROPIC_BASE_URL).toBe(harness.mock.url)
      expect(harness.baseOptions.env?.NODE_ENV).toBe('production')
      expect(harness.baseOptions.env?.USER_TYPE).toBeUndefined()
      expect(harness.baseOptions.env?.FORCE_VCR).toBeUndefined()
      expect(harness.baseOptions.env?.VCR_RECORD).toBeUndefined()
      expect(harness.baseOptions.env?.CLAUDE_CODE_TEST_FIXTURE_ROOT).toBeUndefined()
      expect(process.env.NODE_ENV).toBe('production')

      harness.mock.enqueue({ type: 'text', text: 'DIST_IMPORT_COLLECT_OK' })
      const query = harness.track(harness.sdk.query({
        prompt: 'return the scripted text',
        options: { ...harness.baseOptions, tools: [] },
      }))
      const { messages, error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(messages.map(message => message.type)).toEqual([
        'system',
        'assistant',
        'result',
      ])
      expect(messages[0]).toMatchObject({ type: 'system', subtype: 'init' })
      expect(messages[2]).toMatchObject({ type: 'result', subtype: 'success' })
      expect(JSON.stringify(messages)).toContain('DIST_IMPORT_COLLECT_OK')
    } finally {
      await harness.cleanup()
    }
    expect(process.env.NODE_ENV).toBe(previousNodeEnv)
  })

  test('pauseAtResult uses controlled input and leaves the query open', async () => {
    const harness = await createSdkHarness()
    try {
      harness.mock.enqueue({ type: 'text', text: 'DIST_IMPORT_PAUSE_OK' })
      const input = createUserInput()
      input.push(userMessage('return the scripted text'))
      input.close()
      const query = harness.track(harness.sdk.query({
        prompt: input.input,
        options: { ...harness.baseOptions, tools: [] },
      }))
      const originalReturn = query.return.bind(query)
      let returnCalls = 0
      query.return = async value => {
        returnCalls++
        return originalReturn(value)
      }

      const { messages, result } = await pauseAtResult(query)
      expect(result.subtype).toBe('success')
      expect(messages.map(message => message.type)).toEqual([
        'system',
        'assistant',
        'result',
      ])
      expect(returnCalls).toBe(0)
      await expect(harness.waitFor(() => false, 20)).rejects.toThrow('Timed out')
    } finally {
      await harness.cleanup()
    }
  })
})
