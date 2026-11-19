import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getInboxPath,
  readMailbox,
  writeToMailbox,
} from '../src/utils/teammateMailbox.ts'

const TEAM = 'mailbox-concurrency'
const RECIPIENT = 'worker'
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let tempRoot = ''
const children = new Set<Bun.Subprocess>()

function childEnv(): Record<string, string> {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(tempRoot, 'config'),
  }
}

async function spawnScript(script: string): Promise<Bun.Subprocess> {
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', script],
    cwd: process.cwd(),
    env: childEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.add(child)
  return child
}

async function exitSuccess(child: Bun.Subprocess): Promise<void> {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  children.delete(child)
  expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 })
}

function writeScript(workerId: number, count: number): string {
  return `
    import { writeToMailbox } from './src/utils/teammateMailbox.ts'
    for (let index = 0; index < ${count}; index++) {
      await writeToMailbox(${JSON.stringify(RECIPIENT)}, {
        from: 'child-${workerId}',
        text: 'message-${workerId}-' + index,
        timestamp: '2026-01-01T00:00:${String(workerId).padStart(2, '0')}Z',
      }, ${JSON.stringify(TEAM)})
    }
  `
}

function markScript(indices: number[]): string {
  return `
    import { markMessageAsReadByIndex } from './src/utils/teammateMailbox.ts'
    for (const index of ${JSON.stringify(indices)}) {
      await markMessageAsReadByIndex(${JSON.stringify(RECIPIENT)}, ${JSON.stringify(TEAM)}, index)
    }
  `
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'mailbox-concurrency-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
})

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL')
    await child.exited
  }
  children.clear()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(tempRoot, { recursive: true, force: true })
  tempRoot = ''
})

describe('mailbox real multi-process locking', () => {
  test('preserves every concurrent append as valid unique JSON messages', async () => {
    const writers = Array.from({ length: 6 }, (_, index) =>
      spawnScript(writeScript(index, 6)),
    )
    const started = await Promise.all(writers)
    await Promise.all(started.map(exitSuccess))

    const messages = await readMailbox(RECIPIENT, TEAM)
    expect(messages).toHaveLength(36)
    expect(new Set(messages.map(message => message.text)).size).toBe(36)
    expect(messages.every(message => message.read === false)).toBe(true)
    expect(messages.every(message => /^child-[0-5]$/.test(message.from))).toBe(true)
    expect(JSON.parse(await readFile(getInboxPath(RECIPIENT, TEAM), 'utf8'))).toHaveLength(36)
    expect(existsSync(`${getInboxPath(RECIPIENT, TEAM)}.lock`)).toBe(false)
  })

  test('marks disjoint indexes concurrently without losing message content', async () => {
    for (let index = 0; index < 12; index++) {
      await writeToMailbox(RECIPIENT, {
        from: 'parent',
        text: `message-${index}`,
        timestamp: '2026-01-01T00:00:00Z',
      }, TEAM)
    }
    const first = await spawnScript(markScript([0, 1, 2, 3, 4, 5]))
    const second = await spawnScript(markScript([6, 7, 8, 9, 10, 11]))
    await Promise.all([exitSuccess(first), exitSuccess(second)])

    const messages = await readMailbox(RECIPIENT, TEAM)
    expect(messages).toHaveLength(12)
    expect(messages.every(message => message.read)).toBe(true)
    expect(messages.map(message => message.text).sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `message-${index}`).sort(),
    )
    expect(existsSync(`${getInboxPath(RECIPIENT, TEAM)}.lock`)).toBe(false)
  })

  test('retries while another process holds the inbox lock', async () => {
    await writeToMailbox(RECIPIENT, {
      from: 'parent',
      text: 'initial',
      timestamp: '2026-01-01T00:00:00Z',
    }, TEAM)
    const inbox = getInboxPath(RECIPIENT, TEAM)
    const lockedMarker = join(tempRoot, 'lock-acquired')
    const holder = await spawnScript(`
      import lockfile from 'proper-lockfile'
      import { writeFile } from 'fs/promises'
      const release = await lockfile.lock(${JSON.stringify(inbox)}, {
        lockfilePath: ${JSON.stringify(`${inbox}.lock`)},
        retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
      })
      await writeFile(${JSON.stringify(lockedMarker)}, 'locked')
      await new Promise(resolve => setTimeout(resolve, 350))
      await release()
    `)
    const deadline = Date.now() + 2000
    while (!existsSync(lockedMarker) && Date.now() < deadline) {
      await Bun.sleep(10)
    }
    expect(existsSync(lockedMarker)).toBe(true)

    const writers = await Promise.all(
      Array.from({ length: 4 }, (_, index) => spawnScript(writeScript(index + 10, 3))),
    )
    await Promise.all([...writers.map(exitSuccess), exitSuccess(holder)])

    const messages = await readMailbox(RECIPIENT, TEAM)
    expect(messages).toHaveLength(13)
    expect(new Set(messages.map(message => message.text)).size).toBe(13)
    expect(messages[0]?.text).toBe('initial')
    expect(existsSync(`${inbox}.lock`)).toBe(false)
  })

  test('recovers an unparseable inbox by writing a valid new message list', async () => {
    const inbox = getInboxPath(RECIPIENT, TEAM)
    await mkdir(dirname(inbox), { recursive: true })
    await writeFile(inbox, '{not-json', { flag: 'wx' })

    await writeToMailbox(RECIPIENT, {
      from: 'recovery',
      text: 'after-corruption',
      timestamp: '2026-01-01T00:00:00Z',
    }, TEAM)

    expect(await readMailbox(RECIPIENT, TEAM)).toEqual([
      {
        from: 'recovery',
        text: 'after-corruption',
        timestamp: '2026-01-01T00:00:00Z',
        read: false,
      },
    ])
    expect(JSON.parse(await readFile(inbox, 'utf8'))).toHaveLength(1)
  })
})
