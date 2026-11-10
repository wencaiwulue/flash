export type ServerLock = {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

export async function probeRunningServer(): Promise<ServerLock | null> {
  return null
}

export async function writeServerLock(_lock: ServerLock): Promise<never> {
  throw new Error('Direct-connect server lockfiles are unavailable in this build')
}

export async function removeServerLock(): Promise<never> {
  throw new Error('Direct-connect server lockfiles are unavailable in this build')
}
