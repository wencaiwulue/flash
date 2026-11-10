import { getCompanion } from '../../buddy/companion.js'
import { RARITY_STARS } from '../../buddy/types.js'
import type { Command } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'

const buddy: Command = {
  type: 'local',
  name: 'buddy',
  description: 'Show, mute, or unmute your coding companion',
  isEnabled: () => true,
  argumentHint: '[status|mute|unmute]',
  supportsNonInteractive: true,
  load: async () => ({
    call: async (args: string) => {
      const action = args.trim().toLowerCase() || 'status'
      if (action === 'mute' || action === 'unmute') {
        saveGlobalConfig(current => ({
          ...current,
          companionMuted: action === 'mute',
        }))
        return {
          type: 'text' as const,
          value: `Companion ${action === 'mute' ? 'muted' : 'unmuted'}.`,
        }
      }
      if (action !== 'status') {
        return { type: 'text' as const, value: 'Usage: /buddy [status|mute|unmute]' }
      }
      const companion = getCompanion()
      if (!companion) {
        return {
          type: 'text' as const,
          value: 'No companion hatched yet. Complete a turn with Buddy enabled to create one.',
        }
      }
      return {
        type: 'text' as const,
        value: `${companion.name} — ${companion.rarity} ${companion.species} ${RARITY_STARS[companion.rarity]}\n${companion.personality}`,
      }
    },
  }),
}

export default buddy
