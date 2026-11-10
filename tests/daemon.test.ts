import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  getRemoteControlServerInfo,
  startRemoteControlServer,
  stopRemoteControlServer,
  waitForRemoteControlServer,
} from '../src/commands/remoteControlServer/server.ts'
import { getDaemonStatus } from '../src/daemon/main.ts'
import { DaemonSupervisor } from '../src/daemon/supervisor.ts'
import { runDaemonWorker } from '../src/daemon/workerRegistry.ts'
import { sleep } from '../src/utils/sleep.ts'

afterEach(async () => {
  await stopRemoteControlServer()
})

describe('Remote Control server lifecycle', () => {
  test('shares one query, disables remote control, and closes input on stop', async () => {
    const enableRemoteControl = mock(async (enabled: boolean) =>
      enabled
        ? {
            session_url: 'https://example.invalid/session',
            connect_url: 'https://example.invalid/session',
            environment_id: 'env-test',
          }
        : undefined,
    )
    const returnQuery = mock(async () => {})
    const createQuery = mock(() => ({
      enableRemoteControl,
      return: returnQuery,
    }))

    const info = await startRemoteControlServer({
      createQuery: createQuery as never,
    })
    expect(info.environment_id).toBe('env-test')
    expect(getRemoteControlServerInfo()).toEqual(info)
    await startRemoteControlServer({ createQuery: createQuery as never })
    expect(createQuery).toHaveBeenCalledTimes(1)

    let finished = false
    const waiting = waitForRemoteControlServer().then(() => {
      finished = true
    })
    await sleep(1)
    expect(finished).toBe(false)
    await stopRemoteControlServer()
    await waiting
    expect(finished).toBe(true)
    expect(enableRemoteControl.mock.calls.map(call => call[0])).toEqual([
      true,
      false,
    ])
    expect(returnQuery).toHaveBeenCalledTimes(1)
    expect(getRemoteControlServerInfo()).toBeUndefined()
  })

  test('worker registry accepts known workers and rejects unknown kinds', async () => {
    const start = mock(async () => ({
      session_url: 'x',
      connect_url: 'x',
      environment_id: 'x',
    }))
    const wait = mock(async () => {})
    await runDaemonWorker('assistant', { start: start as never, wait })
    expect(start).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenCalledTimes(1)
    await expect(runDaemonWorker('unknown')).rejects.toThrow(
      'Unknown daemon worker kind',
    )
  })
})

class FakeWorker extends EventEmitter {
  killed = false
  constructor(readonly pid: number) {
    super()
  }
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
}

describe('DaemonSupervisor', () => {
  test('restarts failed workers with bounded exponential delays', async () => {
    const workers: FakeWorker[] = []
    const delays: number[] = []
    const supervisor = new DaemonSupervisor({
      spawn: () => {
        const worker = new FakeWorker(100 + workers.length)
        workers.push(worker)
        return worker
      },
      baseDelayMs: 10,
      maxDelayMs: 15,
      wait: async ms => {
        delays.push(ms)
      },
    })
    const running = supervisor.run('assistant')
    workers[0]!.emit('exit', 1, null)
    await sleep(0)
    expect(workers).toHaveLength(2)
    workers[1]!.emit('exit', 0, null)
    expect(await running).toBe(0)
    expect(delays).toEqual([10])
    expect(supervisor.getState().restarts).toBe(1)
  })

  test('stops after maxRestarts instead of looping forever', async () => {
    const workers: FakeWorker[] = []
    const supervisor = new DaemonSupervisor({
      spawn: () => {
        const worker = new FakeWorker(200 + workers.length)
        workers.push(worker)
        return worker
      },
      maxRestarts: 1,
      wait: async () => {},
    })
    const running = supervisor.run('assistant')
    workers[0]!.emit('exit', 1, null)
    await sleep(0)
    workers[1]!.emit('exit', 1, null)
    await expect(running).rejects.toThrow('failed after 1 restarts')
  })

  test('stop terminates the active worker without restarting it', async () => {
    const worker = new FakeWorker(300)
    const supervisor = new DaemonSupervisor({ spawn: () => worker })
    const running = supervisor.run('assistant')
    supervisor.stop()
    expect(await running).toBe(0)
    expect(worker.killed).toBe(true)
    expect(supervisor.getState().running).toBe(false)
  })

  test('status removes stale PID records', async () => {
    const dir = await mkdtemp(join('/tmp', 'claude-daemon-test-'))
    try {
      await mkdir(dir, { recursive: true })
      const path = join(dir, 'assistant.json')
      await writeFile(
        path,
        JSON.stringify({ pid: 999_999, kind: 'assistant', startedAt: 'old' }),
      )
      expect(await getDaemonStatus('assistant', dir)).toEqual({ running: false })
      await expect(readFile(path, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
