import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  tagSession,
} from '../src/entrypoints/agentSdkTypes.ts'
import { loadSdkSessionTranscript } from '../src/utils/sdkSessions.ts'
import {
  canonicalizePath,
  getProjectDir,
  sanitizePath,
} from '../src/utils/sessionStoragePortable.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let tempDir: string
let projectDir: string
let sessionId: string
let sessionPath: string

beforeAll(async () => {
  tempDir = await mkdtemp(join('/tmp', 'claude-sdk-sessions-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  projectDir = join(tempDir, 'project')
  await mkdir(projectDir, { recursive: true })
  projectDir = await canonicalizePath(projectDir)
  sessionId = randomUUID()
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const entries = [
    {
      type: 'user',
      uuid: ids[0],
      parentUuid: null,
      sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'hello session' },
    },
    {
      type: 'assistant',
      uuid: ids[1],
      parentUuid: ids[0],
      sessionId,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        id: 'msg-1',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'hello back' }],
      },
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: ids[2],
      parentUuid: ids[1],
      sessionId,
      timestamp: '2026-01-01T00:00:02.000Z',
      compactMetadata: { trigger: 'manual', preTokens: 100 },
    },
    {
      type: 'user',
      uuid: ids[3],
      parentUuid: ids[2],
      sessionId,
      timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'user', content: 'after compact' },
    },
    {
      type: 'content-replacement',
      sessionId,
      replacements: [],
    },
  ]
  sessionPath = join(
    getProjectDir(projectDir),
    `${sessionId}.jsonl`,
  )
  await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
  await writeFile(
    sessionPath,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    { mode: 0o600 },
  )
})

afterAll(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  await rm(tempDir, { recursive: true, force: true })
})

describe('SDK session storage', () => {
  test('lists, reads, mutates, and forks sessions without CLI state', async () => {
    expect(sanitizePath(projectDir)).not.toBe('')
    const sessions = await listSessions({ dir: projectDir })
    expect(sessions.map(session => session.sessionId)).toContain(sessionId)

    expect((await getSessionInfo(sessionId, { dir: projectDir }))?.summary).toBe(
      'hello session',
    )
    expect(
      (await getSessionMessages(sessionId, { dir: projectDir })).map(
        message => message.type,
      ),
    ).toEqual(['user', 'assistant', 'user'])
    expect(
      await getSessionMessages(sessionId, {
        dir: projectDir,
        includeSystemMessages: true,
      }),
    ).toHaveLength(4)
    expect(
      await getSessionMessages(sessionId, { dir: projectDir, offset: 1, limit: 1 }),
    ).toHaveLength(1)

    await renameSession(sessionId, 'Renamed session', { dir: projectDir })
    await tagSession(sessionId, 'test-tag', { dir: projectDir })
    const renamed = await getSessionInfo(sessionId, { dir: projectDir })
    expect(renamed?.customTitle).toBe('Renamed session')
    expect(renamed?.tag).toBe('test-tag')

    const { sessionId: forkId } = await forkSession(sessionId, {
      dir: projectDir,
      title: 'Forked session',
    })
    expect(forkId).not.toBe(sessionId)
    expect((await getSessionInfo(forkId, { dir: projectDir }))?.summary).toBe(
      'Forked session',
    )
    expect(
      await getSessionMessages(forkId, {
        dir: projectDir,
        includeSystemMessages: true,
      }),
    ).toHaveLength(4)

    const originalEntries = (await readFile(sessionPath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const forkEntries = (await readFile(
      join(getProjectDir(projectDir), `${forkId}.jsonl`),
      'utf8',
    ))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const originalMessages = originalEntries.filter(entry => entry.uuid)
    const forkMessages = forkEntries.filter(entry => entry.uuid)
    expect(forkMessages.map(entry => entry.uuid)).not.toEqual(
      originalMessages.map(entry => entry.uuid),
    )
    expect(new Set(forkMessages.map(entry => entry.uuid)).size).toBe(
      forkMessages.length,
    )
    expect(forkMessages[0].parentUuid).toBeNull()
    expect(forkMessages[1].parentUuid).toBe(forkMessages[0].uuid)
    expect(forkMessages.every(entry => entry.sessionId === forkId)).toBe(true)
    expect(
      forkEntries.some(entry => entry.type === 'content-replacement'),
    ).toBe(true)

    await tagSession(sessionId, null, { dir: projectDir })
    expect((await getSessionInfo(sessionId, { dir: projectDir }))?.tag).toBeUndefined()
    await expect(
      renameSession(sessionId, ' ', { dir: projectDir }),
    ).rejects.toThrow('Session title must not be empty')
  })

  test('recovers parallel assistant branches before SDK conversion and pagination', async () => {
    const parallelSessionId = randomUUID()
    const ids = Array.from({ length: 6 }, () => randomUUID())
    const [root, assistantA, assistantB, resultA, resultB, next] = ids
    const entries = [
      {
        type: 'user',
        uuid: root,
        parentUuid: null,
        sessionId: parallelSessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'run both tools' },
      },
      {
        type: 'assistant',
        uuid: assistantA,
        parentUuid: root,
        sessionId: parallelSessionId,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          id: 'msg-parallel',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-a', name: 'A', input: {} }],
        },
      },
      {
        type: 'assistant',
        uuid: assistantB,
        parentUuid: assistantA,
        sessionId: parallelSessionId,
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          id: 'msg-parallel',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-b', name: 'B', input: {} }],
        },
      },
      {
        type: 'user',
        uuid: resultA,
        parentUuid: assistantA,
        sourceToolAssistantUUID: assistantA,
        sessionId: parallelSessionId,
        timestamp: '2026-01-01T00:00:03.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'a' }],
        },
      },
      {
        type: 'user',
        uuid: resultB,
        parentUuid: assistantB,
        sourceToolAssistantUUID: assistantB,
        sessionId: parallelSessionId,
        timestamp: '2026-01-01T00:00:04.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-b', content: 'b' }],
        },
      },
      {
        type: 'user',
        uuid: next,
        parentUuid: resultA,
        sessionId: parallelSessionId,
        timestamp: '2026-01-01T00:00:05.000Z',
        message: { role: 'user', content: 'continue' },
      },
    ]
    await writeFile(
      join(getProjectDir(projectDir), `${parallelSessionId}.jsonl`),
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
      { mode: 0o600 },
    )

    const expected = [root, assistantA, assistantB, resultB, resultA, next]
    const messages = await getSessionMessages(parallelSessionId, {
      dir: projectDir,
    })
    expect(messages.map(message => message.uuid)).toEqual(expected)
    expect(new Set(messages.map(message => message.uuid)).size).toBe(6)

    const transcript = await loadSdkSessionTranscript(parallelSessionId, {
      dir: projectDir,
    })
    expect(transcript.map(message => message.uuid)).toEqual(expected)

    expect(
      (
        await getSessionMessages(parallelSessionId, {
          dir: projectDir,
          offset: 1,
          limit: 3,
        })
      ).map(message => message.uuid),
    ).toEqual([assistantA, assistantB, resultB])
    expect(
      (
        await getSessionMessages(parallelSessionId, {
          dir: projectDir,
          offset: 4,
        })
      ).map(message => message.uuid),
    ).toEqual([resultA, next])
  })

  test('does not recover unrelated branches across a missing parent', async () => {
    const brokenSessionId = randomUUID()
    const orphanAssistant = randomUUID()
    const orphanResult = randomUUID()
    const leaf = randomUUID()
    const entries = [
      {
        type: 'assistant',
        uuid: orphanAssistant,
        parentUuid: randomUUID(),
        sessionId: brokenSessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          id: 'msg-unrelated',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'orphan', name: 'A', input: {} }],
        },
      },
      {
        type: 'user',
        uuid: orphanResult,
        parentUuid: orphanAssistant,
        sessionId: brokenSessionId,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x' }],
        },
      },
      {
        type: 'user',
        uuid: leaf,
        parentUuid: randomUUID(),
        sessionId: brokenSessionId,
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: 'only reachable leaf' },
      },
    ]
    await writeFile(
      join(getProjectDir(projectDir), `${brokenSessionId}.jsonl`),
      `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
      { mode: 0o600 },
    )

    expect(
      (await getSessionMessages(brokenSessionId, { dir: projectDir })).map(
        message => message.uuid,
      ),
    ).toEqual([leaf])
  })
})
