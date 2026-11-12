import type { Command } from '../../commands.js'
import { isProductFeedbackAvailable } from '../feedback/feedbackAvailability.js'

const goodClaude = {
  type: 'local-jsx',
  name: 'good-claude',
  description: 'Rate this session as good and optionally share feedback',
  isEnabled: () => isProductFeedbackAvailable(),
  load: () => import('./goodClaude.js'),
} satisfies Command

export default goodClaude
