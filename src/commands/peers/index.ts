import type { Command } from '../../types/command.js'

const peers: Command = {
  type: 'local',
  name: 'peers',
  description: 'Peer sessions are unavailable in this build',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: async () => ({
    call: async () => ({
      type: 'text',
      value: 'Peer sessions are unavailable in this build.',
    }),
  }),
}

export default peers
