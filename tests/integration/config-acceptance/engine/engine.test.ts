import { describe, test, expect } from 'bun:test'
import { loadHookEntries, isBlocked } from './entries.ts'
import { join } from 'path'

const hooksYaml = join(import.meta.dir, '..', 'fixtures', 'hooks.yaml')

describe('loadHookEntries', () => {
  test('loads entries with ids and preserves field values', () => {
    const entries = loadHookEntries(hooksYaml)
    expect(entries.length).toBeGreaterThanOrEqual(14)

    // Check that all expected entries exist and have correct fields
    const preToolUse = entries.find(e => e.id === 'hook:PreToolUse')
    expect(preToolUse).toBeDefined()
    expect(preToolUse?.event).toBe('PreToolUse')
    expect(preToolUse?.trigger).toBe('tool_call_unsafe_block')
    expect(preToolUse?.matcher).toBe('*')
    expect(preToolUse?.exit_semantics).toBe('block')
    expect(preToolUse?.status).toBe('active')

    const postToolUse = entries.find(e => e.id === 'hook:PostToolUse')
    expect(postToolUse).toBeDefined()
    expect(postToolUse?.event).toBe('PostToolUse')
    expect(postToolUse?.trigger).toBe('tool_call_safe')
    expect(postToolUse?.matcher).toBe('*')
    expect(postToolUse?.exit_semantics).toBe('nonblock')
    expect(postToolUse?.status).toBe('active')

    const postToolUseFailure = entries.find(e => e.id === 'hook:PostToolUseFailure')
    expect(postToolUseFailure).toBeDefined()

    const userPromptSubmit = entries.find(e => e.id === 'hook:UserPromptSubmit')
    expect(userPromptSubmit).toBeDefined()

    const sessionStart = entries.find(e => e.id === 'hook:SessionStart')
    expect(sessionStart).toBeDefined()

    const setup = entries.find(e => e.id === 'hook:Setup')
    expect(setup).toBeDefined()

    const stop = entries.find(e => e.id === 'hook:Stop')
    expect(stop).toBeDefined()

    const notification = entries.find(e => e.id === 'hook:Notification')
    expect(notification).toBeDefined()

    const permissionRequest = entries.find(e => e.id === 'hook:PermissionRequest')
    expect(permissionRequest).toBeDefined()

    const permissionDenied = entries.find(e => e.id === 'hook:PermissionDenied')
    expect(permissionDenied).toBeDefined()

    const sessionEnd = entries.find(e => e.id === 'hook:SessionEnd')
    expect(sessionEnd).toBeDefined()

    const stopFailure = entries.find(e => e.id === 'hook:StopFailure')
    expect(stopFailure).toBeDefined()

    const instructionsLoaded = entries.find(e => e.id === 'hook:InstructionsLoaded')
    expect(instructionsLoaded).toBeDefined()

    const userPromptExpansion = entries.find(e => e.id === 'hook:UserPromptExpansion')
    expect(userPromptExpansion).toBeDefined()

    // Verify all ids are unique
    const ids = entries.map(e => e.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
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
