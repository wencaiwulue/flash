import type { Message, UserMessage } from '../../types/message.js'

export type ContextCollapseStats = {
  collapsedSpans: number
  collapsedMessages: number
  stagedSpans: number
  health: {
    totalSpawns: number
    totalErrors: number
    totalEmptySpawns: number
    emptySpawnWarningEmitted: boolean
    lastError?: string
  }
}

export type CommittedCollapse = {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
  summaryMessage: UserMessage
  archived: Message[]
}

export type StagedCollapse = {
  startUuid: string
  endUuid: string
  summary: string
  risk: number
  stagedAt: number
  messages: Message[]
}

/**
 * Session-scoped context collapse state.
 * This replaces the module-level mutable state while maintaining backward compatibility.
 */
export class ContextCollapseState {
  committed: CommittedCollapse[] = []
  staged: StagedCollapse[] = []
  nextId = 1
  armed = false
  lastSpawnTokens = 0
  health = {
    totalSpawns: 0,
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
    lastError: undefined as string | undefined,
  }

  private listeners = new Set<() => void>()

  notifyListeners(): void {
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  reset(): void {
    this.committed = []
    this.staged = []
    this.nextId = 1
    this.armed = false
    this.lastSpawnTokens = 0
    this.health = {
      totalSpawns: 0,
      totalErrors: 0,
      totalEmptySpawns: 0,
      emptySpawnWarningEmitted: false,
      lastError: undefined,
    }
    this.notifyListeners()
  }

  getStats(): ContextCollapseStats {
    return {
      collapsedSpans: this.committed.length,
      collapsedMessages: this.committed.reduce(
        (total, commit) => total + (commit.archived?.length ?? 0),
        0,
      ),
      stagedSpans: this.staged.length,
      health: { ...this.health },
    }
  }

  snapshot() {
    return {
      staged: this.staged.map(stage => ({
        startUuid: stage.startUuid,
        endUuid: stage.endUuid,
        summary: stage.summary,
        risk: stage.risk,
        stagedAt: stage.stagedAt,
      })),
      armed: this.armed,
      lastSpawnTokens: this.lastSpawnTokens,
    }
  }
}

// ============================================================================
// Legacy compatibility layer (for backward compatibility)
// DEPRECATED: Use ContextCollapseState class instead
// ============================================================================

export const collapseStore = {
  committed: [] as CommittedCollapse[],
  staged: [] as StagedCollapse[],
  nextId: 1,
  armed: false,
  lastSpawnTokens: 0,
  health: {
    totalSpawns: 0,
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
    lastError: undefined as string | undefined,
  },
}

const legacyListeners = new Set<() => void>()

export function notifyCollapseListeners(): void {
  for (const listener of legacyListeners) listener()
}

export function subscribeToCollapses(listener: () => void): () => void {
  legacyListeners.add(listener)
  return () => {
    legacyListeners.delete(listener)
  }
}

export function resetCollapseStore(): void {
  collapseStore.committed = []
  collapseStore.staged = []
  collapseStore.nextId = 1
  collapseStore.armed = false
  collapseStore.lastSpawnTokens = 0
  collapseStore.health = {
    totalSpawns: 0,
    totalErrors: 0,
    totalEmptySpawns: 0,
    emptySpawnWarningEmitted: false,
    lastError: undefined,
  }
  notifyCollapseListeners()
}

export function getCollapseStats(): ContextCollapseStats {
  return {
    collapsedSpans: collapseStore.committed.length,
    collapsedMessages: collapseStore.committed.reduce(
      (total, commit) => total + (commit.archived?.length ?? 0),
      0,
    ),
    stagedSpans: collapseStore.staged.length,
    health: { ...collapseStore.health },
  }
}
