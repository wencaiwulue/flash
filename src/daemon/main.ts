import { spawn } from 'child_process'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { DaemonSupervisor } from './supervisor.js'

type DaemonRecord = {
  pid: number
  kind: string
  startedAt: string
}

function recordPath(kind: string, registryDir = join(getClaudeConfigHomeDir(), 'daemon')) {
  return join(registryDir, `${kind.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

async function readRecord(kind: string, registryDir?: string): Promise<DaemonRecord | undefined> {
  try {
    const record = JSON.parse(
      await readFile(recordPath(kind, registryDir), 'utf8'),
    ) as DaemonRecord
    return Number.isInteger(record.pid) && record.pid > 0 ? record : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function getDaemonStatus(
  kind = 'assistant',
  registryDir?: string,
): Promise<{ running: boolean; pid?: number }> {
  const record = await readRecord(kind, registryDir)
  if (!record) return { running: false }
  if (!isAlive(record.pid)) {
    await unlink(recordPath(kind, registryDir)).catch(() => {})
    return { running: false }
  }
  return { running: true, pid: record.pid }
}

export async function startDaemon(kind = 'assistant', registryDir?: string): Promise<DaemonRecord> {
  const existing = await readRecord(kind, registryDir)
  if (existing && isAlive(existing.pid)) return existing
  if (existing) await unlink(recordPath(kind, registryDir)).catch(() => {})
  const script = process.argv[1]
  if (!script) throw new Error('Cannot locate the CLI entrypoint')
  const child = spawn(process.execPath, [script, 'daemon', 'run', kind], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  if (!child.pid) throw new Error('Failed to start daemon supervisor')
  const record = { pid: child.pid, kind, startedAt: new Date().toISOString() }
  const path = recordPath(kind, registryDir)
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify(record), { mode: 0o600 })
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
  return record
}

export async function stopDaemon(kind = 'assistant', registryDir?: string): Promise<boolean> {
  const record = await readRecord(kind, registryDir)
  if (!record) return false
  await unlink(recordPath(kind, registryDir)).catch(() => {})
  if (!isAlive(record.pid)) return false
  process.kill(record.pid, 'SIGTERM')
  return true
}

async function runForeground(kind: string): Promise<void> {
  const script = process.argv[1]
  if (!script) throw new Error('Cannot locate the CLI entrypoint')
  const supervisor = new DaemonSupervisor({
    spawn: workerKind =>
      spawn(process.execPath, [script, '--daemon-worker', workerKind], {
        stdio: 'inherit',
        env: process.env,
      }),
  })
  const stop = () => supervisor.stop()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    process.exitCode = await supervisor.run(kind)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

export async function daemonMain(args: string[]): Promise<void> {
  const [command = 'status', kind = 'assistant'] = args
  switch (command) {
    case 'start': {
      const record = await startDaemon(kind)
      console.log(`Daemon ${kind} supervisor running (pid ${record.pid})`)
      return
    }
    case 'run':
      await runForeground(kind)
      return
    case 'stop': {
      const signalled = await stopDaemon(kind)
      console.log(signalled ? `Daemon ${kind} stopped` : `Daemon ${kind} is not running`)
      return
    }
    case 'status':
      console.log(JSON.stringify(await getDaemonStatus(kind)))
      return
    default:
      throw new Error('Usage: daemon [start|run|stop|status] [assistant|remote-control]')
  }
}
