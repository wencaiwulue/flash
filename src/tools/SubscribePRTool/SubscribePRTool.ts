import { execa } from 'execa'
import { z } from 'zod/v4'
import { PRSubscriptionManager, type PRSubscriptionKey } from '../../services/prSubscriptions.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { parseGitHubRepository } from '../../utils/detectRepository.js'

const manager = new PRSubscriptionManager()
const inputSchema = z.strictObject({
  action: z.enum(['subscribe', 'unsubscribe', 'list']),
  repository: z.string().optional().describe('GitHub owner/repo; defaults to origin'),
  pr_number: z.number().int().positive().optional(),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  message: z.string(),
  subscriptions: z.array(z.string()),
})
type Output = z.infer<typeof outputSchema>

async function defaultRepository(): Promise<string> {
  const result = await execa('git', ['remote', 'get-url', 'origin'], {
    cwd: getCwd(),
  })
  const repository = parseGitHubRepository(result.stdout)
  if (!repository) throw new Error('Could not determine a GitHub owner/repo from origin')
  return repository
}

export const SubscribePRTool = buildTool({
  name: 'SubscribePR',
  inputSchema,
  outputSchema,
  maxResultSizeChars: 4_000,
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async description() {
    return 'Subscribe to GitHub PR comments, reviews, and CI events'
  },
  async prompt() {
    return 'Use GitHub REST to subscribe, unsubscribe, or list PR subscriptions. The first poll establishes a baseline; only new comments, reviews, and check-run changes are emitted. PR state is polled every 30 seconds using the configured GitHub CLI credentials.'
  },
  async validateInput(input) {
    if (input.action !== 'list' && input.pr_number === undefined) {
      return {
        result: false as const,
        message: 'pr_number is required for subscribe/unsubscribe',
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ action, repository, pr_number }) {
    if (action === 'list') {
      return {
        data: {
          message: manager.list().join('\n') || 'No PR subscriptions.',
          subscriptions: manager.list(),
        },
      }
    }
    const repo = repository ?? (await defaultRepository())
    const key = `${repo}#${pr_number}` as PRSubscriptionKey
    if (action === 'subscribe') {
      const created = await manager.subscribe(repo, pr_number!)
      return {
        data: {
          message: created ? `Subscribed to ${key}.` : `Already subscribed to ${key}.`,
          subscriptions: manager.list(),
        },
      }
    }
    const removed = manager.unsubscribe(key)
    return {
      data: {
        message: removed ? `Unsubscribed from ${key}.` : `No subscription for ${key}.`,
        subscriptions: manager.list(),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.message,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

export { manager as prSubscriptionManager }
