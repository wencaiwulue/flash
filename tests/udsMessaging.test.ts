import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtemp, rm, stat } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../src/bootstrap/state.ts'
import {
  getCommandQueueSnapshot,
  resetCommandQueue,
} from '../src/utils/messageQueueManager.ts'
import {
  listAllLiveSessions,
  sendToUdsSocket,
} from '../src/utils/udsClient.ts'
import {
  getUdsMessagingSocketPath,
  setOnEnqueue,
  startUdsMessaging,
  stopUdsMessaging,
} from '../src/utils/udsMessaging.ts'
import {
  readUdsRegistry,
  registerUdsSession,
} from '../src/utils/udsRegistry.ts'

let tempDir: string
let socketPath: string
let registryDir: string

beforeEach(async () => {
  tempDir = await mkdtemp('/tmp/claude-uds-test-')
  socketPath = join(tempDir, 'peer.sock')
  registryDir = join(tempDir, 'registry')
  resetCommandQueue()
})

afterEach(async () => {
  await stopUdsMessaging()
  resetCommandQueue()
  await rm(tempDir, { recursive: true, force: true })
})

test('serves real UDS prompts, peer discovery, and teardown', async () => {
  await startUdsMessaging(socketPath, {
    isExplicit: true,
    registryDir,
  })
  expect(getUdsMessagingSocketPath()).toBe(socketPath)
  expect((await stat(socketPath)).mode & 0o777).toBe(0o600)

  let wakeups = 0
  expect(setOnEnqueue(() => wakeups++)).toBe(true)
  await sendToUdsSocket(socketPath, 'hello by path')
  await sendToUdsSocket(getSessionId(), 'hello by session', registryDir)
  expect(wakeups).toBe(2)
  expect(
    getCommandQueueSnapshot().map(command => command.value),
  ).toEqual(['hello by path', 'hello by session'])

  const sessions = await listAllLiveSessions(registryDir)
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({
    sessionId: getSessionId(),
    socketPath,
    pid: process.pid,
  })

  await stopUdsMessaging()
  expect(getUdsMessagingSocketPath()).toBeUndefined()
  expect(setOnEnqueue(() => {})).toBe(false)
  expect(await readUdsRegistry(registryDir)).toEqual([])
  await expect(stat(socketPath)).rejects.toThrow()
  await expect(sendToUdsSocket(socketPath, 'after stop')).rejects.toThrow()
}, 10_000)

test('removes stale registry entries instead of returning offline peers', async () => {
  const staleId = randomUUID()
  const stalePath = join(tempDir, 'missing.sock')
  await registerUdsSession(
    {
      sessionId: staleId,
      socketPath: stalePath,
      kind: 'interactive',
      pid: 999_999,
    },
    registryDir,
  )
  expect(await listAllLiveSessions(registryDir)).toEqual([])
  expect(await readUdsRegistry(registryDir)).toEqual([])
  await expect(
    sendToUdsSocket(staleId, 'not delivered', registryDir),
  ).rejects.toThrow('Unknown or offline UDS peer')
})
