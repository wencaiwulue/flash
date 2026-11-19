import { beforeEach, describe, expect, it } from 'bun:test'
import {
  getPreferredNotifChannel,
  getTerminalProgressBarEnabled,
  getThemeSetting,
  saveGlobalConfig,
} from '../src/utils/config.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'
import { SettingsSchema } from '../src/utils/settings/types.ts'

// Upstream 2.1.311 "Any file" scope with legacy ~/.claude.json fallback: the
// merged settings-file value wins; a legacy value applies only when no settings
// file sets it. getInitialSettings() reads the session settings cache;
// getGlobalConfig() returns TEST_GLOBAL_CONFIG_FOR_TESTING under NODE_ENV=test.
function setSettings(key: string, value: string | boolean | undefined): void {
  setSessionSettingsCache({
    settings: value === undefined ? {} : { [key]: value },
    errors: [],
  })
}

function setGlobal(key: string, value: string | boolean | undefined): void {
  saveGlobalConfig(current => ({ ...current, [key]: value }))
}

describe('getThemeSetting (settings layer + legacy fallback)', () => {
  beforeEach(() => {
    setSettings('theme', undefined)
    setGlobal('theme', undefined)
  })

  it('defaults to dark when neither settings file nor legacy config sets it', () => {
    expect(getThemeSetting()).toBe('dark')
  })

  it('settings-file value overrides legacy config', () => {
    setGlobal('theme', 'dark')
    setSettings('theme', 'light')
    expect(getThemeSetting()).toBe('light')
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('theme', undefined)
    setGlobal('theme', 'light')
    expect(getThemeSetting()).toBe('light')
  })
})

describe('getPreferredNotifChannel (settings layer + legacy fallback)', () => {
  beforeEach(() => {
    setSettings('preferredNotifChannel', undefined)
    setGlobal('preferredNotifChannel', undefined)
  })

  it('defaults to auto when nothing sets it', () => {
    expect(getPreferredNotifChannel()).toBe('auto')
  })

  it('settings-file value overrides legacy config', () => {
    setGlobal('preferredNotifChannel', 'terminal_bell')
    setSettings('preferredNotifChannel', 'iterm2')
    expect(getPreferredNotifChannel()).toBe('iterm2')
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('preferredNotifChannel', undefined)
    setGlobal('preferredNotifChannel', 'terminal_bell')
    expect(getPreferredNotifChannel()).toBe('terminal_bell')
  })
})

describe('getTerminalProgressBarEnabled (settings layer + legacy fallback)', () => {
  beforeEach(() => {
    setSettings('terminalProgressBarEnabled', undefined)
    setGlobal('terminalProgressBarEnabled', undefined)
  })

  it('defaults to true when nothing sets it', () => {
    expect(getTerminalProgressBarEnabled()).toBe(true)
  })

  it('settings-file value false overrides legacy config true', () => {
    setGlobal('terminalProgressBarEnabled', true)
    setSettings('terminalProgressBarEnabled', false)
    expect(getTerminalProgressBarEnabled()).toBe(false)
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('terminalProgressBarEnabled', undefined)
    setGlobal('terminalProgressBarEnabled', false)
    expect(getTerminalProgressBarEnabled()).toBe(false)
  })
})

// autoConnectIde / autoInstallIdeExtension are Global config (~/.claude.json)
// scope at runtime, but the upstream settings schema still declares the keys, so
// flash declares them for path/type alignment while the runtime read stays on
// GlobalConfig.
describe('IDE settings schema (Global config scope, path/type alignment)', () => {
  it('autoConnectIde accepts boolean and rejects a non-boolean value', () => {
    expect(SettingsSchema().parse({ autoConnectIde: true }).autoConnectIde).toBe(true)
    expect(SettingsSchema().parse({ autoConnectIde: false }).autoConnectIde).toBe(false)
    expect(() => SettingsSchema().parse({ autoConnectIde: 'yes' })).toThrow()
  })

  it('autoInstallIdeExtension accepts boolean and rejects a non-boolean value', () => {
    expect(
      SettingsSchema().parse({ autoInstallIdeExtension: true })
        .autoInstallIdeExtension,
    ).toBe(true)
    expect(() =>
      SettingsSchema().parse({ autoInstallIdeExtension: 'yes' }),
    ).toThrow()
  })
})
