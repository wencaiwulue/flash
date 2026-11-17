import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import {
  SessionMemoryCursorManager,
  MemoryPathValidator,
  PathTraversalError,
  setLastSummarizedMessageId,
  getLastSummarizedMessageId,
  checkAndInvalidateDeletedFiles,
  resetSessionMemoryState,
} from '../src/services/SessionMemory/sessionMemoryUtils'
import {
  MicrocompactSession,
  CachedMicrocompactState,
} from '../src/services/compact/microCompact'
import {
  ContextCollapseSession,
} from '../src/services/contextCollapse'

// ============================================================================
// Session Memory Cursor Sidecar Tests
// ============================================================================

function createTempTestDir(): string {
  const testDir = join(tmpdir(), `session-memory-test-${randomUUID()}`)
  mkdirSync(testDir, { recursive: true })
  return testDir
}

describe('SessionMemoryCursorManager', () => {
  let testDir: string
  let manager: SessionMemoryCursorManager

  beforeEach(() => {
    testDir = createTempTestDir()
    manager = new SessionMemoryCursorManager(testDir)
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    resetSessionMemoryState()
  })

  test('stores and restores last summarized message ID', () => {
    const messageId = 'test-message-uuid-123'

    manager.setLastSummarizedMessageId(messageId)

    const newManager = new SessionMemoryCursorManager(testDir)
    const restored = newManager.getLastSummarizedMessageId()

    expect(restored).toBe(messageId)
  })

  test('returns undefined when no cursor exists', () => {
    const cursor = manager.getCursor()
    expect(cursor).toBeUndefined()
    expect(manager.getLastSummarizedMessageId()).toBeUndefined()
  })

  test('restart restores memory cursor from sidecar', () => {
    const cursorId = 'test-message-uuid-456'

    manager.setCursor({
      lastSummarizedMessageId: cursorId,
      trackedFiles: ['topic.md', 'notes.md'],
      sessionId: 'session-1',
    })

    const restartedManager = new SessionMemoryCursorManager(testDir)
    const restored = restartedManager.getCursor()

    expect(restored).not.toBeUndefined()
    expect(restored?.lastSummarizedMessageId).toBe(cursorId)
    expect(restored?.trackedFiles).toEqual(['topic.md', 'notes.md'])
    expect(restored?.sessionId).toBe('session-1')
    expect(restored?.timestamp).toBeGreaterThan(0)
  })

  test('delete memory file invalidates cursor', () => {
    const memoryFile = join(testDir, 'topic.md')
    writeFileSync(memoryFile, '# Topic', 'utf-8')

    manager.setCursor({
      lastSummarizedMessageId: 'cursor-123',
      trackedFiles: ['topic.md'],
      sessionId: 'session-1',
    })

    expect(manager.getCursor()).not.toBeUndefined()

    rmSync(memoryFile)

    const invalidated = manager.checkAndInvalidateDeletedFiles()
    expect(invalidated).toBe(true)

    expect(manager.getCursor()).toBeUndefined()
    expect(manager.getLastSummarizedMessageId()).toBeUndefined()
  })

  test('invalidate explicitly removes cursor', () => {
    manager.setLastSummarizedMessageId('test-id')
    expect(manager.getCursor()).not.toBeUndefined()

    manager.invalidate()

    expect(manager.getCursor()).toBeUndefined()
  })

  test('adds tracked files with deduplication', () => {
    manager.setLastSummarizedMessageId('test-id')

    manager.addTrackedFile('file1.md')
    manager.addTrackedFile('file2.md')
    manager.addTrackedFile('file1.md')

    const cursor = manager.getCursor()
    expect(cursor?.trackedFiles).toEqual(['file1.md', 'file2.md'])
  })

  test('missing sidecar causes reinitialization', () => {
    const freshManager = new SessionMemoryCursorManager(testDir)
    expect(freshManager.getCursor()).toBeUndefined()
  })
})

// ============================================================================
// Memory Path Validation Tests
// ============================================================================

describe('MemoryPathValidator', () => {
  let testDir: string
  let memoryDir: string
  let validator: MemoryPathValidator

  beforeEach(() => {
    testDir = createTempTestDir()
    memoryDir = join(testDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
    validator = new MemoryPathValidator(memoryDir)
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('rejects paths escaping memory directory (fast path)', () => {
    const escapedPath = join(memoryDir, '..', 'secret.txt')
    const isPlausible = validator.isPlausiblyWithinMemoryDir(escapedPath)
    expect(isPlausible).toBe(false)
  })

  test('allows valid internal memory paths (fast path)', () => {
    const validPath = join(memoryDir, 'notes.md')
    const isPlausible = validator.isPlausiblyWithinMemoryDir(validPath)
    expect(isPlausible).toBe(true)
  })

  test('sanitizes path keys correctly', () => {
    expect(validator.sanitizePathKey('topic.md')).toBe('topic.md')
    expect(validator.sanitizePathKey('subdir/file.md')).toBe('subdir/file.md')
  })

  test('rejects null bytes in path keys', () => {
    expect(() => validator.sanitizePathKey('file\0.md')).toThrow(PathTraversalError)
  })

  test('rejects URL-encoded traversal in path keys', () => {
    expect(() => validator.sanitizePathKey('%2e%2e%2fsecret.txt')).toThrow(PathTraversalError)
  })

  test('rejects absolute path keys', () => {
    expect(() => validator.sanitizePathKey('/etc/passwd')).toThrow(PathTraversalError)
  })

  test('rejects backslashes in path keys', () => {
    expect(() => validator.sanitizePathKey('..\\secret.txt')).toThrow(PathTraversalError)
  })

  test('rejects path traversal segments in keys', () => {
    expect(() => validator.sanitizePathKey('../secret.txt')).toThrow(PathTraversalError)
  })
})

// ============================================================================
// Session State Isolation Tests
// ============================================================================

describe('ContextCollapseSession - session isolation', () => {
  test('two sessions never share collapse state', () => {
    const sessionA = new ContextCollapseSession({
      tokenCount: () => 200,
      contextWindow: () => 100,
      summarize: async () => 'summary A',
      recordCommit: async () => {},
      recordSnapshot: async () => {},
    })

    const sessionB = new ContextCollapseSession({
      tokenCount: () => 200,
      contextWindow: () => 100,
      summarize: async () => 'summary B',
      recordCommit: async () => {},
      recordSnapshot: async () => {},
    })

    expect(sessionA.stats.collapsedSpans).toBe(0)
    expect(sessionB.stats.collapsedSpans).toBe(0)

    sessionA['state'].armed = true

    expect(sessionA['state'].armed).toBe(true)
    expect(sessionB['state'].armed).toBe(false)
  })

  test('reset only affects the session it is called on', () => {
    const sessionA = new ContextCollapseSession()
    const sessionB = new ContextCollapseSession()

    sessionA['state'].armed = true
    sessionB['state'].armed = true

    sessionA.reset()

    expect(sessionA['state'].armed).toBe(false)
    expect(sessionB['state'].armed).toBe(true)
  })
})

describe('MicrocompactSession - session isolation', () => {
  test('two sessions have independent microcompact state', () => {
    const sessionA = new MicrocompactSession('test-model')
    const sessionB = new MicrocompactSession('test-model')

    expect(sessionA.pendingCacheEdits).toBeNull()
    expect(sessionB.pendingCacheEdits).toBeNull()

    const testBlock = { type: 'cache_edits', edits: [] } as any
    sessionA['cachedState'].pendingCacheEdits = testBlock

    expect(sessionA.pendingCacheEdits).toBe(testBlock)
    expect(sessionB.pendingCacheEdits).toBeNull()
  })

  test('reset only affects the session it is called on', () => {
    const sessionA = new MicrocompactSession('test-model')
    const sessionB = new MicrocompactSession('test-model')

    sessionA['cachedState'].registeredTools.add('tool-a')
    sessionB['cachedState'].registeredTools.add('tool-b')

    sessionA.reset()

    expect(sessionA['cachedState'].registeredTools.size).toBe(0)
    expect(sessionB['cachedState'].registeredTools.size).toBe(1)
  })

  test('pinned edits are isolated per session', () => {
    const sessionA = new MicrocompactSession('test-model')
    const sessionB = new MicrocompactSession('test-model')

    const block = { type: 'cache_edits', edits: [] } as any
    sessionA.pinCacheEdits(0, block)

    expect(sessionA.pinnedCacheEdits.length).toBe(1)
    expect(sessionB.pinnedCacheEdits.length).toBe(0)
  })
})

describe('CachedMicrocompactState - standalone', () => {
  test('tracks registered tools', () => {
    const state = new CachedMicrocompactState()

    expect(state.registeredTools.size).toBe(0)

    state.registeredTools.add('tool-1')
    state.registeredTools.add('tool-2')
    state.registeredTools.add('tool-1')

    expect(state.registeredTools.size).toBe(2)
  })

  test('resets cleanly', () => {
    const state = new CachedMicrocompactState()

    state.registeredTools.add('tool-1')
    state.pinnedEdits.push({ userMessageIndex: 0, block: { type: 'cache_edits', edits: [] } as any })
    state.pendingCacheEdits = { type: 'cache_edits', edits: [] } as any

    state.reset()

    expect(state.registeredTools.size).toBe(0)
    expect(state.toolOrder.length).toBe(0)
    expect(state.pinnedEdits.length).toBe(0)
    expect(state.pendingCacheEdits).toBeNull()
  })
})

// ============================================================================
// Restore Boundary Tests
// ============================================================================

describe('Session Memory Restore Boundaries', () => {
  test('restoreStateFromEntries only restores entries for matching session ID', async () => {
    const { restoreStateFromEntries } = await import('../src/services/contextCollapse/persist.ts')
    const { ContextCollapseState } = await import('../src/services/contextCollapse/store.ts')

    const sessionId1 = randomUUID()
    const sessionId2 = randomUUID()

    const commit1 = {
      type: 'marble-origami-commit',
      sessionId: sessionId1,
      collapseId: '0001',
      summaryUuid: randomUUID(),
      summaryContent: '# Summary 1',
      summary: 'summary 1',
      firstArchivedUuid: randomUUID(),
      lastArchivedUuid: randomUUID(),
    } as any

    const commit2 = {
      type: 'marble-origami-commit',
      sessionId: sessionId2,
      collapseId: '0002',
      summaryUuid: randomUUID(),
      summaryContent: '# Summary 2',
      summary: 'summary 2',
      firstArchivedUuid: randomUUID(),
      lastArchivedUuid: randomUUID(),
    } as any

    const state = new ContextCollapseState()
    restoreStateFromEntries(state, [commit1, commit2], undefined, { sessionId: sessionId1 })

    expect(state.committed.length).toBe(1)
    expect(state.committed[0].collapseId).toBe('0001')
  })
})
