import { describe, test, expect } from 'bun:test'
import { loadHookEntries, isBlocked } from './entries.ts'
import { join } from 'path'

const hooksYaml = join(import.meta.dir, '..', 'fixtures', 'hooks.yaml')

describe('loadHookEntries', () => {
  test('loads entries with ids and preserves order', () => {
    const entries = loadHookEntries(hooksYaml)
    expect(entries.length).toBe(3)
    expect(entries[0].id).toBe('hook:PreToolUse')
    expect(entries[2].id).toBe('hook:UserPromptExpansion')
    expect(entries[0].trigger).toBe('tool_call_unsafe_block')
  })

  test('unknown trigger throws with entry id', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'ca-bad-'))
    const bad = join(dir, 'bad.yaml')
    await writeFile(bad, `- event: PreToolUse\n  status: active\n  trigger: bogus_trigger\n  matcher: '*'\n  exit_semantics: block\n  expected_effect: {}\n`)
    try {
      expect(() => loadHookEntries(bad)).toThrow(/hook:PreToolUse/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('isBlocked classifies statuses', () => {
    expect(isBlocked('active')).toBe(false)
    expect(isBlocked('blocked-by-batch:B0')).toBe(true)
    expect(isBlocked('blocked-by-prereq:mcp-elicit-server')).toBe(true)
    expect(isBlocked('form:source')).toBe(true)
  })
})
