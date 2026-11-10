import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

export type SSHSessionCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  onConnected: () => void
  onReconnecting: (attempt: number, maxAttempts: number) => void
  onDisconnected: () => void
  onError: (error: Error) => void
}

/** Disabled SSH transport boundary. No process or socket is opened. */
export class SSHSessionManager {
  connect(): boolean {
    return false
  }

  disconnect(): boolean {
    return false
  }

  async sendMessage(_content: RemoteMessageContent): Promise<boolean> {
    return false
  }

  respondToPermissionRequest(
    _requestId: string,
    _response: RemotePermissionResponse,
  ): boolean {
    return false
  }

  sendInterrupt(): boolean {
    return false
  }
}
