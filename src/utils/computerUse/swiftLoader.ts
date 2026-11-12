import * as swift from '@ant/computer-use-swift'
import type { ComputerUseAPI } from '@ant/computer-use-swift'

let cached: ComputerUseAPI | undefined

export function resetComputerUseSwiftLoader(): void {
  cached = undefined
  swift.resetComputerUseSwiftAdapter()
}

/**
 * Lazy loader for the open macOS helper adapter. The JSON-lines helper owns a
 * real main RunLoop; drainRunLoop remains a bounded compatibility wrapper for
 * executor operations and is never used by the Zavora backend.
 */
export function requireComputerUseSwift(): ComputerUseAPI {
  if (process.platform !== 'darwin') {
    throw new Error('Open Computer Use native adapter is macOS-only')
  }
  return (cached ??= swift as ComputerUseAPI)
}

export type { ComputerUseAPI }
