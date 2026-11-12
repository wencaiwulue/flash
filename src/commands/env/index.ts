import type { Command } from '../../types/command.js'

const env = {
  type: 'local',
  name: 'env',
  description: 'Show effective Claude and Anthropic environment configuration',
  argumentHint: '[NAME]',
  supportsNonInteractive: true,
  load: () => import('./env.js'),
} satisfies Command

export default env
