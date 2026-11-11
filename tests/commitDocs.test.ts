import { describe, expect, test } from 'bun:test'
import { documentationMode } from '../scripts/document-commits.ts'
import type { Commit, CommitRecord } from '../scripts/commit-docs/schema.ts'
import { expectedHistorical } from '../scripts/commit-docs/render.ts'
import {
  validateDuplication,
  validateRecordAgainstCommit,
  validateRecordShape,
  validateRecords,
} from '../scripts/commit-docs/validate.ts'

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
    evidence: [{ kind: 'diff-observed', statement: '测试直接调用形状与重复度校验函数覆盖失败分支。' }],
    remaining: ['语义是否准确仍需审查者对照提交 diff 判断。'],
    references: [{ path: 'scripts/example.ts', role: 'changed', note: '承载示例中的明确实现变更。' }],
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
      verification: ['运行负向单元测试并确认错误信息指向具体记录。'],
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

  test('requires a traceable source for execution and CI claims', () => {
    const record = validRecord()
    record.evidence = [{ kind: 'recorded-ci-pass', statement: '声称某次 CI 已通过，但故意不提供任何来源。' }]
    expect(validateRecordShape(record).join('\n')).toContain('requires a source for recorded-ci-pass')
  })

  test('checks evidence files at their declared revision', () => {
    const record = validRecord('4dd93b75220926cefbe9d5d017224238bfd8e0f1')
    record.evidence = [{
      kind: 'recorded-command-pass',
      statement: '该条证据引用一个不存在的记录文件，因此不能被接受。',
      source: {
        path: 'docs/NOT_A_REAL_VERIFICATION.md',
        role: 'evidence',
        note: '用于验证不存在的证据路径会失败。',
        revision: '4dd93b75220926cefbe9d5d017224238bfd8e0f1',
      },
    }]
    const commit: Commit = {
      full: record.commit,
      short: '4dd93b7',
      date: '2026-01-01T00:00:00Z',
      subject: 'Rename workflow',
    }
    expect(validateRecordAgainstCommit(record, commit).join('\n')).toContain('evidence reference missing at 4dd93b75220926cefbe9d5d017224238bfd8e0f1')
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

  test('requires later evidence to use a full-SHA descendant', () => {
    const documented = '02bc3c2efcd3f3d7978da33b2683e9d392f3220c'
    const commit: Commit = {
      full: documented,
      short: '02bc3c2',
      date: '2026-01-01T00:00:00Z',
      subject: 'Bridge and Cloud',
    }
    const validateLater = (revision: string) => {
      const record = validRecord(documented)
      record.evidence = [{
        kind: 'later-evidence',
        statement: '该证据用于检查后续 revision 的时间方向与不可变性。',
        source: {
          path: 'docs/RELEASE.md',
          role: 'evidence',
          note: '后续发布记录来源。',
          revision,
        },
      }]
      return validateRecordAgainstCommit(record, commit).join('\n')
    }
    expect(validateLater('parent')).toContain('later revision must be an immutable full SHA')
    expect(validateLater('HEAD')).toContain('reference revision must be commit, parent, or an immutable full SHA')
    expect(validateLater(documented)).toContain('is not later evidence')
    expect(validateLater('9b2a35201244ca84adeaa6844bf799e5a18aff6d')).toContain('is not a descendant')
    expect(validateLater('ea8085139c013577cad3130c35a21fc53a3d8bee')).not.toContain('evidence[0]')
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
})
