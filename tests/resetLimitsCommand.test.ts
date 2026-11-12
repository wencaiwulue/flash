import { afterEach, describe, expect, mock, test } from 'bun:test'
import resetLimits, {
  resetLimitsNonInteractive,
} from '../src/commands/reset-limits/index.ts'
import { runResetLimits } from '../src/commands/reset-limits/reset-limits.ts'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'

const wasInteractive = getIsInteractive()
afterEach(() => setIsInteractive(wasInteractive))

function dependencies() {
  const stats = Object.freeze({ totalSessions: 10, totalMessages: 20 })
  return {
    stats,
    deps: {
      checkQuotaStatus: mock(async () => {}),
      clearMockHeaders: mock(() => {}),
      getMockStatus: () => 'No mock response active (using real limits)',
      getLimits: () => ({
        status: 'allowed' as const,
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
        rateLimitType: 'five_hour' as const,
        resetsAt: 1_800_000_000,
        utilization: 0.25,
      }),
    },
  }
}

describe('/reset-limits', () => {
  test('exports matching interactive/non-interactive commands and one lazy core', async () => {
    expect(resetLimits.name).toBe('reset-limits')
    expect(resetLimitsNonInteractive.name).toBe('reset-limits')
    expect(resetLimits.supportsNonInteractive).toBe(false)
    expect(resetLimitsNonInteractive.supportsNonInteractive).toBe(true)
    setIsInteractive(true)
    expect(resetLimits.isEnabled?.()).toBe(true)
    expect(resetLimitsNonInteractive.isEnabled?.()).toBe(false)
    setIsInteractive(false)
    expect(resetLimits.isEnabled?.()).toBe(false)
    expect(resetLimitsNonInteractive.isEnabled?.()).toBe(true)
    expect(await resetLimits.load()).toBe(await resetLimitsNonInteractive.load())
  })

  test('supports default status, explicit status, mocks, and refresh without touching stats', async () => {
    const { deps, stats } = dependencies()
    const defaultStatus = await runResetLimits('', deps)
    const explicitStatus = await runResetLimits('status', deps)
    expect(defaultStatus).toBe(explicitStatus)
    expect(defaultStatus).toContain('session limit')
    expect(defaultStatus).toContain('Utilization: 25%')
    expect(deps.checkQuotaStatus).not.toHaveBeenCalled()
    const mocks = await runResetLimits('mocks', deps)
    expect(deps.clearMockHeaders).toHaveBeenCalledTimes(1)
    expect(mocks).toContain('Real provider limits were not changed')
    expect(deps.checkQuotaStatus).not.toHaveBeenCalled()
    const refreshed = await runResetLimits('refresh', deps)
    expect(deps.checkQuotaStatus).toHaveBeenCalledTimes(1)
    expect(refreshed).toContain('Quota refresh finished')
    expect(stats).toEqual({ totalSessions: 10, totalMessages: 20 })
    expect(await runResetLimits('reset-everything', deps)).toContain('Usage:')
  })

  test('reports refresh/auth failures and never claims a server quota reset', async () => {
    const { deps } = dependencies()
    deps.checkQuotaStatus.mockRejectedValueOnce(new Error('no credentials'))
    const output = await runResetLimits('refresh', deps)
    expect(output).toContain('Quota refresh failed (including missing or rejected credentials)')
    expect(output).toContain('Local usage statistics are preserved')
    expect(output).not.toContain('server quota has been reset')
    expect(output).not.toContain('Server-side quota reset successful')
  })
})
