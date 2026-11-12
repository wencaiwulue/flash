/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'
import UnixWebSocket from 'ws'
import { directConnectWebSocketUrl } from './directConnectTransport.js'

export type DirectConnectConfig = {
  serverUrl: string
  sessionId: string
  wsUrl: string
  authToken?: string
  lastSeq?: number
  maxReconnectAttempts?: number
  dangerouslySkipPermissions?: boolean
}

export type DirectConnectCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onReconnecting?: (attempt: number) => void
  onPermissionCancelled?: (requestIds: string[]) => void
  onReplayReset?: () => void
  onStopped?: () => void
  onError?: (error: Error) => void
}

function isStdoutMessage(value: unknown): value is StdoutMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

export class DirectConnectSessionManager {
  private ws: WebSocket | null = null
  private manuallyClosed = false
  private started = false
  private ready = false
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastSeq: number
  private readonly outgoing: string[] = []

  constructor(
    private readonly config: DirectConnectConfig,
    private readonly callbacks: DirectConnectCallbacks,
  ) {
    this.lastSeq = config.lastSeq ?? 0
  }

  connect(): void {
    this.manuallyClosed = false
    this.started = true
    this.openSocket()
  }

  private openSocket(): void {
    const { url, options } = directConnectWebSocketUrl({
      ...this.config,
      after: this.lastSeq,
    })
    const headers: Record<string, string> = {}
    const token = this.config.authToken ?? process.env.CLAUDE_DIRECT_CONNECT_TOKEN
    if (token) headers.authorization = `Bearer ${token}`
    // Bun's WebSocket supports headers and unix transport; DOM typings do not.
    this.ws = options.unix
      ? (new UnixWebSocket(
          `ws+unix://${options.unix}:${new URL(url).pathname}${new URL(url).search}`,
          { headers },
        ) as unknown as WebSocket)
      : new WebSocket(url, {
          ...options,
          headers,
        } as unknown as string[])

    this.ws.addEventListener('open', () => {
      // Input remains queued until the direct_connect ready frame arrives.
    })

    this.ws.addEventListener('message', event => {
      if (typeof event.data !== 'string') {
        this.callbacks.onError?.(new Error('Server sent a binary WebSocket frame'))
        this.ws?.close(1003)
        return
      }
      for (const line of event.data.split('\n')) {
        if (!line.trim()) continue
        let raw: unknown
        try {
          raw = jsonParse(line)
        } catch {
          this.callbacks.onError?.(new Error('Server sent invalid NDJSON'))
          this.ws?.close(1007)
          return
        }
        if (!isStdoutMessage(raw)) continue
        const parsed = raw as Record<string, unknown> & {
          seq?: number
          subtype?: string
          last_seq?: number
          replay_reset?: boolean
          request_ids?: unknown
        }

        if (parsed.type === 'direct_connect') {
          if (parsed.subtype === 'ready') {
            if (parsed.replay_reset) {
              this.lastSeq = 0
              this.callbacks.onReplayReset?.()
            }
            this.ready = true
            this.attempts = 0
            this.callbacks.onConnected?.()
            for (const message of this.outgoing.splice(0)) this.ws?.send(message)
          } else if (parsed.subtype === 'control_invalidated') {
            const ids = Array.isArray(parsed.request_ids)
              ? parsed.request_ids.filter((id): id is string => typeof id === 'string')
              : []
            this.callbacks.onPermissionCancelled?.(ids)
          } else if (parsed.subtype === 'stopped') {
            this.callbacks.onStopped?.()
          }
          continue
        }

        if (typeof parsed.seq === 'number') {
          if (parsed.seq <= this.lastSeq) continue
          if (parsed.seq !== this.lastSeq + 1) {
            this.ws?.close(4000, 'Sequence gap')
            return
          }
          this.lastSeq = parsed.seq
        }
        this.dispatch(parsed as unknown as StdoutMessage)
      }
    })

    this.ws.addEventListener('close', () => {
      this.ready = false
      this.ws = null
      if (this.manuallyClosed) return
      if (this.attempts >= (this.config.maxReconnectAttempts ?? 5)) {
        this.callbacks.onDisconnected?.()
        return
      }
      this.attempts += 1
      const delay = Math.min(2_000, 250 * 2 ** (this.attempts - 1))
      this.callbacks.onReconnecting?.(this.attempts)
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay)
      this.reconnectTimer.unref()
    })

    this.ws.addEventListener('error', () => {
      this.callbacks.onError?.(new Error('WebSocket connection error'))
    })
  }

  private dispatch(parsed: StdoutMessage): void {
    if (parsed.type === 'control_request') {
      if (parsed.request.subtype === 'can_use_tool') {
        this.callbacks.onPermissionRequest(parsed.request, parsed.request_id)
      } else {
        logForDebugging(
          `[DirectConnect] Unsupported control request subtype: ${parsed.request.subtype}`,
        )
        this.sendErrorResponse(
          parsed.request_id,
          `Unsupported control request subtype: ${parsed.request.subtype}`,
        )
      }
      return
    }
    if (
      parsed.type !== 'control_response' &&
      parsed.type !== 'keep_alive' &&
      parsed.type !== 'control_cancel_request' &&
      parsed.type !== 'streamlined_text' &&
      parsed.type !== 'streamlined_tool_use_summary' &&
      !(parsed.type === 'system' && parsed.subtype === 'post_turn_summary')
    ) {
      this.callbacks.onMessage(parsed)
    }
  }

  private sendOrQueue(message: string): boolean {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message)
      return true
    }
    if (!this.started) return false
    if (
      !this.manuallyClosed &&
      this.attempts < (this.config.maxReconnectAttempts ?? 5)
    ) {
      this.outgoing.push(message)
      return true
    }
    return false
  }

  sendMessage(content: RemoteMessageContent): boolean {
    return this.sendOrQueue(
      jsonStringify({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
      }),
    )
  }

  /** Send a protocol record for NDJSON headless controllers. */
  sendMessageRecord(message: Record<string, unknown>): boolean {
    return this.sendOrQueue(jsonStringify(message))
  }

  respondToPermissionRequest(
    requestId: string,
    result: RemotePermissionResponse,
  ): void {
    this.sendOrQueue(
      jsonStringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            behavior: result.behavior,
            ...(result.behavior === 'allow'
              ? { updatedInput: result.updatedInput }
              : { message: result.message }),
          },
        },
      }),
    )
  }

  sendInterrupt(): void {
    this.sendOrQueue(
      jsonStringify({
        type: 'control_request',
        request_id: crypto.randomUUID(),
        request: { subtype: 'interrupt' },
      }),
    )
  }

  private sendErrorResponse(requestId: string, error: string): void {
    this.sendOrQueue(
      jsonStringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error },
      }),
    )
  }

  disconnect(): void {
    this.manuallyClosed = true
    this.ready = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.outgoing.length = 0
    this.ws?.close()
    this.ws = null
  }

  isConnected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN
  }
}
