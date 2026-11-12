import type { Command } from '../../commands.js'

const share = {
  type: 'local-jsx',
  name: 'share',
  description: 'Save the current conversation as a local static HTML file',
  argumentHint: '[output.html]',
  load: () => import('./share.js'),
} satisfies Command

export default share
