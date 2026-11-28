import { describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SDKMessage,
  SDKResultMessage,
} from '../../../src/entrypoints/sdk/coreTypes.js'
import type { Options } from '../../../src/entrypoints/sdk/runtimeTypes.js'
import {
  createResponseGate,
  type RecordedRequest,
} from '../support/mock-anthropic.ts'
import {
  createSdkHarness,
  createUserInput,
  pauseAtResult,
  userMessage,
  withDeadline,
  type SdkHarness,
} from '../support/sdk.ts'

const TEST_TIMEOUT_MS = 20_000

const OWNED_ENV_KEYS = [
  'SDK_IT_33A_EXISTING',
  'SDK_IT_33A_DELETE',
  'SDK_IT_33A_NEW',
  'SDK_IT_33A_ABSENT',
  'SDK_IT_33A_UNTOUCHED',
] as const

function preserveEnv(keys: readonly string[]): () => void {
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function prepareOwnedEnv(baseEnv: Options['env']): Options['env'] {
  process.env.SDK_IT_33A_EXISTING = 'old'
  process.env.SDK_IT_33A_DELETE = 'gone'
  delete process.env.SDK_IT_33A_NEW
  delete process.env.SDK_IT_33A_ABSENT
  process.env.SDK_IT_33A_UNTOUCHED = 'external-before'
  return {
    ...baseEnv,
    SDK_IT_33A_EXISTING: 'new',
    SDK_IT_33A_DELETE: undefined,
    SDK_IT_33A_NEW: 'created',
    SDK_IT_33A_ABSENT: undefined,
    CLAUDE_CODE_MAX_RETRIES: '0',
  }
}

function expectOwnedEnvRestored(): void {
  expect(process.env.SDK_IT_33A_EXISTING).toBe('old')
  expect(process.env.SDK_IT_33A_DELETE).toBe('gone')
  expect(process.env.SDK_IT_33A_NEW).toBeUndefined()
  expect(process.env.SDK_IT_33A_ABSENT).toBeUndefined()
  expect(process.env.SDK_IT_33A_UNTOUCHED).toBe('external-after')
}

function modelRequests(harness: SdkHarness): RecordedRequest[] {
  return harness.mock.requests.filter(request => request.path === '/v1/messages')
}

function results(messages: SDKMessage[]): SDKResultMessage[] {
  return messages.filter(
    (message): message is SDKResultMessage => message.type === 'result',
  )
}

function toolResult(request: RecordedRequest, toolUseId: string): Record<string, unknown> {
  const messages = request.body?.messages
  if (!Array.isArray(messages)) throw new Error('Model request has no messages')
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (
        (block as { type?: unknown }).type === 'tool_result' &&
        (block as { tool_use_id?: unknown }).tool_use_id === toolUseId
      ) {
        return block as Record<string, unknown>
      }
    }
  }
  throw new Error(`No tool_result for ${toolUseId}`)
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('classic SDK query lifecycle', () => {
  test('emits init, one scripted assistant text, and a successful result with the requested model and prompt', async () => {
    const harness = await createSdkHarness()
    try {
      const marker = 'SDK_QUERY_TEXT_UNIQUE_32A'
      const prompt = 'Return SDK_QUERY_TEXT_UNIQUE_32A exactly once.'
      harness.mock.enqueue({ type: 'text', text: marker })
      const query = harness.track(harness.sdk.query({
        prompt,
        options: {
          ...harness.baseOptions,
          model: 'sdk-model-a',
          tools: [],
          persistSession: false,
        },
      }))

      const { messages, error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(messages[0]).toMatchObject({ type: 'system', subtype: 'init' })
      const assistants = messages.filter(message => message.type === 'assistant')
      expect(assistants).toHaveLength(1)
      expect(JSON.stringify(assistants[0])).toContain(marker)
      expect(results(messages)).toHaveLength(1)
      expect(results(messages)[0]).toMatchObject({
        subtype: 'success',
        is_error: false,
        result: marker,
      })
      expect(results(messages)[0]!.session_id).not.toBe('')
      expect(messages.findIndex(message => message.type === 'system')).toBeLessThan(
        messages.findIndex(message => message.type === 'assistant'),
      )
      expect(messages.findIndex(message => message.type === 'assistant')).toBeLessThan(
        messages.findIndex(message => message.type === 'result'),
      )

      const requests = modelRequests(harness)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.method).toBe('POST')
      expect(requests[0]!.body).toMatchObject({ model: 'sdk-model-a' })
      expect(JSON.stringify(requests[0]!.body?.messages)).toContain(prompt)
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('authorizes Bash through canUseTool and sends the real output back with the matching tool_use_id', async () => {
    const harness = await createSdkHarness()
    try {
      const outputMarker = 'SDK_QUERY_TOOL_ALLOW_32B'
      const finalMarker = 'SDK_QUERY_TOOL_ALLOW_DONE_32B'
      const toolUseId = 'tool-sdk-allow-32b'
      const outputPath = join(harness.sandbox.project, 'allowed-output.txt')
      const command = `printf '%s' '${outputMarker}' | tee ${JSON.stringify(outputPath)}`
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command, description: 'Write the allowed SDK marker' },
        },
        { type: 'text', text: finalMarker },
      )
      const callbackCalls: Array<{
        name: string
        input: Record<string, unknown>
        toolUseID: string
        signal: AbortSignal
      }> = []
      const query = harness.track(harness.sdk.query({
        prompt: 'Run the scripted tool and report its output.',
        options: {
          ...harness.baseOptions,
          tools: ['Bash'],
          persistSession: false,
          canUseTool: async (name, input, { toolUseID, signal }) => {
            callbackCalls.push({ name, input, toolUseID, signal })
            return { behavior: 'allow', updatedInput: input }
          },
        },
      }))

      const { messages, error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(callbackCalls).toHaveLength(1)
      expect(callbackCalls[0]).toMatchObject({
        name: 'Bash',
        input: { command },
        toolUseID: toolUseId,
      })
      expect(callbackCalls[0]!.signal).toBeInstanceOf(AbortSignal)
      expect(callbackCalls[0]!.signal.aborted).toBe(false)
      expect(await readFile(outputPath, 'utf8')).toBe(outputMarker)

      const requests = modelRequests(harness)
      expect(requests).toHaveLength(2)
      const resultBlock = toolResult(requests[1]!, toolUseId)
      expect(resultBlock.is_error).toBe(false)
      expect(JSON.stringify(resultBlock.content)).toContain(outputMarker)
      expect(results(messages).at(-1)).toMatchObject({
        subtype: 'success',
        is_error: false,
        result: finalMarker,
      })
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('denies Bash without a side effect and reports both permission_denials and an error tool_result', async () => {
    const harness = await createSdkHarness()
    try {
      const denialMarker = 'SDK_QUERY_TOOL_DENY_32C'
      const toolUseId = 'tool-sdk-deny-32c'
      const outputPath = join(harness.sandbox.project, 'denied-output.txt')
      const command = `printf '%s' 'SHOULD_NOT_EXIST_32C' > ${JSON.stringify(outputPath)}`
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'Bash',
          input: { command, description: 'Attempt a denied SDK write' },
        },
        { type: 'text', text: 'SDK_QUERY_TOOL_DENY_DONE_32C' },
      )
      const query = harness.track(harness.sdk.query({
        prompt: 'Attempt the scripted tool call.',
        options: {
          ...harness.baseOptions,
          tools: ['Bash'],
          persistSession: false,
          canUseTool: async () => ({ behavior: 'deny', message: denialMarker }),
        },
      }))

      const { messages, error } = await harness.collect(query)
      expect(error).toBeUndefined()
      await expectMissing(outputPath)
      const requests = modelRequests(harness)
      expect(requests).toHaveLength(2)
      const resultBlock = toolResult(requests[1]!, toolUseId)
      expect(resultBlock.is_error).toBe(true)
      expect(JSON.stringify(resultBlock.content)).toContain(denialMarker)
      expect(results(messages).at(-1)).toMatchObject({
        subtype: 'success',
        is_error: false,
        permission_denials: [{
          tool_name: 'Bash',
          tool_use_id: toolUseId,
          tool_input: { command, description: 'Attempt a denied SDK write' },
        }],
      })
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('keeps controlled input open between turns and applies setModel to the next request with prior history', async () => {
    const harness = await createSdkHarness()
    const input = createUserInput()
    try {
      const firstMarker = 'SDK_QUERY_MODEL_FIRST_32D'
      const secondMarker = 'SDK_QUERY_MODEL_SECOND_32D'
      const firstPrompt = 'First controlled prompt 32D'
      const secondPrompt = 'Second controlled prompt 32D'
      harness.mock.enqueue(
        { type: 'text', text: firstMarker },
        { type: 'text', text: secondMarker },
      )
      input.push(userMessage(firstPrompt))
      const query = harness.track(harness.sdk.query({
        prompt: input.input,
        options: {
          ...harness.baseOptions,
          model: 'sdk-model-a',
          tools: [],
          persistSession: false,
        },
      }))

      const first = await pauseAtResult(query)
      expect(first.result.result).toBe(firstMarker)
      expect(modelRequests(harness)).toHaveLength(1)
      await query.setModel('sdk-model-b')
      input.push(userMessage(secondPrompt))
      input.close()
      const remainder = await harness.collect(query)
      expect(remainder.error).toBeUndefined()
      const messages = [...first.messages, ...remainder.messages]
      expect(results(messages).map(result => result.subtype)).toEqual([
        'success',
        'success',
      ])
      expect(results(messages).map(result => result.subtype === 'success' ? result.result : '')).toEqual([
        firstMarker,
        secondMarker,
      ])

      const requests = modelRequests(harness)
      expect(requests.map(request => request.body?.model)).toEqual([
        'sdk-model-a',
        'sdk-model-b',
      ])
      const secondBody = JSON.stringify(requests[1]!.body?.messages)
      expect(secondBody).toContain(firstPrompt)
      expect(secondBody).toContain(firstMarker)
      expect(secondBody).toContain(secondPrompt)
    } finally {
      input.close()
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('yields error_max_turns before throwing and never executes a denied tool past the turn limit', async () => {
    const harness = await createSdkHarness()
    try {
      const toolUseId = 'tool-sdk-max-turns-32e'
      const outputPath = join(harness.sandbox.project, 'max-turns-output.txt')
      const command = `printf '%s' 'SHOULD_NOT_EXIST_32E' > ${JSON.stringify(outputPath)}`
      harness.mock.enqueue({
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: { command, description: 'Must remain denied at the turn limit' },
      })
      let permissionCalls = 0
      const query = harness.track(harness.sdk.query({
        prompt: 'Use the scripted tool.',
        options: {
          ...harness.baseOptions,
          tools: ['Bash'],
          maxTurns: 1,
          persistSession: false,
          canUseTool: async () => {
            permissionCalls++
            return { behavior: 'deny', message: 'SDK_MAX_TURNS_DENY_32E' }
          },
        },
      }))

      const { messages, error } = await harness.collect(query)
      const errorResults = results(messages).filter(result => result.subtype === 'error_max_turns')
      expect(errorResults).toHaveLength(1)
      expect(errorResults[0]!.session_id).not.toBe('')
      expect(errorResults[0]!.subtype === 'error_max_turns' && errorResults[0]!.errors.join('\n')).toContain(
        'Reached maximum number of turns',
      )
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Reached maximum number of turns')
      expect(permissionCalls).toBe(1)
      await expectMissing(outputPath)
      expect(modelRequests(harness)).toHaveLength(1)
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('surfaces a single non-retried API 400 in the stream and throws its diagnostic after the error result', async () => {
    const harness = await createSdkHarness()
    try {
      const diagnostic = 'SDK_QUERY_API_400_DIAGNOSTIC_32F'
      harness.mock.enqueue({
        type: 'error',
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: diagnostic },
        },
      })
      const query = harness.track(harness.sdk.query({
        prompt: 'Trigger the scripted API error.',
        options: {
          ...harness.baseOptions,
          env: { ...harness.baseOptions.env, CLAUDE_CODE_MAX_RETRIES: '0' },
          tools: [],
          persistSession: false,
        },
      }))

      const { messages, error } = await harness.collect(query)
      expect(modelRequests(harness)).toHaveLength(1)
      expect(JSON.stringify(messages)).toContain(diagnostic)
      const terminalResults = results(messages)
      expect(terminalResults).toHaveLength(1)
      expect(terminalResults[0]!.is_error).toBe(true)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(diagnostic)
      expect((error as Error).message).not.toContain('Timed out')
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('throws a recorded terminal error when input closes while query.next is already waiting', async () => {
    const harness = await createSdkHarness()
    const input = createUserInput()
    try {
      const diagnostic = 'SDK_QUERY_DELAYED_CLOSE_DIAGNOSTIC_32J'
      harness.mock.enqueue({
        type: 'error',
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: diagnostic },
        },
      })
      input.push(userMessage('Fail this turn while the input remains open.'))
      const query = harness.track(harness.sdk.query({
        prompt: input.input,
        options: {
          ...harness.baseOptions,
          env: { ...harness.baseOptions.env, CLAUDE_CODE_MAX_RETRIES: '0' },
          tools: [],
          persistSession: false,
        },
      }))

      const messages: SDKMessage[] = []
      while (true) {
        const next = await withDeadline(query.next(), 'delayed-close error result')
        if (next.done) throw new Error('Query ended before its error result')
        messages.push(next.value)
        if (next.value.type === 'result') break
      }
      expect(results(messages)).toHaveLength(1)
      expect(results(messages)[0]!.is_error).toBe(true)

      const waitingNext = query.next()
      // Let the generator finish the error turn and park in channel.iterate().
      await new Promise(resolve => setTimeout(resolve, 0))
      input.close()
      let error: unknown
      try {
        await withDeadline(waitingNext, 'terminal error after delayed input close')
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain(diagnostic)
      expect((error as Error).message).not.toContain('Timed out')
      expect(modelRequests(harness)).toHaveLength(1)
    } finally {
      input.close()
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('interrupts only the active gated turn and accepts a later streaming input turn', async () => {
    const harness = await createSdkHarness()
    const input = createUserInput()
    const gate = createResponseGate()
    try {
      const secondMarker = 'SDK_QUERY_INTERRUPT_SECOND_32G'
      harness.mock.enqueue(
        { type: 'text', text: 'SDK_QUERY_INTERRUPT_FIRST_32G', gate },
        { type: 'text', text: secondMarker },
      )
      input.push(userMessage('Interrupt this gated turn.'))
      const query = harness.track(harness.sdk.query({
        prompt: input.input,
        options: { ...harness.baseOptions, tools: [], persistSession: false },
      }))

      const firstMessages: SDKMessage[] = []
      const firstResultPromise = (async () => {
        while (true) {
          const next = await query.next()
          if (next.done) throw new Error('Query ended before the interrupted result')
          firstMessages.push(next.value)
          if (next.value.type === 'result') return next.value
        }
      })()
      await harness.waitFor(() => modelRequests(harness).length === 1)
      await query.interrupt()
      const firstResult = await withDeadline(firstResultPromise, 'interrupted first result')
      expect(firstResult).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
      })

      input.push(userMessage('Run a fresh turn after interrupt.'))
      input.close()
      const second = await harness.collect(query)
      expect(second.error).toBeUndefined()
      expect(results(second.messages)).toHaveLength(1)
      expect(results(second.messages)[0]).toMatchObject({
        subtype: 'success',
        is_error: false,
        result: secondMarker,
      })
      expect(modelRequests(harness)).toHaveLength(2)
    } finally {
      gate.release()
      input.close()
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('external abort ends collection without starting a queued second turn and remains idempotent to close', async () => {
    const harness = await createSdkHarness()
    const input = createUserInput()
    const gate = createResponseGate()
    const abortController = new AbortController()
    try {
      harness.mock.enqueue(
        { type: 'text', text: 'SDK_QUERY_EXTERNAL_ABORT_FIRST_32H', gate },
        { type: 'text', text: 'SDK_QUERY_EXTERNAL_ABORT_SECOND_32H' },
      )
      input.push(userMessage('Abort this gated turn.'))
      input.push(userMessage('This queued turn must not start.'))
      const query = harness.track(harness.sdk.query({
        prompt: input.input,
        options: {
          ...harness.baseOptions,
          abortController,
          tools: [],
          persistSession: false,
        },
      }))

      const collection = harness.collect(query)
      await harness.waitFor(() => modelRequests(harness).length === 1)
      abortController.abort('SDK external abort 32H')
      const { messages, error } = await collection
      expect(abortController.signal.aborted).toBe(true)
      expect(abortController.signal.reason).toBe('SDK external abort 32H')
      expect(modelRequests(harness)).toHaveLength(1)
      expect(results(messages).at(-1)).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
      })
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain('Timed out')
      await query.close('first explicit close')
      await query.close('second explicit close')
      expect(modelRequests(harness)).toHaveLength(1)
    } finally {
      gate.release()
      input.close()
      await harness.cleanup()
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('restores only options.env-owned keys after normal completion', async () => {
    const restoreEnv = preserveEnv(OWNED_ENV_KEYS)
    const harness = await createSdkHarness()
    try {
      let observed: Record<string, string | undefined> | undefined
      harness.mock.setRouter(() => {
        observed = {
          existing: process.env.SDK_IT_33A_EXISTING,
          deleted: process.env.SDK_IT_33A_DELETE,
          added: process.env.SDK_IT_33A_NEW,
          absent: process.env.SDK_IT_33A_ABSENT,
        }
        process.env.SDK_IT_33A_UNTOUCHED = 'external-after'
        return { type: 'text', text: 'SDK_ENV_NORMAL_33A' }
      })
      const query = harness.track(harness.sdk.query({
        prompt: 'Observe owned env during normal completion.',
        options: {
          ...harness.baseOptions,
          env: prepareOwnedEnv(harness.baseOptions.env),
          tools: [],
          persistSession: false,
        },
      }))

      const { error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(observed).toEqual({
        existing: 'new',
        deleted: undefined,
        added: 'created',
        absent: undefined,
      })
      expectOwnedEnvRestored()
    } finally {
      await harness.cleanup()
      restoreEnv()
    }
  }, TEST_TIMEOUT_MS)

  test.each(['terminal-error', 'setup-failure'] as const)(
    'restores options.env after %s',
    async scenario => {
      const restoreEnv = preserveEnv(OWNED_ENV_KEYS)
      const harness = await createSdkHarness()
      let query: ReturnType<typeof harness.sdk.query> | undefined
      try {
        const options: Options = {
          ...harness.baseOptions,
          env: prepareOwnedEnv(harness.baseOptions.env),
          tools: [],
          persistSession: false,
          ...(scenario === 'setup-failure'
            ? { thinkingConfig: { type: 'enabled' } as Options['thinkingConfig'] }
            : {}),
        }
        // A failed setup makes cleanup reject with the same setup error. Keep this
        // query out of the harness tracker and explicitly consume that cleanup error.
        query = scenario === 'setup-failure'
          ? harness.sdk.query({ prompt: 'Fail setup with owned env.', options })
          : harness.track(harness.sdk.query({
              prompt: 'Fail the model request with owned env.',
              options,
            }))
        if (scenario === 'terminal-error') {
          harness.mock.setRouter(() => {
            process.env.SDK_IT_33A_UNTOUCHED = 'external-after'
            return {
              type: 'error',
              status: 400,
              body: {
                type: 'error',
                error: { type: 'invalid_request_error', message: 'SDK_ENV_ERROR_33A' },
              },
            }
          })
        }
        if (scenario === 'setup-failure') {
          process.env.SDK_IT_33A_UNTOUCHED = 'external-after'
        }
        const { error } = await harness.collect(query)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).not.toContain('Timed out')
        expectOwnedEnvRestored()
      } finally {
        if (scenario === 'setup-failure') {
          await query?.return(undefined).catch(() => {})
        }
        await harness.cleanup()
        restoreEnv()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test.each(['return', 'close'] as const)(
    'restores options.env after explicit %s without running the model',
    async cleanupMethod => {
      const restoreEnv = preserveEnv(OWNED_ENV_KEYS)
      const harness = await createSdkHarness()
      try {
        const query = harness.track(harness.sdk.query({
          prompt: 'Initialize but do not run this query.',
          options: {
            ...harness.baseOptions,
            env: prepareOwnedEnv(harness.baseOptions.env),
            tools: [],
            persistSession: false,
          },
        }))
        await query.supportedModels()
        expect(process.env.SDK_IT_33A_EXISTING).toBe('new')
        expect(process.env.SDK_IT_33A_DELETE).toBeUndefined()
        expect(process.env.SDK_IT_33A_NEW).toBe('created')
        process.env.SDK_IT_33A_UNTOUCHED = 'external-after'

        if (cleanupMethod === 'return') await query.return(undefined)
        else await query.close('SDK env explicit close 33A')
        if (cleanupMethod === 'return') await query.return(undefined)
        else await query.close('SDK env explicit close 33A repeated')
        expectOwnedEnvRestored()
        expect(modelRequests(harness)).toHaveLength(0)
      } finally {
        await harness.cleanup()
        restoreEnv()
      }
    },
    TEST_TIMEOUT_MS,
  )

  test('interrupt while waiting for input does not poison the next turn', async () => {
    const harness = await createSdkHarness()
    const input = createUserInput()
    try {
      const marker = 'SDK_QUERY_IDLE_INTERRUPT_32I'
      harness.mock.enqueue({ type: 'text', text: marker })
      const query = harness.track(harness.sdk.query({
        prompt: input.input,
        options: { ...harness.baseOptions, tools: [], persistSession: false },
      }))
      const collection = harness.collect(query)
      await query.interrupt()
      input.push(userMessage('Run after an idle interrupt.'))
      input.close()
      const { messages, error } = await collection
      expect(error).toBeUndefined()
      expect(results(messages)).toHaveLength(1)
      expect(results(messages)[0]).toMatchObject({
        subtype: 'success',
        is_error: false,
        result: marker,
      })
      expect(modelRequests(harness)).toHaveLength(1)
    } finally {
      input.close()
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)
})
