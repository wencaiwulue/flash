import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getMemoryPath } from '../../utils/config.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { markInternalWrite } from '../../utils/settings/internalWrites.js'
import { getSettingsFilePathForSource } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { SYNC_KEYS } from './types.js'

export const MAX_FILE_SIZE_BYTES = 500 * 1024

async function writeFileForSync(
  filePath: string,
  content: string,
): Promise<boolean> {
  try {
    const parentDir = dirname(filePath)
    if (parentDir) {
      await mkdir(parentDir, { recursive: true })
    }

    await writeFile(filePath, content, 'utf8')
    logForDiagnosticsNoPII('info', 'settings_sync_file_written')
    return true
  } catch {
    logForDiagnosticsNoPII('warn', 'settings_sync_file_write_failed')
    return false
  }
}

/**
 * Apply remote entries to local files (CCR pull pattern).
 * Only writes files that match expected keys.
 *
 * After writing, invalidates relevant caches:
 * - resetSettingsCache() for settings files
 * - clearMemoryFileCaches() for memory files (CLAUDE.md)
 */
export async function applyRemoteEntriesToLocal(
  entries: Record<string, string>,
  projectId: string | null,
): Promise<void> {
  let appliedCount = 0
  let settingsWritten = false
  let memoryWritten = false

  // Helper to check size limit (defense-in-depth, matches backend limit)
  const exceedsSizeLimit = (content: string, _path: string): boolean => {
    const sizeBytes = Buffer.byteLength(content, 'utf8')
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      logForDiagnosticsNoPII('info', 'settings_sync_file_too_large', {
        sizeBytes,
        maxBytes: MAX_FILE_SIZE_BYTES,
      })
      return true
    }
    return false
  }

  // Apply global user settings
  const userSettingsContent = entries[SYNC_KEYS.USER_SETTINGS]
  if (userSettingsContent) {
    const userSettingsPath = getSettingsFilePathForSource('userSettings')
    if (
      userSettingsPath &&
      !exceedsSizeLimit(userSettingsContent, userSettingsPath)
    ) {
      // Mark as internal write to prevent spurious change detection
      markInternalWrite(userSettingsPath)
      if (await writeFileForSync(userSettingsPath, userSettingsContent)) {
        appliedCount++
        settingsWritten = true
      }
    }
  }

  // Apply global user memory
  const userMemoryContent = entries[SYNC_KEYS.USER_MEMORY]
  if (userMemoryContent) {
    const userMemoryPath = getMemoryPath('User')
    if (!exceedsSizeLimit(userMemoryContent, userMemoryPath)) {
      if (await writeFileForSync(userMemoryPath, userMemoryContent)) {
        appliedCount++
        memoryWritten = true
      }
    }
  }

  // Apply project-specific files (only if project ID matches)
  if (projectId) {
    const projectSettingsKey = SYNC_KEYS.projectSettings(projectId)
    const projectSettingsContent = entries[projectSettingsKey]
    if (projectSettingsContent) {
      const localSettingsPath = getSettingsFilePathForSource('localSettings')
      if (
        localSettingsPath &&
        !exceedsSizeLimit(projectSettingsContent, localSettingsPath)
      ) {
        // Mark as internal write to prevent spurious change detection
        markInternalWrite(localSettingsPath)
        if (await writeFileForSync(localSettingsPath, projectSettingsContent)) {
          appliedCount++
          settingsWritten = true
        }
      }
    }

    const projectMemoryKey = SYNC_KEYS.projectMemory(projectId)
    const projectMemoryContent = entries[projectMemoryKey]
    if (projectMemoryContent) {
      const localMemoryPath = getMemoryPath('Local')
      if (!exceedsSizeLimit(projectMemoryContent, localMemoryPath)) {
        if (await writeFileForSync(localMemoryPath, projectMemoryContent)) {
          appliedCount++
          memoryWritten = true
        }
      }
    }
  }

  // Invalidate caches so subsequent reads pick up new content
  if (settingsWritten) {
    resetSettingsCache()
  }
  if (memoryWritten) {
    clearMemoryFileCaches()
  }

  logForDiagnosticsNoPII('info', 'settings_sync_applied', {
    appliedCount,
  })
}
