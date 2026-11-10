export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

type ModifiersModule = {
  prewarm: () => void
  isModifierPressed: (modifier: ModifierKey) => boolean
}

let prewarmed = false
let modifiersModule: ModifiersModule | null | undefined

function getModifiersModule(): ModifiersModule | null {
  if (modifiersModule !== undefined) {
    return modifiersModule
  }
  try {
    const candidate = require('modifiers-napi') as Partial<ModifiersModule>
    modifiersModule =
      typeof candidate.prewarm === 'function' &&
      typeof candidate.isModifierPressed === 'function'
        ? (candidate as ModifiersModule)
        : null
  } catch {
    modifiersModule = null
  }
  return modifiersModule
}

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  getModifiersModule()?.prewarm()
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 * Returns false when the optional native module is unavailable.
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  return getModifiersModule()?.isModifierPressed(modifier) ?? false
}
