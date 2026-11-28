import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const axiosGet = mock(async (..._args: unknown[]) => {
  throw new Error('Unexpected axios.get')
})
let subscriptionType: 'enterprise' | null = 'enterprise'

const authModule = await import('../src/utils/auth.ts')
mock.module('../src/utils/auth.ts', () => ({
  ...authModule,
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
  getAnthropicApiKeyWithSource: () => ({ key: null, source: 'test' }),
  getClaudeAIOAuthTokens: () => ({
    accessToken: 'offline-test-token',
    subscriptionType,
    scopes: ['user:inference'],
  }),
}))
mock.module('axios', () => ({
  default: { get: axiosGet },
}))

const remoteSettings = await import('../src/services/remoteManagedSettings/index.ts')
const remoteCache = await import('../src/services/remoteManagedSettings/syncCache.ts')
const remoteCacheState = await import('../src/services/remoteManagedSettings/syncCacheState.ts')
const policyLimits = await import('../src/services/policyLimits/index.ts')
const { applyRemoteEntriesToLocal } = await import(
  '../src/services/settingsSync/localFileSync.ts'
)
const { SYNC_KEYS } = await import('../src/services/settingsSync/types.ts')
const {
  getSettingsFilePathForSource,
  getSettingsForSource,
} = await import('../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../src/utils/settings/settingsCache.ts')
const { getMemoryPath } = await import('../src/utils/config.ts')

let tempDir: string
let originalConfigDir: string | undefined
let originalEssentialTraffic: string | undefined
let originalBaseUrl: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalEssentialTraffic = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  originalBaseUrl = process.env.ANTHROPIC_BASE_URL
  tempDir = await mkdtemp(join(tmpdir(), 'flash-settings-remote-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  subscriptionType = 'enterprise'
  axiosGet.mockClear()
  remoteCache.resetSyncCache()
  policyLimits._resetPolicyLimitsForTesting()
  resetSettingsCache()
})

afterEach(async () => {
  remoteSettings.stopBackgroundPolling()
  policyLimits.stopBackgroundPolling()
  remoteCache.resetSyncCache()
  policyLimits._resetPolicyLimitsForTesting()
  resetSettingsCache()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalEssentialTraffic === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  } else {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = originalEssentialTraffic
  }
  if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
  await rm(tempDir, { recursive: true, force: true })
})

describe('remote managed settings offline protocol', () => {
  test('304 reuses the exact cached settings and sends their deterministic checksum', async () => {
    const cached = { theme: 'dark' as const, env: { Z: 'last', A: 'first' } }
    await writeFile(remoteCacheState.getSettingsPath(), JSON.stringify(cached))
    const reordered = { env: { A: 'first', Z: 'last' }, theme: 'dark' as const }
    expect(remoteSettings.computeChecksumFromSettings(reordered)).toBe(
      remoteSettings.computeChecksumFromSettings(cached),
    )
    axiosGet.mockImplementation(async () => ({ status: 304, data: null }))

    await remoteSettings.loadRemoteManagedSettings()

    expect(axiosGet).toHaveBeenCalledTimes(1)
    const request = axiosGet.mock.calls[0]?.[1] as {
      headers: Record<string, string>
    }
    expect(request.headers['If-None-Match']).toBe(
      `"${remoteSettings.computeChecksumFromSettings(cached)}"`,
    )
    expect(remoteCacheState.getRemoteManagedSettingsSyncFromCache()).toEqual(
      cached,
    )
    expect(JSON.parse(await readFile(remoteCacheState.getSettingsPath(), 'utf8'))).toEqual(
      cached,
    )
  })
})

describe('policy limits offline decisions', () => {
  test('cache miss fails closed only for essential-traffic protected policy', () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

    expect(policyLimits.isPolicyAllowed('allow_product_feedback')).toBe(false)
    expect(policyLimits.isPolicyAllowed('unknown_future_policy')).toBe(true)
  })

  test('cached restrictions preserve explicit allow and deny values', async () => {
    await writeFile(
      join(tempDir, 'policy-limits.json'),
      JSON.stringify({
        restrictions: {
          allow_product_feedback: { allowed: false },
          allow_remote_sessions: { allowed: true },
        },
      }),
    )

    expect(policyLimits.isPolicyAllowed('allow_product_feedback')).toBe(false)
    expect(policyLimits.isPolicyAllowed('allow_remote_sessions')).toBe(true)
    expect(policyLimits.isPolicyAllowed('unknown_future_policy')).toBe(true)
  })
})

describe('settings sync offline file contracts', () => {
  test('applies only whitelisted entries and refreshes readable settings', async () => {
    const settingsPath = getSettingsFilePathForSource('userSettings')!
    const memoryPath = getMemoryPath('User')
    await mkdir(tempDir, { recursive: true })
    await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }))
    await writeFile(memoryPath, 'old memory')
    resetSettingsCache()

    await applyRemoteEntriesToLocal(
      {
        [SYNC_KEYS.USER_SETTINGS]: JSON.stringify({ theme: 'light' }),
        [SYNC_KEYS.USER_MEMORY]: '# offline memory',
        [join(tempDir, 'unregistered', 'third-party-file')]:
          'must not be applied',
      },
      null,
    )

    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      theme: 'light',
    })
    expect(await readFile(memoryPath, 'utf8')).toBe('# offline memory')
    expect(getSettingsForSource('userSettings')?.theme).toBe('light')
    expect(
      await Bun.file(join(tempDir, 'unregistered', 'third-party-file')).exists(),
    ).toBe(false)
  })

  test('rejects only the over-500KiB entry while applying an under-limit entry', async () => {
    const settingsPath = getSettingsFilePathForSource('userSettings')!
    const memoryPath = getMemoryPath('User')
    await mkdir(tempDir, { recursive: true })
    await writeFile(settingsPath, 'original-settings')
    await writeFile(memoryPath, 'original-memory')

    await applyRemoteEntriesToLocal(
      {
        [SYNC_KEYS.USER_SETTINGS]: 'x'.repeat(500 * 1024 + 1),
        [SYNC_KEYS.USER_MEMORY]: '# under-limit memory',
      },
      null,
    )

    expect(await readFile(settingsPath, 'utf8')).toBe('original-settings')
    expect(await readFile(memoryPath, 'utf8')).toBe('# under-limit memory')
  })
})
