import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

export const ROOTS = ['src', 'tests', 'scripts'] as const
export const MANIFEST_PATH = 'docs/architecture/coverage/manifest.yaml'
export const INDEX_PATH = 'docs/architecture/INDEX.md'

const statusSchema = z.enum(['planned', 'draft', 'approved'])
const repositoryPath = z.string().min(1).refine(
  value => !value.startsWith('/')
    && !value.includes('\\')
    && !value.split('/').includes('..'),
  'Expected a normalized repository-relative path',
)

const manifestSchema = z.object({
  schema_version: z.literal(1),
  roots: z.tuple([
    z.literal('src'),
    z.literal('tests'),
    z.literal('scripts'),
  ]),
  specs: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    spec: repositoryPath,
    coverage: repositoryPath,
    batch: z.number().int().nonnegative(),
    status: statusSchema,
  })),
  exclusions: z.array(z.object({
    glob: z.string().min(1),
    reason: z.string().min(1),
    source_spec: z.string().regex(/^[a-z0-9-]+$/),
  })),
})

const coverageSchema = z.object({
  schema_version: z.literal(1),
  spec_id: z.string().regex(/^[a-z0-9-]+$/),
  spec: z.string().min(1),
  status: statusSchema,
  groups: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    kind: z.enum(['source', 'test', 'script']),
    section: z.number().int().min(1).max(9),
    summary: z.string().min(1),
    files: z.array(repositoryPath).min(1),
  })),
})

export type Manifest = z.infer<typeof manifestSchema>
export type Coverage = z.infer<typeof coverageSchema>
export type SpecEntry = Manifest['specs'][number]

export interface Diagnostic {
  code: string
  message: string
}

export interface CheckResult {
  errors: Diagnostic[]
  warnings: Diagnostic[]
}

async function loadYaml<Schema extends z.ZodType>(
  cwd: string,
  path: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const source = await readFile(resolve(cwd, path), 'utf8')
  const result = schema.safeParse(parse(source))
  if (!result.success) {
    const details = result.error.issues.map(issue => {
      const field = issue.path.join('.') || '<root>'
      return `${field}: ${issue.message}`
    }).join('; ')
    throw new Error(`${path}: ${details}`)
  }
  return result.data
}

export async function loadManifest(cwd: string): Promise<Manifest> {
  return loadYaml(cwd, MANIFEST_PATH, manifestSchema)
}

export async function loadCoverage(
  cwd: string,
  path: string,
): Promise<Coverage> {
  return loadYaml(cwd, path, coverageSchema)
}
