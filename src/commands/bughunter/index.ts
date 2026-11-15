import type { Command } from '../../commands.js'
import { isUltrareviewEnabled } from '../review/ultrareviewEnabled.js'

const bughunter = {
  type: 'local-jsx',
  name: 'bughunter',
  description:
    'Find and verify bugs in this branch with a remote flash review',
  argumentHint: '[focus]',
  availability: ['claude-ai'],
  isEnabled: () => isUltrareviewEnabled(),
  load: () => import('../review/ultrareviewCommand.js'),
} satisfies Command

export default bughunter
