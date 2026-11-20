import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'
import { SettingsSchema } from '../src/utils/settings/types.ts'

// attribution.ts pulls in tool prompt constants that circular-import
// REPLTool/constants.ts (FILE_READ_TOOL_NAME before initialization). Stub the
// FileReadTool prompt module, then dynamically import attribution.ts so the
// mock is registered before its module graph loads.
mock.module('../src/tools/FileReadTool/prompt.js', () => ({
  FILE_READ_TOOL_NAME: 'Read',
}))

const { getAttributionTexts } = await import('../src/utils/attribution.ts')

// Upstream 2.1.311 attribution: object {commit, pr, sessionUrl} | false, scope
// Any file. commit/pr default to the standard attribution; empty string hides
// attribution; false (v2.1.281+) hides all attribution; sessionUrl defaults to
// true and controls the claude.ai session link in cloud/Remote Control commits.
function setSettings(settings: Record<string, unknown>): void {
  setSessionSettingsCache({ settings, errors: [] })
}

describe('attribution schema (object | false, sessionUrl)', () => {
  it('accepts an object with commit/pr/sessionUrl', () => {
    expect(
      SettingsSchema().parse({
        attribution: { commit: 'C', pr: 'P', sessionUrl: false },
      }).attribution,
    ).toEqual({ commit: 'C', pr: 'P', sessionUrl: false })
  })

  it('accepts false to hide all attribution', () => {
    expect(SettingsSchema().parse({ attribution: false }).attribution).toBe(false)
  })

  it('rejects a non-boolean sessionUrl', () => {
    expect(() =>
      SettingsSchema().parse({ attribution: { sessionUrl: 'yes' } }),
    ).toThrow()
  })
})

describe('getAttributionTexts', () => {
  beforeEach(() => {
    setSettings({})
  })

  it('attribution: false hides all attribution', () => {
    setSettings({ attribution: false })
    expect(getAttributionTexts()).toEqual({ commit: '', pr: '' })
  })

  it('custom commit/pr are used verbatim', () => {
    setSettings({ attribution: { commit: 'My Commit', pr: 'My PR' } })
    expect(getAttributionTexts()).toEqual({ commit: 'My Commit', pr: 'My PR' })
  })

  it('empty strings hide attribution', () => {
    setSettings({ attribution: { commit: '', pr: '' } })
    expect(getAttributionTexts()).toEqual({ commit: '', pr: '' })
  })

  it('deprecated includeCoAuthoredBy: false hides attribution', () => {
    setSettings({ includeCoAuthoredBy: false })
    expect(getAttributionTexts()).toEqual({ commit: '', pr: '' })
  })

  it('default includes Co-Authored-By and Generated with', () => {
    const { commit, pr } = getAttributionTexts()
    expect(commit).toContain('Co-Authored-By:')
    expect(pr).toContain('Generated with')
  })
})
