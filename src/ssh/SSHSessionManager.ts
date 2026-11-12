import type { ChildProcess } from 'child_process'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'
import { validateSessionId } from './argv.js'
import { SSHSessionError } from './errors.js'
import { classifyOpenSSHFailure, StderrTail } from './openSSH.js'

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

export type SSHManagedConnection = {
  proc: ChildProcess
  proxy: { stop: () => void }
  getStderrTail?: () => string
}

export type SSHSessionManagerOptions = {
  connection: SSHManagedConnection
  reconnect?: (activeSessionId: string) => Promise<SSHManagedConnection>
  initTimeoutMs?: number
  maxReconnectAttempts?: number
  reconnectDelayMs?: (attempt: number) => number
  gracefulEofMs?: number
  sigkillDelayMs?: number
}

type State =
  | 'idle'
  | 'initializing'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'disconnected'

type PermissionEntry = {
  generation: number
  remoteRequestId: string
  serialized: string
}

const MAX_STDIN_RECORD = 1024 * 1024
const MAX_STDOUT_LINE = 4 * 1024 * 1024
const NON_RETRYABLE = new Set([
  'SSH_INVALID_ARGUMENT',
  'SSH_UNSUPPORTED_TARGET',
  'SSH_HEADLESS_UNSUPPORTED',
  'SSH_AUTH_FAILED',
  'SSH_HOST_KEY_FAILED',
  'SSH_ARTIFACT_MISSING',
  'SSH_ARTIFACT_MISMATCH',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SSHSessionManager {
  private readonly callbacks: SSHSessionCallbacks
  private readonly options: SSHSessionManagerOptions
  private connection: SSHManagedConnection
  private state: State = 'idle'
  private generation = 0
  private activeSessionId: string | undefined
  private hasConnected = false
  private reconnectAttempt = 0
  private initTimer: NodeJS.Timeout | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private eofTimer: NodeJS.Timeout | undefined
  private killTimer: NodeJS.Timeout | undefined
  private stdoutBuffer = Buffer.alloc(0)
  private discardOversizedLine = false
  private permissions = new Map<string, PermissionEntry>()
  private remotePermissionIds = new Map<string, string>()
  private pendingPrompts = new Set<number>()
  private disconnectedNotified = false
  private recoveryInProgress = false
  private readonly localStderr = new StderrTail()

  constructor(options: SSHSessionManagerOptions, callbacks: SSHSessionCallbacks) {
    this.options = options
    this.connection = options.connection
    this.callbacks = callbacks
  }

  connect(): boolean {
    if (this.state !== 'idle') return false
    this.attach(this.connection)
    if (
      this.connection.proc.exitCode !== null ||
      this.connection.proc.signalCode !== null
    ) {
      const generation = this.generation
      queueMicrotask(() =>
        this.handleProcessClose(
          generation,
          this.connection.proc.exitCode,
          this.connection.proc.signalCode,
        ),
      )
    }
    return true
  }

  disconnect(): boolean {
    if (this.state === 'disconnected' || this.state === 'disconnecting') return false
    this.state = 'disconnecting'
    this.clearInitTimer()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.invalidatePermissions()
    const proc = this.connection.proc
    const stdin = proc.stdin
    if (stdin?.writable && !stdin.destroyed) {
      const request = {
        type: 'control_request',
        request_id: `disconnect-${this.generation}-${Date.now()}`,
        request: { subtype: 'end_session' },
      }
      try {
        stdin.write(`${JSON.stringify(request)}\n`, () => stdin.end())
      } catch {
        stdin.end()
      }
    }
    this.eofTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM')
      this.killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      }, this.options.sigkillDelayMs ?? 5_000)
      this.killTimer.unref()
    }, this.options.gracefulEofMs ?? 2_000)
    this.eofTimer.unref()
    this.connection.proxy.stop()
    // A mocked/already-exited process may not emit another close event.
    if (proc.exitCode !== null || proc.signalCode !== null) this.finishDisconnected()
    return true
  }

  async sendMessage(content: RemoteMessageContent): Promise<boolean> {
    const generation = this.generation
    if (!this.writable(generation)) return false
    const message = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    }
    const sent = this.writeRecord(message, generation)
    this.pendingPrompts.add(generation)
    const delivered = await sent
    if (!delivered) this.pendingPrompts.delete(generation)
    return delivered
  }

  respondToPermissionRequest(
    requestId: string,
    result: RemotePermissionResponse,
  ): boolean {
    const entry = this.permissions.get(requestId)
    if (!entry || entry.generation !== this.generation || this.state !== 'connected') {
      return false
    }
    this.permissions.delete(requestId)
    const response = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: entry.remoteRequestId,
        response: {
          behavior: result.behavior,
          ...(result.behavior === 'allow'
            ? { updatedInput: result.updatedInput }
            : { message: result.message }),
        },
      },
    }
    return this.writeRecordSync(response, entry.generation)
  }

  sendInterrupt(): boolean {
    return this.writeRecordSync(
      {
        type: 'control_request',
        request_id: `interrupt-${this.generation}-${crypto.randomUUID()}`,
        request: { subtype: 'interrupt' },
      },
      this.generation,
    )
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  getStderrTail(): string {
    return this.connection.getStderrTail?.() ?? this.localStderr.get()
  }

  private attach(connection: SSHManagedConnection): void {
    this.connection = connection
    this.generation++
    const generation = this.generation
    this.stdoutBuffer = Buffer.alloc(0)
    this.discardOversizedLine = false
    this.recoveryInProgress = false
    this.permissions.clear()
    this.remotePermissionIds.clear()
    this.state = this.reconnectAttempt > 0 ? 'reconnecting' : 'initializing'
    const proc = connection.proc
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      if (generation === this.generation) this.onStdout(Buffer.from(chunk))
    })
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      if (generation === this.generation) this.localStderr.append(chunk)
    })
    proc.on('error', error => {
      if (generation !== this.generation || this.state === 'disconnecting') return
      this.callbacks.onError(error)
    })
    proc.on('close', (code, signal) => this.handleProcessClose(generation, code, signal))
    this.clearInitTimer()
    this.initTimer = setTimeout(() => {
      if (generation !== this.generation || this.state === 'connected') return
      this.callbacks.onError(
        new SSHSessionError('SSH_INIT_TIMEOUT', 'Timed out waiting for remote system/init'),
      )
      void this.scheduleReconnect(generation, null)
      this.terminateCurrent()
    }, this.options.initTimeoutMs ?? 30_000)
    this.initTimer.unref()
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline === -1) break
      const line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (this.discardOversizedLine) {
        this.discardOversizedLine = false
        continue
      }
      if (line.length > MAX_STDOUT_LINE) {
        this.reportProtocolError('Remote NDJSON line exceeded 4 MiB')
        continue
      }
      if (line.length > 0) this.parseLine(line.toString('utf8'))
    }
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE) {
      this.stdoutBuffer = Buffer.alloc(0)
      this.discardOversizedLine = true
      this.reportProtocolError('Remote NDJSON line exceeded 4 MiB')
    }
  }

  private parseLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.reportProtocolError('Remote emitted invalid NDJSON')
      return
    }
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      this.reportProtocolError('Remote emitted an invalid message')
      return
    }
    if (raw.type === 'control_request') {
      this.onControlRequest(raw)
      return
    }
    if (
      raw.type === 'control_response' ||
      raw.type === 'keep_alive' ||
      raw.type === 'control_cancel_request' ||
      raw.type === 'streamlined_text' ||
      raw.type === 'streamlined_tool_use_summary'
    ) {
      return
    }
    if (raw.type.startsWith('control_')) {
      const requestId = typeof raw.request_id === 'string' ? raw.request_id : undefined
      this.reportProtocolError(`Unknown control message: ${raw.type}`, requestId)
      return
    }
    if (raw.type === 'system' && raw.subtype === 'init') {
      if (typeof raw.session_id !== 'string') {
        this.reportProtocolError('Remote system/init has no session_id')
        return
      }
      try {
        validateSessionId(raw.session_id)
      } catch {
        this.reportProtocolError('Remote system/init has an invalid session_id')
        return
      }
      if (this.state !== 'connected') {
        this.activeSessionId = raw.session_id
        this.hasConnected = true
        this.clearInitTimer()
        this.reconnectAttempt = 0
        this.state = 'connected'
        this.callbacks.onConnected()
      }
    } else {
      // Any actual SDK turn activity is the only available acknowledgement for
      // stream-json user input. Until then a disconnect is delivery_unknown.
      this.pendingPrompts.clear()
    }
    this.callbacks.onMessage(raw as unknown as SDKMessage)
  }

  private onControlRequest(raw: Record<string, unknown>): void {
    const requestId = raw.request_id
    const request = raw.request
    if (
      typeof requestId !== 'string' ||
      !requestId ||
      !isRecord(request) ||
      typeof request.subtype !== 'string'
    ) {
      this.reportProtocolError('Invalid control request')
      return
    }
    const serialized = JSON.stringify(request)
    const previous = this.remotePermissionIds.get(requestId)
    if (previous !== undefined) {
      if (previous !== serialized) {
        this.callbacks.onError(
          new SSHSessionError(
            'CONTROL_ID_CONFLICT',
            `Control request ID was reused with different content: ${requestId}`,
          ),
        )
        this.sendControlError(requestId, 'Control request ID conflict')
      }
      return
    }
    this.remotePermissionIds.set(requestId, serialized)
    if (request.subtype !== 'can_use_tool') {
      this.reportProtocolError(`Unsupported control request: ${request.subtype}`, requestId)
      return
    }
    if (
      typeof request.tool_name !== 'string' ||
      typeof request.tool_use_id !== 'string' ||
      !isRecord(request.input)
    ) {
      this.reportProtocolError('Invalid can_use_tool request', requestId)
      return
    }
    // Scope the UI-visible ID to this process generation. A late click from a
    // previous connection can never resolve a request on the new process.
    const localId = `g${this.generation}:${requestId}`
    this.permissions.set(localId, {
      generation: this.generation,
      remoteRequestId: requestId,
      serialized,
    })
    this.callbacks.onPermissionRequest(
      request as unknown as SDKControlPermissionRequest,
      localId,
    )
  }

  private reportProtocolError(message: string, requestId?: string): void {
    this.callbacks.onError(new SSHSessionError('SSH_INVALID_ARGUMENT', message))
    if (requestId) this.sendControlError(requestId, message)
  }

  private sendControlError(requestId: string, error: string): void {
    this.writeRecordSync(
      {
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error },
      },
      this.generation,
      true,
    )
  }

  private writable(generation: number, allowBeforeInit = false): boolean {
    const stdin = this.connection.proc.stdin
    return (
      generation === this.generation &&
      (this.state === 'connected' || (allowBeforeInit && this.state !== 'disconnected')) &&
      !!stdin?.writable &&
      !stdin.destroyed &&
      !stdin.writableNeedDrain
    )
  }

  private serialize(record: unknown): string | undefined {
    let line: string
    try {
      line = `${JSON.stringify(record)}\n`
    } catch {
      return undefined
    }
    if (Buffer.byteLength(line) > MAX_STDIN_RECORD) {
      this.callbacks.onError(
        new SSHSessionError('SSH_INVALID_ARGUMENT', 'NDJSON stdin record exceeds 1 MiB'),
      )
      return undefined
    }
    return line
  }

  private writeRecordSync(
    record: unknown,
    generation: number,
    allowBeforeInit = false,
  ): boolean {
    if (!this.writable(generation, allowBeforeInit)) return false
    const line = this.serialize(record)
    if (!line) return false
    try {
      // A false return means accepted into the kernel/userland buffer with
      // backpressure, not failure. writableNeedDrain gates subsequent writes.
      this.connection.proc.stdin!.write(line)
      return true
    } catch {
      return false
    }
  }

  private async writeRecord(record: unknown, generation: number): Promise<boolean> {
    if (!this.writable(generation)) return false
    const line = this.serialize(record)
    if (!line) return false
    const stdin = this.connection.proc.stdin!
    try {
      if (stdin.write(line)) return generation === this.generation && this.state === 'connected'
      await new Promise<boolean>(resolve => {
        const done = (value: boolean) => {
          stdin.off('drain', onDrain)
          stdin.off('close', onClose)
          stdin.off('error', onError)
          resolve(value)
        }
        const onDrain = () => done(true)
        const onClose = () => done(false)
        const onError = () => done(false)
        stdin.once('drain', onDrain)
        stdin.once('close', onClose)
        stdin.once('error', onError)
      })
      return generation === this.generation && this.state === 'connected'
    } catch {
      return false
    }
  }

  private handleProcessClose(
    generation: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (generation !== this.generation || this.state === 'disconnected') return
    if (this.recoveryInProgress && this.state !== 'disconnecting') return
    this.clearInitTimer()
    if (this.eofTimer) clearTimeout(this.eofTimer)
    if (this.killTimer) clearTimeout(this.killTimer)
    this.connection.proxy.stop()
    if (this.state === 'disconnecting') {
      this.finishDisconnected()
      return
    }
    if (code === 0 && this.state === 'connected') {
      this.finishDisconnected()
      return
    }
    this.notifyDeliveryUnknown(generation)
    this.invalidatePermissions()
    if (!this.hasConnected) {
      const stderr = this.getStderrTail()
      if (/remote forward.*failed|administratively prohibited/i.test(stderr)) {
        this.callbacks.onError(
          new SSHSessionError('SSH_FORWARD_FAILED', stderr.trim() || 'SSH forwarding failed'),
        )
        this.finishDisconnected()
        return
      }
      const classified = classifyOpenSSHFailure(
        { code, signal, stdout: '', stderr },
        'SSH_CONNECTION_LOST',
      )
      if (classified.code !== 'SSH_CONNECTION_LOST') {
        this.callbacks.onError(classified)
        this.finishDisconnected()
        return
      }
    }
    void this.scheduleReconnect(generation, code ?? (signal ? 1 : 0))
  }

  private async scheduleReconnect(
    generation: number,
    _exitCode: number | null,
    continuation = false,
  ): Promise<void> {
    if (generation !== this.generation || this.state === 'disconnecting') return
    if (!continuation && this.recoveryInProgress && this.state === 'reconnecting') return
    this.recoveryInProgress = true
    const reconnect = this.options.reconnect
    const configuredMax = this.options.maxReconnectAttempts ?? 3
    const max = this.hasConnected ? configuredMax : Math.min(configuredMax, 2)
    if (!reconnect) {
      this.callbacks.onError(
        new SSHSessionError('SSH_CONNECTION_LOST', 'SSH process exited and reconnect is unavailable'),
      )
      this.finishDisconnected()
      return
    }
    const attempt = ++this.reconnectAttempt
    if (attempt > max) {
      this.callbacks.onError(
        new SSHSessionError(
          'SSH_RECONNECT_EXHAUSTED',
          `SSH reconnect exhausted after ${max} attempts`,
        ),
      )
      this.finishDisconnected()
      return
    }
    this.state = 'reconnecting'
    this.callbacks.onReconnecting(attempt, max)
    const delay = this.options.reconnectDelayMs?.(attempt) ?? 1000 * 2 ** (attempt - 1)
    await new Promise<void>(resolve => {
      this.reconnectTimer = setTimeout(resolve, delay)
      this.reconnectTimer.unref()
    })
    if (generation !== this.generation || this.state !== 'reconnecting') return
    await this.ensureCurrentProcessStopped()
    if (generation !== this.generation || this.state !== 'reconnecting') return
    try {
      const next = await reconnect(this.activeSessionId ?? '')
      if (generation !== this.generation || this.state !== 'reconnecting') {
        next.proxy.stop()
        if (next.proc.exitCode === null && next.proc.signalCode === null) {
          next.proc.kill('SIGTERM')
        }
        return
      }
      this.attach(next)
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error(String(error)))
      if (error instanceof SSHSessionError && NON_RETRYABLE.has(error.code)) {
        this.finishDisconnected()
        return
      }
      // Keep the same generation while waiting for the next attempt. No old
      // writer is revived and no prompt is replayed.
      this.generation = generation
      this.state = 'reconnecting'
      void this.scheduleReconnect(generation, null, true)
    }
  }

  private notifyDeliveryUnknown(generation: number): void {
    if (!this.pendingPrompts.has(generation)) return
    this.pendingPrompts.clear()
    this.callbacks.onError(
      new SSHSessionError(
        'SSH_DELIVERY_UNKNOWN',
        'An in-flight request was lost; delivery is unknown and it will not be replayed',
      ),
    )
  }

  private invalidatePermissions(): void {
    this.permissions.clear()
    this.remotePermissionIds.clear()
  }

  private terminateCurrent(): void {
    const proc = this.connection.proc
    this.connection.proxy.stop()
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM')
  }

  private async ensureCurrentProcessStopped(): Promise<void> {
    const proc = this.connection.proc
    if (proc.exitCode !== null || proc.signalCode !== null) return
    proc.kill('SIGKILL')
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 1_000)
      timer.unref()
      proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private clearInitTimer(): void {
    if (this.initTimer) clearTimeout(this.initTimer)
    this.initTimer = undefined
  }

  private finishDisconnected(): void {
    if (this.disconnectedNotified) return
    this.state = 'disconnected'
    this.clearInitTimer()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.eofTimer) clearTimeout(this.eofTimer)
    if (this.killTimer) clearTimeout(this.killTimer)
    this.connection.proxy.stop()
    this.invalidatePermissions()
    this.disconnectedNotified = true
    this.callbacks.onDisconnected()
  }
}
