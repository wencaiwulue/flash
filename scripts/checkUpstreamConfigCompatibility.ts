import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import {
  completeRequiresStatement,
  UPSTREAM_BASELINE_VERSION,
  type BaselinePointer,
  type InventoryDiff,
  type UpstreamEntry,
  type UpstreamInventory,
} from './upstreamConfigInventory.ts'

export const COMPATIBILITY_STATUSES = [
  'aligned',
  'partial',
  'missing',
  'different',
  'blocked',
  'excluded',
] as const

export type CheckMode = 'drift' | 'batch' | 'final'

export type MatrixEntryV2 = CompatibilityMatrixEntry & {
  ownerBatch?: number
  spec?: string
  verifiedVersion?: string
  currentReview?: {
    by: string
    at: string
    baseline: string
  }
}

export type CompatibilityMatrixV2 = Omit<CompatibilityMatrix, 'entries'> & {
  schemaVersion: 2
  entries: MatrixEntryV2[]
  migratedFrom?: string
  migratedAt?: string
}

export type EnvConsumerRegistry = {
  schemaVersion: 1
  consumers: Record<string, Array<{ file: string; line?: number; purpose?: string }>>
}

export type CheckCompatibilityInputV2 = Omit<CheckCompatibilityInput, 'inventory' | 'matrix'> & {
  inventory: CompatibilityInventory | UpstreamInventory
  matrix: CompatibilityMatrix | CompatibilityMatrixV2
  mode: CheckMode
  repoRoot?: string
  envConsumers?: EnvConsumerRegistry
}

export type CheckCompatibilityResult = {
  diagnostics: Diagnostic[]
  pass: boolean
  mode: CheckMode
  baseline: string
  counts: {
    total: number
    byStatus: Record<CompatibilityStatus, number>
    byOwner: Record<string, number>
  }
}

export function migrateMatrix(
  sourceMatrix: CompatibilityMatrix | CompatibilityMatrixV2,
  options: {
    from: string
    to: string
    diff: InventoryDiff
    force?: boolean
    ownerDefault?: number
  },
): CompatibilityMatrixV2 {
  const sourceEntries = new Map(sourceMatrix.entries.map(entry => [entry.id, entry]))
  const newEntries: MatrixEntryV2[] = []
  const now = new Date().toISOString()

  // Carry over unchanged entries with default owner if needed
  for (const id of options.diff.unchanged) {
    const source = sourceEntries.get(id)
    if (source) {
      newEntries.push({
        ...source,
        ownerBatch: options.ownerDefault,
        spec: undefined,
        verifiedVersion: undefined,
        currentReview: undefined,
      })
    }
  }

  // Add new entries (missing/blocked)
  for (const entry of options.diff.added) {
    const status = entry.afterBaseline ? 'blocked' : 'missing'
    newEntries.push({
      id: entry.id,
      status,
      implementation: [],
      tests: [],
      evidence: [],
      dimensions: emptyDimensions(),
      notes: entry.afterBaseline
        ? `Upstream documentation is ahead of stable ${options.to}; introduced in ${entry.introduced ?? 'a later version'}.`
        : '',
      exclusion: null,
      ownerBatch: options.ownerDefault,
    })
  }

  // Handle changed entries
  for (const change of options.diff.changed) {
    const source = sourceEntries.get(change.id)
    if (source) {
      // Downgrade aligned to partial
      const status = source.status === 'aligned' ? 'partial' : source.status
      const notes = [
        source.notes,
        `Changed in upstream ${options.to}: ${change.changes.join(', ')}`,
      ].filter(Boolean).join(' ')
      newEntries.push({
        ...source,
        status,
        notes,
        ownerBatch: options.ownerDefault,
      })
    }
  }

  // Handle removed entries (excluded with lifecycle evidence)
  for (const entry of options.diff.removed) {
    newEntries.push({
      id: entry.id,
      status: 'excluded',
      implementation: [],
      tests: [],
      evidence: [],
      dimensions: emptyDimensions(),
      notes: '',
      exclusion: {
        reason: `Upstream lifecycle: ${entry.lifecycle}; removed from baseline ${options.to}`,
        evidence: entry.source?.url ?? 'upstream inventory',
        lifecycle: entry.lifecycle,
        replacement: entry.replacement ?? null,
      },
      ownerBatch: options.ownerDefault,
    })
  }

  // Sort by kind then id
  const kindOrder: Record<UpstreamEntry['kind'], number> = {
    setting: 0, hook: 1, env: 2,
  }
  newEntries.sort((a, b) => {
    const aKind = a.id.split(':')[0] as keyof typeof kindOrder
    const bKind = b.id.split(':')[0] as keyof typeof kindOrder
    const kindDiff = kindOrder[aKind] - kindOrder[bKind]
    return kindDiff !== 0 ? kindDiff : a.id < b.id ? -1 : 1
  })

  return {
    schemaVersion: 2,
    baseline: options.to,
    entries: newEntries,
    schemaExclusions: [...sourceMatrix.schemaExclusions],
    migratedFrom: options.from,
    migratedAt: now,
  }
}

export type CompatibilityStatus = typeof COMPATIBILITY_STATUSES[number]
export type CompatibilityKind = 'setting' | 'hook' | 'env'

export type CompatibilityInventoryEntry = {
  id: string
  kind: CompatibilityKind
  path: string
  lifecycle: 'active' | 'deprecated' | 'removed'
  introduced?: string
  afterBaseline?: boolean
  replacement?: string
  source?: {
    url: string
    sha256: string
    anchor: string
  }
  excerpt?: string
}

export type CompatibilityInventory = {
  baseline: { version: string }
  entries: readonly CompatibilityInventoryEntry[]
}

export type CompatibilityDimensionName =
  | 'path'
  | 'type'
  | 'default'
  | 'source'
  | 'precedence'
  | 'runtime'

export type CompatibilityDimension = {
  status: CompatibilityStatus
  evidence: string
}

export type CompatibilityExclusion = {
  reason: string
  evidence: string
  lifecycle?: 'active' | 'deprecated' | 'removed'
  replacement?: string | null
  sourceAnchor?: string
}

export type CompatibilityMatrixEntry = {
  id: string
  status: CompatibilityStatus
  implementation: string[]
  tests: string[]
  evidence: string[]
  dimensions: Record<CompatibilityDimensionName, CompatibilityDimension>
  notes: string
  exclusion: CompatibilityExclusion | null
}

export type CompatibilityMatrix = {
  schemaVersion: 1
  baseline: string
  entries: CompatibilityMatrixEntry[]
  schemaExclusions: Array<{
    path: string
    reason: string
    evidence: string
  }>
}

export type Diagnostic = {
  code:
    | 'missing-in-flash'
    | 'undocumented-schema-key'
    | 'undocumented-hook-event'
    | 'invalid-matrix-envelope'
    | 'invalid-matrix-structure'
    | 'missing-matrix-entry'
    | 'stale-matrix-entry'
    | 'duplicate-matrix-entry'
    | 'invalid-aligned-evidence'
    | 'invalid-matrix-status'
    | 'invalid-after-baseline'
    | 'invalid-different-evidence'
    | 'invalid-exclusion-evidence'
    | 'invalid-schema-exclusion'
    | 'invalid-owner-batch'
    | 'invalid-spec'
    | 'invalid-implementation-path'
    | 'invalid-test-path'
    | 'invalid-env-consumer'
    | 'invalid-aligned-not-complete'
    | 'invalid-verified-version'
    | 'invalid-current-review'
    | 'invalid-deprecated-effective-excluded'
  id?: string
  path?: string
  message: string
}

export type CheckCompatibilityInput = {
  inventory: CompatibilityInventory
  matrix: CompatibilityMatrix
  schemaPaths: ReadonlySet<string>
  hookEvents: readonly string[]
}

const DIMENSION_NAMES: readonly CompatibilityDimensionName[] = [
  'path',
  'type',
  'default',
  'source',
  'precedence',
  'runtime',
]

const DIAGNOSTIC_OUTPUT_ORDER: Partial<Record<Diagnostic['code'], number>> = {
  'missing-in-flash': 0,
  'undocumented-schema-key': 1,
  'missing-matrix-entry': 2,
  'stale-matrix-entry': 3,
  'invalid-aligned-evidence': 4,
}

const DEFAULT_FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../fixtures/upstream-config/2.1.311/', import.meta.url),
)

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function checkCompatibilityV2(
  input: CheckCompatibilityInputV2,
): Promise<CheckCompatibilityResult> {
  const { mode, repoRoot } = input
  const diagnostics = checkCompatibility({
    ...input,
    inventory: normalizeInventory(input.inventory),
    matrix: normalizeMatrix(input.matrix),
  })
  const matrix = normalizeMatrix(input.matrix)
  const inventory = normalizeInventory(input.inventory)

  // Batch and Final mode checks
  if (mode === 'batch' || mode === 'final') {
    const root = repoRoot ?? fileURLToPath(new URL('..', import.meta.url))
    const matrixEntriesById = new Map(matrix.entries.map(entry => [entry.id, entry]))

    for (const entry of matrix.entries) {
      // Owner batch check
      const v2Entry = entry as MatrixEntryV2
      if (v2Entry.ownerBatch === undefined) {
        diagnostics.push({
          code: 'invalid-owner-batch',
          id: entry.id,
          message: `Entry ${entry.id} requires an ownerBatch`,
        })
      }

      // Spec check (TBD is acceptable)
      if (entry.status === 'aligned' && !v2Entry.spec) {
        diagnostics.push({
          code: 'invalid-spec',
          id: entry.id,
          message: `Aligned entry ${entry.id} requires a spec reference`,
        })
      }

      // Implementation and test paths exist
      for (const path of entry.implementation) {
        const fullPath = join(root, path)
        if (!await pathExists(fullPath)) {
          diagnostics.push({
            code: 'invalid-implementation-path',
            id: entry.id,
            path: fullPath,
            message: `Implementation path ${path} does not exist`,
          })
        }
      }
      for (const path of entry.tests) {
        const fullPath = join(root, path)
        if (!await pathExists(fullPath)) {
          diagnostics.push({
            code: 'invalid-test-path',
            id: entry.id,
            path: fullPath,
            message: `Test path ${path} does not exist`,
          })
        }
      }

      // Env consumer check
      if (entry.id.startsWith('env:')) {
        const consumers = input.envConsumers?.consumers[entry.id.slice('env:'.length)]
        if (!consumers || consumers.length === 0) {
          diagnostics.push({
            code: 'invalid-env-consumer',
            id: entry.id,
            message: `Env var ${entry.id} has no registered consumers`,
          })
        }
      }
    }

    // Final mode only checks
    if (mode === 'final') {
      for (const entry of matrix.entries) {
        const v2Entry = entry as MatrixEntryV2

        if (entry.status === 'aligned') {
          // All dimensions aligned and evidenced
          const allAligned = Object.values(entry.dimensions).every(
            dim => dim.status === 'aligned' && dim.evidence,
          )
          if (!allAligned) {
            diagnostics.push({
              code: 'invalid-aligned-not-complete',
              id: entry.id,
              message: `Aligned entry ${entry.id} requires all six dimensions to be aligned and evidenced`,
            })
          }
          // Verified version present
          if (!v2Entry.verifiedVersion) {
            diagnostics.push({
              code: 'invalid-verified-version',
              id: entry.id,
              message: `Aligned entry ${entry.id} requires verifiedVersion`,
            })
          }
          // Current review present
          if (!v2Entry.currentReview) {
            diagnostics.push({
              code: 'invalid-current-review',
              id: entry.id,
              message: `Aligned entry ${entry.id} requires currentReview`,
            })
          }
        }

        // After baseline entries must be blocked
        const invEntry = inventory.entries.find(e => e.id === entry.id)
        if (invEntry?.afterBaseline && entry.status !== 'blocked') {
          diagnostics.push({
            code: 'invalid-after-baseline',
            id: entry.id,
            message: `After baseline entry ${entry.id} must have status blocked`,
          })
        }

        // Deprecated-effective should not be excluded without explicit evidence
        if (entry.status === 'excluded') {
          const invEntry = inventory.entries.find(e => e.id === entry.id)
          if (invEntry?.lifecycle !== 'removed') {
            // Check for ignored-by-design evidence
            const hasIgnoredEvidence =
              entry.exclusion?.reason.includes('ignored-by-design') ||
              entry.evidence.some(e => e.includes('ignored-by-design'))
            if (!hasIgnoredEvidence) {
              diagnostics.push({
                code: 'invalid-excluded-lacks-evidence',
                id: entry.id,
                message: `Excluded entry ${entry.id} requires 'ignored-by-design' evidence`,
              })
            }
          }
        }
      }
    }
  }

  // Sort diagnostics deterministically
  diagnostics.sort((a, b) => {
    const order = (code: string) =>
      DIAGNOSTIC_OUTPUT_ORDER[code as keyof typeof DIAGNOSTIC_OUTPUT_ORDER] ?? Number.MAX_SAFE_INTEGER
    const orderDiff = order(a.code) - order(b.code)
    if (orderDiff !== 0) return orderDiff
    const aKey = [a.code, a.id, a.path, a.message].map(v => v ?? '').join('\0')
    const bKey = [b.code, b.id, b.path, b.message].map(v => v ?? '').join('\0')
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })

  // Calculate counts
  const byStatus = Object.fromEntries(COMPATIBILITY_STATUSES.map(s => [s, 0])) as Record<
    CompatibilityStatus,
    number
  >
  const byOwner: Record<string, number> = {}
  for (const entry of matrix.entries) {
    byStatus[entry.status]++
    const owner = (entry as MatrixEntryV2).ownerBatch?.toString() ?? 'unknown'
    byOwner[owner] = (byOwner[owner] ?? 0) + 1
  }

  return {
    diagnostics,
    pass: diagnostics.length === 0,
    mode,
    baseline: inventory.baseline.version,
    counts: {
      total: inventory.entries.length,
      byStatus,
      byOwner,
    },
  }
}

function normalizeInventory(inv: CompatibilityInventory | UpstreamInventory): CompatibilityInventory {
  if ('baseline' in inv && 'version' in inv.baseline && 'entries' in inv) {
    return {
      baseline: { version: inv.baseline.version },
      entries: inv.entries.map(e => ({
        id: e.id,
        kind: e.kind,
        path: e.path,
        lifecycle: e.lifecycle,
        introduced: e.introduced,
        afterBaseline: e.afterBaseline,
        replacement: e.replacement,
        source: e.source,
        excerpt: e.excerpt,
      })),
    }
  }
  return inv as CompatibilityInventory
}

function normalizeMatrix(mat: CompatibilityMatrix | CompatibilityMatrixV2): CompatibilityMatrix {
  if (mat.schemaVersion === 2) {
    return {
      ...mat,
      schemaVersion: 1,
      entries: mat.entries.map(e => {
        const { ownerBatch, spec, verifiedVersion, currentReview, ...rest } = e
        return rest
      }),
    }
  }
  return mat as CompatibilityMatrix
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveRef(schema: Record<string, unknown>, reference: string): Record<string, unknown> {
  if (!reference.startsWith('#/')) {
    throw new Error(`external schema reference is not supported: ${reference}`)
  }
  let current: unknown = schema
  for (const encodedSegment of reference.slice(2).split('/')) {
    const segment = encodedSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isRecord(current) || !(segment in current)) {
      throw new Error(`unresolved schema reference: ${reference}`)
    }
    current = current[segment]
  }
  if (!isRecord(current)) throw new Error(`schema reference is not an object: ${reference}`)
  return current
}

export function collectSchemaPaths(schema: Record<string, unknown>): Set<string> {
  const paths = new Set<string>()

  function visit(node: Record<string, unknown>, prefix: string, refStack: Set<string>) {
    const reference = node.$ref
    if (typeof reference === 'string') {
      if (!reference.startsWith('#/')) {
        throw new Error(`external schema reference is not supported: ${reference}`)
      }
      if (!refStack.has(reference)) {
        refStack.add(reference)
        try {
          visit(resolveRef(schema, reference), prefix, refStack)
        } finally {
          refStack.delete(reference)
        }
      }
    }

    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        const path = prefix ? `${prefix}.${key}` : key
        paths.add(path)
        if (isRecord(child)) visit(child, path, refStack)
      }
    }

    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = node[keyword]
      if (!Array.isArray(branches)) continue
      for (const branch of branches) {
        if (isRecord(branch)) visit(branch, prefix, refStack)
      }
    }
  }

  visit(schema, '', new Set())
  return paths
}

function emptyDimensions(): Record<CompatibilityDimensionName, CompatibilityDimension> {
  return {
    path: { status: 'missing', evidence: '' },
    type: { status: 'missing', evidence: '' },
    default: { status: 'missing', evidence: '' },
    source: { status: 'missing', evidence: '' },
    precedence: { status: 'missing', evidence: '' },
    runtime: { status: 'missing', evidence: '' },
  }
}

function requiresEvidence(entry: CompatibilityInventoryEntry): string {
  const evidence = completeRequiresStatement(entry.excerpt ?? '')
  if (!evidence) {
    throw new Error(
      `after-baseline entry ${entry.id} requires a complete Requires statement in its inventory excerpt`,
    )
  }
  return evidence
}

function lifecycleExclusion(entry: CompatibilityInventoryEntry): CompatibilityExclusion {
  const sourceAnchor = entry.source?.anchor ?? ''
  return {
    reason: `upstream lifecycle: ${entry.lifecycle}; no flash implementation recorded`,
    evidence: entry.source ? `${entry.source.url}${sourceAnchor}` : 'upstream inventory',
    lifecycle: entry.lifecycle,
    replacement: entry.replacement ?? null,
    sourceAnchor,
  }
}

export function createInitialMatrix(
  inventory: CompatibilityInventory,
  schemaPaths: ReadonlySet<string>,
  hookEvents: readonly string[],
): CompatibilityMatrix {
  const hookEventSet = new Set(hookEvents)
  const documentedSchemaPaths = new Set(
    inventory.entries.filter(entry => entry.kind === 'setting').map(entry => entry.path),
  )

  const entries = inventory.entries.map(entry => {
    const dimensions = emptyDimensions()
    const present = entry.kind === 'setting'
      ? schemaPaths.has(entry.path)
      : entry.kind === 'hook'
        ? hookEventSet.has(entry.path)
        : false
    if (present) {
      dimensions.path = {
        status: 'aligned',
        evidence: entry.kind === 'setting' ? 'generated schema diff' : 'HOOK_EVENTS',
      }
    }

    let status: CompatibilityStatus = present ? 'partial' : 'missing'
    let exclusion: CompatibilityExclusion | null = null
    let notes = ''
    if (!present && entry.lifecycle !== 'active') {
      status = 'excluded'
      exclusion = lifecycleExclusion(entry)
    }
    if (entry.afterBaseline) {
      status = 'blocked'
      dimensions.runtime = { status: 'blocked', evidence: requiresEvidence(entry) }
      notes = `Upstream documentation is ahead of stable ${inventory.baseline.version}; introduced in ${entry.introduced ?? 'a later version'}.`
      exclusion = null
    }

    return {
      id: entry.id,
      status,
      implementation: [],
      tests: [],
      evidence: [],
      dimensions,
      notes,
      exclusion,
    }
  })

  const schemaExclusions = [...schemaPaths]
    .filter(path => !documentedSchemaPaths.has(path))
    .sort()
    .map(path => ({
      path,
      reason: 'flash-only or legacy schema path; review ownership in B2-B5',
      evidence: 'src/utils/settings/types.ts',
    }))

  return {
    schemaVersion: 1,
    baseline: inventory.baseline.version,
    entries,
    schemaExclusions,
  }
}

function isCompatibilityStatus(value: unknown): value is CompatibilityStatus {
  return typeof value === 'string' &&
    (COMPATIBILITY_STATUSES as readonly string[]).includes(value)
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function hasEvidence(value: unknown): value is string[] {
  return Array.isArray(value) && value.some(item => hasText(item))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

export function checkCompatibility({
  inventory,
  matrix,
  schemaPaths,
  hookEvents,
}: CheckCompatibilityInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (!isRecord(matrix)) {
    return [{
      code: 'invalid-matrix-envelope',
      message: 'compatibility matrix must be a mapping',
    }]
  }
  if (
    matrix.schemaVersion !== 1 ||
    inventory.baseline.version !== UPSTREAM_BASELINE_VERSION ||
    matrix.baseline !== inventory.baseline.version
  ) {
    diagnostics.push({
      code: 'invalid-matrix-envelope',
      message: `matrix envelope requires schemaVersion 1 and baseline ${UPSTREAM_BASELINE_VERSION} matching the inventory; received schemaVersion ${String(matrix.schemaVersion)} and baseline ${String(matrix.baseline)} (inventory ${String(inventory.baseline.version)})`,
    })
  }
  const rawMatrixEntries: unknown[] = Array.isArray(matrix.entries) ? matrix.entries : []
  if (!Array.isArray(matrix.entries)) {
    diagnostics.push({
      code: 'invalid-matrix-structure',
      message: 'matrix entries must be an array of mappings',
    })
  }
  const matrixEntries: CompatibilityMatrixEntry[] = []
  for (const [index, entry] of rawMatrixEntries.entries()) {
    if (!isRecord(entry)) {
      diagnostics.push({
        code: 'invalid-matrix-structure',
        id: `entries[${index}]`,
        message: 'matrix entries must contain only mappings',
      })
      continue
    }
    matrixEntries.push(entry as CompatibilityMatrixEntry)
  }

  const inventoryById = new Map(inventory.entries.map(entry => [entry.id, entry]))
  const matrixEntriesById = new Map<string, CompatibilityMatrixEntry[]>()
  for (const entry of matrixEntries) {
    if (typeof entry.id !== 'string') continue
    const entries = matrixEntriesById.get(entry.id) ?? []
    entries.push(entry)
    matrixEntriesById.set(entry.id, entries)
  }

  for (const inventoryEntry of inventory.entries) {
    if (!matrixEntriesById.has(inventoryEntry.id)) {
      diagnostics.push({
        code: 'missing-matrix-entry',
        id: inventoryEntry.id,
        message: `inventory entry ${inventoryEntry.id} has no matrix entry`,
      })
    }
  }
  for (const [id, entries] of matrixEntriesById) {
    if (!inventoryById.has(id)) {
      diagnostics.push({
        code: 'stale-matrix-entry',
        id,
        message: `matrix entry ${id} is not present in the upstream inventory`,
      })
    }
    if (entries.length > 1) {
      diagnostics.push({
        code: 'duplicate-matrix-entry',
        id,
        message: `matrix entry ${id} occurs ${entries.length} times`,
      })
    }
  }

  const documentedSchemaPaths = new Set(
    inventory.entries.filter(entry => entry.kind === 'setting').map(entry => entry.path),
  )
  const schemaExclusionPaths = new Set<string>()
  const schemaExclusions: unknown[] = Array.isArray(matrix.schemaExclusions)
    ? matrix.schemaExclusions
    : []
  if (!Array.isArray(matrix.schemaExclusions)) {
    diagnostics.push({
      code: 'invalid-matrix-structure',
      message: 'matrix schemaExclusions must be an array of mappings',
    })
  }
  for (const exclusion of schemaExclusions) {
    if (!isRecord(exclusion)) {
      diagnostics.push({
        code: 'invalid-schema-exclusion',
        message: 'schema exclusions must contain only mappings',
      })
      continue
    }
    if (typeof exclusion.path === 'string') schemaExclusionPaths.add(exclusion.path)
    if (
      !hasText(exclusion.path) || exclusion.path.includes('*') ||
      !hasText(exclusion.reason) || !hasText(exclusion.evidence)
    ) {
      diagnostics.push({
        code: 'invalid-schema-exclusion',
        path: typeof exclusion.path === 'string' ? exclusion.path : undefined,
        message: 'schema exclusions require an exact path, reason and evidence',
      })
    }
  }
  for (const path of schemaPaths) {
    if (!documentedSchemaPaths.has(path) && !schemaExclusionPaths.has(path)) {
      diagnostics.push({
        code: 'undocumented-schema-key',
        path,
        message: `schema path ${path} is neither in the upstream inventory nor exactly excluded`,
      })
    }
  }

  const hookEventSet = new Set(hookEvents)
  const documentedHooks = new Set(
    inventory.entries.filter(entry => entry.kind === 'hook').map(entry => entry.path),
  )
  for (const event of hookEventSet) {
    if (!documentedHooks.has(event)) {
      diagnostics.push({
        code: 'undocumented-hook-event',
        path: event,
        message: `hook event ${event} is not present in the upstream inventory`,
      })
    }
  }

  for (const matrixEntry of matrixEntries) {
    const inventoryEntry = inventoryById.get(matrixEntry.id)
    const id = matrixEntry.id
    const invalidStructure: string[] = []
    if (!hasText(id)) invalidStructure.push('id')
    for (const field of ['implementation', 'tests', 'evidence'] as const) {
      if (!isStringArray(matrixEntry[field])) invalidStructure.push(field)
    }
    if (typeof matrixEntry.notes !== 'string') invalidStructure.push('notes')
    for (const name of DIMENSION_NAMES) {
      if (typeof matrixEntry.dimensions?.[name]?.evidence !== 'string') {
        invalidStructure.push(`dimensions.${name}.evidence`)
      }
    }
    if (invalidStructure.length > 0) {
      diagnostics.push({
        code: 'invalid-matrix-structure',
        id,
        message: `matrix entry ${id} requires string[] implementation/tests/evidence, string notes, and string evidence in all six dimensions; invalid: ${invalidStructure.join(', ')}`,
      })
    }
    if (!isCompatibilityStatus(matrixEntry.status)) {
      diagnostics.push({
        code: 'invalid-matrix-status',
        id,
        message: `matrix entry ${id} has invalid status ${String(matrixEntry.status)}`,
      })
    }
    for (const name of DIMENSION_NAMES) {
      const dimension = matrixEntry.dimensions?.[name]
      if (!dimension || !isCompatibilityStatus(dimension.status)) {
        diagnostics.push({
          code: 'invalid-matrix-status',
          id,
          path: name,
          message: `matrix entry ${id} has an invalid ${name} dimension status`,
        })
      }
    }

    if (matrixEntry.status === 'aligned') {
      const invalidDimensions = DIMENSION_NAMES.filter(name => {
        const dimension = matrixEntry.dimensions?.[name]
        return dimension?.status !== 'aligned' || !hasText(dimension.evidence)
      })
      if (
        !hasEvidence(matrixEntry.implementation) ||
        !hasEvidence(matrixEntry.tests) ||
        invalidDimensions.length > 0
      ) {
        diagnostics.push({
          code: 'invalid-aligned-evidence',
          id,
          message: `aligned entry ${id} requires implementation, tests and six evidenced aligned dimensions${invalidDimensions.length ? `; invalid: ${invalidDimensions.join(', ')}` : ''}`,
        })
      }
    }

    if (
      matrixEntry.status === 'different' &&
      (!hasText(matrixEntry.notes) || !hasEvidence(matrixEntry.evidence))
    ) {
      diagnostics.push({
        code: 'invalid-different-evidence',
        id,
        message: `different entry ${id} requires notes and top-level evidence`,
      })
    }

    if (matrixEntry.status === 'excluded') {
      const exclusion = matrixEntry.exclusion
      if (
        !exclusion || !hasText(exclusion.reason) || !hasText(exclusion.evidence) ||
        (inventoryEntry?.replacement !== undefined &&
          exclusion.replacement !== inventoryEntry.replacement)
      ) {
        diagnostics.push({
          code: 'invalid-exclusion-evidence',
          id,
          message: `excluded entry ${id} requires exclusion reason, evidence and any upstream replacement`,
        })
      }
    }

    if (!inventoryEntry) continue
    const pathDimension = matrixEntry.dimensions?.path
    const runtimeDimension = matrixEntry.dimensions?.runtime
    if (inventoryEntry.afterBaseline) {
      const expectedEvidence = completeRequiresStatement(inventoryEntry.excerpt ?? '')
      if (
        matrixEntry.status !== 'blocked' || runtimeDimension?.status !== 'blocked' ||
        !expectedEvidence || runtimeDimension.evidence !== expectedEvidence
      ) {
        diagnostics.push({
          code: 'invalid-after-baseline',
          id,
          message: `after-baseline entry ${id} must have blocked total and runtime statuses and quote the complete original Requires statement`,
        })
      }
    }

    const present = inventoryEntry.kind === 'setting'
      ? schemaPaths.has(inventoryEntry.path)
      : inventoryEntry.kind === 'hook'
        ? hookEventSet.has(inventoryEntry.path)
        : undefined
    if (present === false && (
      matrixEntry.status === 'aligned' || pathDimension?.status === 'aligned'
    )) {
      diagnostics.push({
        code: 'missing-in-flash',
        id,
        path: inventoryEntry.path,
        message: `matrix entry ${id} claims path alignment but ${inventoryEntry.path} is absent from flash`,
      })
    }
  }

  return diagnostics.sort((left, right) => {
    const groupDifference =
      (DIAGNOSTIC_OUTPUT_ORDER[left.code] ?? Number.MAX_SAFE_INTEGER) -
      (DIAGNOSTIC_OUTPUT_ORDER[right.code] ?? Number.MAX_SAFE_INTEGER)
    if (groupDifference !== 0) return groupDifference
    const leftKey = [left.code, left.id, left.path, left.message]
      .map(value => value ?? '').join('\0')
    const rightKey = [right.code, right.id, right.path, right.message]
      .map(value => value ?? '').join('\0')
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

function printReport(
  inventory: CompatibilityInventory,
  matrix: CompatibilityMatrix | CompatibilityMatrixV2,
  diagnostics: Diagnostic[],
  mode: CheckMode = 'drift',
) {
  const matrixEntries = isRecord(matrix) && Array.isArray(matrix.entries)
    ? matrix.entries.filter(entry => isRecord(entry) && typeof entry.id === 'string')
    : []
  const matrixById = new Map(matrixEntries.map(entry => [entry.id, entry]))
  for (const kind of ['setting', 'hook', 'env'] as const) {
    const entries = inventory.entries.filter(entry => entry.kind === kind)
    const counts = Object.fromEntries(COMPATIBILITY_STATUSES.map(status => [status, 0])) as Record<CompatibilityStatus, number>
    for (const entry of entries) {
      const status = matrixById.get(entry.id)?.status
      if (status && isCompatibilityStatus(status)) counts[status]++
    }
    console.log([
      `${kind}: total=${entries.length}`,
      ...COMPATIBILITY_STATUSES.map(status => `${status}=${counts[status]}`),
    ].join(' '))
  }
  console.log(`mode: ${mode}, diagnostics: ${diagnostics.length}`)
  for (const diagnostic of diagnostics) {
    console.error(`[${diagnostic.code}] ${diagnostic.id ?? diagnostic.path ?? ''}: ${diagnostic.message}`)
  }
}

export async function runCli(
  arguments_: readonly string[],
  fixtureDirectory = DEFAULT_FIXTURE_DIRECTORY,
): Promise<Diagnostic[]> {
  let initialize = false
  let mode: CheckMode = 'drift'
  let baselineVersion: string | undefined
  let customFixtureDir: string | undefined

  let i = 0
  while (i < arguments_.length) {
    const arg = arguments_[i]!
    if (arg === '--initialize-matrix') {
      initialize = true
      i++
    } else if (arg === '--mode' && i + 1 < arguments_.length) {
      const m = arguments_[i + 1]
      if (m === 'drift' || m === 'batch' || m === 'final') {
        mode = m
      } else {
        throw new Error(`invalid mode: ${m}`)
      }
      i += 2
    } else if (arg === '--baseline' && i + 1 < arguments_.length) {
      baselineVersion = arguments_[i + 1]
      i += 2
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  // Determine fixture directory
  let fixtureDir = fixtureDirectory
  if (baselineVersion) {
    // Use versioned directory
    fixtureDir = fixtureDirectory.replace(/\/[\d.]+\/?$/, `/${baselineVersion}/`)
  }

  const inventoryPath = join(fixtureDir, 'inventory.json')
  const matrixPath = join(fixtureDir, 'compatibility.yaml')
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as CompatibilityInventory

  const [{ generateSettingsJSONSchema }, { HOOK_EVENTS }] = await Promise.all([
    import('../src/utils/settings/schemaOutput.ts'),
    import('../src/entrypoints/sdk/coreTypes.ts'),
  ])
  const schemaPaths = collectSchemaPaths(JSON.parse(generateSettingsJSONSchema()))

  // Load env consumers
  let envConsumers: EnvConsumerRegistry | undefined
  try {
    const envConsumersPath = join(fixtureDir, '..', 'env-consumers.json')
    if (await pathExists(envConsumersPath)) {
      envConsumers = JSON.parse(await readFile(envConsumersPath, 'utf8')) as EnvConsumerRegistry
    }
  } catch {
    // Ignore if not present
  }

  let matrix: CompatibilityMatrix | CompatibilityMatrixV2
  if (initialize) {
    if (await pathExists(matrixPath)) {
      throw new Error(`refusing to overwrite existing compatibility matrix: ${matrixPath}`)
    }
    matrix = createInitialMatrix(inventory, schemaPaths, HOOK_EVENTS)
    try {
      await writeFile(matrixPath, stringify(matrix, { lineWidth: 0 }), {
        encoding: 'utf8',
        flag: 'wx',
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`refusing to overwrite existing compatibility matrix: ${matrixPath}`)
      }
      throw error
    }
  } else {
    matrix = parse(await readFile(matrixPath, 'utf8')) as CompatibilityMatrix | CompatibilityMatrixV2
  }

  let diagnostics: Diagnostic[]
  if (mode === 'drift') {
    diagnostics = checkCompatibility({
      inventory,
      matrix,
      schemaPaths,
      hookEvents: HOOK_EVENTS,
    })
    printReport(inventory, matrix, diagnostics, mode)
  } else {
    const result = await checkCompatibilityV2({
      inventory,
      matrix,
      schemaPaths,
      hookEvents: HOOK_EVENTS,
      mode,
      repoRoot: fileURLToPath(new URL('..', import.meta.url)),
      envConsumers,
    })
    diagnostics = result.diagnostics
    printReport(inventory, matrix, diagnostics, mode)
  }

  return diagnostics
}

if (import.meta.main) {
  runCli(process.argv.slice(2))
    .then(diagnostics => {
      if (diagnostics.length > 0) process.exitCode = 1
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
