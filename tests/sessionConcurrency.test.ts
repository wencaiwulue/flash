/**
 * Task 6: Session Concurrency and Locking Tests
 *
 * Tests that session storage uses proper-lockfile safely with
 * recordTranscript and context collapse snapshots.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtemp, rm, writeFile, readFile, mkdir, utimes } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import {
  loadTranscriptFile,
  flushSessionStorage,
  resetProjectForTesting,
  recordTranscript,
  recordContextCollapseSnapshot,
  getTranscriptPath,
} from '../src/utils/sessionStorage.ts'
import { switchSession, resetStateForTests } from '../src/bootstrap/state.ts'
import { canonicalizePath, getProjectDir } from '../src/utils/sessionStoragePortable.ts'
import * as lockfile from '../src/utils/lockfile.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const originalNodeEnv = process.env.NODE_ENV
let tempDir: string
let projectDir: string
const projectRoot = resolve(__dirname, '..')

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

  test('real proper-lockfile: stale lock is cleaned up', async () => {
    // Create a test file for locking
    const testDir = await mkdtemp(join(tmpdir(), 'claude-stale-lock-test-'))
    const testFile = join(testDir, 'test.jsonl')
    await mkdir(dirname(testFile), { recursive: true, mode: 0o700 })
    await writeFile(testFile, '', { mode: 0o600 })

    // Manually create a lock directory to simulate a stale lock
    // proper-lockfile creates directories named ${filename}.lock
    const lockDir = testFile + '.lock'
    await mkdir(lockDir, { mode: 0o700 })

    // Age the lock by setting its mtime to 1 hour ago
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    await utimes(lockDir, new Date(oneHourAgo), new Date(oneHourAgo))

    try {
      // Now try to acquire the lock with a short stale threshold (1 second)
      // This should succeed because the manual lock is stale
      const release = await lockfile.lock(testFile, {
        stale: 1000,
        retries: 0,
      })

      // Verify we can check the lock status and it shows as locked
      const isLocked = await lockfile.check(testFile, { stale: 10000 })
      expect(isLocked).toBe(true)

      // Release the lock
      await release()

      // Verify check shows as not locked
      const isLockedAfterRelease = await lockfile.check(testFile, { stale: 10000 })
      expect(isLockedAfterRelease).toBe(false)
    } finally {
      // Clean up
      await rm(testDir, { recursive: true, force: true })
    }
  })

  test('real proper-lockfile: can lock and unlock multiple times', async () => {
    // Create a test file for locking
    const testDir = await mkdtemp(join(tmpdir(), 'claude-stale-lock-test-'))
    const testFile = join(testDir, 'test.jsonl')
    await mkdir(dirname(testFile), { recursive: true, mode: 0o700 })
    await writeFile(testFile, '', { mode: 0o600 })

    // Lock and unlock multiple times to verify recovery works
    for (let i = 0; i < 3; i++) {
      const release = await lockfile.lock(testFile, {
        stale: 10000,
        retries: 2,
      })
      await release()
    }

    // Final lock should succeed
    const finalRelease = await lockfile.lock(testFile, { stale: 10000 })
    await finalRelease()

    await rm(testDir, { recursive: true, force: true })
  })

  test('real proper-lockfile: valid lock contention fails', async () => {
    // Create a test file for locking
    const testDir = await mkdtemp(join(tmpdir(), 'claude-lock-contention-test-'))
    const testFile = join(testDir, 'test.jsonl')
    await mkdir(dirname(testFile), { recursive: true, mode: 0o700 })
    await writeFile(testFile, '', { mode: 0o600 })

    let release: (() => Promise<void>) | undefined
    try {
      // Acquire lock first
      release = await lockfile.lock(testFile, {
        stale: 10000,
      })

      // Assert that lockfile.check reports exactly true while held
      const isLockedWhileHeld = await lockfile.check(testFile, { stale: 10000 })
      expect(isLockedWhileHeld).toBe(true)

      // Now try to acquire again with finite retries - this should fail
      let secondRelease: (() => Promise<void>) | undefined
      let lockError: Error & { code?: string } | undefined
      const startTime = Date.now()
      try {
        secondRelease = await lockfile.lock(testFile, {
          stale: 10000,
          retries: 1,
          minTimeout: 50,
          maxTimeout: 100,
        })
      } catch (e) {
        lockError = e as Error & { code?: string }
      }
      const duration = Date.now() - startTime

      // Should have failed with lock error within bounded duration
      expect(lockError).toBeDefined()
      expect(lockError?.code).toBe('ELOCKED')
      expect(secondRelease).toBeUndefined()
      expect(duration).toBeLessThan(5000) // Should fail quickly, not hang
    } finally {
      // Now release the lock
      if (release) {
        await release()
      }

      // Assert check is false after release
      const isLockedAfterRelease = await lockfile.check(testFile, { stale: 10000 })
      expect(isLockedAfterRelease).toBe(false)
    }

    await rm(testDir, { recursive: true, force: true })
  })

  test('real proper-lockfile: lock/unlock cycle works', async () => {
    // Create a test file for locking
    const testDir = await mkdtemp(join(tmpdir(), 'claude-lock-test-'))
    const testFile = join(testDir, 'test.jsonl')
    await mkdir(dirname(testFile), { recursive: true, mode: 0o700 })
    await writeFile(testFile, '', { mode: 0o600 })

    // Acquire lock
    const release = await lockfile.lock(testFile, {
      stale: 10000,
    })

    // Release lock
    await release()

    // Acquire again - should work
    const release2 = await lockfile.lock(testFile, {
      retries: 0,
      stale: 10000,
    })
    await release2()

    await rm(testDir, { recursive: true, force: true })
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

  test('real concurrent writes with Bun.spawn child processes', async () => {
    // Create a fresh temp dir for this test
    const testTempDir = await mkdtemp(join(tmpdir(), 'claude-real-concurrent-test-'))

    try {
      const sharedSessionId = randomUUID()
      const workerPath = resolve(__dirname, 'fixtures', 'concurrent-worker.ts')

      // Set up both workers
      const env1 = {
        ...process.env,
        WORKER_ID: '1',
        SHARED_SESSION_ID: sharedSessionId,
        TEST_PROJECT_ROOT: projectRoot, // Actual project root for imports
        TEST_TEMP_DIR: testTempDir, // Temp dir for session files
      }
      const env2 = {
        ...process.env,
        WORKER_ID: '2',
        SHARED_SESSION_ID: sharedSessionId,
        TEST_PROJECT_ROOT: projectRoot, // Actual project root for imports
        TEST_TEMP_DIR: testTempDir, // Temp dir for session files
      }

      console.log(`[test] Starting worker 1 and 2 with session: ${sharedSessionId}`)

      // Spawn both workers
      const worker1 = Bun.spawn({
        cmd: [process.execPath, workerPath],
        env: env1,
        cwd: projectRoot,
        stderr: 'pipe',
        stdout: 'pipe',
      })

      const worker2 = Bun.spawn({
        cmd: [process.execPath, workerPath],
        env: env2,
        cwd: projectRoot,
        stderr: 'pipe',
        stdout: 'pipe',
      })

      // Wait for both with timeout
      const timeoutMs = 30000
      const timeout = setTimeout(() => {
        console.error('[test] Timeout - killing workers')
        try { worker1.kill() } catch {}
        try { worker2.kill() } catch {}
      }, timeoutMs)

      // Read outputs
      const [exitCode1, exitCode2, stdout1, stdout2, stderr1, stderr2] = await Promise.all([
        worker1.exited,
        worker2.exited,
        new Response(worker1.stdout).text(),
        new Response(worker2.stdout).text(),
        new Response(worker1.stderr).text(),
        new Response(worker2.stderr).text(),
      ])

      clearTimeout(timeout)

      // Print outputs for debugging
      console.log(`[test] Worker 1 exit code: ${exitCode1}`)
      console.log(`[test] Worker 1 stdout:\n${stdout1}`)
      if (stderr1) console.log(`[test] Worker 1 stderr:\n${stderr1}`)
      console.log(`[test] Worker 2 exit code: ${exitCode2}`)
      console.log(`[test] Worker 2 stdout:\n${stdout2}`)
      if (stderr2) console.log(`[test] Worker 2 stderr:\n${stderr2}`)

      // Both should exit successfully
      expect(exitCode1).toBe(0)
      expect(exitCode2).toBe(0)

      // Now load and verify the transcript - scan temp dir to find the file
      const { readdir } = await import('fs/promises')
      let transcriptPath: string | undefined

      async function findJsonl(dir: string): Promise<string | undefined> {
        try {
          const entries = await readdir(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = join(dir, entry.name)
            if (entry.isDirectory()) {
              const found = await findJsonl(fullPath)
              if (found) return found
            } else if (entry.name === `${sharedSessionId}.jsonl`) {
              return fullPath
            }
          }
        } catch {
          // Skip directories we can't read
        }
        return undefined
      }

      transcriptPath = await findJsonl(testTempDir)
      expect(transcriptPath).toBeDefined()
      console.log(`[test] Loading transcript from: ${transcriptPath}`)

      const content = await readFile(transcriptPath!, 'utf-8')
      const lines = content.trim().split('\n').filter(l => l.trim())

      console.log(`[test] Total lines: ${lines.length}`)

      // Parse all lines and count valid snapshots
      const snapshots: any[] = []
      const seenStartUuids = new Set<string>()
      const seenEndUuids = new Set<string>()
      const seenWorkerIds = new Set<string>()
      let invalidLines = 0

      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'marble-origami-snapshot') {
            snapshots.push(entry)
            // Extract worker ID from summary
            const summary = entry.staged?.[0]?.summary || ''
            const workerMatch = summary.match(/worker-(\d)/)
            if (workerMatch) {
              seenWorkerIds.add(workerMatch[1])
            }
            const startUuid = entry.staged?.[0]?.startUuid
            const endUuid = entry.staged?.[0]?.endUuid
            if (startUuid) seenStartUuids.add(startUuid)
            if (endUuid) seenEndUuids.add(endUuid)
          }
        } catch {
          invalidLines++
        }
      }

      // Verify results
      expect(invalidLines).toBe(0) // No interleaved JSON - all lines parse
      expect(snapshots.length).toBe(100) // Exactly 100 snapshots
      expect(seenStartUuids.size).toBe(100) // All start UUIDs unique
      expect(seenEndUuids.size).toBe(100) // All end UUIDs unique
      expect(seenWorkerIds.has('1')).toBe(true) // Both workers present
      expect(seenWorkerIds.has('2')).toBe(true)

    } finally {
      // Clean up
      await rm(testTempDir, { recursive: true, force: true })
    }
  })
})
