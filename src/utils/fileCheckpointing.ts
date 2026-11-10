import type { UUID } from 'crypto'
import type { RewindFilesResult } from '../entrypoints/sdk/coreTypes.js'
import { errorMessage } from './errors.js'
import {
  type FileHistoryState,
  fileHistoryCanRestore,
  fileHistoryEnabledForState,
  fileHistoryGetDiffStats,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
} from './fileHistory.js'

export type UpdateFileHistoryState = (
  updater: (previous: FileHistoryState) => FileHistoryState,
) => void

/** Shared CLI/SDK rewind behavior. Dry runs only inspect backups and files. */
export async function rewindFileCheckpoint(
  userMessageId: UUID,
  state: FileHistoryState,
  updateFileHistoryState: UpdateFileHistoryState,
  dryRun: boolean,
): Promise<RewindFilesResult> {
  if (!fileHistoryEnabledForState(state)) {
    return { canRewind: false, error: 'File rewinding is not enabled.' }
  }
  if (!fileHistoryCanRestore(state, userMessageId)) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
    }
  }

  if (dryRun) {
    const diffStats = await fileHistoryGetDiffStats(state, userMessageId)
    return {
      canRewind: true,
      filesChanged: diffStats?.filesChanged,
      insertions: diffStats?.insertions,
      deletions: diffStats?.deletions,
    }
  }

  try {
    await fileHistoryRewind(updateFileHistoryState, userMessageId)
  } catch (error) {
    return {
      canRewind: false,
      error: `Failed to rewind: ${errorMessage(error)}`,
    }
  }

  return { canRewind: true }
}

/** Per-query snapshot bookkeeping; no process-global checkpoint configuration. */
export class FileCheckpointing {
  readonly #pendingSnapshots = new Map<string, Promise<void>>()
  readonly #getState: () => FileHistoryState
  readonly #updateState: UpdateFileHistoryState
  readonly #makeSnapshot: typeof fileHistoryMakeSnapshot

  constructor(
    getState: () => FileHistoryState,
    updateState: UpdateFileHistoryState,
    makeSnapshot = fileHistoryMakeSnapshot,
  ) {
    this.#getState = getState
    this.#updateState = updateState
    this.#makeSnapshot = makeSnapshot
  }

  makeSnapshot(messageId: UUID): Promise<void> {
    const existing = this.#pendingSnapshots.get(messageId)
    if (existing) return existing

    // Register before starting async work so rewindFiles can always await the
    // exact snapshot associated with this user message.
    const pending = Promise.resolve().then(() =>
      this.#makeSnapshot(this.#updateState, messageId),
    )
    this.#pendingSnapshots.set(messageId, pending)
    return pending
  }

  async rewindFiles(
    userMessageId: string,
    options: { dryRun?: boolean } = {},
  ): Promise<RewindFilesResult> {
    const pending = this.#pendingSnapshots.get(userMessageId)
    if (pending) {
      try {
        await pending
      } catch (error) {
        return {
          canRewind: false,
          error: `Failed to create file checkpoint: ${errorMessage(error)}`,
        }
      }
    }

    return rewindFileCheckpoint(
      userMessageId as UUID,
      this.#getState(),
      this.#updateState,
      options.dryRun ?? false,
    )
  }
}
