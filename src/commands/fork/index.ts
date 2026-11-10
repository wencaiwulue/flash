import { isForkSubagentEnabled } from '../../tools/AgentTool/forkSubagent.js'
import type { Command } from '../../types/command.js'

const fork: Command = {
  type: 'prompt',
  name: 'fork',
  description: 'Fork the current conversation into a background worker',
  argumentHint: '<directive>',
  isEnabled: isForkSubagentEnabled,
  source: 'builtin',
  userInvocable: true,
  progressMessage: 'forking conversation',
  contentLength: 0,
  async getPromptForCommand(args: string) {
    const directive = args.trim()
    if (!directive) return [{ type: 'text' as const, text: 'Usage: /fork <directive>' }]
    return [
      {
        type: 'text' as const,
        text: `Use the Agent tool without a subagent_type to fork the current conversation as a background worker. Give it this complete directive and do not substitute a named agent:\n\n${directive}`,
      },
    ]
  },
}

export default fork
