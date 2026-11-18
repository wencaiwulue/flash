import { beforeEach, describe, expect, mock, test } from 'bun:test'

const axiosGet = mock(async (..._args: unknown[]) => {
  throw new Error('Unexpected axios.get')
})
const axiosPost = mock(async (..._args: unknown[]) => {
  throw new Error('Unexpected axios.post')
})

mock.module('axios', () => ({
  default: {
    get: axiosGet,
    post: axiosPost,
    isAxiosError: () => false,
  },
}))

const {
  exchangeCodeForTokens,
  fetchAndStoreUserRoles,
  fetchProfileInfo,
} = await import('../src/services/oauth/client.ts')
const { getOauthProfileFromOauthToken } = await import(
  '../src/services/oauth/getOauthProfile.ts'
)
const { getOauthConfig } = await import('../src/constants/oauth.ts')
const { getGlobalConfig, saveGlobalConfig } = await import(
  '../src/utils/config.ts'
)

beforeEach(() => {
  axiosGet.mockReset()
  axiosPost.mockReset()
  saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
})

const profile = {
  account: {
    uuid: 'offline-account',
    display_name: 'Offline User',
    created_at: '2025-01-01T00:00:00.000Z',
  },
  organization: {
    uuid: 'offline-org',
    organization_type: 'claude_team',
    rate_limit_tier: 'default',
    billing_type: 'stripe',
    has_extra_usage_enabled: true,
    subscription_created_at: '2025-02-01T00:00:00.000Z',
  },
}

describe('OAuth token exchange with an axios boundary', () => {
  test('posts the authorization grant and returns the provider response', async () => {
    const data = {
      access_token: 'offline-access-token',
      refresh_token: 'offline-refresh-token',
      expires_in: 3600,
      scope: 'user:inference user:profile',
    }
    axiosPost.mockResolvedValue({ status: 200, data })

    await expect(
      exchangeCodeForTokens(
        'offline-authorization-code',
        'expected-state',
        'offline-verifier',
        4310,
        true,
        1200,
      ),
    ).resolves.toEqual(data)

    expect(axiosPost).toHaveBeenCalledTimes(1)
    const [url, body, config] = axiosPost.mock.calls[0]!
    expect(url).toBe(getOauthConfig().TOKEN_URL)
    expect(body).toEqual({
      grant_type: 'authorization_code',
      code: 'offline-authorization-code',
      redirect_uri: getOauthConfig().MANUAL_REDIRECT_URL,
      client_id: getOauthConfig().CLIENT_ID,
      code_verifier: 'offline-verifier',
      state: 'expected-state',
      expires_in: 1200,
    })
    expect(config).toMatchObject({
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    })
  })

  test('rejects a non-200 authorization exchange without returning tokens', async () => {
    axiosPost.mockResolvedValue({ status: 401, statusText: 'Unauthorized' })

    await expect(
      exchangeCodeForTokens('bad-code', 'state', 'verifier', 4310),
    ).rejects.toThrow('Authentication failed: Invalid authorization code')
  })
})

describe('OAuth profile and account side effects with an axios boundary', () => {
  test('returns profile data and maps organization/account fields', async () => {
    axiosGet.mockResolvedValue({ status: 200, data: profile })

    await expect(getOauthProfileFromOauthToken('offline-access-token')).resolves.toEqual(
      profile,
    )
    const info = await fetchProfileInfo('offline-access-token')

    expect(info).toMatchObject({
      subscriptionType: 'team',
      displayName: 'Offline User',
      rateLimitTier: 'default',
      hasExtraUsageEnabled: true,
      billingType: 'stripe',
      accountCreatedAt: '2025-01-01T00:00:00.000Z',
      subscriptionCreatedAt: '2025-02-01T00:00:00.000Z',
      rawProfile: profile,
    })
    const [, config] = axiosGet.mock.calls[0]!
    expect(config).toMatchObject({
      headers: {
        Authorization: 'Bearer offline-access-token',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
  })

  test('isolates a profile transport failure without a result', async () => {
    axiosGet.mockRejectedValue(new Error('offline profile failure'))

    await expect(
      getOauthProfileFromOauthToken('offline-access-token'),
    ).resolves.toBeUndefined()
  })

  test('stores fetched organization and workspace roles in global config', async () => {
    saveGlobalConfig(current => ({
      ...current,
      oauthAccount: { accountUuid: 'offline-account' },
    }))
    axiosGet.mockResolvedValue({
      status: 200,
      data: {
        organization_role: 'admin',
        workspace_role: 'developer',
        organization_name: 'Offline Org',
      },
    })

    await fetchAndStoreUserRoles('offline-access-token')

    expect(getGlobalConfig().oauthAccount).toMatchObject({
      accountUuid: 'offline-account',
      organizationRole: 'admin',
      workspaceRole: 'developer',
      organizationName: 'Offline Org',
    })
    const [, config] = axiosGet.mock.calls[0]!
    expect(config).toMatchObject({
      headers: { Authorization: 'Bearer offline-access-token' },
    })
  })
})
