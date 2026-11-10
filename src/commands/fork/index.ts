import type { Command } from '../../types/command.js'

const fork: Command = {
  type: 'local',
  name: 'fork',
  description: 'Forked sessions are unavailable in this build',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: async () => ({
    call: async () => ({
      type: 'text',
      value: 'Forked sessions are unavailable in this build.',
    }),
  }),
}

export default fork
