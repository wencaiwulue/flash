import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { documentationMode } from '../scripts/document-commits.ts'
import { commits } from '../scripts/commit-docs/git.ts'
import {
  buildManualIndexes,
  readManualDocuments,
  validateProse,
  validateSequence,
  type ManualDocument,
} from '../scripts/commit-docs/manual.ts'

const temporary = new Set<string>()
afterEach(async () => {
  for (const path of temporary) await rm(path, { recursive: true, force: true })
  temporary.clear()
})

function document(overrides: Partial<ManualDocument> = {}): ManualDocument {
  return {
    commit: 'a'.repeat(40),
    date: '2026-11-11',
    title: 'Example',
    status: 'implemented',
    kind: 'component',
    slug: 'feature-design',
    specPath: 'docs/specs/2026-11-11-feature-design-SPEC.md',
    planPath: 'docs/plans/2026-11-11-feature-design-PLAN.md',
    ...overrides,
  }
}

describe('manual commit documentation', () => {
  test('supports only explicit head and next modes', () => {
    expect(documentationMode([])).toBe('head')
    expect(documentationMode(['--next'])).toBe('next')
    expect(() => documentationMode(['--unknown'])).toThrow('usage:')
  })

  test('reads every historical pair plus self and builds complete indexes', async () => {
    const history = commits()
    const { historical, self } = await readManualDocuments('next')
    expect(historical.size).toBe(history.length)
    expect(self.specPath).toBe('docs/specs/self-SPEC.md')
    const indexes = await buildManualIndexes('next')
    const json = JSON.parse(indexes.get('docs/status/index.json')!)
    expect(json.commits).toHaveLength(history.length + 1)
    expect(json.commits.at(-1).changeId).toBe('manual-commit-design-rewrite')
    expect(indexes.get('docs/INDEX.md')).toContain('2026-11-11-live-validation-probes-SPEC.md')
  })

  test('head and next index generation is deterministic', async () => {
    const next = await buildManualIndexes('next')
    const again = await buildManualIndexes('next')
    expect(again).toEqual(next)
    const head = await buildManualIndexes('head')
    const history = commits()
    const json = JSON.parse(head.get('docs/status/index.json')!)
    expect(json.commits).toHaveLength(history.length)
  })

  test('validates same-day sequence in topological order', () => {
    const first = document()
    const second = document({ commit: 'b'.repeat(40), slug: 'feature-design-02' })
    const third = document({ commit: 'c'.repeat(40), slug: 'feature-design-03' })
    expect(() => validateSequence([first, second, third])).not.toThrow()
    expect(() => validateSequence([second, first, third])).toThrow('expected suffix')
  })

  test('rejects generic generated prose and execution-result sections', () => {
    expect(() => validateProse('## 验证证据', 'x.md')).toThrow('forbidden boilerplate')
    expect(() => validateProse('按提交范围修改实现并补充回归。', 'x.md')).toThrow('forbidden boilerplate')
    expect(() => validateProse('## 验收标准\n具体行为条件。', 'x.md')).not.toThrow()
  })

  test('rejects a missing PLAN before producing indexes', async () => {
    const root = await mkdtemp(join('/tmp', 'manual-docs-missing-plan-'))
    temporary.add(root)
    const commit = commits()[0]!
    await mkdir(join(root, 'docs/specs'), { recursive: true })
    await mkdir(join(root, 'docs/plans'), { recursive: true })
    const spec = `---\ncommit: ${commit.full}\ntitle: "Root"\ndate: ${commit.date.slice(0, 10)}\n---\n\n# Root\n`
    await writeFile(join(root, 'docs/specs/2026-03-31-root-source-snapshot-SPEC.md'), spec)
    await expect(readManualDocuments('next', root)).rejects.toThrow('missing PLAN')
  })

  test('rejects a document whose commit is outside Git history', async () => {
    const root = await mkdtemp(join('/tmp', 'manual-docs-unknown-sha-'))
    temporary.add(root)
    await mkdir(join(root, 'docs/specs'), { recursive: true })
    await mkdir(join(root, 'docs/plans'), { recursive: true })
    const spec = `---\ncommit: ${'a'.repeat(40)}\ntitle: "Unknown"\ndate: 2026-11-11\n---\n`
    await writeFile(join(root, 'docs/specs/2026-11-11-unknown-SPEC.md'), spec)
    await expect(readManualDocuments('next', root)).rejects.toThrow('not in Git history')
  })
})
