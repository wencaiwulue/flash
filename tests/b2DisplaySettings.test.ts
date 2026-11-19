import { describe, expect, it } from 'bun:test'
import { getInitialSettings } from '../src/utils/settings/settings.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'

// B2 display/output settings (upstream 2.1.311): all scope "Any file" with no
// ~/.claude.json legacy fallback and no extra precedence. Consumers read the
// merged settings value (getInitialSettings / AppState.settings). These tests
// pin the source + default behavior each consumer relies on.
function set(settings: Record<string, unknown>): void {
  setSessionSettingsCache({ settings, errors: [] })
}

describe('B2 display settings: source + default', () => {
  it('outputStyle: reads settings value; unset falls back to "default"', () => {
    set({})
    expect(getInitialSettings().outputStyle ?? 'default').toBe('default')
    set({ outputStyle: 'explanatory' })
    expect(getInitialSettings().outputStyle ?? 'default').toBe('explanatory')
  })

  it('showThinkingSummaries: default false hides thinking, true shows it', () => {
    // betas.ts uses `!== true` so unset/false pushes REDACT_THINKING_BETA_HEADER.
    set({})
    expect(getInitialSettings().showThinkingSummaries !== true).toBe(true)
    set({ showThinkingSummaries: true })
    expect(getInitialSettings().showThinkingSummaries !== true).toBe(false)
  })

  it('showClearContextOnPlanAccept: default false, true enables the option', () => {
    set({})
    expect(getInitialSettings().showClearContextOnPlanAccept ?? false).toBe(false)
    set({ showClearContextOnPlanAccept: true })
    expect(getInitialSettings().showClearContextOnPlanAccept ?? false).toBe(true)
  })
})
