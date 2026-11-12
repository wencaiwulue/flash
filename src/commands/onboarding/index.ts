import type { Command } from '../../commands.js'

const onboarding = {
  type: 'local-jsx',
  name: 'onboarding',
  description: 'Run the welcome and terminal setup wizard again',
  load: () => import('./onboarding.js'),
} satisfies Command

export default onboarding
