import type {
  ConnectRemoteControlOptions,
  InboundPrompt,
  RemoteControlHandle,
} from '../entrypoints/agentSdkTypes.js'
import type { SDKMessage } from '../entrypoints/sdk/coreTypes.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import {
  initEnvLessBridgeCore,
  type EnvLessBridgeParams,
} from '../bridge/remoteBridgeCore.js'
import type { ReplBridgeHandle } from '../bridge/replBridge.js'
import { getRemoteSessionUrl } from '../constants/product.js'
import { checkAndRefreshOAuthTokenIfNeeded } from '../utils/auth.js'
import { toSDKMessages } from '../utils/messages/mappers.js'

class AsyncQueue<T> {
  private items: T[] = []
  private waiters = new Set<() => void>()
  private closed = false

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.notify()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.notify()
  }

  private notify(): void {
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  async *iterate(): AsyncGenerator<T, void> {
    try {
      while (true) {
        const item = this.items.shift()
        if (item !== undefined) {
          yield item
          continue
        }
        if (this.closed) return
        await new Promise<void>(resolve => this.waiters.add(resolve))
      }
    } finally {
      this.close()
    }
  }
}

export type DaemonBridgeDependencies = {
  initCore?: typeof initEnvLessBridgeCore
  refreshOAuth?: () => Promise<unknown>
}

export async function connectDaemonBridge(
  opts: ConnectRemoteControlOptions,
  dependencies: DaemonBridgeDependencies = {},
): Promise<RemoteControlHandle | null> {
  const inboundPromptQueue = new AsyncQueue<InboundPrompt>()
  const controlRequestQueue = new AsyncQueue<SDKControlRequest>()
  const permissionResponseQueue = new AsyncQueue<SDKControlResponse>()
  const stateListeners = new Set<
    Parameters<RemoteControlHandle['onStateChange']>[0]
  >()
  const initCore = dependencies.initCore ?? initEnvLessBridgeCore

  const params: EnvLessBridgeParams = {
    baseUrl: opts.baseUrl,
    orgUUID: opts.orgUUID,
    title: opts.name ?? 'flash daemon',
    getAccessToken: opts.getAccessToken,
    onAuth401: async () => {
      await (dependencies.refreshOAuth ?? checkAndRefreshOAuthTokenIfNeeded)()
      return true
    },
    toSDKMessages,
    initialHistoryCap: 0,
    onInboundMessage: message => {
      if (message.type !== 'user') return
      inboundPromptQueue.push({
        content: message.message.content,
        ...(message.uuid ? { uuid: message.uuid } : {}),
      })
    },
    onControlRequest: request => {
      if (request.request.subtype === 'initialize') return false
      controlRequestQueue.push(request)
      return true
    },
    onPermissionResponse: response => {
      permissionResponseQueue.push(response)
    },
    onStateChange: (state, detail) => {
      for (const listener of stateListeners) listener(state, detail)
    },
  }

  const core: ReplBridgeHandle | null = await initCore(params)
  if (!core) return null

  let teardownPromise: Promise<void> | undefined
  const teardown = () => {
    teardownPromise ??= (async () => {
      try {
        await core.teardown()
      } finally {
        inboundPromptQueue.close()
        controlRequestQueue.close()
        permissionResponseQueue.close()
      }
    })()
    return teardownPromise
  }

  return {
    sessionUrl: getRemoteSessionUrl(core.bridgeSessionId, core.sessionIngressUrl),
    environmentId: '',
    bridgeSessionId: core.bridgeSessionId,
    write(message: SDKMessage) {
      core.writeSdkMessages([message])
    },
    sendResult: core.sendResult,
    sendControlRequest: core.sendControlRequest,
    sendControlResponse: core.sendControlResponse,
    sendControlCancelRequest: core.sendControlCancelRequest,
    inboundPrompts: () => inboundPromptQueue.iterate(),
    controlRequests: () => controlRequestQueue.iterate(),
    permissionResponses: () => permissionResponseQueue.iterate(),
    onStateChange(cb) {
      stateListeners.add(cb)
    },
    teardown,
  }
}
