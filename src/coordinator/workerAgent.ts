import { ASYNC_AGENT_ALLOWED_TOOLS } from '../constants/asyncAgentTools.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/constants.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../tools/AgentTool/loadAgentsDir.js'

const WORKER_AGENT: BuiltInAgentDefinition = {
  agentType: 'worker',
  whenToUse:
    'Coordinator-mode worker for autonomous research, implementation, and verification tasks. Give each worker a self-contained objective and concrete completion criteria.',
  tools: Array.from(ASYNC_AGENT_ALLOWED_TOOLS)
    .filter(name => name !== SYNTHETIC_OUTPUT_TOOL_NAME)
    .sort(),
  source: 'built-in',
  baseDir: 'built-in',
  background: true,
  getSystemPrompt() {
    return `You are a worker launched by a Claude Code coordinator. The coordinator's prompt is your complete task; you cannot see the user conversation.

Work autonomously with the available tools. Research before changing code, keep edits scoped to the objective, and run the relevant verification yourself. Do not spawn other agents or wait for another worker unless the task explicitly requires it. Ask the coordinator for missing information only when the task cannot proceed safely.

Finish with a concise report containing the outcome, important file paths, verification actually run, and any remaining blocker. Never claim tests, commits, or external actions that you did not perform.`
  },
}

export function getCoordinatorAgents(): AgentDefinition[] {
  return [WORKER_AGENT]
}
