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

const listeners = new Set<() => void>()

export function notifyCollapseListeners(): void {
  for (const listener of listeners) listener()
}

export function subscribeToCollapses(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
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
      (total, commit) => total + commit.archived.length,
      0,
    ),
    stagedSpans: collapseStore.staged.length,
    health: { ...collapseStore.health },
  }
}
