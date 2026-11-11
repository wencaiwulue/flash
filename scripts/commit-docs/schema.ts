export type CommitStatus = 'implemented' | 'partial' | 'unimplemented'
export type CommitKind = 'component' | 'metadata-migration' | 'evidence-update'
export type ReferenceRole = 'changed' | 'reused' | 'test'

export type CommitReference = {
  path: string
  role: ReferenceRole
  note: string
  oldPath?: string
  symbol?: string
  revision?: string
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
]
