import type { Command } from '../../types/command.js'

const backfillSessions = {
  type: 'local',
  name: 'backfill-sessions',
  description: 'Rebuild missing local insights session metadata',
  argumentHint: '[--dry-run] [--force]',
  supportsNonInteractive: true,
  load: () => import('./backfill-sessions.js'),
} satisfies Command

export default backfillSessions
