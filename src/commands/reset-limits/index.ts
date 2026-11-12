import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../types/command.js'

export const resetLimits = {
  type: 'local',
  name: 'reset-limits',
  description: 'Inspect limits, clear local mocks, or refresh quota status',
  argumentHint: '[status|mocks|refresh]',
  supportsNonInteractive: false,
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./reset-limits.js'),
} satisfies Command

export const resetLimitsNonInteractive = {
  type: 'local',
  name: 'reset-limits',
  description: 'Inspect limits, clear local mocks, or refresh quota status',
  argumentHint: '[status|mocks|refresh]',
  supportsNonInteractive: true,
  isEnabled: () => getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./reset-limits.js'),
} satisfies Command

export default resetLimits
