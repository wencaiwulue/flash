import type { AppState } from '../../state/AppState.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  agentId?: string
  error?: string
}

export function killMonitorMcp(
  _taskId: string,
  _setAppState: SetAppState,
): boolean {
  return false
}

/** Returns the number of monitors stopped; zero means this backend is disabled. */
export function killMonitorMcpTasksForAgent(
  _agentId: string,
  _getAppState: () => AppState,
  _setAppState: SetAppState,
): number {
  return 0
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  async kill(_taskId: string, _setAppState: SetAppState): Promise<never> {
    throw new Error('MCP monitor tasks are unavailable in this build')
  },
}
