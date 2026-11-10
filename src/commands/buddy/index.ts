import type { Command } from '../../types/command.js'

const buddy: Command = {
  type: 'local',
  name: 'buddy',
  description: 'Buddy mode is unavailable in this build',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: async () => ({
    call: async () => ({
      type: 'text',
      value: 'Buddy mode is unavailable in this build.',
    }),
  }),
}

export default buddy
