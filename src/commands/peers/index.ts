import type { Command } from '../../types/command.js'
import { listAllLiveSessions } from '../../utils/udsClient.js'

const peers: Command = {
  type: 'local',
  name: 'peers',
  description: 'List live local peer sessions over UDS',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: async () => ({
    call: async () => {
      const sessions = await listAllLiveSessions()
      return {
        type: 'text' as const,
        value:
          sessions.length === 0
            ? 'No live UDS peer sessions.'
            : sessions
                .map(
                  session =>
                    `${session.sessionId} (${session.kind ?? 'unknown'})\n  uds:${session.sessionId}\n  ${session.socketPath}`,
                )
                .join('\n'),
      }
    },
  }),
}

export default peers
