import type { Command } from '../../commands.js'
import { isProductFeedbackAvailable } from './feedbackAvailability.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about flash`,
  argumentHint: '[report]',
  isEnabled: () =>
    isProductFeedbackAvailable() && process.env.USER_TYPE !== 'ant',
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
