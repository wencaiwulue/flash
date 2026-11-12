import { logForDebugging } from '../debug.js'
import { requireComputerUseSwift } from './swiftLoader.js'

/**
 * Global Escape → abort. Mirrors Cowork's `escAbort.ts` but without Electron:
 * CGEventTap in the open native helper. While registered, Escape is
 * consumed system-wide (PI defense — a prompt-injected action can't dismiss
 * a dialog with Escape).
 *
 * Lifecycle: register on fresh lock acquire (`wrapper.tsx` `acquireCuLock`),
 * unregister on lock release (`cleanup.ts`). The helper owns the tap's main
 * CFRunLoop for the whole registration, so no Node-side busy pump is needed.
 *
 * `notifyExpectedEscape()` punches a hole for model-synthesized Escapes: the
 * executor's `key("escape")` calls it before posting the CGEvent. Swift
 * schedules a 100ms decay so a CGEvent that never reaches the tap callback
 * doesn't eat the next user ESC.
 */

let registered = false

export async function registerEscHotkey(onEscape: () => void): Promise<boolean> {
  if (registered) return true
  const cu = requireComputerUseSwift()
  if (!(await cu.hotkey.registerEscape(onEscape))) {
    // CGEvent.tapCreate failed — typically missing Accessibility permission.
    // CU still works, just without ESC abort. Mirrors Cowork's escAbort.ts:81.
    logForDebugging('[cu-esc] registerEscape returned false', { level: 'warn' })
    return false
  }
  registered = true
  logForDebugging('[cu-esc] registered')
  return true
}

export async function unregisterEscHotkey(): Promise<void> {
  if (!registered) return
  try {
    await requireComputerUseSwift().hotkey.unregister()
  } finally {
    registered = false
    logForDebugging('[cu-esc] unregistered')
  }
}

export async function notifyExpectedEscape(): Promise<void> {
  if (!registered) return
  await requireComputerUseSwift().hotkey.notifyExpectedEscape()
}
