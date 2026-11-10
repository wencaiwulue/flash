import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'

export type UdsLiveSession = {
  kind?: string
  sessionId?: string
  socketPath: string
  pid?: number
}

export function getUdsRegistryDir(): string {
  return join(getClaudeConfigHomeDir(), 'uds')
}

function registryFile(dir: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(dir, `${safeId}.json`)
}

export async function registerUdsSession(
  session: Required<Pick<UdsLiveSession, 'sessionId' | 'socketPath' | 'pid'>> &
    Pick<UdsLiveSession, 'kind'>,
  registryDir = getUdsRegistryDir(),
): Promise<void> {
  await mkdir(registryDir, { recursive: true, mode: 0o700 })
  const path = registryFile(registryDir, session.sessionId)
  const temporary = `${path}.${session.pid}.tmp`
  await writeFile(temporary, JSON.stringify(session), { mode: 0o600 })
  await rename(temporary, path)
}

export async function unregisterUdsSession(
  sessionId: string,
  socketPath: string,
  registryDir = getUdsRegistryDir(),
): Promise<void> {
  const path = registryFile(registryDir, sessionId)
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as UdsLiveSession
    if (current.socketPath === socketPath) await unlink(path)
  } catch {
    // Missing or malformed records need no cleanup.
  }
}

export async function readUdsRegistry(
  registryDir = getUdsRegistryDir(),
): Promise<UdsLiveSession[]> {
  let names: string[]
  try {
    names = await readdir(registryDir)
  } catch {
    return []
  }
  const sessions = await Promise.all(
    names
      .filter(name => name.endsWith('.json'))
      .map(async name => {
        try {
          const value = JSON.parse(
            await readFile(join(registryDir, name), 'utf8'),
          ) as UdsLiveSession
          return typeof value.sessionId === 'string' &&
            typeof value.socketPath === 'string'
            ? value
            : undefined
        } catch {
          return undefined
        }
      }),
  )
  return sessions.filter((session): session is UdsLiveSession => !!session)
}
