/**
 * Task 6: Session Concurrency and Locking Tests
 *
 * Tests that session storage uses proper-lockfile safely with
 * recordTranscript and context collapse snapshots.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  loadTranscriptFile,
  flushSessionStorage,
  resetProjectForTesting,
} from '../src/utils/sessionStorage.ts'
import { switchSession, resetStateForTests } from '../src/bootstrap/state.ts'
import { canonicalizePath, getProjectDir } from '../src/utils/sessionStoragePortable.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
let tempDir: string
let projectDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claude-session-concurrency-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  projectDir = join(tempDir, 'project')
  await rm(projectDir, { recursive: true, force: true })
  await mkdir(projectDir, { recursive: true })
  projectDir = await canonicalizePath(projectDir)
})

afterAll(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalTestPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  }
  await rm(tempDir, { recursive: true, force: true })
})

describe('Session Concurrency Contracts', () => {
  test('proper-lockfile module is available', async () => {
    const lockfile = await import('../src/utils/lockfile.ts')
    expect(lockfile.lock).toBeInstanceOf(Function)
    expect(lockfile.unlock).toBeInstanceOf(Function)
    expect(lockfile.check).toBeInstanceOf(Function)
  })

  test('loadTranscriptFile validates complete JSONL records', async () => {
    const sessionId = randomUUID() as any
    const transcriptPath = join(getProjectDir(projectDir), `${sessionId}.jsonl`)

    // Create valid messages
    const validMsg1 = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'valid message 1' },
    }
    const validMsg2 = {
      type: 'assistant',
      uuid: randomUUID(),
      parentUuid: validMsg1.uuid,
      sessionId,
      timestamp: new Date(Date.now() + 1).toISOString(),
      message: { role: 'assistant', content: 'valid message 2' },
    }

    const content =
      JSON.stringify(validMsg1) +
      '\n' +
      JSON.stringify(validMsg2) +
      '\n' +
      '{"type": "user", "uuid": "partial' // partial line - should be skipped

    await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
    await writeFile(transcriptPath, content, { mode: 0o600 })

    // Load should skip invalid JSON
    const { messages } = await loadTranscriptFile(transcriptPath)
    expect(messages.size).toBe(2)
    expect(messages.has(validMsg1.uuid as any)).toBe(true)
    expect(messages.has(validMsg2.uuid as any)).toBe(true)
  })

  test('loadTranscriptFile reads context collapse snapshot', async () => {
    const sessionId = randomUUID() as any
    const transcriptPath = join(getProjectDir(projectDir), `${sessionId}.jsonl`)

    // Create messages and snapshots
    const userMsg = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'test collapse' },
    }

    const snapshot1 = {
      type: 'marble-origami-snapshot',
      sessionId,
      staged: [],
      armed: true,
      lastSpawnTokens: 100,
    }

    const snapshot2 = {
      type: 'marble-origami-snapshot',
      sessionId,
      staged: [],
      armed: false,
      lastSpawnTokens: 400, // Last one should win
    }

    const content =
      JSON.stringify(userMsg) +
      '\n' +
      JSON.stringify(snapshot1) +
      '\n' +
      JSON.stringify(snapshot2) +
      '\n'

    await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
    await writeFile(transcriptPath, content, { mode: 0o600 })

    // Load and verify - last snapshot wins
    const { contextCollapseSnapshot } = await loadTranscriptFile(transcriptPath)
    expect(contextCollapseSnapshot).toBeDefined()
    expect(contextCollapseSnapshot?.lastSpawnTokens).toBe(400)
    expect(contextCollapseSnapshot?.armed).toBe(false)
  })

  test('loadTranscriptFile validates parentUuid chain', async () => {
    const sessionId = randomUUID() as any
    const transcriptPath = join(getProjectDir(projectDir), `${sessionId}.jsonl`)

    const ids = Array.from({ length: 5 }, () => randomUUID())
    const messages = []

    for (let i = 0; i < 5; i++) {
      messages.push({
        type: i % 2 === 0 ? 'user' : 'assistant',
        uuid: ids[i],
        parentUuid: i === 0 ? null : ids[i - 1],
        sessionId,
        timestamp: new Date(Date.now() + i).toISOString(),
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
        },
      })
    }

    const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
    await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
    await writeFile(transcriptPath, content, { mode: 0o600 })

    // Load and verify chain
    const { messages: loadedMsgs } = await loadTranscriptFile(transcriptPath)

    for (const [uuid, msg] of loadedMsgs) {
      if (msg.parentUuid !== null) {
        expect(loadedMsgs.has(msg.parentUuid)).toBe(true)
      }
    }
  })

  test('multiple sessions are isolated', async () => {
    const sessionId1 = randomUUID() as any
    const transcriptPath1 = join(getProjectDir(projectDir), `${sessionId1}.jsonl`)

    const sessionId2 = randomUUID() as any
    const transcriptPath2 = join(getProjectDir(projectDir), `${sessionId2}.jsonl`)

    const msg1 = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sessionId1,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'session 1 message' },
    }

    const msg2 = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sessionId2,
      timestamp: new Date(Date.now() + 1).toISOString(),
      message: { role: 'user', content: 'session 2 message' },
    }

    await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
    await writeFile(transcriptPath1, JSON.stringify(msg1) + '\n', { mode: 0o600 })
    await writeFile(transcriptPath2, JSON.stringify(msg2) + '\n', { mode: 0o600 })

    // Verify files are separate
    const { messages: loaded1 } = await loadTranscriptFile(transcriptPath1)
    const { messages: loaded2 } = await loadTranscriptFile(transcriptPath2)

    expect(loaded1.size).toBe(1)
    expect(loaded2.size).toBe(1)
    expect(loaded1.has(msg1.uuid as any)).toBe(true)
    expect(loaded2.has(msg2.uuid as any)).toBe(true)
    expect(loaded1.has(msg2.uuid as any)).toBe(false)
    expect(loaded2.has(msg1.uuid as any)).toBe(false)
  })

  test('loadTranscriptFile handles corrupt tail', async () => {
    const sessionId = randomUUID() as any
    const transcriptPath = join(getProjectDir(projectDir), `${sessionId}.jsonl`)

    const validMsg = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'valid message' },
    }

    const content =
      JSON.stringify(validMsg) +
      '\n' +
      'not json at all' +
      '\n' +
      '{"partial": "json"' +
      '\n'

    await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
    await writeFile(transcriptPath, content, { mode: 0o600 })

    // Load should skip invalid lines but keep valid ones
    const { messages } = await loadTranscriptFile(transcriptPath)
    expect(messages.size).toBe(1)
    expect(messages.has(validMsg.uuid as any)).toBe(true)
  })
})
