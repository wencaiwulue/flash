import { describe, expect, it } from 'bun:test'
import { SettingsSchema } from '../src/utils/settings/types.ts'

// Upstream 2.1.311 worktree.* (Any file). flash implements symlinkDirectories
// and sparsePaths (read in worktree.ts: symlinkDirectories ?? [] at :583-586,
// sparsePaths -> git sparse-checkout --cone at :323-354). baseRef/bgIsolation/
// location are functional gaps (no zod). These tests pin the schema layer.
describe('worktree schema', () => {
  it('accepts symlinkDirectories/sparsePaths string arrays', () => {
    const parsed = SettingsSchema().parse({
      worktree: {
        symlinkDirectories: ['node_modules', '.cache'],
        sparsePaths: ['src', 'docs'],
      },
    })
    expect(parsed.worktree?.symlinkDirectories).toEqual([
      'node_modules',
      '.cache',
    ])
    expect(parsed.worktree?.sparsePaths).toEqual(['src', 'docs'])
  })

  it('rejects a non-array worktree.symlinkDirectories', () => {
    expect(() =>
      SettingsSchema().parse({ worktree: { symlinkDirectories: 'node_modules' } }),
    ).toThrow()
  })

  it('rejects a non-array worktree.sparsePaths', () => {
    expect(() =>
      SettingsSchema().parse({ worktree: { sparsePaths: 'src' } }),
    ).toThrow()
  })
})
