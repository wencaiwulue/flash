import { parseWorkflowDefinition, type WorkflowDefinition } from '../schema.js'

const bundled = new Map<string, WorkflowDefinition>()

export function initBundledWorkflows(): void {
  // Registry initialization is intentionally idempotent. Bundled definitions can
  // be registered by product packages without changing workflow discovery.
}

export function registerBundledWorkflow(value: unknown): WorkflowDefinition {
  const workflow = parseWorkflowDefinition(value)
  bundled.set(workflow.name, workflow)
  return workflow
}

export function getBundledWorkflows(): WorkflowDefinition[] {
  return [...bundled.values()]
}

export function getBundledWorkflow(name: string): WorkflowDefinition | undefined {
  return bundled.get(name)
}
