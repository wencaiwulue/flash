import { describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  HookCallback,
  HookCallbackMatcher,
  Options,
  PostToolUseHookInput,
  PreToolUseHookInput,
  UserPromptSubmitHookInput,
} from '../../../src/entrypoints/agentSdkTypes.js'
import { createSdkHarness } from '../support/sdk.ts'

const TEST_TIMEOUT_MS = 20_000

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('classic SDK options.hooks', () => {
  test('runs matching prompt/pre/post callbacks with real payloads and applies updatedInput', async () => {
    const harness = await createSdkHarness()
    try {
      const toolUseId = 'tool-sdk-hooks-allow-33a'
      const outputPath = join(harness.sandbox.project, 'hook-allowed.txt')
      const originalMarker = 'SDK_HOOK_ORIGINAL_33A'
      const updatedMarker = 'SDK_HOOK_UPDATED_33A'
      const originalCommand = `printf '%s' '${originalMarker}' | tee ${JSON.stringify(outputPath)}`
      const updatedCommand = `printf '%s' '${updatedMarker}' | tee ${JSON.stringify(outputPath)}`
      const prompt = 'Run the hooked tool 33A.'
      const order: string[] = []
      let promptInput: UserPromptSubmitHookInput | undefined
      let preInput: PreToolUseHookInput | undefined
      let postInput: PostToolUseHookInput | undefined
      let promptSignal: AbortSignal | undefined
      let preSignal: AbortSignal | undefined
      let postSignal: AbortSignal | undefined
      let preCallbackToolUseId: string | undefined
      let postCallbackToolUseId: string | undefined
      let nonMatchingCalls = 0

      const nonMatchingCallback: HookCallback = async () => {
        nonMatchingCalls++
        return {}
      }
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command: originalCommand, description: 'Original hook input' },
        },
        { type: 'text', text: 'SDK_HOOK_ALLOW_DONE_33A' },
      )
      const query = harness.track(harness.sdk.query({
        prompt,
        options: {
          ...harness.baseOptions,
          tools: ['Bash'],
          persistSession: false,
          hooks: {
            UserPromptSubmit: [{
              hooks: [async (input, _toolUseID, { signal }) => {
                order.push('prompt')
                promptInput = input as UserPromptSubmitHookInput
                promptSignal = signal
                return { continue: true }
              }],
            }],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [async (input, callbackToolUseID, { signal }) => {
                  order.push('pre')
                  preInput = input as PreToolUseHookInput
                  preCallbackToolUseId = callbackToolUseID
                  preSignal = signal
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'allow',
                      permissionDecisionReason: 'SDK hook allow 33A',
                      updatedInput: {
                        ...(input as PreToolUseHookInput).tool_input,
                        command: updatedCommand,
                      },
                    },
                  }
                }],
              },
              { matcher: 'Write', hooks: [nonMatchingCallback] },
            ],
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [async (input, callbackToolUseID, { signal }) => {
                  order.push('post')
                  postInput = input as PostToolUseHookInput
                  postCallbackToolUseId = callbackToolUseID
                  postSignal = signal
                  return {}
                }],
              },
              { matcher: 'Edit', hooks: [nonMatchingCallback] },
            ],
          },
        },
      }))

      const first = await harness.collect(query)
      expect(first.error).toBeUndefined()
      expect(order).toEqual(['prompt', 'pre', 'post'])
      expect(nonMatchingCalls).toBe(0)
      expect(promptInput).toMatchObject({
        hook_event_name: 'UserPromptSubmit',
        prompt,
      })
      expect(preInput).toMatchObject({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: originalCommand },
        tool_use_id: toolUseId,
      })
      expect(preCallbackToolUseId).toBe(toolUseId)
      expect(postInput).toMatchObject({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: updatedCommand },
        tool_use_id: toolUseId,
      })
      expect(JSON.stringify(postInput?.tool_response)).toContain(updatedMarker)
      expect(postCallbackToolUseId).toBe(toolUseId)
      for (const signal of [promptSignal, preSignal, postSignal]) {
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal?.aborted).toBe(false)
      }
      expect(await readFile(outputPath, 'utf8')).toBe(updatedMarker)

      harness.mock.enqueue({ type: 'text', text: 'SDK_HOOK_NO_HOOKS_33A' })
      const withoutHooks = harness.track(harness.sdk.query({
        prompt: 'No callbacks should leak into this query.',
        options: { ...harness.baseOptions, tools: [], persistSession: false },
      }))
      const second = await harness.collect(withoutHooks)
      expect(second.error).toBeUndefined()
      expect(order).toEqual(['prompt', 'pre', 'post'])
      expect(nonMatchingCalls).toBe(0)
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('PreToolUse deny blocks the real side effect and returns its reason to the model', async () => {
    const harness = await createSdkHarness()
    try {
      const toolUseId = 'tool-sdk-hooks-deny-33a'
      const denialReason = 'SDK_HOOK_DENY_33A'
      const outputPath = join(harness.sandbox.project, 'hook-denied.txt')
      const command = `printf '%s' 'SHOULD_NOT_EXIST_33A' > ${JSON.stringify(outputPath)}`
      let preCalls = 0
      let postCalls = 0
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command, description: 'Denied by SDK hook' },
        },
        { type: 'text', text: 'SDK_HOOK_DENY_DONE_33A' },
      )
      const query = harness.track(harness.sdk.query({
        prompt: 'Attempt the denied hooked tool.',
        options: {
          ...harness.baseOptions,
          tools: ['Bash'],
          persistSession: false,
          hooks: {
            PreToolUse: [{
              matcher: 'Bash',
              hooks: [async input => {
                preCalls++
                expect(input).toMatchObject({
                  hook_event_name: 'PreToolUse',
                  tool_name: 'Bash',
                  tool_input: { command },
                  tool_use_id: toolUseId,
                })
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: denialReason,
                  },
                }
              }],
            }],
            PostToolUse: [{
              matcher: 'Bash',
              hooks: [async () => {
                postCalls++
                return {}
              }],
            }],
          },
        },
      }))

      const { messages, error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(preCalls).toBe(1)
      expect(postCalls).toBe(0)
      await expectMissing(outputPath)
      expect(JSON.stringify(messages)).toContain(denialReason)
      expect(harness.mock.requests).toHaveLength(2)
      expect(JSON.stringify(harness.mock.requests[1]?.body)).toContain(denialReason)
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('closing A twice preserves B when both queries share one matcher and hooks array', async () => {
    const harness = await createSdkHarness()
    try {
      const calls: string[] = []
      const sharedHooks: HookCallback[] = [async input => {
        if (input.hook_event_name === 'UserPromptSubmit') calls.push(input.prompt)
        return {}
      }]
      const sharedMatcher: HookCallbackMatcher = { hooks: sharedHooks }
      const options = (): Options => ({
        ...harness.baseOptions,
        tools: [],
        persistSession: false,
        hooks: { UserPromptSubmit: [sharedMatcher] },
      })
      const queryA = harness.track(harness.sdk.query({ prompt: 'A', options: options() }))
      const queryB = harness.track(harness.sdk.query({ prompt: 'B', options: options() }))
      await queryA.supportedModels()
      await queryB.supportedModels()
      expect(harness.mock.requests).toHaveLength(0)

      await queryA.return(undefined)
      await queryA.return(undefined)
      harness.mock.enqueue({ type: 'text', text: 'SDK_HOOK_SHARED_B_33A' })
      const resultB = await harness.collect(queryB)
      expect(resultB.error).toBeUndefined()
      expect(calls).toEqual(['B'])

      harness.mock.enqueue({ type: 'text', text: 'SDK_HOOK_SHARED_NONE_33A' })
      const withoutHooks = harness.track(harness.sdk.query({
        prompt: 'C',
        options: { ...harness.baseOptions, tools: [], persistSession: false },
      }))
      const resultC = await harness.collect(withoutHooks)
      expect(resultC.error).toBeUndefined()
      expect(calls).toEqual(['B'])
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test.each(['terminal-error', 'setup-failure'] as const)(
    '%s releases only its own occurrence and preserves another query owner',
    async scenario => {
      const harness = await createSdkHarness()
      let target: ReturnType<typeof harness.sdk.query> | undefined
      try {
        let targetCalls = 0
        let otherCalls = 0
        const other = harness.track(harness.sdk.query({
          prompt: 'other owner',
          options: {
            ...harness.baseOptions,
            tools: [],
            persistSession: false,
            hooks: {
              UserPromptSubmit: [{ hooks: [async () => {
                otherCalls++
                return {}
              }] }],
            },
          },
        }))
        await other.supportedModels()

        const targetOptions: Options = {
          ...harness.baseOptions,
          env: {
            ...harness.baseOptions.env,
            CLAUDE_CODE_MAX_RETRIES: '0',
          },
          tools: [],
          persistSession: false,
          hooks: {
            UserPromptSubmit: [{ hooks: [async () => {
              targetCalls++
              return {}
            }] }],
          },
          ...(scenario === 'setup-failure'
            ? { thinkingConfig: { type: 'enabled' } as Options['thinkingConfig'] }
            : {}),
        }
        target = harness.sdk.query({
          prompt: 'target owner',
          options: targetOptions,
        })
        if (scenario === 'terminal-error') harness.track(target)
        if (scenario === 'terminal-error') {
          harness.mock.enqueue({
            type: 'error',
            status: 400,
            body: {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'SDK_HOOK_ERROR_33A' },
            },
          })
        }
        const failed = await harness.collect(target)
        expect(failed.error).toBeInstanceOf(Error)
        expect(targetCalls).toBe(scenario === 'terminal-error' ? 1 : 0)
        // Registry callbacks are process-global while both owners are active, so
        // the surviving owner may also observe the target's prompt. Its count
        // after target cleanup is the baseline for proving B still fires once.
        const otherCallsAfterTargetCleanup = otherCalls

        harness.mock.enqueue({ type: 'text', text: 'SDK_HOOK_OTHER_SURVIVES_33A' })
        const otherResult = await harness.collect(other)
        expect(otherResult.error).toBeUndefined()
        expect(otherCalls).toBe(otherCallsAfterTargetCleanup + 1)
        expect(targetCalls).toBe(scenario === 'terminal-error' ? 1 : 0)
      } finally {
        if (scenario === 'setup-failure') {
          await target?.return(undefined).catch(() => {})
        }
        await harness.cleanup()
      }
    },
    TEST_TIMEOUT_MS,
  )
})
