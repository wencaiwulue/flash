import { getInitialSettings } from '../settings/settings.js'
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

/* eslint-disable @typescript-eslint/no-require-imports */
function getInternalModels(): typeof import('./antModels.js') | null {
  // Keep the existing internal flag-backed catalog available to ant builds.
  // External builds eliminate this branch and only read public settings.
  return process.env.USER_TYPE === 'ant'
    ? (require('./antModels.js') as typeof import('./antModels.js'))
    : null
}
/* eslint-enable @typescript-eslint/no-require-imports */

export function getAntModelOverrideConfig(): AntModelOverrideConfig | undefined {
  const internal = getInternalModels()?.getAntModelOverrideConfig()
  if (internal) {
    return internal
  }
  return getInitialSettings().modelCatalog
}

export function getAntModels(): AntModelInfo[] {
  const internal = getInternalModels()
  if (internal) {
    const models = internal.getAntModels()
    if (models.length > 0) {
      return models
    }
  }
  return getInitialSettings().modelCatalog?.models ?? []
}

export function resolveAntModel(
  model: string | undefined,
): AntModelInfo | undefined {
  if (model === undefined) {
    return undefined
  }
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/\[1m]$/i, '')
    .trim()
  if (!normalized) {
    return undefined
  }
  return getAntModels().find(candidate => {
    const alias = candidate.alias.toLowerCase()
    const modelId = candidate.model.toLowerCase()
    return (
      alias === normalized ||
      modelId === normalized ||
      normalized.includes(modelId)
    )
  })
}
