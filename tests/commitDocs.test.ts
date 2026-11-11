import { describe, expect, test } from 'bun:test'
import { documentationMode } from '../scripts/document-commits.ts'
import type { Commit, CommitRecord } from '../scripts/commit-docs/schema.ts'
import { expectedHistorical, specFor, planFor } from '../scripts/commit-docs/render.ts'
import {
  validateDuplication,
  validateRecordAgainstCommit,
  validateRecordShape,
  validateRecords,
} from '../scripts/commit-docs/validate.ts'
import {
  historicalDocumentPaths,
  SELF_DOCUMENT_PATHS,
} from '../scripts/commit-docs/naming.ts'

function validRecord(commit = 'a'.repeat(40)): CommitRecord {
  return {
    commit,
    kind: 'component',
    status: 'implemented',
    beforeState: '父提交中的校验器只比较文件是否存在，无法理解设计记录的技术含义。',
    problem: '需要让缺失设计记录和占位正文成为明确的校验失败，而不是自动生成一份空泛替代物。',
    goals: ['把每个历史提交绑定到独立且完整的设计记录。'],
    nonGoals: ['本次校验不重新执行历史提交对应的外部服务验证。'],
    architecture: ['加载器读取明确记录，校验器拒绝缺项，渲染器只负责把已经审核的内容转换成文档。'],
    decisions: ['把技术正文保存在结构化记录中，使路径和证据可以单独核对。'],
    alternatives: ['继续从标题推断正文会产生不可验证的设计理由，因此不采用。'],
    security: ['文档只引用公开代码和已有验证记录，不读取或写入认证材料。'],
    acceptance: ['缺失记录、空章节和模板正文都必须导致非零检查结论。'],
    remaining: ['语义是否准确仍需审查者对照提交 diff 判断。'],
    references: [{ path: 'scripts/example.ts', role: 'changed', note: '承载示例中的明确实现变更。' }],
    slug: 'example-design',
    plan: {
      preconditions: ['已经确定目标提交及其父提交。'],
      reuse: ['复用现有 Git 元数据而不是手工复制提交标题。'],
      steps: [{
        title: '建立记录并连接校验',
        detail: '先写入该提交独有的设计依据，再把文件引用交给校验器核对。',
        paths: ['scripts/example.ts'],
      }],
      compatibility: ['保持原有输出目录和文档链接不变。'],
      risks: ['自动检查不能证明技术理由正确，因此仍需人工阅读 diff。'],
      acceptanceSequence: ['运行负向单元测试并确认错误信息指向具体记录。'],
      completed: ['记录结构、失败分支和错误报告均有确定实现。'],
      incomplete: ['真实外部协议仍需要各自授权环境单独验收。'],
    },
  }
}

describe('commit design record validation', () => {
  test('accepts a complete record shape', () => {
    expect(validateRecordShape(validRecord())).toEqual([])
  })

  test('rejects empty required sections and generic not-applicable text', () => {
    const record = validRecord()
    record.goals = []
    record.architecture = ['N/A']
    expect(validateRecordShape(record).join('\n')).toContain('goals must not be empty')
    expect(validateRecordShape(record).join('\n')).toContain('architecture[0]')
  })

  test('rejects legacy fallback prose and placeholders', () => {
    const record = validRecord()
    record.problem = 'TODO：按提交范围修改实现并补充回归。'
    expect(validateRecordShape(record).join('\n')).toContain('placeholder or legacy fallback')
  })

  test('rejects credential-like content without echoing it', () => {
    const record = validRecord()
    record.problem = `示例敏感值 sk-ant-${'x'.repeat(20)} 不应进入文档。`
    const errors = validateRecordShape(record).join('\n')
    expect(errors).toContain('value suppressed')
    expect(errors).not.toContain('sk-ant-')
  })

  test('requires every historical SHA and reports missing records', () => {
    const commit: Commit = {
      full: 'b'.repeat(40),
      short: 'bbbbbbb',
      date: '2026-01-01T00:00:00Z',
      subject: 'Example',
    }
    const self = { ...validRecord('self'), changeId: 'test', title: 'Test change' }
    const errors = validateRecords({ historical: new Map(), self }, [commit], 'next')
    expect(errors.join('\n')).toContain('missing design record: bbbbbbb')
  })

  test('checks changed paths against the selected commit diff', () => {
    const record = validRecord('4dd93b75220926cefbe9d5d017224238bfd8e0f1')
    const commit: Commit = {
      full: record.commit,
      short: '4dd93b7',
      date: '2026-01-01T00:00:00Z',
      subject: 'Rename workflow',
    }
    const errors = validateRecordAgainstCommit(record, commit).join('\n')
    expect(errors).toContain('changed reference is absent from diff: scripts/example.ts')
    expect(errors).toContain('.github/workflows/live-checks.yml')
  })

  test('detects copied design paragraphs after normalizing SHAs and counts', () => {
    const first = validRecord('a'.repeat(40))
    const second = validRecord('b'.repeat(40))
    first.architecture = ['提交 abcdef1 将 12 个文件接入同一套未经定制的处理链路，这个句子用于确认复制内容无法仅靠替换提交编号和数量来逃避审查。']
    second.architecture = ['提交 1234567 将 99 个文件接入同一套未经定制的处理链路，这个句子用于确认复制内容无法仅靠替换提交编号和数量来逃避审查。']
    expect(validateDuplication([first, second]).join('\n')).toContain('duplicate substantive paragraph')
  })

  test('checks symbols on changed files as well as reused files', () => {
    const record = validRecord('4dd93b75220926cefbe9d5d017224238bfd8e0f1')
    record.references = [{
      path: '.github/workflows/live-checks.yml',
      oldPath: '.github/workflows/live-validation.yml',
      role: 'changed',
      symbol: 'name: definitely-not-the-workflow',
      note: '正确覆盖 rename 路径，但故意给出不存在的 workflow 名称。',
    }]
    record.plan.steps = [{
      title: '检查 workflow 内容',
      detail: '通过不存在的名称确认 changed reference 的 symbol 也会在该提交读取核对。',
      paths: ['.github/workflows/live-checks.yml'],
    }]
    const commit: Commit = {
      full: record.commit,
      short: '4dd93b7',
      date: '2026-01-01T00:00:00Z',
      subject: 'Rename workflow',
    }
    expect(validateRecordAgainstCommit(record, commit).join('\n')).toContain('symbol/heading not found at 4dd93b7')
  })


  test('rejects a crossed or fabricated rename relationship', () => {
    const record = validRecord('4dd93b75220926cefbe9d5d017224238bfd8e0f1')
    record.references = [{
      path: '.github/workflows/live-checks.yml',
      oldPath: 'README.md',
      role: 'changed',
      note: '新路径正确，但故意把它与不相关的旧路径配对。',
    }]
    record.plan.steps = [{
      title: '核对 rename 配对',
      detail: '检查器不能只确认两个路径各自出现，还要确认它们属于同一条 rename 记录。',
      paths: ['.github/workflows/live-checks.yml'],
    }]
    const commit: Commit = {
      full: record.commit,
      short: '4dd93b7',
      date: '2026-01-01T00:00:00Z',
      subject: 'Rename workflow',
    }
    expect(validateRecordAgainstCommit(record, commit).join('\n')).toContain('rename pair does not match diff')
  })

  test('allows empty remaining sections instead of forcing fabricated work', () => {
    const implemented = validRecord()
    implemented.remaining = []
    implemented.plan.incomplete = []
    expect(validateRecordShape(implemented)).toEqual([])
    const unimplemented = validRecord()
    unimplemented.status = 'unimplemented'
    unimplemented.plan.completed = []
    expect(validateRecordShape(unimplemented)).toEqual([])
  })

  test('allows substantive discussion of TODO and FIXME handling', () => {
    const record = validRecord()
    record.problem = '该变更解析源码中的 TODO 与 FIXME 注释，并把位置映射到审查结果，而不是留下未解决占位符。'
    expect(validateRecordShape(record)).toEqual([])
  })


  test('head covers ancestors plus self while next also covers the current tip', () => {
    const history: Commit[] = ['a', 'b', 'c'].map(letter => ({
      full: letter.repeat(40),
      short: letter.repeat(7),
      date: '2026-01-01T00:00:00Z',
      subject: letter,
    }))
    expect(expectedHistorical(history, 'head')).toHaveLength(2)
    expect(expectedHistorical(history, 'next')).toHaveLength(3)
  })

  test('supports explicit head and next inventory modes only', () => {
    expect(documentationMode([])).toBe('head')
    expect(documentationMode(['--next'])).toBe('next')
    expect(() => documentationMode(['--unknown'])).toThrow('usage:')
  })

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
})

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
