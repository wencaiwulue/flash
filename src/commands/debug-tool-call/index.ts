import type { Command } from '../../types/command.js'

const debugToolCall = {
  type: 'local-jsx',
  name: 'debug-tool-call',
  description: 'Inspect saved tool calls and validate inputs without replay',
  argumentHint: '[tool-use-id] [--validate]',
  load: () => import('./debug-tool-call.js'),
} satisfies Command

export default debugToolCall
