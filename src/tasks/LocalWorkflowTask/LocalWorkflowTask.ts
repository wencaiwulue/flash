import { mkdir, writeFile } from 'fs/promises'
import { dirname } from 'path'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  createTaskStateBase,
  generateTaskId,
  type SetAppState,
  type Task,
  type TaskStateBase,
} from '../../Task.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'
import {
  WorkflowExecution,
  type WorkflowAgentState,
  type WorkflowExecutionState,
  type WorkflowStepRunner,
} from '../../tools/WorkflowTool/executor.js'
import { runWorkflowStep } from '../../tools/WorkflowTool/runner.js'
import type { WorkflowDefinition } from '../../tools/WorkflowTool/schema.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  workflowName?: string
  summary?: string
  agentCount: number
  agents?: Record<string, WorkflowAgentState>
  agentId?: string
  error?: string
}

const executions = new Map<string, WorkflowExecution>()

export function startWorkflowTask(options: {
  workflow: WorkflowDefinition
  input: string
  context: ToolUseContext
  canUseTool: CanUseToolFn
  runner?: WorkflowStepRunner
}): { taskId: string; done: Promise<WorkflowExecutionState> } {
  const { workflow, input, context, canUseTool } = options
  const taskId = generateTaskId('local_workflow')
  const setAppState = context.setAppStateForTasks ?? context.setAppState
  const base = createTaskStateBase(
    taskId,
    'local_workflow',
    `Workflow ${workflow.name}`,
    context.toolUseId,
  )
  const initial: LocalWorkflowTaskState = {
    ...base,
    type: 'local_workflow',
    status: 'running',
    workflowName: workflow.name,
    summary: `${workflow.name} running`,
    agentCount: workflow.steps.length,
    agents: Object.fromEntries(
      workflow.steps.map(step => [step.id, { status: 'pending' }]),
    ),
    agentId: context.agentId,
  }
  registerTask(initial, setAppState)

  const execution = new WorkflowExecution(
    workflow,
    input,
    options.runner ??
      ((step, prompt, signal) =>
        runWorkflowStep(
          step,
          prompt,
          signal,
          context,
          canUseTool,
          `workflows/${taskId}`,
        )),
    state => {
      updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
        ...task,
        agents: state.agents,
        summary: `${workflow.name} ${state.status}`,
        error: state.error,
      }))
    },
  )
  executions.set(taskId, execution)
  execution.start()
  const done = execution.done.then(async state => {
    executions.delete(taskId)
    const outputFile = initial.outputFile
    let finalState = state
    let hasOutput = false
    try {
      await mkdir(dirname(outputFile), { recursive: true, mode: 0o700 })
      await writeFile(outputFile, JSON.stringify(state, null, 2), { mode: 0o600 })
      hasOutput = true
    } catch (error) {
      finalState = {
        ...state,
        status: 'failed',
        error: `Failed to persist workflow output: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
      ...task,
      status: finalState.status,
      agents: finalState.agents,
      summary: `${workflow.name} ${finalState.status}`,
      error: finalState.error,
      endTime: Date.now(),
      notified: true,
    }))
    const toolUseIdLine = context.toolUseId
      ? `\n<${TOOL_USE_ID_TAG}>${context.toolUseId}</${TOOL_USE_ID_TAG}>`
      : ''
    const outputTag = hasOutput
      ? `\n<${OUTPUT_FILE_TAG}>${outputFile}</${OUTPUT_FILE_TAG}>`
      : ''
    enqueuePendingNotification({
      value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}${outputTag}
<${STATUS_TAG}>${finalState.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(`Workflow ${workflow.name} ${finalState.status}`)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`,
      mode: 'task-notification',
      priority: 'later',
      agentId: context.agentId,
    })
    return finalState
  })
  return { taskId, done }
}

export function killWorkflowTask(
  taskId: string,
  _setAppState: SetAppState,
): boolean {
  return executions.get(taskId)?.kill() ?? false
}

export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  _setAppState: SetAppState,
): boolean {
  return executions.get(taskId)?.skip(agentId) ?? false
}

export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  _setAppState: SetAppState,
): boolean {
  return executions.get(taskId)?.retry(agentId) ?? false
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    if (!killWorkflowTask(taskId, setAppState)) {
      throw new Error(`Workflow task is not active: ${taskId}`)
    }
  },
}
