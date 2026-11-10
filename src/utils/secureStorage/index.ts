import { createFallbackStorage } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { linuxSecretStorage } from './linuxSecretStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

/**
 * Get the appropriate secure storage implementation for the current platform
 */
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }

  if (process.platform === 'linux') {
    return createFallbackStorage(linuxSecretStorage, plainTextStorage)
  }

  return plainTextStorage
}
