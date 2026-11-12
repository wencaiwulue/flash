import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { once } from 'events'
import { appendFile, chmod, mkdir, readdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { spawnScriptArgs } from '../utils/bundledMode.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getProcessStartToken, probeProcessIdentity } from '../jobs/state.js'
import { OpenRunnerClient } from './client.js'
import {
  OPEN_RUNNER_PROTOCOL,
  OpenRunnerError,
  eventIdForMessage,
  isObject,
  resolveWorkspaceCwd,
  type LeaseIdentity,
  type RunnerIdentity,
  type RunnerRegistration,
  type WorkAssignment,
  type WorkEventInput,
  type WorkRecord,
} from './protocol.js'
import { atomicWriteJson } from './store.js'

type ActivePhase = 'accepted' | 'spawning' | 'prompt_sending' | 'prompt_sent' | 'running'

type ActiveWork = {
  protocol: typeof OPEN_RUNNER_PROTOCOL
  assignment: WorkAssignment
  identity: LeaseIdentity
  phase: ActivePhase
  pid: number | null
  start_token: string | null
  connection_generation: number
  prompt_sent: boolean
  delivery_unknown: boolean
  pending_event: WorkEventInput | null
  updated_at: string
}

export type OpenRunnerWorkerOptions = {
  client: OpenRunnerClient
  runnerId: string
  workspace: string
  stateDir?: string
  maxWork?: number
  instanceId?: string
  execPath?: string
  scriptArgs?: string[]
  env?: NodeJS.ProcessEnv
  spawnProcess?: typeof spawn
  buildChildCommand?: (context: {
    assignment: WorkAssignment
    argv: string[]
    cwd: string
  }) => { command: string; args: string[] }
}

function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const exact = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TEMP', 'TMP',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'NODE_ENV',
  ])
  for (const [key, value] of Object.entries(env)) {
    if (
      exact.has(key) ||
      key.startsWith('LC_') ||
      key.startsWith('AWS_') ||
      key.startsWith('GOOGLE_') ||
      key.startsWith('CLOUD_ML_')
    ) {
      result[key] = value
    }
  }
  for (const key of Object.keys(result)) {
    if (
      key.startsWith('OPEN_RUNNER_') ||
      key.startsWith('SSH_') ||
      key.includes('WORKER_TOKEN') ||
      key.includes('ADMIN_TOKEN') ||
      key === 'CLAUDE_CODE_SESSION_ACCESS_TOKEN' ||
      key === 'CLAUDE_CODE_WORKER_EPOCH'
    ) {
      delete result[key]
    }
  }
  return result
}

function redact(text: string): string {
  return text.replace(/(?:Bearer\s+|sk-ant-|sk-)[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]').slice(-64 * 1024)
}

export class OpenRunnerWorker {
  readonly instanceId: string
  readonly stateDir: string
  private registration?: RunnerRegistration
  private connectionGeneration = 0
  private stopping = false

  constructor(private readonly options: OpenRunnerWorkerOptions) {
    this.instanceId = options.instanceId ?? randomUUID()
    this.stateDir = options.stateDir ?? join(
      getClaudeConfigHomeDir(),
      'open-runner',
      options.runnerId,
    )
  }

  private get identity(): RunnerIdentity {
    if (!this.registration) throw new Error('Worker has not registered')
    return {
      runner_id: this.options.runnerId,
      instance_id: this.instanceId,
      worker_epoch: this.registration.worker_epoch,
    }
  }

  private lease(assignment: WorkAssignment): LeaseIdentity {
    return { ...this.identity, lease_id: assignment.lease_id }
  }

  private activePath(leaseId?: string): string {
    return join(
      this.stateDir,
      leaseId && (this.options.maxWork ?? 1) > 1
        ? `active-work-${leaseId}.json`
        : 'active-work.json',
    )
  }

  private async writeActive(record: ActiveWork): Promise<void> {
    await atomicWriteJson(this.activePath(record.identity.lease_id), record)
  }

  private async readActive(path = this.activePath()): Promise<ActiveWork | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as ActiveWork
      if (
        value.protocol !== OPEN_RUNNER_PROTOCOL ||
        !value.assignment ||
        !value.identity ||
        typeof value.phase !== 'string'
      ) {
        throw new Error('invalid active-work record')
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new OpenRunnerError('RECOVERY_CONFLICT', 'Worker active-work record is corrupt', 409)
    }
  }

  private async clearActive(leaseId: string): Promise<void> {
    const path = this.activePath(leaseId)
    const active = await this.readActive(path)
    if (active?.identity.lease_id === leaseId) await unlink(path)
  }

  private async log(message: string): Promise<void> {
    try {
      const path = join(this.stateDir, 'worker.log')
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      await appendFile(path, `${new Date().toISOString()} ${redact(message)}\n`, { mode: 0o600 })
      await chmod(path, 0o600)
    } catch {
      // Diagnostics are best-effort and must never change work or process state.
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    await chmod(this.stateDir, 0o700)
    const names = await readdir(this.stateDir)
    for (const name of names) {
      if (/^active-work(?:-[0-9a-f-]{36})?\.json$/.test(name)) {
        await this.recoverActiveWork(join(this.stateDir, name))
      }
    }
    await this.register()
  }

  private async recoverActiveWork(path: string): Promise<void> {
    const active = await this.readActive(path)
    if (!active) return
    const previousClient = this.options.client
    if (active.pid !== null) {
      const probe = await probeProcessIdentity(active.pid, active.start_token)
      if (probe === 'alive') {
        // The old record is the only authorization to terminate a leftover child.
        process.kill(active.pid, 'SIGTERM')
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 50))
          if (await probeProcessIdentity(active.pid, active.start_token) === 'dead') break
        }
        const remaining = await probeProcessIdentity(active.pid, active.start_token)
        if (remaining === 'alive') {
          process.kill(active.pid, 'SIGKILL')
        } else if (remaining !== 'dead') {
          throw new OpenRunnerError(
            'RECOVERY_CONFLICT',
            'Cannot verify that the previous CLI child stopped',
            409,
          )
        }
      } else if (probe !== 'dead') {
        throw new OpenRunnerError(
          'RECOVERY_CONFLICT',
          'Cannot verify the previous CLI child; refusing to signal a process',
          409,
        )
      }
    }
    const deliveryUnknown = active.phase === 'prompt_sending' || active.delivery_unknown
    try {
      if (active.pending_event) {
        await previousClient.appendEvents(
          active.assignment.work_id,
          active.identity,
          [active.pending_event],
        )
      }
      await previousClient.complete(active.assignment.work_id, active.identity, {
        outcome: 'failed',
        retryable: !deliveryUnknown,
        error: {
          code: deliveryUnknown ? 'DELIVERY_UNKNOWN' : 'RUNNER_RESTARTED',
          message: deliveryUnknown
            ? 'Runner restarted with uncertain prompt delivery; explicit retry is required'
            : 'Runner restarted; assignment may be retried at least once',
        },
      })
      await this.clearActive(active.identity.lease_id)
    } catch (error) {
      if (error instanceof OpenRunnerError && ['STALE_LEASE', 'STALE_WORKER_EPOCH', 'WORK_TERMINAL', 'TERMINAL_CONFLICT'].includes(error.code)) {
        await this.clearActive(active.identity.lease_id)
        return
      }
      throw error
    }
  }

  async register(): Promise<RunnerRegistration> {
    this.registration = await this.options.client.register({
      runner_id: this.options.runnerId,
      instance_id: this.instanceId,
    }, this.options.maxWork ?? 1)
    this.connectionGeneration++
    await atomicWriteJson(join(this.stateDir, 'instance.json'), {
      protocol: OPEN_RUNNER_PROTOCOL,
      runner_id: this.options.runnerId,
      instance_id: this.instanceId,
      worker_epoch: this.registration.worker_epoch,
      connection_generation: this.connectionGeneration,
      registered_at: new Date().toISOString(),
    })
    return this.registration
  }

  async runOnce(waitMs = 0): Promise<WorkRecord[]> {
    if (!this.registration) await this.initialize()
    const response = await this.options.client.poll(this.identity, this.options.maxWork ?? 1, waitMs)
    return Promise.all(response.work.map(work => this.execute(work)))
  }

  async run(options: { once?: boolean; waitMs?: number } = {}): Promise<WorkRecord[]> {
    if (!this.registration) await this.initialize()
    const completed: WorkRecord[] = []
    do {
      try {
        const batch = await this.runOnce(options.once ? 0 : (options.waitMs ?? 25_000))
        completed.push(...batch)
        if (options.once) break
      } catch (error) {
        if (error instanceof OpenRunnerError && error.code === 'STALE_WORKER_EPOCH') {
          this.stopping = true
          await this.register()
          this.stopping = false
          continue
        }
        throw error
      }
    } while (!this.stopping)
    return completed
  }

  stop(): void {
    this.stopping = true
  }

  private buildArgv(assignment: WorkAssignment): string[] {
    const resume = assignment.attempt > 1 || assignment.input.session_id !== undefined
    const argv = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      ...(resume ? ['--resume', assignment.session_id] : ['--session-id', assignment.session_id]),
      '--permission-mode', assignment.input.permission_mode,
    ]
    if (assignment.input.model) argv.push('--model', assignment.input.model)
    return argv
  }

  private async sendEvent(active: ActiveWork, event: WorkEventInput): Promise<void> {
    await this.writeActive({ ...active, pending_event: event, updated_at: new Date().toISOString() })
    await this.options.client.appendEvents(active.assignment.work_id, active.identity, [event])
    const latest = await this.readActive(this.activePath(active.identity.lease_id))
    if (latest?.identity.lease_id === active.identity.lease_id) {
      await this.writeActive({ ...latest, pending_event: null, updated_at: new Date().toISOString() })
    }
  }

  private async execute(assignment: WorkAssignment): Promise<WorkRecord> {
    const identity = this.lease(assignment)
    let active: ActiveWork = {
      protocol: OPEN_RUNNER_PROTOCOL,
      assignment,
      identity,
      phase: 'accepted',
      pid: null,
      start_token: null,
      connection_generation: this.connectionGeneration,
      prompt_sent: false,
      delivery_unknown: false,
      pending_event: null,
      updated_at: new Date().toISOString(),
    }
    await this.writeActive(active)
    await this.options.client.acknowledge(assignment.work_id, identity)
    const cwd = await resolveWorkspaceCwd(this.options.workspace, assignment.input.cwd)
    active = { ...active, phase: 'spawning', updated_at: new Date().toISOString() }
    await this.writeActive(active)
    const argv = this.buildArgv(assignment)
    const command = this.options.buildChildCommand?.({ assignment, argv, cwd }) ?? {
      command: this.options.execPath ?? process.execPath,
      args: [...(this.options.scriptArgs ?? spawnScriptArgs()), ...argv],
    }
    let child: ChildProcess
    try {
      child = (this.options.spawnProcess ?? spawn)(command.command, command.args, {
        cwd,
        env: workerEnvironment(this.options.env ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      return this.options.client.complete(assignment.work_id, identity, {
        outcome: 'failed', retryable: true,
        error: { code: 'CHILD_EXIT', message: error instanceof Error ? error.message : String(error) },
      })
    }
    if (!child.pid || !child.stdin) {
      child.kill('SIGTERM')
      return this.options.client.complete(assignment.work_id, identity, {
        outcome: 'failed', retryable: true,
        error: { code: 'CHILD_EXIT', message: 'CLI child did not provide stdio and a PID' },
      })
    }
    const closePromise = once(child, 'close')
    const childError = new Promise<Error>(resolve => child.once('error', resolve))
    void childError.then(error => this.log(error.message))
    let successResult = false
    let resultSeen = false
    let protocolError = false
    let markPromptRecorded!: () => void
    const promptRecorded = new Promise<void>(resolve => { markPromptRecorded = resolve })
    // Attach stdio before any disk/network await. A fast child may exit while
    // active-work and the spawn event are being persisted.
    if (child.stderr) {
      const stderr = createInterface({ input: child.stderr })
      stderr.on('line', line => { void this.log(line) })
    }
    const stdoutPromise = (async () => {
      if (!child.stdout) return
      const stdout = createInterface({ input: child.stdout })
      for await (const line of stdout) {
        if (!line.trim()) continue
        await promptRecorded
        let message: unknown
        try { message = JSON.parse(line) } catch {
          protocolError = true
          await this.sendEvent(active, {
            event_id: randomUUID(), kind: 'error', occurred_at: new Date().toISOString(),
            message: { code: 'CHILD_PROTOCOL_ERROR', message: 'CLI emitted invalid NDJSON' },
          })
          continue
        }
        if (isObject(message) && message.type === 'result') {
          resultSeen = true
          successResult = message.subtype === 'success' && message.is_error !== true
        }
        await this.sendEvent(active, {
          event_id: eventIdForMessage(message),
          kind: 'sdk', occurred_at: new Date().toISOString(), message,
        })
      }
    })()
    void stdoutPromise.catch(error => this.log(error instanceof Error ? error.message : String(error)))
    active = {
      ...active,
      phase: 'prompt_sending',
      pid: child.pid,
      start_token: await getProcessStartToken(child.pid),
      updated_at: new Date().toISOString(),
    }
    await this.writeActive(active)
    await this.sendEvent(active, {
      event_id: randomUUID(), kind: 'process', occurred_at: new Date().toISOString(),
      message: { event: 'spawn', pid: child.pid, attempt: assignment.attempt },
    })
    const prompt = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: assignment.input.prompt },
      session_id: assignment.session_id,
    })
    child.stdin.write(`${prompt}\n`)
    child.stdin.end()
    active = {
      ...active,
      phase: 'prompt_sent',
      prompt_sent: true,
      updated_at: new Date().toISOString(),
    }
    await this.writeActive(active)
    markPromptRecorded()

    let cancelled = false
    let timedOut = false
    let heartbeatFailures = 0
    let heartbeatRunning = false
    const terminate = (signal: NodeJS.Signals = 'SIGINT') => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return
      heartbeatRunning = true
      void this.options.client.heartbeat(assignment.work_id, identity).then(result => {
        heartbeatFailures = 0
        if (result.cancel_requested) {
          cancelled = true
          terminate()
        }
      }).catch(error => {
        heartbeatFailures++
        void this.log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
        if (heartbeatFailures >= 3) terminate()
        if (error instanceof OpenRunnerError && ['STALE_LEASE', 'STALE_WORKER_EPOCH', 'WORK_TERMINAL'].includes(error.code)) {
          terminate()
        }
      }).finally(() => { heartbeatRunning = false })
    }, this.registration?.heartbeat_interval_ms ?? 10_000)
    const timeout = setTimeout(() => {
      timedOut = true
      terminate()
      const kill = setTimeout(() => terminate('SIGTERM'), 2_000)
      const force = setTimeout(async () => {
        if (active.pid && active.start_token && await probeProcessIdentity(active.pid, active.start_token) === 'alive') {
          terminate('SIGKILL')
        }
      }, 5_000)
      kill.unref()
      force.unref()
    }, assignment.max_runtime_ms)

    try {
      await stdoutPromise
      const [exitCode, signal] = await closePromise as [number | null, string | null]
      clearInterval(heartbeat)
      clearTimeout(timeout)
      await this.sendEvent(active, {
        event_id: randomUUID(), kind: 'process', occurred_at: new Date().toISOString(),
        message: { event: 'exit', exit_code: exitCode, signal },
      })
      const outcome = cancelled ? 'cancelled' : timedOut || protocolError || exitCode !== 0 || !resultSeen || !successResult ? 'failed' : 'succeeded'
      const record = await this.options.client.complete(assignment.work_id, identity, {
        outcome,
        retryable: outcome === 'failed' && !timedOut && exitCode !== 0,
        ...(outcome === 'succeeded' ? { result: { exit_code: exitCode } } : {}),
        ...(outcome === 'failed' ? { error: {
          code: timedOut ? 'WORK_TIMEOUT' : exitCode !== 0 ? 'CHILD_EXIT' : 'CHILD_PROTOCOL_ERROR',
          message: timedOut ? 'Work exceeded max_runtime_ms' : 'CLI did not produce a successful result',
        } } : {}),
        ...(outcome === 'cancelled' ? { error: { code: 'CANCELLED', message: 'Work was cancelled' } } : {}),
      })
      await this.clearActive(identity.lease_id)
      return record
    } catch (error) {
      clearInterval(heartbeat)
      clearTimeout(timeout)
      terminate('SIGTERM')
      await this.log(error instanceof Error ? error.message : String(error))
      throw error
    }
  }
}

export async function runOpenRunnerWorker(
  options: OpenRunnerWorkerOptions & { once?: boolean },
): Promise<WorkRecord[]> {
  const worker = new OpenRunnerWorker(options)
  await worker.initialize()
  return worker.run({ once: options.once })
}
