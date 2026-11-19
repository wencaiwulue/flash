import { describe, expect, it } from 'bun:test'
import { getInitialSettings } from '../src/utils/settings/settings.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'

// B2 terminal/memory settings (upstream 2.1.311): all scope "Any file". These
// pin the source + default behavior each consumer relies on. autoMemoryEnabled
// also honors CLAUDE_CODE_DISABLE_AUTO_MEMORY / --bare precedence (memdir/
// paths.ts); autoMemoryDirectory is read per-source (policy>flag>local>user) in
// memdir/paths.ts getAutoMemPathSetting.
function set(settings: Record<string, unknown>): void {
  setSessionSettingsCache({ settings, errors: [] })
}

describe('B2 terminal/memory settings: source + default', () => {
  it('autoMemoryEnabled: default on unless explicitly false', () => {
    set({})
    expect(getInitialSettings().autoMemoryEnabled === false).toBe(false)
    set({ autoMemoryEnabled: false })
    expect(getInitialSettings().autoMemoryEnabled === false).toBe(true)
  })

  it('autoMemoryDirectory: reads the configured string, unset otherwise', () => {
    set({})
    expect(getInitialSettings().autoMemoryDirectory).toBeUndefined()
    set({ autoMemoryDirectory: '/tmp/mem' })
    expect(getInitialSettings().autoMemoryDirectory).toBe('/tmp/mem')
  })

  it('terminalTitleFromRename: default true unless explicitly false', () => {
    set({})
    expect(getInitialSettings().terminalTitleFromRename !== false).toBe(true)
    set({ terminalTitleFromRename: false })
    expect(getInitialSettings().terminalTitleFromRename !== false).toBe(false)
  })

  it("autoUpdatesChannel: default 'latest', reads configured channel", () => {
    set({})
    expect(getInitialSettings().autoUpdatesChannel ?? 'latest').toBe('latest')
    set({ autoUpdatesChannel: 'stable' })
    expect(getInitialSettings().autoUpdatesChannel ?? 'latest').toBe('stable')
  })
})
