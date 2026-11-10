import { setKairosActive } from '../../bootstrap/state.js'
import {
  initializeAssistantTeam,
  isAssistantMode,
  markAssistantForced,
} from '../../assistant/index.js'
import { discoverAssistantSessions } from '../../assistant/sessionDiscovery.js'
import type { Command, LocalJSXCommandOnDone } from '../../types/command.js'

async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args: string) {
  const action = args.trim().toLowerCase() || 'start'
  try {
    if (action === 'start') {
      markAssistantForced()
      setKairosActive(true)
      const team = await initializeAssistantTeam()
      onDone(`Assistant team started: ${team.teamName}`)
      return null
    }
    if (action === 'status') {
      onDone(isAssistantMode() ? 'Assistant mode is active.' : 'Assistant mode is off. Run /assistant start to enable it.')
      return null
    }
    if (action === 'sessions') {
      const sessions = await discoverAssistantSessions()
      onDone(
        sessions.length === 0
          ? 'No assistant sessions found.'
          : sessions.map(session => `${session.id} ${session.title ?? ''}`).join('\n'),
      )
      return null
    }
    onDone('Usage: /assistant [start|status|sessions]')
  } catch (error) {
    onDone(`Assistant command failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return null
}

export default {
  type: 'local-jsx',
  name: 'assistant',
  description: 'Start or inspect assistant mode and sessions',
  argumentHint: '[start|status|sessions]',
  availability: ['claude-ai'],
  isEnabled: () => true,
  load: () => Promise.resolve({ call }),
} satisfies Command
