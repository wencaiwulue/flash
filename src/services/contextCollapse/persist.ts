import type {
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
} from '../../types/logs.js'

export function restoreFromEntries(
  _commits: ContextCollapseCommitEntry[],
  _snapshot: ContextCollapseSnapshotEntry | undefined,
): void {
  // Context collapse is disabled in this build; there is no store to restore.
}
