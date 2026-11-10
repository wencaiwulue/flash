/**
 * File persistence orchestrator
 *
 * This module provides the main orchestration logic for persisting files
 * at the end of each turn:
 * - BYOC mode: Upload files to Files API and collect file IDs
 * - 1P/Cloud mode: Query Files API listDirectory for file IDs (rclone handles sync)
 */

import { feature } from 'bun:bundle'
import { lstat } from 'fs/promises'
import { isAbsolute, join, posix, relative, sep } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  type FileMetadata,
  type FilesApiConfig,
  listFilesCreatedAfter,
  uploadSessionFiles,
} from '../../services/api/filesApi.js'
import { getCwd } from '../cwd.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { getSessionIngressAuthToken } from '../sessionIngressAuth.js'
import { sleep } from '../sleep.js'
import {
  findModifiedFiles,
  getEnvironmentKind,
  logDebug,
} from './outputsScanner.js'
import {
  DEFAULT_UPLOAD_CONCURRENCY,
  type FailedPersistence,
  FILE_COUNT_LIMIT,
  type FilesPersistedEventData,
  OUTPUTS_SUBDIR,
  type PersistedFile,
  type TurnStartTime,
} from './types.js'

/**
 * Execute file persistence for modified files in the outputs directory.
 *
 * Assembles all config internally:
 * - Checks environment kind (CLAUDE_CODE_ENVIRONMENT_KIND)
 * - Retrieves session access token
 * - Requires CLAUDE_CODE_REMOTE_SESSION_ID for session ID
 *
 * @param turnStartTime - The timestamp when the turn started
 * @param signal - Optional abort signal for cancellation
 * @returns Event data, or null if not enabled or no files to persist
 */
export async function runFilePersistence(
  turnStartTime: TurnStartTime,
  signal?: AbortSignal,
): Promise<FilesPersistedEventData | null> {
  const environmentKind = getEnvironmentKind()
  if (environmentKind !== 'byoc' && environmentKind !== 'anthropic_cloud') {
    return null
  }

  const sessionAccessToken = getSessionIngressAuthToken()
  if (!sessionAccessToken) {
    return null
  }

  const sessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  if (!sessionId) {
    logError(
      new Error(
        'File persistence enabled but CLAUDE_CODE_REMOTE_SESSION_ID is not set',
      ),
    )
    return null
  }

  const config: FilesApiConfig = {
    oauthToken: sessionAccessToken,
    sessionId,
  }

  const outputsDir = join(getCwd(), sessionId, OUTPUTS_SUBDIR)

  // Check if aborted
  if (signal?.aborted) {
    logDebug('Persistence aborted before processing')
    return null
  }

  const startTime = Date.now()
  logEvent('tengu_file_persistence_started', {
    mode: environmentKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  try {
    let result: FilesPersistedEventData
    if (environmentKind === 'byoc') {
      result = await executeBYOCPersistence(
        turnStartTime,
        config,
        outputsDir,
        signal,
      )
    } else {
      result = await executeCloudPersistence(
        turnStartTime,
        config,
        outputsDir,
        signal,
      )
    }

    // Nothing to report
    if (result.files.length === 0 && result.failed.length === 0) {
      return null
    }

    const durationMs = Date.now() - startTime
    logEvent('tengu_file_persistence_completed', {
      success_count: result.files.length,
      failure_count: result.failed.length,
      duration_ms: durationMs,
      mode: environmentKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    return result
  } catch (error) {
    if (signal?.aborted) {
      logDebug('File persistence aborted')
      return null
    }

    logError(error)
    logDebug(`File persistence failed: ${error}`)

    const durationMs = Date.now() - startTime
    logEvent('tengu_file_persistence_completed', {
      success_count: 0,
      failure_count: 0,
      duration_ms: durationMs,
      mode: environmentKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error:
        'exception' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    return {
      files: [],
      failed: [
        {
          filename: outputsDir,
          error: errorMessage(error),
        },
      ],
    }
  }
}

/**
 * Execute BYOC mode persistence: scan local filesystem for modified files,
 * then upload to Files API.
 */
async function executeBYOCPersistence(
  turnStartTime: TurnStartTime,
  config: FilesApiConfig,
  outputsDir: string,
  signal?: AbortSignal,
): Promise<FilesPersistedEventData> {
  // Find modified files via local filesystem scan
  // Uses same directory structure as downloads: {cwd}/{sessionId}/outputs
  const modifiedFiles = await findModifiedFiles(turnStartTime, outputsDir)

  if (modifiedFiles.length === 0) {
    logDebug('No modified files to persist')
    return { files: [], failed: [] }
  }

  logDebug(`Found ${modifiedFiles.length} modified files`)

  if (signal?.aborted) {
    return { files: [], failed: [] }
  }

  // Enforce file count limit
  if (modifiedFiles.length > FILE_COUNT_LIMIT) {
    logDebug(
      `File count limit exceeded: ${modifiedFiles.length} > ${FILE_COUNT_LIMIT}`,
    )
    logEvent('tengu_file_persistence_limit_exceeded', {
      file_count: modifiedFiles.length,
      limit: FILE_COUNT_LIMIT,
    })
    return {
      files: [],
      failed: [
        {
          filename: outputsDir,
          error: `Too many files modified (${modifiedFiles.length}). Maximum: ${FILE_COUNT_LIMIT}.`,
        },
      ],
    }
  }

  const filesToProcess = modifiedFiles
    .map(filePath => ({
      path: filePath,
      relativePath: relative(outputsDir, filePath),
    }))
    .filter(({ relativePath }) => {
      // Security: skip files that resolve outside the outputs directory
      if (relativePath.startsWith('..')) {
        logDebug(`Skipping file outside outputs directory: ${relativePath}`)
        return false
      }
      return true
    })

  logDebug(`BYOC mode: uploading ${filesToProcess.length} files`)

  // Upload files in parallel
  const results = await uploadSessionFiles(
    filesToProcess,
    config,
    DEFAULT_UPLOAD_CONCURRENCY,
  )

  // Separate successful and failed uploads
  const persistedFiles: PersistedFile[] = []
  const failedFiles: FailedPersistence[] = []

  for (const result of results) {
    if (result.success) {
      persistedFiles.push({
        filename: result.path,
        file_id: result.fileId,
      })
    } else {
      failedFiles.push({
        filename: result.path,
        error: result.error,
      })
    }
  }

  logDebug(
    `BYOC persistence complete: ${persistedFiles.length} uploaded, ${failedFiles.length} failed`,
  )

  return {
    files: persistedFiles,
    failed: failedFiles,
  }
}

const CLOUD_INDEX_MAX_ATTEMPTS = 3
const CLOUD_INDEX_BASE_DELAY_MS = 250

type CloudFileToMatch = {
  relativePath: string
  size: number
}

/**
 * Normalize both local and API paths to a portable relative path. Absolute
 * paths, traversal, and platform-specific drive paths are never valid keys.
 */
function normalizeCloudRelativePath(
  filePath: string,
  normalizeBackslashes = true,
): string | null {
  if (!filePath || filePath.includes('\0') || filePath.endsWith('/')) {
    return null
  }

  const slashPath = normalizeBackslashes
    ? filePath.replaceAll('\\', '/')
    : filePath
  if (posix.isAbsolute(slashPath) || /^[a-zA-Z]:/.test(slashPath)) {
    return null
  }

  const normalized = posix.normalize(slashPath)
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    posix.isAbsolute(normalized)
  ) {
    return null
  }
  return normalized
}

function getOutputsRelativePath(
  outputsDir: string,
  filePath: string,
): string | null {
  const relativePath = relative(outputsDir, filePath)
  if (!relativePath || isAbsolute(relativePath)) {
    return null
  }
  // Only the platform separator is structural locally. On POSIX, a backslash
  // can be part of a filename and must not be conflated with a nested path.
  return normalizeCloudRelativePath(relativePath.split(sep).join('/'), false)
}

/**
 * Execute Cloud (1P) mode persistence. Cloud storage synchronization handles
 * the bytes; this discovers file IDs through the Files API and correlates them
 * with locally modified outputs by normalized relative path.
 */
async function executeCloudPersistence(
  turnStartTime: TurnStartTime,
  config: FilesApiConfig,
  outputsDir: string,
  signal?: AbortSignal,
): Promise<FilesPersistedEventData> {
  const modifiedFiles = await findModifiedFiles(turnStartTime, outputsDir)
  if (modifiedFiles.length === 0) {
    logDebug('No modified files to persist')
    return { files: [], failed: [] }
  }
  if (signal?.aborted) {
    return { files: [], failed: [] }
  }

  if (modifiedFiles.length > FILE_COUNT_LIMIT) {
    logDebug(
      `File count limit exceeded: ${modifiedFiles.length} > ${FILE_COUNT_LIMIT}`,
    )
    logEvent('tengu_file_persistence_limit_exceeded', {
      file_count: modifiedFiles.length,
      limit: FILE_COUNT_LIMIT,
    })
    return {
      files: [],
      failed: [
        {
          filename: outputsDir,
          error: `Too many files modified (${modifiedFiles.length}). Maximum: ${FILE_COUNT_LIMIT}.`,
        },
      ],
    }
  }

  const candidates = modifiedFiles.flatMap(filePath => {
    const relativePath = getOutputsRelativePath(outputsDir, filePath)
    if (!relativePath) {
      logDebug(`Skipping file outside outputs directory: ${filePath}`)
      return []
    }
    return [{ path: filePath, relativePath }]
  })

  // Re-check with lstat before trusting local metadata. This also supplies an
  // auxiliary size check without using size as the file identity.
  const checkedFiles = await Promise.all(
    candidates.map(async candidate => {
      try {
        const stat = await lstat(candidate.path)
        if (!stat.isFile() || stat.isSymbolicLink()) {
          logDebug(`Skipping non-regular output file: ${candidate.path}`)
          return { candidate, size: null, error: null }
        }
        return { candidate, size: stat.size, error: null }
      } catch (error) {
        return { candidate, size: null, error: errorMessage(error) }
      }
    }),
  )

  if (signal?.aborted) {
    return { files: [], failed: [] }
  }

  const filesToMatch: CloudFileToMatch[] = []
  const persistedFiles: PersistedFile[] = []
  const failedFiles: FailedPersistence[] = []
  for (const checked of checkedFiles) {
    if (checked.error) {
      failedFiles.push({
        filename: checked.candidate.relativePath,
        error: checked.error,
      })
    } else if (checked.size !== null) {
      filesToMatch.push({
        relativePath: checked.candidate.relativePath,
        size: checked.size,
      })
    }
  }

  const pending = new Map(
    filesToMatch.map(file => [file.relativePath, file] as const),
  )
  const afterCreatedAt = new Date(turnStartTime).toISOString()

  for (
    let attempt = 1;
    attempt <= CLOUD_INDEX_MAX_ATTEMPTS && pending.size > 0;
    attempt++
  ) {
    if (signal?.aborted) {
      return { files: [], failed: [] }
    }

    let listedFiles: FileMetadata[]
    try {
      listedFiles = await listFilesCreatedAfter(afterCreatedAt, config, {
        signal,
      })
    } catch (error) {
      if (signal?.aborted) {
        return { files: [], failed: [] }
      }
      const message = `Failed to list Cloud files: ${errorMessage(error)}`
      logDebug(message)
      for (const relativePath of pending.keys()) {
        failedFiles.push({ filename: relativePath, error: message })
      }
      pending.clear()
      break
    }

    if (signal?.aborted) {
      return { files: [], failed: [] }
    }

    // Ignore unrelated session files. Repeated copies of the same path/ID are
    // harmless, but conflicting IDs (or one ID at multiple paths) are not.
    const metadataByPath = new Map<string, Map<string, number[]>>()
    const pathsById = new Map<string, Set<string>>()
    for (const metadata of listedFiles) {
      if (
        typeof metadata.filename !== 'string' ||
        typeof metadata.fileId !== 'string' ||
        !metadata.fileId
      ) {
        continue
      }
      const relativePath = normalizeCloudRelativePath(metadata.filename)
      if (!relativePath || !pending.has(relativePath)) {
        continue
      }

      let byId = metadataByPath.get(relativePath)
      if (!byId) {
        byId = new Map<string, number[]>()
        metadataByPath.set(relativePath, byId)
      }
      const sizes = byId.get(metadata.fileId) ?? []
      sizes.push(metadata.size)
      byId.set(metadata.fileId, sizes)

      const paths = pathsById.get(metadata.fileId) ?? new Set<string>()
      paths.add(relativePath)
      pathsById.set(metadata.fileId, paths)
    }

    for (const [relativePath, file] of pending) {
      const matches = metadataByPath.get(relativePath)
      if (!matches || matches.size === 0) {
        continue
      }

      const hasCrossPathConflict = [...matches.keys()].some(
        fileId => (pathsById.get(fileId)?.size ?? 0) > 1,
      )
      if (matches.size !== 1 || hasCrossPathConflict) {
        failedFiles.push({
          filename: relativePath,
          error: `Ambiguous Cloud file metadata for ${relativePath}: multiple file IDs or output paths match`,
        })
        pending.delete(relativePath)
        continue
      }

      const match = [...matches.entries()][0]
      if (!match) {
        continue
      }
      const [fileId, sizes] = match
      const knownSizes = sizes.filter(size => Number.isFinite(size))
      if (knownSizes.length > 0 && !knownSizes.includes(file.size)) {
        failedFiles.push({
          filename: relativePath,
          error: `Cloud file size mismatch for ${relativePath}: local ${file.size} bytes, remote ${knownSizes.join('/')} bytes`,
        })
        pending.delete(relativePath)
        continue
      }

      persistedFiles.push({ filename: relativePath, file_id: fileId })
      pending.delete(relativePath)
    }

    if (pending.size === 0) {
      break
    }

    if (attempt === CLOUD_INDEX_MAX_ATTEMPTS) {
      for (const relativePath of pending.keys()) {
        failedFiles.push({
          filename: relativePath,
          error: `No matching Cloud file metadata after ${CLOUD_INDEX_MAX_ATTEMPTS} attempts`,
        })
      }
      pending.clear()
      break
    }

    const delayMs = CLOUD_INDEX_BASE_DELAY_MS * Math.pow(2, attempt - 1)
    logDebug(
      `Cloud file index is missing ${pending.size} output(s); retrying in ${delayMs}ms`,
    )
    await sleep(delayMs, signal)
  }

  if (signal?.aborted) {
    return { files: [], failed: [] }
  }

  logDebug(
    `Cloud persistence complete: ${persistedFiles.length} matched, ${failedFiles.length} failed`,
  )
  return { files: persistedFiles, failed: failedFiles }
}

/**
 * Execute file persistence and emit result via callback.
 * Handles errors internally.
 */
export async function executeFilePersistence(
  turnStartTime: TurnStartTime,
  signal: AbortSignal,
  onResult: (result: FilesPersistedEventData) => void,
): Promise<void> {
  try {
    const result = await runFilePersistence(turnStartTime, signal)
    if (result) {
      onResult(result)
    }
  } catch (error) {
    logError(error)
  }
}

/**
 * Check if file persistence is enabled.
 * Requires: feature flag ON, valid environment kind, session access token,
 * and CLAUDE_CODE_REMOTE_SESSION_ID.
 * This ensures only public-api/sessions users trigger file persistence,
 * not normal Claude Code CLI users.
 */
export function isFilePersistenceEnabled(): boolean {
  if (feature('FILE_PERSISTENCE')) {
    const environmentKind = getEnvironmentKind()
    return (
      (environmentKind === 'byoc' || environmentKind === 'anthropic_cloud') &&
      !!getSessionIngressAuthToken() &&
      !!process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    )
  }
  return false
}
