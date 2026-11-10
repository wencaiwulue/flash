import { createConnection } from 'net'
import {
  readUdsRegistry,
  unregisterUdsSession,
  type UdsLiveSession,
} from './udsRegistry.js'

export type { UdsLiveSession } from './udsRegistry.js'

const MAX_RESPONSE_BYTES = 64 * 1024

function requestUds(
  socketPath: string,
  payload: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ''
    let settled = false
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    const timeout = setTimeout(() => {
      finish(new Error(`UDS request timed out: ${socketPath}`))
    }, timeoutMs)
    socket.on('connect', () => socket.write(`${payload}\n`))
    socket.on('data', chunk => {
      response += chunk.toString()
      if (response.length > MAX_RESPONSE_BYTES) {
        finish(new Error('UDS response exceeded 64 KiB'))
        return
      }
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        const value = JSON.parse(response.slice(0, newline)) as Record<
          string,
          unknown
        >
        finish(undefined, value)
      } catch {
        finish(new Error('UDS peer returned malformed JSON'))
      }
    })
    socket.on('error', error => finish(error))
    socket.on('close', () => {
      if (!settled) finish(new Error(`UDS peer closed without a response: ${socketPath}`))
    })
  })
}

export async function pingUdsSession(
  socketPath: string,
  timeoutMs = 300,
): Promise<UdsLiveSession | undefined> {
  try {
    const response = await requestUds(
      socketPath,
      JSON.stringify({ type: 'ping' }),
      timeoutMs,
    )
    if (response.type !== 'pong' || typeof response.sessionId !== 'string') {
      return undefined
    }
    return {
      sessionId: response.sessionId,
      kind: typeof response.kind === 'string' ? response.kind : undefined,
      socketPath,
    }
  } catch {
    return undefined
  }
}

export async function listAllLiveSessions(
  registryDir?: string,
): Promise<UdsLiveSession[]> {
  const records = await readUdsRegistry(registryDir)
  const sessions: (UdsLiveSession | undefined)[] = await Promise.all(
    records.map(async record => {
      const live = await pingUdsSession(record.socketPath)
      if (!live || live.sessionId !== record.sessionId) {
        if (record.sessionId) {
          await unregisterUdsSession(
            record.sessionId,
            record.socketPath,
            registryDir,
          )
        }
        return undefined
      }
      return {
        ...live,
        ...(record.pid !== undefined ? { pid: record.pid } : {}),
      }
    }),
  )
  return sessions
    .filter((session): session is UdsLiveSession => !!session)
    .sort((a, b) => (a.sessionId ?? '').localeCompare(b.sessionId ?? ''))
}

export async function sendToUdsSocket(
  socketPath: string,
  message: string,
  registryDir?: string,
): Promise<void> {
  let resolvedPath = socketPath
  if (!socketPath.startsWith('/') && !socketPath.startsWith('\\\\')) {
    const peer = (await listAllLiveSessions(registryDir)).find(
      session => session.sessionId === socketPath,
    )
    if (!peer) throw new Error(`Unknown or offline UDS peer: ${socketPath}`)
    resolvedPath = peer.socketPath
  }
  const response = await requestUds(resolvedPath, message, 2_000)
  if (response.ok !== true) {
    throw new Error(
      typeof response.error === 'string'
        ? response.error
        : 'UDS peer rejected the message',
    )
  }
}
