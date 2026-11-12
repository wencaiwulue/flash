import type { Command } from '../../types/command.js'

const ctxViz = {
  type: 'local-jsx',
  name: 'ctx_viz',
  description: 'Visualize per-message context tokens and optionally export metadata',
  argumentHint: '[--json <path>]',
  load: () => import('./ctx_viz.js'),
} satisfies Command

export default ctxViz
