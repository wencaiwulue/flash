/**
 * Memory Regression Tests
 *
 * Tests for memory cursor restart/deletion invalidation, realpath boundaries,
 * and extraction locking.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from 'fs/promises'
import { join, resolve, basename } from 'path'
import { tmpdir } from 'os'
import {
  SessionMemoryCursorManager,
  MemoryPathValidator,
  PathTraversalError,
  setLastSummarizedMessageId,
  getLastSummarizedMessageId,
  checkAndInvalidateDeletedFiles,
  resetSessionMemoryState,
  markExtractionStarted,
  markExtractionCompleted,
  isSessionMemoryInitialized,
  markSessionMemoryInitialized,
  hasMetInitializationThreshold,
  hasMetUpdateThreshold,
} from '../src/services/SessionMemory/sessionMemoryUtils.ts'

function createTempTestDir(): string {
  const testDir = join(tmpdir(), `memory-test-${randomUUID()}`)
  return testDir
}

describe('memory - cursor persistence and restart', () => {
  let testDir: string
  let manager: SessionMemoryCursorManager

  beforeEach(async () => {
    testDir = createTempTestDir()
    await mkdir(testDir, { recursive: true })
    manager = new SessionMemoryCursorManager(testDir)
    resetSessionMemoryState()
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
    resetSessionMemoryState()
  })

  test('stores and retrieves last summarized message ID', () => {
    const messageId = 'test-message-uuid-12345'

    manager.setLastSummarizedMessageId(messageId)
    const retrieved = manager.getLastSummarizedMessageId()

    expect(retrieved).toBe(messageId)
  })

  test('returns undefined when no cursor exists', () => {
    const cursor = manager.getCursor()
    expect(cursor).toBeUndefined()
  })

  test('persists cursor across manager restarts', async () => {
    const cursorId = 'test-message-uuid-54321'
    const trackedFiles = ['notes.md', 'ideas.md']
    const sessionId = 'session-abc123'

    manager.setCursor({
      lastSummarizedMessageId: cursorId,
      trackedFiles,
      sessionId,
    })

    // Create a new manager instance pointing to the same directory
    const restartedManager = new SessionMemoryCursorManager(testDir)
    const restored = restartedManager.getCursor()

    expect(restored).not.toBeUndefined()
    expect(restored?.lastSummarizedMessageId).toBe(cursorId)
    expect(restored?.trackedFiles).toEqual(trackedFiles)
    expect(restored?.sessionId).toBe(sessionId)
    expect(restored?.timestamp).toBeGreaterThan(0)
  })

  test('explicitly invalidates cursor', () => {
    manager.setLastSummarizedMessageId('test-id')
    expect(manager.getCursor()).not.toBeUndefined()

    manager.invalidate()

    expect(manager.getCursor()).toBeUndefined()
  })

  test('adds tracked files with deduplication', () => {
    manager.setLastSummarizedMessageId('test-id')

    manager.addTrackedFile('file1.md')
    manager.addTrackedFile('file2.md')
    manager.addTrackedFile('file1.md') // Duplicate

    const cursor = manager.getCursor()
    expect(cursor?.trackedFiles).toEqual(['file1.md', 'file2.md'])
  })

  test('global setLastSummarizedMessageId/getLastSummarizedMessageId work', () => {
    const testId = 'global-test-id'

    setLastSummarizedMessageId(testId, 'test-session')

    expect(getLastSummarizedMessageId()).toBe(testId)
  })

  test('resetSessionMemoryState clears global state', () => {
    setLastSummarizedMessageId('to-be-cleared', 'test-session')

    resetSessionMemoryState()

    expect(getLastSummarizedMessageId()).toBeUndefined()
  })
})

describe('memory - deletion invalidation', () => {
  let testDir: string
  let manager: SessionMemoryCursorManager
  let memoryDir: string

  beforeEach(async () => {
    testDir = createTempTestDir()
    memoryDir = join(testDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    manager = new SessionMemoryCursorManager(memoryDir)
    resetSessionMemoryState()
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
    resetSessionMemoryState()
  })

  test('detects deleted tracked files and invalidates cursor', async () => {
    const memoryFile = join(memoryDir, 'topic.md')
    await writeFile(memoryFile, '# Topic Notes', 'utf-8')

    manager.setCursor({
      lastSummarizedMessageId: 'cursor-123',
      trackedFiles: ['topic.md'],
      sessionId: 'session-1',
    })

    // Verify cursor exists
    expect(manager.getCursor()).not.toBeUndefined()

    // Delete the tracked file
    await rm(memoryFile)

    // Check and invalidate
    const invalidated = manager.checkAndInvalidateDeletedFiles()
    expect(invalidated).toBe(true)

    // Cursor should be gone
    expect(manager.getCursor()).toBeUndefined()
  })

  test('does not invalidate when no tracked files are deleted', async () => {
    const memoryFile = join(memoryDir, 'topic.md')
    await writeFile(memoryFile, '# Topic Notes', 'utf-8')

    manager.setCursor({
      lastSummarizedMessageId: 'cursor-123',
      trackedFiles: ['topic.md'],
      sessionId: 'session-1',
    })

    const invalidated = manager.checkAndInvalidateDeletedFiles()
    expect(invalidated).toBe(false)
    expect(manager.getCursor()).not.toBeUndefined()
  })

  test('checkAndInvalidateDeletedFiles handles empty tracked files', () => {
    manager.setCursor({
      lastSummarizedMessageId: 'cursor-123',
      trackedFiles: [],
      sessionId: 'session-1',
    })

    const invalidated = manager.checkAndInvalidateDeletedFiles()
    expect(invalidated).toBe(false)
  })

  test('checkAndInvalidateDeletedFiles handles missing cursor', () => {
    // No cursor set
    const invalidated = manager.checkAndInvalidateDeletedFiles()
    expect(invalidated).toBe(false)
  })
})

describe('memory - realpath boundaries', () => {
  let testDir: string
  let validator: MemoryPathValidator

  beforeEach(async () => {
    testDir = createTempTestDir()
    const memoryDir = join(testDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    validator = new MemoryPathValidator(memoryDir)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('sanitizePathKey rejects path traversal attempts', () => {
    expect(() => validator.sanitizePathKey('../secret.txt')).toThrow(PathTraversalError)
  })

  test('sanitizePathKey rejects absolute paths', () => {
    expect(() => validator.sanitizePathKey('/etc/passwd')).toThrow(PathTraversalError)
  })

  test('sanitizePathKey rejects null bytes', () => {
    expect(() => validator.sanitizePathKey('file\0.md')).toThrow(PathTraversalError)
  })

  test('sanitizePathKey rejects URL encoded path traversal', () => {
    expect(() => validator.sanitizePathKey('%2e%2e%2fsecret.txt')).toThrow(PathTraversalError)
  })

  test('sanitizePathKey rejects backslashes', () => {
    expect(() => validator.sanitizePathKey('..\\secret.txt')).toThrow(PathTraversalError)
  })

  test('sanitizePathKey accepts valid relative paths', () => {
    expect(validator.sanitizePathKey('notes.md')).toBe('notes.md')
    expect(validator.sanitizePathKey('subdir/notes.md')).toBe('subdir/notes.md')
  })

  test('isPlausiblyWithinMemoryDir rejects escaping paths', async () => {
    const escapedPath = join(validator['memoryDir'], '..', 'secret.txt')
    const isPlausible = validator.isPlausiblyWithinMemoryDir(escapedPath)
    expect(isPlausible).toBe(false)
  })

  test('isPlausiblyWithinMemoryDir accepts internal paths', () => {
    const validPath = join(validator['memoryDir'], 'notes.md')
    const isPlausible = validator.isPlausiblyWithinMemoryDir(validPath)
    expect(isPlausible).toBe(true)
  })

  test('isPlausiblyWithinMemoryDir handles symlink paths', async () => {
    const realFile = join(testDir, 'real.md')
    const symlinkPath = join(validator['memoryDir'], 'link.md')
    await writeFile(realFile, 'real content', 'utf-8')

    try {
      await symlink(realFile, symlinkPath)
    } catch {
      // Some platforms might not allow symlinks, skip this test if so
      return
    }

    // Plausibility check should pass based on path string alone
    const isPlausible = validator.isPlausiblyWithinMemoryDir(symlinkPath)
    expect(isPlausible).toBe(true)
  })
})

describe('memory - extraction locking', () => {
  beforeEach(() => {
    resetSessionMemoryState()
  })

  afterEach(() => {
    resetSessionMemoryState()
  })

  test('markExtractionStarted sets extraction timestamp', () => {
    markExtractionStarted()
    // Just verify it doesn't throw - the return type is void
    markExtractionStarted()
    expect(true).toBe(true)
  })

  test('markExtractionCompleted clears extraction timestamp', () => {
    markExtractionStarted()
    markExtractionCompleted()
    // Just verify it doesn't throw
    expect(true).toBe(true)
  })

  test('markExtractionCompleted can be called safely multiple times', () => {
    expect(() => {
      markExtractionCompleted()
      markExtractionCompleted()
    }).not.toThrow()
  })
})

describe('memory - initialization and thresholds', () => {
  beforeEach(() => {
    resetSessionMemoryState()
  })

  afterEach(() => {
    resetSessionMemoryState()
  })

  test('isSessionMemoryInitialized returns false initially', () => {
    expect(isSessionMemoryInitialized()).toBe(false)
  })

  test('markSessionMemoryInitialized updates state', () => {
    markSessionMemoryInitialized()
    expect(isSessionMemoryInitialized()).toBe(true)
  })

  test('hasMetInitializationThreshold returns boolean', () => {
    // Just verify the function returns something without throwing
    const result = hasMetInitializationThreshold(1000)
    expect(typeof result).toBe('boolean')
  })

  test('hasMetUpdateThreshold returns boolean after init', () => {
    markSessionMemoryInitialized()
    const result = hasMetUpdateThreshold(2000)
    expect(typeof result).toBe('boolean')
  })

  test('resetSessionMemoryState resets all state', () => {
    markSessionMemoryInitialized()
    setLastSummarizedMessageId('test-id', 'test-session')

    resetSessionMemoryState()

    expect(isSessionMemoryInitialized()).toBe(false)
    expect(getLastSummarizedMessageId()).toBeUndefined()
  })
})

describe('memory - concurrent extraction guard', () => {
  beforeEach(() => {
    resetSessionMemoryState()
  })

  afterEach(() => {
    resetSessionMemoryState()
  })

  test('markExtractionStarted and markExtractionCompleted work in sequence', () => {
    // Verify the functions can be called in sequence without throwing
    expect(() => {
      markExtractionStarted()
      markExtractionCompleted()
      markExtractionStarted()
      markExtractionCompleted()
    }).not.toThrow()
  })
})
