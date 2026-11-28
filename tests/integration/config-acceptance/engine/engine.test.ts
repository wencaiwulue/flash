import { describe, test, expect } from 'bun:test'
import { loadHookEntries, isBlocked } from './entries.ts'
import { assertHookEntryResult, type ScenarioResult } from './scenarios.ts'
import { join } from 'path'

const hooksYaml = join(import.meta.dir, '..', 'fixtures', 'hooks.yaml')

describe('mcp_elicitation result validation', () => {
  const entry = loadHookEntries(hooksYaml).find(item => item.id === 'hook:Elicitation')!
  const validResult = {
    hookFired: true,
    marker: null,
    toolExecuted: true,
    stdout: 'CONFIG_MCP_ELICITATION_DONE_33B',
    markersByEvent: {
      Elicitation: { hook_event_name: 'Elicitation' },
      ElicitationResult: {
        hook_event_name: 'ElicitationResult',
        action: 'accept',
        content: { answer: 'CONFIG_ELICITATION_ACCEPT_33B' },
      },
    },
    elicitationFallbackCalls: 0,
    finalElicitationResult: {
      action: 'accept',
      content: { answer: 'CONFIG_ELICITATION_RESULT_ACCEPT_33B' },
    },
  } as ScenarioResult

  test('accepts only independently valid first and final responses', () => {
    expect(() => assertHookEntryResult(entry, validResult)).not.toThrow()
  })

  test('never borrows the ElicitationResult marker for a missing Elicitation', () => {
    const result = {
      ...validResult,
      marker: validResult.markersByEvent!.ElicitationResult!,
      markersByEvent: {
        ElicitationResult: validResult.markersByEvent!.ElicitationResult!,
      },
    }
    expect(() => assertHookEntryResult(entry, result)).toThrow(/hook:Elicitation hook_fired/)
  })

  test('rejects ElicitationResult converting a fallback into an apparent first response', () => {
    const result = {
      ...validResult,
      elicitationFallbackCalls: 1,
      markersByEvent: {
        ...validResult.markersByEvent,
        ElicitationResult: {
          ...validResult.markersByEvent!.ElicitationResult!,
          content: { answer: 'CONFIG_ELICITATION_FALLBACK_33B' },
        },
      },
    } as ScenarioResult
    expect(() => assertHookEntryResult(entry, result)).toThrow(/first response|fallback/)
  })

  test('rejects content other than the ElicitationResult final response', () => {
    const result = {
      ...validResult,
      finalElicitationResult: {
        action: 'accept',
        content: { answer: 'WRONG_FINAL_CONTENT' },
      },
    } as ScenarioResult
    expect(() => assertHookEntryResult(entry, result)).toThrow(/final response/)
  })
})

describe('loadHookEntries', () => {
  test('loads entries with ids and preserves field values', () => {
    const entries = loadHookEntries(hooksYaml)
    expect(entries.length).toBe(33)

    // Verify all 27 core events from HOOK_EVENTS are present
    const coreEvents = [
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
      'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
      'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact',
      'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle',
      'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult',
      'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded',
      'CwdChanged', 'FileChanged',
    ]
    const eventNames = entries.map(e => e.event)
    for (const event of coreEvents) {
      expect(eventNames).toContain(event)
    }

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

  test('preserves the mcp_elicitation trigger', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(join(tmpdir(), 'ca-elicit-'))
    const yaml = join(dir, 'elicitation.yaml')
    await writeFile(yaml, `- event: Elicitation\n  status: active\n  trigger: mcp_elicitation\n  matcher: '*'\n  exit_semantics: nonblock\n  expected_effect:\n    hook_fired: true\n`)
    try {
      const [entry] = loadHookEntries(yaml)
      expect(entry).toMatchObject({
        id: 'hook:Elicitation',
        status: 'active',
        trigger: 'mcp_elicitation',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
