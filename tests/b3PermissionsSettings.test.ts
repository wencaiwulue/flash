import { afterEach, describe, expect, it } from 'bun:test'
import { PermissionsSchema } from '../src/utils/settings/types.ts'
import { initialPermissionModeFromCLI } from '../src/utils/permissions/permissionSetup.ts'
import { setSessionSettingsCache } from '../src/utils/settings/settingsCache.ts'

// Upstream 2.1.311 permissions.* schema alignment (Any file scope). Runtime
// fail-closed semantics (deny-first, remote defaultMode restriction,
// disableBypassPermissionsMode) live in permissionSetup.ts; these tests pin the
// schema/type layer for each sub-field.
describe('permissions schema', () => {
  it('accepts allow/deny/ask rule-string arrays', () => {
    const parsed = PermissionsSchema().parse({
      allow: ['Bash(ls)'],
      deny: ['Read(/etc/passwd)'],
      ask: ['Bash(rm)'],
    })
    expect(parsed.allow).toEqual(['Bash(ls)'])
    expect(parsed.deny).toEqual(['Read(/etc/passwd)'])
    expect(parsed.ask).toEqual(['Bash(rm)'])
  })

  it('rejects a non-array allow', () => {
    expect(() => PermissionsSchema().parse({ allow: 'Bash(ls)' })).toThrow()
  })

  it('accepts a valid defaultMode and rejects an invalid one', () => {
    const parsed = PermissionsSchema().parse({ defaultMode: 'plan' })
    expect(parsed.defaultMode).toBe('plan')
    expect(() => PermissionsSchema().parse({ defaultMode: 'bogus' })).toThrow()
  })

  it('accepts disableBypassPermissionsMode "disable" and rejects others', () => {
    const parsed = PermissionsSchema().parse({
      disableBypassPermissionsMode: 'disable',
    })
    expect(parsed.disableBypassPermissionsMode).toBe('disable')
    expect(() =>
      PermissionsSchema().parse({ disableBypassPermissionsMode: 'yes' }),
    ).toThrow()
  })

  it('accepts additionalDirectories as a string array and rejects non-strings', () => {
    const parsed = PermissionsSchema().parse({
      additionalDirectories: ['/tmp', '/var'],
    })
    expect(parsed.additionalDirectories).toEqual(['/tmp', '/var'])
    expect(() =>
      PermissionsSchema().parse({ additionalDirectories: [42] }),
    ).toThrow()
  })
})

// Fail-closed resolution in initialPermissionModeFromCLI. Statsig gates default
// to false in tests, so the settings-driven fail-closed paths are exercised.
describe('permissions fail-closed resolution', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_REMOTE
  })

  it('honors an allowed defaultMode', () => {
    setSessionSettingsCache({
      settings: { permissions: { defaultMode: 'acceptEdits' } } as never,
      errors: [],
    })
    const r = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
    })
    expect(r.mode).toBe('acceptEdits')
  })

  it('fail-closed: bypassPermissions is skipped when disabled by settings', () => {
    setSessionSettingsCache({
      settings: {
        permissions: {
          defaultMode: 'bypassPermissions',
          disableBypassPermissionsMode: 'disable',
        },
      } as never,
      errors: [],
    })
    const r = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
    })
    expect(r.mode).not.toBe('bypassPermissions')
    expect(r.notification).toMatch(/disabled/i)
  })

  it('fail-closed: remote ignores a bypassPermissions defaultMode', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    setSessionSettingsCache({
      settings: {
        permissions: { defaultMode: 'bypassPermissions' },
      } as never,
      errors: [],
    })
    const r = initialPermissionModeFromCLI({
      permissionModeCli: undefined,
      dangerouslySkipPermissions: false,
    })
    expect(r.mode).not.toBe('bypassPermissions')
  })
})
