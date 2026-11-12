import {
  checkQuotaStatus,
  currentLimits,
  getRateLimitDisplayName,
} from '../../services/claudeAiLimits.js'
import {
  clearMockHeaders,
  getMockStatus,
} from '../../services/mockRateLimits.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE = 'Usage: /reset-limits [status|mocks|refresh]'

export type ResetLimitsDependencies = {
  checkQuotaStatus: () => Promise<void>
  clearMockHeaders: () => void
  getMockStatus: () => string
  getLimits: () => typeof currentLimits
}

const defaultDependencies: ResetLimitsDependencies = {
  checkQuotaStatus,
  clearMockHeaders,
  getMockStatus,
  getLimits: () => currentLimits,
}

export function formatLimitStatus(
  deps: Pick<ResetLimitsDependencies, 'getLimits' | 'getMockStatus'> =
    defaultDependencies,
): string {
  const limits = deps.getLimits()
  const lines = [
    'Local limit status (last known provider response):',
    `  Status: ${limits.status}`,
  ]
  if (limits.rateLimitType) {
    lines.push(
      `  Limit: ${getRateLimitDisplayName(limits.rateLimitType)}`,
    )
  }
  if (limits.resetsAt) {
    lines.push(
      `  Resets: ${new Date(limits.resetsAt * 1000).toISOString()}`,
    )
  }
  if (limits.utilization !== undefined) {
    lines.push(`  Utilization: ${Math.round(limits.utilization * 100)}%`)
  }
  if (limits.overageStatus) {
    lines.push(`  Extra usage: ${limits.overageStatus}`)
  }
  lines.push('Mock status:', deps.getMockStatus())
  lines.push('Local usage statistics are preserved; no command can reset server-side quota.')
  return lines.join('\n')
}

export async function runResetLimits(
  args: string,
  deps: ResetLimitsDependencies = defaultDependencies,
): Promise<string> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const action = tokens.length === 0 ? 'status' : tokens[0]
  if (tokens.length > 1 || !['status', 'mocks', 'refresh'].includes(action!)) {
    return USAGE
  }

  if (action === 'mocks') {
    deps.clearMockHeaders()
    return 'Local mock rate limits cleared. Real provider limits were not changed; local usage statistics were preserved.'
  }
  if (action === 'refresh') {
    try {
      await deps.checkQuotaStatus()
    } catch {
      return `Quota refresh failed (including missing or rejected credentials). Previous cached status and local usage statistics were preserved.\n${formatLimitStatus(deps)}`
    }
    return `Quota refresh finished (authentication, privacy, or non-interactive policy may skip the request).\n${formatLimitStatus(deps)}`
  }
  return formatLimitStatus(deps)
}

export const call: LocalCommandCall = async args => ({
  type: 'text',
  value: await runResetLimits(args),
})
