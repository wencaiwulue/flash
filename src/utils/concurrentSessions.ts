import { feature } from 'bun:bundle'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'fs/promises'
import { dirname, join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { isProcessRunning } from './genericProcessUtils.js'
import { getProcessStartToken } from './processIdentity.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getAgentId } from './teammate.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

export type BackgroundSessionRecord = {
  version: 'background-sessions-v1'
  launchId: string
  sessionId: string
  pid: number
  processStartToken: string
  argsHash: string
  cwd: string
  startedAt: number
  kind: 'bg'
  entrypoint: string
  name?: string
  logPath: string
  messagingSocketPath?: string
  status: SessionStatus | 'starting'
  waitingFor?: string | null
  updatedAt: number
  lifecycle: 'launching' | 'running' | 'stopping' | 'stopped' | 'failed'
  tmuxSocket: string
  tmuxSocketPath: string
  tmuxSession: string
  tmuxServerPid: number
  tmuxPanePid: number
  ownerUid: number
  registeredAt?: number
  exit?: {
    code: number | null
    signal: string | null
    reason: string
    ended_at: number
  } | null
}

export type SessionRegistryRecord = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: SessionKind
  entrypoint?: string
  name?: string
  logPath?: string
  messagingSocketPath?: string
  processStartToken?: string
  status?: SessionStatus | 'starting'
  waitingFor?: string | null
  updatedAt?: number
  registeredAt?: number
  [key: string]: unknown
}

export function getSessionRegistryDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

export function getSessionTombstoneDir(): string {
  return join(getClaudeConfigHomeDir(), 'session-tombstones')
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(jsonStringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

export async function writeSessionRegistryRecord(
  record: SessionRegistryRecord | BackgroundSessionRecord,
): Promise<void> {
  const dir = getSessionRegistryDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  await atomicWriteJson(join(dir, `${record.pid}.json`), record)
}

export async function writeSessionTombstone(
  record: SessionRegistryRecord | BackgroundSessionRecord,
): Promise<void> {
  if (record.kind !== 'bg') return
  const dir = getSessionTombstoneDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  await atomicWriteJson(join(dir, `${record.sessionId}.json`), record)
}

export async function deleteSessionRegistryRecord(
  record: SessionRegistryRecord | BackgroundSessionRecord,
): Promise<boolean> {
  const path = join(getSessionRegistryDir(), `${record.pid}.json`)
  try {
    const current = jsonParse(await readFile(path, 'utf8')) as SessionRegistryRecord
    if (
      current.sessionId !== record.sessionId ||
      (record.processStartToken &&
        current.processStartToken !== record.processStartToken)
    ) {
      return false
    }
    await unlink(path)
    return true
  } catch {
    return false
  }
}

export async function readSessionRegistry(): Promise<SessionRegistryRecord[]> {
  let files: string[]
  try {
    files = await readdir(getSessionRegistryDir())
  } catch {
    return []
  }
  const records = await Promise.all(
    files.filter(file => /^\d+\.json$/.test(file)).map(async file => {
      const path = join(getSessionRegistryDir(), file)
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) return undefined
        const record = jsonParse(await readFile(path, 'utf8')) as SessionRegistryRecord
        if (
          record.pid !== Number(file.slice(0, -5)) ||
          typeof record.sessionId !== 'string' ||
          typeof record.kind !== 'string'
        ) {
          return undefined
        }
        return record
      } catch {
        return undefined
      }
    }),
  )
  return records.filter((record): record is SessionRegistryRecord => !!record)
}

function envSessionKind(): SessionKind | undefined {
  if (feature('BG_SESSIONS')) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false
  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionRegistryDir()
  const pidFile = join(dir, `${process.pid}.json`)
  const processStartToken = await getProcessStartToken(process.pid)
  let launchRecord: SessionRegistryRecord | undefined
  if (kind === 'bg') {
    try {
      launchRecord = jsonParse(await readFile(pidFile, 'utf8')) as SessionRegistryRecord
      if (
        launchRecord.sessionId !== getSessionId() ||
        launchRecord.kind !== 'bg' ||
        (processStartToken && launchRecord.processStartToken !== processStartToken)
      ) {
        launchRecord = undefined
      }
    } catch {
      // A manually started bg-kind process can still register a basic record.
    }
  }

  registerCleanup(async () => {
    try {
      const current = jsonParse(await readFile(pidFile, 'utf8')) as SessionRegistryRecord
      if (
        current.sessionId !== getSessionId() ||
        (processStartToken && current.processStartToken !== processStartToken)
      ) {
        return
      }
      if (current.kind === 'bg') {
        await writeSessionTombstone({
          ...current,
          lifecycle: 'stopped',
          exit: {
            code: 0,
            signal: null,
            reason: 'process_exit',
            ended_at: Date.now(),
          },
        } as BackgroundSessionRecord)
      }
      await unlink(pidFile)
    } catch {
      // ENOENT is fine (already deleted or never written).
    }
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    await writeSessionRegistryRecord({
      ...launchRecord,
      pid: process.pid,
      sessionId: getSessionId(),
      cwd: launchRecord?.cwd ?? getOriginalCwd(),
      startedAt: launchRecord?.startedAt ?? Date.now(),
      kind,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      processStartToken: launchRecord?.processStartToken ?? processStartToken,
      registeredAt: Date.now(),
      updatedAt: Date.now(),
      ...(kind === 'bg' ? { lifecycle: 'running', status: 'idle' } : {}),
      ...(feature('UDS_INBOX')
        ? { messagingSocketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET }
        : {}),
      ...(feature('BG_SESSIONS')
        ? {
            name: process.env.CLAUDE_CODE_SESSION_NAME ?? launchRecord?.name,
            logPath: process.env.CLAUDE_CODE_SESSION_LOG ?? launchRecord?.logPath,
            agent: process.env.CLAUDE_CODE_AGENT,
          }
        : {}),
    })
    onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (error) {
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(error)}`)
    return false
  }
}

let updateQueue: Promise<void> = Promise.resolve()
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  const operation = updateQueue.then(async () => {
    const pidFile = join(getSessionRegistryDir(), `${process.pid}.json`)
    try {
      const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<string, unknown>
      await writeSessionRegistryRecord({
        ...data,
        ...patch,
        updatedAt: Date.now(),
      } as SessionRegistryRecord)
    } catch (error) {
      logForDebugging(
        `[concurrentSessions] updatePidFile failed: ${errorMessage(error)}`,
      )
    }
  })
  updateQueue = operation.catch(() => undefined)
  return operation
}

export async function updateSessionName(name: string | undefined): Promise<void> {
  if (!name) return
  await updatePidFile({ name })
}

export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  if (!feature('BG_SESSIONS')) return
  await updatePidFile(patch)
}

export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionRegistryDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (error) {
    if (!isFsInaccessible(error)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(error)}`)
    }
    return 0
  }
  let count = 0
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) count++
    // Do not delete stale-looking records here: bg cleanup requires the shared
    // PID+start-token+tmux authorization path, not a signal-0 hint alone.
  }
  return count
}
