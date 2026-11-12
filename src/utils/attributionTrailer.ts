import type {
  AttributionData,
  AttributionState,
} from './commitAttribution.js'

function nonNegativeDelta(current: number, atLastCommit: number): number {
  return Math.max(0, Math.trunc(current) - Math.trunc(atLastCommit))
}

/** Public, path-free statistics shared by commit and PR attribution. */
export function buildPRTrailers(
  data: AttributionData,
  state: AttributionState,
): string[] {
  const trailers: string[] = []
  if (data.summary.claudeChars > 0 || data.summary.humanChars > 0) {
    const percent = Number.isFinite(data.summary.claudePercent)
      ? Math.min(100, Math.max(0, Math.round(data.summary.claudePercent)))
      : 0
    trailers.push(`Claude-Code-Contribution: ${percent}`)
  }

  const counts: Array<[string, number]> = [
    [
      'Claude-Code-Prompts',
      nonNegativeDelta(state.promptCount, state.promptCountAtLastCommit),
    ],
    [
      'Claude-Code-Permission-Prompts',
      nonNegativeDelta(
        state.permissionPromptCount,
        state.permissionPromptCountAtLastCommit,
      ),
    ],
    [
      'Claude-Code-Escapes',
      nonNegativeDelta(state.escapeCount, state.escapeCountAtLastCommit),
    ],
  ]
  for (const [key, value] of counts) {
    if (value > 0) trailers.push(`${key}: ${value}`)
  }
  return trailers
}
