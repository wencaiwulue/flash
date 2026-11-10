import { prSubscriptionManager } from '../tools/SubscribePRTool/SubscribePRTool.js'
import type { Command } from '../types/command.js'

export default {
  type: 'local',
  name: 'subscribe-pr',
  description: 'Manage GitHub PR comment, review, and CI subscriptions',
  argumentHint: '[owner/repo#number|off owner/repo#number|list]',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: async () => ({
    call: async (args: string) => {
      const [action = 'list', target] = args.trim().split(/\s+/, 2)
      if (action === 'list') {
        return {
          type: 'text' as const,
          value: prSubscriptionManager.list().join('\n') || 'No PR subscriptions.',
        }
      }
      const match = target?.match(/^([^#]+)#(\d+)$/)
      if (!match) {
        return {
          type: 'text' as const,
          value: 'Usage: /subscribe-pr [owner/repo#number|off owner/repo#number|list]',
        }
      }
      const repository = match[1]!
      const number = Number(match[2])
      const key = `${repository}#${number}` as const
      if (action === 'off') {
        prSubscriptionManager.unsubscribe(key)
        return { type: 'text' as const, value: `Unsubscribed from ${key}.` }
      }
      if (action !== 'subscribe') {
        return { type: 'text' as const, value: 'Use subscribe, off, or list.' }
      }
      await prSubscriptionManager.subscribe(repository, number)
      return { type: 'text' as const, value: `Subscribed to ${key}.` }
    },
  }),
} satisfies Command
