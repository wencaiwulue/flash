import { readFile } from 'fs/promises'
import { execFileNoThrow } from './execFileNoThrow.js'

export type ProcessIdentity = {
  state: 'running' | 'not_found' | 'unknown'
  token?: string
}

/** Read the Linux starttime field without being confused by spaces/parentheses in comm. */
async function linuxStartToken(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    if (end < 0) return undefined
    const fields = stat.slice(end + 1).trim().split(/\s+/)
    // Fields after comm begin at field 3; starttime is field 22.
    return fields[19]
  } catch {
    return undefined
  }
}

async function psStartToken(pid: number): Promise<string | undefined> {
  const result = await execFileNoThrow(
    'ps',
    ['-o', 'lstart=', '-p', String(pid)],
    { useCwd: false, timeout: 2_000, preserveOutputOnError: false },
  )
  if (result.code !== 0) return undefined
  const token = result.stdout.trim().replace(/\s+/g, ' ')
  return token || undefined
}

/**
 * Return a stable, platform-specific process start token. EPERM and unavailable
 * identity data are reported as unknown, never as proof that a process died.
 */
async function isZombie(pid: number): Promise<boolean> {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      return end >= 0 && stat.slice(end + 1).trim().split(/\s+/)[0] === 'Z'
    } catch {
      return false
    }
  }
  if (process.platform === 'win32') return false
  const result = await execFileNoThrow('ps', ['-o', 'stat=', '-p', String(pid)], {
    useCwd: false,
    timeout: 2_000,
    preserveOutputOnError: false,
  })
  return result.code === 0 && result.stdout.trim().startsWith('Z')
}

export async function getProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: 'not_found' }
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return { state: 'unknown' }
    if (code === 'ESRCH') return { state: 'not_found' }
    return { state: 'unknown' }
  }

  if (await isZombie(pid)) return { state: 'not_found' }

  const token =
    process.platform === 'linux'
      ? await linuxStartToken(pid)
      : process.platform === 'win32'
        ? undefined
        : await psStartToken(pid)
  return token ? { state: 'running', token } : { state: 'unknown' }
}

export async function getProcessStartToken(
  pid: number,
): Promise<string | undefined> {
  return (await getProcessIdentity(pid)).token
}

export async function matchesProcessStartToken(
  pid: number,
  expected: string,
): Promise<boolean> {
  if (!expected) return false
  const identity = await getProcessIdentity(pid)
  return identity.state === 'running' && identity.token === expected
}
