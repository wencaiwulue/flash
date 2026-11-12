import {
  MOCK_SCENARIOS,
  type MockScenario,
  clearMockHeaders,
  getMockLimitsBanner,
  getMockStatus,
  getScenarioDescription,
  isMockLimitsEnabled,
  setMockRateLimitScenario,
} from '../../services/mockRateLimits.js'
import type { LocalCommandCall } from '../../types/command.js'

const USAGE =
  'Usage: /mock-limits list|status|clear|<scenario>\n' +
  'Mocking is process-local and does not change real provider limits.'

function listScenarios(): string {
  return [
    'Available mock scenarios (process-local only):',
    ...MOCK_SCENARIOS.map(
      scenario => `  ${scenario} — ${getScenarioDescription(scenario)}`,
    ),
    'Real provider limits are never changed.',
  ].join('\n')
}

export function formatMockLimitsResult(args: string): string {
  if (!isMockLimitsEnabled()) {
    return 'Mock limits are disabled. Set CLAUDE_CODE_ENABLE_MOCK_LIMITS=1 before starting Claude Code.'
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length !== 1) return USAGE
  const action = tokens[0]!
  if (action === 'list') return listScenarios()
  if (action === 'status') {
    const banner = getMockLimitsBanner()
    return [banner, getMockStatus(), 'Real provider limits are unchanged.']
      .filter(Boolean)
      .join('\n')
  }
  if (action === 'clear') {
    clearMockHeaders()
    return 'Mock rate limits cleared. Real provider responses are active; real provider limits were not changed.'
  }
  if (!(MOCK_SCENARIOS as readonly string[]).includes(action)) {
    return `Unknown mock scenario: ${action}\n${USAGE}`
  }

  setMockRateLimitScenario(action as MockScenario)
  return [
    getMockLimitsBanner(),
    `Scenario: ${action}`,
    getMockStatus(),
    'This process may now show simulated 429 responses. Real provider limits are unchanged.',
  ].join('\n')
}

export const call: LocalCommandCall = async args => ({
  type: 'text',
  value: formatMockLimitsResult(args),
})
