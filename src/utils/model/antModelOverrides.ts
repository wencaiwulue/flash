import type { EffortLevel } from '../effort.js'

export type AntModelInfo = {
  alias: string
  label: string
  model: string
  description?: string
  contextWindow?: number
  defaultMaxTokens?: number
  upperMaxTokensLimit?: number
  defaultEffortLevel?: EffortLevel
  defaultEffortValue?: number
}

export type AntModelOverrideConfig = {
  defaultModel?: string
  defaultModelEffortLevel?: EffortLevel
}

// Internal model catalogs are not bundled in the external build. Keeping the
// disabled result explicit prevents accidental fallback to private model IDs.
export function getAntModelOverrideConfig(): AntModelOverrideConfig | undefined {
  return undefined
}

export function getAntModels(): AntModelInfo[] {
  return []
}

export function resolveAntModel(_model: string): AntModelInfo | undefined {
  return undefined
}
