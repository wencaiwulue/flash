import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync, readFileSync, statSync, openSync, closeSync } from 'fs'
import { createHash } from 'crypto'
import type { Server } from 'http'
import type { SecureStorage, SecureStorageData } from '../src/utils/secureStorage/types.js'
import { plainTextStorage } from '../src/utils/secureStorage/plainTextStorage.js'
import { createFallbackStorage } from '../src/utils/secureStorage/fallbackStorage.js'
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
} from '../src/services/oauth/crypto.js'
import { AuthCodeListener } from '../src/services/oauth/auth-code-listener.js'
import { getOauthConfig } from '../src/constants/oauth.ts'
import {
  getOAuthTokenFromFileDescriptor,
  getApiKeyFromFileDescriptor,
  maybePersistTokenForSubprocesses,
  readTokenFromWellKnownFile,
  CCR_OAUTH_TOKEN_PATH,
  CCR_API_KEY_PATH,
} from '../src/utils/authFileDescriptor.js'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.js'
import { getAnthropicApiKeyWithSource } from '../src/utils/auth.ts'
import { resetStateForTests, setClientType } from '../src/bootstrap/state.ts'

// Mock environment and state
const originalEnv = { ...process.env }
const originalCwd = process.cwd()

// Test data
const testOAuthTokens: SecureStorageData = {
  claudeAiOauth: {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3600000,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'pro',
    rateLimitTier: null,
  },
}

const testTrustedDevice: SecureStorageData = {
  trustedDeviceToken: 'test-device-token',
}

function createTestDir(): string {
  const testDir = join(tmpdir(), `claude-test-auth-${Date.now()}-${Math.random()}`)
  mkdirSync(testDir, { recursive: true, mode: 0o700 })
  return testDir
}

async function closeListenerAndWait(listener: AuthCodeListener): Promise<void> {
  const server = (listener as unknown as { localServer: Server }).localServer
  listener.close()
  await new Promise<void>(resolve => server.once('close', resolve))
}

function clearEnvConfigCache(): void {
  // Clear memoization cache - lodash memoize stores cache on the function
  const fn = getClaudeConfigHomeDir as unknown as { cache?: Map<unknown, unknown> }
  if (fn.cache) {
    fn.cache.clear()
  }
}

function createMockStorage(
  name: string,
  data: SecureStorageData | null,
  shouldFail = false,
): SecureStorage {
  let currentData = data
  return {
    name,
    read: mock(() => currentData),
    readAsync: mock(async () => currentData),
    update: mock((newData) => {
      if (shouldFail) {
        return { success: false }
      }
      currentData = newData
      return { success: true }
    }),
    delete: mock(() => {
      if (shouldFail) {
        return false
      }
      currentData = null
      return true
    }),
  }
}

describe('Auth - plainTextStorage', () => {
  let testDir: string

  beforeEach(() => {
    // Create a temporary directory and override CLAUDE_CONFIG_HOME
    testDir = createTestDir()
    process.env.CLAUDE_CONFIG_DIR = testDir
    clearEnvConfigCache()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    clearEnvConfigCache()
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test('creates file with 0o600 permissions', () => {
    const result = plainTextStorage.update(testOAuthTokens)
    expect(result.success).toBe(true)
    expect(result.warning).toBe('Warning: Storing credentials in plaintext.')

    // Verify the file exists and has correct permissions
    const storagePath = join(testDir, '.credentials.json')
    expect(existsSync(storagePath)).toBe(true)

    expect(statSync(storagePath).mode & 0o777).toBe(0o600)
    const content = readFileSync(storagePath, 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.claudeAiOauth.accessToken).toBe('test-access-token')
  })

  test('reads valid JSON file', () => {
    // Create test file directly
    const storagePath = join(testDir, '.credentials.json')
    writeFileSync(storagePath, JSON.stringify(testOAuthTokens), { mode: 0o600 })

    const result = plainTextStorage.read()
    expect(result).toEqual(testOAuthTokens)
  })

  test('returns null for missing file', () => {
    const result = plainTextStorage.read()
    expect(result).toBeNull()
  })

  test('returns null for invalid JSON', () => {
    const storagePath = join(testDir, '.credentials.json')
    writeFileSync(storagePath, 'not valid json', { mode: 0o600 })

    const result = plainTextStorage.read()
    expect(result).toBeNull()
  })

  test('async read works the same as sync', async () => {
    const storagePath = join(testDir, '.credentials.json')
    writeFileSync(storagePath, JSON.stringify(testTrustedDevice), { mode: 0o600 })

    const syncResult = plainTextStorage.read()
    const asyncResult = await plainTextStorage.readAsync()
    expect(asyncResult).toEqual(syncResult)
  })

  test('deletes the file', () => {
    const storagePath = join(testDir, '.credentials.json')
    writeFileSync(storagePath, JSON.stringify(testOAuthTokens), { mode: 0o600 })
    expect(existsSync(storagePath)).toBe(true)

    const result = plainTextStorage.delete()
    expect(result).toBe(true)
    expect(existsSync(storagePath)).toBe(false)
  })

  test('delete succeeds for non-existent file', () => {
    const result = plainTextStorage.delete()
    expect(result).toBe(true) // No error, returns true for idempotent
  })

  test('never writes secrets in plaintext warnings to logs', () => {
    // This test just verifies the warning message doesn't contain the actual token
    const result = plainTextStorage.update(testOAuthTokens)
    expect(result.warning).not.toContain('test-access-token')
    expect(result.warning).not.toContain('test-refresh-token')
  })
})

describe('Auth - fallbackStorage', () => {
  test('reads from primary first when available', () => {
    const primary = createMockStorage('primary', testOAuthTokens)
    const secondary = createMockStorage('secondary', testTrustedDevice)

    const storage = createFallbackStorage(primary, secondary)
    const result = storage.read()

    expect(result).toEqual(testOAuthTokens)
    expect(primary.read).toHaveBeenCalled()
    expect(secondary.read).not.toHaveBeenCalled()
  })

  test('falls back to secondary when primary returns null', () => {
    const primary = createMockStorage('primary', null)
    const secondary = createMockStorage('secondary', testTrustedDevice)

    const storage = createFallbackStorage(primary, secondary)
    const result = storage.read()

    expect(result).toEqual(testTrustedDevice)
    expect(primary.read).toHaveBeenCalled()
    expect(secondary.read).toHaveBeenCalled()
  })

  test('falls back to secondary when primary fails', () => {
    const primary = createMockStorage('primary', null, true) // shouldFail = true
    const secondary = createMockStorage('secondary', testTrustedDevice)

    const storage = createFallbackStorage(primary, secondary)
    const result = storage.read()

    expect(result).toEqual(testTrustedDevice)
  })

  test('returns empty object when both fail', () => {
    const primary = createMockStorage('primary', null, true)
    const secondary = createMockStorage('secondary', null, true)

    const storage = createFallbackStorage(primary, secondary)
    const result = storage.read()

    expect(result).toEqual({})
  })

  test('updates primary successfully', () => {
    const primary = createMockStorage('primary', null)
    const secondary = createMockStorage('secondary', testTrustedDevice)

    const storage = createFallbackStorage(primary, secondary)
    const result = storage.update(testOAuthTokens)

    expect(result.success).toBe(true)
    expect(primary.update).toHaveBeenCalledWith(testOAuthTokens)
    expect(secondary.update).not.toHaveBeenCalled()
  })

  test('migrates from secondary to primary on first successful update', () => {
    const primary = createMockStorage('primary', null) // No prior data
    const secondary = createMockStorage('secondary', testTrustedDevice)

    const storage = createFallbackStorage(primary, secondary)
    storage.update(testOAuthTokens)

    expect(primary.update).toHaveBeenCalled()
    expect(secondary.delete).toHaveBeenCalled() // Clean up secondary
  })

  test('does not delete secondary when primary already has data', () => {
    const primary = createMockStorage('primary', testTrustedDevice) // Has prior data
    const secondary = createMockStorage('secondary', testTrustedDevice)

    const storage = createFallbackStorage(primary, secondary)
    storage.update(testOAuthTokens)

    expect(primary.update).toHaveBeenCalled()
    expect(secondary.delete).not.toHaveBeenCalled()
  })

  test('falls back to secondary when primary update fails', () => {
    const primaryDataBefore: SecureStorageData | null = testTrustedDevice
    const primary = createMockStorage('primary', primaryDataBefore, true) // shouldFail = true
    const secondary = createMockStorage('secondary', null)

    const storage = createFallbackStorage(primary, secondary)
    const result = storage.update(testOAuthTokens)

    expect(result.success).toBe(true)
    expect(primary.update).toHaveBeenCalled()
    expect(secondary.update).toHaveBeenCalledWith(testOAuthTokens)
    // Only delete primary if primary had data before (to prevent stale shadow)
    if (primaryDataBefore !== null) {
      expect(primary.delete).toHaveBeenCalled()
    }
  })

  test('deletes both primary and secondary', () => {
    const primary = createMockStorage('primary', testOAuthTokens)
    const secondary = createMockStorage('secondary', testTrustedDevice)

    const storage = createFallbackStorage(primary, secondary)
    const result = storage.delete()

    expect(result).toBe(true) // Succeeds if either delete succeeds
    expect(primary.delete).toHaveBeenCalled()
    expect(secondary.delete).toHaveBeenCalled()
  })

  test('async read follows same fallback logic', async () => {
    const primary = createMockStorage('primary', null)
    const secondary = createMockStorage('secondary', testOAuthTokens)

    const storage = createFallbackStorage(primary, secondary)
    const result = await storage.readAsync()

    expect(result).toEqual(testOAuthTokens)
    expect(primary.readAsync).toHaveBeenCalled()
    expect(secondary.readAsync).toHaveBeenCalled()
  })
})

describe('Auth - OAuth crypto', () => {
  test('generateCodeVerifier creates valid base64url string', () => {
    const verifier = generateCodeVerifier()
    expect(verifier).toBeTruthy()
    expect(verifier.length).toBeGreaterThan(32) // At least 256 bits
    // Should only contain base64url characters: A-Z, a-z, 0-9, -, _
    expect(verifier).toMatch(/^[A-Za-z0-9-_]+$/)
    // Should not contain +, /, or =
    expect(verifier).not.toContain('+')
    expect(verifier).not.toContain('/')
    expect(verifier).not.toContain('=')
  })

  test('generateCodeVerifier creates unique values', () => {
    const v1 = generateCodeVerifier()
    const v2 = generateCodeVerifier()
    expect(v1).not.toBe(v2)
  })

  test('generateCodeChallenge creates valid SHA256 hash', () => {
    const verifier = generateCodeVerifier()
    const challenge = generateCodeChallenge(verifier)
    expect(challenge).toBeTruthy()
    expect(challenge.length).toBeGreaterThan(0)
    expect(challenge).toMatch(/^[A-Za-z0-9-_]+$/)
    expect(challenge).toBe(
      createHash('sha256').update(verifier).digest('base64url'),
    )
  })

  test('generateCodeChallenge is deterministic', () => {
    const verifier = generateCodeVerifier()
    const c1 = generateCodeChallenge(verifier)
    const c2 = generateCodeChallenge(verifier)
    expect(c1).toBe(c2)
  })

  test('generateCodeChallenge differs for different verifiers', () => {
    const v1 = generateCodeVerifier()
    const v2 = generateCodeVerifier()
    const c1 = generateCodeChallenge(v1)
    const c2 = generateCodeChallenge(v2)
    expect(c1).not.toBe(c2)
  })

  test('generateState creates valid base64url string', () => {
    const state = generateState()
    expect(state).toBeTruthy()
    expect(state.length).toBeGreaterThan(32)
    expect(state).toMatch(/^[A-Za-z0-9-_]+$/)
  })

  test('generateState creates unique values', () => {
    const s1 = generateState()
    const s2 = generateState()
    expect(s1).not.toBe(s2)
  })
})

describe('Auth - AuthCodeListener', () => {
  test('starts and closes a random local port', async () => {
    const listener = new AuthCodeListener()
    const port = await listener.start()
    expect(port).toBeGreaterThan(0)
    expect(listener.getPort()).toBe(port)
    await closeListenerAndWait(listener)
  })

  test('accepts a matching state and code then completes a success redirect', async () => {
    const listener = new AuthCodeListener('/custom-oauth-callback')
    const port = await listener.start()
    let responsePromise: Promise<Response> | undefined

    try {
      const authorization = listener.waitForAuthorization('expected-state', () => {
        responsePromise = fetch(
          `http://localhost:${port}/custom-oauth-callback?code=offline-code&state=expected-state`,
          { redirect: 'manual', headers: { connection: 'close' } },
        )
        return responsePromise.then(() => undefined)
      })

      await expect(authorization).resolves.toBe('offline-code')
      expect(listener.hasPendingResponse()).toBe(true)
      listener.handleSuccessRedirect(['user:inference'])
      const response = await responsePromise!
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(
        getOauthConfig().CLAUDEAI_SUCCESS_URL,
      )

      await closeListenerAndWait(listener)
    } finally {
      listener.close()
    }
  })

  test('rejects a missing code and a mismatched state with observable 400 responses', async () => {
    const listener = new AuthCodeListener()
    const port = await listener.start()

    async function expectBadRequest(
      query: string,
      expectedError: string,
      expectedBody: string,
    ) {
      let responsePromise: Promise<Response> | undefined
      const authorization = listener.waitForAuthorization('expected-state', () => {
        responsePromise = fetch(`http://localhost:${port}/callback?${query}`, {
          redirect: 'manual',
          headers: { connection: 'close' },
        })
        return responsePromise.then(() => undefined)
      })
      await expect(authorization).rejects.toThrow(expectedError)
      const response = await responsePromise!
      expect(response.status).toBe(400)
      expect(await response.text()).toBe(expectedBody)
      expect(listener.hasPendingResponse()).toBe(false)
    }

    try {
      await expectBadRequest(
        'state=expected-state',
        'No authorization code received',
        'Authorization code not found',
      )
      await expectBadRequest(
        'code=offline-code&state=wrong-state',
        'Invalid state parameter',
        'Invalid state parameter',
      )
    } finally {
      listener.close()
    }
  })
})

describe('Auth - authFileDescriptor', () => {
  let testDir: string

  beforeEach(() => {
    testDir = join(tmpdir(), `claude-test-auth-fd-${Date.now()}`)
    mkdirSync(testDir, { recursive: true, mode: 0o700 })
    process.env = { ...originalEnv }
    resetStateForTests()
  })

  afterEach(() => {
    process.env = originalEnv
    resetStateForTests()
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test('readTokenFromWellKnownFile returns null for non-existent file', () => {
    const nonExistentPath = join(testDir, 'non-existent-token')
    const result = readTokenFromWellKnownFile(nonExistentPath, 'test token')
    expect(result).toBeNull()
  })

  test('readTokenFromWellKnownFile reads token from file', () => {
    const tokenPath = join(testDir, 'test-token-file')
    const testToken = 'test-token-12345'
    writeFileSync(tokenPath, testToken, { mode: 0o600 })

    const result = readTokenFromWellKnownFile(tokenPath, 'test token')
    expect(result).toBe(testToken)
  })

  test('readTokenFromWellKnownFile trims whitespace', () => {
    const tokenPath = join(testDir, 'test-token-file')
    writeFileSync(tokenPath, '  token-with-whitespace  \n', { mode: 0o600 })

    const result = readTokenFromWellKnownFile(tokenPath, 'test token')
    expect(result).toBe('token-with-whitespace')
  })

  test('reads an API key from an isolated real file descriptor without CCR persistence', () => {
    const tokenPath = join(testDir, 'descriptor-token')
    writeFileSync(tokenPath, 'descriptor-test-token\n', { mode: 0o600 })
    const descriptor = openSync(tokenPath, 'r')
    delete process.env.CLAUDE_CODE_REMOTE
    process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR = String(descriptor)

    try {
      expect(getApiKeyFromFileDescriptor()).toBe('descriptor-test-token')
      expect(existsSync(join(testDir, '.api_key'))).toBe(false)
    } finally {
      closeSync(descriptor)
      delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    }
  })

  test('readTokenFromWellKnownFile returns null for empty file', () => {
    const tokenPath = join(testDir, 'empty-token-file')
    writeFileSync(tokenPath, '', { mode: 0o600 })

    const result = readTokenFromWellKnownFile(tokenPath, 'test token')
    expect(result).toBeNull()
  })

  test('maybePersistTokenForSubprocesses does not write outside CCR mode', () => {
    delete process.env.CLAUDE_CODE_REMOTE
    const tokenPath = join(testDir, 'should-not-exist')
    maybePersistTokenForSubprocesses(tokenPath, 'test-token', 'test token')
    expect(existsSync(tokenPath)).toBe(false)
  })

  test('getOAuthTokenFromFileDescriptor returns null without FD env var', () => {
    // No FD env var set
    const result = getOAuthTokenFromFileDescriptor()
    expect(result).toBeNull()
  })

  test('getApiKeyFromFileDescriptor returns null without FD env var', () => {
    // No FD env var set
    const result = getApiKeyFromFileDescriptor()
    expect(result).toBeNull()
  })
})

describe('Auth - core source precedence without keychain access', () => {
  let testDir: string

  beforeEach(() => {
    testDir = createTestDir()
    process.env = { ...originalEnv, NODE_ENV: 'test' }
    delete process.env.CLAUDE_CODE_REMOTE
    resetStateForTests()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    resetStateForTests()
    rmSync(testDir, { recursive: true, force: true })
  })

  test('uses an explicit environment API key in the hermetic test branch', () => {
    process.env.ANTHROPIC_API_KEY = 'environment-test-key'
    delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

    expect(getAnthropicApiKeyWithSource()).toEqual({
      key: 'environment-test-key',
      source: 'ANTHROPIC_API_KEY',
    })
  })

  test('returns no API key for an OAuth-only environment', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-only-test-token'

    expect(getAnthropicApiKeyWithSource()).toEqual({
      key: null,
      source: 'none',
    })
  })

  test('prefers an isolated FD API key over the environment key in the first-party IDE branch', () => {
    setClientType('claude-vscode')
    const tokenPath = join(testDir, 'fd-key')
    writeFileSync(tokenPath, 'descriptor-precedence-key\n', { mode: 0o600 })
    const descriptor = openSync(tokenPath, 'r')
    process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR = String(descriptor)
    process.env.ANTHROPIC_API_KEY = 'environment-test-key'

    try {
      expect(getAnthropicApiKeyWithSource()).toEqual({
        key: 'descriptor-precedence-key',
        source: 'ANTHROPIC_API_KEY',
      })
    } finally {
      closeSync(descriptor)
      delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    }
  })
})
