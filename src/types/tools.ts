import type { TaskType } from '../Task.js'
import type { AgentId } from './ids.js'
import type {
  NormalizedAssistantMessage,
  NormalizedUserMessage,
} from './message.js'

type AgentProgressMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage

export type AgentToolProgress = {
  type: 'agent_progress'
  message: AgentProgressMessage
  prompt: string
  agentId: AgentId
}

export type SkillToolProgress = {
  type: 'skill_progress'
  message: AgentProgressMessage
  prompt: string
  agentId: AgentId
}

export type BashProgress = {
  type: 'bash_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  timeoutMs?: number
  taskId?: string
}

export type PowerShellProgress = {
  type: 'powershell_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  timeoutMs?: number
  taskId?: string
}

export type ShellProgress = BashProgress | PowerShellProgress

export type MCPProgress = {
  type: 'mcp_progress'
  status: 'started' | 'completed' | 'failed' | 'progress'
  serverName: string
  toolName: string
  elapsedTimeMs?: number
  progress?: number
  total?: number
  progressMessage?: string
}

export type WebSearchProgress =
  | {
      type: 'query_update'
      query: string
    }
  | {
      type: 'search_results_received'
      resultCount: number
      query: string
    }

export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType: TaskType
}

export type REPLToolProgress = {
  type: 'repl_tool_call'
  phase: 'start'
  toolName: string
  toolInput: unknown
}

export type ToolProgressData =
  | AgentToolProgress
  | BashProgress
  | MCPProgress
  | PowerShellProgress
  | REPLToolProgress
  | SkillToolProgress
  | TaskOutputProgress
  | WebSearchProgress

export type SdkWorkflowProgress = {
  type: string
  index: number
  phaseIndex: number
}
