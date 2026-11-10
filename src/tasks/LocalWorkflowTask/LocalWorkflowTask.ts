import type { SetAppState, Task, TaskStateBase } from '../../Task.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  workflowName?: string
  summary?: string
  agentCount: number
  agentId?: string
  error?: string
}

function unavailable(): never {
  throw new Error('Local workflows are unavailable in this build')
}

export function killWorkflowTask(
  _taskId: string,
  _setAppState: SetAppState,
): boolean {
  return false
}

export function skipWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: SetAppState,
): boolean {
  return false
}

export function retryWorkflowAgent(
  _taskId: string,
  _agentId: string,
  _setAppState: SetAppState,
): boolean {
  return false
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(_taskId: string, _setAppState: SetAppState): Promise<never> {
    unavailable()
  },
}
