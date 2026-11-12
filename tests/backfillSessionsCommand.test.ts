import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import backfillSessions from '../src/commands/backfill-sessions/index.ts'
import {
  backfillSessionMetadata,
  runBackfillSessions,
  type BackfillDependencies,
} from '../src/commands/backfill-sessions/backfill-sessions.ts'
import {
  getSessionMetaDir,
  loadCachedSessionMeta,
  logToSessionMeta,
  saveSessionMeta,
} from '../src/commands/insights/sessionMeta.ts'
import type { LogOption } from '../src/types/logs.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

function makeLog(sessionId: string, userMessages = 1): LogOption {
  return {
    date: '2026-01-01T00:00:00.000Z',
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date('2026-01-01T00:01:00.000Z'),
    messages: Array.from({ length: userMessages }, () => ({
      type: 'user', sessionId, cwd: '/tmp', userType: 'external', timestamp: '2026-01-01T00:00:00.000Z', version: '1',
      uuid: randomUUID(), message: { role: 'user', content: 'local test' },
    })) as LogOption['messages'],
    value: 0,
    firstPrompt: 'local test',
    messageCount: userMessages,
    isSidechain: false,
    sessionId,
    projectPath: '/tmp/project',
  }
}

function depsFor(ids: string[]) {
  const cached = new Map<string, ReturnType<typeof logToSessionMeta>>()
  const saves = mock(async (meta: ReturnType<typeof logToSessionMeta>) => {
    cached.set(meta.session_id, meta)
  })
  const lock = mock(<T>(fn: () => Promise<T>) => fn())
  const logs = new Map(ids.map(id => [id, [makeLog(id, 1), makeLog(id, 2)]]))
  const deps: BackfillDependencies = {
    listSessions: async () => new Map(ids.map(id => [id, { path: `/tmp/${id}.jsonl`, mtime: 1, ctime: 1, size: 1 }])),
    loadCachedSessionMeta: async id => cached.get(id) ?? null,
    loadAllLogsFromSessionFile: async path => {
      const id = ids.find(candidate => path.includes(candidate))!
      const result = logs.get(id)
      if (!result) throw new Error('corrupt transcript')
      return result
    },
    saveSessionMeta: saves,
    withLock: lock,
  }
  return { deps, cached, saves, lock, logs }
}

const originalConfig = process.env.CLAUDE_CONFIG_DIR
afterEach(() => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  spyOn(globalThis, 'fetch').mockRestore()
})

describe('/backfill-sessions', () => {
  test('registers a non-interactive local command with lazy usage handling', async () => {
    expect(backfillSessions.name).toBe('backfill-sessions')
    expect(backfillSessions.supportsNonInteractive).toBe(true)
    expect(backfillSessions.isHidden).not.toBe(true)
    const { call } = await backfillSessions.load()
    const result = await call('--unknown', {} as LocalJSXCommandContext)
    expect(result.type).toBe('text')
    if (result.type === 'text') expect(result.value).toContain('Usage:')
  })

  test('rebuilds missing/corrupt metadata, preserves valid entries, and deduplicates branches', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const { deps, cached, saves, lock, logs } = depsFor(ids)
    cached.set(ids[0]!, logToSessionMeta(makeLog(ids[0]!)))
    logs.delete(ids[2]!)
    const report = await backfillSessionMetadata({ dryRun: false, force: false }, deps)
    expect(report.valid).toBe(1)
    expect(report.rebuilt).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.duplicates).toBe(1)
    expect(saves).toHaveBeenCalledTimes(1)
    expect(cached.get(ids[1]!)?.user_message_count).toBe(2)
    expect(lock).toHaveBeenCalledTimes(1)
  })

  test('dry-run performs no writes or lock and force rebuilds valid metadata', async () => {
    const id = randomUUID()
    const { deps, cached, saves, lock } = depsFor([id])
    cached.set(id, logToSessionMeta(makeLog(id)))
    const dry = await backfillSessionMetadata({ dryRun: true, force: false }, deps)
    expect(dry.valid).toBe(1)
    expect(saves).not.toHaveBeenCalled()
    expect(lock).not.toHaveBeenCalled()
    const forced = await backfillSessionMetadata({ dryRun: false, force: true }, deps)
    expect(forced.rebuilt).toBe(1)
    expect(saves).toHaveBeenCalledTimes(1)
    expect(await runBackfillSessions('--dry-run --dry-run', deps)).toContain('Usage:')
  })

  test('atomic cache writes use 0600, tolerate concurrent rebuilds, and reject corrupt JSON', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
    const dir = await mkdtemp(join(tmpdir(), 'claude-backfill-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    try {
      const id = randomUUID()
      const meta = logToSessionMeta(makeLog(id))
      await Promise.all(Array.from({ length: 5 }, () => saveSessionMeta(meta)))
      const path = join(getSessionMetaDir(), `${id}.json`)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await loadCachedSessionMeta(id)).toEqual(meta)
      expect((await readdir(getSessionMetaDir())).filter(name => name.endsWith('.tmp'))).toHaveLength(0)
      await writeFile(path, '{broken')
      expect(await loadCachedSessionMeta(id)).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
