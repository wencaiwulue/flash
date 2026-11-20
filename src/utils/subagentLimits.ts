/**
 * Subagent spawn limits (upstream 2.1.311):
 * - CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (default 20): cap on simultaneously
 *   running in-process subagents.
 * - CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3): cap on nesting depth
 *   (main thread = 0, first-level subagent = 1, ...).
 *
 * CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION was removed upstream and is a no-op;
 * it is intentionally NOT implemented here.
 */

import { getAgentContext } from './agentContext.js'

export function getMaxConcurrentSubagents(): number {
  const raw = Number(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20
}

export function getMaxSubagentSpawnDepth(): number {
  const raw = Number(process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3
}

let activeCount = 0

export function getActiveSubagentCount(): number {
  return activeCount
}

export class SubagentLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubagentLimitError'
  }
}

/** Nesting depth of the calling agent (0 = main thread). */
export function getCurrentSubagentDepth(): number {
  return getAgentContext()?.depth ?? 0
}

/**
 * Acquire a concurrency slot for a new subagent at `depth`. Throws
 * SubagentLimitError when the depth or concurrency cap is exceeded. Returns a
 * release function to invoke when the subagent finishes.
 */
export function acquireSubagentSlot(depth: number): () => void {
  const maxDepth = getMaxSubagentSpawnDepth()
  if (depth > maxDepth) {
    throw new SubagentLimitError(
      `Subagent spawn depth ${depth} exceeds CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (${maxDepth})`,
    )
  }
  const maxConcurrent = getMaxConcurrentSubagents()
  if (activeCount >= maxConcurrent) {
    throw new SubagentLimitError(
      `Concurrent subagent limit reached (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=${maxConcurrent})`,
    )
  }
  activeCount++
  let released = false
  return () => {
    if (!released) {
      released = true
      activeCount--
    }
  }
}
