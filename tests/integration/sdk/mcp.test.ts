import { describe, expect, test } from 'bun:test'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import type {
  ElicitationHookInput,
  ElicitationResultHookInput,
} from '../../../src/entrypoints/agentSdkTypes.js'
import type { Options } from '../../../src/entrypoints/sdk/runtimeTypes.js'
import type { RecordedRequest } from '../support/mock-anthropic.ts'
import {
  createFormElicitationEchoServer,
  MCP_FORM_MESSAGE,
} from '../support/mcp.ts'
import {
  createSdkHarness,
  createUserInput,
  pauseAtResult,
  userMessage,
  type DistSdk,
  type SdkHarness,
} from '../support/sdk.ts'

const TEST_TIMEOUT_MS = 25_000

function modelRequests(harness: SdkHarness): RecordedRequest[] {
  return harness.mock.requests.filter(request => request.path === '/v1/messages')
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

function mcpOptions(harness: SdkHarness, server: ReturnType<DistSdk['createSdkMcpServer']>): Options {
  return {
    ...harness.baseOptions,
    tools: [],
    allowedTools: ['mcp__mock__echo'],
    mcpServers: { mock: server },
    persistSession: false,
  }
}

async function drain(input: ReturnType<typeof createUserInput>, harness: SdkHarness, query: Parameters<SdkHarness['collect']>[0]) {
  input.close()
  const remainder = await harness.collect(query)
  expect(remainder.error).toBeUndefined()
  return remainder.messages
}

describe('classic SDK in-process MCP', () => {
  test('discovers, calls, removes, and explicitly replaces a same-name server', async () => {
    const harness = await createSdkHarness()
    const input = createUserInput()
    try {
      const originalCalls: Array<Record<string, unknown>> = []
      const freshCalls: Array<Record<string, unknown>> = []
      const original = createFormElicitationEchoServer(harness.sdk, 'SDK_MCP_ORIGINAL_33B', originalCalls)
      input.push(userMessage('Call the original mock echo tool.'))
      const query = harness.track(harness.sdk.query({
        prompt: input.input,
        options: mcpOptions(harness, original),
      }))

      expect(await query.mcpServerStatus()).toMatchObject([{ name: 'mock', status: 'connected' }])
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: 'tool-sdk-mcp-original-33b',
          name: 'mcp__mock__echo',
          input: { text: 'original-input' },
        },
        { type: 'text', text: 'SDK_MCP_ORIGINAL_DONE_33B' },
      )
      const first = await pauseAtResult(query)
      const init = first.messages.find(message =>
        message.type === 'system' && message.subtype === 'init',
      )
      expect(JSON.stringify(init)).toContain('mcp__mock__echo')
      expect(originalCalls).toEqual([{ text: 'original-input' }])
      expect(JSON.stringify(modelRequests(harness)[0]?.body?.tools)).toContain('mcp__mock__echo')
      const originalResult = toolResult(modelRequests(harness)[1]!, 'tool-sdk-mcp-original-33b')
      expect(originalResult.is_error).not.toBe(true)
      expect(JSON.stringify(originalResult.content)).toContain('SDK_MCP_ORIGINAL_33B')

      expect(await query.setMcpServers({})).toEqual({
        added: [], removed: ['mock'], errors: {},
      })
      expect(await query.mcpServerStatus()).toEqual([])
      harness.mock.enqueue({ type: 'text', text: 'SDK_MCP_REMOVED_DONE_33B' })
      input.push(userMessage('Respond without the removed server.'))
      await pauseAtResult(query)
      expect(JSON.stringify(modelRequests(harness)[2]?.body?.tools)).not.toContain('mcp__mock__echo')

      const fresh = createFormElicitationEchoServer(harness.sdk, 'SDK_MCP_FRESH_33B', freshCalls)
      // This is explicit replacement recovery, not automatic remote reconnection.
      expect(await query.setMcpServers({ mock: fresh })).toEqual({
        added: ['mock'], removed: [], errors: {},
      })
      expect(await query.mcpServerStatus()).toMatchObject([{ name: 'mock', status: 'connected' }])
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: 'tool-sdk-mcp-fresh-33b',
          name: 'mcp__mock__echo',
          input: { text: 'fresh-input' },
        },
        { type: 'text', text: 'SDK_MCP_FRESH_DONE_33B' },
      )
      input.push(userMessage('Call the fresh mock echo tool.'))
      const third = await pauseAtResult(query)
      expect(
        freshCalls,
        JSON.stringify({ messages: third.messages, request: modelRequests(harness)[3]?.body }),
      ).toEqual([{ text: 'fresh-input' }])
      expect(originalCalls).toHaveLength(1)
      expect(JSON.stringify(modelRequests(harness)[3]?.body?.tools)).toContain('mcp__mock__echo')
      const freshResult = toolResult(modelRequests(harness)[4]!, 'tool-sdk-mcp-fresh-33b')
      expect(freshResult.is_error).not.toBe(true)
      expect(JSON.stringify(freshResult.content)).toContain('SDK_MCP_FRESH_33B')

      await drain(input, harness, query)
    } finally {
      input.close()
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('passes onElicitation accept content through the tool to the model and result hooks', async () => {
    const harness = await createSdkHarness()
    try {
      const elicitationResults: ElicitResult[] = []
      const resultInputs: ElicitationResultHookInput[] = []
      const callbackRequests: Array<Record<string, unknown>> = []
      const server = createFormElicitationEchoServer(harness.sdk, 'SDK_MCP_ELICIT_ACCEPT_33B', [], elicitationResults)
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: 'tool-sdk-elicit-accept-33b',
          name: 'mcp__mock__echo',
          input: { text: 'accept-input', elicit: true },
        },
        { type: 'text', text: 'SDK_MCP_ELICIT_ACCEPT_DONE_33B' },
      )
      const query = harness.track(harness.sdk.query({
        prompt: 'Call the form-eliciting tool.',
        options: {
          ...mcpOptions(harness, server),
          onElicitation: async (request, { signal }) => {
            callbackRequests.push(request)
            expect(signal).toBeInstanceOf(AbortSignal)
            expect(signal.aborted).toBe(false)
            return { action: 'accept', content: { answer: 'SDK_MCP_CALLBACK_ANSWER_33B' } }
          },
          hooks: {
            ElicitationResult: [{ hooks: [async input => {
              resultInputs.push(input as ElicitationResultHookInput)
              return {}
            }] }],
          },
        },
      }))

      const { error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(callbackRequests).toHaveLength(1)
      expect(callbackRequests[0]).toMatchObject({
        serverName: 'mock',
        message: MCP_FORM_MESSAGE,
        mode: 'form',
        requestedSchema: {
          type: 'object',
          required: ['answer'],
        },
      })
      expect(elicitationResults).toEqual([{
        action: 'accept', content: { answer: 'SDK_MCP_CALLBACK_ANSWER_33B' },
      }])
      expect(resultInputs).toHaveLength(1)
      expect(resultInputs[0]).toMatchObject({
        hook_event_name: 'ElicitationResult',
        mcp_server_name: 'mock',
        mode: 'form',
        action: 'accept',
        content: { answer: 'SDK_MCP_CALLBACK_ANSWER_33B' },
      })
      const result = toolResult(modelRequests(harness)[1]!, 'tool-sdk-elicit-accept-33b')
      expect(result.is_error).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('SDK_MCP_CALLBACK_ANSWER_33B')
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test.each(['decline', 'cancel'] as const)('returns %s without UI and reports it to result hooks', async action => {
    const harness = await createSdkHarness()
    try {
      const elicitationResults: ElicitResult[] = []
      const resultInputs: ElicitationResultHookInput[] = []
      let callbackCalls = 0
      const server = createFormElicitationEchoServer(harness.sdk, `SDK_MCP_ELICIT_${action}_33B`, [], elicitationResults)
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: `tool-sdk-elicit-${action}-33b`,
          name: 'mcp__mock__echo',
          input: { text: `${action}-input`, elicit: true },
        },
        { type: 'text', text: `SDK_MCP_ELICIT_${action}_DONE_33B` },
      )
      const query = harness.track(harness.sdk.query({
        prompt: 'Call the form-eliciting tool.',
        options: {
          ...mcpOptions(harness, server),
          ...(action === 'cancel' ? {
            onElicitation: async () => {
              callbackCalls++
              return { action: 'cancel' as const }
            },
          } : {}),
          hooks: {
            ElicitationResult: [{ hooks: [async input => {
              resultInputs.push(input as ElicitationResultHookInput)
              return {}
            }] }],
          },
        },
      }))

      const { error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(callbackCalls).toBe(action === 'cancel' ? 1 : 0)
      expect(elicitationResults).toEqual([{ action }])
      expect(resultInputs).toHaveLength(1)
      expect(resultInputs[0]).toMatchObject({ action })
      const result = toolResult(modelRequests(harness)[1]!, `tool-sdk-elicit-${action}-33b`)
      expect(result.is_error).not.toBe(true)
      const content = result.content as Array<{ text: string }>
      expect(JSON.parse(content[0]!.text)).toMatchObject({
        elicitation: { action },
      })
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('lets Elicitation hooks win before onElicitation and sends the final result-hook content', async () => {
    const harness = await createSdkHarness()
    try {
      const elicitationResults: ElicitResult[] = []
      const hookInputs: ElicitationHookInput[] = []
      const resultInputs: ElicitationResultHookInput[] = []
      let callbackCalls = 0
      const server = createFormElicitationEchoServer(harness.sdk, 'SDK_MCP_ELICIT_HOOK_33B', [], elicitationResults)
      harness.mock.enqueue(
        {
          type: 'tool_use',
          id: 'tool-sdk-elicit-hook-33b',
          name: 'mcp__mock__echo',
          input: { text: 'hook-input', elicit: true },
        },
        { type: 'text', text: 'SDK_MCP_ELICIT_HOOK_DONE_33B' },
      )
      const query = harness.track(harness.sdk.query({
        prompt: 'Call the hook-eliciting tool.',
        options: {
          ...mcpOptions(harness, server),
          onElicitation: async () => {
            callbackCalls++
            return { action: 'decline' }
          },
          hooks: {
            Elicitation: [{ matcher: 'mock', hooks: [async input => {
              hookInputs.push(input as ElicitationHookInput)
              return {
                hookSpecificOutput: {
                  hookEventName: 'Elicitation',
                  action: 'accept',
                  content: { answer: 'SDK_MCP_HOOK_ANSWER_33B' },
                },
              }
            }] }],
            ElicitationResult: [{ matcher: 'mock', hooks: [async input => {
              resultInputs.push(input as ElicitationResultHookInput)
              return {
                hookSpecificOutput: {
                  hookEventName: 'ElicitationResult',
                  action: 'accept',
                  content: { answer: 'SDK_MCP_RESULT_FINAL_33B' },
                },
              }
            }] }],
          },
        },
      }))

      const { error } = await harness.collect(query)
      expect(error).toBeUndefined()
      expect(
        callbackCalls,
        JSON.stringify({ hookInputs, resultInputs, elicitationResults }),
      ).toBe(0)
      expect(hookInputs).toHaveLength(1)
      expect(hookInputs[0]).toMatchObject({
        hook_event_name: 'Elicitation', mcp_server_name: 'mock', mode: 'form',
      })
      expect(resultInputs).toHaveLength(1)
      expect(resultInputs[0]).toMatchObject({
        action: 'accept', content: { answer: 'SDK_MCP_HOOK_ANSWER_33B' },
      })
      expect(elicitationResults).toEqual([{
        action: 'accept', content: { answer: 'SDK_MCP_RESULT_FINAL_33B' },
      }])
      const result = toolResult(modelRequests(harness)[1]!, 'tool-sdk-elicit-hook-33b')
      expect(JSON.stringify(result.content)).toContain('SDK_MCP_RESULT_FINAL_33B')
    } finally {
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)

  test('aborts a pending form elicitation with cancel semantics', async () => {
    const harness = await createSdkHarness()
    const abortController = new AbortController()
    try {
      const callbackResults: ElicitResult[] = []
      let callbackStarted = false
      let callbackSignalAborted = false
      const server = createFormElicitationEchoServer(harness.sdk, 'SDK_MCP_ELICIT_ABORT_33B', [])
      harness.mock.enqueue({
        type: 'tool_use',
        id: 'tool-sdk-elicit-abort-33b',
        name: 'mcp__mock__echo',
        input: { text: 'abort-input', elicit: true },
      })
      const query = harness.track(harness.sdk.query({
        prompt: 'Call the abortable form-eliciting tool.',
        options: {
          ...mcpOptions(harness, server),
          abortController,
          onElicitation: (_request, { signal }) => {
            callbackStarted = true
            return new Promise<ElicitResult>(resolve => {
              const cancel = () => {
                callbackSignalAborted = true
                const result: ElicitResult = { action: 'cancel' }
                callbackResults.push(result)
                resolve(result)
              }
              if (signal.aborted) cancel()
              else signal.addEventListener('abort', cancel, { once: true })
            })
          },
        },
      }))

      const collection = harness.collect(query)
      await harness.waitFor(() => callbackStarted)
      abortController.abort('SDK_MCP_ABORT_33B')
      await collection
      await harness.waitFor(() => callbackSignalAborted)
      // An aborted tools/call has no live response channel, so cancellation is
      // observed at the public callback signal/result rather than a later model request.
      expect(callbackResults).toEqual([{ action: 'cancel' }])
      expect(modelRequests(harness)).toHaveLength(1)
    } finally {
      abortController.abort('SDK_MCP_ABORT_CLEANUP_33B')
      await harness.cleanup()
    }
  }, TEST_TIMEOUT_MS)
})
