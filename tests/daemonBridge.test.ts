import { describe, expect, mock, test } from 'bun:test'
import { connectDaemonBridge } from '../src/assistant/daemonBridge.ts'
import type { EnvLessBridgeParams } from '../src/bridge/remoteBridgeCore.ts'
import type { ReplBridgeHandle } from '../src/bridge/replBridge.ts'

describe('daemon remote control bridge', () => {
  test('maps the handle and buffers inbound streams before teardown', async () => {
    let params: EnvLessBridgeParams | undefined
    const writeSdkMessages = mock(() => {})
    const sendResult = mock(() => {})
    const sendControlRequest = mock(() => {})
    const sendControlResponse = mock(() => {})
    const sendControlCancelRequest = mock(() => {})
    const coreHandle = {
      bridgeSessionId: 'cse_test',
      environmentId: '',
      sessionIngressUrl: 'https://api.example.com',
      writeSdkMessages,
      sendResult,
      sendControlRequest,
      sendControlResponse,
      sendControlCancelRequest,
      teardown: async () => {},
    } as unknown as ReplBridgeHandle

    const handle = await connectDaemonBridge(
      {
        dir: '/tmp',
        name: 'test',
        getAccessToken: () => 'test-token',
        baseUrl: 'https://api.example.com',
        orgUUID: 'org-test',
        model: 'test-model',
      },
      {
        initCore: async options => {
          params = options
          return coreHandle
        },
      },
    )

    expect(handle).not.toBeNull()
    expect(handle!.environmentId).toBe('')
    expect(handle!.sessionUrl).toContain('/code/cse_test')
    expect(params?.title).toBe('test')
    expect(params?.initialHistoryCap).toBe(0)

    handle!.write({ type: 'result', subtype: 'success' } as never)
    handle!.sendResult()
    handle!.sendControlRequest({} as never)
    handle!.sendControlResponse({} as never)
    handle!.sendControlCancelRequest('request-1')
    expect(writeSdkMessages).toHaveBeenCalledTimes(1)
    expect(sendResult).toHaveBeenCalledTimes(1)
    expect(sendControlRequest).toHaveBeenCalledTimes(1)
    expect(sendControlResponse).toHaveBeenCalledTimes(1)
    expect(sendControlCancelRequest).toHaveBeenCalledWith('request-1')

    const controls = handle!.controlRequests()
    expect(
      params?.onControlRequest?.({
        request: { subtype: 'initialize' },
      } as never),
    ).toBe(false)
    expect(
      params?.onControlRequest?.({
        request: { subtype: 'set_model', model: 'next-model' },
      } as never),
    ).toBe(true)
    expect((await controls.next()).done).toBe(false)
    const closedControl = controls.next()

    const permissions = handle!.permissionResponses()
    params?.onPermissionResponse?.({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'request-1', response: { behavior: 'allow' },
    } } as never)
    expect((await permissions.next()).done).toBe(false)

    const prompts = handle!.inboundPrompts()
    params?.onInboundMessage?.({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      uuid: 'user-1',
    } as never)
    expect((await prompts.next()).done).toBe(false)

    const states: string[] = []
    handle!.onStateChange(state => states.push(state))
    params?.onStateChange?.('ready')
    expect(states).toEqual(['ready'])

    await handle!.teardown()
    await handle!.teardown()
    expect((await closedControl).done).toBe(true)
    expect((await permissions.next()).done).toBe(true)
    expect((await prompts.next()).done).toBe(true)
  })

  test('returns null when initialization fails', async () => {
    const handle = await connectDaemonBridge(
      {
        dir: '/tmp',
        getAccessToken: () => 'test-token',
        baseUrl: 'https://api.example.com',
        orgUUID: 'org-test',
        model: 'test-model',
      },
      { initCore: async () => null },
    )
    expect(handle).toBeNull()
  })
})
