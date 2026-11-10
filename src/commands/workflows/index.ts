import type { Command } from '../../types/command.js'
import { listWorkflowDefinitions } from '../../tools/WorkflowTool/discovery.js'
import { getCwd } from '../../utils/cwd.js'

const workflows: Command = {
  type: 'local',
  name: 'workflows',
  description: 'List discovered workflows',
  isEnabled: () => true,
  supportsNonInteractive: true,
  load: async () => ({
    call: async () => {
      const definitions = await listWorkflowDefinitions(getCwd())
      return {
        type: 'text' as const,
        value:
          definitions.length === 0
            ? 'No workflows found. Add JSON definitions to .claude/workflows/.'
            : definitions
                .map(
                  workflow =>
                    `/${workflow.name} [${workflow.source}] — ${workflow.description} (${workflow.steps.length} steps)`,
                )
                .join('\n'),
      }
    },
  }),
}

export default workflows
