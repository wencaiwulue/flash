import { z } from 'zod/v4'
import { startWorkflowTask } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { findWorkflowDefinition } from './discovery.js'

const inputSchema = z.strictObject({
  workflow: z.string().min(1).describe('Name of a discovered workflow'),
  input: z.string().optional().describe('Input substituted into {{input}}'),
  wait: z.boolean().default(false).describe('Wait for all steps instead of returning a task ID'),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  message: z.string(),
  task_id: z.string(),
  status: z.string().optional(),
})
type Output = z.infer<typeof outputSchema>

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  maxResultSizeChars: 10_000,
  inputSchema,
  outputSchema,
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async description() {
    return 'Run a declarative multi-step workflow with isolated agents'
  },
  async prompt() {
    return 'Run a workflow discovered from project/user .claude/workflows JSON files or bundled registrations. Steps execute through normal agent tool permissions. Use wait=true for a final result or the default for a background task ID.'
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ workflow, input = '', wait }, context, canUseTool) {
    const definition = await findWorkflowDefinition(workflow, getCwd())
    if (!definition) throw new Error(`Unknown workflow: ${workflow}`)
    const { taskId, done } = startWorkflowTask({
      workflow: definition,
      input,
      context,
      canUseTool,
    })
    if (!wait) {
      return {
        data: { message: `Workflow ${workflow} started: ${taskId}`, task_id: taskId },
      }
    }
    const state = await done
    return {
      data: {
        message: `Workflow ${workflow} ${state.status}: ${taskId}`,
        task_id: taskId,
        status: state.status,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: output.message }
  },
} satisfies ToolDef<InputSchema, Output>)
