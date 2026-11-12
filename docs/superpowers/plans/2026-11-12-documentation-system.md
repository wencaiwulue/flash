# Documentation System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the documentation registry, coverage/exclusion checker, CLI, and initial `documentation-system` ownership records required before subsystem specs can be written safely.

**Architecture:** A single Bun/TypeScript checker owns manifest parsing, unique file ownership, explicit exclusions, spec/frontmatter validation, Markdown links, and strict-mode promotion of incomplete coverage. YAML files are the machine-readable source of truth; Markdown specs contain design prose, while `INDEX.md` contains navigation only. This plan implements only the shared documentation-system foundation; `query-core`, `plugins`, and each later domain receive independent spec → plan → implementation cycles rather than placeholder tasks here.

**Tech Stack:** Bun 1.3.14, TypeScript strict, Bun test, `yaml`, Zod v4, Git, existing Bun test runner.

## Global Constraints

- Cover hand-written files under exactly `src/`, `tests/`, and `scripts/`; do not scan `dist/` or dependency directories.
- Every in-scope file must ultimately have exactly one primary spec; generated and binary files under the scanned roots require explicit, justified exclusions.
- `src/entrypoints/sdk/settingsTypes.generated.ts` is a hand-written compatibility re-export and MUST NOT be excluded. Generated exclusions are `coreTypes.generated.ts`, `controlTypes.ts`, and `src/types/generated/**`.
- Intermediate checks report uncovered files and planned/draft specs as warnings; `--require-approved` promotes those warnings to errors. Structural errors always fail.
- Planned registry entries have neither spec nor coverage files. Draft/approved entries require real spec and coverage files; no empty placeholder documents.
- Specs use nine numbered sections, frontmatter `id`, `batch`, and `status`, and a bidirectional coverage link. Actual command results belong in `STATUS.md`, not in specs.
- Do not modify product implementation under `src/`; only docs, `scripts/check-design-docs.ts`, and `tests/designDocs*.test.ts` may change.
- Use the existing Bun test discovery in `scripts/test.ts`; do not add dependencies or a second test runner.
- Commits are local only; do not push.

## 实施理由与步骤依据

先固定 YAML 契约，再实现覆盖集合和排除规则，后续 spec/link 检查才能复用同一份已解析数据。随后添加 CLI，确保交互行为与库函数一致。最后才登记真实仓库：这样初始 manifest、coverage 和文档模板会由已经通过 fixture 测试的校验器验证，而不是先写一大批无法检查的元数据。

每个任务都采用失败测试 → 最小实现 → 通过测试 → 独立提交。回滚只需 revert 对应提交；没有数据库、生成状态或产品运行时迁移。全量测试和 build 放在真实仓库登记之后，用于确认新增测试发现机制和文档工具没有破坏现有交付。

## File Structure

- Create `scripts/check-design-docs.ts`: YAML schemas, ownership/exclusion checks, spec/link checks, Git file discovery, and CLI.
- Create `tests/designDocsModel.test.ts`: manifest and coverage schema tests.
- Create `tests/designDocsOwnership.test.ts`: unique ownership, ghost files, exclusions, and incomplete coverage tests.
- Create `tests/designDocs.test.ts`: complete fixture, spec/frontmatter/section/link checks, and final real-repository structural test.
- Create `tests/designDocsCli.test.ts`: CLI exit codes and diagnostic output.
- Create `docs/architecture/INDEX.md`: subsystem navigation and status.
- Create `docs/architecture/coverage/manifest.yaml`: roots, spec registry, and generated-file exclusions.
- Create `docs/architecture/coverage/documentation-system.yaml`: primary ownership of the checker and its four test files.
- Modify `docs/superpowers/specs/TEMPLATE.md`: nine-section retrospective spec contract.
- Modify `docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md`: registry metadata, section-six title, and coverage backlink.
- Modify `docs/COMMIT_DOCS.md`: ownership, evidence, exclusion, and review policy.
- Modify `docs/ARCHITECTURE.md`: link to subsystem navigation.

---

### Task 1: Parse and Validate YAML Contracts

**Files:**
- Create: `scripts/check-design-docs.ts`
- Test: `tests/designDocsModel.test.ts`

**Interfaces:**
- Produces: `ROOTS`, `Manifest`, `Coverage`, `Diagnostic`, `CheckResult`, `loadManifest(cwd: string): Promise<Manifest>`, and `loadCoverage(cwd: string, path: string): Promise<Coverage>`.
- Consumes: existing `yaml` and `zod` packages; no project code imports.

- [ ] **Step 1: Write the failing schema tests**

Create `tests/designDocsModel.test.ts` with this complete content. The valid case fixes the exact registry shape; the invalid case proves malformed groups are rejected rather than silently ignored.

```typescript
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import { loadCoverage, loadManifest } from '../scripts/check-design-docs.ts'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'design-docs-model-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function put(path: string, content: string): void {
  const absolute = join(cwd, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function manifest(): Record<string, unknown> {
  return {
    schema_version: 1,
    roots: ['src', 'tests', 'scripts'],
    specs: [{
      id: 'system',
      spec: 'docs/superpowers/specs/system-design.md',
      coverage: 'docs/architecture/coverage/system.yaml',
      batch: 0,
      status: 'approved',
    }],
    exclusions: [{
      glob: 'src/generated.ts',
      reason: 'Generated by the fixture generator.',
      source_spec: 'system',
    }],
  }
}

function coverage(): Record<string, unknown> {
  return {
    schema_version: 1,
    spec_id: 'system',
    spec: '../../superpowers/specs/system-design.md',
    status: 'approved',
    groups: [{
      id: 'source',
      kind: 'source',
      section: 4,
      summary: 'Fixture source.',
      files: ['src/index.ts'],
    }],
  }
}

test('loads valid manifest and coverage contracts', async () => {
  put('docs/architecture/coverage/manifest.yaml', stringify(manifest()))
  put('docs/architecture/coverage/system.yaml', stringify(coverage()))

  const loadedManifest = await loadManifest(cwd)
  const loadedCoverage = await loadCoverage(
    cwd,
    'docs/architecture/coverage/system.yaml',
  )

  expect(loadedManifest.specs[0]?.id).toBe('system')
  expect(loadedManifest.roots).toEqual(['src', 'tests', 'scripts'])
  expect(loadedCoverage.groups[0]?.files).toEqual(['src/index.ts'])
})

test('rejects malformed coverage groups with their field path', async () => {
  const invalid = coverage()
  invalid.groups = [{
    id: 'bad',
    kind: 'source',
    section: 10,
    summary: '',
    files: [],
  }]
  put('docs/architecture/coverage/system.yaml', stringify(invalid))

  await expect(loadCoverage(
    cwd,
    'docs/architecture/coverage/system.yaml',
  )).rejects.toThrow('groups.0.section')
})
```

- [ ] **Step 2: Run the tests and verify the module is missing**

Run:

```bash
bun test tests/designDocsModel.test.ts
```

Expected: FAIL with `Cannot find module '../scripts/check-design-docs.ts'`.

- [ ] **Step 3: Implement the schemas and loaders**

Create `scripts/check-design-docs.ts` with this complete content. Repository paths forbid absolute paths, parent traversal, and backslashes; coverage backreferences are validated later because they legitimately contain `..`.

```typescript
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
```

- [ ] **Step 4: Run the schema tests**

Run:

```bash
bun test tests/designDocsModel.test.ts
```

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-design-docs.ts tests/designDocsModel.test.ts
git commit -m "Add design documentation schemas" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

---

### Task 2: Enforce Unique Ownership and Explicit Exclusions

**Files:**
- Modify: `scripts/check-design-docs.ts`
- Test: `tests/designDocsOwnership.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `CheckResult`, `Diagnostic`, `ROOTS`, and `loadCoverage()` from Task 1.
- Produces: `checkOwnership(options: { cwd: string; manifest: Manifest; files: string[]; requireApproved?: boolean }): Promise<CheckResult>`.

- [ ] **Step 1: Write the failing ownership tests**

Create `tests/designDocsOwnership.test.ts` with this complete content. These cases distinguish warnings from strict errors and prove that duplicate ownership, ghost paths, stale exclusions, and unknown source specs cannot pass silently.

```typescript
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import {
  checkOwnership,
  loadManifest,
  MANIFEST_PATH,
} from '../scripts/check-design-docs.ts'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'design-docs-ownership-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function put(path: string, content: string): void {
  const absolute = join(cwd, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function manifest(): Record<string, any> {
  return {
    schema_version: 1,
    roots: ['src', 'tests', 'scripts'],
    specs: [{
      id: 'system',
      spec: 'docs/superpowers/specs/system-design.md',
      coverage: 'docs/architecture/coverage/system.yaml',
      batch: 0,
      status: 'approved',
    }],
    exclusions: [{
      glob: 'src/generated.ts',
      reason: 'Generated by the fixture generator.',
      source_spec: 'system',
    }],
  }
}

function coverage(): Record<string, any> {
  return {
    schema_version: 1,
    spec_id: 'system',
    spec: '../../superpowers/specs/system-design.md',
    status: 'approved',
    groups: [
      {
        id: 'source', kind: 'source', section: 4,
        summary: 'Source.', files: ['src/index.ts'],
      },
      {
        id: 'tests', kind: 'test', section: 7,
        summary: 'Tests.', files: ['tests/system.test.ts'],
      },
      {
        id: 'scripts', kind: 'script', section: 4,
        summary: 'Scripts.', files: ['scripts/build.ts'],
      },
    ],
  }
}

const files = [
  'src/index.ts',
  'src/generated.ts',
  'tests/system.test.ts',
  'scripts/build.ts',
]

async function setup(): Promise<void> {
  put(MANIFEST_PATH, stringify(manifest()))
  put('docs/architecture/coverage/system.yaml', stringify(coverage()))
  put('src/generated.ts', '// generated fixture\n')
}

test('accepts complete unique coverage plus an explicit exclusion', async () => {
  await setup()
  const result = await checkOwnership({
    cwd,
    manifest: await loadManifest(cwd),
    files,
  })
  expect(result).toEqual({ errors: [], warnings: [] })
})

test('rejects duplicate ownership and ghost coverage paths', async () => {
  await setup()
  const invalid = coverage()
  invalid.groups[0].files.push('src/index.ts', 'src/ghost.ts')
  put('docs/architecture/coverage/system.yaml', stringify(invalid))

  const result = await checkOwnership({
    cwd,
    manifest: await loadManifest(cwd),
    files,
  })
  expect(result.errors.map(issue => issue.code)).toContain('DUPLICATE_FILE')
  expect(result.errors.map(issue => issue.code)).toContain('GHOST_COVERAGE')
})

test('rejects stale exclusions and unknown source specs', async () => {
  const invalid = manifest()
  invalid.exclusions[0].glob = 'src/missing.ts'
  invalid.exclusions[0].source_spec = 'unknown'
  put(MANIFEST_PATH, stringify(invalid))
  put('docs/architecture/coverage/system.yaml', stringify(coverage()))

  const result = await checkOwnership({
    cwd,
    manifest: await loadManifest(cwd),
    files,
  })
  expect(result.errors.map(issue => issue.code)).toContain('STALE_EXCLUSION')
  expect(result.errors.map(issue => issue.code)).toContain('UNKNOWN_SOURCE_SPEC')
})

test('promotes uncovered files to errors only in strict mode', async () => {
  await setup()
  const withExtraFile = [...files, 'src/uncovered.ts']
  const loaded = await loadManifest(cwd)

  const normal = await checkOwnership({ cwd, manifest: loaded, files: withExtraFile })
  const strict = await checkOwnership({
    cwd,
    manifest: loaded,
    files: withExtraFile,
    requireApproved: true,
  })

  expect(normal.errors).toEqual([])
  expect(normal.warnings.map(issue => issue.code)).toContain('UNCOVERED_FILE')
  expect(strict.errors.map(issue => issue.code)).toContain('UNCOVERED_FILE')
})
```

- [ ] **Step 2: Run the ownership tests and verify the missing export**

Run:

```bash
bun test tests/designDocsOwnership.test.ts
```

Expected: FAIL because `checkOwnership` is not exported.

- [ ] **Step 3: Implement ownership and exclusion checks**

In `scripts/check-design-docs.ts`, replace the two Node import lines with:

```typescript
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
```

Append this complete implementation. `scan()` evaluates exclusions against actual files on disk; the `files` argument defines the repository universe, which keeps unit fixtures deterministic and lets production use `git ls-files`.

```typescript
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
```

- [ ] **Step 4: Run both schema and ownership tests**

Run:

```bash
bun test tests/designDocsModel.test.ts tests/designDocsOwnership.test.ts
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-design-docs.ts tests/designDocsOwnership.test.ts
git commit -m "Validate design document ownership" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

---

### Task 3: Validate Specs, Navigation, and Local Links

**Files:**
- Modify: `scripts/check-design-docs.ts`
- Test: `tests/designDocs.test.ts`

**Interfaces:**
- Consumes: `checkOwnership()`, `loadManifest()`, `SpecEntry`, `INDEX_PATH`, and `CheckResult`.
- Produces: `REQUIRED_HEADINGS`, `listRepositoryFiles(cwd: string): Promise<string[]>`, and `checkDesignDocs(options: { cwd: string; files?: string[]; requireApproved?: boolean }): Promise<CheckResult>`.

- [ ] **Step 1: Write the failing integration tests**

Create `tests/designDocs.test.ts` with this complete content. The fixture proves a fully linked approved spec passes; mutation cases prove metadata, required sections, bidirectional links, INDEX membership, and planned semantics are all checked.

```typescript
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stringify } from 'yaml'
import {
  checkDesignDocs,
  INDEX_PATH,
  MANIFEST_PATH,
} from '../scripts/check-design-docs.ts'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'design-docs-integration-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function put(path: string, content: string): void {
  const absolute = join(cwd, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function manifest(): Record<string, any> {
  return {
    schema_version: 1,
    roots: ['src', 'tests', 'scripts'],
    specs: [{
      id: 'system',
      spec: 'docs/superpowers/specs/system-design.md',
      coverage: 'docs/architecture/coverage/system.yaml',
      batch: 0,
      status: 'approved',
    }],
    exclusions: [{
      glob: 'src/generated.ts',
      reason: 'Generated by the fixture generator.',
      source_spec: 'system',
    }],
  }
}

function coverage(): Record<string, any> {
  return {
    schema_version: 1,
    spec_id: 'system',
    spec: '../../superpowers/specs/system-design.md',
    status: 'approved',
    groups: [
      { id: 'source', kind: 'source', section: 4, summary: 'Source.', files: ['src/index.ts'] },
      { id: 'tests', kind: 'test', section: 7, summary: 'Tests.', files: ['tests/system.test.ts'] },
      { id: 'scripts', kind: 'script', section: 4, summary: 'Scripts.', files: ['scripts/build.ts'] },
    ],
  }
}

function specText(): string {
  return `---
id: system
batch: 0
title: System
status: approved
---
# System

## 1. 问题与约束

问题与约束正文。

## 2. 设计理由与备选方案

设计理由与备选方案正文。

## 3. 目标与非目标

目标与非目标正文。

## 4. 架构、模块与数据流

架构、模块与数据流正文。

## 5. 失败语义与工程取舍

失败语义与工程取舍正文。

## 6. 现状验收标准

现状验收标准正文。

## 7. 代码与测试证据

代码与测试证据正文。

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/system.yaml)

## 9. 改进建议

改进建议正文。
`
}

const files = [
  'src/index.ts',
  'src/generated.ts',
  'tests/system.test.ts',
  'scripts/build.ts',
]

function createCompleteFixture(): void {
  put(MANIFEST_PATH, stringify(manifest()))
  put('docs/architecture/coverage/system.yaml', stringify(coverage()))
  put('docs/superpowers/specs/system-design.md', specText())
  put(INDEX_PATH, '# Architecture\n\n[System](../superpowers/specs/system-design.md)\n')
  put('src/index.ts', 'export {}\n')
  put('src/generated.ts', '// generated fixture\n')
  put('tests/system.test.ts', '// test fixture\n')
  put('scripts/build.ts', '// build fixture\n')
}

test('accepts a complete approved and linked fixture', async () => {
  createCompleteFixture()
  const result = await checkDesignDocs({ cwd, files })
  expect(result).toEqual({ errors: [], warnings: [] })
})

test('rejects metadata, section, backlink, INDEX, and Markdown failures', async () => {
  createCompleteFixture()
  put(
    'docs/superpowers/specs/system-design.md',
    specText()
      .replace('id: system', 'id: other')
      .replace('## 2. 设计理由与备选方案', '## 2. Wrong')
      .replace('../../architecture/coverage/system.yaml', '../../architecture/coverage/missing.yaml'),
  )
  put(INDEX_PATH, '# Architecture\n\n[Missing](missing-spec.md)\n')

  const result = await checkDesignDocs({ cwd, files })
  const codes = result.errors.map(issue => issue.code)
  for (const code of [
    'SPEC_METADATA',
    'MISSING_SECTION',
    'SPEC_COVERAGE_LINK',
    'INDEX_SPEC_LINK',
    'BROKEN_LINK',
  ]) {
    expect(codes).toContain(code)
  }
})

test('allows artifact-free planned entries normally and rejects them strictly', async () => {
  createCompleteFixture()
  const value = manifest()
  value.specs.push({
    id: 'future',
    spec: 'docs/superpowers/specs/future-design.md',
    coverage: 'docs/architecture/coverage/future.yaml',
    batch: 1,
    status: 'planned',
  })
  put(MANIFEST_PATH, stringify(value))

  const normal = await checkDesignDocs({ cwd, files })
  const strict = await checkDesignDocs({ cwd, files, requireApproved: true })
  expect(normal.errors).toEqual([])
  expect(normal.warnings.map(issue => issue.code)).toContain('PLANNED_SPEC')
  expect(strict.errors.map(issue => issue.code)).toContain('PLANNED_SPEC')
})
```

- [ ] **Step 2: Run the integration tests and verify the missing export**

Run:

```bash
bun test tests/designDocs.test.ts
```

Expected: FAIL because `checkDesignDocs` is not exported.

- [ ] **Step 3: Implement document checks and Git discovery**

Append this complete implementation to `scripts/check-design-docs.ts`. Only non-planned specs require bodies and links; this prevents planned registrations from becoming empty placeholder documents.

```typescript
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
    if (!pathPart || !existsSync(resolve(cwd, dirname(path), decodeURIComponent(pathPart)))) {
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
  if (metadata.id !== entry.id || metadata.batch !== entry.batch || metadata.status !== entry.status) {
    errors.push({ code: 'SPEC_METADATA', message: `Frontmatter does not match manifest: ${entry.id}` })
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
  if (!existsSync(resolve(cwd, INDEX_PATH))) {
    result.errors.push({ code: 'MISSING_INDEX', message: `Missing ${INDEX_PATH}` })
    return result
  }
  const indexContent = await readFile(resolve(cwd, INDEX_PATH), 'utf8')
  checkMarkdownLinks(cwd, INDEX_PATH, indexContent, result.errors)
  for (const entry of manifest.specs) {
    if (entry.status !== 'planned') {
      await checkSpecDocument(cwd, entry, indexContent, result.errors)
    }
  }
  return result
}
```

- [ ] **Step 4: Run all documentation checker tests**

Run:

```bash
bun test tests/designDocsModel.test.ts tests/designDocsOwnership.test.ts tests/designDocs.test.ts
```

Expected: 9 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-design-docs.ts tests/designDocs.test.ts
git commit -m "Validate design spec documents" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

---

### Task 4: Add the CLI and Strict Exit Semantics

**Files:**
- Modify: `scripts/check-design-docs.ts`
- Test: `tests/designDocsCli.test.ts`

**Interfaces:**
- Consumes: `checkDesignDocs()` and `REQUIRED_HEADINGS`.
- Produces: `bun scripts/check-design-docs.ts [--require-approved]`; exit 0 for valid/intermediate checks, 1 for validation failures, 2 for usage/runtime failures.

- [ ] **Step 1: Write the failing CLI test**

Create `tests/designDocsCli.test.ts` with this complete content. A real temporary Git repository exercises the production `git ls-files` path rather than the injected fixture array.

```typescript
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stringify } from 'yaml'
import {
  INDEX_PATH,
  MANIFEST_PATH,
  REQUIRED_HEADINGS,
} from '../scripts/check-design-docs.ts'

let cwd: string
const checker = resolve(import.meta.dir, '../scripts/check-design-docs.ts')

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'design-docs-cli-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function put(path: string, content: string): void {
  const absolute = join(cwd, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function git(...args: string[]): void {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function run(...args: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, checker, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  }
}

function createFixture(): void {
  put(MANIFEST_PATH, stringify({
    schema_version: 1,
    roots: ['src', 'tests', 'scripts'],
    specs: [{
      id: 'system',
      spec: 'docs/superpowers/specs/system-design.md',
      coverage: 'docs/architecture/coverage/system.yaml',
      batch: 0,
      status: 'approved',
    }],
    exclusions: [],
  }))
  put('docs/architecture/coverage/system.yaml', stringify({
    schema_version: 1,
    spec_id: 'system',
    spec: '../../superpowers/specs/system-design.md',
    status: 'approved',
    groups: [{
      id: 'source', kind: 'source', section: 4,
      summary: 'Source.', files: ['src/index.ts'],
    }],
  }))
  const headings = REQUIRED_HEADINGS.map(heading => `${heading}\n\n正文。\n`).join('\n')
  put('docs/superpowers/specs/system-design.md', `---
id: system
batch: 0
title: System
status: approved
---
# System

${headings}
[Coverage](../../architecture/coverage/system.yaml)
`)
  put(INDEX_PATH, '# Architecture\n\n[System](../superpowers/specs/system-design.md)\n')
  put('src/index.ts', 'export {}\n')
  git('init', '-q')
  git('add', '.')
}

test('CLI distinguishes intermediate, strict, and usage failures', () => {
  createFixture()
  expect(run().exitCode).toBe(0)
  expect(run('--require-approved').exitCode).toBe(0)

  put('src/uncovered.ts', 'export {}\n')
  git('add', 'src/uncovered.ts')
  const normal = run()
  expect(normal.exitCode).toBe(0)
  expect(normal.output).toContain('UNCOVERED_FILE')

  const strict = run('--require-approved')
  expect(strict.exitCode).toBe(1)
  expect(strict.output).toContain('UNCOVERED_FILE')
  expect(run('--unknown').exitCode).toBe(2)
}, 15000)
```

- [ ] **Step 2: Run the CLI test and verify strict failure is missing**

Run:

```bash
bun test tests/designDocsCli.test.ts
```

Expected: FAIL because the final strict invocation exits 0 instead of 1; the script has no CLI entrypoint yet.

- [ ] **Step 3: Add the CLI entrypoint**

Append this complete code to `scripts/check-design-docs.ts`. Limit printed diagnostics so the initial full-repository report remains readable while preserving the exact total.

```typescript
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
```

- [ ] **Step 4: Run all four documentation test files**

Run:

```bash
bun test tests/designDocsModel.test.ts tests/designDocsOwnership.test.ts tests/designDocs.test.ts tests/designDocsCli.test.ts
```

Expected: 10 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-design-docs.ts tests/designDocsCli.test.ts
git commit -m "Add design documentation checker CLI" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

---

### Task 5: Bootstrap the Real Registry and Documentation Policy

**Files:**
- Modify: `tests/designDocs.test.ts`
- Modify: `docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md`
- Modify: `docs/superpowers/specs/TEMPLATE.md`
- Modify: `docs/COMMIT_DOCS.md`
- Modify: `docs/ARCHITECTURE.md`
- Create: `docs/architecture/INDEX.md`
- Create: `docs/architecture/coverage/manifest.yaml`
- Create: `docs/architecture/coverage/documentation-system.yaml`

**Interfaces:**
- Consumes: production `checkDesignDocs()` and CLI from Tasks 1–4.
- Produces: valid `documentation-system` registration, six generated-file exclusions, and two artifact-free planned source specs (`sdk-type-generation`, `telemetry`).

- [ ] **Step 1: Add the failing real-repository test**

Append this test to `tests/designDocs.test.ts`; its existing imports already include `resolve` and `checkDesignDocs`. Warnings are expected until later domain plans finish, but no structural error is acceptable.

```typescript
test('repository documentation registry has no structural errors', async () => {
  const result = await checkDesignDocs({ cwd: resolve(import.meta.dir, '..') })
  expect(result.errors).toEqual([])
  expect(result.warnings).toContainEqual({
    code: 'UNCOVERED_FILE',
    message: 'File has no primary spec or exclusion: src/entrypoints/sdk/settingsTypes.generated.ts',
  })
})
```

- [ ] **Step 2: Run the real-repository test and verify the registry is absent**

Run:

```bash
bun test tests/designDocs.test.ts -t "repository documentation registry"
```

Expected: FAIL with an error reading `docs/architecture/coverage/manifest.yaml`.

- [ ] **Step 3: Create the real registry and update governance docs**

3a. In `docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md`, make the frontmatter exactly:

```yaml
---
id: documentation-system
batch: 0
title: 全项目代码设计文档体系
date: 2026-11-12
status: approved
---
```

Rename `## 6. 验收标准` to `## 6. 现状验收标准`. In section 8, immediately after the paragraph beginning “本总 spec 定义文档体系”, add this bidirectional link:

```markdown
[Documentation-system coverage](../../architecture/coverage/documentation-system.yaml)
```

3b. Replace `docs/superpowers/specs/TEMPLATE.md` with:

```markdown
---
id: <subsystem-id>
batch: <nonnegative-integer>
title: <subsystem-name>
date: <YYYY-MM-DD>
status: draft | approved
---

# <Subsystem Name>

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

<当前行为、用户/系统问题、责任范围、internal/external 条件和成功标准>

## 2. 设计理由与备选方案

<当前结构解决的问题、代价、至少一个备选方案及不采用原因；无直接证据的历史动机标为“设计推断”>

## 3. 目标与非目标

<该子系统当前承担和明确不承担的职责>

## 4. 架构、模块与数据流

<入口、公共接口、状态所有权、控制流、数据流、持久化和跨 spec 依赖>

## 5. 失败语义与工程取舍

<错误、取消、重试、并发、兼容性、安全、资源清理和性能取舍>

## 6. 现状验收标准

<可独立判断的应然行为，不写历史执行结果>

## 7. 代码与测试证据

<仓库相对路径、符号、测试文件、测试场景及其覆盖的不变量>

## 8. 文件覆盖与相关子系统

<链接本 spec 的 coverage YAML，列出上游、下游和共享证据>

## 9. 改进建议

<按 P0–P3 列出证据、触发场景、建议方向、回归代价、验收方式、S/M/L 工作量和置信度>
```

3c. Append this section to `docs/COMMIT_DOCS.md`:

```markdown
## 回溯性子系统设计档案

- 子系统 spec 必须具有 frontmatter `id`、`batch`、`status`，并使用九章模板。planned 只在 manifest 注册，不创建空 spec 或 coverage；draft/approved 必须有完整正文。
- `src/`、`tests/`、`scripts/` 的每个手写文件恰有一个主 spec。功能专用入口、命令、UI、hook 与测试按运行时职责归属，跨域引用不复制正文或重复归属。
- `docs/architecture/coverage/manifest.yaml` 是 roots、spec 注册与排除规则的唯一来源；coverage YAML 显式列文件，`docs/architecture/INDEX.md` 只负责导航。
- 生成代码和二进制排除必须有有界 glob、原因与 `source_spec`。不得按文件名或扩展名猜测：`src/entrypoints/sdk/settingsTypes.generated.ts` 是手写 re-export，必须纳入覆盖。
- 关键行为使用路径与符号佐证。测试存在不等于通过，mock 不等于 live；实际结果只写入 `docs/STATUS.md` 或验证记录。
- 每批同时运行结构检查和人工语义评审。自动检查通过不证明架构语义正确，也不能替代对“设计推断”和 P0/P1 建议证据的审查。
```

3d. Append this section to `docs/ARCHITECTURE.md`:

```markdown
## Subsystem design specifications

The retrospective subsystem designs, review status, and primary file ownership index are maintained in [Subsystem design specs](architecture/INDEX.md). This page remains the product-level summary; subsystem prose lives in the linked specs rather than being duplicated here.
```

3e. Create `docs/architecture/INDEX.md`:

```markdown
# Subsystem design specs

本索引只负责导航。设计正文位于 spec，文件主归属位于 coverage；planned 条目在正文获批前不创建空文件或链接。

| Spec ID | Batch | Status | Design | Coverage |
|---|---:|---|---|---|
| `documentation-system` | 0 | approved | [全项目代码设计文档体系](../superpowers/specs/2026-11-12-codebase-design-docs-design.md) | [coverage](coverage/documentation-system.yaml) |
| `sdk-type-generation` | 0 | planned | SDK schema 与类型生成 | 待对应 spec 批准后登记 |
| `telemetry` | 0 | planned | 遥测契约与 protobuf 生成边界 | 待对应 spec 批准后登记 |
```

3f. Create `docs/architecture/coverage/manifest.yaml`:

```yaml
schema_version: 1
roots:
  - src
  - tests
  - scripts
specs:
  - id: documentation-system
    spec: docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md
    coverage: docs/architecture/coverage/documentation-system.yaml
    batch: 0
    status: approved
  - id: sdk-type-generation
    spec: docs/superpowers/specs/2026-11-12-sdk-type-generation-design.md
    coverage: docs/architecture/coverage/sdk-type-generation.yaml
    batch: 0
    status: planned
  - id: telemetry
    spec: docs/superpowers/specs/2026-11-12-telemetry-design.md
    coverage: docs/architecture/coverage/telemetry.yaml
    batch: 0
    status: planned
exclusions:
  - glob: src/entrypoints/sdk/coreTypes.generated.ts
    reason: Generated by scripts/generate-sdk-types.ts from src/entrypoints/sdk/coreSchemas.ts.
    source_spec: sdk-type-generation
  - glob: src/entrypoints/sdk/controlTypes.ts
    reason: Generated by scripts/generate-sdk-types.ts from src/entrypoints/sdk/controlSchemas.ts.
    source_spec: sdk-type-generation
  - glob: src/types/generated/**
    reason: protoc-gen-ts_proto output; source protobuf names are recorded in each generated file header.
    source_spec: telemetry
# settingsTypes.generated.ts is a hand-written compatibility re-export, not an exclusion.
```

3g. Create `docs/architecture/coverage/documentation-system.yaml`:

```yaml
schema_version: 1
spec_id: documentation-system
spec: ../../superpowers/specs/2026-11-12-codebase-design-docs-design.md
status: approved
groups:
  - id: documentation-checker
    kind: script
    section: 4
    summary: Registry, ownership, exclusion, spec, link, Git discovery, and CLI validation.
    files:
      - scripts/check-design-docs.ts
  - id: documentation-checker-tests
    kind: test
    section: 7
    summary: Schema, ownership, document, CLI, and real-repository verification.
    files:
      - tests/designDocsModel.test.ts
      - tests/designDocsOwnership.test.ts
      - tests/designDocs.test.ts
      - tests/designDocsCli.test.ts
```

- [ ] **Step 4: Verify the real registry and full repository regression**

Run the focused tests first:

```bash
bun test tests/designDocsModel.test.ts tests/designDocsOwnership.test.ts tests/designDocs.test.ts tests/designDocsCli.test.ts
bun scripts/check-design-docs.ts
```

Expected: 11 tests pass, 0 fail. The real-repository test directly asserts that `settingsTypes.generated.ts` remains an `UNCOVERED_FILE` warning rather than an exclusion. The CLI prints `0 errors`; warnings are the still-uncovered files and two planned specs.

Then run the repository gates:

```bash
bun run typecheck
bun run test
bun run build
git diff --check
git diff --name-only 5294289 -- src
```

Expected: typecheck, all tests, build, and whitespace checks exit 0; the final command prints no product source changes. Do not run `--require-approved` as a passing gate yet: it must fail until all later subsystem specs are approved and coverage is complete.

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md docs/COMMIT_DOCS.md docs/architecture/INDEX.md docs/architecture/coverage/manifest.yaml docs/architecture/coverage/documentation-system.yaml docs/superpowers/specs/TEMPLATE.md docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md tests/designDocs.test.ts
git commit -m "Bootstrap subsystem documentation registry" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
```

## Final Handoff

After Task 5, the documentation-system foundation is independently usable and tested. The next independent planning unit is the `query-core` retrospective subsystem spec, followed by `plugins`; their implementation plans must register real files, replace warnings with owned coverage, and preserve the no-placeholder rule. Strict `--require-approved` becomes a passing gate only after every later domain cycle is complete.
