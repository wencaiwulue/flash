import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../types/command.js'

const perfIssue = {
  type: 'local-jsx',
  name: 'perf-issue',
  description: 'Preview and export local performance diagnostics',
  argumentHint: '[output.json]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./perf-issue.js'),
} satisfies Command

export default perfIssue
