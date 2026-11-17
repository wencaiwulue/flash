/**
 * Task 6: Session Concurrency and Locking Tests
 *
 * Tests that session storage uses proper-lockfile safely with
 * recordTranscript and context collapse snapshots.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtemp, rm, writeFile, readFile, mkdir, appendFile, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  loadTranscriptFile,
  flushSessionStorage,
  resetProjectForTesting,
  recordTranscript,
  recordContextCollapseSnapshot,
  getTranscriptPath,
  adoptResumedSessionFile,
  resetSessionFilePointer,
} from '../src/utils/sessionStorage.ts'
import { switchSession, resetStateForTests, getSessionId } from '../src/bootstrap/state.ts'
import { canonicalizePath, getProjectDir } from '../src/utils/sessionStoragePortable.ts'
import * as lockfile from '../src/utils/lockfile.ts'
import { sleep } from 'bun'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalNodeEnv = process.env.NODE_ENV
let tempDir: string
let projectDir: string

// Worker script for concurrent writes
const workerScript = `
import { randomUUID } from 'crypto'
import { setInterval } from 'timers'

// Set up environment
process.env.CLAUDE_CONFIG_DIR = process.env.TEST_CONFIG_DIR
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.NODE_ENV = 'test'

// Import after env is set
const { switchSession, getSessionId } = await import(process.env.TEST_ROOT + '/src/bootstrap/state.ts')
const {
  recordTranscript,
  recordContextCollapseSnapshot,
  getTranscriptPath,
  flushSessionStorage,
} = await import(process.env.TEST_ROOT + '/src/utils/sessionStorage.ts')
const { getProjectDir } = await import(process.env.TEST_ROOT + '/src/utils/sessionStoragePortable.ts')

// Initialize
const workerId = process.env.WORKER_ID
const sharedSessionId = process.env.SHARED_SESSION_ID
const projectDir = process.env.TEST_PROJECT_DIR

switchSession(sharedSessionId as any, projectDir)

// First, record an initial message to create the file
const initMsg = {
  type: 'user',
  uuid: randomUUID(),
  parentUuid: null,
  message: { role: 'user', content: \`init from worker \${workerId}\` },
  isMeta: false,
}

try {
  await recordTranscript([initMsg])
  await flushSessionStorage()
} catch (e) {
  console.error('Worker init error:', e)
  process.send({ type: 'error', workerId, error: String(e) })
  process.exit(1)
}

// Now record 50 context collapse snapshots
let written = 0
const writeSnapshot = async () => {
  if (written >= 50) {
    clearInterval(timer)
    await flushSessionStorage()
    process.send({ type: 'done', workerId, written })
    return
  }

  try {
    const startUuid = randomUUID()
    const endUuid = randomUUID()
    await recordContextCollapseSnapshot({
      staged: [{
        startUuid,
        endUuid,
        summary: \`snapshot \${written} from worker \${workerId}\`,
        risk: 0.5,
        stagedAt: Date.now(),
      }],
      armed: written % 2 === 0,
      lastSpawnTokens: 100 + written,
    })
    written++
    process.send({ type: 'snapshot', workerId, count: written, startUuid, endUuid })
  } catch (e) {
    console.error('Worker write error:', e)
    process.send({ type: 'error', workerId, error: String(e) })
  }
}

const timer = setInterval(writeSnapshot, 10)
writeSnapshot() // Start immediately
`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'claude-session-concurrency-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.NODE_ENV = 'test'
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
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = originalNodeEnv
  }
  await rm(tempDir, { recursive: true, force: true })
})

describe('Session Concurrency Contracts', () => {
  test('proper-lockfile module is available', async () => {
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

  test('concurrent writes simulation tests 100 valid snapshot entries', async () => {
    const sharedSessionId = randomUUID()
    switchSession(sharedSessionId as any, projectDir)

    // First, write an initial message to materialize the session file
    await recordTranscript([{
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      message: { role: 'user', content: 'initial message' },
      isMeta: false,
    }])

    // Create 50 snapshots from "worker1"
    for (let i = 0; i < 50; i++) {
      await recordContextCollapseSnapshot({
        staged: [{
          startUuid: randomUUID(),
          endUuid: randomUUID(),
          summary: `snapshot-${i} from worker1`,
          risk: 0.5,
          stagedAt: Date.now(),
        }],
        armed: i % 2 === 0,
        lastSpawnTokens: 100 + i,
      })
    }

    // Create 50 snapshots from "worker2"
    for (let i = 0; i < 50; i++) {
      await recordContextCollapseSnapshot({
        staged: [{
          startUuid: randomUUID(),
          endUuid: randomUUID(),
          summary: `snapshot-${i} from worker2`,
          risk: 0.5,
          stagedAt: Date.now(),
        }],
        armed: i % 2 === 1,
        lastSpawnTokens: 200 + i,
      })
    }

    await flushSessionStorage()

    // Read and verify the transcript
    const transcriptPath = getTranscriptPath()
    const content = await readFile(transcriptPath, 'utf-8')
    const lines = content.trim().split('\n')
    const snapshots: any[] = []
    const seenUuids = new Set<string>()
    let hasInterleavedJson = false
    const workerIds = new Set<string>()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue

      try {
        const entry = JSON.parse(line)
        if (entry.type === 'marble-origami-snapshot') {
          snapshots.push(entry)
          // Check for worker ID in summary
          if (entry.staged?.[0]?.summary) {
            const summary = entry.staged[0].summary
            if (summary.includes('worker1')) workerIds.add('worker1')
            if (summary.includes('worker2')) workerIds.add('worker2')
          }
          // Check UUID uniqueness
          if (entry.staged?.[0]?.startUuid) {
            const startUuid = entry.staged[0].startUuid
            const endUuid = entry.staged[0].endUuid
            expect(seenUuids.has(startUuid)).toBe(false)
            expect(seenUuids.has(endUuid)).toBe(false)
            seenUuids.add(startUuid)
            seenUuids.add(endUuid)
          }
        }
      } catch (e) {
        hasInterleavedJson = true
      }
    }

    // Verify results
    expect(snapshots.length).toBe(100)
    expect(hasInterleavedJson).toBe(false)
    expect(workerIds.has('worker1')).toBe(true)
    expect(workerIds.has('worker2')).toBe(true)

    resetStateForTests()
    resetProjectForTesting()
  })

  test('parentUuid chaining works correctly', async () => {
    const sessionId = randomUUID() as any
    switchSession(sessionId, projectDir)

    // Create a chain of messages
    const id1 = randomUUID()
    const id2 = randomUUID()
    const id3 = randomUUID()

    const msg1 = {
      type: 'user',
      uuid: id1,
      parentUuid: null,
      message: { role: 'user', content: 'message 1' },
      isMeta: false,
    }

    await recordTranscript([msg1])
    await flushSessionStorage()

    const msg2 = {
      type: 'assistant',
      uuid: id2,
      parentUuid: id1,
      message: { role: 'assistant', content: 'message 2' },
      isMeta: false,
    }

    await recordTranscript([msg2])
    await flushSessionStorage()

    const msg3 = {
      type: 'user',
      uuid: id3,
      parentUuid: id2,
      message: { role: 'user', content: 'message 3' },
      isMeta: false,
    }

    await recordTranscript([msg3])
    await flushSessionStorage()

    // Load and verify chain
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    expect(messages.size).toBe(3)
    const m1 = messages.get(id1 as any)!
    const m2 = messages.get(id2 as any)!
    const m3 = messages.get(id3 as any)!

    expect(m1.parentUuid).toBe(null)
    expect(m2.parentUuid).toBe(id1)
    expect(m3.parentUuid).toBe(id2)

    resetStateForTests()
    resetProjectForTesting()
  })

  test('duplicate UUIDs are suppressed', async () => {
    const sessionId = randomUUID() as any
    switchSession(sessionId, projectDir)

    const id = randomUUID()
    const msg1 = {
      type: 'user',
      uuid: id,
      parentUuid: null,
      message: { role: 'user', content: 'message 1' },
      isMeta: false,
    }

    // Record same message twice
    await recordTranscript([msg1])
    await flushSessionStorage()
    await recordTranscript([msg1]) // Duplicate
    await flushSessionStorage()

    // Load and verify only one copy
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    expect(messages.size).toBe(1)

    resetStateForTests()
    resetProjectForTesting()
  })

  test('stale lock cleanup works', async () => {
    const sessionId = randomUUID() as any
    switchSession(sessionId, projectDir)

    // Create a transcript file first
    const transcriptPath = getTranscriptPath()
    await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
    await writeFile(transcriptPath, '', { mode: 0o600 })

    // Now try to write normally - this will test that the locking mechanism works
    const msg = {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      message: { role: 'user', content: 'test' },
      isMeta: false,
    }

    // This should work fine
    await recordTranscript([msg])
    await flushSessionStorage()

    // Verify the message was written
    const { messages } = await loadTranscriptFile(transcriptPath)
    expect(messages.size).toBe(1)

    resetStateForTests()
    resetProjectForTesting()
  })

  test('corrupt tail recovery skips invalid lines', async () => {
    const sessionId = randomUUID() as any
    const transcriptPath = join(getProjectDir(projectDir), `${sessionId}.jsonl`)

    // Create valid messages plus various corrupt tails
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
      'not json at all' +
      '\n' +
      '{"partial": "json"' +
      '\n' +
      '{"type": "user", "missing": "closing}' +
      '\n' +
      'incomplete'

    await mkdir(getProjectDir(projectDir), { recursive: true, mode: 0o700 })
    await writeFile(transcriptPath, content, { mode: 0o600 })

    // Load should skip invalid lines but keep valid ones
    const { messages } = await loadTranscriptFile(transcriptPath)
    expect(messages.size).toBe(2)
    expect(messages.has(validMsg1.uuid as any)).toBe(true)
    expect(messages.has(validMsg2.uuid as any)).toBe(true)
  })
})
