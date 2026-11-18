import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setOriginalCwd,
  switchSession,
} from '../src/bootstrap/state.ts'
import {
  backfillSessionMetadata,
} from '../src/commands/backfill-sessions/backfill-sessions.ts'
import { loadCachedSessionMeta } from '../src/commands/insights/sessionMeta.ts'
import type { LogOption } from '../src/types/logs.ts'
import type { SessionId } from '../src/types/ids.ts'
import {
  countConcurrentSessions,
  deleteSessionRegistryRecord,
  getSessionRegistryDir,
  getSessionTombstoneDir,
  readSessionRegistry,
  registerSession,
  updateSessionBridgeId,
  updateSessionName,
  writeSessionRegistryRecord,
  writeSessionTombstone,
} from '../src/utils/concurrentSessions.ts'
import { checkCrossProjectResume } from '../src/utils/crossProjectResume.ts'
import { parseSessionInfoFromLite } from '../src/utils/listSessionsImpl.ts'
import { resetProjectForTesting } from '../src/utils/sessionStorage.ts'
import {
  getProjectsDir,
  readSessionLite,
} from '../src/utils/sessionStoragePortable.ts'

let tempDir: string
let originalConfigDir: string | undefined
let originalUserType: string | undefined
let originalCwd: string

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalUserType = process.env.USER_TYPE
  originalCwd = process.cwd()
  tempDir = await mkdtemp(join(tmpdir(), 'flash-session-search-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  delete process.env.USER_TYPE
  resetStateForTests()
  resetProjectForTesting()
})

afterEach(async () => {
  resetStateForTests()
  resetProjectForTesting()
  process.chdir(originalCwd)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType
  await rm(tempDir, { recursive: true, force: true })
})

function transcriptMessage(
  sessionId: string,
  type: 'user' | 'assistant',
  uuid: string,
  parentUuid: string | null,
  content: string,
) {
  return {
    type,
    sessionId,
    cwd: '/tmp/project',
    userType: 'external',
    timestamp: '2026-01-01T00:00:00.000Z',
    version: '1',
    uuid,
    parentUuid,
    isSidechain: false,
    message: { role: type, content },
  }
}

async function writeTranscript(
  directory: string,
  sessionId: string,
  entries: unknown[],
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${sessionId}.jsonl`)
  await writeFile(
    path,
    entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
    { mode: 0o600 },
  )
  return path
}

describe('session lite recovery', () => {
  test('reads independent head/tail windows and applies title/tag/cwd precedence', async () => {
    const sessionId = randomUUID()
    const path = await writeTranscript(tempDir, sessionId, [
      transcriptMessage(sessionId, 'user', randomUUID(), null, 'first prompt'),
      transcriptMessage(
        sessionId,
        'assistant',
        randomUUID(),
        null,
        'x'.repeat(70 * 1024),
      ),
      { type: 'ai-title', aiTitle: 'AI title', sessionId },
      { type: 'custom-title', customTitle: 'User title', sessionId },
      { type: 'tag', tag: 'tagged', sessionId },
      { type: 'last-prompt', lastPrompt: 'latest prompt', gitBranch: 'feature' },
    ])

    const lite = await readSessionLite(path)
    expect(lite?.size).toBeGreaterThan(64 * 1024)
    const info = parseSessionInfoFromLite(sessionId, lite!, '/fallback/project')
    expect(info).toMatchObject({
      sessionId,
      summary: 'User title',
      customTitle: 'User title',
      firstPrompt: 'first prompt',
      gitBranch: 'feature',
      cwd: '/tmp/project',
      tag: 'tagged',
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    })
  })

  test('rejects sidechain and metadata-only entries without a summary', async () => {
    const sidechainId = randomUUID()
    const sidechainPath = await writeTranscript(tempDir, sidechainId, [
      { ...transcriptMessage(sidechainId, 'user', randomUUID(), null, 'sidechain'), isSidechain: true },
    ])
    const sidechainLite = await readSessionLite(sidechainPath)
    expect(parseSessionInfoFromLite(sidechainId, sidechainLite!)).toBeNull()

    const metadataId = randomUUID()
    const metadataPath = await writeTranscript(tempDir, metadataId, [
      { type: 'mode', mode: 'normal', sessionId: metadataId },
    ])
    const metadataLite = await readSessionLite(metadataPath)
    expect(parseSessionInfoFromLite(metadataId, metadataLite!)).toBeNull()
  })
})

describe('cross-project resume decisions', () => {
  test('generates a quoted cross-project command and recognizes same-repo worktrees', () => {
    setOriginalCwd('/current/project')
    const sessionId = randomUUID()
    const log = {
      sessionId,
      projectPath: '/tmp/other project',
      messages: [],
    } as unknown as LogOption

    expect(checkCrossProjectResume(log, false, [])).toEqual({
      isCrossProject: false,
    })
    expect(checkCrossProjectResume(log, true, [])).toEqual({
      isCrossProject: true,
      isSameRepoWorktree: false,
      command: `cd '/tmp/other project' && claude --resume ${sessionId}`,
      projectPath: '/tmp/other project',
    })

    process.env.USER_TYPE = 'ant'
    expect(
      checkCrossProjectResume(log, true, ['/tmp/other project']),
    ).toEqual({
      isCrossProject: true,
      isSameRepoWorktree: true,
      projectPath: '/tmp/other project',
    })
  })
})

describe('concurrent session registry', () => {
  test('registers, updates on session switch, and prevents stale deletion', async () => {
    const first = randomUUID() as SessionId
    switchSession(first, tempDir)
    await expect(registerSession()).resolves.toBe(true)
    expect(await countConcurrentSessions()).toBe(1)

    const registryPath = join(getSessionRegistryDir(), `${process.pid}.json`)
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600)
    expect((await stat(getSessionRegistryDir())).mode & 0o777).toBe(0o700)

    await updateSessionName('offline session')
    await updateSessionBridgeId('bridge-offline')
    const second = randomUUID() as SessionId
    switchSession(second, tempDir)
    const deadline = Date.now() + 2000
    let record = (await readSessionRegistry()).find(
      entry => entry.pid === process.pid,
    )
    while (record?.sessionId !== second && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      record = (await readSessionRegistry()).find(
        entry => entry.pid === process.pid,
      )
    }
    expect(record).toMatchObject({
      sessionId: second,
      name: 'offline session',
      bridgeSessionId: 'bridge-offline',
      kind: 'interactive',
    })

    expect(
      await deleteSessionRegistryRecord({
        pid: process.pid,
        sessionId: first,
        cwd: tempDir,
        startedAt: 1,
        kind: 'interactive',
      }),
    ).toBe(false)
    expect(
      await deleteSessionRegistryRecord({
        pid: process.pid,
        sessionId: second,
        cwd: tempDir,
        startedAt: 1,
        kind: 'interactive',
      }),
    ).toBe(true)
  })

  test('filters corrupt/symlink records and writes only background tombstones', async () => {
    const valid = {
      pid: 999999,
      sessionId: randomUUID(),
      cwd: tempDir,
      startedAt: 1,
      kind: 'interactive' as const,
    }
    await writeSessionRegistryRecord(valid)
    await writeFile(join(getSessionRegistryDir(), 'broken.json'), '{broken')
    await writeFile(join(getSessionRegistryDir(), '12345.json'), '{broken')
    await symlink(
      join(getSessionRegistryDir(), '999999.json'),
      join(getSessionRegistryDir(), '12346.json'),
    )

    const records = await readSessionRegistry()
    expect(records.map(record => record.pid)).toEqual([999999])
    expect(await countConcurrentSessions()).toBe(0)

    await writeSessionTombstone(valid)
    const interactiveTombstone = join(
      getSessionTombstoneDir(),
      `${valid.sessionId}.json`,
    )
    await expect(stat(interactiveTombstone)).rejects.toThrow()

    const background = { ...valid, kind: 'bg' as const }
    await writeSessionTombstone(background)
    const tombstone = JSON.parse(
      await readFile(
        join(getSessionTombstoneDir(), `${background.sessionId}.json`),
        'utf8',
      ),
    )
    expect(tombstone).toMatchObject(background)
  })
})

describe('default backfill integration', () => {
  test('rebuilds real multi-project metadata and preserves it on the second run', async () => {
    const projectsDir = getProjectsDir()
    const first = randomUUID()
    const second = randomUUID()
    const corrupt = randomUUID()
    const firstUser = transcriptMessage(first, 'user', randomUUID(), null, 'first')
    const secondUser = transcriptMessage(first, 'user', randomUUID(), firstUser.uuid, 'second')
    const firstAssistant = transcriptMessage(
      first,
      'assistant',
      randomUUID(),
      secondUser.uuid,
      'answer',
    )
    await writeTranscript(join(projectsDir, 'project-a'), first, [
      firstUser,
      secondUser,
      firstAssistant,
    ])
    await writeTranscript(join(projectsDir, 'project-b'), second, [
      transcriptMessage(second, 'user', randomUUID(), null, 'other project'),
    ])
    await writeTranscript(join(projectsDir, 'project-c'), corrupt, [
      transcriptMessage(corrupt, 'user', randomUUID(), null, 'valid prefix'),
    ])
    await writeFile(join(projectsDir, 'project-c', `${corrupt}.jsonl`), '{broken')

    const report = await backfillSessionMetadata({ dryRun: false, force: false })
    expect(report).toMatchObject({
      scanned: 3,
      valid: 0,
      rebuilt: 2,
      wouldRebuild: 0,
      failed: 1,
      dryRun: false,
    })
    expect((await loadCachedSessionMeta(first))?.user_message_count).toBe(2)
    expect((await loadCachedSessionMeta(second))?.user_message_count).toBe(1)
    expect(await loadCachedSessionMeta(corrupt)).toBeNull()

    const secondRun = await backfillSessionMetadata({
      dryRun: false,
      force: false,
    })
    expect(secondRun).toMatchObject({ valid: 2, rebuilt: 0, failed: 1 })
  })
})
