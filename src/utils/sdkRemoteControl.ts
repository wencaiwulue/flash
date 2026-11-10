import { randomUUID, type UUID } from 'crypto'
import type { RemoteControlHandle } from '../entrypoints/agentSdkTypes.js'
import type { InternalQuery } from '../entrypoints/sdk/runtimeTypes.js'
import type { PermissionResult } from '../entrypoints/sdk/coreTypes.js'
import type { PermissionDecision } from '../types/permissions.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { SDKUserMessage } from '../entrypoints/sdk/coreTypes.js'
import type { UserMessageChannel } from './sdkQuery.js'

export type SdkRemoteController = {
  handle: RemoteControlHandle
  requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
  ): Promise<PermissionDecision>
  stop(): Promise<void>
}

type PendingPermission = {
  resolve: (result: PermissionDecision) => void
  reject: (error: Error) => void
}

function isControlRequest(value: unknown): value is SDKControlRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'control_request' &&
    'request_id' in value &&
    'request' in value
  )
}

function isControlResponse(value: unknown): value is SDKControlResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'control_response' &&
    'response' in value
  )
}

function isPermissionResult(value: unknown): value is PermissionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'behavior' in value &&
    (value.behavior === 'allow' || value.behavior === 'deny')
  )
}

function toPermissionDecision(result: PermissionResult): PermissionDecision {
  if (result.behavior === 'allow') {
    return {
      behavior: 'allow',
      ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
      ...(result.toolUseID ? { toolUseID: result.toolUseID } : {}),
    }
  }
  return {
    behavior: 'deny',
    message: result.message,
    decisionReason: {
      type: 'hook',
      hookName: 'Remote Control canUseTool',
      reason: result.message,
    },
    ...(result.interrupt !== undefined
      ? { interrupt: result.interrupt }
      : {}),
    ...(result.toolUseID ? { toolUseID: result.toolUseID } : {}),
  }
}

export function startSdkRemoteControl({
  handle,
  query,
  channel,
}: {
  handle: RemoteControlHandle
  query: InternalQuery
  channel: UserMessageChannel
}): SdkRemoteController {
  const pending = new Map<string, PendingPermission>()
  const outputTask = (async () => {
    for await (const message of query) handle.write(message)
    handle.sendResult()
  })()
  const inboundTask = (async () => {
    for await (const prompt of handle.inboundPrompts()) {
      const message: SDKUserMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: prompt.content as SDKUserMessage['message']['content'],
        },
        parent_tool_use_id: null,
        session_id: '',
        uuid: (prompt.uuid as UUID | undefined) ?? randomUUID(),
      }
      channel.push(message)
    }
  })()
  const controlTask = (async () => {
    for await (const request of handle.controlRequests()) {
      if (!isControlRequest(request)) continue
      try {
        switch (request.request.subtype) {
          case 'interrupt':
            await query.interrupt()
            break
          case 'set_model':
            await query.setModel(request.request.model)
            break
          case 'set_max_thinking_tokens':
            await query.setMaxThinkingTokens(
              request.request.max_thinking_tokens ?? null,
            )
            break
          case 'set_permission_mode':
            if (request.request.mode) {
              await query.setPermissionMode(request.request.mode)
            }
            break
        }
        handle.sendControlResponse({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
          },
        })
      } catch (error) {
        handle.sendControlResponse({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: request.request_id,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  })()
  const permissionTask = (async () => {
    for await (const response of handle.permissionResponses()) {
      if (!isControlResponse(response)) continue
      if (response.response.subtype === 'error') {
        const pendingRequest = pending.get(response.response.request_id)
        if (pendingRequest) {
          pending.delete(response.response.request_id)
          pendingRequest.reject(new Error(response.response.error))
        }
        continue
      }
      if (!isPermissionResult(response.response.response)) continue
      const pendingRequest = pending.get(response.response.request_id)
      if (pendingRequest) {
        pending.delete(response.response.request_id)
        pendingRequest.resolve(toPermissionDecision(response.response.response))
      }
    }
  })()

  let stopPromise: Promise<void> | undefined
  return {
    handle,
    async requestPermission(toolName, input, toolUseID) {
      const requestId = randomUUID()
      const result = new Promise<PermissionDecision>((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
      })
      try {
        handle.sendControlRequest({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: toolName,
            input,
            tool_use_id: toolUseID,
          },
        })
        return await result
      } finally {
        pending.delete(requestId)
      }
    },
    stop() {
      stopPromise ??= (async () => {
        // Close the output generator without awaiting it: its cleanup also
        // invokes this stop() and would otherwise form a self-waiting promise.
        void query.return(undefined)
        await Promise.allSettled([
          handle.teardown(),
          query.interrupt(),
        ])
        await Promise.allSettled([
          outputTask,
          inboundTask,
          controlTask,
          permissionTask,
        ])
        for (const pendingRequest of pending.values()) {
          pendingRequest.reject(new Error('Remote control stopped'))
        }
        pending.clear()
      })()
      return stopPromise
    },
  }
}
