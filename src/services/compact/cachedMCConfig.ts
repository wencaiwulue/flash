export type CachedMCConfig = {
  enabled: boolean
  systemPromptSuggestSummaries: boolean
  supportedModels: readonly string[]
  triggerThreshold: number
  keepRecent: number
}

const DISABLED_CONFIG: CachedMCConfig = {
  enabled: false,
  systemPromptSuggestSummaries: false,
  supportedModels: [],
  triggerThreshold: 0,
  keepRecent: 0,
}

/** Cached microcompaction is not included in this build. */
export function getCachedMCConfig(): CachedMCConfig {
  return DISABLED_CONFIG
}
