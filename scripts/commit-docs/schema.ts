export type CommitStatus = 'implemented' | 'partial' | 'unimplemented'
export type CommitKind = 'component' | 'metadata-migration' | 'evidence-update'
export type ReferenceRole = 'changed' | 'reused' | 'test' | 'evidence'

export type CommitReference = {
  path: string
  role: ReferenceRole
  note: string
  oldPath?: string
  symbol?: string
  revision?: string
}

export type EvidenceKind =
  | 'recorded-command-pass'
  | 'recorded-ci-pass'
  | 'test-added'
  | 'diff-observed'
  | 'later-evidence'
  | 'not-recorded'

export type CommitEvidence = {
  kind: EvidenceKind
  statement: string
  source?: CommitReference
}

export type ChangeGroup = {
  prefix: string
  count: number
  note: string
}

export type PlanStep = {
  title: string
  detail: string
  paths: string[]
}

export type CommitRecord = {
  commit: string
  changeId?: string
  title?: string
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
  evidence: CommitEvidence[]
  remaining: string[]
  references: CommitReference[]
  changeGroups?: ChangeGroup[]
  plan: {
    preconditions: string[]
    reuse: string[]
    steps: PlanStep[]
    compatibility: string[]
    risks: string[]
    verification: string[]
    completed: string[]
    incomplete: string[]
  }
}

export type Commit = {
  full: string
  short: string
  date: string
  subject: string
}

export type DocumentationMode = 'head' | 'next'

export function defineCommitRecord(record: CommitRecord): CommitRecord {
  return record
}

export const REFERENCE_ROLES: ReferenceRole[] = [
  'changed',
  'reused',
  'test',
  'evidence',
]

export const EVIDENCE_KINDS: EvidenceKind[] = [
  'recorded-command-pass',
  'recorded-ci-pass',
  'test-added',
  'diff-observed',
  'later-evidence',
  'not-recorded',
]
