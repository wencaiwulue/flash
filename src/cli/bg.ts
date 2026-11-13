import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import {
  access,
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { spawnScriptArgs } from '../utils/bundledMode.js'
import {
  type BackgroundSessionRecord,
  type SessionRegistryRecord,
  deleteSessionRegistryRecord,
  getSessionRegistryDir,
  getSessionTombstoneDir,
  readSessionRegistry,
  writeSessionRegistryRecord,
  writeSessionTombstone,
} from '../utils/concurrentSessions.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getPlatform } from '../utils/platform.js'
import { getProcessIdentity } from '../utils/processIdentity.js'
import { checkTmuxAvailable, execTmux } from '../utils/tmuxSocket.js'
import { pingUdsSession } from '../utils/udsClient.js'
import { stripBackgroundFlags } from './bgArgs.js'

const VERSION = 'background-sessions-v1'
const MAX_LOG_BYTES = 1024 * 1024
const MAX_LOG_LINES = 200

export class BackgroundSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BackgroundSessionError'
  }
}

export type BackgroundLaunchOptions = {
  executable?: string
  executableArgs?: string[]
  cwd?: string
  env?: Record<string, string>
  /** Offline fake-child tests can rely on PID+tmux instead of CLI registration. */
  waitForRegistration?: boolean
  stopTimeoutMs?: number
}

type AuthorizedSession = {
  record: BackgroundSessionRecord
  state: 'live' | 'stopped' | 'unknown'
  attachedClients: number
}

function fail(code: string, message: string): never {
  throw new BackgroundSessionError(code, message)
}

function uid(): number {
  return process.getuid?.() ?? 0
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function backgroundRecord(value: SessionRegistryRecord): BackgroundSessionRecord {
  const record = value as unknown as Partial<BackgroundSessionRecord>
  if (
    record.version !== VERSION ||
    record.kind !== 'bg' ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId ||
    typeof record.processStartToken !== 'string' ||
    !record.processStartToken ||
    typeof record.tmuxSocket !== 'string' ||
    typeof record.tmuxSocketPath !== 'string' ||
    typeof record.tmuxSession !== 'string' ||
    typeof record.logPath !== 'string' ||
    record.ownerUid !== uid() ||
    record.pid !== record.tmuxPanePid ||
    !isAbsolute(record.tmuxSocketPath) ||
    !isAbsolute(record.logPath)
  ) {
    return fail(
      'PID_IDENTITY_MISMATCH',
      'Background session record is legacy or has invalid identity metadata',
    )
  }
  return record as BackgroundSessionRecord
}

async function tombstone(sessionId: string): Promise<BackgroundSessionRecord | undefined> {
  const path = join(getSessionTombstoneDir(), `${sessionId}.json`)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    const value = JSON.parse(await readFile(path, 'utf8')) as SessionRegistryRecord
    return backgroundRecord(value)
  } catch {
    return undefined
  }
}

async function findBackgroundSession(
  sessionId: string | undefined,
): Promise<{ record: BackgroundSessionRecord; stopped: boolean }> {
  if (!sessionId) fail('SESSION_NOT_FOUND', 'A session ID is required')
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    fail('SESSION_NOT_FOUND', 'Background session not found')
  }
  const matches = (await readSessionRegistry()).filter(
    record => record.sessionId === sessionId,
  )
  if (matches.length > 1) fail('SESSION_AMBIGUOUS', 'Session ID is ambiguous')
  if (matches.length === 1) {
    if (matches[0].kind !== 'bg') {
      fail('SESSION_NOT_BACKGROUND', 'Session is not a background session')
    }
    return { record: backgroundRecord(matches[0]), stopped: false }
  }
  const stopped = await tombstone(sessionId)
  if (stopped) return { record: stopped, stopped: true }
  fail('SESSION_NOT_FOUND', 'Background session not found')
}

async function tmuxIdentity(
  record: BackgroundSessionRecord,
): Promise<{ attachedClients: number }> {
  const socketInfo = await lstat(record.tmuxSocketPath).catch(() => undefined)
  if (
    !socketInfo ||
    !socketInfo.isSocket() ||
    socketInfo.isSymbolicLink() ||
    socketInfo.uid !== uid() ||
    basename(dirname(record.tmuxSocketPath)) !== `tmux-${uid()}`
  ) {
    fail('SESSION_IDENTITY_CONFLICT', 'tmux socket identity does not match')
  }
  const has = await execTmux([
    '-L',
    record.tmuxSocket,
    'has-session',
    '-t',
    record.tmuxSession,
  ])
  if (has.code !== 0) fail('SESSION_IDENTITY_CONFLICT', 'tmux session is unavailable')
  const display = await execTmux([
    '-L',
    record.tmuxSocket,
    'display-message',
    '-p',
    '-t',
    record.tmuxSession,
    '#{socket_path},#{pane_pid},#{session_attached}',
  ])
  const [socketPath, panePid, attached] = display.stdout.trim().split(',')
  if (
    display.code !== 0 ||
    socketPath !== record.tmuxSocketPath ||
    Number(panePid) !== record.pid
  ) {
    fail('SESSION_IDENTITY_CONFLICT', 'tmux pane identity does not match')
  }
  return { attachedClients: Number(attached) || 0 }
}

/** Shared fail-closed authorization used by ps, attach and every kill signal. */
export async function authorizeSession(
  input: SessionRegistryRecord | BackgroundSessionRecord,
  operation: 'ps' | 'attach' | 'kill' = 'kill',
): Promise<AuthorizedSession> {
  const record = backgroundRecord(input as SessionRegistryRecord)
  const logInfo = await lstat(record.logPath).catch(() => undefined)
  if (!logInfo || !logInfo.isFile() || logInfo.isSymbolicLink() || logInfo.uid !== uid()) {
    fail('SESSION_IDENTITY_CONFLICT', 'Session log identity does not match')
  }
  const [actualLogDir, expectedLogDir] = await Promise.all([
    realpath(dirname(record.logPath)).catch(() => undefined),
    realpath(join(getClaudeConfigHomeDir(), 'session-logs')).catch(() => undefined),
  ])
  if (!actualLogDir || actualLogDir !== expectedLogDir) {
    fail('SESSION_IDENTITY_CONFLICT', 'Session log directory does not match')
  }
  if (getPlatform() === 'windows') {
    fail('PID_IDENTITY_MISMATCH', 'Cross-host WSL process identity is unavailable')
  }
  const identity = await getProcessIdentity(record.pid)
  if (identity.state === 'unknown') {
    if (operation === 'ps') return { record, state: 'unknown', attachedClients: 0 }
    fail('PID_IDENTITY_MISMATCH', 'Process identity is unavailable')
  }
  if (identity.state === 'not_found') {
    const has = await execTmux([
      '-L',
      record.tmuxSocket,
      'has-session',
      '-t',
      record.tmuxSession,
    ])
    if (has.code === 0) {
      fail('SESSION_IDENTITY_CONFLICT', 'tmux session outlived its registered process')
    }
    return { record, state: 'stopped', attachedClients: 0 }
  }
  if (identity.token !== record.processStartToken) {
    fail('PID_IDENTITY_MISMATCH', 'Process start token does not match')
  }
  const { attachedClients } = await tmuxIdentity(record)
  if (record.messagingSocketPath) {
    if (!isAbsolute(record.messagingSocketPath) && process.platform !== 'win32') {
      fail('SESSION_IDENTITY_CONFLICT', 'Messaging socket path is invalid')
    }
    const pong = await pingUdsSession(record.messagingSocketPath)
    if (pong && pong.sessionId !== record.sessionId) {
      fail('SESSION_IDENTITY_CONFLICT', 'Messaging socket belongs to another session')
    }
    // A timeout is degraded only: PID+start token+tmux remain authoritative.
  }
  return { record, state: 'live', attachedClients }
}

function publicRecord(
  record: SessionRegistryRecord,
  state: string,
  attachedClients = 0,
): Record<string, unknown> {
  const bg = record.kind === 'bg' ? (record as unknown as BackgroundSessionRecord) : undefined
  return {
    session_id: record.sessionId,
    pid: record.pid,
    kind: record.kind,
    state,
    waiting_for: record.waitingFor ?? null,
    ...(record.name ? { name: record.name } : {}),
    cwd: record.cwd,
    started_at: record.startedAt,
    updated_at: record.updatedAt ?? record.startedAt,
    attached_clients: attachedClients,
    ...(bg
      ? {
          tmux_socket: bg.tmuxSocket,
          tmux_session: bg.tmuxSession,
          log_path: bg.logPath,
        }
      : {}),
  }
}

export async function listBackgroundSessions(): Promise<Record<string, unknown>[]> {
  const sessions: Record<string, unknown>[] = []
  for (const record of await readSessionRegistry()) {
    if (record.kind !== 'bg') {
      const identity = await getProcessIdentity(record.pid)
      if (identity.state === 'not_found') continue
      sessions.push(
        publicRecord(
          record,
          identity.state === 'unknown' ? 'unknown' : (record.status ?? 'idle'),
        ),
      )
      continue
    }
    try {
      const authorized = await authorizeSession(record, 'ps')
      if (authorized.state === 'stopped') {
        const stopped = {
          ...authorized.record,
          lifecycle: 'stopped' as const,
          exit: authorized.record.exit ?? {
            code: null,
            signal: null,
            reason: 'process_exit',
            ended_at: Date.now(),
          },
        }
        if (await deleteSessionRegistryRecord(authorized.record)) {
          await writeSessionTombstone(stopped)
        }
        continue
      }
      sessions.push(
        publicRecord(
          record,
          authorized.state === 'unknown' ? 'unknown' : (record.status ?? 'idle'),
          authorized.attachedClients,
        ),
      )
    } catch {
      sessions.push(publicRecord(record, 'unknown'))
    }
  }
  return sessions.sort((a, b) => {
    const started = Number(a.started_at) - Number(b.started_at)
    return started || String(a.session_id).localeCompare(String(b.session_id))
  })
}

function sessionIdFromArgs(args: string[]): { id?: string; args: string[] } {
  const index = args.findIndex(arg => arg === '--session-id')
  if (index >= 0) return { id: args[index + 1], args }
  const inline = args.find(arg => arg.startsWith('--session-id='))
  return { id: inline?.slice('--session-id='.length), args }
}

function validateMode(args: string[]): void {
  if (
    args[0] === 'ssh' ||
    args[0] === 'open' ||
    args.some(arg =>
      ['-p', '--print', '--sdk', '--ssh', '--remote-control'].includes(arg),
    ) ||
    args.some(arg => arg.startsWith('--print=') || arg.startsWith('cc:')) ||
    args.includes('--input-format')
  ) {
    fail('BG_MODE_CONFLICT', 'Background mode requires a local interactive CLI')
  }
}

export async function launchBackgroundSession(
  inputArgs: string[],
  options: BackgroundLaunchOptions = {},
): Promise<BackgroundSessionRecord> {
  const stripped = stripBackgroundFlags(inputArgs)
  if (!stripped.background) fail('BG_MODE_CONFLICT', 'No background CLI flag was provided')
  validateMode(stripped.args)
  if (!(await checkTmuxAvailable())) {
    fail('TMUX_UNAVAILABLE', 'tmux is required for background sessions')
  }
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()))
  const existingId = sessionIdFromArgs(stripped.args).id
  const sessionId = existingId ?? randomUUID()
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    fail('SESSION_CONFLICT', 'Background session ID must be a UUID')
  }
  const childArgs = existingId
    ? [...stripped.args]
    : [...stripped.args, '--session-id', sessionId]
  const argsHash = createHash('sha256')
    .update(JSON.stringify({ cwd, args: childArgs }))
    .digest('hex')

  const existing = (await readSessionRegistry()).find(
    record => record.sessionId === sessionId,
  )
  if (existing) {
    const record = backgroundRecord(existing)
    if (record.argsHash !== argsHash) {
      fail('SESSION_CONFLICT', 'Session ID was already used with different arguments')
    }
    const authorized = await authorizeSession(record, 'ps')
    if (authorized.state !== 'live') {
      fail('SESSION_CONFLICT', 'An exited session requires an explicit --resume')
    }
    return record
  }
  if (await tombstone(sessionId)) {
    fail('SESSION_CONFLICT', 'An exited session requires an explicit --resume')
  }

  const suffix = sessionId.slice(0, 8)
  const tmuxSocket = `claude-bg-${uid()}-${suffix}`
  const tmuxSession = `bg-${suffix}`
  const logDir = join(getClaudeConfigHomeDir(), 'session-logs')
  const logPath = join(logDir, `${sessionId}.log`)
  await mkdir(logDir, { recursive: true, mode: 0o700 })
  await chmod(logDir, 0o700)
  const log = await open(logPath, 'wx', 0o600)
  await log.close()
  await chmod(logPath, 0o600)

  const has = await execTmux(['-L', tmuxSocket, 'has-session', '-t', tmuxSession])
  if (has.code === 0) {
    await unlink(logPath).catch(() => undefined)
    fail('SESSION_CONFLICT', 'tmux session already exists')
  }
  const executable = options.executable ?? process.execPath
  const executableArgs = options.executableArgs ?? spawnScriptArgs()
  const command = ['exec', shellQuote(executable), ...[...executableArgs, ...childArgs].map(shellQuote)].join(' ')
  const messagingSocketPath = join(
    tmpdir(),
    `claude-code-${uid()}-${suffix}.sock`,
  )
  const environment = {
    CLAUDE_CODE_SESSION_KIND: 'bg',
    CLAUDE_CODE_SESSION_NAME: tmuxSession,
    CLAUDE_CODE_SESSION_LOG: logPath,
    CLAUDE_CODE_MESSAGING_SOCKET: messagingSocketPath,
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ...options.env,
  }
  const created = await execTmux([
    '-L',
    tmuxSocket,
    'new-session',
    '-d',
    '-s',
    tmuxSession,
    '-c',
    cwd,
    ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    command,
  ])
  if (created.code !== 0) {
    await unlink(logPath).catch(() => undefined)
    fail('TMUX_LAUNCH_FAILED', 'Unable to create detached tmux session')
  }

  let record: BackgroundSessionRecord | undefined
  try {
    const display = await execTmux([
      '-L',
      tmuxSocket,
      'display-message',
      '-p',
      '-t',
      tmuxSession,
      '#{socket_path},#{pid},#{pane_pid}',
    ])
    const [tmuxSocketPath, serverPidText, panePidText] = display.stdout.trim().split(',')
    const tmuxServerPid = Number(serverPidText)
    const panePid = Number(panePidText)
    if (display.code !== 0 || !tmuxSocketPath || !Number.isSafeInteger(panePid)) {
      fail('TMUX_LAUNCH_FAILED', 'Unable to verify tmux process identity')
    }
    const identity = await getProcessIdentity(panePid)
    if (identity.state !== 'running' || !identity.token) {
      fail('PID_IDENTITY_MISMATCH', 'Background process start token is unavailable')
    }
    const now = Date.now()
    record = {
      version: VERSION,
      launchId: sessionId,
      sessionId,
      pid: panePid,
      processStartToken: identity.token,
      argsHash,
      cwd,
      startedAt: now,
      kind: 'bg',
      entrypoint: 'cli',
      logPath,
      messagingSocketPath,
      status: 'starting',
      waitingFor: null,
      updatedAt: now,
      lifecycle: 'launching',
      tmuxSocket,
      tmuxSocketPath,
      tmuxSession,
      tmuxServerPid,
      tmuxPanePid: panePid,
      ownerUid: uid(),
      exit: null,
    }
    await writeSessionRegistryRecord(record)
    // A missing executable fails in the pane shell after new-session returns.
    // Check it here so cleanup does not depend on winning that process-exit race.
    if (isAbsolute(executable)) await access(executable, constants.X_OK)
    const pipe = await execTmux([
      '-L',
      tmuxSocket,
      'pipe-pane',
      '-o',
      '-t',
      tmuxSession,
      `cat >> ${shellQuote(logPath)}`,
    ])
    if (pipe.code !== 0) fail('TMUX_LAUNCH_FAILED', 'Unable to capture terminal output')

    if (options.waitForRegistration !== false) {
      const deadline = Date.now() + 5_000
      let delay = 50
      while (Date.now() < deadline) {
        const current = (await readSessionRegistry()).find(
          candidate =>
            candidate.sessionId === sessionId && candidate.pid === panePid,
        )
        if (current?.registeredAt) {
          record = { ...record, ...current } as BackgroundSessionRecord
          const pong = await pingUdsSession(messagingSocketPath, 100)
          if (pong && pong.sessionId !== sessionId) {
            fail('SESSION_IDENTITY_CONFLICT', 'Messaging socket returned the wrong session')
          }
          return record
        }
        await new Promise(resolveWait => setTimeout(resolveWait, delay))
        delay = Math.min(800, delay * 2)
      }
      fail('SESSION_LAUNCH_TIMEOUT', 'Background process did not register in time')
    }
    return record
  } catch (error) {
    await execTmux(['-L', tmuxSocket, 'kill-session', '-t', tmuxSession])
    if (record) await deleteSessionRegistryRecord(record)
    await unlink(logPath).catch(() => undefined)
    throw error
  }
}

function summary(record: BackgroundSessionRecord): Record<string, unknown> {
  return {
    version: VERSION,
    session_id: record.sessionId,
    pid: record.pid,
    state: record.status,
    tmux_socket: record.tmuxSocket,
    tmux_session: record.tmuxSession,
    log_path: record.logPath,
    attach: `claude attach ${record.sessionId}`,
  }
}

async function readLogs(sessionId: string | undefined): Promise<void> {
  const { record } = await findBackgroundSession(sessionId)
  const expectedDir = join(getClaudeConfigHomeDir(), 'session-logs')
  if (dirname(record.logPath) !== expectedDir) {
    fail('LOG_UNAVAILABLE', 'Log path is outside the session log directory')
  }
  const info = await lstat(record.logPath).catch(() => undefined)
  if (
    !info ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== uid()
  ) {
    fail('LOG_UNAVAILABLE', 'Session log is unavailable or has invalid ownership')
  }
  await chmod(record.logPath, 0o600)
  const handle = await open(record.logPath, 'r')
  try {
    const length = Math.min(info.size, MAX_LOG_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, info.size - length))
    let text = buffer.toString('utf8')
    if (info.size > length) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : text
    }
    const lines = text.split('\n')
    const truncated = info.size > length || lines.length > MAX_LOG_LINES
    const selected = lines.slice(-MAX_LOG_LINES).join('\n')
    process.stdout.write(selected)
    if (selected && !selected.endsWith('\n')) process.stdout.write('\n')
    if (truncated) {
      process.stderr.write('Log truncated to the last 200 lines and 1 MiB.\n')
    }
  } finally {
    await handle.close()
  }
}

async function attach(record: BackgroundSessionRecord): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const authorized = await authorizeSession(record, 'attach')
    if (authorized.state !== 'live') fail('SESSION_NOT_FOUND', 'Session has exited')
    const args = ['-L', record.tmuxSocket, 'attach-session', '-t', record.tmuxSession]
    const windows = getPlatform() === 'windows'
    const code = await new Promise<number>(resolveExit => {
      const child = spawn(
        windows ? 'wsl' : 'tmux',
        windows ? ['-e', 'tmux', ...args] : args,
        { stdio: 'inherit' },
      )
      child.once('error', () => resolveExit(1))
      child.once('exit', exitCode => resolveExit(exitCode ?? 1))
    })
    if (code === 0) return 0
    if (attempt < 2) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100 * 2 ** attempt))
    }
  }
  return 1
}

export async function killBackgroundSession(
  sessionId: string | undefined,
  options: { stopTimeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const found = await findBackgroundSession(sessionId)
  if (found.stopped) return { session_id: found.record.sessionId, state: 'already_stopped' }
  const record = found.record
  const initial = await authorizeSession(record, 'kill')
  if (initial.state === 'stopped') {
    await writeSessionTombstone({ ...record, lifecycle: 'stopped' })
    await deleteSessionRegistryRecord(record)
    return { session_id: record.sessionId, state: 'already_stopped' }
  }

  const signal = async (name: 'SIGTERM' | 'SIGKILL') => {
    const authorized = await authorizeSession(record, 'kill')
    if (authorized.state !== 'live') return false
    try {
      process.kill(record.pid, name)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      fail('PID_IDENTITY_MISMATCH', 'Unable to signal the authorized process')
    }
  }
  await signal('SIGTERM')
  const deadline = Date.now() + (options.stopTimeoutMs ?? 5_000)
  let live = true
  while (Date.now() < deadline) {
    const identity = await getProcessIdentity(record.pid)
    if (identity.state === 'not_found') {
      live = false
      break
    }
    if (identity.state === 'unknown') {
      // ps/proc can briefly omit start metadata while the process is exiting.
      // Keep waiting; no additional signal or cleanup is authorized meanwhile.
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
      continue
    }
    if (identity.token !== record.processStartToken) {
      fail('PID_IDENTITY_MISMATCH', 'Process identity changed during kill')
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  const escalated = live
  if (live) {
    await signal('SIGKILL')
    const killDeadline = Date.now() + 5_000
    while (Date.now() < killDeadline) {
      const identity = await getProcessIdentity(record.pid)
      if (identity.state === 'not_found') {
        live = false
        break
      }
      if (identity.state === 'running' && identity.token !== record.processStartToken) {
        fail('PID_IDENTITY_MISMATCH', 'Process identity changed during SIGKILL')
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    if (live) {
      const identity = await getProcessIdentity(record.pid)
      if (identity.state === 'not_found') live = false
      else if (identity.state === 'running' && identity.token === record.processStartToken) {
        fail('KILL_TIMEOUT', 'Process did not exit after SIGKILL')
      } else {
        fail('PID_IDENTITY_MISMATCH', 'Process exit could not be verified')
      }
    }
  }

  await execTmux(['-L', record.tmuxSocket, 'kill-session', '-t', record.tmuxSession])
  const stopped: BackgroundSessionRecord = {
    ...record,
    lifecycle: 'stopped',
    status: 'idle',
    updatedAt: Date.now(),
    exit: {
      code: null,
      signal: escalated ? 'SIGKILL' : 'SIGTERM',
      reason: 'killed',
      ended_at: Date.now(),
    },
  }
  await writeSessionTombstone(stopped)
  await deleteSessionRegistryRecord(record)
  return { session_id: record.sessionId, state: 'stopped' }
}

async function handle(operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const converted =
      error instanceof BackgroundSessionError
        ? error
        : new BackgroundSessionError('BACKGROUND_OPERATION_FAILED', 'Background operation failed')
    process.stderr.write(`${converted.code}: ${converted.message}\n`)
    process.exitCode = 1
  }
}

export async function psHandler(args: string[]): Promise<void> {
  await handle(async () => {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      process.stdout.write('Usage: claude ps [--json]\n')
      return
    }
    if (args.some(arg => arg !== '--json')) {
      fail('INVALID_ARGUMENT', 'ps only accepts --json')
    }
    const sessions = await listBackgroundSessions()
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ version: VERSION, sessions })}\n`)
    } else {
      for (const session of sessions) process.stdout.write(`${JSON.stringify(session)}\n`)
    }
  })
}

export async function logsHandler(sessionId: string | undefined): Promise<void> {
  await handle(() => readLogs(sessionId))
}

export async function attachHandler(sessionId: string | undefined): Promise<void> {
  await handle(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail('ATTACH_REQUIRES_TTY', 'attach requires an interactive TTY')
    }
    const { record, stopped } = await findBackgroundSession(sessionId)
    if (stopped) fail('SESSION_NOT_FOUND', 'Session has exited')
    const code = await attach(record)
    if (code !== 0) process.exitCode = code
  })
}

export async function killHandler(sessionId: string | undefined): Promise<void> {
  await handle(async () => {
    process.stdout.write(`${JSON.stringify(await killBackgroundSession(sessionId))}\n`)
  })
}

export async function handleBgFlag(args: string[]): Promise<void> {
  await handle(async () => {
    const record = await launchBackgroundSession(args)
    process.stdout.write(`${JSON.stringify(summary(record))}\n`)
  })
}
