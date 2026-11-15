import type { Command } from '../../commands.js'

const teleport = {
  type: 'local-jsx',
  name: 'teleport',
  description: 'Resume an existing flash on the web session locally',
  argumentHint: '[session-id]',
  availability: ['claude-ai'],
  load: () => import('./teleport.js'),
} satisfies Command

export default teleport
