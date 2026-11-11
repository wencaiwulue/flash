import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { commits, REPOSITORY_ROOT } from './git.ts'
import type { Commit } from './git.ts'

export type DocumentationMode = 'head' | 'next'

export type ManualDocument = {
  commit: string
  date: string
  title: string
  status: string
  kind: string
  slug: string
  specPath: string
  planPath: string
}

const FORBIDDEN = [
  '复核目标、现有实现和复用模块',
  '按提交范围修改实现并补充回归',
  '## 验证证据',
  '## 验证顺序',
  '没有随提交记录运行',
  '本地实际执行',
]

function frontmatter(text: string, path: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match?.[1]) throw new Error(`${path}: missing frontmatter`)
  return match[1]
}

function field(source: string, name: string, path: string): string {
  const line = source.split('\n').find(line => line.startsWith(`${name}:`))
  if (!line) throw new Error(`${path}: missing ${name}`)
  return line.slice(name.length + 1).trim()
}

function optional(source: string, name: string, fallback: string): string {
  const line = source.split('\n').find(line => line.startsWith(`${name}:`))
  return line ? line.slice(name.length + 1).trim() : fallback
}

function title(source: string, path: string): string {
  const value = field(source, 'title', path)
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function validateProse(text: string, path: string): void {
  for (const phrase of FORBIDDEN) {
    if (text.includes(phrase)) throw new Error(`${path}: forbidden boilerplate: ${phrase}`)
  }
}

function expectedHistorical(history: Commit[], mode: DocumentationMode): Commit[] {
  return mode === 'next' ? history : history.slice(0, -1)
}

export function validateSequence(documents: ManualDocument[]): void {
  const occurrences = new Map<string, number>()
  for (const document of documents) {
    const date = document.date.slice(0, 10)
    const baseSlug = document.slug.replace(/-(?:0[2-9]|[1-9]\d+)$/, '')
    const key = `${date}/${baseSlug}`
    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    const expected = occurrence === 1 ? '' : `-${String(occurrence).padStart(2, '0')}`
    const actual = document.slug.slice(baseSlug.length)
    if (actual !== expected) {
      throw new Error(`${document.commit.slice(0, 7)}: expected suffix ${expected || '(none)'} for ${key}, got ${actual || '(none)'}`)
    }
  }
}

export async function readManualDocuments(mode: DocumentationMode, root = REPOSITORY_ROOT): Promise<{
  historical: Map<string, ManualDocument>
  self: { specPath: string; planPath: string }
}> {
  const history = commits()
  const selected = expectedHistorical(history, mode)
  const expected = new Set(selected.map(commit => commit.full))
  const byCommit = new Map(history.map(commit => [commit.full, commit]))
  const directory = join(root, 'docs/specs')
  const files = (await readdir(directory)).filter(file => file.endsWith('-SPEC.md') && file !== 'self-SPEC.md').sort()
  const documents: ManualDocument[] = []

  for (const file of files) {
    const specPath = `docs/specs/${file}`
    const text = await readFile(join(root, specPath), 'utf8')
    const source = frontmatter(text, specPath)
    const sha = field(source, 'commit', specPath)
    const commit = byCommit.get(sha)
    if (!commit) throw new Error(`${specPath}: commit is not in Git history: ${sha}`)
    if (!expected.has(sha)) continue
    const date = field(source, 'date', specPath)
    if (!date.startsWith(commit.date.slice(0, 10))) {
      throw new Error(`${specPath}: date ${date} does not match commit ${commit.date}`)
    }
    const slug = file.slice(0, -'-SPEC.md'.length).slice(11)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error(`${specPath}: invalid feature slug`)
    }
    const planPath = `docs/plans/${file.slice(0, -'-SPEC.md'.length)}-PLAN.md`
    const plan = await readFile(join(root, planPath), 'utf8').catch(() => {
      throw new Error(`${planPath}: missing PLAN for ${commit.short}`)
    })
    const planSource = frontmatter(plan, planPath)
    if (field(planSource, 'commit', planPath) !== sha) {
      throw new Error(`${planPath}: commit does not match SPEC`)
    }
    if (field(planSource, 'date', planPath) !== date) {
      throw new Error(`${planPath}: date does not match SPEC`)
    }
    validateProse(text, specPath)
    validateProse(plan, planPath)
    if (documents.some(document => document.commit === sha)) {
      throw new Error(`${specPath}: duplicate document for ${commit.short}`)
    }
    documents.push({
      commit: sha,
      date,
      title: title(source, specPath),
      status: optional(source, 'status', 'implemented'),
      kind: source.split('\n').find(line => line.startsWith('kind:'))?.slice(5).trim() ?? 'component',
      slug,
      specPath,
      planPath,
    })
  }

  const order = new Map(selected.map((commit, index) => [commit.full, index]))
  documents.sort((a, b) => order.get(a.commit)! - order.get(b.commit)!)
  validateSequence(documents)
  for (const commit of selected) {
    if (!documents.some(document => document.commit === commit.full)) {
      throw new Error(`missing design document: ${commit.short}`)
    }
  }
  for (const path of ['docs/specs/self-SPEC.md', 'docs/plans/self-PLAN.md']) {
    const text = await readFile(join(root, path), 'utf8')
    const source = frontmatter(text, path)
    if (field(source, 'commit', path) !== 'self') throw new Error(`${path}: invalid self commit`)
    field(source, 'changeId', path)
    validateProse(text, path)
  }
  return {
    historical: new Map(documents.map(document => [document.commit, document])),
    self: { specPath: 'docs/specs/self-SPEC.md', planPath: 'docs/plans/self-PLAN.md' },
  }
}

export async function buildManualIndexes(mode: DocumentationMode, root = REPOSITORY_ROOT): Promise<Map<string, string>> {
  const history = commits()
  const selected = expectedHistorical(history, mode)
  const { historical, self } = await readManualDocuments(mode, root)
  const rows: string[] = []
  const jsonCommits: unknown[] = []
  const counts: Record<string, number> = { implemented: 0, partial: 0, unimplemented: 0 }
  for (const commit of selected) {
    const document = historical.get(commit.full)!
    counts[document.status] = (counts[document.status] ?? 0) + 1
    rows.push(`| ${commit.short} | ${commit.subject.replaceAll('|', '\\|')} | ${document.status} | [SPEC](../${document.specPath}) | [PLAN](../${document.planPath}) |`)
    jsonCommits.push({
      fullSha: commit.full,
      shortSha: commit.short,
      date: commit.date,
      subject: commit.subject,
      status: document.status,
      kind: document.kind,
      slug: document.slug,
      spec: document.specPath,
      plan: document.planPath,
    })
  }
  const selfSpec = await readFile(join(root, self.specPath), 'utf8')
  const selfSource = frontmatter(selfSpec, self.specPath)
  const changeId = field(selfSource, 'changeId', self.specPath)
  const selfTitle = title(selfSource, self.specPath)
  const selfStatus = field(selfSource, 'status', self.specPath)
  rows.push(`| self (${changeId}) | ${selfTitle.replaceAll('|', '\\|')} | ${selfStatus} | [SPEC](../${self.specPath}) | [PLAN](../${self.planPath}) |`)
  jsonCommits.push({
    fullSha: 'self', changeId, subject: selfTitle, status: selfStatus,
    kind: 'metadata-migration', slug: 'self', spec: self.specPath, plan: self.planPath,
  })
  return new Map([
    ['docs/INDEX.md', `# Commit documentation index\n\n每份 SPEC/PLAN 均由对应 revision 独立审核；索引器不生成设计正文。\n\n- Implemented: ${counts.implemented}\n- Partial: ${counts.partial}\n- Unimplemented: ${counts.unimplemented}\n\n| Commit | Subject | Status | SPEC | PLAN |\n|---|---|---|---|---|\n${rows.join('\n')}\n`],
    ['docs/status/index.json', `${JSON.stringify({ commits: jsonCommits }, null, 2)}\n`],
  ])
}
