import { chmod, mkdir, stat, unlink } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir, userInfo } from 'os'
import { dirname, join } from 'path'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { enqueue } from './messageQueueManager.js'
import { pingUdsSession } from './udsClient.js'
import {
  getUdsRegistryDir,
  registerUdsSession,
  unregisterUdsSession,
} from './udsRegistry.js'

const MAX_FRAME_BYTES = 1024 * 1024

let activeServer: Server | undefined
let activePath: string | undefined
let activeRegistryDir: string | undefined
let unregisterCleanup: (() => void) | undefined
let onEnqueue: (() => void) | undefined
const connections = new Set<Socket>()

export function getDefaultUdsSocketPath(): string {
  const sessionId = getSessionId()
  const name = `claude-code-${userInfo().uid}-${sessionId.slice(0, 8)}`
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : join(tmpdir(), `${name}.sock`)
}

export function getUdsMessagingSocketPath(): string | undefined {
  return activePath
}

function handleFrame(frame: string, socket: Socket): void {
  let parsed: Record<string, unknown> | undefined
  try {
    const value = JSON.parse(frame) as Record<string, unknown>
    if (value && typeof value === 'object') parsed = value
  } catch {
    // Ordinary prompts are plain text, not JSON.
  }
  if (parsed?.type === 'ping') {
    socket.write(
      `${JSON.stringify({
        type: 'pong',
        sessionId: getSessionId(),
        kind: getIsNonInteractiveSession() ? 'headless' : 'interactive',
      })}\n`,
    )
    return
  }

  const message =
    parsed?.type === 'message' && typeof parsed.message === 'string'
      ? parsed.message
      : frame
  if (!message) {
    socket.write(`${JSON.stringify({ ok: false, error: 'Empty message' })}\n`)
    return
  }
  enqueue({ mode: 'prompt', value: message, priority: 'later' })
  socket.write(`${JSON.stringify({ ok: true })}\n`)
  onEnqueue?.()
}

export async function startUdsMessaging(
  socketPath: string,
  options: { isExplicit: boolean; registryDir?: string },
): Promise<void> {
  if (activeServer) {
    if (activePath === socketPath) return
    throw new Error(`UDS server is already listening at ${activePath}`)
  }
  if (process.platform !== 'win32' && Buffer.byteLength(socketPath) >= 100) {
    throw new Error('UDS socket path is too long (must be under 100 bytes)')
  }

  if (process.platform !== 'win32') {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
    const exists = await stat(socketPath).then(() => true, () => false)
    if (exists) {
      if (await pingUdsSession(socketPath)) {
        throw new Error(
          `UDS socket is already active: ${socketPath}${options.isExplicit ? ' (explicit path)' : ''}`,
        )
      }
      await unlink(socketPath)
    }
  }

  const server = createServer(socket => {
    connections.add(socket)
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.destroy(new Error('UDS frame exceeded 1 MiB'))
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const frame = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (frame) handleFrame(frame, socket)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => connections.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.off('error', onError)
      resolve()
    })
  })

  activeServer = server
  activePath = socketPath
  activeRegistryDir = options.registryDir ?? getUdsRegistryDir()
  try {
    if (process.platform !== 'win32') await chmod(socketPath, 0o600)
    await registerUdsSession(
      {
        sessionId: getSessionId(),
        kind: getIsNonInteractiveSession() ? 'headless' : 'interactive',
        socketPath,
        pid: process.pid,
      },
      activeRegistryDir,
    )
  } catch (error) {
    await stopUdsMessaging()
    throw error
  }

  server.on('error', error => logForDebugging(`UDS server error: ${error}`))
  server.unref()
  unregisterCleanup = registerCleanup(stopUdsMessaging)
}

export async function stopUdsMessaging(): Promise<void> {
  const server = activeServer
  const socketPath = activePath
  const registryDir = activeRegistryDir
  activeServer = undefined
  activePath = undefined
  activeRegistryDir = undefined
  unregisterCleanup?.()
  unregisterCleanup = undefined
  onEnqueue = undefined

  for (const socket of connections) socket.destroy()
  connections.clear()
  if (server) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  if (socketPath) {
    await unregisterUdsSession(getSessionId(), socketPath, registryDir)
    if (process.platform !== 'win32') await unlink(socketPath).catch(() => {})
  }
}

export function setOnEnqueue(callback: () => void): boolean {
  if (!activeServer) return false
  onEnqueue = callback
  return true
}
