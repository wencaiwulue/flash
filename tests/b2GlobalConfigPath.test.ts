import { beforeEach, describe, expect, it } from 'bun:test'
import {
  getShowTurnDuration,
  getVerbose,
  saveGlobalConfig,
} from '../src/utils/config.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'

// Upstream 2.1.311 global-config read path: the merged settings-file value wins;
// a legacy ~/.claude.json value applies only when no settings file sets it.
// getInitialSettings() reads the session settings cache; getGlobalConfig()
// returns TEST_GLOBAL_CONFIG_FOR_TESTING under NODE_ENV=test.
function setSettings(key: string, value: boolean | undefined): void {
  setSessionSettingsCache({
    settings: value === undefined ? {} : { [key]: value },
    errors: [],
  })
}

function setGlobal(key: string, value: boolean | undefined): void {
  saveGlobalConfig(current => ({ ...current, [key]: value }))
}

describe('getShowTurnDuration (global-config read path)', () => {
  beforeEach(() => {
    setSettings('showTurnDuration', undefined)
    setGlobal('showTurnDuration', undefined)
  })

  it('defaults to true when neither settings file nor legacy config sets it', () => {
    expect(getShowTurnDuration()).toBe(true)
  })

  it('settings-file value false overrides legacy config true', () => {
    setGlobal('showTurnDuration', true)
    setSettings('showTurnDuration', false)
    expect(getShowTurnDuration()).toBe(false)
  })

  it('settings-file value true overrides legacy config false', () => {
    setGlobal('showTurnDuration', false)
    setSettings('showTurnDuration', true)
    expect(getShowTurnDuration()).toBe(true)
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('showTurnDuration', undefined)
    setGlobal('showTurnDuration', false)
    expect(getShowTurnDuration()).toBe(false)
  })
})

describe('getVerbose (global-config read path + CLI precedence)', () => {
  beforeEach(() => {
    setSettings('verbose', undefined)
    setGlobal('verbose', undefined)
  })

  it('defaults to false when nothing sets it', () => {
    expect(getVerbose()).toBe(false)
  })

  it('settings-file value applies when no CLI flag', () => {
    setSettings('verbose', true)
    expect(getVerbose()).toBe(true)
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('verbose', undefined)
    setGlobal('verbose', true)
    expect(getVerbose()).toBe(true)
  })

  it('settings-file value true overrides legacy config false', () => {
    setGlobal('verbose', false)
    setSettings('verbose', true)
    expect(getVerbose()).toBe(true)
  })

  it('--verbose CLI flag overrides a settings-file false', () => {
    setSettings('verbose', false)
    expect(getVerbose(true)).toBe(true)
  })

  it('CLI false overrides a settings-file true', () => {
    setSettings('verbose', true)
    expect(getVerbose(false)).toBe(false)
  })
})
