import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { APIError } from '@anthropic-ai/sdk'

let subscriber = false
let thirdParty = false
let apiKey: string | null = null
let hasAuthToken = false
let subscriptionType: string | null = null

const authModule = await import('../src/utils/auth.ts')
mock.module('../src/utils/auth.ts', () => ({
  ...authModule,
  isClaudeAISubscriber: () => subscriber,
  isUsing3PServices: () => thirdParty,
  getAnthropicApiKey: () => apiKey,
  getAuthTokenSource: () => ({
    source: hasAuthToken ? 'apiKeyHelper' : 'none',
    hasToken: hasAuthToken,
  }),
  getSubscriptionType: () => subscriptionType,
}))

const {
  calculateUSDCost,
  getOpus46CostTier,
} = await import('../src/utils/modelCost.ts')
const {
  addToTotalSessionCost,
  formatTotalCost,
  getStoredSessionCosts,
  restoreCostStateForSession,
  saveCurrentSessionCosts,
} = await import('../src/cost-tracker.ts')
const {
  hasClaudeAiBillingAccess,
  hasConsoleBillingAccess,
  setMockBillingAccessOverride,
} = await import('../src/utils/billing.ts')
const {
  emitStatusChange,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
  statusListeners,
} = await import('../src/services/claudeAiLimits.ts')
const {
  getGlobalConfig,
  saveGlobalConfig,
} = await import('../src/utils/config.ts')
const {
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
} = await import('../src/utils/model/configs.ts')
const {
  getTotalCostUSD,
  hasUnknownModelCost,
  resetStateForTests,
  switchSession,
} = await import('../src/bootstrap/state.ts')

let originalFastMode: string | undefined
let originalCostWarnings: string | undefined

beforeEach(() => {
  subscriber = false
  thirdParty = false
  apiKey = null
  hasAuthToken = false
  subscriptionType = null
  originalFastMode = process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  originalCostWarnings = process.env.DISABLE_COST_WARNINGS
  delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  delete process.env.DISABLE_COST_WARNINGS
  resetStateForTests()
  setMockBillingAccessOverride(null)
  statusListeners.clear()
  emitStatusChange({
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  })
  saveGlobalConfig(current => ({
    ...current,
    cachedExtraUsageDisabledReason: null,
    oauthAccount: undefined,
  }))
})

afterEach(() => {
  statusListeners.clear()
  setMockBillingAccessOverride(null)
  if (originalFastMode === undefined) delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
  else process.env.CLAUDE_CODE_DISABLE_FAST_MODE = originalFastMode
  if (originalCostWarnings === undefined) delete process.env.DISABLE_COST_WARNINGS
  else process.env.DISABLE_COST_WARNINGS = originalCostWarnings
})

describe('model cost calculation', () => {
  test('combines input, output, cache and web search costs exactly', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 2_000_000,
      cache_read_input_tokens: 3_000_000,
      cache_creation_input_tokens: 4_000_000,
      server_tool_use: { web_search_requests: 5 },
    } as Usage

    expect(calculateUSDCost(CLAUDE_SONNET_4_5_CONFIG.firstParty, usage)).toBeCloseTo(
      48.95,
      8,
    )
  })

  test('selects Opus fast tier and marks unknown models for fallback handling', () => {
    expect(getOpus46CostTier(true)).toMatchObject({
      inputTokens: 30,
      outputTokens: 150,
    })
    expect(getOpus46CostTier(false)).toMatchObject({
      inputTokens: 5,
      outputTokens: 25,
    })

    expect(hasUnknownModelCost()).toBe(false)
    const cost = calculateUSDCost('offline-unknown-model', {
      input_tokens: 100,
      output_tokens: 50,
    } as Usage)
    expect(cost).toBeGreaterThan(0)
    expect(hasUnknownModelCost()).toBe(true)
  })
})

describe('session cost persistence', () => {
  test('accumulates, saves and restores costs only for the matching session', () => {
    const sessionId = crypto.randomUUID()
    switchSession(sessionId, '/tmp/offline-cost')
    const model = CLAUDE_SONNET_4_5_CONFIG.firstParty
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 20,
    } as Usage
    const expectedCost = calculateUSDCost(model, usage)

    expect(addToTotalSessionCost(expectedCost, usage, model)).toBeCloseTo(
      expectedCost,
      10,
    )
    saveCurrentSessionCosts()
    expect(getStoredSessionCosts(sessionId)).toMatchObject({
      totalCostUSD: expectedCost,
    })

    resetStateForTests()
    expect(restoreCostStateForSession(crypto.randomUUID())).toBe(false)
    expect(restoreCostStateForSession(sessionId)).toBe(true)
    expect(getTotalCostUSD()).toBeCloseTo(expectedCost, 10)
    expect(formatTotalCost()).toContain('Total cost:')
  })
})

describe('billing access roles', () => {
  test('console access requires auth and admin/billing roles', () => {
    process.env.DISABLE_COST_WARNINGS = '1'
    expect(hasConsoleBillingAccess()).toBe(false)
    delete process.env.DISABLE_COST_WARNINGS
    subscriber = true
    expect(hasConsoleBillingAccess()).toBe(false)
    subscriber = false
    expect(hasConsoleBillingAccess()).toBe(false)

    apiKey = 'offline-api-key'
    hasAuthToken = true
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: { organizationRole: 'admin', workspaceRole: 'member' },
    }))
    expect(hasConsoleBillingAccess()).toBe(true)
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: { organizationRole: 'member', workspaceRole: 'member' },
    }))
    expect(hasConsoleBillingAccess()).toBe(false)
  })

  test('claude.ai access honors overrides, consumer plans and admin roles', () => {
    setMockBillingAccessOverride(true)
    expect(hasClaudeAiBillingAccess()).toBe(true)
    setMockBillingAccessOverride(null)
    subscriber = false
    expect(hasClaudeAiBillingAccess()).toBe(false)

    subscriber = true
    subscriptionType = 'pro'
    expect(hasClaudeAiBillingAccess()).toBe(true)
    subscriptionType = 'enterprise'
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: { organizationRole: 'owner' },
    }))
    expect(hasClaudeAiBillingAccess()).toBe(true)
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: { organizationRole: 'member' },
    }))
    expect(hasClaudeAiBillingAccess()).toBe(false)
  })
})

describe('rate limit state transitions', () => {
  test('emits early warning and caches overage disabled reason', () => {
    const listener = mock(() => {})
    statusListeners.add(listener)
    subscriber = true
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-surpassed-threshold': '0.9',
      'anthropic-ratelimit-unified-5h-utilization': '0.95',
      'anthropic-ratelimit-unified-5h-reset': '12345',
      'anthropic-ratelimit-unified-overage-disabled-reason':
        'org_level_disabled',
    })

    extractQuotaStatusFromHeaders(headers)

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 0.95,
        resetsAt: 12345,
        surpassedThreshold: 0.9,
      }),
    )
    expect(getGlobalConfig().cachedExtraUsageDisabledReason).toBe(
      'org_level_disabled',
    )
  })

  test('forces rejected on 429 and resets to allowed when processing stops', () => {
    const listener = mock(() => {})
    statusListeners.add(listener)
    subscriber = true
    extractQuotaStatusFromError({
      status: 429,
      headers: new Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
      }),
    } as APIError)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ status: 'rejected' })

    subscriber = false
    extractQuotaStatusFromHeaders(new Headers())
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'allowed' }),
    )
  })
})
