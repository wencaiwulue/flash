import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  collapseStore,
  notifyCollapseListeners,
  resetCollapseStore,
} from './store.js'

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
