import { describe, expect, test } from 'bun:test'
import type { Query } from '../../../src/entrypoints/sdk/runtimeTypes.js'
import {
  MOCK_API_KEY,
  type RecordedRequest,
} from '../support/mock-anthropic.ts'
import {
  createSdkHarness,
  pauseAtResult,
  withDeadline,
} from '../support/sdk.ts'

const TEST_TIMEOUT_MS = 30_000
const TOOL_TOKEN_COUNT_OVERHEAD = 500

function recordedTokenCount(request: RecordedRequest): number {
  if (!request.body) throw new Error('count_tokens request has no JSON body')
  return JSON.stringify(request.body).length
}

function hasContent(request: RecordedRequest, marker: string): boolean {
  return JSON.stringify(request.body?.messages).includes(marker)
}

function hasTools(request: RecordedRequest): boolean {
  return Array.isArray(request.body?.tools) && request.body.tools.length > 0
}

function isEmptyToolProbe(request: RecordedRequest): boolean {
  const messages = request.body?.messages
  if (!Array.isArray(messages) || messages.length !== 1 || hasTools(request)) {
    return false
  }
  const message = messages[0] as { role?: unknown; content?: unknown }
  return message.role === 'user' && message.content === 'foo'
}

describe('classic SDK context usage', () => {
  test('counts real context categories through the local mock while the query env lease is active', async () => {
    const harness = await createSdkHarness()
    const externalBaseUrl = 'http://127.0.0.1:1'
    const externalApiKey = 'offline-external-placeholder'
    let query: Query | undefined
    let countRequestCount: number | undefined
    try {
      // These values stand in for the caller's original environment. They are
      // deliberately unusable and are restored by the query, not by usage.
      process.env.ANTHROPIC_BASE_URL = externalBaseUrl
      process.env.ANTHROPIC_API_KEY = externalApiKey

      const marker = 'SDK_TOKEN_COUNT_UNIQUE_34B'
      const prompt = 'Return SDK_TOKEN_COUNT_UNIQUE_34B exactly once.'
      harness.mock.enqueue({ type: 'text', text: marker })
      query = harness.track(harness.sdk.query({
        prompt,
        options: {
          ...harness.baseOptions,
          env: {
            ...harness.baseOptions.env,
            CLAUDE_CODE_MAX_RETRIES: '0',
          },
          model: 'sdk-context-usage-model',
          tools: ['Read'],
          persistSession: false,
        },
      }))

      // Do not replace this with for-await or full collection: pausing at the
      // result yield is what keeps the query-owned mock environment active.
      const { messages, result } = await pauseAtResult(query)
      expect(result.result).toBe(marker)
      expect(messages.filter(message => message.type === 'assistant')).toHaveLength(1)
      expect(messages.filter(message => message.type === 'result')).toEqual([result])
      expect(process.env.ANTHROPIC_BASE_URL).toBe(harness.mock.url)
      expect(process.env.ANTHROPIC_API_KEY).toBe(MOCK_API_KEY)

      const streamBeforeUsage = JSON.stringify(messages)
      const usage = await withDeadline(
        query.getContextUsage(),
        'SDK context usage against local mock',
        TEST_TIMEOUT_MS,
      )
      expect(JSON.stringify(messages)).toBe(streamBeforeUsage)
      expect(JSON.stringify(messages)).not.toContain('count_tokens')

      const countRequests = harness.mock.requests.filter(
        request => request.path === '/v1/messages/count_tokens',
      )
      countRequestCount = countRequests.length
      expect(countRequests.length).toBeGreaterThan(1)
      for (const request of countRequests) {
        expect(request.method).toBe('POST')
        expect(request.headers['x-api-key']).toBe(MOCK_API_KEY)
        expect(typeof request.body?.model).toBe('string')
        expect(Array.isArray(request.body?.messages)).toBe(true)
        expect(Array.isArray(request.body?.tools)).toBe(true)
        expect(Number.isFinite(recordedTokenCount(request))).toBe(true)
        expect(recordedTokenCount(request)).toBeGreaterThanOrEqual(0)
      }

      const messageRequests = countRequests.filter(
        request => hasContent(request, prompt) && hasContent(request, marker),
      )
      const toolRequests = countRequests.filter(hasTools)
      const classified = new Set([...messageRequests, ...toolRequests])
      const systemRequests = countRequests.filter(
        request => !classified.has(request) && !isEmptyToolProbe(request),
      )
      const emptyToolProbes = countRequests.filter(isEmptyToolProbe)
      expect(messageRequests).toHaveLength(1)
      expect(toolRequests.length).toBeGreaterThan(0)
      expect(systemRequests.length).toBeGreaterThan(0)

      const sumCounts = (requests: RecordedRequest[]) => requests.reduce(
        (sum, request) => sum + recordedTokenCount(request),
        0,
      )
      const expectedContentTokens =
        sumCounts(systemRequests) +
        sumCounts(messageRequests) +
        sumCounts(toolRequests) +
        emptyToolProbes.reduce(
          (sum, request) => sum + Math.max(
            0,
            recordedTokenCount(request) - TOOL_TOKEN_COUNT_OVERHEAD,
          ),
          0,
        )
      const contentCategories = usage.categories.filter(
        category =>
          !category.isDeferred &&
          category.name !== 'Free space' &&
          category.name !== 'Compact buffer' &&
          category.name !== 'Autocompact buffer',
      )
      expect(contentCategories.length).toBeGreaterThan(1)
      expect(contentCategories.map(category => category.name)).toEqual(
        expect.arrayContaining(['System prompt', 'System tools', 'Messages']),
      )
      for (const category of usage.categories) {
        expect(Number.isFinite(category.tokens)).toBe(true)
        expect(category.tokens).toBeGreaterThanOrEqual(0)
      }
      expect(
        contentCategories.reduce((sum, category) => sum + category.tokens, 0),
      ).toBe(expectedContentTokens)
      expect(usage.categories.find(category => category.name === 'Messages')?.tokens)
        .toBe(sumCounts(messageRequests))
      expect(usage.categories.find(category => category.name === 'System prompt')?.tokens)
        .toBe(sumCounts(systemRequests))

      expect(Number.isFinite(usage.totalTokens)).toBe(true)
      expect(usage.totalTokens).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(usage.maxTokens)).toBe(true)
      expect(usage.maxTokens).toBeGreaterThan(0)
      expect(usage.totalTokens).toBeLessThanOrEqual(usage.maxTokens)
      expect(usage.rawMaxTokens).toBe(usage.maxTokens)
      const expectedReportedTotal = usage.apiUsage
        ? usage.apiUsage.input_tokens +
          usage.apiUsage.cache_creation_input_tokens +
          usage.apiUsage.cache_read_input_tokens
        : expectedContentTokens
      expect(usage.totalTokens).toBe(expectedReportedTotal)
    } finally {
      if (query) {
        await query.return(undefined)
        expect(process.env.ANTHROPIC_BASE_URL).toBe(externalBaseUrl)
        expect(process.env.ANTHROPIC_API_KEY).toBe(externalApiKey)
        if (countRequestCount !== undefined) {
          expect(
            harness.mock.requests.filter(
              request => request.path === '/v1/messages/count_tokens',
            ),
          ).toHaveLength(countRequestCount)
        }
      }
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)
})
