import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../../commands.js'

export function buildSummaryPrompt(
  args: string,
  messageCount: number,
): ContentBlockParam[] {
  if (messageCount === 0) {
    return [
      {
        type: 'text',
        text: 'There is no earlier conversation to summarize. Tell the user that the conversation is empty; do not invent a summary.',
      },
    ]
  }

  const focus = args.trim()
  return [
    {
      type: 'text',
      text: `Summarize the existing conversation as a normal assistant response. Preserve the important decisions, context, work completed, and next steps. Do not compact, truncate, rewrite, checkpoint, or otherwise modify the conversation history.${
        focus
          ? `\n\nFocus the summary on the following user-requested topic, without omitting essential related context:\n${focus}`
          : ''
      }`,
    },
  ]
}

const summary = {
  type: 'prompt',
  name: 'summary',
  description: 'Summarize the current conversation without changing its history',
  argumentHint: '[focus]',
  progressMessage: 'summarizing conversation',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args, context) {
    return buildSummaryPrompt(args, context.messages.length)
  },
} satisfies Command

export default summary
