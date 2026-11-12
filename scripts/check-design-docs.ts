import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
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

export function normalizeRepoPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

export interface OwnershipOptions {
  cwd: string
  manifest: Manifest
  files: string[]
  requireApproved?: boolean
}

export async function checkOwnership({
  cwd,
  manifest,
  files,
  requireApproved = false,
}: OwnershipOptions): Promise<CheckResult> {
  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  const fail = (code: string, message: string): void => {
    errors.push({ code, message })
  }
  const incomplete = (code: string, message: string): void => {
    ;(requireApproved ? errors : warnings).push({ code, message })
  }

  const actual = new Set(files.map(normalizeRepoPath))
  const specIds = new Set<string>()
  for (const entry of manifest.specs) {
    if (specIds.has(entry.id)) fail('DUPLICATE_SPEC', `Duplicate spec id: ${entry.id}`)
    specIds.add(entry.id)
  }

  for (const file of actual) {
    if (!ROOTS.some(root => file.startsWith(`${root}/`))) {
      fail('OUT_OF_SCOPE', `Coverage input is outside src/tests/scripts: ${file}`)
    }
  }

  const covered = new Map<string, string>()
  for (const entry of manifest.specs) {
    if (entry.status === 'planned') {
      incomplete('PLANNED_SPEC', `Spec is planned: ${entry.id}`)
      if (existsSync(resolve(cwd, entry.spec)) || existsSync(resolve(cwd, entry.coverage))) {
        fail('PLANNED_ARTIFACT', `Planned spec must not have artifacts: ${entry.id}`)
      }
      continue
    }
    if (entry.status === 'draft') incomplete('DRAFT_SPEC', `Spec is draft: ${entry.id}`)
    if (!existsSync(resolve(cwd, entry.coverage))) {
      fail('MISSING_COVERAGE', `Missing coverage for ${entry.id}: ${entry.coverage}`)
      continue
    }

    const coverage = await loadCoverage(cwd, entry.coverage)
    if (coverage.spec_id !== entry.id || coverage.status !== entry.status) {
      fail('COVERAGE_METADATA', `Coverage id/status does not match manifest: ${entry.id}`)
    }
    const backreference = normalizeRepoPath(relative(
      cwd,
      resolve(cwd, dirname(entry.coverage), coverage.spec),
    ))
    if (backreference !== entry.spec) {
      fail('COVERAGE_BACKLINK', `Coverage backreference does not match spec: ${entry.id}`)
    }

    for (const group of coverage.groups) {
      const expectedRoot = { source: 'src', test: 'tests', script: 'scripts' }[group.kind]
      for (const file of group.files) {
        if (!file.startsWith(`${expectedRoot}/`)) {
          fail('KIND_MISMATCH', `${file} does not match group kind ${group.kind}`)
        }
        if (!actual.has(file)) fail('GHOST_COVERAGE', `Covered file is not in Git scope: ${file}`)
        if (covered.has(file)) {
          fail('DUPLICATE_FILE', `${file} is owned by ${covered.get(file)} and ${entry.id}`)
        } else {
          covered.set(file, entry.id)
        }
      }
    }
  }

  const excluded = new Map<string, string>()
  for (const exclusion of manifest.exclusions) {
    if (!specIds.has(exclusion.source_spec)) {
      fail('UNKNOWN_SOURCE_SPEC', `${exclusion.glob} references ${exclusion.source_spec}`)
    }
    const matches: string[] = []
    for await (const match of new Bun.Glob(exclusion.glob).scan({ cwd, onlyFiles: true })) {
      const file = normalizeRepoPath(match)
      if (actual.has(file)) matches.push(file)
    }
    if (matches.length === 0) {
      fail('STALE_EXCLUSION', `Exclusion matches no in-scope file: ${exclusion.glob}`)
    }
    for (const file of matches) {
      if (covered.has(file)) {
        fail('EXCLUSION_COVERED', `${file} is both covered and excluded`)
      }
      if (excluded.has(file)) {
        fail('DUPLICATE_EXCLUSION', `${file} matches multiple exclusions`)
      } else {
        excluded.set(file, exclusion.glob)
      }
    }
  }

  for (const file of [...actual].sort()) {
    if (!covered.has(file) && !excluded.has(file)) {
      incomplete('UNCOVERED_FILE', `File has no primary spec or exclusion: ${file}`)
    }
  }
  return { errors, warnings }
}
