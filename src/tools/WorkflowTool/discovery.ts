import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getBundledWorkflows } from './bundled/index.js'
import { parseWorkflowDefinition, type WorkflowDefinition } from './schema.js'

export type DiscoveredWorkflow = WorkflowDefinition & {
  source: 'project' | 'user' | 'bundled'
  path?: string
}

async function readWorkflowDir(
  dir: string,
  source: 'project' | 'user',
): Promise<DiscoveredWorkflow[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const workflows = await Promise.all(
    names
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(async name => {
        const path = join(dir, name)
        try {
          const workflow = parseWorkflowDefinition(
            JSON.parse(await readFile(path, 'utf8')),
          )
          return { ...workflow, source, path } as DiscoveredWorkflow
        } catch (error) {
          logForDebugging(`Invalid workflow ${path}: ${String(error)}`)
          return undefined
        }
      }),
  )
  return workflows.filter((workflow): workflow is DiscoveredWorkflow => !!workflow)
}

export async function listWorkflowDefinitions(cwd: string): Promise<DiscoveredWorkflow[]> {
  const [project, user] = await Promise.all([
    readWorkflowDir(join(cwd, '.claude', 'workflows'), 'project'),
    readWorkflowDir(join(getClaudeConfigHomeDir(), 'workflows'), 'user'),
  ])
  const byName = new Map<string, DiscoveredWorkflow>()
  for (const workflow of getBundledWorkflows()) {
    byName.set(workflow.name, { ...workflow, source: 'bundled' })
  }
  for (const workflow of [...user, ...project]) byName.set(workflow.name, workflow)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function findWorkflowDefinition(
  name: string,
  cwd: string,
): Promise<DiscoveredWorkflow | undefined> {
  return (await listWorkflowDefinitions(cwd)).find(
    workflow => workflow.name === name,
  )
}
