import { chmod, mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getProcessIdentity, getProcessStartToken } from '../utils/processIdentity.js'

export type ServerLock = {
  version?: 'direct-connect-v1'
  pid: number
  processStartToken?: string
  port: number
  host: string
  httpUrl: string
  unix?: string | null
  startedAt: number
}

function lockPath(): string {
  return join(getClaudeConfigHomeDir(), 'server.lock')
}

function parseLock(value: unknown): ServerLock {
  if (typeof value !== 'object' || value === null) throw new Error('bad lock')
  const lock = value as ServerLock
  if (
    lock.version !== 'direct-connect-v1' ||
    !Number.isSafeInteger(lock.pid) ||
    typeof lock.processStartToken !== 'string' ||
    !lock.processStartToken ||
    typeof lock.httpUrl !== 'string' ||
    typeof lock.startedAt !== 'number'
  ) {
    throw new Error('Invalid or legacy direct-connect lockfile')
  }
  return lock
}

async function healthMatches(lock: ServerLock): Promise<boolean | undefined> {
  try {
    const unix = lock.unix ?? (lock.httpUrl.startsWith('unix:') ? lock.httpUrl.slice(5) : undefined)
    const response = await fetch(unix ? 'http://localhost/health' : `${lock.httpUrl}/health`, {
      signal: AbortSignal.timeout(1_500),
      ...(unix ? ({ unix } as unknown as RequestInit) : {}),
    })
    if (!response.ok) return false
    const health = (await response.json()) as Record<string, unknown>
    return health.protocol === 'direct-connect-v1' && health.pid === lock.pid
  } catch {
    return undefined
  }
}

async function removeIfUnchanged(raw: string): Promise<void> {
  try {
    if ((await readFile(lockPath(), 'utf8')) === raw) await unlink(lockPath())
  } catch {
    // A concurrently replaced lock belongs to another launcher.
  }
}

/** Probe both process identity and the unauthenticated minimal health endpoint. */
export async function probeRunningServer(): Promise<ServerLock | null> {
  let raw: string
  try {
    raw = await readFile(lockPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let lock: ServerLock
  try {
    lock = parseLock(JSON.parse(raw))
  } catch {
    // There is no safe PID identity to act on. Fail closed rather than stealing
    // or deleting an operator's possibly-live lock.
    throw new Error('Direct-connect lockfile is invalid; manual cleanup is required')
  }

  const identity = await getProcessIdentity(lock.pid)
  if (identity.state === 'unknown') return lock
  if (identity.state === 'not_found') {
    await removeIfUnchanged(raw)
    return null
  }
  if (identity.token !== lock.processStartToken) {
    // A matching start token is required to trust PID ownership. A different
    // live PID proves the original process is gone, so only this exact lock
    // contents may be removed.
    await removeIfUnchanged(raw)
    return null
  }

  const healthy = await healthMatches(lock)
  if (healthy === false) {
    await removeIfUnchanged(raw)
    return null
  }
  // Health timeout/refused with a verified live process is conservatively live.
  return lock
}

export async function writeServerLock(lock: ServerLock): Promise<void> {
  const directory = getClaudeConfigHomeDir()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const processStartToken = lock.processStartToken ?? (await getProcessStartToken(lock.pid))
  if (!processStartToken) {
    throw new Error('Unable to establish server process identity')
  }
  const value: ServerLock = {
    ...lock,
    version: 'direct-connect-v1',
    processStartToken,
    unix: lock.unix ?? null,
  }
  // wx is the lock acquisition. No bearer token is ever included in this file.
  await writeFile(lockPath(), JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  await chmod(lockPath(), 0o600)
}

export async function removeServerLock(): Promise<void> {
  let raw: string
  try {
    raw = await readFile(lockPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const lock = parseLock(JSON.parse(raw))
  if (lock.pid !== process.pid) return
  const token = await getProcessStartToken(process.pid)
  if (!token || token !== lock.processStartToken) return
  await removeIfUnchanged(raw)
}
