export type CacheEditsBlock = {
  type: 'cache_edits'
  edits: Array<{ type: 'delete'; cache_reference: string }>
}

export type PinnedCacheEdits = {
  userMessageIndex: number
  block: CacheEditsBlock
}

export type CachedMCState = {
  registeredTools: Set<string>
  toolOrder: string[]
  deletedRefs: Set<string>
  pinnedEdits: PinnedCacheEdits[]
}

export type CachedMicrocompactConfig = {
  supportedModels: readonly string[]
  triggerThreshold: number
  keepRecent: number
}

const DISABLED_CONFIG: CachedMicrocompactConfig = {
  supportedModels: [],
  triggerThreshold: 0,
  keepRecent: 0,
}

export function isCachedMicrocompactEnabled(): boolean {
  return false
}

export function isModelSupportedForCacheEditing(_model: string): boolean {
  return false
}

export function getCachedMCConfig(): CachedMicrocompactConfig {
  return DISABLED_CONFIG
}

export function createCachedMCState(): CachedMCState {
  return {
    registeredTools: new Set(),
    toolOrder: [],
    deletedRefs: new Set(),
    pinnedEdits: [],
  }
}

export function registerToolResult(
  _state: CachedMCState,
  _toolUseId: string,
): void {
  // Cached microcompact is disabled; do not track results for deletion.
}

export function registerToolMessage(
  _state: CachedMCState,
  _groupIds: string[],
): void {
  // Cached microcompact is disabled; do not track results for deletion.
}

export function getToolResultsToDelete(_state: CachedMCState): string[] {
  return []
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  _toolUseIds: string[],
): CacheEditsBlock | null {
  return null
}

export function markToolsSentToAPI(_state: CachedMCState): void {
  // Disabled: there are no registered tools to mark.
}

export function resetCachedMCState(_state: CachedMCState): void {
  // Disabled: no cached-microcompact tracking is retained.
}
