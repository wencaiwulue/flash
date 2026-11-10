import type { Command } from '../commands.js'
import type { LocalJSXCommandOnDone } from '../types/command.js'
import {
  activateProactive,
  deactivateProactive,
  getProactiveControlState,
  pauseProactive,
  resumeProactive,
} from '../proactive/index.js'

async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args: string) {
  const current = getProactiveControlState()
  const action = args.trim().toLowerCase() || (current.active ? 'off' : 'on')
  switch (action) {
    case 'on':
      if (!current.active) activateProactive('command')
      else if (current.paused) resumeProactive()
      onDone('Proactive mode enabled. Ticks run while the session is idle.')
      break
    case 'off':
      deactivateProactive()
      onDone('Proactive mode disabled.')
      break
    case 'pause':
      onDone(
        pauseProactive()
          ? 'Proactive mode paused.'
          : 'Proactive mode is not active or is already paused.',
      )
      break
    case 'resume':
      onDone(
        resumeProactive()
          ? 'Proactive mode resumed.'
          : 'Proactive mode is not paused.',
      )
      break
    case 'status': {
      const state = getProactiveControlState()
      onDone(
        !state.active
          ? 'Proactive mode is off.'
          : state.paused
            ? 'Proactive mode is paused.'
            : state.contextBlocked
              ? 'Proactive mode is active but blocked by context errors.'
              : 'Proactive mode is active.',
      )
      break
    }
    default:
      onDone('Usage: /proactive [on|off|pause|resume|status]')
  }
  return null
}

export default {
  type: 'local-jsx',
  name: 'proactive',
  description: 'Control autonomous idle ticks',
  argumentHint: '[on|off|pause|resume|status]',
  immediate: true,
  isEnabled: () => true,
  load: () => Promise.resolve({ call }),
} satisfies Command
