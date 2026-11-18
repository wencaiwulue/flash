import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ToolUseContext } from '../src/Tool.ts'
import type { AggregatedHookResult } from '../src/utils/hooks.ts'

let executePreModelSwitchHooks: typeof import('../src/utils/hooks.ts').executePreModelSwitchHooks
let executePostModelSwitchHooks: typeof import('../src/utils/hooks.ts').executePostModelSwitchHooks
let executeMessageDisplayHooks: typeof import('../src/utils/hooks.ts').executeMessageDisplayHooks
let executeDirectoryAddedHooks: typeof import('../src/utils/hooks.ts').executeDirectoryAddedHooks
let executePostToolBatchHooks: typeof import('../src/utils/hooks.ts').executePostToolBatchHooks
let executeUserPromptExpansionHooks: typeof import('../src/utils/hooks.ts').executeUserPromptExpansionHooks
let registerHookCallbacks: typeof import('../src/bootstrap/state.ts').registerHookCallbacks
let clearRegisteredHooks: typeof import('../src/bootstrap/state.ts').clearRegisteredHooks
let setIsInteractive: typeof import('../src/bootstrap/state.ts').setIsInteractive
let getDefaultAppState: typeof import('../src/state/AppStateStore.ts').getDefaultAppState

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
  ;({
    executePreModelSwitchHooks,
    executePostModelSwitchHooks,
    executeMessageDisplayHooks,
    executeDirectoryAddedHooks,
    executePostToolBatchHooks,
    executeUserPromptExpansionHooks,
  } = await import('../src/utils/hooks.ts'))
  ;({ registerHookCallbacks, clearRegisteredHooks, setIsInteractive } =
    await import('../src/bootstrap/state.ts'))
  ;({ getDefaultAppState } = await import('../src/state/AppStateStore.ts'))
  setIsInteractive(false)
})

beforeEach(() => clearRegisteredHooks())
afterEach(() => clearRegisteredHooks())

function registerCommandHook(event: string, json: unknown) {
  registerHookCallbacks({
    [event]: [
      {
        hooks: [
          { type: 'command', command: `echo '${JSON.stringify(json)}'` },
        ],
        pluginRoot: process.cwd(),
        pluginName: 'b1-trigger',
        pluginId: 'b1-trigger@local',
      },
    ],
  })
}

function makeContext() {
  const appState = getDefaultAppState()
  const abortController = new AbortController()
  const toolUseContext = {
    abortController,
    getAppState: () => appState,
  } as unknown as ToolUseContext
  return { appState, toolUseContext }
}

async function drain(
  gen: AsyncGenerator<AggregatedHookResult>,
): Promise<AggregatedHookResult[]> {
  const out: AggregatedHookResult[] = []
  for await (const r of gen) out.push(r)
  return out
}

const modelFields = {
  from_model: 'claude-sonnet-4-6',
  to_model: 'claude-opus-4-6',
  requested_model: 'opus',
  source: 'command' as const,
  context_tokens: 0,
  prompt_cache_warm: false,
  cache_ttl: '5m' as const,
  estimated_cache_write_usd: 0,
  pricing: 'default' as const,
}

describe('B1 trigger points (real command hooks)', () => {
  it('PreModelSwitch deny produces a blockingError (cancels switch)', async () => {
    registerCommandHook('PreModelSwitch', {
      hookSpecificOutput: {
        hookEventName: 'PreModelSwitch',
        permissionDecision: 'deny',
        permissionDecisionReason: 'switch blocked',
      },
    })
    const results = await drain(executePreModelSwitchHooks(modelFields))
    const blocking = results.find(r => r.blockingError)
    expect(blocking?.blockingError?.blockingError).toBe('switch blocked')
  })

  it('PreModelSwitch allow does not block', async () => {
    registerCommandHook('PreModelSwitch', {
      hookSpecificOutput: {
        hookEventName: 'PreModelSwitch',
        permissionDecision: 'allow',
      },
    })
    const results = await drain(executePreModelSwitchHooks(modelFields))
    expect(results.find(r => r.blockingError)).toBeUndefined()
  })

  it('PostModelSwitch yields additionalContext', async () => {
    registerCommandHook('PostModelSwitch', {
      hookSpecificOutput: {
        hookEventName: 'PostModelSwitch',
        additionalContext: 'switched to opus',
      },
    })
    const results = await drain(executePostModelSwitchHooks(modelFields))
    const ctx = results.flatMap(r => r.additionalContexts ?? [])
    expect(ctx).toContain('switched to opus')
  })

  it('MessageDisplay yields displayContent replacement', async () => {
    registerCommandHook('MessageDisplay', {
      hookSpecificOutput: {
        hookEventName: 'MessageDisplay',
        displayContent: 'REPLACED',
      },
    })
    const results = await drain(
      executeMessageDisplayHooks({
        turn_id: 't1',
        message_id: 'm1',
        index: 0,
        final: true,
        delta: 'original',
      }),
    )
    expect(results.find(r => r.displayContent)?.displayContent).toBe('REPLACED')
  })

  it('DirectoryAdded fires without blocking', async () => {
    registerCommandHook('DirectoryAdded', {
      hookSpecificOutput: { hookEventName: 'DirectoryAdded' },
    })
    const results = await drain(
      executeDirectoryAddedHooks('/tmp/some-dir', 'slash_command'),
    )
    expect(results.find(r => r.blockingError)).toBeUndefined()
  })

  it('PostToolBatch yields additionalContext from tool_calls batch', async () => {
    registerCommandHook('PostToolBatch', {
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext: 'batch done',
      },
    })
    const { toolUseContext } = makeContext()
    const results = await drain(
      executePostToolBatchHooks(
        [
          {
            tool_name: 'Read',
            tool_input: { file_path: '/tmp/x' },
            tool_use_id: 'tu1',
            tool_response: 'content',
          },
        ],
        toolUseContext,
      ),
    )
    const ctx = results.flatMap(r => r.additionalContexts ?? [])
    expect(ctx).toContain('batch done')
  })

  it('UserPromptExpansion yields additionalContext and suppressOriginalPrompt', async () => {
    registerCommandHook('UserPromptExpansion', {
      hookSpecificOutput: {
        hookEventName: 'UserPromptExpansion',
        additionalContext: 'expanded ctx',
        suppressOriginalPrompt: true,
      },
    })
    const { toolUseContext } = makeContext()
    const results = await drain(
      executeUserPromptExpansionHooks(
        'slash_command',
        'probe',
        'a b',
        undefined,
        '/probe a b',
        toolUseContext,
      ),
    )
    const ctx = results.flatMap(r => r.additionalContexts ?? [])
    expect(ctx).toContain('expanded ctx')
    expect(results.find(r => r.suppressOriginalPrompt)?.suppressOriginalPrompt).toBe(
      true,
    )
  })

  it('UserPromptExpansion block aborts expansion', async () => {
    registerCommandHook('UserPromptExpansion', {
      decision: 'block',
      reason: 'expansion blocked',
      hookSpecificOutput: { hookEventName: 'UserPromptExpansion' },
    })
    const { toolUseContext } = makeContext()
    const results = await drain(
      executeUserPromptExpansionHooks(
        'slash_command',
        'probe',
        'a b',
        undefined,
        '/probe a b',
        toolUseContext,
      ),
    )
    expect(results.find(r => r.blockingError)).toBeDefined()
  })
})
