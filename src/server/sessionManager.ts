import { createHash, randomUUID } from 'crypto'
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getProcessStartToken } from '../utils/processIdentity.js'
import {
  type BackendCreateOptions,
  type BackendSession,
  ProcessBackend,
} from './backends/processBackend.js'
import type {
  SessionIndex,
  SessionIndexEntry,
  SessionInfo,
  SessionState,
} from './types.js'

export const DIRECT_CONNECT_PROTOCOL = 'direct-connect-v1'
const INDEX_VERSION = 1
const DEFAULT_EVENT_LIMIT = 16 * 1024 * 1024

type SessionBackend = {
  create(options: BackendCreateOptions): Promise<BackendSession>
  destroyAll(): Promise<void>
}

export type SessionManagerOptions = {
  idleTimeoutMs: number
  maxSessions: number
  workspace?: string
  allowDangerousSkipPermissions?: boolean
  configDir?: string
  eventLogLimitBytes?: number
  idleSweepIntervalMs?: number
  /** Test/embedding hook; production verifies the native JSONL transcript. */
  transcriptExists?: (entry: SessionIndexEntry) => Promise<boolean>
}

export type CreateSessionRequest = {
  cwd?: string
  dangerouslySkipPermissions?: boolean
  sessionId?: string
  clientRequestId?: string
}

export type CreateSessionResult = {
  sessionId: string
  workDir: string
  state: SessionState
  resumed: boolean
  lastSeq: number
}

export class SessionManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'SessionManagerError'
  }
}

type Connection = {
  send: (record: Record<string, unknown>) => void
  replaying: boolean
  buffered: Record<string, unknown>[]
  sentSeq: number
}

type RuntimeSession = {
  info: SessionInfo
  backend: BackendSession | null
  connections: Set<Connection>
  controlIds: Map<string, string>
  pendingControls: Set<string>
  restored: boolean
  eventChain: Promise<void>
}

type IndexFile = {
  version: number
  ownerId: string
  sessions: SessionIndex
  idempotency?: Record<
    string,
    { hash: string; result: CreateSessionResult }
  >
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function safeError(error: unknown): SessionManagerError {
  if (error instanceof SessionManagerError) return error
  return new SessionManagerError('INTERNAL_ERROR', 'Internal server error', 500)
}

function normalizeIndex(value: unknown): IndexFile {
  if (typeof value !== 'object' || value === null) throw new Error('bad index')
  const raw = value as Partial<IndexFile>
  if (raw.version !== INDEX_VERSION || typeof raw.ownerId !== 'string') {
    throw new Error('bad index version')
  }
  if (typeof raw.sessions !== 'object' || raw.sessions === null) {
    throw new Error('bad sessions')
  }
  const sessions: SessionIndex = {}
  for (const [id, entry] of Object.entries(raw.sessions)) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      ) ||
      !entry ||
      entry.sessionId !== id ||
      typeof entry.transcriptSessionId !== 'string' ||
      typeof entry.cwd !== 'string' ||
      typeof entry.createdAt !== 'number' ||
      typeof entry.lastActiveAt !== 'number'
    ) {
      throw new Error('bad session entry')
    }
    sessions[id] = {
      ...entry,
      state: entry.state ?? 'stopped',
      lastSeq: entry.lastSeq ?? 0,
    }
  }
  return {
    version: INDEX_VERSION,
    ownerId: raw.ownerId,
    sessions,
    ...(raw.idempotency && typeof raw.idempotency === 'object'
      ? { idempotency: raw.idempotency }
      : {}),
  }
}

export class SessionManager {
  private readonly backend: SessionBackend
  private readonly options: SessionManagerOptions
  private readonly configDir: string
  private readonly indexPath: string
  private readonly eventsDir: string
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly idempotency = new Map<
    string,
    { hash: string; result: CreateSessionResult }
  >()
  private readonly ready: Promise<void>
  private ownerId: string = randomUUID()
  private workspaceRoot?: string
  private allowedRoot!: string
  private mutation: Promise<unknown> = Promise.resolve()
  private persistence: Promise<void> = Promise.resolve()
  private indexCorrupt = false
  private shuttingDown = false
  private idleTimer: ReturnType<typeof setInterval> | null = null

  constructor(backend: SessionBackend, options: SessionManagerOptions) {
    this.backend = backend
    this.options = options
    this.configDir = options.configDir ?? getClaudeConfigHomeDir()
    this.indexPath = join(this.configDir, 'server-sessions.json')
    this.eventsDir = join(this.configDir, 'server-events')
    this.ready = this.initialize()
    const interval = options.idleSweepIntervalMs ?? 1_000
    if (options.idleTimeoutMs > 0) {
      this.idleTimer = setInterval(() => void this.reapIdleSessions(), interval)
      this.idleTimer.unref()
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 })
    await chmod(this.configDir, 0o700)
    await mkdir(this.eventsDir, { recursive: true, mode: 0o700 })
    await chmod(this.eventsDir, 0o700)
    const ownerPath = join(this.configDir, 'server-owner')
    try {
      const owner = (await readFile(ownerPath, 'utf8')).trim()
      if (!owner) throw new Error('empty owner')
      this.ownerId = owner
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeFile(ownerPath, this.ownerId, { flag: 'wx', mode: 0o600 })
      await chmod(ownerPath, 0o600)
    }
    this.allowedRoot = await realpath(process.cwd())
    if (this.options.workspace) {
      this.workspaceRoot = await realpath(resolve(this.options.workspace))
    }
    try {
      const index = normalizeIndex(JSON.parse(await readFile(this.indexPath, 'utf8')))
      if (index.ownerId !== this.ownerId) throw new Error('index owner mismatch')
      for (const [id, entry] of Object.entries(index.sessions)) {
        const wasActive = entry.state !== 'stopped'
        const info: SessionInfo = {
          id,
          status: wasActive ? 'stopped' : entry.state,
          createdAt: entry.createdAt,
          workDir: entry.cwd,
          process: null,
          lastActiveAt: entry.lastActiveAt,
          lastSeq: entry.lastSeq,
          transcriptSessionId: entry.transcriptSessionId,
          permissionMode: entry.permissionMode,
          sessionKey: entry.processStartToken,
          exit: wasActive
            ? {
                code: null,
                signal: null,
                reason: 'server_restart',
                endedAt: Date.now(),
              }
            : (entry.exit ?? undefined),
        }
        this.sessions.set(id, {
          info,
          backend: null,
          connections: new Set(),
          controlIds: new Map(),
          pendingControls: new Set(),
          restored: true,
          eventChain: Promise.resolve(),
        })
        if (wasActive) {
          await this.publish(id, {
            type: 'direct_connect',
            subtype: 'control_invalidated',
            reason: 'server_restart',
          })
        }
      }
      for (const [requestId, value] of Object.entries(index.idempotency ?? {})) {
        if (
          value &&
          typeof value.hash === 'string' &&
          value.result &&
          this.sessions.has(value.result.sessionId)
        ) {
          this.idempotency.set(requestId, value)
        }
      }
      await this.persist()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.indexCorrupt = true
      } else {
        await this.persist()
      }
    }
  }

  private eventPath(id: string): string {
    return join(this.eventsDir, `${id}.jsonl`)
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async persist(): Promise<void> {
    const entries: SessionIndex = {}
    for (const [id, runtime] of this.sessions) {
      entries[id] = {
        sessionId: id,
        transcriptSessionId: runtime.info.transcriptSessionId,
        cwd: runtime.info.workDir,
        permissionMode: runtime.info.permissionMode,
        createdAt: runtime.info.createdAt,
        lastActiveAt: runtime.info.lastActiveAt,
        processStartToken: runtime.info.sessionKey,
        state: runtime.info.status,
        lastSeq: runtime.info.lastSeq,
        exit: runtime.info.exit ?? null,
        ownerId: this.ownerId,
      }
    }
    const snapshot: IndexFile = {
      version: INDEX_VERSION,
      ownerId: this.ownerId,
      sessions: entries,
      idempotency: Object.fromEntries(this.idempotency),
    }
    const write = async () => {
      await mkdir(this.configDir, { recursive: true, mode: 0o700 })
      const temporary = `${this.indexPath}.${process.pid}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(snapshot))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await chmod(temporary, 0o600)
      await rename(temporary, this.indexPath)
    }
    const next = this.persistence.then(write, write)
    this.persistence = next.catch(() => undefined)
    return next
  }

  private async resolveCwd(requested?: string): Promise<string> {
    const root = this.workspaceRoot ?? this.allowedRoot
    let candidate: string
    try {
      candidate = await realpath(requested ? resolve(requested) : root)
    } catch {
      throw new SessionManagerError(
        'CWD_NOT_ALLOWED',
        'Requested working directory is not accessible',
        400,
      )
    }
    const targetStat = await stat(candidate)
    if (!targetStat.isDirectory() || !isWithin(root, candidate)) {
      throw new SessionManagerError(
        'CWD_NOT_ALLOWED',
        'Requested working directory is outside the server workspace',
        403,
      )
    }
    return candidate
  }

  private activeCount(): number {
    let count = 0
    for (const runtime of this.sessions.values()) {
      if (runtime.info.status !== 'stopped') count++
    }
    return count
  }

  async createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    await this.ready
    if (this.shuttingDown) {
      throw new SessionManagerError('SERVER_SHUTTING_DOWN', 'Server is shutting down', 503, true)
    }
    if (this.indexCorrupt) {
      throw new SessionManagerError(
        request.sessionId ? 'SESSION_NOT_RESUMABLE' : 'SESSION_INDEX_CORRUPT',
        'Session index is corrupt',
        409,
      )
    }
    if (
      request.clientRequestId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        request.clientRequestId,
      )
    ) {
      throw new SessionManagerError(
        'INVALID_REQUEST',
        'client_request_id must be a UUID',
        400,
      )
    }
    return this.enqueue(async () => {
      const cwd = await this.resolveCwd(request.cwd)
      const hash = requestHash({
        cwd,
        dangerously_skip_permissions: request.dangerouslySkipPermissions === true,
        session_id: request.sessionId ?? null,
      })
      if (request.clientRequestId) {
        const prior = this.idempotency.get(request.clientRequestId)
        if (prior) {
          if (prior.hash !== hash) {
            throw new SessionManagerError(
              'IDEMPOTENCY_CONFLICT',
              'Client request ID was already used with a different request',
              409,
            )
          }
          return { ...prior.result, resumed: true }
        }
      }

      const dangerous = request.dangerouslySkipPermissions === true
      if (dangerous && !this.options.allowDangerousSkipPermissions) {
        throw new SessionManagerError(
          'DANGEROUS_MODE_DISABLED',
          'Dangerous permission mode is disabled by the server',
          403,
        )
      }

      let id = request.sessionId
      let runtime = id ? this.sessions.get(id) : undefined
      let resumed = false
      if (id) {
        if (!runtime) {
          throw new SessionManagerError('SESSION_NOT_FOUND', 'Session not found', 404)
        }
        if (runtime.info.workDir !== cwd && request.cwd) {
          // Resume is rooted in the indexed workspace, never in an unrelated cwd.
          throw new SessionManagerError(
            'CWD_NOT_ALLOWED',
            'Resume cwd does not match the indexed session',
            403,
          )
        }
        if (runtime.info.status !== 'stopped') {
          const result: CreateSessionResult = {
            sessionId: id,
            workDir: runtime.info.workDir,
            state: runtime.info.status,
            resumed: true,
            lastSeq: runtime.info.lastSeq,
          }
          if (request.clientRequestId) {
            this.idempotency.set(request.clientRequestId, { hash, result })
          }
          return result
        }
        await this.validateResume(runtime.info)
        runtime.info.status = 'starting'
        runtime.info.exit = undefined
        resumed = true
      } else {
        if (this.options.maxSessions > 0 && this.activeCount() >= this.options.maxSessions) {
          throw new SessionManagerError(
            'MAX_SESSIONS',
            'Maximum concurrent sessions reached',
            429,
            true,
          )
        }
        id = randomUUID()
        runtime = {
          info: {
            id,
            status: 'starting',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            workDir: cwd,
            process: null,
            lastSeq: 0,
            transcriptSessionId: id,
          },
          backend: null,
          connections: new Set(),
          controlIds: new Map(),
          pendingControls: new Set(),
          restored: false,
          eventChain: Promise.resolve(),
        }
        this.sessions.set(id, runtime)
      }

      const current = runtime
      current.info.permissionMode = dangerous ? 'bypassPermissions' : 'default'
      try {
        const backend = await this.backend.create({
          sessionId: id,
          cwd: current.info.workDir,
          resumeTranscriptId: resumed
            ? current.info.transcriptSessionId
            : undefined,
          permissionMode: dangerous ? 'bypassPermissions' : 'default',
        })
        current.backend = backend
        current.info.process = backend.process
        current.info.status = 'detached'
        current.info.lastActiveAt = Date.now()
        current.restored = false
        backend.on('stdout', (line: string) => this.handleStdout(current, line))
        backend.on('error', () => {
          void this.publish(id, {
            type: 'direct_connect',
            subtype: 'backend_error',
            message: 'Session process error',
          })
        })
        backend.on('exit', (exit: { code: number | null; signal: string | null }) => {
          void this.handleExit(current, exit)
        })
        const token = backend.pid
          ? await getProcessStartToken(backend.pid)
          : undefined
        if (token) current.info.sessionKey = token
        const result: CreateSessionResult = {
          sessionId: id,
          workDir: current.info.workDir,
          state: current.info.status,
          resumed,
          lastSeq: current.info.lastSeq,
        }
        if (request.clientRequestId) {
          this.idempotency.set(request.clientRequestId, { hash, result })
        }
        await this.persist()
        return result
      } catch (error) {
        current.info.status = 'stopped'
        current.info.process = null
        current.info.exit = {
          code: null,
          signal: null,
          reason: 'spawn_failed',
          endedAt: Date.now(),
        }
        await this.persist().catch(() => undefined)
        if (
          dangerous &&
          this.options.allowDangerousSkipPermissions &&
          error instanceof Error &&
          error.message.includes('Dangerous permission mode is disabled')
        ) {
          throw new SessionManagerError(
            'DANGEROUS_MODE_DISABLED',
            'Dangerous permission mode was not enabled on both client and server',
            403,
          )
        }
        throw safeError(error)
      }
    })
  }

  private async validateResume(info: SessionInfo): Promise<void> {
    const indexed = this.sessions.get(info.id)
    if (!indexed || !/^[a-zA-Z0-9_-]+$/.test(info.transcriptSessionId)) {
      throw new SessionManagerError(
        'SESSION_NOT_RESUMABLE',
        'Session metadata is not resumable',
        409,
      )
    }
    if (this.options.transcriptExists) {
      if (!(await this.options.transcriptExists(await this.indexEntry(info)))) {
        throw new SessionManagerError(
          'SESSION_NOT_RESUMABLE',
          'Session transcript is unavailable',
          409,
        )
      }
      return
    }
    const { getProjectDir } = await import('../utils/sessionStorage.js')
    const transcript = join(
      getProjectDir(info.workDir),
      `${info.transcriptSessionId}.jsonl`,
    )
    try {
      const transcriptStat = await stat(transcript)
      if (!transcriptStat.isFile()) throw new Error('not a file')
    } catch {
      throw new SessionManagerError(
        'SESSION_NOT_RESUMABLE',
        'Session transcript is unavailable',
        409,
      )
    }
  }

  private async indexEntry(info: SessionInfo): Promise<SessionIndexEntry> {
    const token = info.sessionKey
    return {
      sessionId: info.id,
      transcriptSessionId: info.transcriptSessionId,
      cwd: info.workDir,
      createdAt: info.createdAt,
      lastActiveAt: info.lastActiveAt,
      processStartToken: token,
      state: info.status,
      lastSeq: info.lastSeq,
      exit: info.exit,
      ownerId: this.ownerId,
    }
  }

  private handleStdout(runtime: RuntimeSession, line: string): void {
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      message = parsed as Record<string, unknown>
    } catch {
      void this.publish(runtime.info.id, {
        type: 'direct_connect',
        subtype: 'backend_error',
        message: 'Subprocess emitted invalid JSON',
      })
      return
    }
    if (
      message.type === 'system' &&
      message.subtype === 'init' &&
      typeof message.session_id === 'string'
    ) {
      runtime.info.transcriptSessionId = message.session_id
    }
    if (message.type === 'control_request' && typeof message.request_id === 'string') {
      runtime.pendingControls.add(message.request_id)
    }
    void this.publish(runtime.info.id, message)
  }

  private async handleExit(
    runtime: RuntimeSession,
    exit: { code: number | null; signal: string | null },
  ): Promise<void> {
    runtime.info.process = null
    runtime.backend = null
    runtime.info.status = 'stopped'
    runtime.info.exit = { ...exit, endedAt: Date.now() }
    if (runtime.pendingControls.size > 0) {
      await this.publish(runtime.info.id, {
        type: 'direct_connect',
        subtype: 'control_invalidated',
        request_ids: [...runtime.pendingControls],
        reason: 'process_exit',
      })
      runtime.pendingControls.clear()
    }
    for (const connection of runtime.connections) {
      connection.send({
        type: 'direct_connect',
        subtype: 'stopped',
        session_id: runtime.info.id,
        exit: runtime.info.exit,
      })
    }
    await this.persist()
  }

  private publish(
    id: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const runtime = this.sessions.get(id)
    if (!runtime) return Promise.resolve()
    const operation = runtime.eventChain.then(
      () => this.publishNow(runtime, message),
      () => this.publishNow(runtime, message),
    )
    runtime.eventChain = operation.catch(() => undefined)
    return operation
  }

  private async publishNow(
    runtime: RuntimeSession,
    message: Record<string, unknown>,
  ): Promise<void> {
    const id = runtime.info.id
    runtime.info.lastSeq += 1
    const record = { ...message, seq: runtime.info.lastSeq }
    try {
      await appendFile(this.eventPath(id), `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      })
      await chmod(this.eventPath(id), 0o600)
      await this.rotateEventsIfNeeded(runtime)
    } catch {
      // Do not send an event which could not be replayed after reconnect.
      runtime.info.lastSeq -= 1
      return
    }
    // Once appended, the event is the source of truth. An index write failure
    // must not cause this seq to be reused; a later flush can recover metadata.
    await this.persist().catch(() => undefined)
    for (const connection of runtime.connections) {
      if (connection.replaying) connection.buffered.push(record)
      else this.sendSequenced(connection, record)
    }
  }

  private sendSequenced(
    connection: Connection,
    record: Record<string, unknown>,
  ): void {
    const seq = typeof record.seq === 'number' ? record.seq : 0
    if (seq <= connection.sentSeq) return
    connection.sentSeq = seq
    connection.send(record)
  }

  private async rotateEventsIfNeeded(runtime: RuntimeSession): Promise<void> {
    const limit = this.options.eventLogLimitBytes ?? DEFAULT_EVENT_LIMIT
    const path = this.eventPath(runtime.info.id)
    const info = await stat(path)
    if (info.size <= limit) return
    const contents = await readFile(path, 'utf8')
    const lines = contents.split('\n').filter(Boolean)
    const retained: string[] = []
    let size = 0
    for (let index = lines.length - 1; index >= 0; index--) {
      const addition = Buffer.byteLength(lines[index]) + 1
      if (retained.length > 0 && size + addition > Math.floor(limit / 2)) break
      retained.unshift(lines[index])
      size += addition
    }
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${retained.join('\n')}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  async attach(
    id: string,
    after: number,
    send: (record: Record<string, unknown>) => void,
  ): Promise<() => void> {
    await this.ready
    const runtime = this.sessions.get(id)
    if (!runtime) {
      throw new SessionManagerError('SESSION_NOT_FOUND', 'Session not found', 404)
    }
    if (!runtime.backend || runtime.info.status === 'stopped') {
      throw new SessionManagerError(
        'SESSION_NOT_RUNNING',
        'Session must be resumed before attaching',
        409,
      )
    }
    if (this.shuttingDown || runtime.info.status === 'stopping') {
      throw new SessionManagerError('SERVER_SHUTTING_DOWN', 'Session is stopping', 503, true)
    }
    const connection: Connection = {
      send,
      replaying: true,
      buffered: [],
      sentSeq: after,
    }
    runtime.connections.add(connection)
    runtime.info.status = 'running'
    runtime.info.lastActiveAt = Date.now()
    let events: Record<string, unknown>[] = []
    let replayReset = false
    try {
      const text = await readFile(this.eventPath(id), 'utf8')
      events = text
        .split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try {
            return [JSON.parse(line) as Record<string, unknown>]
          } catch {
            replayReset = true
            return []
          }
        })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') replayReset = true
    }
    const available = events
      .map(event => (typeof event.seq === 'number' ? event.seq : 0))
      .filter(seq => seq > 0)
    const oldest = available.length ? Math.min(...available) : runtime.info.lastSeq + 1
    if (after + 1 < oldest) replayReset = true
    send({
      type: 'direct_connect',
      subtype: 'ready',
      session_id: id,
      state: runtime.info.status,
      last_seq: runtime.info.lastSeq,
      replayed_from: after,
      ...(replayReset ? { replay_reset: true } : {}),
    })
    for (const event of events) {
      const seq = typeof event.seq === 'number' ? event.seq : 0
      if (seq > after) this.sendSequenced(connection, event)
    }
    connection.replaying = false
    connection.buffered.sort((a, b) => Number(a.seq) - Number(b.seq))
    for (const event of connection.buffered) this.sendSequenced(connection, event)
    connection.buffered = []
    await this.persist()
    return () => {
      if (!runtime.connections.delete(connection)) return
      if (runtime.connections.size === 0 && runtime.info.status === 'running') {
        runtime.info.status = 'detached'
        void this.persist()
      }
    }
  }

  async handleClientMessage(id: string, raw: unknown): Promise<void> {
    const runtime = this.sessions.get(id)
    if (!runtime || !runtime.backend) {
      throw new SessionManagerError('SESSION_NOT_RUNNING', 'Session is not running', 409)
    }
    if (runtime.info.status === 'stopping' || this.shuttingDown) {
      throw new SessionManagerError('SESSION_NOT_RUNNING', 'Session is stopping', 409)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SessionManagerError('INVALID_MESSAGE', 'Message must be an object', 400)
    }
    const message = raw as Record<string, unknown>
    runtime.info.lastActiveAt = Date.now()
    if (message.type === 'user') {
      runtime.backend.write(JSON.stringify({ ...message, session_id: id }))
      return
    }
    if (message.type === 'control_response') {
      const response = message.response as Record<string, unknown> | undefined
      const requestId = response?.request_id
      if (typeof requestId !== 'string') {
        throw new SessionManagerError('INVALID_MESSAGE', 'Missing control request ID', 400)
      }
      const hash = requestHash(message)
      const previous = runtime.controlIds.get(requestId)
      if (previous && previous !== hash) {
        await this.publish(id, {
          type: 'direct_connect',
          subtype: 'error',
          code: 'CONTROL_ID_CONFLICT',
          request_id: requestId,
        })
        return
      }
      runtime.controlIds.set(requestId, hash)
      if (!previous) runtime.backend.write(JSON.stringify(message))
      runtime.pendingControls.delete(requestId)
      return
    }
    if (message.type === 'control_request') {
      const requestId = message.request_id
      const control = message.request as Record<string, unknown> | undefined
      if (typeof requestId !== 'string' || typeof control?.subtype !== 'string') {
        throw new SessionManagerError('INVALID_MESSAGE', 'Invalid control request', 400)
      }
      const hash = requestHash(message)
      const previous = runtime.controlIds.get(requestId)
      if (previous && previous !== hash) {
        await this.publish(id, {
          type: 'direct_connect',
          subtype: 'error',
          code: 'CONTROL_ID_CONFLICT',
          request_id: requestId,
        })
        return
      }
      runtime.controlIds.set(requestId, hash)
      if (previous) return
      if (control.subtype === 'interrupt') {
        runtime.backend.interrupt()
        runtime.backend.write(JSON.stringify(message))
        return
      }
      await this.publish(id, {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: `Unsupported control request subtype: ${control.subtype}`,
        },
      })
      return
    }
    if (message.type === 'keep_alive') return
    throw new SessionManagerError('INVALID_MESSAGE', 'Unsupported message type', 400)
  }

  async getSession(id: string): Promise<Record<string, unknown>> {
    await this.ready
    const runtime = this.sessions.get(id)
    if (!runtime) {
      throw new SessionManagerError('SESSION_NOT_FOUND', 'Session not found', 404)
    }
    return {
      session_id: id,
      state: runtime.info.status,
      cwd: runtime.info.workDir,
      work_dir: runtime.info.workDir,
      transcript_session_id: runtime.info.transcriptSessionId,
      created_at: runtime.info.createdAt,
      last_active_at: runtime.info.lastActiveAt,
      last_seq: runtime.info.lastSeq,
      exit: runtime.info.exit ?? null,
    }
  }

  async deleteSession(id: string): Promise<Record<string, unknown>> {
    await this.ready
    return this.enqueue(async () => {
      const runtime = this.sessions.get(id)
      if (!runtime) {
        throw new SessionManagerError('SESSION_NOT_FOUND', 'Session not found', 404)
      }
      if (runtime.info.status !== 'stopped') {
        runtime.info.status = 'stopping'
        await this.persist()
        await runtime.backend?.stop()
        runtime.info.status = 'stopped'
        runtime.info.process = null
        runtime.backend = null
        runtime.info.exit ??= {
          code: null,
          signal: null,
          reason: 'deleted',
          endedAt: Date.now(),
        }
        await this.persist()
      }
      return this.getSession(id)
    })
  }

  async reapIdleSessions(): Promise<void> {
    await this.ready
    if (this.options.idleTimeoutMs <= 0) return
    const now = Date.now()
    const expired = [...this.sessions.values()].filter(
      runtime =>
        runtime.info.status === 'detached' &&
        runtime.connections.size === 0 &&
        now - runtime.info.lastActiveAt >= this.options.idleTimeoutMs,
    )
    for (const runtime of expired) {
      await this.deleteSession(runtime.info.id)
    }
  }

  async destroyAll(): Promise<void> {
    await this.ready
    this.shuttingDown = true
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = null
    const active = [...this.sessions.values()].filter(
      runtime => runtime.info.status !== 'stopped',
    )
    await Promise.all(
      active.map(async runtime => {
        runtime.info.status = 'stopping'
        await runtime.backend?.stop()
        runtime.info.status = 'stopped'
        runtime.info.process = null
        runtime.backend = null
        runtime.info.exit ??= {
          code: null,
          signal: null,
          reason: 'server_shutdown',
          endedAt: Date.now(),
        }
        runtime.connections.clear()
      }),
    )
    await this.backend.destroyAll()
    await this.persist()
  }

  /** Wait for pending filesystem writes; useful for graceful result cleanup. */
  async flush(): Promise<void> {
    await this.persistence
  }
}

// Keep the production backend part of the public type surface for embedders.
export type { ProcessBackend }
