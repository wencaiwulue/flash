import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as settingsModule from '../src/utils/settings/settings.ts'
import { shouldAllowManagedHooksOnly } from '../src/utils/hooks/hooksConfigSnapshot.ts'

// Upstream 2.1.311 allowManagedHooksOnly: Scope Managed, Type Boolean, Default
// unset (hooks from every scope + plugin run). flash reads policySettings only
// (managed), so a user/project/local settings file cannot enable it — a
// fail-closed guard against privilege escalation. When on, only managed hooks
// run. settingsModule is imported as a module object so spyOn works (per
// hooksConfigSnapshot.ts's own note).
const spies: Array<{ mockRestore: () => void }> = []

function mockSettings(policy: unknown, merged: unknown): void {
  spies.push(
    spyOn(settingsModule, 'getSettingsForSource').mockReturnValue(
      policy as never,
    ),
  )
  spies.push(
    spyOn(settingsModule, 'getSettings_DEPRECATED').mockReturnValue(
      merged as never,
    ),
  )
}

describe('allowManagedHooksOnly (managed-only fail-closed)', () => {
  afterEach(() => {
    spies.forEach(s => s.mockRestore())
    spies.length = 0
  })

  it('true when managed (policySettings) sets allowManagedHooksOnly', () => {
    mockSettings({ allowManagedHooksOnly: true }, {})
    expect(shouldAllowManagedHooksOnly()).toBe(true)
  })

  it('false when unset (default: all-scope hooks run)', () => {
    mockSettings(undefined, {})
    expect(shouldAllowManagedHooksOnly()).toBe(false)
  })

  it('false when only a non-managed source sets it (scope is Managed)', () => {
    // allowManagedHooksOnly lives in merged (non-managed) settings, but
    // policySettings does not set it -> must NOT restrict to managed-only.
    mockSettings(undefined, { allowManagedHooksOnly: true })
    expect(shouldAllowManagedHooksOnly()).toBe(false)
  })

  it('fail-closed: non-managed disableAllHooks forces managed-only', () => {
    // disableAllHooks set outside managed settings cannot disable managed
    // hooks, so the effective behavior becomes managed-only.
    mockSettings(undefined, { disableAllHooks: true })
    expect(shouldAllowManagedHooksOnly()).toBe(true)
  })

  it('managed disableAllHooks does not take the non-managed branch', () => {
    // managed disableAllHooks returns {} earlier (handled by caller); the
    // managed-only predicate is driven by allowManagedHooksOnly here.
    mockSettings({ disableAllHooks: true }, { disableAllHooks: true })
    expect(shouldAllowManagedHooksOnly()).toBe(false)
  })
})
