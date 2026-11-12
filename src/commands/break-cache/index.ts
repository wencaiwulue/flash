import type { Command } from '../../types/command.js'

const breakCache = {
  type: 'local',
  name: 'break-cache',
  description: 'Rebuild process-local derived caches',
  supportsNonInteractive: true,
  load: () => import('./break-cache.js'),
} satisfies Command

export default breakCache
