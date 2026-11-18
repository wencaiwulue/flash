import { beforeAll, describe, expect, it } from 'bun:test'
import type { HookEvent } from '../src/utils/hooks.ts'

let processHookJSONOutput: typeof import('../src/utils/hooks.ts').processHookJSONOutput

beforeAll(async () => {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '1.0.0',
      BUILD_TIME: '',
      PACKAGE_URL: '',
      NATIVE_PACKAGE_URL: '',
      VERSION_CHANGELOG: '',
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
    },
  })
  ;({ processHookJSONOutput } = await import('../src/utils/hooks.ts'))
})

function parse(event: HookEvent, hso: Record<string, unknown> | undefined) {
  return processHookJSONOutput({
    json: (hso
      ? { hookSpecificOutput: { hookEventName: event, ...hso } }
      : {}) as never,
    command: 'cmd',
    hookName: 'test',
    toolUseID: 'id',
    hookEvent: event,
    expectedHookEvent: event,
  })
}

describe('B1 six hook events — hookSpecificOutput extraction', () => {
  it('UserPromptExpansion extracts additionalContext and suppressOriginalPrompt', () => {
    const r = parse('UserPromptExpansion', {
      additionalContext: 'extra',
      suppressOriginalPrompt: true,
    })
    expect(r.additionalContext).toBe('extra')
    expect(r.suppressOriginalPrompt).toBe(true)
  })

  it('UserPromptExpansion suppressOriginalPrompt defaults to undefined', () => {
    const r = parse('UserPromptExpansion', { additionalContext: 'x' })
    expect(r.suppressOriginalPrompt).toBeUndefined()
  })

  it('PostToolBatch extracts additionalContext', () => {
    const r = parse('PostToolBatch', { additionalContext: 'batch ctx' })
    expect(r.additionalContext).toBe('batch ctx')
  })

  it('PostModelSwitch extracts additionalContext', () => {
    const r = parse('PostModelSwitch', { additionalContext: 'switched' })
    expect(r.additionalContext).toBe('switched')
  })

  it('MessageDisplay extracts displayContent', () => {
    const r = parse('MessageDisplay', { displayContent: 'replacement' })
    expect(r.displayContent).toBe('replacement')
  })

  it('PreModelSwitch deny sets blockingError, deny behavior, and reason', () => {
    const r = parse('PreModelSwitch', {
      permissionDecision: 'deny',
      permissionDecisionReason: 'no switch',
    })
    expect(r.permissionBehavior).toBe('deny')
    expect(r.blockingError?.blockingError).toBe('no switch')
    expect(r.hookPermissionDecisionReason).toBe('no switch')
  })

  it('PreModelSwitch deny falls back to default reason', () => {
    const r = parse('PreModelSwitch', { permissionDecision: 'deny' })
    expect(r.permissionBehavior).toBe('deny')
    expect(r.blockingError?.blockingError).toContain('PreModelSwitch')
  })

  it('PreModelSwitch allow/ask map to permissionBehavior without blocking', () => {
    const allow = parse('PreModelSwitch', { permissionDecision: 'allow' })
    expect(allow.permissionBehavior).toBe('allow')
    expect(allow.blockingError).toBeUndefined()
    const ask = parse('PreModelSwitch', { permissionDecision: 'ask' })
    expect(ask.permissionBehavior).toBe('ask')
    expect(ask.blockingError).toBeUndefined()
  })

  it('DirectoryAdded has no hookSpecificOutput fields', () => {
    const r = parse('DirectoryAdded', undefined)
    expect(r.additionalContext).toBeUndefined()
    expect(r.displayContent).toBeUndefined()
    expect(r.suppressOriginalPrompt).toBeUndefined()
  })

  it('continue:false sets preventContinuation for PostToolBatch', () => {
    const r = processHookJSONOutput({
      json: {
        continue: false,
        stopReason: 'halt',
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch',
          additionalContext: 'x',
        },
      } as never,
      command: 'cmd',
      hookName: 'test',
      toolUseID: 'id',
      hookEvent: 'PostToolBatch',
      expectedHookEvent: 'PostToolBatch',
    })
    expect(r.preventContinuation).toBe(true)
    expect(r.stopReason).toBe('halt')
    expect(r.additionalContext).toBe('x')
  })
})
