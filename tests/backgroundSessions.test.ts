import '../src/runtimeMacros.ts'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  authorizeSession,
  killBackgroundSession,
  launchBackgroundSession,
  listBackgroundSessions,
  logsHandler,
} from '../src/cli/bg.ts'
import { hasBackgroundFlag, stripBackgroundFlags } from '../src/cli/bgArgs.ts'
import {
  type BackgroundSessionRecord,
  readSessionRegistry,
  writeSessionRegistryRecord,
} from '../src/utils/concurrentSessions.ts'
import { getProcessStartToken } from '../src/utils/processIdentity.ts'
import { execTmux } from '../src/utils/tmuxSocket.ts'
import { startUdsMessaging, stopUdsMessaging } from '../src/utils/udsMessaging.ts'

let temp: string
let configDir: string
let workspace: string
let previousConfig: string | undefined
let launched: BackgroundSessionRecord[]

beforeEach(async () => {
  temp = await mkdtemp('/tmp/background-sessions-test-')
  configDir = join(temp, 'config')
  workspace = join(temp, 'workspace')
  await mkdir(workspace, { recursive: true })
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  launched = []
})

afterEach(async () => {
  for (const record of launched.reverse()) {
    try {
      await killBackgroundSession(record.sessionId, { stopTimeoutMs: 100 })
    } catch {
      await execTmux(['-L', record.tmuxSocket, 'kill-session', '-t', record.tmuxSession])
    }
  }
  launched = []
  await stopUdsMessaging()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  process.exitCode = 0
  await rm(temp, { recursive: true, force: true })
})

async function fakeChild(ignoreTerm = false): Promise<string> {
  const script = join(temp, ignoreTerm ? 'stubborn.cjs' : 'child.cjs')
  await writeFile(
    script,
    `let n = 0; setInterval(() => console.log('fake-child ' + (++n)), 50);\n` +
      (ignoreTerm
        ? `process.on('SIGTERM', () => console.log('ignored-term'));\n`
        : `process.on('SIGTERM', () => { console.log('term'); process.exit(0); });\n`) +
      `process.stdin.resume();\n`,
  )
  return script
}

async function launchFake(ignoreTerm = false, extra: string[] = []) {
  const script = await fakeChild(ignoreTerm)
  const record = await launchBackgroundSession(
    ['--bg', '--session-id', crypto.randomUUID(), ...extra],
    {
      executable: process.execPath,
      executableArgs: [script],
      cwd: workspace,
      waitForRegistration: false,
    },
  )
  launched.push(record)
  return record
}

test('background flags preserve option values and text after --', () => {
  const parsed = stripBackgroundFlags([
    '--bg', '--session-id', '--background', '--prompt', '--bg', '--', '--background',
  ])
  expect(parsed.background).toBe(true)
  expect(parsed.args).toEqual([
    '--session-id', '--background', '--prompt', '--bg', '--', '--background',
  ])
  expect(hasBackgroundFlag(['--', '--bg'])).toBe(false)
  expect(hasBackgroundFlag(['--prompt', '--bg'])).toBe(false)
  expect(hasBackgroundFlag(['--model', 'sonnet', '--background'])).toBe(true)
  expect(hasBackgroundFlag(['--print', '--bg'])).toBe(true)
})

test('registry ignores non-PID files and writes private atomic records', async () => {
  await mkdir(join(configDir, 'sessions'), { recursive: true })
  await writeFile(join(configDir, 'sessions', '2026-notes.md'), '{}')
  const token = await getProcessStartToken(process.pid)
  await writeSessionRegistryRecord({
    pid: process.pid,
    sessionId: crypto.randomUUID(),
    cwd: workspace,
    startedAt: Date.now(),
    kind: 'interactive',
    processStartToken: token,
  })
  const records = await readSessionRegistry()
  expect(records).toHaveLength(1)
  expect(records[0].pid).toBe(process.pid)
  expect((await stat(join(configDir, 'sessions', `${process.pid}.json`))).mode & 0o777).toBe(0o600)
  expect((await stat(join(configDir, 'sessions'))).mode & 0o777).toBe(0o700)
})

test('PID token mismatch fails closed before attach or kill authorization', async () => {
  await mkdir(join(configDir, 'session-logs'), { recursive: true })
  await writeFile(join(configDir, 'session-logs', 'x.log'), '')
  const record = {
    version: 'background-sessions-v1', launchId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(), pid: process.pid, processStartToken: 'wrong',
    argsHash: 'x', cwd: workspace, startedAt: Date.now(), kind: 'bg', entrypoint: 'cli',
    logPath: join(configDir, 'session-logs', 'x.log'), status: 'idle', updatedAt: Date.now(),
    lifecycle: 'running', tmuxSocket: 'wrong', tmuxSocketPath: '/tmp/tmux-0/wrong',
    tmuxSession: 'wrong', tmuxServerPid: 1, tmuxPanePid: process.pid,
    ownerUid: process.getuid?.() ?? 0,
  } as BackgroundSessionRecord
  await expect(authorizeSession(record, 'kill')).rejects.toMatchObject({
    code: 'PID_IDENTITY_MISMATCH',
  })
})

test('non-interactive and tmux mode conflicts do not fall through to foreground', async () => {
  await expect(launchBackgroundSession(['--bg', '--print'])).rejects.toMatchObject({
    code: 'BG_MODE_CONFLICT',
  })
  await expect(launchBackgroundSession(['--prompt', '--bg'])).rejects.toMatchObject({
    code: 'BG_MODE_CONFLICT',
  })
})

test('spawn failure cleans the tmux session, registry and log in reverse order', async () => {
  const sessionId = crypto.randomUUID()
  await expect(launchBackgroundSession(['--bg', '--session-id', sessionId], {
    executable: join(temp, 'missing-executable'),
    executableArgs: [],
    cwd: workspace,
    waitForRegistration: false,
  })).rejects.toBeInstanceOf(Error)
  const socket = `claude-bg-${process.getuid?.() ?? 0}-${sessionId.slice(0, 8)}`
  const tmuxSession = `bg-${sessionId.slice(0, 8)}`
  expect((await execTmux(['-L', socket, 'has-session', '-t', tmuxSession])).code).not.toBe(0)
  expect((await readSessionRegistry()).some(record => record.sessionId === sessionId)).toBe(false)
  await expect(stat(join(configDir, 'session-logs', `${sessionId}.log`))).rejects.toThrow()
})

test('real tmux supports discovery, idempotent launch, logs, identity checks and idempotent kill', async () => {
  const record = await launchFake(false, ['--name', 'value with spaces'])
  expect(record.tmuxSocket).toContain(record.sessionId.slice(0, 8))
  expect(record.tmuxPanePid).toBe(record.pid)
  expect((await stat(record.logPath)).mode & 0o777).toBe(0o600)
  const authorized = await authorizeSession(record, 'attach')
  expect(authorized.state).toBe('live')
  expect(authorized.attachedClients).toBe(0)

  const same = await launchBackgroundSession(
    ['--background', '--session-id', record.sessionId, '--name', 'value with spaces'],
    {
      executable: process.execPath,
      executableArgs: [await fakeChild()],
      cwd: workspace,
      waitForRegistration: false,
    },
  )
  expect(same.pid).toBe(record.pid)
  await expect(launchBackgroundSession(
    ['--bg', '--session-id', record.sessionId, '--name', 'different'],
    {
      executable: process.execPath,
      executableArgs: [await fakeChild()],
      cwd: workspace,
      waitForRegistration: false,
    },
  )).rejects.toMatchObject({ code: 'SESSION_CONFLICT' })

  await new Promise(resolve => setTimeout(resolve, 250))
  const sessions = await listBackgroundSessions()
  expect(sessions.some(session => session.session_id === record.sessionId)).toBe(true)
  const logs = await readFile(record.logPath, 'utf8')
  expect(logs).toContain('fake-child')

  const paneMismatch = {
    ...record,
    pid: process.pid,
    tmuxPanePid: process.pid,
    processStartToken: await getProcessStartToken(process.pid),
  }
  await expect(authorizeSession(paneMismatch, 'kill')).rejects.toMatchObject({
    code: 'SESSION_IDENTITY_CONFLICT',
  })

  expect((await killBackgroundSession(record.sessionId, { stopTimeoutMs: 500 })).state).toBe('stopped')
  expect((await killBackgroundSession(record.sessionId)).state).toBe('already_stopped')
  expect((await execTmux(['-L', record.tmuxSocket, 'has-session', '-t', record.tmuxSession])).code).not.toBe(0)
  expect(await readFile(record.logPath, 'utf8')).toContain('fake-child')
}, 20_000)

test('wrong UDS identity is a conflict rather than a stale-session cleanup', async () => {
  const record = await launchFake()
  const socket = join(temp, 'wrong.sock')
  await startUdsMessaging(socket, { isExplicit: true, registryDir: join(temp, 'uds') })
  await expect(authorizeSession({ ...record, messagingSocketPath: socket }, 'kill')).rejects.toMatchObject({
    code: 'SESSION_IDENTITY_CONFLICT',
  })
  expect((await authorizeSession(record, 'ps')).state).toBe('live')
})

test('SIGTERM timeout rechecks identity before SIGKILL and leaves a readable tombstone', async () => {
  const record = await launchFake(true)
  const result = await killBackgroundSession(record.sessionId, { stopTimeoutMs: 100 })
  expect(result.state).toBe('stopped')
  expect((await killBackgroundSession(record.sessionId)).state).toBe('already_stopped')
  const tombstone = JSON.parse(await readFile(join(configDir, 'session-tombstones', `${record.sessionId}.json`), 'utf8'))
  expect(tombstone.exit.reason).toBe('killed')
}, 20_000)

test('logs retain order and truncate large output without changing permissions', async () => {
  const record = await launchFake()
  const lines = Array.from({ length: 250 }, (_, index) => `line-${index}`).join('\n') + '\n'
  await writeFile(record.logPath, lines, { mode: 0o600 })
  let output = ''
  let warning = ''
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warning += chunk.toString()
    return true
  }) as typeof process.stderr.write
  try {
    await logsHandler(record.sessionId)
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
  expect(output).toContain('line-249')
  expect(output).not.toContain('line-0\n')
  expect(output.indexOf('line-200')).toBeLessThan(output.indexOf('line-249'))
  expect(warning).toContain('truncated')
  expect((await stat(record.logPath)).mode & 0o777).toBe(0o600)
})
