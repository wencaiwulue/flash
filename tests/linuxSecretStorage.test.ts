import { describe, expect, test } from 'bun:test'
import { createLinuxSecretStorage, type SecretToolResult } from '../src/utils/secureStorage/linuxSecretStorage.ts'
import { createFallbackStorage } from '../src/utils/secureStorage/fallbackStorage.ts'
import type { SecureStorage } from '../src/utils/secureStorage/types.ts'

const data = { trustedDeviceToken: 'test-secret' }

function result(code: number, stdout = ''): SecretToolResult {
  return { code, stdout, stderr: '' }
}

function createRunner(responses: SecretToolResult[]) {
  const calls: Array<{ args: string[]; input?: string }> = []
  return {
    calls,
    run: (args: string[], input?: string) => {
      calls.push({ args, input })
      return responses.shift() ?? result(1)
    },
    runAsync: async (args: string[], input?: string) => {
      calls.push({ args, input })
      return responses.shift() ?? result(1)
    },
  }
}

describe('Linux libsecret storage', () => {
  test('reads, writes, and deletes secrets without putting JSON in argv', async () => {
    const runner = createRunner([
      result(0, JSON.stringify(data)),
      result(0, JSON.stringify(data)),
      result(0),
      result(0),
    ])
    const storage = createLinuxSecretStorage({
      run: runner.run,
      runAsync: runner.runAsync,
      getServiceName: () => 'test-service',
      getAccountName: () => 'test-account',
    })

    expect(storage.read()).toEqual(data)
    expect(await storage.readAsync()).toEqual(data)
    expect(storage.update(data).success).toBe(true)
    expect(storage.delete()).toBe(true)

    const storeCall = runner.calls[2]!
    expect(storeCall.args[0]).toBe('store')
    expect(storeCall.args).not.toContain(JSON.stringify(data))
    expect(storeCall.input).toBe(JSON.stringify(data))
    expect(runner.calls.every(call => !call.args.includes('test-secret'))).toBe(
      true,
    )
  })

  test('returns null for missing or malformed entries', async () => {
    const runner = createRunner([result(1), result(0, '{bad json}')])
    const storage = createLinuxSecretStorage({
      run: runner.run,
      runAsync: runner.runAsync,
    })
    expect(storage.read()).toBeNull()
    expect(await storage.readAsync()).toBeNull()
  })

  test('reports update failure and falls back without losing data', () => {
    const runner = createRunner([result(1), result(1)])
    const primary = createLinuxSecretStorage({
      run: runner.run,
      runAsync: runner.runAsync,
    })
    let secondaryData: typeof data | null = null
    let deleted = false
    const secondary: SecureStorage = {
      name: 'plaintext-test',
      read: () => secondaryData,
      readAsync: async () => secondaryData,
      update: value => {
        secondaryData = value as typeof data
        return { success: true }
      },
      delete: () => {
        deleted = true
        secondaryData = null
        return true
      },
    }
    const storage = createFallbackStorage(primary, secondary)

    expect(storage.update(data).success).toBe(true)
    expect(secondaryData).toEqual(data)
    expect(deleted).toBe(false)
    expect(storage.read()).toEqual(data)
  })

  test('deletes plaintext after the first successful libsecret migration', () => {
    const runner = createRunner([result(1), result(0)])
    const primary = createLinuxSecretStorage({
      run: runner.run,
      runAsync: runner.runAsync,
    })
    let secondaryData: typeof data | null = data
    let deleted = false
    const secondary: SecureStorage = {
      name: 'plaintext-test',
      read: () => secondaryData,
      readAsync: async () => secondaryData,
      update: () => ({ success: true }),
      delete: () => {
        deleted = true
        secondaryData = null
        return true
      },
    }
    const storage = createFallbackStorage(primary, secondary)

    expect(storage.update(data).success).toBe(true)
    expect(deleted).toBe(true)
    expect(secondaryData).toBeNull()
  })
})
