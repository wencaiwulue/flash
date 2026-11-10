import type { Command } from '../../types/command.js'

/** Workflow discovery is disabled; there are no workflow-backed commands. */
export async function getWorkflowCommands(_cwd: string): Promise<Command[]> {
  return []
}
