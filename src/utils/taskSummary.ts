import type { CacheSafeParams } from './forkedAgent.js'

export function shouldGenerateTaskSummary(): boolean {
  return false
}

export function maybeGenerateTaskSummary(_params: CacheSafeParams): void {
  // Background task summaries are disabled in this build.
}
