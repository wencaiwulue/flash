import { beforeEach, describe, expect, it } from 'bun:test'
import { getTeammateMode, saveGlobalConfig } from '../src/utils/config.ts'
import { resolveOverriddenModel } from '../src/utils/model/modelStrings.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'
import { SettingsSchema } from '../src/utils/settings/types.ts'

// Upstream 2.1.311 "Any file" scope. teammateMode additionally has a documented
// legacy ~/.claude.json fallback (sourceRules: "also reads a value left in
// ~/.claude.json by older versions"), so its helper is settings ?? legacy ??
// 'auto'. The --teammate-mode CLI override is handled by the caller. modelOverrides
// is already read from getInitialSettings() (modelStrings.ts); these tests pin
// that behavior.
function setSettings(key: string, value: unknown): void {
  setSessionSettingsCache({
    settings: value === undefined ? {} : { [key]: value },
    errors: [],
  })
}

function setGlobal(key: string, value: string | undefined): void {
  saveGlobalConfig(current => ({ ...current, [key]: value }))
}

describe('getTeammateMode (settings layer + legacy fallback)', () => {
  beforeEach(() => {
    setSettings('teammateMode', undefined)
    setGlobal('teammateMode', undefined)
  })

  it('defaults to auto when nothing sets it', () => {
    expect(getTeammateMode()).toBe('auto')
  })

  it('settings-file value overrides legacy config', () => {
    setGlobal('teammateMode', 'auto')
    setSettings('teammateMode', 'tmux')
    expect(getTeammateMode()).toBe('tmux')
  })

  it('legacy ~/.claude.json value applies when no settings file sets it', () => {
    setSettings('teammateMode', undefined)
    setGlobal('teammateMode', 'tmux')
    expect(getTeammateMode()).toBe('tmux')
  })

  it('schema rejects an invalid teammateMode value', () => {
    expect(() => SettingsSchema().parse({ teammateMode: 'bogus' })).toThrow()
  })
})

describe('modelOverrides (already read from getInitialSettings)', () => {
  it('schema accepts a string-to-string record and rejects non-string values', () => {
    expect(
      SettingsSchema().parse({
        modelOverrides: { 'claude-opus-4-6': 'arn:aws:bedrock:us-east-1/opus' },
      }).modelOverrides,
    ).toEqual({ 'claude-opus-4-6': 'arn:aws:bedrock:us-east-1/opus' })
    expect(() =>
      SettingsSchema().parse({ modelOverrides: { 'claude-opus-4-6': 42 } }),
    ).toThrow()
  })

  it('resolveOverriddenModel maps an override ARN back to its canonical ID', () => {
    setSettings('modelOverrides', {
      'claude-opus-4-6': 'arn:aws:bedrock:us-east-1/opus',
    })
    expect(resolveOverriddenModel('arn:aws:bedrock:us-east-1/opus')).toBe(
      'claude-opus-4-6',
    )
  })

  it('resolveOverriddenModel returns the input unchanged when nothing matches', () => {
    setSettings('modelOverrides', {
      'claude-opus-4-6': 'arn:aws:bedrock:us-east-1/opus',
    })
    expect(resolveOverriddenModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })
})
