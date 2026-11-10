import { startWorkflowTask } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { Command, LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { listWorkflowDefinitions, type DiscoveredWorkflow } from './discovery.js'

function commandForWorkflow(workflow: DiscoveredWorkflow): Command {
  async function call(
    onDone: LocalJSXCommandOnDone,
    context: LocalJSXCommandContext,
    args: string,
  ): Promise<null> {
    if (!context.canUseTool) {
      onDone(`Workflow ${workflow.name} requires an interactive permission context.`)
      return null
    }
    const { taskId } = startWorkflowTask({
      workflow,
      input: args,
      context,
      canUseTool: context.canUseTool,
    })
    onDone(`Workflow ${workflow.name} started: ${taskId}`)
    return null
  }
  return {
    type: 'local-jsx',
    name: workflow.name,
    description: workflow.description,
    kind: 'workflow',
    ...(workflow.source === 'bundled' ? { loadedFrom: 'bundled' } : {}),
    isEnabled: () => true,
    load: () => Promise.resolve({ call }),
  }
}

export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  return (await listWorkflowDefinitions(cwd)).map(commandForWorkflow)
}
