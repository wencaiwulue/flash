import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { StopHookInput } from '../src/entrypoints/agentSdkTypes.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { AggregatedHookResult, HookResult } from '../src/utils/hooks.ts'

const execPromptHook = mock()
const execAgentHook = mock()

mock.module('../src/utils/hooks/execPromptHook.ts', () => ({
  execPromptHook,
}))
mock.module('../src/utils/hooks/execAgentHook.ts', () => ({
  execAgentHook,
}))

let executeHooksOutsideREPL: typeof import('../src/utils/hooks.ts').executeHooksOutsideREPL
let executeStopHooks: typeof import('../src/utils/hooks.ts').executeStopHooks
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
  ;({ executeHooksOutsideREPL, executeStopHooks } = await import(
    '../src/utils/hooks.ts'
  ))
  ;({ registerHookCallbacks, clearRegisteredHooks, setIsInteractive } =
    await import('../src/bootstrap/state.ts'))
  ;({ getDefaultAppState } = await import('../src/state/AppStateStore.ts'))
  setIsInteractive(false)
})

beforeEach(() => {
  clearRegisteredHooks()
})

afterEach(() => {
  execPromptHook.mockReset()
  execAgentHook.mockReset()
  clearRegisteredHooks()
})

function modelResult(
  type: 'prompt' | 'agent',
  outcome: HookResult['outcome'],
  blockingError?: string,
): HookResult {
  return {
    hook: { type, prompt: `${type} prompt` },
    outcome,
    ...(blockingError
      ? {
          blockingError: {
            blockingError,
            command: `${type} prompt`,
          },
          ...(type === 'prompt'
            ? { preventContinuation: true, stopReason: blockingError }
            : {}),
        }
      : {}),
  }
}

function registerModelHook(
  event: 'Stop' | 'Notification',
  type: 'prompt' | 'agent',
) {
  const hook = { type, prompt: `${type} prompt` }
  registerHookCallbacks({
    [event]: [
      {
        hooks: [hook],
        pluginRoot: '/tmp/headless-hooks-test',
        pluginName: 'headless-hooks-test',
        pluginId: 'headless-hooks-test@local',
      },
    ],
  })
  return hook
}

function createContext() {
  const appState = getDefaultAppState()
  const abortController = new AbortController()
  const toolUseContext = {
    abortController,
    getAppState: () => appState,
  } as unknown as ToolUseContext
  return { appState, abortController, toolUseContext }
}

function stopInput(): StopHookInput {
  return {
    session_id: 'headless-hooks-test',
    transcript_path: '/tmp/headless-hooks-test.jsonl',
    cwd: process.cwd(),
    hook_event_name: 'Stop',
    stop_hook_active: false,
  }
}

async function runStopHook(type: 'prompt' | 'agent') {
  const { appState, toolUseContext } = createContext()
  return executeHooksOutsideREPL({
    getAppState: () => appState,
    hookInput: stopInput(),
    timeoutMs: 1_000,
    toolUseContext,
    messages: [],
  })
}

describe.each(['prompt', 'agent'] as const)('headless %s stop hooks', type => {
  test('maps an allowed model decision to a successful result', async () => {
    registerModelHook('Stop', type)
    const executor = type === 'prompt' ? execPromptHook : execAgentHook
    executor.mockResolvedValue(modelResult(type, 'success'))

    const results = await runStopHook(type)

    expect(results).toEqual([
      {
        command: `${type} prompt`,
        succeeded: true,
        output: '',
        blocked: false,
        systemMessage: undefined,
        preventContinuation: undefined,
        stopReason: undefined,
      },
    ])
    expect(executor).toHaveBeenCalledTimes(1)
    expect(executor.mock.calls[0][2]).toBe('Stop')
    expect(JSON.parse(executor.mock.calls[0][3])).toMatchObject({
      hook_event_name: 'Stop',
      stop_hook_active: false,
    })
  })

  test('maps a structured block decision and reason', async () => {
    registerModelHook('Stop', type)
    const reason = `${type} condition was not met`
    const executor = type === 'prompt' ? execPromptHook : execAgentHook
    executor.mockResolvedValue(modelResult(type, 'blocking', reason))

    const results = await runStopHook(type)

    expect(results).toEqual([
      {
        command: `${type} prompt`,
        succeeded: true,
        output: reason,
        blocked: true,
        systemMessage: undefined,
        preventContinuation: type === 'prompt' ? true : undefined,
        stopReason: type === 'prompt' ? reason : undefined,
      },
    ])
  })

  test('executeStopHooks awaits and preserves the model decision', async () => {
    registerModelHook('Stop', type)
    const reason = `${type} headless decision`
    const executor = type === 'prompt' ? execPromptHook : execAgentHook
    executor.mockResolvedValue(modelResult(type, 'blocking', reason))
    const { abortController, toolUseContext } = createContext()

    const results: AggregatedHookResult[] = []
    for await (const result of executeStopHooks(
      'default',
      abortController.signal,
      1_000,
      false,
      undefined,
      toolUseContext,
      [],
    )) {
      results.push(result)
    }

    const blockingResult = {
      blockingError: {
        blockingError: reason,
        command: `${type} prompt`,
      },
    }
    expect(results[0]?.message).toMatchObject({
      type: 'progress',
      data: {
        type: 'hook_progress',
        hookEvent: 'Stop',
        command: `${type} prompt`,
      },
    })
    const decisions = results.filter(
      result => result.message?.type !== 'progress',
    )
    expect(decisions).toEqual(
      type === 'prompt'
        ? [
            { preventContinuation: true, stopReason: reason },
            blockingResult,
          ]
        : [blockingResult],
    )
    expect(executor).toHaveBeenCalledTimes(1)
  })

  test('returns model failures without blocking', async () => {
    registerModelHook('Stop', type)
    const executor = type === 'prompt' ? execPromptHook : execAgentHook
    const output = `Error executing ${type} hook: model failed`
    executor.mockResolvedValue({
      ...modelResult(type, 'non_blocking_error'),
      message: {
        type: 'attachment',
        attachment: {
          type: 'hook_non_blocking_error',
          hookName: 'Stop',
          hookEvent: 'Stop',
          toolUseID: 'hook-tool-use-id',
          stderr: output,
          stdout: '',
          exitCode: 1,
        },
      } as HookResult['message'],
    })

    const results = await runStopHook(type)

    expect(results).toEqual([
      {
        command: `${type} prompt`,
        succeeded: false,
        output,
        blocked: false,
        systemMessage: undefined,
        preventContinuation: undefined,
        stopReason: undefined,
        message: expect.objectContaining({
          type: 'attachment',
          attachment: expect.objectContaining({
            type: 'hook_non_blocking_error',
            stderr: output,
          }),
        }),
      },
    ])
  })

  test('propagates cancellation through the model abort signal', async () => {
    registerModelHook('Stop', type)
    const { appState, abortController, toolUseContext } = createContext()
    const executor = type === 'prompt' ? execPromptHook : execAgentHook
    let modelSignal: AbortSignal | undefined
    executor.mockImplementation(
      async (
        _hook: unknown,
        _hookName: unknown,
        _hookEvent: unknown,
        _jsonInput: unknown,
        signal: AbortSignal,
      ) => {
        modelSignal = signal
        return new Promise<HookResult>(resolve => {
          signal.addEventListener(
            'abort',
            () => resolve(modelResult(type, 'cancelled')),
            { once: true },
          )
        })
      },
    )

    const pending = executeHooksOutsideREPL({
      getAppState: () => appState,
      hookInput: stopInput(),
      signal: abortController.signal,
      timeoutMs: 1_000,
      toolUseContext,
      messages: [],
    })
    while (!modelSignal) {
      await new Promise(resolve => setImmediate(resolve))
    }
    abortController.abort()

    expect(await pending).toEqual([
      {
        command: `${type} prompt`,
        succeeded: false,
        output: 'Hook cancelled',
        blocked: false,
        systemMessage: undefined,
        preventContinuation: undefined,
        stopReason: undefined,
      },
    ])
    expect(modelSignal.aborted).toBe(true)
  })
})

test('leaves non-Stop prompt and agent hooks unsupported', async () => {
  registerModelHook('Notification', 'prompt')
  registerModelHook('Notification', 'agent')
  const { appState, toolUseContext } = createContext()

  const results = await executeHooksOutsideREPL({
    getAppState: () => appState,
    hookInput: {
      session_id: 'headless-hooks-test',
      transcript_path: '/tmp/headless-hooks-test.jsonl',
      cwd: process.cwd(),
      hook_event_name: 'Notification',
      message: 'notification',
      notification_type: 'test',
    },
    timeoutMs: 1_000,
    toolUseContext,
  })

  expect(results).toEqual([
    {
      command: 'prompt prompt',
      succeeded: false,
      output: 'Prompt stop hooks are not yet supported outside REPL',
      blocked: false,
    },
    {
      command: 'agent prompt',
      succeeded: false,
      output: 'Agent stop hooks are not yet supported outside REPL',
      blocked: false,
    },
  ])
  expect(execPromptHook).not.toHaveBeenCalled()
  expect(execAgentHook).not.toHaveBeenCalled()
})
