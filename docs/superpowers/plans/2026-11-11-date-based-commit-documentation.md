# Date-Based Commit Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every commit SPEC/PLAN to stable `YYYY-MM-DD-feature-slug` paths and remove historical execution results while retaining substantive designs, file-level steps, and acceptance criteria.

**Architecture:** Keep full SHA as the record identity and add a pure naming module between validated records and rendering. A one-time AST-position-based codemod mechanically updates all records, followed by explicit semantic cleanup; rendering, indexes, policies, generated documents, and old-path removal ship as one atomic migration.

**Tech Stack:** Bun 1.3+, TypeScript, Bun test, Git, existing `scripts/commit-docs` modules; no new runtime dependency.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md`.
- Historical paths are `docs/specs/YYYY-MM-DD-<feature-slug>-SPEC.md` and `docs/plans/YYYY-MM-DD-<feature-slug>-PLAN.md`.
- Slugs match `^[a-z0-9]+(?:-[a-z0-9]+)*$`; dates come from the first ten characters of `%cI`.
- Same-day/same-slug suffixes are empty, `-02`, `-03` in `git rev-list --reverse --topo-order HEAD` order; any remaining collision fails.
- Full SHA remains in frontmatter and both indexes. Internal record filenames remain SHA-based.
- `self-SPEC.md` and `self-PLAN.md` remain fixed; `self` still requires a slug for later finalization.
- Do not rewrite Git history, product source, commit messages, or historical execution evidence into a new form. Remove execution results and retain acceptance criteria.
- Do not replace design prose automatically. Mechanical edits are limited to `slug`, `evidence`, `verification`, and stale reference roles.
- CI remains read-only. Never run the writer as part of `docs:check`.
- Current planning HEAD is `4909c0fccbf24736f5c670ef936bae317e52dd4c` with 95 commits. `--next` therefore covers 95 historical records plus `self`, producing 192 SPEC/PLAN files.
- Use one atomic implementation commit. Intermediate commits would each require another self/SHA metadata migration and would leave the repository documentation gate red.
- Every task ends with its stated test/checkpoint; the sole implementation commit is Task 8.

## File Structure

- Create `scripts/commit-docs/naming.ts`: pure date/slug/sequence/path calculation.
- Modify `scripts/commit-docs/schema.ts`: add `slug`, remove execution-evidence types, rename `plan.verification`.
- Modify `scripts/commit-docs/validate.ts`: validate naming and legacy fields; remove evidence-source validation.
- Modify `scripts/commit-docs/render.ts`: consume naming module, remove evidence section, emit acceptance sequence and new indexes.
- Modify `scripts/commit-docs/records/*.ts`: explicit slugs and cleaned design records.
- Create `scripts/commit-docs/records/c69c271.ts` and `4909c0f.ts`: finalize records missing from `--next`.
- Replace `scripts/commit-docs/records/self.ts`: describe this migration without execution claims.
- Modify `tests/commitDocs.test.ts`: naming, legacy rejection, rendering, and retained validation tests.
- Modify `docs/COMMIT_DOCS.md`, `docs/specs/template.md`, `docs/plans/template.md`: current authoring contract.
- Regenerate `docs/specs`, `docs/plans`, `docs/INDEX.md`, and `docs/status/index.json`; remove old seven-hex paths.

---

### Task 1: Pure Document Naming

**Files:**
- Create: `scripts/commit-docs/naming.ts`
- Test: `tests/commitDocs.test.ts`

**Interfaces:**
- Consumes: existing `Commit` from `schema.ts`.
- Produces: `DocumentPaths`, `SELF_DOCUMENT_PATHS`, `SLUG_PATTERN`, and `historicalDocumentPaths(commits, getRecord)` for Tasks 2 and 7.

- [ ] **Step 1: Add failing naming tests**

Append these tests to `tests/commitDocs.test.ts` and add the named imports:

```ts
import {
  historicalDocumentPaths,
  SELF_DOCUMENT_PATHS,
} from '../scripts/commit-docs/naming.ts'

function namingCommit(letter: string, date = '2026-11-11T10:00:00+08:00'): Commit {
  return {
    full: letter.repeat(40),
    short: letter.repeat(7),
    date,
    subject: `Commit ${letter}`,
  }
}

function pathsFor(
  commits: Commit[],
  slugs: Record<string, string>,
) {
  return historicalDocumentPaths(commits, full => {
    const slug = slugs[full]
    return slug === undefined ? undefined : { slug }
  })
}

describe('date and feature document naming', () => {
  test('uses the committer day and stable same-day suffixes', () => {
    const commits = [namingCommit('a'), namingCommit('b'), namingCommit('c')]
    const paths = pathsFor(commits, {
      ['a'.repeat(40)]: 'feature-design',
      ['b'.repeat(40)]: 'feature-design',
      ['c'.repeat(40)]: 'feature-design',
    })
    expect(paths.get('a'.repeat(40))?.spec).toBe('docs/specs/2026-11-11-feature-design-SPEC.md')
    expect(paths.get('b'.repeat(40))?.plan).toBe('docs/plans/2026-11-11-feature-design-02-PLAN.md')
    expect(paths.get('c'.repeat(40))?.spec).toBe('docs/specs/2026-11-11-feature-design-03-SPEC.md')
  })

  test('allows the same slug on another day and keeps self fixed', () => {
    const commits = [namingCommit('a'), namingCommit('b', '2026-11-12T00:00:00Z')]
    const paths = pathsFor(commits, {
      ['a'.repeat(40)]: 'feature-design',
      ['b'.repeat(40)]: 'feature-design',
    })
    expect(paths.get('b'.repeat(40))?.spec).toBe('docs/specs/2026-11-12-feature-design-SPEC.md')
    expect(SELF_DOCUMENT_PATHS).toEqual({
      spec: 'docs/specs/self-SPEC.md',
      plan: 'docs/plans/self-PLAN.md',
    })
  })

  test('rejects invalid slugs, invalid dates, missing records, and residual collisions', () => {
    const one = [namingCommit('a')]
    expect(() => pathsFor(one, { ['a'.repeat(40)]: 'Bad Slug' })).toThrow('invalid slug')
    expect(() => pathsFor([namingCommit('a', 'not-a-date')], { ['a'.repeat(40)]: 'valid-slug' })).toThrow('invalid commit date')
    expect(() => pathsFor(one, {})).toThrow('missing record')

    const commits = [namingCommit('a'), namingCommit('b'), namingCommit('c')]
    expect(() => pathsFor(commits, {
      ['a'.repeat(40)]: 'feature',
      ['b'.repeat(40)]: 'feature',
      ['c'.repeat(40)]: 'feature-02',
    })).toThrow('document path collision')
  })
})
```

- [ ] **Step 2: Run the tests and confirm the module is missing**

Run: `bun test tests/commitDocs.test.ts`

Expected: FAIL with an import resolution error for `scripts/commit-docs/naming.ts`.

- [ ] **Step 3: Implement the pure naming module**

Create `scripts/commit-docs/naming.ts`:

```ts
import type { Commit } from './schema.ts'

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type DocumentPaths = {
  spec: string
  plan: string
  slug: string
}

export const SELF_DOCUMENT_PATHS = {
  spec: 'docs/specs/self-SPEC.md',
  plan: 'docs/plans/self-PLAN.md',
} as const

export function historicalDocumentPaths(
  commits: Commit[],
  getRecord: (fullSha: string) => { slug: string } | undefined,
): Map<string, DocumentPaths> {
  const occurrences = new Map<string, number>()
  const usedBasenames = new Map<string, string>()
  const result = new Map<string, DocumentPaths>()

  for (const commit of commits) {
    const record = getRecord(commit.full)
    if (!record) throw new Error(`${commit.short}: missing record for document naming`)
    if (typeof record.slug !== 'string' || !SLUG_PATTERN.test(record.slug)) {
      throw new Error(`${commit.short}: invalid slug: ${record.slug}`)
    }
    const date = commit.date.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`${commit.short}: invalid commit date: ${commit.date}`)
    }

    const key = `${date}/${record.slug}`
    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    const suffix = occurrence === 1 ? '' : `-${String(occurrence).padStart(2, '0')}`
    const basename = `${date}-${record.slug}${suffix}`
    const previous = usedBasenames.get(basename)
    if (previous) {
      throw new Error(`${commit.short}: document path collision with ${previous}: ${basename}`)
    }
    usedBasenames.set(basename, commit.short)
    result.set(commit.full, {
      spec: `docs/specs/${basename}-SPEC.md`,
      plan: `docs/plans/${basename}-PLAN.md`,
      slug: record.slug,
    })
  }
  return result
}
```

- [ ] **Step 4: Run naming and existing tests**

Run: `bun test tests/commitDocs.test.ts`

Expected: PASS; the new naming tests and all pre-existing tests pass.

---

### Task 2: Schema, Validation, and Rendering Contract

**Files:**
- Modify: `scripts/commit-docs/schema.ts`
- Modify: `scripts/commit-docs/validate.ts`
- Modify: `scripts/commit-docs/render.ts`
- Test: `tests/commitDocs.test.ts`

**Interfaces:**
- Consumes: `historicalDocumentPaths` and `SELF_DOCUMENT_PATHS` from Task 1.
- Produces: `CommitRecord.slug`, `plan.acceptanceSequence`, date-based `buildDocuments`, and legacy-field rejection for all later tasks.

- [ ] **Step 1: Change tests before implementation**

In `validRecord()` add `slug: 'example-design'`, remove the entire `evidence` property, and rename `verification` to `acceptanceSequence`. Remove the three evidence-specific tests (`requires a traceable source...`, `checks evidence files...`, and `requires later evidence...`). Add these tests:

```ts
test('rejects legacy execution evidence fields at runtime', () => {
  const withEvidence = validRecord() as CommitRecord & { evidence?: unknown }
  withEvidence.evidence = []
  expect(validateRecordShape(withEvidence).join('\n')).toContain('legacy evidence field')

  const withVerification = validRecord() as CommitRecord & {
    plan: CommitRecord['plan'] & { verification?: unknown }
  }
  withVerification.plan.verification = []
  expect(validateRecordShape(withVerification).join('\n')).toContain('legacy plan.verification field')

  const withEvidenceRole = validRecord()
  withEvidenceRole.references[0]!.role = 'evidence' as never
  expect(validateRecordShape(withEvidenceRole).join('\n')).toContain('legacy evidence reference role')
})

test('rejects historical execution claims outside acceptance criteria', () => {
  const record = validRecord()
  record.architecture = ['本地实际执行 bun test，16 个测试全部通过。']
  expect(validateRecordShape(record).join('\n')).toContain('historical execution result')
})

test('renders acceptance criteria without an execution evidence section', () => {
  const record = validRecord()
  const commit = namingCommit('a')
  const spec = specFor(record, commit)
  const plan = planFor(record, commit)
  expect(spec).not.toContain('## 验证证据')
  expect(spec).toContain('## 验收标准')
  expect(plan).toContain('## 验收顺序')
  expect(plan).not.toContain('## 验证顺序')
})
```

Add `specFor` and `planFor` to the existing render import.

- [ ] **Step 2: Run tests and confirm the new contract fails**

Run: `bun test tests/commitDocs.test.ts`

Expected: FAIL because the old renderer still reads `record.plan.verification` and the new legacy-field/execution-claim assertions are not implemented. `specFor` and `planFor` are already exported; do not proceed if the test file itself has syntax errors.

- [ ] **Step 3: Replace the schema contract**

In `scripts/commit-docs/schema.ts`:

- Change `ReferenceRole` to `'changed' | 'reused' | 'test'`.
- Delete `EvidenceKind`, `CommitEvidence`, and `EVIDENCE_KINDS`.
- Add `slug: string` immediately after optional `title`.
- Rename `plan.verification` to `plan.acceptanceSequence: string[]`.

The resulting core definitions are:

```ts
export type ReferenceRole = 'changed' | 'reused' | 'test'

export type CommitRecord = {
  commit: string
  changeId?: string
  title?: string
  slug: string
  kind: CommitKind
  status: CommitStatus
  beforeState: string
  problem: string
  goals: string[]
  nonGoals: string[]
  architecture: string[]
  decisions: string[]
  alternatives: string[]
  security: string[]
  acceptance: string[]
  remaining: string[]
  references: CommitReference[]
  changeGroups?: ChangeGroup[]
  plan: {
    preconditions: string[]
    reuse: string[]
    steps: PlanStep[]
    compatibility: string[]
    risks: string[]
    acceptanceSequence: string[]
    completed: string[]
    incomplete: string[]
  }
}
```

- [ ] **Step 4: Update validation without weakening existing checks**

In `scripts/commit-docs/validate.ts`:

1. Import `SLUG_PATTERN` and `historicalDocumentPaths` from `naming.ts`.
2. Remove `CommitEvidence` references, `record.evidence` from `stringsInRecord`, all evidence-shape checks, and the entire `for (const [index, evidence] of record.evidence.entries())` block.
3. Rename every `record.plan.verification` read to `record.plan.acceptanceSequence`.
4. Make the text helper tolerate missing runtime fields, then add execution-claim and legacy checks to `validateRecordShape`:

```ts
function nonempty(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length > 1 && !/^(?:n\/?a|none|不适用|无)$/i.test(normalized)
}

// Change the nested helper signature as well:
const requireString = (value: unknown, field: string) => {
  if (!nonempty(value)) errors.push(`${label}: ${field} must be substantive text`)
}
```

Add these rules inside `validateRecordShape`:
const HISTORICAL_EXECUTION_TEXT = [
  /本地实际(?:执行|运行)/,
  /(?:测试|CI|构建|typecheck|build).{0,24}(?:全部|均|已)?通过/,
  /\brun[ -]?ID\b/i,
  /recorded-(?:command|ci)-pass|later-evidence|not-recorded|diff-observed|test-added/,
]

// Inside validateRecordShape, before scanning stringsInRecord:
requireString(record.slug, 'slug')
if (record.slug && !SLUG_PATTERN.test(record.slug)) {
  errors.push(`${label}: invalid slug`)
}
if ('evidence' in record) errors.push(`${label}: legacy evidence field`)
if ('verification' in record.plan) errors.push(`${label}: legacy plan.verification field`)
for (const [index, reference] of record.references.entries()) {
  if ((reference.role as string) === 'evidence') {
    errors.push(`${label}: references[${index}] legacy evidence reference role`)
  }
}

// Append to the existing stringsInRecord(record).forEach callback:
if (HISTORICAL_EXECUTION_TEXT.some(pattern => pattern.test(value))) {
  errors.push(`${label}: historical execution result detected`)
}
```

5. At the start of `validateRecords`, validate the selected naming map and convert a thrown naming error into a collected error:

```ts
try {
  historicalDocumentPaths(selected, full => loaded.historical.get(full))
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error))
}
```

Keep SHA coverage, changed-file coverage, revision/symbol checks, rename checks, sensitive-data checks, and duplication checks unchanged.

- [ ] **Step 5: Update the renderer**

In `scripts/commit-docs/render.ts`:

1. Remove `CommitEvidence` import, `evidence` from `ROLE_LABELS`, and `evidenceSource`.
2. Delete the complete `## 验证证据` table from `specFor`.
3. Replace the PLAN heading and field with `## 验收顺序` and `record.plan.acceptanceSequence`.
4. Import naming helpers and replace SHA path construction inside `buildDocuments`:

```ts
import { historicalDocumentPaths, SELF_DOCUMENT_PATHS } from './naming.ts'

// Immediately after selected/count initialization:
const documentPaths = historicalDocumentPaths(
  selected,
  full => loaded.historical.get(full),
)

// At the start of each commit loop:
const paths = documentPaths.get(commit.full)!

// Replace spec/plan path creation and every subsequent spec/plan use:
documents.set(paths.spec, specFor(record, commit))
documents.set(paths.plan, planFor(record, commit))
rows.push(`| ${commit.short} | ${commit.subject.replaceAll('|', '\\|')} | ${record.status} | [SPEC](../${paths.spec}) | [PLAN](../${paths.plan}) |`)

// Add slug to the JSON object and use paths.spec/paths.plan:
slug: paths.slug,
spec: paths.spec,
plan: paths.plan,
```

5. Replace `docs/specs/self-SPEC.md` and `docs/plans/self-PLAN.md` with `SELF_DOCUMENT_PATHS.spec` and `.plan` everywhere, including JSON. Add `slug: loaded.self.slug` to the self JSON object. Keep `self` row and mode semantics unchanged.
6. Change the checker success text in `scripts/check-commit-docs.ts` from `reference, evidence, and duplication checks` to `reference, naming, and duplication checks`.

- [ ] **Step 6: Run focused tests**

Run: `bun test tests/commitDocs.test.ts`

Expected: PASS. Full-repository generation is still expected to fail because records have not yet received slugs.

---

### Task 3: Finalize Missing HEAD Records and Define Current Self

**Files:**
- Create: `scripts/commit-docs/records/c69c271.ts`
- Create: `scripts/commit-docs/records/4909c0f.ts`
- Replace: `scripts/commit-docs/records/self.ts`

**Interfaces:**
- Consumes: `CommitRecord` from Task 2.
- Produces: complete 95-commit + self inventory required by `--next`.

- [ ] **Step 1: Finalize the c69c271 record with exact diff groups**

Copy the old self record, bind it to the full SHA, and remove its `changeId`:

```bash
cp scripts/commit-docs/records/self.ts scripts/commit-docs/records/c69c271.ts
bun -e "const p='scripts/commit-docs/records/c69c271.ts'; let s=await Bun.file(p).text(); s=s.replace(\"commit: 'self',\", \"commit: 'c69c271db2278642918bce5caf9641108e4f6cab',\").replace(\"  changeId: 'substantive-commit-docs',\\n\", ''); await Bun.write(p,s)"
```

Add this root-level `changeGroups` property after `references` in `c69c271.ts`; the counts come from `git diff-tree --no-commit-id --name-only -r c69c271` and cover the generated bulk while explicit references cover the remaining 15 paths:

```ts
changeGroups: [
  { prefix: 'scripts/commit-docs/records/', count: 94, note: '逐提交结构化设计与实施记录。' },
  { prefix: 'docs/specs/', count: 95, note: '由记录渲染的历史方案设计文档。' },
  { prefix: 'docs/plans/', count: 95, note: '由记录渲染的历史步骤实施文档。' },
],
```

Add `slug: 'substantive-commit-design-docs'` after `title`.

- [ ] **Step 2: Create the design-review commit record**

Create `scripts/commit-docs/records/4909c0f.ts` with this complete record:

```ts
import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '4909c0fccbf24736f5c670ef936bae317e52dd4c',
  title: 'Design date-based commit documentation',
  slug: 'date-based-commit-docs-design',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: 'c69c271 已提供逐提交的实质设计记录，但交付文档仍以七位 SHA 命名，并保存历史执行证据。',
  problem: '需要在不改动产品实现的前提下，确定日期加功能的命名规则、同日冲突处理和只保留验收标准的迁移契约。',
  goals: ['形成可评审的命名、渲染、校验、迁移与验收设计。'],
  nonGoals: ['本提交只保存方案设计，不实施记录或生成物迁移。'],
  architecture: ['设计文档把完整 SHA 保留为记录身份，把日期与显式 slug 作为输出名称，并定义 head/next 动态清单和旧文件迁移顺序。'],
  decisions: ['采用显式 slug 而不是从标题猜测功能名；同日同功能使用稳定序号；历史执行结果不进入新文档。'],
  alternatives: ['保留 SHA 路径会更简单但不满足可读命名要求；纯自动生成正文会重新引入无依据设计结论。'],
  security: ['变更仅为设计文档，不增加凭据、协议或运行时权限。'],
  acceptance: ['设计明确命名格式、冲突算法、数据契约、迁移顺序、错误处理和测试验收。'],
  remaining: ['后续实施提交按本设计完成全部记录和生成物迁移。'],
  references: [{ path: 'docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md', role: 'changed', note: '经评审的完整方案设计。' }],
  plan: {
    preconditions: ['确认 c69c271 的结构化文档现状和用户命名要求。'],
    reuse: ['复用现有 head/next、结构化记录和只读检查设计。'],
    steps: [{ title: '编写并评审迁移设计', detail: '记录命名、内容、迁移、错误和验收契约并修正动态 HEAD 边界。', paths: ['docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md'] }],
    compatibility: ['完整 SHA 继续作为记录和索引身份。'],
    risks: ['设计提交会扩大 next 清单；实施时必须动态覆盖当前 HEAD。'],
    acceptanceSequence: ['核对设计覆盖 SPEC 各节，并确认没有把静态基线数量写成固定校验。'],
    completed: ['方案设计文档已落盘。'],
    incomplete: ['代码、记录和生成物迁移属于后续实施范围。'],
  },
})
```

- [ ] **Step 3: Replace self with the migration record**

Create `scripts/commit-docs/records/self.ts` with the following content. Its initial `unimplemented` state is intentional and will be updated only after implementation is complete; no test result is added later.

```ts
import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'self',
  changeId: 'date-based-commit-docs',
  title: 'Use date and feature names for commit documentation',
  slug: 'date-based-commit-docs-migration',
  kind: 'metadata-migration',
  status: 'unimplemented',
  beforeState: '历史 SPEC/PLAN 以七位 SHA 命名，结构化记录还包含执行证据字段，渲染器输出验证证据和验证顺序。',
  problem: '需要原子迁移全部记录、输出路径和索引，同时保留设计事实、文件级步骤及验收标准。',
  goals: ['实现日期加功能命名，清理历史执行结果，并迁移所有生成物和链接。'],
  nonGoals: ['不修改产品源码，不重写 Git 历史，不重新执行历史验证。'],
  architecture: ['纯命名模块根据 commit date、显式 slug 和 topo 顺序生成路径；记录经校验后由渲染器统一输出 SPEC、PLAN 和索引。'],
  decisions: ['完整 SHA 仍是身份；同日同功能使用序号；writer 与 checker 分离；旧路径在新清单完整后显式删除。'],
  alternatives: ['继续用 SHA 文件名不满足可读性；从标题自动推断 slug 或设计正文不可验证。'],
  security: ['Git 操作只读历史；旧文件删除仅针对已跟踪的七位 SHA 生成物，不处理凭据或产品协议。'],
  acceptance: ['全部当前 commit 与 self 均有新命名文档，索引一致、无旧路径、无执行证据、重复生成无差异。'],
  remaining: ['命名、记录、渲染、迁移和验收尚未完成。'],
  references: [
    { path: 'scripts/commit-docs/naming.ts', role: 'changed', note: '纯命名与冲突检测。' },
    { path: 'scripts/commit-docs/schema.ts', role: 'changed', note: 'slug 与验收序列契约。' },
    { path: 'scripts/commit-docs/validate.ts', role: 'changed', note: '命名、遗留字段与执行结果检查。' },
    { path: 'scripts/commit-docs/render.ts', role: 'changed', note: '新路径与验收渲染。' },
    { path: 'tests/commitDocs.test.ts', role: 'test', note: '命名和契约回归。' },
  ],
  plan: {
    preconditions: ['已批准设计存在，当前 HEAD 和全部历史可读。'],
    reuse: ['复用现有 Git、加载、校验、渲染和 head/next 入口。'],
    steps: [
      { title: '实现命名与数据契约', detail: '先测试命名，再调整 schema、validate 和 render。', paths: ['scripts/commit-docs/naming.ts', 'scripts/commit-docs/schema.ts', 'scripts/commit-docs/validate.ts', 'scripts/commit-docs/render.ts'] },
      { title: '迁移全部结构化记录', detail: '补齐当前 HEAD 记录，添加显式 slug，删除证据字段并清理历史执行陈述。', paths: ['scripts/commit-docs/records'] },
      { title: '迁移生成物和链接', detail: '生成日期加功能文档，更新索引和政策，再删除七位 SHA 旧文件。', paths: ['docs/specs', 'docs/plans', 'docs/INDEX.md', 'docs/status/index.json'] },
    ],
    compatibility: ['记录身份、head/next 模式和 self 文件位置保持兼容。'],
    risks: ['同日冲突、动态 HEAD 遗漏和误删新文件必须通过路径清单与精确七位 SHA 匹配控制。'],
    acceptanceSequence: ['先运行命名与契约测试，再检查 next 全量清单、重复生成、全量测试、typecheck、build 和提交后的 head 模式。'],
    completed: [],
    incomplete: ['全部实现与迁移尚未完成。'],
  },
})
```

- [ ] **Step 4: Check record inventory before the bulk codemod**

Run: `find scripts/commit-docs/records -name '*.ts' | wc -l`

Expected: `96` = 95 historical commits + `self`.

---

### Task 4: Mechanical Record Migration with an Exact Slug Map

**Files:**
- Create temporarily: `/tmp/migrate-commit-doc-records.ts`
- Modify: every `scripts/commit-docs/records/*.ts`

**Interfaces:**
- Consumes: complete record inventory from Task 3.
- Produces: explicit slugs, no root evidence blocks, `acceptanceSequence`, and `reused` references pinned to `revision: 'commit'` where the old role was `evidence`.

- [ ] **Step 1: Write the one-time codemod with complete slug assignments**

Create `/tmp/migrate-commit-doc-records.ts` containing the following script. It uses TypeScript only to locate properties; edits preserve original formatting and are applied from the end of each file.

```ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import ts from '/Users/fengcaiwen/GolandProjects/claude-code/node_modules/typescript/lib/typescript.js'

const directory = '/Users/fengcaiwen/GolandProjects/claude-code/scripts/commit-docs/records'
const SLUGS: Record<string, string> = {
  '4b9d30f.ts': 'root-source-snapshot',
  '9b2a352.ts': 'restore-cli-sdk-build',
  '6b7bf48.ts': 'secure-storage-marketplace-sdk',
  'e5c06bc.ts': 'feature-completion-status',
  '02bc3c2.ts': 'remote-control-cloud-persistence',
  '2ff078c.ts': 'remote-cloud-verification-status',
  '614bf48.ts': 'external-features-sdk-dag',
  '301a3e7.ts': 'monitoring-internal-tools',
  'edcaa95.ts': 'proactive-coordinator-workers',
  'e2e0ff6.ts': 'ci-independent-feature-profile',
  'e92caa6.ts': 'local-skill-discovery',
  '809351a.ts': 'uds-inbox-peer-discovery',
  'd2fafcd.ts': 'daemon-remote-control-lifecycle',
  'ea80851.ts': 'declarative-workflow-execution',
  '31697a0.ts': 'context-collapse-recovery',
  'da942ac.ts': 'reactive-compaction-recovery',
  'dab8405.ts': 'implementation-boundaries-status',
  '982ab10.ts': 'buddy-fork-subagent',
  '2bf435a.ts': 'history-snipping',
  '0b68068.ts': 'review-artifact-hunter',
  'ab30aec.ts': 'skillhub-remote-skills',
  'd5a675a.ts': 'open-kairos-functionality',
  'd925b12.ts': 'computer-use-browser-mcp',
  'a8c8b90.ts': 'lifecycle-regressions-race-fixes',
  'adaa8ff.ts': 'env-less-perpetual-continuity',
  'c43f42e.ts': 'ci-lifecycle-test-isolation',
  '3948f91.ts': 'deterministic-cron-takeover',
  'e31ff8f.ts': 'cron-scheduler-reset',
  '271cf75.ts': 'final-ci-status',
  '9cd4c63.ts': 'live-validation-workflows',
  '6ef3352.ts': 'live-jobs-environment-gating',
  '85028f7.ts': 'isolate-live-workflow-jobs',
  '17f52b5.ts': 'unconditional-live-workflow-jobs',
  '4dd93b7.ts': 'reregister-live-validation-workflow',
  'b183b9a.ts': 'live-job-environment-gates',
  '4c04383.ts': 'env-context-live-gating',
  'b160aef.ts': 'explicit-live-gating-expressions',
  '97b13fd.ts': 'script-based-live-gating',
  'e900423.ts': 'skip-desktop-without-runner',
  '4dbadb8.ts': 'live-workflow-status',
  'beee034.ts': 'settings-bearer-authentication',
  '587c466.ts': 'commit-specs-and-plans',
  '8117aaa.ts': 'commit-docs-finalization',
  'c4e19ce.ts': 'commit-docs-finalization',
  '17c9196.ts': 'commit-docs-finalization',
  'f210ce9.ts': 'commit-docs-finalization',
  '7740a1d.ts': 'commit-docs-finalization',
  'fe3c177.ts': 'commit-docs-finalization',
  '63e138f.ts': 'commit-docs-finalization',
  '80e6def.ts': 'commit-docs-finalization',
  '7ca78c1.ts': 'commit-docs-finalization',
  'f251df9.ts': 'commit-docs-finalization',
  '2fe47f6.ts': 'commit-docs-finalization',
  'f355de1.ts': 'commit-docs-finalization',
  '55f7c7e.ts': 'commit-docs-finalization',
  'd802331.ts': 'commit-docs-finalization',
  '335b217.ts': 'commit-docs-finalization',
  '0640471.ts': 'commit-docs-finalization',
  '501672c.ts': 'commit-docs-finalization',
  '2f55f19.ts': 'commit-docs-finalization',
  'd472e5c.ts': 'commit-docs-finalization',
  '3fbabc2.ts': 'commit-docs-finalization',
  '1bc02bf.ts': 'commit-docs-finalization',
  '1329f79.ts': 'commit-docs-finalization',
  'be5c03e.ts': 'commit-docs-finalization',
  '2a4aa6c.ts': 'commit-docs-finalization',
  '0dabf46.ts': 'commit-docs-finalization',
  '612cc40.ts': 'commit-docs-finalization',
  '6c3c1e4.ts': 'commit-docs-finalization',
  '96283ae.ts': 'commit-docs-finalization',
  'b6bf982.ts': 'commit-docs-finalization',
  '787b2dc.ts': 'commit-docs-finalization',
  '6b0ce9d.ts': 'commit-docs-finalization',
  '5c5bc03.ts': 'commit-docs-finalization',
  'c771f05.ts': 'commit-docs-finalization',
  'dc3f075.ts': 'commit-docs-finalization',
  '1fe1430.ts': 'commit-docs-finalization',
  'a4edc60.ts': 'commit-docs-finalization',
  'e0cbbe1.ts': 'commit-docs-finalization',
  '8a248e3.ts': 'commit-docs-finalization',
  '4329cd8.ts': 'commit-docs-finalization',
  'f5b097b.ts': 'commit-docs-finalization',
  'e8d8c06.ts': 'commit-docs-finalization',
  'fdffe9e.ts': 'commit-docs-finalization',
  '3c4b6f2.ts': 'commit-docs-finalization',
  'c8338e1.ts': 'commit-docs-finalization',
  '69d3596.ts': 'commit-docs-finalization',
  '846c130.ts': 'commit-docs-finalization',
  '0e2559a.ts': 'commit-docs-finalization',
  'fe2ced6.ts': 'commit-docs-finalization',
  '5c56455.ts': 'commit-docs-finalization',
  '9525612.ts': 'generate-docs-before-ci',
  'ab2d941.ts': 'commit-docs-ci-status',
  'c69c271.ts': 'substantive-commit-design-docs',
  '4909c0f.ts': 'date-based-commit-docs-design',
  'self.ts': 'date-based-commit-docs-migration',
}

type Edit = { start: number; end: number; text: string }
const files = readdirSync(directory).filter(file => file.endsWith('.ts')).sort()
const missingAssignments = files.filter(file => !SLUGS[file])
const extraAssignments = Object.keys(SLUGS).filter(file => !files.includes(file))
if (missingAssignments.length || extraAssignments.length) {
  throw new Error(`slug map mismatch: missing=${missingAssignments} extra=${extraAssignments}`)
}

for (const file of files) {
  const path = `${directory}/${file}`
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let root: ts.ObjectLiteralExpression | undefined
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'defineCommitRecord') {
      const argument = node.arguments[0]
      if (argument && ts.isObjectLiteralExpression(argument)) root = argument
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!root) throw new Error(`${file}: defineCommitRecord object not found`)

  const properties = [...root.properties].filter(ts.isPropertyAssignment)
  const commit = properties.find(property => property.name.getText(source) === 'commit')
  if (!commit) throw new Error(`${file}: commit property not found`)
  const edits: Edit[] = []
  if (!properties.some(property => property.name.getText(source) === 'slug')) {
    const comma = text[commit.getEnd()] === ',' ? 1 : 0
    edits.push({ start: commit.getEnd() + comma, end: commit.getEnd() + comma, text: `\n  slug: '${SLUGS[file]}',` })
  }

  const evidence = properties.find(property => property.name.getText(source) === 'evidence')
  if (evidence) {
    let end = evidence.getEnd()
    if (text[end] === ',') end++
    if (text[end] === '\r') end++
    if (text[end] === '\n') end++
    edits.push({ start: evidence.getFullStart(), end, text: '' })
  }

  const renameAndConvert = (node: ts.Node) => {
    if (evidence && node.pos >= evidence.pos && node.end <= evidence.end) return
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source)
      if (name === 'verification') {
        edits.push({ start: node.name.getStart(source), end: node.name.getEnd(), text: 'acceptanceSequence' })
      }
      if (name === 'role' && ts.isStringLiteral(node.initializer) && node.initializer.text === 'evidence') {
        edits.push({ start: node.initializer.getStart(source), end: node.initializer.getEnd(), text: "'reused'" })
        if (ts.isObjectLiteralExpression(node.parent)) {
          const hasRevision = node.parent.properties.some(property =>
            ts.isPropertyAssignment(property) && property.name.getText(source) === 'revision',
          )
          if (!hasRevision) edits.push({ start: node.getEnd(), end: node.getEnd(), text: ", revision: 'commit'" })
        }
      }
    }
    ts.forEachChild(node, renameAndConvert)
  }
  renameAndConvert(root)

  const ordered = edits.sort((a, b) => b.start - a.start)
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index - 1]!.start < ordered[index]!.end) {
      throw new Error(`${file}: overlapping edits`)
    }
  }
  let updated = text
  for (const edit of ordered) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end)
  writeFileSync(path, updated)
}
console.log(`Migrated ${files.length} records`)
```

- [ ] **Step 2: Run the codemod once and remove the temporary script**

```bash
bun /tmp/migrate-commit-doc-records.ts
rm /tmp/migrate-commit-doc-records.ts
```

Expected: `Migrated 96 records`. The codemod is not committed and is not rerun against already migrated files.

- [ ] **Step 3: Verify mechanical invariants**

```bash
! rg -n '^  evidence:|^    verification:|recorded-command-pass|recorded-ci-pass|later-evidence|not-recorded|diff-observed|test-added' scripts/commit-docs/records
! rg -n "role: 'evidence'" scripts/commit-docs/records
bun run typecheck
```

Expected: both searches print nothing; typecheck exits zero. If a converted reference creates invalid coverage, fix only that reference using the actual commit diff: use `changed` for a changed path it explains, `test` for a test, or retain `reused` with `revision: 'commit'` for a same-revision dependency.

---

### Task 5: Remove Historical Execution Claims from Design Prose

**Files:**
- Modify: `scripts/commit-docs/records/4b9d30f.ts`, `9b2a352.ts`, `e5c06bc.ts`, `2ff078c.ts`, `dab8405.ts`, `271cf75.ts`, `4dbadb8.ts`, `ab2d941.ts`
- Modify: `scripts/commit-docs/records/9cd4c63.ts`, `6ef3352.ts`, `85028f7.ts`, `17f52b5.ts`, `4dd93b7.ts`, `b183b9a.ts`, `4c04383.ts`, `b160aef.ts`, `97b13fd.ts`, `e900423.ts`
- Modify: all metadata finalization records from `587c466.ts` through `5c56455.ts`
- Modify: any remaining record reported by the validator

**Interfaces:**
- Consumes: mechanically migrated records from Task 4.
- Produces: design prose that passes `HISTORICAL_EXECUTION_TEXT` and preserves code behavior and acceptance criteria.

- [ ] **Step 1: Produce the concrete cleanup inventory**

```bash
bun run docs:check -- --next
```

Expected before cleanup: FAIL with `historical execution result detected` and/or changed-file coverage errors. Capture each record/field from the error output; do not suppress the validator.

- [ ] **Step 2: Apply field-specific semantic cleanup**

For every reported field, use these exact transformations rather than deleting whole design sections:

- `beforeState`, `problem`, `architecture`, `decisions`: retain implementation behavior; replace claims about what ran with what the code or documentation change does.
- `nonGoals`, `security`: remove meta commentary about not claiming CI/test success; retain actual permission, protocol, credential, and scope boundaries.
- `remaining`, `plan.incomplete`: retain unimplemented code or environment requirements; delete statements whose only content is that logs, run IDs, or historical execution records are absent.
- `acceptance`, `plan.acceptanceSequence`: rewrite as conditions to check, never as outcomes.
- `plan.completed`: retain files and behavior implemented by the commit, not commands that ran.

Apply these representative replacements verbatim where they occur:

```diff
-本地实际执行 tests/commitDocs.test.ts，16 个测试、27 个断言全部通过。
+tests/commitDocs.test.ts 负责命名、遗留字段、引用和渲染契约的回归。

-新文档的 verification 段落没有配套命令输出或 CI 结果。
+新文档只列出验收条件，不保存历史命令或 CI 执行结果。

-model/cloud 的 secrets job-if 不受支持，需要改用有效门控或脚本 guard；不能依赖当前条件获得可预测的 CI 跳过。
+model/cloud 的 secrets job-if 不受支持；设计应使用有效门控或脚本 guard 才能获得可预测的跳过行为。
```

For status/evidence commits, describe the actual metadata transition. For example, replace “某次 live workflow 已成功” with “`docs/STATUS.md` 或 `docs/RELEASE.md` 中对应状态条目被修改；本记录只说明修改位置和文档影响”。Do not invent a replacement architecture for a metadata-only commit.

Review the groups in this order so earlier product decisions are available for later metadata records:

1. Root/restoration/status: `4b9d30f`, `9b2a352`, `e5c06bc`, `2ff078c`, `dab8405`, `271cf75`, `4dbadb8`, `ab2d941`.
2. Live workflow and CI: `9cd4c63`, `6ef3352`, `85028f7`, `17f52b5`, `4dd93b7`, `b183b9a`, `4c04383`, `b160aef`, `97b13fd`, `e900423`, `9525612`.
3. Product and test commits not matched by the search: compare their `acceptance` and `acceptanceSequence` against the same outcome-vs-criterion rule.
4. Documentation records: `587c466`, `8117aaa`, `c4e19ce`, `17c9196`, `f210ce9`, `7740a1d`, `fe3c177`, `63e138f`, `80e6def`, `7ca78c1`, `f251df9`, `2fe47f6`, `f355de1`, `55f7c7e`, `d802331`, `335b217`, `0640471`, `501672c`, `2f55f19`, `d472e5c`, `3fbabc2`, `1bc02bf`, `1329f79`, `be5c03e`, `2a4aa6c`, `0dabf46`, `612cc40`, `6c3c1e4`, `96283ae`, `b6bf982`, `787b2dc`, `6b0ce9d`, `5c5bc03`, `c771f05`, `dc3f075`, `1fe1430`, `a4edc60`, `e0cbbe1`, `8a248e3`, `4329cd8`, `f5b097b`, `e8d8c06`, `fdffe9e`, `3c4b6f2`, `c8338e1`, `69d3596`, `846c130`, `0e2559a`, `fe2ced6`, `5c56455`.
5. Current records: `c69c271`, `4909c0f`, `self`.

- [ ] **Step 3: Run structural validation again**

```bash
bun run docs:check -- --next
```

Expected at completion: records and references pass validation; the command may still report `missing` new date-based documents and `orphaned generated document` old SHA documents. It must not report `historical execution result`, missing records, slug errors, changed-file coverage errors, or reference errors.

---

### Task 6: Update Authoring Policy and Templates

**Files:**
- Modify: `docs/COMMIT_DOCS.md`
- Modify: `docs/specs/template.md`
- Modify: `docs/plans/template.md`

**Interfaces:**
- Consumes: final record/render contract.
- Produces: documentation that instructs future commits to use the same naming and acceptance-only model.

- [ ] **Step 1: Replace path and evidence instructions in COMMIT_DOCS.md**

Replace the record/output bullets with:

```markdown
- `scripts/commit-docs/records/<short-sha>.ts`：一个历史提交一份完整设计记录，full SHA 与文件名必须对应，并显式维护功能 `slug`。
- `scripts/commit-docs/records/self.ts`：当前工作的设计记录，含稳定 `changeId` 和后续固化所需的 `slug`。
- `docs/specs/YYYY-MM-DD-<feature-slug>-SPEC.md`：前置问题、目标/非目标、架构与数据流、设计决策、备选与取舍、安全协议、验收标准和剩余范围。
- `docs/plans/YYYY-MM-DD-<feature-slug>-PLAN.md`：前置条件、复用、按依赖排序的文件级步骤、兼容/迁移、风险、验收顺序和完成状态。
- `docs/status/index.json` 与 `docs/INDEX.md`：保存 full SHA、slug 和新路径的机器映射与人工导航。
```

Replace the evidence/status paragraph with:

```markdown
状态为 `implemented`、`partial`、`unimplemented`，只描述该提交的实现范围。SPEC/PLAN 不保存历史测试、命令、CI 或 live 执行结果，不记录 run ID，也不以“已通过”描述历史验证；测试文件和 revision 引用仅用于说明设计及验收关系。
```

Replace update-flow references to “证据来源” with “设计与验收关系”，and replace the CI quality list with:

```markdown
检查包括：记录/SHA 全量覆盖、slug 格式、日期与同日序号、路径冲突、必需章节、非空内容、旧模板和执行证据字段、历史执行结果表述、变更文件覆盖、路径与 symbol、重复正文、敏感信息、索引和孤儿文档。单元测试覆盖这些失败分支。
```

- [ ] **Step 2: Update the SPEC template**

In `docs/specs/template.md`:

- Immediately after the frontmatter, add this authoring note: `结构化记录必须另含 slug: <feature-slug>；slug 用于输出文件名，不重复写入生成后的 frontmatter。`
- Change `文件、接口与证据关系` to `文件、接口与复用关系`.
- Delete the complete `## 验证证据` section.
- Replace the opening note with: “正文依据对应 revision 的实现与测试独立编写；验收标准只写应满足的条件，不记录历史执行结果。”

- [ ] **Step 3: Update the PLAN template**

In `docs/plans/template.md`:

- Change `## 验证顺序` to `## 验收顺序`.
- Replace its placeholder with `<按依赖顺序列出应检查的验收条件，不写历史执行结果>`.
- Change the final instruction to `<逐项列出已实现和未实现范围，不附测试、CI 或 live 执行结论>`.

- [ ] **Step 4: Check policy consistency**

```bash
rg -n '验证证据|验证顺序|<short-sha>-SPEC|<short-sha>-PLAN|later evidence|证据来源' docs/COMMIT_DOCS.md docs/specs/template.md docs/plans/template.md
```

Expected: no output. Template angle-bracket placeholders are intentional and are not generated records.

---

### Task 7: Generate New Documents and Remove Old Paths

**Files:**
- Regenerate: `docs/specs/*.md`, `docs/plans/*.md`, `docs/INDEX.md`, `docs/status/index.json`
- Delete: tracked files matching exactly seven lowercase hex characters plus `-SPEC.md` or `-PLAN.md`

**Interfaces:**
- Consumes: validated records and new renderer.
- Produces: complete date+feature documentation tree with no duplicate old outputs.

- [ ] **Step 1: Generate the next-mode inventory**

```bash
bun run docs:generate -- --next
```

Expected: `Generated 192 commit design/implementation documents and indexes (next mode).` The count is 95 historical pairs plus one self pair; recalculate dynamically if HEAD changed before execution.

- [ ] **Step 2: Inspect naming, collisions, and representative content before deletion**

```bash
find docs/specs -maxdepth 1 -name '2026-11-11-commit-docs-finalization*-SPEC.md' | sort
rg -n '验证证据|验证顺序|本地实际执行|run ID' docs/specs docs/plans
rg -n '## 验收标准|## 验收顺序|commit:' docs/specs/2026-11-11-live-validation-workflows-SPEC.md docs/plans/2026-11-11-live-validation-workflows-PLAN.md
```

Expected: finalization files use no suffix for the first and `-02`, `-03`, etc. thereafter; execution-result search prints nothing; representative files retain their full SHA and acceptance sections.

- [ ] **Step 3: Check repository links before removing old files**

```bash
rg -n '\]\((?:\.\./)?docs/(specs|plans)/[0-9a-f]{7}-(SPEC|PLAN)\.md' --glob '*.md' .
```

Expected: no output. Do not rewrite old SHA paths inside historical TypeScript records; those paths identify files at historical revisions and are validated by `fileAtRevision`.

- [ ] **Step 4: Delete only the old generated paths**

```bash
git ls-files 'docs/specs/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-SPEC.md' 'docs/plans/[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-PLAN.md' | xargs git rm --
```

Expected: Git reports removal of the old seven-hex SPEC/PLAN files only. The pathspec cannot match `YYYY-MM-DD-slug` files or `self` files.

- [ ] **Step 5: Run the read-only next check and idempotence check**

```bash
bun run docs:check -- --next
git add -A docs/specs docs/plans docs/INDEX.md docs/status/index.json
bun run docs:generate -- --next
git diff --exit-code -- docs/specs docs/plans docs/INDEX.md docs/status/index.json
git status --short
```

Expected: `All 192 substantive commit documents and indexes pass structural, reference, naming, and duplication checks (next mode).` Staging before the second generation creates a snapshot that includes new files and deletions, so the final diff must be empty across every generated path. `git status` should show staged migrations but no unstaged changes.

---

### Task 8: Full Verification and Atomic Commit

**Files:**
- Modify: `scripts/commit-docs/records/self.ts`
- Stage: all plan/record/renderer/policy/generated changes from Tasks 1–7

**Interfaces:**
- Consumes: complete next-mode documentation tree.
- Produces: one commit whose post-commit head-mode check is unchanged and green.

- [ ] **Step 1: Mark self implemented without adding execution evidence**

In `scripts/commit-docs/records/self.ts` apply exactly these semantic updates:

```ts
status: 'implemented',
remaining: [],
plan: {
  // Keep preconditions, reuse, steps, compatibility, risks, and acceptanceSequence unchanged.
  completed: [
    '日期加功能命名、冲突检测和结构化记录契约已经落地。',
    '全部历史记录、生成文档、索引、政策和模板已经迁移。',
    '旧七位 SHA 生成物已经移除，self 继续承接当前提交。',
  ],
  incomplete: [],
},
```

Do not add test counts, CI claims, command output, or “验证通过” to the record.

- [ ] **Step 2: Regenerate self and rerun all focused checks**

```bash
bun run docs:generate -- --next
bun run docs:check -- --next
bun test tests/commitDocs.test.ts
```

Expected: generation remains at the dynamic historical+self count; checker and tests pass.

- [ ] **Step 3: Run the complete engineering verification**

```bash
bun run typecheck
bun test
bun run build
git diff --check
```

Expected: all commands exit zero. Record any failure in the session, fix the implementation, and rerun the affected step plus this full sequence; do not write execution outcomes into historical SPEC/PLAN.

- [ ] **Step 4: Audit the final inventory and staged diff**

```bash
bun -e "import { commits } from './scripts/commit-docs/git.ts'; const history=commits(); const specs=[...new Bun.Glob('docs/specs/*.md').scanSync()].filter(p=>!p.endsWith('/template.md')); const plans=[...new Bun.Glob('docs/plans/*.md').scanSync()].filter(p=>!p.endsWith('/template.md')); console.log({commits:history.length,specs:specs.length,plans:plans.length,expectedEach:history.length+1}); if(specs.length!==history.length+1||plans.length!==history.length+1) process.exit(1)"
! git ls-files | rg '/[0-9a-f]{7}-(SPEC|PLAN)\.md$'
git status --short
```

Expected: `commits: 95`, `specs: 96`, `plans: 96`, `expectedEach: 96` at the stated planning HEAD; no remaining old paths in the second command. Review `git status` to ensure no product source or credentials are included.

- [ ] **Step 5: Stage and commit the atomic migration**

```bash
git add docs/superpowers/plans/2026-11-11-date-based-commit-documentation.md docs/COMMIT_DOCS.md docs/INDEX.md docs/status/index.json docs/specs docs/plans scripts/commit-docs scripts/document-commits.ts scripts/check-commit-docs.ts tests/commitDocs.test.ts
git commit -m "Use date-based names for commit documentation"
```

- [ ] **Step 6: Verify head-mode continuity and idempotence after commit**

```bash
bun run docs:check
bun run docs:generate
git diff --exit-code
git status --short --branch
```

Expected: default head mode covers the same 95 ancestors plus `self`; checker passes, regeneration produces no diff, and status shows only the branch/ahead line. Do not push unless the user separately asks for a push.
