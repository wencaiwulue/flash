import type { Command } from '../../types/command.js'

const antTrace = {
  type: 'local-jsx',
  name: 'ant-trace',
  description: 'Record and export bounded local OpenTelemetry diagnostics',
  argumentHint: 'start|stop|status|export <path>',
  load: () => import('./ant-trace.js'),
} satisfies Command

export default antTrace
