import type { Command } from '../../types/command.js'

const workflows: Command = {
  type: 'local',
  name: 'workflows',
  description: 'Workflows are unavailable in this build',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: async () => ({
    call: async () => ({
      type: 'text',
      value: 'Workflows are unavailable in this build.',
    }),
  }),
}

export default workflows
