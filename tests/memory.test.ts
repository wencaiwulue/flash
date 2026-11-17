import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MemoryPathValidator,
  PathTraversalError,
  SessionMemoryCursorManager,
  markExtractionCompleted,
  markExtractionStarted,
  resetSessionMemoryState,
  waitForSessionMemoryExtraction,
} from '../src/services/SessionMemory/sessionMemoryUtils.ts'

describe('memory - cursor persistence and deletion recovery', () => {
  let testDir: string
  let manager: SessionMemoryCursorManager

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'flash-memory-cursor-'))
    manager = new SessionMemoryCursorManager(testDir)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('restores cursor, session and tracked files after a manager restart', async () => {
    manager.setCursor({
      lastSummarizedMessageId: 'message-42',
      trackedFiles: ['notes.md', 'ideas.md'],
      sessionId: 'session-a',
    })

    const restarted = new SessionMemoryCursorManager(testDir)
    const restored = restarted.getCursor()

    expect(restored).toMatchObject({
      lastSummarizedMessageId: 'message-42',
      trackedFiles: ['notes.md', 'ideas.md'],
      sessionId: 'session-a',
    })
    expect(restored!.timestamp).toBeGreaterThan(0)
    expect(restarted.getLastSummarizedMessageId()).toBe('message-42')
  })

  test('atomically replaces the sidecar without leaving a temporary file', async () => {
    const cursorPath = join(testDir, '.session-memory-cursor.json')
    manager.setLastSummarizedMessageId('message-old', 'session-a')
    manager.setLastSummarizedMessageId('message-new', 'session-a')

    const persisted = JSON.parse(await readFile(cursorPath, 'utf8'))
    expect(persisted.lastSummarizedMessageId).toBe('message-new')
    expect(persisted.sessionId).toBe('session-a')
    expect((await stat(cursorPath)).mode & 0o777).toBe(0o600)
    await expect(access(`${cursorPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(new SessionMemoryCursorManager(testDir).getLastSummarizedMessageId()).toBe('message-new')
  })

  test('deduplicates tracked files while preserving insertion order', () => {
    manager.setLastSummarizedMessageId('message-1', 'session-a')
    manager.addTrackedFile('one.md')
    manager.addTrackedFile('two.md')
    manager.addTrackedFile('one.md')

    expect(manager.getCursor()?.trackedFiles).toEqual(['one.md', 'two.md'])
  })

  test('invalidates the persisted cursor when any tracked memory file is deleted', async () => {
    await writeFile(join(testDir, 'one.md'), 'one')
    await writeFile(join(testDir, 'two.md'), 'two')
    manager.setCursor({
      lastSummarizedMessageId: 'message-1',
      trackedFiles: ['one.md', 'two.md'],
      sessionId: 'session-a',
    })
    await rm(join(testDir, 'one.md'))

    expect(manager.checkAndInvalidateDeletedFiles()).toBe(true)
    expect(manager.getCursor()).toBeUndefined()
    expect(new SessionMemoryCursorManager(testDir).getCursor()).toBeUndefined()
  })

  test('keeps a valid cursor when every tracked file still exists', async () => {
    await writeFile(join(testDir, 'one.md'), 'one')
    manager.setCursor({
      lastSummarizedMessageId: 'message-1',
      trackedFiles: ['one.md'],
      sessionId: 'session-a',
    })

    expect(manager.checkAndInvalidateDeletedFiles()).toBe(false)
    expect(manager.getLastSummarizedMessageId()).toBe('message-1')
  })
})

describe('memory - execution-layer realpath containment', () => {
  let testDir: string
  let memoryDir: string
  let validator: MemoryPathValidator

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'flash-memory-realpath-'))
    memoryDir = join(testDir, 'memory')
    await mkdir(memoryDir)
    validator = new MemoryPathValidator(memoryDir)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('accepts an ordinary file and returns its canonical path', async () => {
    const file = join(memoryDir, 'notes.md')
    await writeFile(file, 'notes')

    expect(await validator.validateRealPathContainment(file)).toBe(await realpath(file))
  })

  test('accepts a symlink whose target remains inside memory', async () => {
    const target = join(memoryDir, 'target.md')
    const link = join(memoryDir, 'alias.md')
    await writeFile(target, 'internal')
    await symlink(target, link)

    expect(validator.isPlausiblyWithinMemoryDir(link)).toBe(true)
    expect(await validator.validateRealPathContainment(link)).toBe(await realpath(target))
  })

  test('rejects a file symlink that escapes memory', async () => {
    const outside = join(testDir, 'outside.md')
    const link = join(memoryDir, 'escape.md')
    await writeFile(outside, 'secret')
    await symlink(outside, link)

    await expect(validator.validateRealPathContainment(link)).rejects.toBeInstanceOf(PathTraversalError)
  })

  test('rejects a directory symlink escape even when the lexical path is internal', async () => {
    const outsideDir = join(testDir, 'outside')
    await mkdir(outsideDir)
    await writeFile(join(outsideDir, 'secret.md'), 'secret')
    const link = join(memoryDir, 'linked-directory')
    await symlink(outsideDir, link, 'dir')
    const candidate = join(link, 'secret.md')

    expect(validator.isPlausiblyWithinMemoryDir(candidate)).toBe(true)
    await expect(validator.validateRealPathContainment(candidate)).rejects.toBeInstanceOf(PathTraversalError)
  })

  test('rejects lexical traversal before reading the target', async () => {
    const outside = join(testDir, 'outside.md')
    await writeFile(outside, 'secret')

    await expect(
      validator.validateRealPathContainment(join(memoryDir, '..', 'outside.md')),
    ).rejects.toBeInstanceOf(PathTraversalError)
  })
})

describe('memory - extraction wait boundary', () => {
  beforeEach(() => {
    resetSessionMemoryState()
  })

  afterEach(() => {
    resetSessionMemoryState()
  })

  test('returns promptly when no extraction is active', async () => {
    const started = Date.now()
    await waitForSessionMemoryExtraction()
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('keeps the caller waiting until extraction is marked complete', async () => {
    markExtractionStarted()
    let resolved = false
    const waiting = waitForSessionMemoryExtraction().then(() => {
      resolved = true
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    expect(resolved).toBe(false)

    markExtractionCompleted()
    await waiting
    expect(resolved).toBe(true)
  }, 5000)
})
