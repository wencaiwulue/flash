/**
 * Session Memory utility functions that can be imported without circular dependencies.
 * These are separate from the main sessionMemory.ts to avoid importing runAgent.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { isFsInaccessible } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { sleep } from '../../utils/sleep.js'
import { logEvent } from '../analytics/index.js'

const EXTRACTION_WAIT_TIMEOUT_MS = 15000
const EXTRACTION_STALE_THRESHOLD_MS = 60000 // 1 minute

/**
 * Configuration for session memory extraction thresholds
 */
export type SessionMemoryConfig = {
  /** Minimum context window tokens before initializing session memory.
   * Uses the same token counting as autocompact (input + output + cache tokens)
   * to ensure consistent behavior between the two features. */
  minimumMessageTokensToInit: number
  /** Minimum context window growth (in tokens) between session memory updates.
   * Uses the same token counting as autocompact (tokenCountWithEstimation)
   * to measure actual context growth, not cumulative API usage. */
  minimumTokensBetweenUpdate: number
  /** Number of tool calls between session memory updates */
  toolCallsBetweenUpdates: number
}

// Default configuration values
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
}

// ============================================================================
// Session Memory Cursor Sidecar (NEW)
// ============================================================================

/**
 * Data stored in the session memory cursor sidecar file.
 */
export type SessionMemoryCursor = {
  /** ID of the last summarized message */
  lastSummarizedMessageId: string | undefined
  /** When this cursor was created/updated */
  timestamp: number
  /** List of tracked memory files (for deletion invalidation) */
  trackedFiles: string[]
  /** Session ID this cursor belongs to */
  sessionId: string | undefined
}

/**
 * Manages the atomic session memory cursor sidecar file.
 * Ensures cursor persists across restarts and invalidates on file deletion.
 */
export class SessionMemoryCursorManager {
  private readonly baseDir: string
  private readonly cursorPath: string
  private cachedCursor: SessionMemoryCursor | null = null
  private lastKnownTrackedFiles = new Set<string>()

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? dirname(getSessionMemoryPath())
    this.cursorPath = join(this.baseDir, '.session-memory-cursor.json')
  }

  /**
   * Gets the current cursor, loading from disk if needed.
   * Returns undefined if no cursor exists or it's invalid.
   */
  getCursor(): SessionMemoryCursor | undefined {
    if (this.cachedCursor) {
      return this.cachedCursor
    }

    if (!existsSync(this.cursorPath)) {
      return undefined
    }

    try {
      const content = readFileSync(this.cursorPath, 'utf-8')
      const cursor = JSON.parse(content) as SessionMemoryCursor

      // Validate cursor structure
      if (!cursor || typeof cursor.timestamp !== 'number') {
        return undefined
      }

      this.cachedCursor = cursor
      this.lastKnownTrackedFiles = new Set(cursor.trackedFiles ?? [])
      return cursor
    } catch {
      // Invalid JSON or unreadable file - treat as no cursor
      return undefined
    }
  }

  /**
   * Sets the cursor atomically, writing to disk.
   */
  setCursor(cursor: Omit<SessionMemoryCursor, 'timestamp'>): void {
    const fullCursor: SessionMemoryCursor = {
      ...cursor,
      timestamp: Date.now(),
    }

    // Ensure directory exists
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true, mode: 0o700 })
    }

    // Write atomically - first to temp file, then rename
    const tempPath = this.cursorPath + '.tmp'
    writeFileSync(tempPath, JSON.stringify(fullCursor, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })

    const fs = getFsImplementation()
    fs.renameSync(tempPath, this.cursorPath)

    this.cachedCursor = fullCursor
    this.lastKnownTrackedFiles = new Set(fullCursor.trackedFiles ?? [])
  }

  /**
   * Updates just the last summarized message ID.
   */
  setLastSummarizedMessageId(
    messageId: string | undefined,
    sessionId?: string,
  ): void {
    const existing = this.getCursor()
    this.setCursor({
      lastSummarizedMessageId: messageId,
      trackedFiles: existing?.trackedFiles ?? [],
      sessionId: sessionId ?? existing?.sessionId,
    })
  }

  /**
   * Gets just the last summarized message ID.
   */
  getLastSummarizedMessageId(): string | undefined {
    return this.getCursor()?.lastSummarizedMessageId
  }

  /**
   * Adds a tracked memory file.
   */
  addTrackedFile(filePath: string): void {
    const existing = this.getCursor()
    const trackedFiles = [...(existing?.trackedFiles ?? []), filePath]
    // Deduplicate
    this.setCursor({
      lastSummarizedMessageId: existing?.lastSummarizedMessageId,
      trackedFiles: [...new Set(trackedFiles)],
      sessionId: existing?.sessionId,
    })
  }

  /**
   * Checks if any tracked file has been deleted.
   * If so, invalidates the cursor and returns true.
   */
  checkAndInvalidateDeletedFiles(): boolean {
    const existing = this.getCursor()
    if (!existing || !existing.trackedFiles.length) {
      return false
    }

    // Check if any tracked file no longer exists
    const allFilesExist = existing.trackedFiles.every(filePath => {
      // Resolve relative to memory dir
      const absolutePath = join(this.baseDir, filePath)
      return existsSync(absolutePath)
    })

    if (!allFilesExist) {
      this.invalidate()
      return true
    }

    return false
  }

  /**
   * Invalidates the cursor entirely.
   * Called when memory files are deleted or session restarts without valid state.
   */
  invalidate(): void {
    this.cachedCursor = null
    this.lastKnownTrackedFiles.clear()
    if (existsSync(this.cursorPath)) {
      try {
        const fs = getFsImplementation()
        fs.unlinkSync(this.cursorPath)
      } catch {
        // Ignore errors when deleting
      }
    }
  }
}

// ============================================================================
// Memory Path Validation (NEW)
// ============================================================================

/**
 * Error thrown when path validation detects a traversal attempt.
 */
export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathTraversalError'
  }
}

/**
 * Validates memory paths for containment and safety.
 * Separates fast-path checks from execution-layer realpath validation.
 */
export class MemoryPathValidator {
  private readonly memoryDir: string
  private readonly normalizedMemoryDir: string

  constructor(memoryDir?: string) {
    this.memoryDir = memoryDir ?? dirname(getSessionMemoryPath())
    this.normalizedMemoryDir = join(this.memoryDir, '') // Ensure trailing separator
  }

  /**
   * Fast-path check: does the path look like it's within the memory directory?
   * Uses string-based checks only - no filesystem operations.
   * Can have false negatives (rejects safe paths), but no false positives.
   */
  isPlausiblyWithinMemoryDir(candidatePath: string): boolean {
    const normalized = join(candidatePath, '') // Ensure consistent separators
    return normalized.startsWith(this.normalizedMemoryDir)
  }

  /**
   * Execution-layer validation: confirms the real resolved path is within
   * the memory directory, following symlinks and resolving all path components.
   *
   * SECURITY: This performs actual filesystem operations and must be called
   * before any read/write operation on the path.
   *
   * @throws PathTraversalError if the path escapes the memory directory
   */
  async validateRealPathContainment(candidatePath: string): Promise<string> {
    const fs = getFsImplementation()

    // First pass: fast-path check without filesystem
    const resolved = join(candidatePath, '')
    if (!resolved.startsWith(this.normalizedMemoryDir)) {
      throw new PathTraversalError(
        `Path escapes memory directory: ${candidatePath}`,
      )
    }

    // Second pass: resolve symlinks on the deepest existing ancestor
    const realPath = await this.realpathDeepestExisting(resolved, fs)

    // Verify real path containment
    const realMemoryDir = await this.getRealMemoryDir(fs)
    if (!realPath.startsWith(realMemoryDir)) {
      throw new PathTraversalError(
        `Real path escapes memory directory: ${candidatePath} -> ${realPath}`,
      )
    }

    return realPath
  }

  /**
   * Gets the real path of the memory directory, resolving symlinks.
   */
  private async getRealMemoryDir(fs: any): Promise<string> {
    try {
      return await fs.realpath(this.memoryDir)
    } catch {
      // If memory dir doesn't exist yet, containment is trivially true
      // (no symlinks to escape through)
      return this.normalizedMemoryDir
    }
  }

  /**
   * Resolve symlinks for the deepest existing ancestor of a path.
   * The target file may not exist yet (we may be about to create it), so we
   * walk up the directory tree until realpath succeeds, then rejoin the
   * non-existing tail onto the resolved ancestor.
   */
  private async realpathDeepestExisting(absolutePath: string, fs: any): Promise<string> {
    const tail: string[] = []
    let current = absolutePath

    // Walk up until realpath succeeds or we hit root
    for (
      let parent = dirname(current);
      current !== parent;
      parent = dirname(current)
    ) {
      try {
        const realCurrent = await fs.realpath(current)
        // Rejoin the non-existing tail in reverse order (deepest popped first)
        return tail.length === 0
          ? realCurrent
          : join(realCurrent, ...tail.reverse())
      } catch (error: any) {
        const code = error?.code
        if (code === 'ENOENT') {
          // Could be truly non-existent (safe to walk up) OR a dangling symlink
          // whose target doesn't exist. Check if it's a symlink.
          try {
            const stats = await fs.lstat(current)
            if (stats.isSymbolicLink()) {
              throw new PathTraversalError(
                `Dangling symlink detected: ${current}`,
              )
            }
          } catch (lstatError: any) {
            if (lstatError instanceof PathTraversalError) {
              throw lstatError
            }
            // lstat also failed - truly non-existent, safe to walk up
          }
        } else if (code === 'ELOOP') {
          throw new PathTraversalError(
            `Symlink loop detected in path: ${current}`,
          )
        } else if (code && code !== 'ENOTDIR' && code !== 'ENAMETOOLONG') {
          throw new PathTraversalError(
            `Cannot verify path containment (${code}): ${current}`,
          )
        }

        // Pop the last segment and try the parent
        tail.push(current.slice(parent.length + 1))
        current = parent
      }
    }

    // Reached filesystem root without finding an existing ancestor
    return absolutePath
  }

  /**
   * Sanitizes a path key (e.g., from a server response) to prevent injection.
   * Rejects null bytes, URL-encoded traversals, Unicode normalization attacks, etc.
   */
  sanitizePathKey(key: string): string {
    // Null bytes can truncate paths in C-based syscalls
    if (key.includes('\0')) {
      throw new PathTraversalError(`Null byte in path key: ${key}`)
    }

    // URL-encoded traversals (e.g., %2e%2e%2f = ../)
    let decoded: string
    try {
      decoded = decodeURIComponent(key)
    } catch {
      // Malformed percent-encoding - not valid URL-encoding, so no traversal
      decoded = key
    }

    if (decoded !== key && (decoded.includes('../') || decoded.includes('/'))) {
      throw new PathTraversalError(`URL-encoded traversal in path key: ${key}`)
    }

    // Unicode normalization attacks: fullwidth ．．／ (U+FF0E U+FF0F) normalize
    // to ASCII ../ under NFKC.
    const normalized = key.normalize('NFKC')
    if (
      normalized !== key &&
      (normalized.includes('../') ||
        normalized.includes('/') ||
        normalized.includes('\\') ||
        normalized.includes('\0'))
    ) {
      throw new PathTraversalError(
        `Unicode-normalized traversal in path key: ${key}`,
      )
    }

    // Reject backslashes (Windows path separator used as traversal vector)
    if (key.includes('\\')) {
      throw new PathTraversalError(`Backslash in path key: ${key}`)
    }

    // Reject absolute paths
    if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
      throw new PathTraversalError(`Absolute path key: ${key}`)
    }

    // Reject path traversal segments
    if (key.includes('../') || key.includes('..\\')) {
      throw new PathTraversalError(`Path traversal in key: ${key}`)
    }

    return key
  }
}

// ============================================================================
// Global instances for backward compatibility (lazy-loaded to avoid circular deps)
// ============================================================================

let _globalCursorManager: SessionMemoryCursorManager | null = null
let _globalPathValidator: MemoryPathValidator | null = null

function getGlobalCursorManager(): SessionMemoryCursorManager {
  if (!_globalCursorManager) {
    _globalCursorManager = new SessionMemoryCursorManager()
  }
  return _globalCursorManager
}

function getGlobalPathValidator(): MemoryPathValidator {
  if (!_globalPathValidator) {
    _globalPathValidator = new MemoryPathValidator()
  }
  return _globalPathValidator
}

// Current session memory configuration
let sessionMemoryConfig: SessionMemoryConfig = {
  ...DEFAULT_SESSION_MEMORY_CONFIG,
}

// Track extraction state with timestamp (set by sessionMemory.ts)
let extractionStartedAt: number | undefined

// Track context size at last memory extraction (for minimumTokensBetweenUpdate)
let tokensAtLastExtraction = 0

// Track whether session memory has been initialized (met minimumMessageTokensToInit)
let sessionMemoryInitialized = false

/**
 * Get the message ID up to which the session memory is current.
 * Uses the atomic sidecar file for persistence.
 */
export function getLastSummarizedMessageId(): string | undefined {
  return getGlobalCursorManager().getLastSummarizedMessageId()
}

/**
 * Set the last summarized message ID (called from sessionMemory.ts).
 * Persists atomically to the sidecar file.
 */
export function setLastSummarizedMessageId(
  messageId: string | undefined,
  sessionId?: string,
): void {
  getGlobalCursorManager().setLastSummarizedMessageId(messageId, sessionId)
}

/**
 * Check for deleted memory files and invalidate cursor if needed.
 * Returns true if cursor was invalidated.
 */
export function checkAndInvalidateDeletedFiles(): boolean {
  return getGlobalCursorManager().checkAndInvalidateDeletedFiles()
}

/**
 * Validate a memory path for safe access.
 * Separates fast-path and realpath checks.
 */
export async function validateMemoryPath(path: string): Promise<string> {
  return await getGlobalPathValidator().validateRealPathContainment(path)
}

/**
 * Mark extraction as started (called from sessionMemory.ts)
 */
export function markExtractionStarted(): void {
  extractionStartedAt = Date.now()
}

/**
 * Mark extraction as completed (called from sessionMemory.ts)
 */
export function markExtractionCompleted(): void {
  extractionStartedAt = undefined
}

/**
 * Wait for any in-progress session memory extraction to complete (with 15s timeout)
 * Returns immediately if no extraction is in progress or extraction is stale (>1min old).
 */
export async function waitForSessionMemoryExtraction(): Promise<void> {
  const startTime = Date.now()
  while (extractionStartedAt) {
    const extractionAge = Date.now() - extractionStartedAt
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      return
    }

    if (Date.now() - startTime > EXTRACTION_WAIT_TIMEOUT_MS) {
      return
    }

    await sleep(1000)
  }
}

/**
 * Get the current session memory content
 */
export async function getSessionMemoryContent(): Promise<string | null> {
  const fs = getFsImplementation()
  const memoryPath = getSessionMemoryPath()

  try {
    const content = await fs.readFile(memoryPath, { encoding: 'utf-8' })

    logEvent('tengu_session_memory_loaded', {
      content_length: content.length,
    })

    return content
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * Set the session memory configuration
 */
export function setSessionMemoryConfig(
  config: Partial<SessionMemoryConfig>,
): void {
  sessionMemoryConfig = {
    ...sessionMemoryConfig,
    ...config,
  }
}

/**
 * Get the current session memory configuration
 */
export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...sessionMemoryConfig }
}

/**
 * Record the context size at the time of extraction.
 * Used to measure context growth for minimumTokensBetweenUpdate threshold.
 */
export function recordExtractionTokenCount(currentTokenCount: number): void {
  tokensAtLastExtraction = currentTokenCount
}

/**
 * Check if session memory has been initialized (met minimumTokensToInit threshold)
 */
export function isSessionMemoryInitialized(): boolean {
  return sessionMemoryInitialized
}

/**
 * Mark session memory as initialized
 */
export function markSessionMemoryInitialized(): void {
  sessionMemoryInitialized = true
}

/**
 * Check if we've met the threshold to initialize session memory.
 * Uses total context window tokens (same as autocompact) for consistent behavior.
 */
export function hasMetInitializationThreshold(
  currentTokenCount: number,
): boolean {
  return currentTokenCount >= sessionMemoryConfig.minimumMessageTokensToInit
}

/**
 * Check if we've met the threshold for the next update.
 * Measures actual context window growth since last extraction
 * (same metric as autocompact and initialization threshold).
 */
export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  const tokensSinceLastExtraction = currentTokenCount - tokensAtLastExtraction
  return (
    tokensSinceLastExtraction >= sessionMemoryConfig.minimumTokensBetweenUpdate
  )
}

/**
 * Get the configured number of tool calls between updates
 */
export function getToolCallsBetweenUpdates(): number {
  return sessionMemoryConfig.toolCallsBetweenUpdates
}

/**
 * Reset session memory state (useful for testing)
 */
export function resetSessionMemoryState(): void {
  sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }
  tokensAtLastExtraction = 0
  sessionMemoryInitialized = false
  extractionStartedAt = undefined
  if (_globalCursorManager) {
    _globalCursorManager.invalidate()
    _globalCursorManager = null
  }
  _globalPathValidator = null
}
