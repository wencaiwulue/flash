import { changedFiles, fileAtRevision, git } from './git.ts'
import type { ChangedFile } from './git.ts'
import type { LoadedRecords } from './load.ts'
import { expectedHistorical } from './render.ts'
import type {
  Commit,
  CommitRecord,
  CommitReference,
  DocumentationMode,
} from './schema.ts'
import { SLUG_PATTERN, historicalDocumentPaths } from './naming.ts'

const FORBIDDEN_TEXT = [
  /复核目标、现有实现和复用模块/,
  /按提交范围修改实现并补充回归/,
  /执行验证、记录状态与未实现边界/,
  /保持现有 CLI\/SDK 接口、feature gating 与权限边界/,
  /<(?:full-sha|commit-subject|commit-date|[^>]*placeholder[^>]*)>/i,
]

const SECRET_TEXT = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{12,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
]

function nonempty(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length > 1 && !/^(?:n\/?a|none|不适用|无)$/i.test(normalized)
}

const HISTORICAL_EXECUTION_TEXT = [
  /本地实际(?:执行|运行)/,
  /(?:测试|CI|构建|typecheck|build).{0,24}(?:全部|均|已)?通过(?:[。！？，；]|$)/,
  /\brun[ -]?ID\b/i,
  /recorded-(?:command|ci)-pass|later-evidence|not-recorded|diff-observed|test-added/,
]

function stringsInRecord(record: CommitRecord): string[] {
  return [
    record.beforeState,
    record.problem,
    ...record.goals,
    ...record.nonGoals,
    ...record.architecture,
    ...record.decisions,
    ...record.alternatives,
    ...record.security,
    ...record.acceptance,
    ...record.remaining,
    ...record.references.flatMap(reference => [reference.path, reference.note]),
    ...record.plan.preconditions,
    ...record.plan.reuse,
    ...record.plan.compatibility,
    ...record.plan.risks,
    ...record.plan.acceptanceSequence,
    ...record.plan.completed,
    ...record.plan.incomplete,
    ...record.plan.steps.flatMap(step => [step.title, step.detail, ...step.paths]),
  ]
}

export function validateRecordShape(record: CommitRecord): string[] {
  const errors: string[] = []
  const label = record.commit || '<missing SHA>'
  const requireString = (value: unknown, field: string) => {
    if (!nonempty(value)) errors.push(`${label}: ${field} must be substantive text`)
  }
  const requireArray = (values: string[], field: string) => {
    if (values.length === 0) errors.push(`${label}: ${field} must not be empty`)
    values.forEach((value, index) => requireString(value, `${field}[${index}]`))
  }

  requireString(record.commit, 'commit')
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
  requireString(record.beforeState, 'beforeState')
  requireString(record.problem, 'problem')
  requireArray(record.goals, 'goals')
  requireArray(record.nonGoals, 'nonGoals')
  requireArray(record.architecture, 'architecture')
  requireArray(record.decisions, 'decisions')
  requireArray(record.alternatives, 'alternatives')
  requireArray(record.security, 'security')
  requireArray(record.acceptance, 'acceptance')
  record.remaining.forEach((value, index) => requireString(value, `remaining[${index}]`))
  requireArray(record.plan.preconditions, 'plan.preconditions')
  requireArray(record.plan.reuse, 'plan.reuse')
  requireArray(record.plan.compatibility, 'plan.compatibility')
  requireArray(record.plan.risks, 'plan.risks')
  requireArray(record.plan.acceptanceSequence, 'plan.acceptanceSequence')
  record.plan.completed.forEach((value, index) => requireString(value, `plan.completed[${index}]`))
  record.plan.incomplete.forEach((value, index) => requireString(value, `plan.incomplete[${index}]`))
  if (!['implemented', 'partial', 'unimplemented'].includes(record.status)) {
    errors.push(`${label}: invalid status`)
  }
  if (!['component', 'metadata-migration', 'evidence-update'].includes(record.kind)) {
    errors.push(`${label}: invalid kind`)
  }
  if (record.references.length === 0) errors.push(`${label}: references must not be empty`)
  if (record.plan.steps.length === 0) errors.push(`${label}: plan.steps must not be empty`)
  record.references.forEach((reference, index) => {
    requireString(reference.path, `references[${index}].path`)
    requireString(reference.note, `references[${index}].note`)
  })
  record.plan.steps.forEach((step, index) => {
    requireString(step.title, `plan.steps[${index}].title`)
    requireString(step.detail, `plan.steps[${index}].detail`)
    requireArray(step.paths, `plan.steps[${index}].paths`)
  })
  stringsInRecord(record).forEach(value => {
    if (/^(?:TODO|TBD|FIXME)$/i.test(value.trim())) {
      errors.push(`${label}: unresolved placeholder detected`)
    }
    if (FORBIDDEN_TEXT.some(pattern => pattern.test(value))) {
      errors.push(`${label}: placeholder or legacy fallback text detected`)
    }
    if (SECRET_TEXT.some(pattern => pattern.test(value))) {
      errors.push(`${label}: potential credential detected; value suppressed`)
    }
    if (HISTORICAL_EXECUTION_TEXT.some(pattern => pattern.test(value))) {
      errors.push(`${label}: historical execution result detected`)
    }
  })
  return errors
}

function revisionFor(reference: CommitReference, commit: Commit): string {
  if (!reference.revision && reference.role === 'reused') {
    const parents = git(['rev-list', '--parents', '-n', '1', commit.full]).split(' ')
    return parents.length > 1 ? `${commit.full}^` : commit.full
  }
  if (!reference.revision || reference.revision === 'commit') return commit.full
  if (reference.revision === 'parent') return `${commit.full}^`
  return reference.revision
}

function validateReference(
  reference: CommitReference,
  commit: Commit,
  changes: ChangedFile[],
): string[] {
  const errors: string[] = []
  const changedPaths = new Set(changes.flatMap(change => [change.path, change.oldPath ?? '']))
  if (reference.revision && !['commit', 'parent'].includes(reference.revision) && !/^[0-9a-f]{40}$/.test(reference.revision)) {
    errors.push(`${commit.short}: reference revision must be commit, parent, or an immutable full SHA`)
  }
  const revision = revisionFor(reference, commit)
  if (reference.role === 'changed') {
    const change = changes.find(candidate => candidate.path === reference.path)
    if (!changedPaths.has(reference.path)) {
      errors.push(`${commit.short}: changed reference is absent from diff: ${reference.path}`)
    }
    if (reference.oldPath) {
      if (!changedPaths.has(reference.oldPath)) {
        errors.push(`${commit.short}: rename old path is absent from diff: ${reference.oldPath}`)
      }
      if (!change?.status.startsWith('R') || change.oldPath !== reference.oldPath) {
        errors.push(`${commit.short}: rename pair does not match diff: ${reference.oldPath} -> ${reference.path}`)
      }
    }
    if (reference.revision && !['commit', commit.full].includes(reference.revision)) {
      errors.push(`${commit.short}: changed reference cannot point to another revision: ${reference.path}`)
    }
    if (reference.symbol && changedPaths.has(reference.path)) {
      const symbolRevision = change?.status === 'D' ? `${commit.full}^` : commit.full
      const content = fileAtRevision(symbolRevision, reference.path)
      if (content === undefined) {
        errors.push(`${commit.short}: changed reference content unavailable at ${symbolRevision}: ${reference.path}`)
      } else if (!content.includes(reference.symbol)) {
        errors.push(`${commit.short}: symbol/heading not found at ${symbolRevision}: ${reference.symbol}`)
      }
    }
  } else {
    const content = fileAtRevision(revision, reference.path)
    if (content === undefined) {
      errors.push(`${commit.short}: ${reference.role} reference missing at ${revision}: ${reference.path}`)
    } else if (reference.symbol && !content.includes(reference.symbol)) {
      errors.push(`${commit.short}: symbol/heading not found at ${revision}: ${reference.symbol}`)
    }
  }
  return errors
}

export function validateRecordAgainstCommit(record: CommitRecord, commit: Commit): string[] {
  const errors = validateRecordShape(record)
  if (record.commit !== commit.full) {
    errors.push(`${commit.short}: record full SHA mismatch`)
  }
  const changes = changedFiles(commit.full)
  const changedPaths = new Set(changes.flatMap(change => [change.path, change.oldPath ?? '']))
  const declared = new Set<string>()

  for (const reference of record.references) {
    errors.push(...validateReference(reference, commit, changes))
    if (reference.role === 'changed') {
      declared.add(reference.path)
      if (reference.oldPath) declared.add(reference.oldPath)
    }
  }
  for (const change of changes) {
    if (!change.status.startsWith('R')) continue
    const paired = record.references.some(reference =>
      reference.role === 'changed' &&
      reference.path === change.path &&
      reference.oldPath === change.oldPath,
    )
    if (!paired) {
      errors.push(`${commit.short}: rename requires an explicit old/new reference: ${change.oldPath} -> ${change.path}`)
    }
  }
  for (const group of record.changeGroups ?? []) {
    const matches = changes.filter(change =>
      change.path.startsWith(group.prefix) || change.oldPath?.startsWith(group.prefix),
    )
    if (matches.length !== group.count) {
      errors.push(`${commit.short}: group ${group.prefix} declares ${group.count}, diff contains ${matches.length}`)
    }
    matches.forEach(change => {
      declared.add(change.path)
      if (change.oldPath) declared.add(change.oldPath)
    })
  }
  for (const path of changedPaths) {
    if (path && !declared.has(path)) {
      errors.push(`${commit.short}: changed file has no design/plan coverage: ${path}`)
    }
  }

  const knownPaths = new Set([
    ...record.references.flatMap(reference => [reference.path, reference.oldPath ?? '']),
    ...(record.changeGroups ?? []).map(group => group.prefix),
  ])
  for (const [index, step] of record.plan.steps.entries()) {
    for (const path of step.paths) {
      if (!knownPaths.has(path) && ![...knownPaths].some(known => known.endsWith('/') && path.startsWith(known))) {
        errors.push(`${commit.short}: plan step ${index + 1} has undeclared path: ${path}`)
      }
    }
  }

  return errors
}

function substantiveProse(record: CommitRecord): { field: string; text: string }[] {
  return [
    record.beforeState,
    record.problem,
    ...record.architecture,
    ...record.decisions,
    ...record.alternatives,
    ...record.plan.steps.map(step => step.detail),
  ].map(text => ({ field: record.commit.slice(0, 7), text }))
}

function normalizedShingles(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[0-9a-f]{7,40}/g, '<sha>')
    .replace(/\d+/g, '<n>')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
  const shingles = new Set<string>()
  for (let index = 0; index <= normalized.length - 8; index++) {
    shingles.add(normalized.slice(index, index + 8))
  }
  return shingles
}

export function validateDuplication(records: CommitRecord[]): string[] {
  const errors: string[] = []
  const prose = records.flatMap(substantiveProse)
  for (let left = 0; left < prose.length; left++) {
    for (let right = left + 1; right < prose.length; right++) {
      const a = prose[left]!
      const b = prose[right]!
      if (a.field === b.field) continue
      const normalizeExact = (text: string) => text.replace(/[0-9a-f]{7,40}/g, '<sha>').replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim()
      if (a.text.length >= 50 && normalizeExact(a.text) === normalizeExact(b.text)) {
        errors.push(`duplicate substantive paragraph: ${a.field} and ${b.field}`)
        continue
      }
      if (a.text.length < 140 || b.text.length < 140) continue
      const aShingles = normalizedShingles(a.text)
      const bShingles = normalizedShingles(b.text)
      const intersection = [...aShingles].filter(value => bShingles.has(value)).length
      const union = new Set([...aShingles, ...bShingles]).size
      if (union > 0 && intersection / union >= 0.9) {
        errors.push(`near-duplicate substantive paragraph: ${a.field} and ${b.field}`)
      }
    }
  }
  return errors
}

export function validateRecords(
  loaded: LoadedRecords,
  history: Commit[],
  mode: DocumentationMode,
): string[] {
  const errors: string[] = []
  const selected = expectedHistorical(history, mode)

  try {
    historicalDocumentPaths(selected, full => loaded.historical.get(full))
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  const expected = new Set(selected.map(commit => commit.full))
  const shortShas = new Set<string>()
  for (const commit of history) {
    if (shortShas.has(commit.short)) errors.push(`short SHA collision: ${commit.short}`)
    shortShas.add(commit.short)
  }
  for (const sha of loaded.historical.keys()) {
    if (!expected.has(sha)) errors.push(`unexpected record for this mode: ${sha.slice(0, 7)}`)
  }
  for (const commit of selected) {
    const record = loaded.historical.get(commit.full)
    if (!record) {
      errors.push(`missing design record: ${commit.short}`)
      continue
    }
    errors.push(...validateRecordAgainstCommit(record, commit))
  }
  errors.push(...validateRecordShape(loaded.self))
  errors.push(...validateDuplication([...selected.map(commit => loaded.historical.get(commit.full)!).filter(Boolean), loaded.self]))
  return errors
}
