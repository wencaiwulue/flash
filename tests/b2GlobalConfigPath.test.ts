import { beforeEach, describe, expect, it } from 'bun:test'
import {
  getShowTurnDuration,
  saveGlobalConfig,
} from '../src/utils/config.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'

// Upstream 2.1.311 showTurnDuration: merged settings-file value wins; a legacy
// ~/.claude.json value applies only when no settings file sets it; default true.
// getInitialSettings() reads the session settings cache; getGlobalConfig()
// returns TEST_GLOBAL_CONFIG_FOR_TESTING under NODE_ENV=test.
function setSettings(value: boolean | undefined): void {
  setSessionSettingsCache({
    settings: value === undefined ? {} : { showTurnDuration: value },
    errors: [],
  })
}

function setGlobal(value: boolean | undefined): void {
  saveGlobalConfig(current => ({ ...current, showTurnDuration: value }))
}

describe('getShowTurnDuration (global-config read path)', () => {
  beforeEach(() => {
    setSettings(undefined)
    setGlobal(undefined)
  })

  it('defaults to true when neither settings file nor legacy config sets it', () => {
    expect(getShowTurnDuration()).toBe(true)
  })

  it('settings-file value false overrides legacy config true', () => {
    setGlobal(true)
    setSettings(false)
    expect(getShowTurnDuration()).toBe(false)
  })

  it('settings-file value true overrides legacy config false', () => {
    setGlobal(false)
    setSettings(true)
    expect(getShowTurnDuration()).toBe(true)
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings(undefined)
    setGlobal(false)
    expect(getShowTurnDuration()).toBe(false)
  })
})
