import { describe, expect, mock, test } from 'bun:test'
import oauthRefresh from '../src/commands/oauth-refresh/index.ts'
import {
  type OAuthRefreshDependencies,
  runOauthRefresh,
} from '../src/commands/oauth-refresh/oauthRefresh.ts'
import type { OAuthTokens } from '../src/services/oauth/types.ts'

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: Date.UTC(2027, 0, 2, 3, 4, 5),
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'pro',
    rateLimitTier: null,
    ...overrides,
  }
}

function deps(overrides: Partial<OAuthRefreshDependencies> = {}) {
  const current = tokens()
  return {
    getTokens: mock(async () => current),
    refresh: mock(async () =>
      tokens({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
    ),
    save: mock(() => ({ success: true })),
    clearCache: mock(() => {}),
    ...overrides,
  } satisfies OAuthRefreshDependencies
}

describe('/oauth-refresh', () => {
  test('is a public noninteractive Claude.ai command', async () => {
    expect(oauthRefresh.name).toBe('oauth-refresh')
    expect(oauthRefresh.supportsNonInteractive).toBe(true)
    expect(oauthRefresh.availability).toEqual(['claude-ai'])
    expect((await oauthRefresh.load()).call).toBeFunction()
  })

  test('status reports expiry and scopes without refreshing or saving', async () => {
    const d = deps()
    const output = await runOauthRefresh('--status', d)
    expect(output).toContain('2027-01-02T03:04:05.000Z')
    expect(output).toContain('user:profile user:inference')
    expect(output).not.toContain('access-secret')
    expect(output).not.toContain('refresh-secret')
    expect(d.refresh).not.toHaveBeenCalled()
    expect(d.save).not.toHaveBeenCalled()
    expect(d.clearCache).not.toHaveBeenCalled()
  })

  test('force-refreshes even a valid token, saves rotation, then clears cache', async () => {
    const d = deps()
    const output = await runOauthRefresh('', d)
    expect(d.refresh).toHaveBeenCalledWith('refresh-secret')
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
      }),
    )
    expect(d.clearCache).toHaveBeenCalledTimes(1)
    expect(output).toContain('refreshed and saved')
    expect(output).not.toContain('new-access')
    expect(output).not.toContain('new-refresh')
  })

  test('keeps old credentials on network failure and redacts thrown secrets', async () => {
    const d = deps({
      refresh: mock(async () => {
        throw new Error('network failed for access-secret and refresh-secret')
      }),
    })
    const output = await runOauthRefresh('', d)
    expect(output).toContain('Existing credentials were not changed')
    expect(output).not.toContain('access-secret')
    expect(output).not.toContain('refresh-secret')
    expect(output).toContain('<redacted>')
    expect(d.save).not.toHaveBeenCalled()
    expect(d.clearCache).not.toHaveBeenCalled()
  })

  test('does not clear cache when persistence fails', async () => {
    const d = deps({ save: mock(() => ({ success: false })) })
    const output = await runOauthRefresh('', d)
    expect(output).toContain('could not be saved')
    expect(d.clearCache).not.toHaveBeenCalled()
  })

  test('handles missing tokens and invalid arguments without side effects', async () => {
    const d = deps({ getTokens: mock(async () => null) })
    expect(await runOauthRefresh('--status', d)).toContain('No Claude.ai OAuth token')
    expect(await runOauthRefresh('', d)).toContain('No refreshable')
    expect(await runOauthRefresh('--logout', d)).toContain('Usage:')
    expect(d.refresh).not.toHaveBeenCalled()
  })
})
