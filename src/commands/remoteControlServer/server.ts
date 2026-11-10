import { query } from '../../entrypoints/agentSdkTypes.js'
import type { SDKUserMessage } from '../../entrypoints/sdk/coreTypes.js'
import type { InternalQuery } from '../../entrypoints/sdk/runtimeTypes.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'

export type RemoteControlServerInfo = {
  session_url: string
  connect_url: string
  environment_id: string
}

type ServerQuery = Pick<InternalQuery, 'enableRemoteControl' | 'return'>

type RunningServer = {
  query: ServerQuery
  closeInput: () => Promise<void>
  info: RemoteControlServerInfo
  done: Promise<void>
  finish: () => void
  unregisterCleanup: () => void
}

let running: RunningServer | undefined

function pendingInput(): {
  iterable: AsyncIterable<SDKUserMessage>
  close: () => Promise<void>
} {
  let closed = false
  let wake: (() => void) | undefined
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SDKUserMessage>> {
            if (closed) return { done: true, value: undefined }
            await new Promise<void>(resolve => {
              wake = resolve
            })
            return closed
              ? { done: true, value: undefined }
              : { done: false, value: undefined as never }
          },
          async return(): Promise<IteratorResult<SDKUserMessage>> {
            closed = true
            wake?.()
            return { done: true, value: undefined }
          },
        }
      },
    },
    close: async () => {
      closed = true
      wake?.()
    },
  }
}

export async function startRemoteControlServer(options?: {
  cwd?: string
  createQuery?: (params: {
    prompt: AsyncIterable<SDKUserMessage>
    options: { cwd: string }
  }) => ServerQuery
}): Promise<RemoteControlServerInfo> {
  if (running) return running.info
  const input = pendingInput()
  const serverQuery = (options?.createQuery ?? query)({
    prompt: input.iterable,
    options: { cwd: options?.cwd ?? process.cwd() },
  })
  let info: RemoteControlServerInfo
  try {
    info = (await serverQuery.enableRemoteControl(
      true,
    )) as RemoteControlServerInfo
  } catch (error) {
    await input.close()
    await serverQuery.return(undefined)
    throw error
  }

  let finish = () => {}
  const done = new Promise<void>(resolve => {
    finish = resolve
  })
  const server: RunningServer = {
    query: serverQuery,
    closeInput: input.close,
    info,
    done,
    finish,
    unregisterCleanup: () => {},
  }
  server.unregisterCleanup = registerCleanup(async () => {
    await stopRemoteControlServer()
  })
  running = server
  return info
}

export function getRemoteControlServerInfo(): RemoteControlServerInfo | undefined {
  return running?.info
}

export async function waitForRemoteControlServer(): Promise<void> {
  await running?.done
}

export async function stopRemoteControlServer(): Promise<void> {
  const server = running
  if (!server) return
  running = undefined
  server.unregisterCleanup()
  try {
    await server.query.enableRemoteControl(false)
    await server.closeInput()
    await server.query.return(undefined)
  } finally {
    server.finish()
  }
}
