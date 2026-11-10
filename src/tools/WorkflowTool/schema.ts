import { z } from 'zod/v4'

export const workflowStepSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  prompt: z.string().min(1),
  agentType: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).default([]),
  continueOnError: z.boolean().default(false),
})

export const workflowDefinitionSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  description: z.string().min(1),
  steps: z.array(workflowStepSchema).min(1),
  concurrency: z.number().int().min(1).max(8).default(2),
})

export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse(value)
  const ids = new Set<string>()
  for (const step of workflow.steps) {
    if (ids.has(step.id)) throw new Error(`Duplicate workflow step: ${step.id}`)
    ids.add(step.id)
  }
  for (const step of workflow.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Unknown dependency ${dependency} in step ${step.id}`)
      }
      if (dependency === step.id) {
        throw new Error(`Step ${step.id} cannot depend on itself`)
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(workflow.steps.map(step => [step.id, step]))
  function visit(id: string): void {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Workflow dependency cycle at ${id}`)
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of workflow.steps) visit(step.id)
  return workflow
}

export function buildStepPrompt(
  step: WorkflowStep,
  input: string,
  results: Readonly<Record<string, string>>,
): string {
  return step.prompt.replace(/\{\{([^}]+)\}\}/g, (match, reference: string) => {
    if (reference === 'input') return input
    const stepMatch = /^steps\.([a-z][a-z0-9-]*)\.output$/.exec(reference)
    if (stepMatch && results[stepMatch[1]!] !== undefined) {
      return results[stepMatch[1]!]!
    }
    return match
  })
}
