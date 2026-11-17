import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  collapseStore,
  ContextCollapseState,
  notifyCollapseListeners,
  resetCollapseStore,
} from './store.js'

/**
 * Restore context collapse state to the legacy module-level store.
 * DEPRECATED: Use restoreStateFromEntries with a ContextCollapseState instead.
 */
export function restoreFromEntries(
  commits: ContextCollapseCommitEntry[],
  snapshot: ContextCollapseSnapshotEntry | undefined,
): void {
  resetCollapseStore()
  let maximumId = 0
  for (const commit of commits) {
    maximumId = Math.max(maximumId, Number(commit.collapseId) || 0)
    collapseStore.committed.push({
      collapseId: commit.collapseId,
      summaryUuid: commit.summaryUuid,
      summaryContent: commit.summaryContent,
      summary: commit.summary,
      firstArchivedUuid: commit.firstArchivedUuid,
      lastArchivedUuid: commit.lastArchivedUuid,
      summaryMessage: createUserMessage({
        content: commit.summaryContent,
        uuid: commit.summaryUuid,
        isMeta: true,
      }),
      archived: [],
    })
  }
  collapseStore.nextId = maximumId + 1
  if (snapshot) {
    collapseStore.staged = snapshot.staged.map(stage => ({
      ...stage,
      messages: [],
    }))
    collapseStore.armed = snapshot.armed
    collapseStore.lastSpawnTokens = snapshot.lastSpawnTokens
  }
  notifyCollapseListeners()
}

/**
 * Restore context collapse state to a specific ContextCollapseState instance.
 * Optionally filters by sessionId to only restore entries for that session.
 */
export function restoreStateFromEntries(
  state: ContextCollapseState,
  commits: ContextCollapseCommitEntry[],
  snapshot: ContextCollapseSnapshotEntry | undefined,
  options?: { sessionId?: string },
): void {
  state.reset()

  const filteredCommits = options?.sessionId
    ? commits.filter(c => c.sessionId === options.sessionId)
    : commits

  let maximumId = 0
  for (const commit of filteredCommits) {
    maximumId = Math.max(maximumId, Number(commit.collapseId) || 0)
    state.committed.push({
      collapseId: commit.collapseId,
      summaryUuid: commit.summaryUuid,
      summaryContent: commit.summaryContent,
      summary: commit.summary,
      firstArchivedUuid: commit.firstArchivedUuid,
      lastArchivedUuid: commit.lastArchivedUuid,
      summaryMessage: createUserMessage({
        content: commit.summaryContent,
        uuid: commit.summaryUuid,
        isMeta: true,
      }),
      archived: [],
    })
  }
  state.nextId = maximumId + 1

  // Only apply snapshot if it matches the sessionId (or no sessionId specified)
  if (
    snapshot &&
    (!options?.sessionId || snapshot.sessionId === options.sessionId)
  ) {
    state.staged = snapshot.staged.map(stage => ({
      ...stage,
      messages: [],
    }))
    state.armed = snapshot.armed
    state.lastSpawnTokens = snapshot.lastSpawnTokens
  }

  state.notifyListeners()
}
