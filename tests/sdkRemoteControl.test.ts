import { afterAll, describe, expect, mock, test } from 'bun:test'
import { startSdkRemoteControl } from '../src/utils/sdkRemoteControl.ts'
import { createSdkQuery } from '../src/utils/sdkQuery.ts'
import type { InternalQuery } from '../src/entrypoints/sdk/runtimeTypes.ts'
import type { RemoteControlHandle } from '../src/entrypoints/agentSdkTypes.ts'
import type { UserMessageChannel } from '../src/utils/sdkQuery.ts'

const originalApiKey = process.env.ANTHROPIC_API_KEY

function createEmptyHandle(): RemoteControlHandle {
  return {
    sessionUrl: 'https://claude.ai/code/cse_test',
    environmentId: '',
    bridgeSessionId: 'cse_test',
    write: () => {},
    sendResult: () => {},
    sendControlRequest: () => {},
    sendControlResponse: () => {},
    sendControlCancelRequest: () => {},
    inboundPrompts: async function* () {},
    controlRequests: async function* () {},
    permissionResponses: async function* () {},
    onStateChange: () => {},
    teardown: async () => {},
  }
}

describe('SDK remote control query integration', () => {
  test('routes prompts, control requests, and permission responses', async () => {
    const sendControlRequest = mock(request => {
      lastRequest = request
    })
    const sendResult = mock(() => {})
    const teardown = mock(async () => {})
    const setModel = mock(async () => {})
    const setMaxThinkingTokens = mock(async () => {})
    const setPermissionMode = mock(async () => {})
    const interrupt = mock(async () => {})
    const query = {
      setModel,
      setMaxThinkingTokens,
      setPermissionMode,
      interrupt,
      return: async () => ({ done: true, value: undefined }),
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as InternalQuery
    const push = mock(() => {})
    const channel = { push } as unknown as UserMessageChannel
    let lastRequest: { request_id: string } | undefined
    const handle: RemoteControlHandle = {
      sessionUrl: 'https://claude.ai/code/cse_test',
      environmentId: '',
      bridgeSessionId: 'cse_test',
      write: mock(() => {}),
      sendResult,
      sendControlRequest,
      sendControlResponse: mock(() => {}),
      sendControlCancelRequest: mock(() => {}),
      inboundPrompts: async function* () {
        yield { content: 'from remote', uuid: 'prompt-1' }
      },
      controlRequests: async function* () {
        yield { type: 'control_request', request_id: 'model-1', request: { subtype: 'set_model', model: 'next-model' } } as never
        yield { type: 'control_request', request_id: 'tokens-1', request: { subtype: 'set_max_thinking_tokens', max_thinking_tokens: 42 } } as never
        yield { type: 'control_request', request_id: 'mode-1', request: { subtype: 'set_permission_mode', mode: 'plan' } } as never
        yield { type: 'control_request', request_id: 'interrupt-1', request: { subtype: 'interrupt' } } as never
      },
      permissionResponses: async function* () {
        while (!lastRequest) {
          await new Promise(resolve => setTimeout(resolve, 1))
        }
        yield {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: lastRequest.request_id,
            response: { behavior: 'allow' },
          },
        } as never
      },
      onStateChange: () => {},
      teardown,
    }

    const controller = startSdkRemoteControl({ handle, query, channel })
    const permission = await controller.requestPermission('Bash', { command: 'true' }, 'tool-1')
    expect(permission.behavior).toBe('allow')
    expect(sendControlRequest).toHaveBeenCalledWith({
      type: 'control_request',
      request_id: expect.any(String),
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'true' },
        tool_use_id: 'tool-1',
      },
    })

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user',
        message: { role: 'user', content: 'from remote' },
      }),
    )
    expect(setModel).toHaveBeenCalledWith('next-model')
    expect(setMaxThinkingTokens).toHaveBeenCalledWith(42)
    expect(setPermissionMode).toHaveBeenCalledWith('plan')
    expect(interrupt).toHaveBeenCalled()
    expect(handle.sendControlResponse).toHaveBeenCalledTimes(4)
    expect(sendResult).toHaveBeenCalled()
    await controller.stop()
    expect(teardown).toHaveBeenCalled()
  })

  test('enables and disables remote control on a query', async () => {
    process.env.ANTHROPIC_API_KEY = 'offline-test-placeholder'
    const q = createSdkQuery({
      prompt: (async function* () {})(),
      options: { tools: [] },
      remoteControlFactory: async () => createEmptyHandle(),
      organizationUUID: 'org-test',
    })
    try {
      const enabled = await q.enableRemoteControl(true)
      expect(enabled?.session_url).toContain('/code/cse_test')
      expect(enabled?.environment_id).toBe('')
      await q.enableRemoteControl(false)
    } finally {
      await q.return(undefined)
    }
  })
})

afterAll(() => {
  if (originalApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalApiKey
  }
})
