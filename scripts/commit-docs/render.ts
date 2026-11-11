import type {
  Commit,
  CommitRecord,
  CommitReference,
  CommitStatus,
  DocumentationMode,
} from './schema.ts'
import type { LoadedRecords } from './load.ts'
import { historicalDocumentPaths, SELF_DOCUMENT_PATHS } from './naming.ts'

const ROLE_LABELS = {
  changed: '变更',
  reused: '复用',
  test: '测试',
} as const

function bullets(items: string[]): string {
  return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : '- 无'
}

function tableCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function paragraphs(items: string[]): string {
  return items.join('\n\n')
}

function frontmatter(record: CommitRecord, commit?: Commit): string {
  const title = commit?.subject ?? record.title!
  return [
    '---',
    `commit: ${commit?.full ?? 'self'}`,
    ...(commit ? [] : [`changeId: ${record.changeId}`]),
    `title: ${JSON.stringify(title)}`,
    ...(commit ? [`date: ${commit.date}`] : []),
    `status: ${record.status}`,
    `kind: ${record.kind}`,
    '---',
  ].join('\n')
}

function referenceText(reference: CommitReference): string {
  const rename = reference.oldPath ? `（原路径 \`${reference.oldPath}\`）` : ''
  const symbol = reference.symbol ? `，符号 \`${reference.symbol}\`` : ''
  const revision = reference.revision ? `，revision \`${reference.revision}\`` : ''
  return `\`${reference.path}\`${rename}${symbol}${revision}`
}


export function expectedHistorical(commits: Commit[], mode: DocumentationMode): Commit[] {
  return mode === 'next' ? commits : commits.slice(0, -1)
}

export function specFor(record: CommitRecord, commit?: Commit): string {
  const title = commit?.subject ?? record.title!
  const groups = record.changeGroups?.length
    ? `\n### 大型快照分组核对\n\n${bullets(record.changeGroups.map(group => `${group.note}：\`${group.prefix}\`，${group.count} 个文件。`))}\n`
    : ''
  return `${frontmatter(record, commit)}

# ${title}

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

${record.beforeState}

${record.problem}

## 目标与非目标

### 目标

${bullets(record.goals)}

### 非目标

${bullets(record.nonGoals)}

## 方案架构与数据流

${paragraphs(record.architecture)}

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
${record.references.map(reference => `| ${ROLE_LABELS[reference.role]} | ${tableCell(referenceText(reference))} | ${tableCell(reference.note)} |`).join('\n')}
${groups}
## 关键决策与工程取舍

${bullets(record.decisions)}

### 备选方案与回溯分析

${bullets(record.alternatives)}

## 安全与协议边界

${bullets(record.security)}

## 验收标准

${bullets(record.acceptance)}

## 实现状态与剩余范围

- 状态：**${record.status}**
${bullets(record.remaining)}
`
}

export function planFor(record: CommitRecord, commit?: Commit): string {
  const title = commit?.subject ?? record.title!
  return `${frontmatter(record, commit)}

# 实施计划：${title}

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

${record.problem}

${bullets(record.plan.preconditions)}

## 复用与兼容处理

### 复用现有实现

${bullets(record.plan.reuse)}

### 兼容、迁移与生命周期

${bullets(record.plan.compatibility)}

## 文件级实施步骤

${record.plan.steps.map((step, index) => `### ${index + 1}. ${step.title}

${step.detail}

涉及位置：${step.paths.map(path => `\`${path}\``).join('、')}`).join('\n\n')}

## 风险与处理

${bullets(record.plan.risks)}

## 验收顺序

${record.plan.acceptanceSequence.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## 完成状态与剩余工作

- 状态：**${record.status}**

### 已完成

${bullets(record.plan.completed)}

### 未完成或后续工作

${bullets(record.plan.incomplete)}
`
}

export function buildDocuments(
  loaded: LoadedRecords,
  history: Commit[],
  mode: DocumentationMode,
): Map<string, string> {
  const documents = new Map<string, string>()
  const selected = expectedHistorical(history, mode)
  const documentPaths = historicalDocumentPaths(
    selected,
    full => loaded.historical.get(full),
  )
  const counts: Record<CommitStatus, number> = {
    implemented: 0,
    partial: 0,
    unimplemented: 0,
  }
  const rows: string[] = []
  const jsonCommits: unknown[] = []

  for (const commit of selected) {
    const record = loaded.historical.get(commit.full)!
    const paths = documentPaths.get(commit.full)!
    counts[record.status]++
    documents.set(paths.spec, specFor(record, commit))
    documents.set(paths.plan, planFor(record, commit))
    rows.push(`| ${commit.short} | ${commit.subject.replaceAll('|', '\\|')} | ${record.status} | [SPEC](../${paths.spec}) | [PLAN](../${paths.plan}) |`)
    jsonCommits.push({
      fullSha: commit.full,
      shortSha: commit.short,
      date: commit.date,
      subject: commit.subject,
      status: record.status,
      kind: record.kind,
      slug: paths.slug,
      spec: paths.spec,
      plan: paths.plan,
    })
  }

  documents.set(SELF_DOCUMENT_PATHS.spec, specFor(loaded.self))
  documents.set(SELF_DOCUMENT_PATHS.plan, planFor(loaded.self))
  rows.push(`| self (${loaded.self.changeId}) | ${loaded.self.title!.replaceAll('|', '\\|')} | ${loaded.self.status} | [SPEC](../${SELF_DOCUMENT_PATHS.spec}) | [PLAN](../${SELF_DOCUMENT_PATHS.plan}) |`)
  jsonCommits.push({
    fullSha: 'self',
    changeId: loaded.self.changeId,
    subject: loaded.self.title,
    status: loaded.self.status,
    kind: loaded.self.kind,
    slug: loaded.self.slug,
    spec: SELF_DOCUMENT_PATHS.spec,
    plan: SELF_DOCUMENT_PATHS.plan,
  })
  documents.set(
    'docs/INDEX.md',
    `# Commit documentation index\n\n每份 SPEC 是回溯性方案设计，每份 PLAN 是文件级实施顺序。自动检查不替代逐提交的语义审查。\n\n- Implemented: ${counts.implemented}\n- Partial: ${counts.partial}\n- Unimplemented: ${counts.unimplemented}\n\n| Commit | Subject | Status | SPEC | PLAN |\n|---|---|---|---|---|\n${rows.join('\n')}\n`,
  )
  documents.set(
    'docs/status/index.json',
    `${JSON.stringify({ commits: jsonCommits }, null, 2)}\n`,
  )
  return documents
}
