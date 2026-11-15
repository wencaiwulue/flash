import type { Command } from '../../commands.js'
import { isProductFeedbackAvailable } from '../feedback/feedbackAvailability.js'

const issue = {
  type: 'local-jsx',
  name: 'issue',
  description: 'Report a product issue through the flash feedback flow',
  argumentHint: '[report]',
  isEnabled: () => isProductFeedbackAvailable(),
  load: () => import('../feedback/feedback.js'),
} satisfies Command

export default issue
