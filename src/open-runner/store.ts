import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { dirname, join } from 'path'
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LEASE_MS,
  MAX_EVENT_BATCH_BYTES,
  MAX_EVENT_BYTES,
  OPEN_RUNNER_PROTOCOL,
  OpenRunnerError,
  type LeaseIdentity,
  type RunnerIdentity,
  type RunnerRegistration,
  type WorkAssignment,
  type WorkError,
  type WorkEvent,
  type WorkEventInput,
  type WorkInput,
  type WorkRecord,
  type WorkState,
  WORK_STATES,
  assertInteger,
  assertKeys,
  assertObject,
  assertRfc3339,
  assertUuid,
  canonicalJson,
  contentHash,
  invalidRequest,
  isObject,
  isTerminalState,
  isUuid,
  normalizeWorkInput,
  publicWork,
} from './protocol.js'

const STATE_VERSION = 1
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_MAX_RUNTIME_MS = 3_600_000

type StoredRunner = RunnerIdentity & {
  last_seen_at: string
}

export type StoredWork = WorkRecord & {
  protocol: typeof OPEN_RUNNER_PROTOCOL
  lease_id: string | null
  lease_expires_at: string | null
  runner_id: string | null
  instance_id: string | null
  worker_epoch: number | null
  next_attempt_at: string | null
  submit_hash: string
  completion_hash: string | null
  retryable: boolean
}

type StoredEvent = WorkEvent & { hash: string }

type PersistentState = {
  version: typeof STATE_VERSION
  protocol: typeof OPEN_RUNNER_PROTOCOL
  works: Record<string, StoredWork>
  runners: Record<string, StoredRunner>
  order: string[]
}

export type OpenRunnerStoreOptions = {
  stateDir: string
  leaseMs?: number
  heartbeatIntervalMs?: number
  now?: () => number
  monotonicNow?: () => number
  retryBaseMs?: number
}

export type SubmitWork = {
  work_id: string
  input: unknown
  max_attempts?: number
  max_runtime_ms?: number
}

function emptyState(): PersistentState {
  return {
    version: STATE_VERSION,
    protocol: OPEN_RUNNER_PROTOCOL,
    works: {},
    runners: {},
    order: [],
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch {
    // Some platforms do not permit directory fsync. The rename itself is
    // still atomic; platforms that support directory fsync get durability.
  } finally {
    await handle?.close().catch(() => {})
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
    await fsyncDirectory(dirname(path))
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

async function appendDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await chmod(path, 0o600)
  } finally {
    await handle.close()
  }
}

function staleLease(): OpenRunnerError {
  return new OpenRunnerError('STALE_LEASE', 'Work lease is stale', 409)
}

function workNotFound(): OpenRunnerError {
  return new OpenRunnerError('WORK_NOT_FOUND', 'Work not found', 404)
}

export class OpenRunnerStore {
  private state: PersistentState = emptyState()
  private events = new Map<string, StoredEvent[]>()
  private eventIds = new Map<string, Map<string, StoredEvent>>()
  private leaseDeadlines = new Map<string, number>()
  private operation: Promise<unknown> = Promise.resolve()
  private readonly changes = new EventEmitter()
  private readonly lockPath: string
  private readonly startupToken = randomUUID()
  private initialized = false
  private closed = false

  readonly leaseMs: number
  readonly heartbeatIntervalMs: number

  constructor(private readonly options: OpenRunnerStoreOptions) {
    this.lockPath = join(options.stateDir, 'locks', 'server.lock')
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (this.leaseMs < 1 || this.heartbeatIntervalMs < 1) {
      throw new Error('Lease and heartbeat intervals must be positive')
    }
  }

  get stateDir(): string {
    return this.options.stateDir
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private monotonicNow(): number {
    return (this.options.monotonicNow ?? (() => performance.now()))()
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const { stateDir } = this.options
    await mkdir(join(stateDir, 'events'), { recursive: true, mode: 0o700 })
    await mkdir(join(stateDir, 'locks'), { recursive: true, mode: 0o700 })
    await chmod(stateDir, 0o700)
    await chmod(join(stateDir, 'events'), 0o700)
    await chmod(join(stateDir, 'locks'), 0o700)

    let lock: FileHandle
    try {
      lock = await open(this.lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Open Runner state directory is locked by another instance')
      }
      throw error
    }
    try {
      await lock.writeFile(
        JSON.stringify({
          protocol: OPEN_RUNNER_PROTOCOL,
          pid: process.pid,
          startup_token: this.startupToken,
          started_at: this.timestamp(),
        }),
      )
      await lock.sync()
    } catch (error) {
      await lock.close().catch(() => {})
      await unlink(this.lockPath).catch(() => {})
      throw error
    }
    await lock.close()

    try {
      await this.load()
      this.initialized = true
    } catch (error) {
      await this.releaseLock()
      throw error
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      const current = JSON.parse(await readFile(this.lockPath, 'utf8')) as {
        startup_token?: string
      }
      if (current.startup_token === this.startupToken) {
        await unlink(this.lockPath)
      }
    } catch {
      // Never remove a lock whose identity cannot be verified.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.operation.catch(() => {})
    this.closed = true
    this.changes.removeAllListeners()
    if (this.initialized) await this.releaseLock()
  }

  private async load(): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(
        await readFile(join(this.options.stateDir, 'state.json'), 'utf8'),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState()
        await this.persist()
        return
      }
      throw new Error('Open Runner state.json is corrupt or unreadable')
    }
    this.state = this.validateState(parsed)
    this.state.order.forEach(id => {
      this.events.set(id, [])
      this.eventIds.set(id, new Map())
    })

    const eventDirectory = join(this.options.stateDir, 'events')
    const names = await readdir(eventDirectory)
    for (const name of names.sort()) {
      if (!name.endsWith('.jsonl')) {
        throw new Error(`Unexpected file in Open Runner events directory: ${name}`)
      }
      const workId = name.slice(0, -'.jsonl'.length)
      if (!isUuid(workId) || !this.state.works[workId]) {
        throw new Error('Open Runner event file has an invalid work ID')
      }
      let text: string
      try {
        text = await readFile(join(eventDirectory, name), 'utf8')
      } catch {
        throw new Error('Open Runner event log is unreadable')
      }
      const lines = text === '' ? [] : text.split('\n')
      if (lines.at(-1) !== '') {
        throw new Error('Open Runner event log has a partial final record')
      }
      lines.pop()
      const stored: StoredEvent[] = []
      const ids = new Map<string, StoredEvent>()
      for (let index = 0; index < lines.length; index++) {
        let candidate: unknown
        try {
          candidate = JSON.parse(lines[index]!)
        } catch {
          throw new Error('Open Runner event log contains invalid JSON')
        }
        const event = this.validateStoredEvent(candidate, workId, index + 1)
        if (ids.has(event.event_id)) {
          throw new Error('Open Runner event log contains duplicate event IDs')
        }
        stored.push(event)
        ids.set(event.event_id, event)
      }
      this.events.set(workId, stored)
      this.eventIds.set(workId, ids)
      if (this.state.works[workId]!.last_seq > stored.length) {
        throw new Error('Open Runner state references missing events')
      }
      if (this.state.works[workId]!.last_seq < stored.length) {
        // An append can survive a crash before the state rename. Those records
        // were not acknowledged, but retaining and numbering them is safe.
        this.state.works[workId]!.last_seq = stored.length
      }
    }
    for (const work of Object.values(this.state.works)) {
      if (work.lease_expires_at && work.lease_id) {
        this.leaseDeadlines.set(
          work.work_id,
          this.monotonicNow() +
            Math.max(0, Date.parse(work.lease_expires_at) - this.now()),
        )
      }
    }
    await this.persist()
  }

  private validateState(value: unknown): PersistentState {
    const root = assertObject(value, 'state')
    if (
      root.version !== STATE_VERSION ||
      root.protocol !== OPEN_RUNNER_PROTOCOL ||
      !isObject(root.works) ||
      !isObject(root.runners) ||
      !Array.isArray(root.order)
    ) {
      throw new Error('Open Runner state schema is invalid')
    }
    const state = root as unknown as PersistentState
    const ids = new Set<string>()
    for (const id of state.order) {
      if (!isUuid(id) || ids.has(id) || !state.works[id]) {
        throw new Error('Open Runner work queue is invalid')
      }
      ids.add(id)
    }
    if (ids.size !== Object.keys(state.works).length) {
      throw new Error('Open Runner work queue is incomplete')
    }
    for (const [id, work] of Object.entries(state.works)) {
      if (!isUuid(id) || work.work_id !== id || !isUuid(work.session_id)) {
        throw new Error('Open Runner work identity is invalid')
      }
      if (
        work.protocol !== OPEN_RUNNER_PROTOCOL ||
        !WORK_STATES.includes(work.state) ||
        !Number.isSafeInteger(work.attempt) ||
        work.attempt < 0 ||
        !Number.isSafeInteger(work.max_attempts) ||
        work.max_attempts < 1 ||
        work.max_attempts > 5 ||
        !Number.isSafeInteger(work.max_runtime_ms) ||
        work.max_runtime_ms < 1 ||
        !Number.isSafeInteger(work.last_seq) ||
        work.last_seq < 0 ||
        typeof work.cancel_requested !== 'boolean' ||
        typeof work.created_at !== 'string' ||
        !Number.isFinite(Date.parse(work.created_at)) ||
        typeof work.updated_at !== 'string' ||
        !Number.isFinite(Date.parse(work.updated_at)) ||
        typeof work.submit_hash !== 'string' ||
        typeof work.retryable !== 'boolean'
      ) {
        throw new Error('Open Runner work schema is invalid')
      }
      try {
        normalizeWorkInput(work.input)
      } catch {
        throw new Error('Open Runner work input is invalid')
      }
      const leased = work.state === 'leased' || work.state === 'running'
      if (
        leased &&
        (!isUuid(work.lease_id) ||
          !isUuid(work.runner_id) ||
          !isUuid(work.instance_id) ||
          !Number.isSafeInteger(work.worker_epoch) ||
          typeof work.lease_expires_at !== 'string' ||
          !Number.isFinite(Date.parse(work.lease_expires_at)))
      ) {
        throw new Error('Open Runner lease schema is invalid')
      }
      if (work.next_attempt_at !== null) {
        if (
          typeof work.next_attempt_at !== 'string' ||
          !Number.isFinite(Date.parse(work.next_attempt_at))
        ) {
          throw new Error('Open Runner retry deadline is invalid')
        }
      }
    }
    for (const [id, runner] of Object.entries(state.runners)) {
      if (
        !isUuid(id) ||
        runner.runner_id !== id ||
        !isUuid(runner.instance_id) ||
        !Number.isSafeInteger(runner.worker_epoch) ||
        runner.worker_epoch < 1
      ) {
        throw new Error('Open Runner runner schema is invalid')
      }
    }
    return state
  }

  private validateStoredEvent(
    value: unknown,
    workId: string,
    expectedSeq: number,
  ): StoredEvent {
    if (!isObject(value)) throw new Error('Open Runner event schema is invalid')
    const event = value as unknown as StoredEvent
    if (
      event.seq !== expectedSeq ||
      !isUuid(event.event_id) ||
      !['sdk', 'process', 'log', 'error'].includes(event.kind) ||
      typeof event.occurred_at !== 'string' ||
      !Number.isFinite(Date.parse(event.occurred_at)) ||
      event.hash !==
        contentHash({
          event_id: event.event_id,
          kind: event.kind,
          occurred_at: event.occurred_at,
          message: event.message,
        }) ||
      Buffer.byteLength(JSON.stringify(event.message), 'utf8') > MAX_EVENT_BYTES
    ) {
      throw new Error(`Open Runner event schema is invalid for work ${workId}`)
    }
    return event
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(async () => {
      if (this.closed) throw new Error('Open Runner store is closed')
      if (!this.initialized) throw new Error('Open Runner store is not initialized')
      return operation()
    })
    this.operation = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(join(this.options.stateDir, 'state.json'), this.state)
  }

  private changed(): void {
    this.changes.emit('change')
  }

  wakeUp(): void {
    this.changed()
  }

  async waitForChange(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const done = () => {
        clearTimeout(timer)
        this.changes.off('change', done)
        resolve()
      }
      timer = setTimeout(done, timeoutMs)
      this.changes.once('change', done)
    })
  }

  private assertRunner(identity: RunnerIdentity): StoredRunner {
    const runner = this.state.runners[identity.runner_id]
    if (
      !runner ||
      runner.instance_id !== identity.instance_id ||
      runner.worker_epoch !== identity.worker_epoch
    ) {
      throw new OpenRunnerError(
        'STALE_WORKER_EPOCH',
        'Worker instance has been fenced',
        409,
      )
    }
    return runner
  }

  private work(id: string): StoredWork {
    assertUuid(id, 'work_id')
    const work = this.state.works[id]
    if (!work) throw workNotFound()
    return work
  }

  private expire(work: StoredWork): boolean {
    if (work.state !== 'leased' && work.state !== 'running') return false
    const deadline = this.leaseDeadlines.get(work.work_id)
    const expired =
      deadline !== undefined
        ? this.monotonicNow() >= deadline
        : !work.lease_expires_at ||
          this.now() >= Date.parse(work.lease_expires_at)
    if (!expired) return false
    work.lease_id = null
    work.lease_expires_at = null
    work.runner_id = null
    work.instance_id = null
    work.worker_epoch = null
    work.completion_hash = null
    this.leaseDeadlines.delete(work.work_id)
    work.updated_at = this.timestamp()
    if (work.cancel_requested) {
      work.state = 'cancelled'
      work.error = { code: 'CANCELLED', message: 'Work was cancelled' }
    } else if (work.attempt < work.max_attempts) {
      work.state = 'retry_wait'
      work.next_attempt_at = new Date(
        this.now() + this.retryDelay(work.attempt),
      ).toISOString()
      work.error = {
        code: 'LEASE_EXPIRED',
        message: 'Work lease expired; another attempt may run',
      }
    } else {
      work.state = 'failed'
      work.next_attempt_at = null
      work.error = {
        code: 'LEASE_EXPIRED',
        message: 'Work lease expired with no attempts remaining',
      }
    }
    return true
  }

  private retryDelay(attempt: number): number {
    const base = this.options.retryBaseMs ?? 1_000
    return Math.min(30_000, base * 2 ** Math.max(0, attempt - 1))
  }

  private expireAll(): boolean {
    let changed = false
    for (const work of Object.values(this.state.works)) {
      changed = this.expire(work) || changed
    }
    return changed
  }

  private assertLease(work: StoredWork, identity: LeaseIdentity): void {
    this.assertRunner(identity)
    if (
      work.lease_id !== identity.lease_id ||
      work.runner_id !== identity.runner_id ||
      work.instance_id !== identity.instance_id ||
      work.worker_epoch !== identity.worker_epoch
    ) {
      throw staleLease()
    }
    if (this.expire(work)) throw staleLease()
  }

  async register(value: unknown): Promise<RunnerRegistration> {
    const body = assertObject(value)
    assertKeys(body, ['runner_id', 'instance_id', 'capabilities'], [
      'runner_id',
      'instance_id',
      'capabilities',
    ])
    const runnerId = assertUuid(body.runner_id, 'runner_id')
    const instanceId = assertUuid(body.instance_id, 'instance_id')
    const capabilities = assertObject(body.capabilities, 'capabilities')
    assertKeys(capabilities, ['max_work', 'permission_modes'], [
      'max_work',
      'permission_modes',
    ])
    assertInteger(capabilities.max_work, 'capabilities.max_work', 1, 100)
    if (
      !Array.isArray(capabilities.permission_modes) ||
      capabilities.permission_modes.length === 0 ||
      capabilities.permission_modes.some(
        mode => !['default', 'acceptEdits', 'plan'].includes(mode as string),
      )
    ) {
      throw invalidRequest('capabilities.permission_modes is invalid')
    }
    return this.serialize(async () => {
      let runner = this.state.runners[runnerId]
      if (!runner) {
        runner = {
          runner_id: runnerId,
          instance_id: instanceId,
          worker_epoch: 1,
          last_seen_at: this.timestamp(),
        }
      } else if (runner.instance_id !== instanceId) {
        runner = {
          ...runner,
          instance_id: instanceId,
          worker_epoch: runner.worker_epoch + 1,
          last_seen_at: this.timestamp(),
        }
      } else {
        runner.last_seen_at = this.timestamp()
      }
      this.state.runners[runnerId] = runner
      await this.persist()
      this.changed()
      return {
        runner_id: runnerId,
        instance_id: instanceId,
        worker_epoch: runner.worker_epoch,
        heartbeat_interval_ms: this.heartbeatIntervalMs,
        lease_ms: this.leaseMs,
        server_time: this.timestamp(),
      }
    })
  }

  async submit(value: unknown): Promise<WorkRecord> {
    const body = assertObject(value)
    assertKeys(body, ['work_id', 'input', 'max_attempts', 'max_runtime_ms'], [
      'work_id',
      'input',
    ])
    const workId = assertUuid(body.work_id, 'work_id')
    const input = normalizeWorkInput(body.input)
    const maxAttempts =
      body.max_attempts === undefined
        ? DEFAULT_MAX_ATTEMPTS
        : assertInteger(body.max_attempts, 'max_attempts', 1, 5)
    const maxRuntime =
      body.max_runtime_ms === undefined
        ? DEFAULT_MAX_RUNTIME_MS
        : assertInteger(body.max_runtime_ms, 'max_runtime_ms', 1, 2_147_483_647)
    const normalized: SubmitWork = {
      work_id: workId,
      input,
      max_attempts: maxAttempts,
      max_runtime_ms: maxRuntime,
    }
    const hash = contentHash(normalized)
    return this.serialize(async () => {
      const existing = this.state.works[workId]
      if (existing) {
        if (existing.submit_hash !== hash) {
          throw new OpenRunnerError(
            'IDEMPOTENCY_CONFLICT',
            'Work ID was already submitted with different input',
            409,
          )
        }
        return publicWork(existing)
      }
      const now = this.timestamp()
      const work: StoredWork = {
        protocol: OPEN_RUNNER_PROTOCOL,
        work_id: workId,
        session_id: input.session_id ?? randomUUID(),
        state: 'queued',
        attempt: 0,
        input,
        max_attempts: maxAttempts,
        max_runtime_ms: maxRuntime,
        cancel_requested: false,
        created_at: now,
        updated_at: now,
        last_seq: 0,
        result: null,
        error: null,
        lease_id: null,
        lease_expires_at: null,
        runner_id: null,
        instance_id: null,
        worker_epoch: null,
        next_attempt_at: null,
        submit_hash: hash,
        completion_hash: null,
        retryable: false,
      }
      this.state.works[workId] = work
      this.state.order.push(workId)
      this.events.set(workId, [])
      this.eventIds.set(workId, new Map())
      const eventHandle = await open(
        join(this.options.stateDir, 'events', `${workId}.jsonl`),
        'wx',
        0o600,
      )
      await eventHandle.sync()
      await eventHandle.close()
      await this.persist()
      this.changed()
      return publicWork(work)
    })
  }

  async poll(value: unknown): Promise<{
    server_time: string
    work: WorkAssignment[]
    cancel_requested: string[]
  }> {
    const body = assertObject(value)
    assertKeys(
      body,
      ['runner_id', 'instance_id', 'worker_epoch', 'max_work', 'wait_ms'],
      ['runner_id', 'instance_id', 'worker_epoch', 'max_work', 'wait_ms'],
    )
    const identity: RunnerIdentity = {
      runner_id: assertUuid(body.runner_id, 'runner_id'),
      instance_id: assertUuid(body.instance_id, 'instance_id'),
      worker_epoch: assertInteger(body.worker_epoch, 'worker_epoch', 1, 1e9),
    }
    const maxWork = assertInteger(body.max_work, 'max_work', 1, 100)
    assertInteger(body.wait_ms, 'wait_ms', 0, 25_000)
    return this.serialize(async () => {
      const runner = this.assertRunner(identity)
      runner.last_seen_at = this.timestamp()
      const expired = this.expireAll()
      const assignments: WorkAssignment[] = []
      const active = Object.values(this.state.works).filter(
        work =>
          (work.state === 'leased' || work.state === 'running') &&
          work.runner_id === identity.runner_id &&
          work.instance_id === identity.instance_id &&
          work.worker_epoch === identity.worker_epoch,
      ).length
      let capacity = Math.max(0, maxWork - active)
      const now = this.now()
      for (const id of this.state.order) {
        if (capacity === 0) break
        const work = this.state.works[id]!
        if (
          work.state !== 'queued' &&
          !(
            work.state === 'retry_wait' &&
            work.next_attempt_at !== null &&
            Date.parse(work.next_attempt_at) <= now
          )
        ) {
          continue
        }
        work.attempt += 1
        work.state = 'leased'
        work.lease_id = randomUUID()
        work.lease_expires_at = new Date(now + this.leaseMs).toISOString()
        work.runner_id = identity.runner_id
        work.instance_id = identity.instance_id
        work.worker_epoch = identity.worker_epoch
        work.next_attempt_at = null
        work.result = null
        work.error = null
        work.completion_hash = null
        work.retryable = false
        this.leaseDeadlines.set(work.work_id, this.monotonicNow() + this.leaseMs)
        assignments.push({
          work_id: work.work_id,
          session_id: work.session_id,
          attempt: work.attempt,
          lease_id: work.lease_id,
          lease_expires_at: work.lease_expires_at,
          input: structuredClone(work.input),
          max_runtime_ms: work.max_runtime_ms,
        })
        capacity--
      }
      const cancelRequested = Object.values(this.state.works)
        .filter(
          work =>
            work.cancel_requested &&
            (work.state === 'leased' || work.state === 'running') &&
            work.runner_id === identity.runner_id &&
            work.instance_id === identity.instance_id &&
            work.worker_epoch === identity.worker_epoch,
        )
        .map(work => work.work_id)
      if (expired || assignments.length > 0 || runner.last_seen_at) {
        await this.persist()
      }
      if (expired || assignments.length > 0) this.changed()
      return {
        server_time: this.timestamp(),
        work: assignments,
        cancel_requested: cancelRequested,
      }
    })
  }

  async acknowledge(workId: string, value: unknown): Promise<WorkRecord> {
    const identity = this.parseLeaseIdentity(value)
    return this.serialize(async () => {
      const work = this.work(workId)
      this.assertLease(work, identity)
      if (isTerminalState(work.state)) {
        throw new OpenRunnerError('WORK_TERMINAL', 'Work is terminal', 409)
      }
      if (work.state !== 'leased' && work.state !== 'running') throw staleLease()
      if (work.state === 'leased') {
        work.state = 'running'
        work.updated_at = this.timestamp()
        await this.persist()
        this.changed()
      }
      return publicWork(work)
    })
  }

  private parseLeaseIdentity(
    value: unknown,
    allowExtra = false,
  ): LeaseIdentity {
    const body = assertObject(value)
    if (!allowExtra) {
      assertKeys(body, ['runner_id', 'instance_id', 'worker_epoch', 'lease_id'], [
        'runner_id',
        'instance_id',
        'worker_epoch',
        'lease_id',
      ])
    }
    return {
      runner_id: assertUuid(body.runner_id, 'runner_id'),
      instance_id: assertUuid(body.instance_id, 'instance_id'),
      worker_epoch: assertInteger(body.worker_epoch, 'worker_epoch', 1, 1e9),
      lease_id: assertUuid(body.lease_id, 'lease_id'),
    }
  }

  private parseCompleteIdentity(value: unknown): {
    identity: LeaseIdentity
    body: Record<string, unknown>
  } {
    const body = assertObject(value)
    assertKeys(
      body,
      [
        'runner_id',
        'instance_id',
        'worker_epoch',
        'lease_id',
        'outcome',
        'retryable',
        'result',
        'error',
      ],
      ['runner_id', 'instance_id', 'worker_epoch', 'lease_id', 'outcome'],
    )
    return { identity: this.parseLeaseIdentity(body, true), body }
  }

  async heartbeat(
    workId: string,
    value: unknown,
  ): Promise<{
    lease_expires_at: string
    state: WorkState
    cancel_requested: boolean
  }> {
    const identity = this.parseLeaseIdentity(value)
    return this.serialize(async () => {
      const work = this.work(workId)
      this.assertLease(work, identity)
      if (isTerminalState(work.state)) {
        throw new OpenRunnerError('WORK_TERMINAL', 'Work is terminal', 409)
      }
      if (work.state !== 'running') throw staleLease()
      const deadline = this.now() + this.leaseMs
      work.lease_expires_at = new Date(deadline).toISOString()
      work.updated_at = this.timestamp()
      this.leaseDeadlines.set(work.work_id, this.monotonicNow() + this.leaseMs)
      const runner = this.assertRunner(identity)
      runner.last_seen_at = this.timestamp()
      await this.persist()
      return {
        lease_expires_at: work.lease_expires_at,
        state: work.state,
        cancel_requested: work.cancel_requested,
      }
    })
  }

  async cancel(workId: string, value: unknown): Promise<WorkRecord> {
    const body = assertObject(value)
    assertKeys(body, ['reason'])
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      throw invalidRequest('reason must be a string')
    }
    if (typeof body.reason === 'string' && body.reason.length > 4096) {
      throw invalidRequest('reason is too long')
    }
    return this.serialize(async () => {
      const work = this.work(workId)
      if (isTerminalState(work.state)) return publicWork(work)
      work.cancel_requested = true
      work.updated_at = this.timestamp()
      if (work.state === 'queued' || work.state === 'retry_wait') {
        work.state = 'cancelled'
        work.next_attempt_at = null
        work.error = {
          code: 'CANCELLED',
          message: typeof body.reason === 'string' ? body.reason : 'Work was cancelled',
        }
      }
      await this.persist()
      this.changed()
      return publicWork(work)
    })
  }

  async appendEvents(
    workId: string,
    value: unknown,
  ): Promise<{ accepted: { event_id: string; seq: number }[]; last_seq: number }> {
    const body = assertObject(value)
    assertKeys(
      body,
      ['runner_id', 'instance_id', 'worker_epoch', 'lease_id', 'events'],
      ['runner_id', 'instance_id', 'worker_epoch', 'lease_id', 'events'],
    )
    const identity = this.parseLeaseIdentity(body, true)
    if (!Array.isArray(body.events) || body.events.length > 1000) {
      throw invalidRequest('events must be an array with at most 1000 entries')
    }
    const batchBytes = Buffer.byteLength(JSON.stringify(body.events), 'utf8')
    if (batchBytes > MAX_EVENT_BATCH_BYTES) {
      throw new OpenRunnerError(
        'INVALID_REQUEST',
        'Event batch exceeds 8 MiB',
        413,
      )
    }
    const inputs = body.events.map(raw => {
      const event = assertObject(raw, 'event')
      assertKeys(event, ['event_id', 'kind', 'occurred_at', 'message'], [
        'event_id',
        'kind',
        'occurred_at',
        'message',
      ])
      const candidate: WorkEventInput = {
        event_id: assertUuid(event.event_id, 'event.event_id'),
        kind: event.kind as WorkEventInput['kind'],
        occurred_at: assertRfc3339(event.occurred_at, 'event.occurred_at'),
        message: event.message,
      }
      if (!['sdk', 'process', 'log', 'error'].includes(candidate.kind)) {
        throw invalidRequest('event.kind is invalid')
      }
      if (Buffer.byteLength(JSON.stringify(candidate.message), 'utf8') > MAX_EVENT_BYTES) {
        throw new OpenRunnerError(
          'INVALID_REQUEST',
          'Event message exceeds 4 MiB',
          413,
        )
      }
      return candidate
    })
    return this.serialize(async () => {
      const work = this.work(workId)
      this.assertLease(work, identity)
      if (work.state !== 'leased' && work.state !== 'running') throw staleLease()
      const existing = this.eventIds.get(workId)!
      const pending: StoredEvent[] = []
      const pendingIds = new Set<string>()
      const accepted: { event_id: string; seq: number }[] = []
      let nextSeq = work.last_seq + 1
      for (const input of inputs) {
        const hash = contentHash(input)
        const duplicate = existing.get(input.event_id)
        if (duplicate) {
          if (duplicate.hash !== hash) {
            throw new OpenRunnerError(
              'EVENT_ID_CONFLICT',
              'Event ID was already written with different content',
              409,
            )
          }
          accepted.push({ event_id: input.event_id, seq: duplicate.seq })
          continue
        }
        if (pendingIds.has(input.event_id)) {
          const previous = pending.find(event => event.event_id === input.event_id)!
          if (previous.hash !== hash) {
            throw new OpenRunnerError(
              'EVENT_ID_CONFLICT',
              'Event ID occurs with different content in one batch',
              409,
            )
          }
          accepted.push({ event_id: input.event_id, seq: previous.seq })
          continue
        }
        const event: StoredEvent = { ...input, seq: nextSeq++, hash }
        pending.push(event)
        pendingIds.add(input.event_id)
        accepted.push({ event_id: input.event_id, seq: event.seq })
      }
      if (pending.length > 0) {
        const list = this.events.get(workId)!
        const text = pending.map(event => JSON.stringify(event) + '\n').join('')
        await appendDurably(
          join(this.options.stateDir, 'events', `${workId}.jsonl`),
          text,
        )
        for (const event of pending) {
          list.push(event)
          existing.set(event.event_id, event)
        }
        work.last_seq = nextSeq - 1
        work.updated_at = this.timestamp()
        await this.persist()
        this.changed()
      }
      return { accepted, last_seq: work.last_seq }
    })
  }

  async readEvents(
    workId: string,
    after = 0,
    limit = 100,
  ): Promise<{
    work_id: string
    events: WorkEvent[]
    last_seq: number
    has_more: boolean
  }> {
    assertInteger(after, 'after', 0, Number.MAX_SAFE_INTEGER)
    assertInteger(limit, 'limit', 1, 1000)
    return this.serialize(async () => {
      const work = this.work(workId)
      const events = this.events.get(workId)!
      return {
        work_id: workId,
        events: events.slice(after, after + limit).map(event => {
          const { hash: _hash, ...publicEvent } = event
          return structuredClone(publicEvent)
        }),
        last_seq: work.last_seq,
        has_more: after + limit < work.last_seq,
      }
    })
  }

  async complete(workId: string, value: unknown): Promise<WorkRecord> {
    const { identity, body } = this.parseCompleteIdentity(value)
    if (!['succeeded', 'failed', 'cancelled'].includes(body.outcome as string)) {
      throw invalidRequest('outcome is invalid')
    }
    if (body.retryable !== undefined && typeof body.retryable !== 'boolean') {
      throw invalidRequest('retryable must be a boolean')
    }
    if (body.result !== undefined && !isObject(body.result)) {
      throw invalidRequest('result must be an object')
    }
    if (body.error !== undefined && body.error !== null) {
      const error = assertObject(body.error, 'error')
      assertKeys(error, ['code', 'message'], ['code', 'message'])
      if (typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw invalidRequest('error code and message must be strings')
      }
    }
    const outcome = body.outcome as 'succeeded' | 'failed' | 'cancelled'
    const retryable = body.retryable ?? false
    const result = (body.result as Record<string, unknown> | undefined) ?? null
    const error = (body.error as WorkError | null | undefined) ?? null
    const completion = { outcome, retryable, result, error }
    const completionHash = contentHash(completion)
    return this.serialize(async () => {
      const work = this.work(workId)
      this.assertLease(work, identity)
      if (work.completion_hash !== null) {
        if (work.completion_hash === completionHash) return publicWork(work)
        throw new OpenRunnerError(
          'TERMINAL_CONFLICT',
          'Work was already completed with a different result',
          409,
        )
      }
      if (isTerminalState(work.state)) {
        throw new OpenRunnerError(
          'TERMINAL_CONFLICT',
          'Work is already terminal',
          409,
        )
      }
      if (work.state !== 'leased' && work.state !== 'running') throw staleLease()
      work.updated_at = this.timestamp()
      work.completion_hash = completionHash
      work.retryable = retryable
      work.result = result
      work.error = error
      if (
        outcome === 'failed' &&
        retryable &&
        work.attempt < work.max_attempts &&
        !work.cancel_requested
      ) {
        work.state = 'retry_wait'
        work.next_attempt_at = new Date(
          this.now() + this.retryDelay(work.attempt),
        ).toISOString()
      } else {
        work.state = outcome === 'failed' && work.cancel_requested ? 'cancelled' : outcome
        work.next_attempt_at = null
      }
      await this.persist()
      this.changed()
      return publicWork(work)
    })
  }

  async getWork(workId: string): Promise<WorkRecord> {
    return this.serialize(async () => {
      const work = this.work(workId)
      if (this.expire(work)) {
        await this.persist()
        this.changed()
      }
      return publicWork(work)
    })
  }

  async listWorks(state?: WorkState, limit = 100): Promise<WorkRecord[]> {
    if (state !== undefined && !WORK_STATES.includes(state)) {
      throw invalidRequest('state is invalid')
    }
    assertInteger(limit, 'limit', 1, 1000)
    return this.serialize(async () => {
      const expired = this.expireAll()
      if (expired) await this.persist()
      return this.state.order
        .map(id => this.state.works[id]!)
        .filter(work => state === undefined || work.state === state)
        .slice(0, limit)
        .map(publicWork)
    })
  }
}

/** Validate an event identity before handing it to a transport or store. */
export function eventContentHash(event: WorkEventInput): string {
  return contentHash(event)
}

/** Exposed for state-migration and corruption tests, not for queue mutation. */
export function canonicalStoredState(value: unknown): string {
  return canonicalJson(value)
}
