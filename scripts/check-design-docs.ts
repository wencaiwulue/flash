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

export const REQUIRED_HEADINGS = [
  '## 1. 问题与约束',
  '## 2. 设计理由与备选方案',
  '## 3. 目标与非目标',
  '## 4. 架构、模块与数据流',
  '## 5. 失败语义与工程取舍',
  '## 6. 现状验收标准',
  '## 7. 代码与测试证据',
  '## 8. 文件覆盖与相关子系统',
  '## 9. 改进建议',
] as const

export interface CheckOptions {
  cwd: string
  files?: string[]
  requireApproved?: boolean
}

export async function listRepositoryFiles(cwd: string): Promise<string[]> {
  const result = Bun.spawnSync({
    cmd: [
      'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
      '--', ...ROOTS,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().split('\0').filter(Boolean)
    .map(normalizeRepoPath).sort()
}

const RECOMMENDATION_HEADER =
  '| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |'

function checkRecommendations(
  entry: SpecEntry,
  content: string,
  errors: Diagnostic[],
): void {
  const start = content.indexOf('## 9. 改进建议')
  if (start < 0) return
  const body = content.slice(start + '## 9. 改进建议'.length)
  const lines = body.split('\n').map(line => line.trim())
  const rows = lines.filter(line => /^\|\s*P[0-3]\s*\|/.test(line))
  if (!lines.includes(RECOMMENDATION_HEADER) || rows.length === 0) {
    errors.push({
      code: 'RECOMMENDATIONS_TABLE',
      message: `${entry.spec} section 9 requires the normalized seven-column table`,
    })
  }

  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    let hasRowError = false
    if (cells.length !== 7 || !/^[SML]$/.test(cells[5] ?? '')) {
      errors.push({
        code: 'RECOMMENDATION_ROW',
        message: `${entry.spec} has a malformed recommendation row: ${row}`,
      })
      hasRowError = true
    }
    // Only check evidence if we have all cells including confidence
    if (cells.length >= 7) {
      const [priority, , , , , , confidence] = cells
      const unsupported = priority === 'P0'
        ? !confidence.startsWith('已证实')
        : priority === 'P1'
          ? !/^(已证实|待运行验证)/.test(confidence)
          : false
      if (unsupported) {
        errors.push({
          code: 'RECOMMENDATION_EVIDENCE',
          message: `${entry.spec} has unsupported ${priority} evidence: ${confidence}`,
        })
      }
    }
  }
}

function checkMarkdownLinks(
  cwd: string,
  path: string,
  content: string,
  errors: Diagnostic[],
): void {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '')
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const pathPart = target.split('#')[0]
    let resolvedPath: string
    try {
      resolvedPath = decodeURIComponent(pathPart)
    } catch {
      resolvedPath = pathPart
    }
    if (!pathPart || !existsSync(resolve(cwd, dirname(path), resolvedPath))) {
      errors.push({ code: 'BROKEN_LINK', message: `${path} links to missing ${target}` })
    }
  }
}

async function checkSpecDocument(
  cwd: string,
  entry: SpecEntry,
  indexContent: string,
  errors: Diagnostic[],
): Promise<void> {
  if (!existsSync(resolve(cwd, entry.spec))) {
    errors.push({ code: 'MISSING_SPEC', message: `Missing spec: ${entry.spec}` })
    return
  }
  const content = await readFile(resolve(cwd, entry.spec), 'utf8')
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)
  const metadata = frontmatter ? parse(frontmatter[1]) as Record<string, unknown> : {}

  const mismatches: string[] = []
  if (metadata.id !== entry.id) {
    mismatches.push(`id: expected ${JSON.stringify(entry.id)}, got ${JSON.stringify(metadata.id)}`)
  }
  if (metadata.batch !== entry.batch) {
    mismatches.push(`batch: expected ${entry.batch}, got ${metadata.batch}`)
  }
  if (metadata.status !== entry.status) {
    mismatches.push(`status: expected ${JSON.stringify(entry.status)}, got ${JSON.stringify(metadata.status)}`)
  }
  if (mismatches.length > 0) {
    errors.push({ code: 'SPEC_METADATA', message: `Frontmatter does not match manifest (${entry.id}): ${mismatches.join('; ')}` })
  }

  for (const heading of REQUIRED_HEADINGS) {
    const start = content.indexOf(heading)
    if (start < 0) {
      errors.push({ code: 'MISSING_SECTION', message: `${entry.spec} lacks ${heading}` })
      continue
    }
    const bodyStart = start + heading.length
    const next = content.indexOf('\n## ', bodyStart)
    const body = content.slice(bodyStart, next < 0 ? undefined : next).trim()
    if (!body) errors.push({ code: 'EMPTY_SECTION', message: `${entry.spec} has empty ${heading}` })
  }
  if (/\b(TBD|TODO)\b/.test(content)) {
    errors.push({ code: 'PLACEHOLDER', message: `Placeholder found in ${entry.spec}` })
  }

  const coverageLink = normalizeRepoPath(relative(
    dirname(resolve(cwd, entry.spec)),
    resolve(cwd, entry.coverage),
  ))
  if (!content.includes(`](${coverageLink})`)) {
    errors.push({ code: 'SPEC_COVERAGE_LINK', message: `${entry.spec} must link ${coverageLink}` })
  }
  const indexLink = normalizeRepoPath(relative(
    dirname(resolve(cwd, INDEX_PATH)),
    resolve(cwd, entry.spec),
  ))
  if (!indexContent.includes(`](${indexLink})`)) {
    errors.push({ code: 'INDEX_SPEC_LINK', message: `${INDEX_PATH} must link ${indexLink}` })
  }
  checkRecommendations(entry, content, errors)
  checkMarkdownLinks(cwd, entry.spec, content, errors)
}

export async function checkDesignDocs({
  cwd,
  files,
  requireApproved = false,
}: CheckOptions): Promise<CheckResult> {
  const manifest = await loadManifest(cwd)
  const result = await checkOwnership({
    cwd,
    manifest,
    files: files ?? await listRepositoryFiles(cwd),
    requireApproved,
  })
  let indexContent = ''
  if (!existsSync(resolve(cwd, INDEX_PATH))) {
    result.errors.push({ code: 'MISSING_INDEX', message: `Missing ${INDEX_PATH}` })
  } else {
    indexContent = await readFile(resolve(cwd, INDEX_PATH), 'utf8')
    checkMarkdownLinks(cwd, INDEX_PATH, indexContent, result.errors)
  }
  for (const entry of manifest.specs) {
    if (entry.status !== 'planned') {
      await checkSpecDocument(cwd, entry, indexContent, result.errors)
    }
  }
  return result
}

function printDiagnostics(label: string, diagnostics: Diagnostic[]): void {
  const output = label === 'ERROR' ? console.error : console.warn
  for (const diagnostic of diagnostics.slice(0, 20)) {
    output(`${label} ${diagnostic.code}: ${diagnostic.message}`)
  }
  if (diagnostics.length > 20) {
    output(`${label}: ... ${diagnostics.length - 20} more diagnostics`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const unknown = args.filter(arg => arg !== '--require-approved')
  if (unknown.length > 0) {
    console.error(`Usage: bun scripts/check-design-docs.ts [--require-approved]; unknown: ${unknown.join(', ')}`)
    process.exitCode = 2
    return
  }
  const result = await checkDesignDocs({
    cwd: process.cwd(),
    requireApproved: args.includes('--require-approved'),
  })
  printDiagnostics('ERROR', result.errors)
  printDiagnostics('WARN', result.warnings)
  console.log(`Design docs: ${result.errors.length} errors, ${result.warnings.length} warnings`)
  process.exitCode = result.errors.length > 0 ? 1 : 0
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  })
}
