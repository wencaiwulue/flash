import { describe, expect, it } from 'bun:test'
import { SettingsSchema } from '../src/utils/settings/types.ts'

// B2 statusLine (upstream 2.1.311): object with type:"command", command string,
// optional padding (number), refreshInterval (number, min 1), hideVimModeIndicator
// (boolean). Managed-only restriction is enforced in executeStatusLineCommand
// (shouldAllowManagedHooksOnly/shouldDisableAllHooksIncludingManaged), covered by
// the hook compatibility suites.
describe('B2 statusLine schema', () => {
  it('parses a full statusLine config including refreshInterval + hideVimModeIndicator', () => {
    const parsed = SettingsSchema().parse({
      statusLine: {
        type: 'command',
        command: 'my-status',
        padding: 2,
        refreshInterval: 5,
        hideVimModeIndicator: true,
      },
    })
    expect(parsed.statusLine?.refreshInterval).toBe(5)
    expect(parsed.statusLine?.hideVimModeIndicator).toBe(true)
    expect(parsed.statusLine?.padding).toBe(2)
  })

  it('accepts a minimal statusLine without the optional fields', () => {
    const parsed = SettingsSchema().parse({
      statusLine: { type: 'command', command: 'my-status' },
    })
    expect(parsed.statusLine?.refreshInterval).toBeUndefined()
    expect(parsed.statusLine?.hideVimModeIndicator).toBeUndefined()
  })

  it('rejects refreshInterval below the minimum of 1', () => {
    expect(() =>
      SettingsSchema().parse({
        statusLine: { type: 'command', command: 'x', refreshInterval: 0 },
      }),
    ).toThrow()
  })
})
