import { afterEach, describe, expect, test } from 'bun:test'
import mockLimits from '../src/commands/mock-limits/index.ts'
import { formatMockLimitsResult } from '../src/commands/mock-limits/mock-limits.ts'
import {
  MOCK_SCENARIOS,
  applyMockHeaders,
  clearMockHeaders,
  getCurrentMockScenario,
  getMockHeaders,
  getMockLimitsBanner,
  setMockRateLimitScenario,
} from '../src/services/mockRateLimits.ts'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
  processRateLimitHeaders,
} from '../src/services/rateLimitMocking.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

const originalOptIn = process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS
afterEach(() => {
  clearMockHeaders()
  if (originalOptIn === undefined) delete process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS
  else process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS = originalOptIn
})

describe('/mock-limits', () => {
  test('registers a real opt-in command with a lazy call interface', async () => {
    delete process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS
    expect(mockLimits.name).toBe('mock-limits')
    expect(mockLimits.isHidden).not.toBe(true)
    expect(mockLimits.isEnabled?.()).toBe(false)
    process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS = '1'
    expect(mockLimits.isEnabled?.()).toBe(true)
    const { call } = await mockLimits.load()
    const result = await call('list', {} as LocalJSXCommandContext)
    expect(result.type).toBe('text')
    if (result.type === 'text') expect(result.value).toContain('session-limit-reached')
  })

  test('is completely inert without explicit opt-in', () => {
    delete process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS
    setMockRateLimitScenario('weekly-limit-reached')
    expect(getMockHeaders()).toBeNull()
    expect(getCurrentMockScenario()).toBeNull()
    expect(formatMockLimitsResult('status')).toContain('disabled')
  })

  test('supports every exported scenario, list, status, clear, and invalid input', () => {
    process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS = '1'
    expect(formatMockLimitsResult('list')).toContain('Available mock scenarios')
    for (const scenario of MOCK_SCENARIOS) {
      setMockRateLimitScenario(scenario)
      expect(getCurrentMockScenario()).toBe(scenario)
      expect(formatMockLimitsResult('status')).toContain(scenario)
      expect(getMockLimitsBanner()).toContain('MOCK LIMITS ACTIVE')
    }
    expect(formatMockLimitsResult('not-a-scenario')).toContain('Usage:')
    expect(formatMockLimitsResult('clear')).toContain('Real provider responses')
    expect(getMockHeaders()).toBeNull()
    expect(getMockLimitsBanner()).toBeNull()
  })

  test('restores real headers and keeps mock 429s out of normal retry handling', () => {
    process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS = '1'
    const real = new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' })
    setMockRateLimitScenario('session-limit-reached')
    expect(processRateLimitHeaders(real).get('anthropic-ratelimit-unified-status')).toBe('rejected')
    const error = checkMockRateLimitError('claude-sonnet-4-5')
    expect(error?.status).toBe(429)
    if (error) expect(isMockRateLimitError(error)).toBe(true)
    clearMockHeaders()
    expect(applyMockHeaders(real)).toBe(real)
    expect(real.get('anthropic-ratelimit-unified-status')).toBe('allowed')
    expect(checkMockRateLimitError('claude-sonnet-4-5')).toBeNull()
  })
})
