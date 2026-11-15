import { execa, execaSync } from 'execa'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './macOsKeychainHelpers.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './types.js'

export type SecretToolResult = {
  code: number
  stdout: string
  stderr: string
}

export type SecretToolRunner = (
  args: string[],
  input?: string,
) => SecretToolResult

export type SecretToolAsyncRunner = (
  args: string[],
  input?: string,
) => Promise<SecretToolResult>

type LinuxSecretStorageOptions = {
  run?: SecretToolRunner
  runAsync?: SecretToolAsyncRunner
  getServiceName?: () => string
  getAccountName?: () => string
}

const DEFAULT_TIMEOUT_MS = 5000

function defaultRun(args: string[], input?: string): SecretToolResult {
  try {
    const result = execaSync('secret-tool', args, {
      input,
      reject: false,
      timeout: DEFAULT_TIMEOUT_MS,
    })
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    return { code: 1, stdout: '', stderr: String(error) }
  }
}

async function defaultRunAsync(
  args: string[],
  input?: string,
): Promise<SecretToolResult> {
  try {
    const result = await execa('secret-tool', args, {
      input,
      reject: false,
      timeout: DEFAULT_TIMEOUT_MS,
    })
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    return { code: 1, stdout: '', stderr: String(error) }
  }
}

export function createLinuxSecretStorage(
  options: LinuxSecretStorageOptions = {},
): SecureStorage {
  const run = options.run ?? defaultRun
  const runAsync = options.runAsync ?? defaultRunAsync
  const getServiceName =
    options.getServiceName ??
    (() => getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX))
  const getAccountName = options.getAccountName ?? getUsername

  function lookupArgs(): string[] {
    return ['lookup', 'service', getServiceName(), 'account', getAccountName()]
  }

  function storeArgs(): string[] {
    return [
      'store',
      '--label=flash Credentials',
      'service',
      getServiceName(),
      'account',
      getAccountName(),
    ]
  }

  function clearArgs(): string[] {
    return ['clear', 'service', getServiceName(), 'account', getAccountName()]
  }

  function parseResult(result: SecretToolResult): SecureStorageData | null {
    if (result.code !== 0 || !result.stdout.trim()) return null
    try {
      return jsonParse(result.stdout) as SecureStorageData
    } catch {
      return null
    }
  }

  return {
    name: 'libsecret',
    read(): SecureStorageData | null {
      return parseResult(run(lookupArgs()))
    },
    async readAsync(): Promise<SecureStorageData | null> {
      return parseResult(await runAsync(lookupArgs()))
    },
    update(data: SecureStorageData) {
      const result = run(storeArgs(), jsonStringify(data))
      return { success: result.code === 0 }
    },
    delete(): boolean {
      return run(clearArgs()).code === 0
    },
  }
}

export const linuxSecretStorage = createLinuxSecretStorage()
