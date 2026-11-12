import * as input from '@ant/computer-use-input'
import type { ComputerUseInputAPI } from '@ant/computer-use-input'

let cached: ComputerUseInputAPI | undefined

export function resetComputerUseInputLoader(): void {
  cached = undefined
  input.resetComputerUseInputAdapter()
}

/**
 * Lazy process-lifetime loader for the public CGEvent input adapter. Platform
 * support is detected at runtime; the helper is spawned only when input is
 * first requested, never for screenshot-only or Zavora sessions.
 */
export function requireComputerUseInput(): ComputerUseInputAPI {
  if (cached) return cached
  if (!input.isSupported) {
    throw new Error('Open Computer Use input is not supported on this platform')
  }
  return (cached = input as ComputerUseInputAPI)
}
