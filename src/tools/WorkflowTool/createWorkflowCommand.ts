import { startWorkflowTask } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { Command, LocalJSXCommandContext } from '../../types/command.js'
import { listWorkflowDefinitions, type DiscoveredWorkflow } from './discovery.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'

function commandForWorkflow(workflow: DiscoveredWorkflow): Command {
  async function call(args: string, context: LocalJSXCommandContext) {
    const { taskId } = startWorkflowTask({
      workflow,
      input: args,
      context,
      canUseTool: context.canUseTool ?? hasPermissionsToUseTool,
    })
    return {
      type: 'text' as const,
      value: `Workflow ${workflow.name} started: ${taskId}`,
    }
  }
  return {
    type: 'local',
    name: workflow.name,
    description: workflow.description,
    kind: 'workflow',
    ...(workflow.source === 'bundled' ? { loadedFrom: 'bundled' } : {}),
    isEnabled: () => true,
    supportsNonInteractive: true,
    load: () => Promise.resolve({ call }),
  }
}

export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  return (await listWorkflowDefinitions(cwd)).map(commandForWorkflow)
}
