import type { Command } from '../../types/command.js'

const mockLimits = {
  type: 'local',
  name: 'mock-limits',
  description: 'Test process-local rate limit responses (explicit opt-in)',
  argumentHint: 'list|status|clear|<scenario>',
  isEnabled: () => process.env.CLAUDE_CODE_ENABLE_MOCK_LIMITS === '1',
  supportsNonInteractive: false,
  load: () => import('./mock-limits.js'),
} satisfies Command

export default mockLimits
