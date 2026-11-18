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
  determineOwnerBatch
} from './upstreamConfigInventory.ts'

export const COMPATIBILITY_STATUSES = [
  'aligned',
  'partial',
  'missing',
  'different',
  'blocked',
  'excluded',
  'ignored-by-design',
] as const

const VALID_OWNER_BATCHES: ReadonlyArray<1 | 2 | 3 | 4 | 5 | 'final'> = [1, 2, 3, 4, 5, 'final']

export type CheckMode = 'drift' | 'batch' | 'final'

export type MatrixEntryV2 = CompatibilityMatrixEntry & {
  ownerBatch?: 1 | 2 | 3 | 4 | 5 | 'final'
  spec?: string
  verifiedVersion?: string
  currentReview?: {
    by: string
    at?: string
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
  batches?: Array<1 | 2 | 3 | 4 | 5>
  /** 已登记 spec id 集合（来自 docs/architecture/coverage/manifest.yaml）。传入后 aligned 条目的 spec 必须在其中。 */
  specRegistry?: ReadonlySet<string>
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

export type MigrationResult = {
  matrix: CompatibilityMatrixV2
  removedIds: string[]
  diff: InventoryDiff
}

/**
 * 迁移矩阵到新版本，非破坏性
 * - 保留不变条目的 ownerBatch/spec/verifiedVersion/currentReview
 * - 降级变化条目 aligned→partial
 * - 不自动排除消失条目，而是在 removedIds 中返回供人工复核
 * - 确定排序，时间戳仅在明确传入时设置
 */
export function migrateMatrix(
  sourceMatrix: CompatibilityMatrix | CompatibilityMatrixV2,
  options: {
    from: string
    to: string
    diff: InventoryDiff
    migratedAt?: string
  }
): MigrationResult {
  const sourceEntriesById = new Map(sourceMatrix.entries.map(entry => [entry.id, entry]))
  const newEntries: MatrixEntryV2[] = []
  const removedIds: string[] = []

  // 处理不变条目：保留所有字段，不自动添加 currentReview（需显式批准）
  for (const id of options.diff.unchanged) {
    const source = sourceEntriesById.get(id)
    if (source) {
      const v2Source: MatrixEntryV2 = source as MatrixEntryV2
      newEntries.push({
        ...v2Source,
        ownerBatch: v2Source.ownerBatch ?? determineOwnerBatch(id),
        // Do NOT automatically add currentReview - needs explicit carry-forward approval
      })
    }
  }

  // 处理新增条目
  for (const entry of options.diff.added) {
    const status = entry.afterBaseline ? 'blocked' : 'missing'
    newEntries.push({
      id: entry.id,
      status,
      implementation: [],
      tests: [],
      evidence: [],
      dimensions: {
        path: { status: 'missing', evidence: '' },
        type: { status: 'missing', evidence: '' },
        default: { status: 'missing', evidence: '' },
        source: { status: 'missing', evidence: '' },
        precedence: { status: 'missing', evidence: '' },
        runtime: { status: 'missing', evidence: '' },
      },
      notes: entry.afterBaseline
        ? `Upstream documentation is ahead of stable ${options.to}; introduced in ${entry.introduced ?? 'a later version'}.`
        : '',
      exclusion: null,
      ownerBatch: determineOwnerBatch(entry.id, entry),
    })
  }

  // 处理变化条目：降级 aligned→partial，不自动添加 currentReview
  for (const change of options.diff.changed) {
    const source = sourceEntriesById.get(change.id)
    if (source) {
      const v2Source: MatrixEntryV2 = source as MatrixEntryV2
      const wasAligned = source.status === 'aligned'
      const newStatus = wasAligned ? 'partial' : source.status
      const newNotes = [
        source.notes,
        `Changed in upstream ${options.to}: ${change.changes.join(', ')}`,
      ].filter(Boolean).join(' ')

      newEntries.push({
        ...v2Source,
        status: newStatus,
        notes: newNotes,
        ownerBatch: v2Source.ownerBatch ?? determineOwnerBatch(change.id),
        verifiedVersion: wasAligned ? undefined : v2Source.verifiedVersion,
        // Do NOT automatically add currentReview - existing one is preserved if present
      })
    }
  }

  // 记录消失条目供人工复核（不自动添加为 excluded）
  for (const entry of options.diff.removed) {
    removedIds.push(entry.id)
  }

  // 确定排序：按 kind 然后 id
  const kindOrder: Record<string, number> = { setting: 0, hook: 1, env: 2 }
  newEntries.sort((a, b) => {
    const aKind = a.id.split(':')[0] ?? ''
    const bKind = b.id.split(':')[0] ?? ''
    const kindDiff = (kindOrder[aKind] ?? 999) - (kindOrder[bKind] ?? 999)
    return kindDiff !== 0 ? kindDiff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const result: CompatibilityMatrixV2 = {
    schemaVersion: 2,
    baseline: options.to,
    entries: newEntries,
    schemaExclusions: [...(sourceMatrix.schemaExclusions ?? [])],
    migratedFrom: options.from,
  }

  if (options.migratedAt) {
    result.migratedAt = options.migratedAt
  }

  return { matrix: result, removedIds, diff: options.diff }
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
    | 'entry-not-aligned'
  id?: string
  path?: string
  message: string
}

export type CheckCompatibilityInput = {
  inventory: CompatibilityInventory
  matrix: CompatibilityMatrix
  schemaPaths: ReadonlySet<string>
  hookEvents: readonly string[]
  /**
   * 期望的基线版本。默认 UPSTREAM_BASELINE_VERSION（B0 硬契约：拒绝任何非 2.1.311 基线）。
   * checkCompatibilityV2 传入 inventory 实际基线以支持多基线端到端检查。
   */
  expectedBaseline?: string
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

function normalizeInventory(inv: CompatibilityInventory | UpstreamInventory): CompatibilityInventory {
  if ('baseline' in inv && 'version' in inv.baseline && 'entries' in inv) {
    return {
      baseline: { version: inv.baseline.version },
      entries: (inv.entries as Array<{id:string, kind?:string, path:string, lifecycle?:string, introduced?:string, afterBaseline?:boolean, replacement?:string, source?:{url:string, sha256?:string, anchor:string}, excerpt?:string}>).map(e => ({
        id: e.id,
        kind: (e.kind ?? 'setting') as CompatibilityKind,
        path: e.path,
        lifecycle: (e.lifecycle ?? 'active') as 'active'|'deprecated'|'removed',
        introduced: e.introduced,
        afterBaseline: e.afterBaseline,
        replacement: e.replacement,
        source: e.source ? {url:e.source.url, sha256:e.source.sha256 ?? '', anchor:e.source.anchor} : undefined,
        excerpt: e.excerpt
      })),
    }
  }
  return inv as CompatibilityInventory
}

function normalizeMatrix(mat: CompatibilityMatrix | CompatibilityMatrixV2 | null | undefined): CompatibilityMatrix {
  if (!mat || !isRecord(mat)) {
    return {
      schemaVersion: 1,
      baseline: UPSTREAM_BASELINE_VERSION,
      entries: [],
      schemaExclusions: [],
    }
  }
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
    const segment = encodedSegment.replace('~1', '/').replace('~0', '~')
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
  expectedBaseline = UPSTREAM_BASELINE_VERSION,
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
    inventory.baseline.version !== expectedBaseline ||
    matrix.baseline !== inventory.baseline.version
  ) {
    diagnostics.push({
      code: 'invalid-matrix-envelope',
      message: `matrix envelope requires schemaVersion 1 and baseline ${expectedBaseline} matching the inventory; received schemaVersion ${String(matrix.schemaVersion)} and baseline ${String(matrix.baseline)} (inventory ${String(inventory.baseline.version)})`,
    })
    // If envelope is invalid, only return envelope diagnostics
    return diagnostics
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

export async function checkCompatibilityV2(
  input: CheckCompatibilityInputV2,
): Promise<CheckCompatibilityResult> {
  const { mode, repoRoot, batches } = input

  if (input.matrix === null || !isRecord(input.matrix)) {
    // Empty or invalid matrix, return invalid-matrix-envelope
    return {
      diagnostics: [{
        code: 'invalid-matrix-envelope',
        message: 'compatibility matrix must be a mapping',
      }],
      pass: false,
      mode,
      baseline: normalizeInventory(input.inventory).baseline.version,
      counts: { total: 0, byStatus: {}, byOwner: {} },
    }
  }

  const normalizedInventory = normalizeInventory(input.inventory)
  const normalizedMatrix = normalizeMatrix(input.matrix)

  // 首先运行 B0 checkCompatibility 以确保基础通过。
  // 传入 inventory 实际基线，使多基线端到端工作（B0 直接调用仍默认 2.1.311 硬契约）。
  const diagnostics = checkCompatibility({
    inventory: normalizedInventory,
    matrix: normalizedMatrix,
    schemaPaths: input.schemaPaths,
    hookEvents: input.hookEvents,
    expectedBaseline: normalizedInventory.baseline.version,
  })

  const matrixV2 = input.matrix as CompatibilityMatrixV2
  const entries = matrixV2.entries ?? (input.matrix.entries as MatrixEntryV2[])
  const inventoryById = new Map(normalizedInventory.entries.map(e => [e.id, e]))

  if (mode === 'batch' || mode === 'final') {
    const root = repoRoot ?? fileURLToPath(new URL('..', import.meta.url))

    for (const entry of entries) {
      const v2Entry = entry as MatrixEntryV2
      const inventoryEntry = inventoryById.get(entry.id)
      const ownerBatch = v2Entry.ownerBatch ?? determineOwnerBatch(entry.id, inventoryEntry)

      // 批次过滤仅在 batch 模式生效；final 模式始终全量严格检查，忽略 batches，
      // 否则 final+--batch 会跳过非选中批次条目的 ownerBatch/spec/路径/env 校验，造成绕过。
      const isInSelectedBatch = mode === 'final' || !batches || batches.length === 0 || batches.includes(ownerBatch as 1|2|3|4|5)
      if (!isInSelectedBatch) continue

      // OwnerBatch 验证：必须存在且为合法枚举值（1-5 或 'final'），仅 truthy 检查不够
      if (v2Entry.ownerBatch === undefined || v2Entry.ownerBatch === null) {
        diagnostics.push({
          code: 'invalid-owner-batch',
          id: entry.id,
          message: `Entry ${entry.id} requires an ownerBatch`,
        })
      } else if (!VALID_OWNER_BATCHES.includes(v2Entry.ownerBatch)) {
        diagnostics.push({
          code: 'invalid-owner-batch',
          id: entry.id,
          message: `Entry ${entry.id} has invalid ownerBatch ${String(v2Entry.ownerBatch)}; must be 1-5 or 'final'`,
        })
      }

      // Spec 引用验证：aligned 必须有 spec；若提供了 specRegistry（manifest 登记的 spec id 集合），
      // spec 必须真实登记，仅 truthy 检查不够（否则 spec="definitely-not-registered" 也能通过）。
      if (entry.status === 'aligned') {
        if (!v2Entry.spec) {
          diagnostics.push({
            code: 'invalid-spec',
            id: entry.id,
            message: `Aligned entry ${entry.id} requires a spec reference`,
          })
        } else if (input.specRegistry && !input.specRegistry.has(v2Entry.spec)) {
          diagnostics.push({
            code: 'invalid-spec',
            id: entry.id,
            message: `Aligned entry ${entry.id} references unregistered spec ${v2Entry.spec}; spec must be registered in docs/architecture/coverage/manifest.yaml`,
          })
        }
      }

      // 实现路径存在验证（仅当路径非空时检查）
      for (const path of entry.implementation) {
        const fullPath = join(root, path)
        if (path && !await pathExists(fullPath)) {
          diagnostics.push({
            code: 'invalid-implementation-path',
            id: entry.id,
            path: fullPath,
            message: `Implementation path ${path} does not exist`,
          })
        }
      }

      // 测试路径存在验证（仅当路径非空时检查）
      for (const path of entry.tests) {
        const fullPath = join(root, path)
        if (path && !await pathExists(fullPath)) {
          diagnostics.push({
            code: 'invalid-test-path',
            id: entry.id,
            path: fullPath,
            message: `Test path ${path} does not exist`,
          })
        }
      }

      // 环境变量消费者验证
      if (entry.id.startsWith('env:')) {
        const envName = entry.id.slice('env:'.length)
        const consumers = input.envConsumers?.consumers?.[envName]
        if (!consumers || consumers.length === 0) {
          // 仅当状态不是 missing/partial 时才报错，允许未开始工作
          if (entry.status === 'aligned' || entry.status === 'different' || entry.status === 'excluded') {
            diagnostics.push({
              code: 'invalid-env-consumer',
              id: entry.id,
              message: `Env var ${entry.id} has no registered consumers`,
            })
          }
        }
      }
    }

    // Final 模式独有检查
    if (mode === 'final') {
      for (const entry of entries) {
        const v2Entry = entry as MatrixEntryV2
        const inventoryEntry = inventoryById.get(entry.id)

        // Final 严格门禁：每个 active 条目必须处于终态。
        // 终态 = aligned，或合法 excluded（lifecycle=removed），或有证据的 ignored-by-design，
        // 或 afterBaseline 的 blocked（上游文档领先于基线，允许保留）。
        // 其余 missing/partial/different/blocked 一律视为未完成，必须报错。
        const isAfterBaselineBlocked = Boolean(inventoryEntry?.afterBaseline) && entry.status === 'blocked'
        const isRemovedExcluded = entry.status === 'excluded' && inventoryEntry?.lifecycle === 'removed'
        const isTerminal =
          entry.status === 'aligned' ||
          entry.status === 'ignored-by-design' ||
          isRemovedExcluded ||
          isAfterBaselineBlocked
        if (!isTerminal) {
          diagnostics.push({
            code: 'entry-not-aligned',
            id: entry.id,
            message: `Final mode requires entry ${entry.id} to reach a terminal state (aligned, removed-excluded, or evidenced ignored-by-design); current status: ${entry.status}`,
          })
        }

        if (entry.status === 'aligned') {
          // 所有六维必须 aligned 且有证据
          const allAligned = DIMENSION_NAMES.every(name => {
            const dim = entry.dimensions?.[name]
            return dim?.status === 'aligned' && hasText(dim.evidence)
          })
          if (!allAligned) {
            diagnostics.push({
              code: 'invalid-aligned-not-complete',
              id: entry.id,
              message: `Aligned entry ${entry.id} requires all six dimensions to be aligned and evidenced`,
            })
          }
          // verifiedVersion 必须存在
          if (!v2Entry.verifiedVersion) {
            diagnostics.push({
              code: 'invalid-verified-version',
              id: entry.id,
              message: `Aligned entry ${entry.id} requires verifiedVersion`,
            })
          }
          // currentReview 必须存在且 baseline 匹配当前基线（显式 carry-forward）
          if (!v2Entry.currentReview) {
            diagnostics.push({
              code: 'invalid-current-review',
              id: entry.id,
              message: `Aligned entry ${entry.id} requires currentReview`,
            })
          } else if (v2Entry.currentReview.baseline !== normalizedInventory.baseline.version) {
            diagnostics.push({
              code: 'invalid-current-review',
              id: entry.id,
              message: `Aligned entry ${entry.id} currentReview.baseline must match current baseline ${normalizedInventory.baseline.version} (got ${v2Entry.currentReview.baseline}) - explicit carry-forward approval required`,
            })
          }
        }

        // afterBaseline 条目必须 blocked
        if (inventoryEntry?.afterBaseline && entry.status !== 'blocked') {
          diagnostics.push({
            code: 'invalid-after-baseline',
            id: entry.id,
            message: `After-baseline entry ${entry.id} must have status blocked`,
          })
        }

        // 排除规则验证：仅 removed 可 excluded；其他 ignored-by-design 需用单独状态
        if (entry.status === 'excluded') {
          const exclusion = entry.exclusion

          if (inventoryEntry?.lifecycle !== 'removed') {
            diagnostics.push({
              code: 'invalid-exclusion-evidence',
              id: entry.id,
              message: `Excluded entry ${entry.id} must have lifecycle=removed; use ignored-by-design status otherwise`,
            })
          }

          if (!exclusion?.evidence) {
            diagnostics.push({
              code: 'invalid-exclusion-evidence',
              id: entry.id,
              message: `Excluded entry ${entry.id} requires evidence pointing to upstream removal`,
            })
          }
        }

        // ignored-by-design 状态验证：必须有结构化证据。
        // 自由文本 notes 不算证据（否则随便写一句 notes 即可绕过门禁）；
        // evidence 必须含非空字符串，或提供 exclusion.reason + exclusion.evidence。
        if (entry.status === 'ignored-by-design') {
          const hasExclusionEvidence = Boolean(
            entry.exclusion && hasText(entry.exclusion.reason) && hasText(entry.exclusion.evidence)
          )
          const hasAnyEvidence = hasEvidence(entry.evidence) || hasExclusionEvidence

          if (!hasAnyEvidence) {
            diagnostics.push({
              code: 'invalid-exclusion-evidence',
              id: entry.id,
              message: `ignored-by-design entry ${entry.id} requires explicit evidence (non-empty evidence[] or exclusion.reason+exclusion.evidence); free-text notes alone are not sufficient`,
            })
          }
        }
      }
    }
  }

  // 确定排序诊断
  diagnostics.sort((a, b) => {
    const orderA = DIAGNOSTIC_OUTPUT_ORDER[a.code] ?? Number.MAX_SAFE_INTEGER
    const orderB = DIAGNOSTIC_OUTPUT_ORDER[b.code] ?? Number.MAX_SAFE_INTEGER
    if (orderA !== orderB) return orderA - orderB
    const keyA = [a.code, a.id, a.path, a.message].map(v => v ?? '').join('\0')
    const keyB = [b.code, b.id, b.path, b.message].map(v => v ?? '').join('\0')
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
  })

  // 计算统计
  const byStatus = Object.fromEntries(COMPATIBILITY_STATUSES.map(s => [s, 0])) as Record<
    CompatibilityStatus,
    number
  >
  const byOwner: Record<string, number> = {}
  for (const entry of entries) {
    byStatus[entry.status]++
    const owner = ((entry as MatrixEntryV2).ownerBatch ?? determineOwnerBatch(entry.id)).toString()
    byOwner[owner] = (byOwner[owner] ?? 0) + 1
  }

  return {
    diagnostics,
    pass: diagnostics.length === 0,
    mode,
    baseline: normalizedInventory.baseline.version,
    counts: {
      total: normalizedInventory.entries.length,
      byStatus,
      byOwner,
    },
  }
}

function printReport(
  inventory: CompatibilityInventory,
  matrix: CompatibilityMatrix | CompatibilityMatrixV2,
  diagnostics: Diagnostic[],
  mode: CheckMode = 'drift',
) {
  const matrixEntries = isRecord(matrix) && Array.isArray(matrix.entries)
    ? matrix.entries.filter(entry => isRecord(entry) && typeof (entry as {id:string}).id === 'string')
    : []
  const matrixById = new Map(matrixEntries.map(entry => [
    (entry as {id:string}).id,
    entry
  ]))
  for (const kind of ['setting', 'hook', 'env'] as const) {
    const entries = inventory.entries.filter(entry => entry.kind === kind)
    const counts = Object.fromEntries(COMPATIBILITY_STATUSES.map(status => [status, 0])) as Record<CompatibilityStatus, number>
    for (const entry of entries) {
      const status = (matrixById.get(entry.id) as {status?:CompatibilityStatus})?.status
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
  const batches: Array<1|2|3|4|5> = []

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
    } else if (arg === '--batch' && i + 1 < arguments_.length) {
      const b = arguments_[i + 1]
      const batchNum = parseInt(b.replace('B', ''), 10)
      if (batchNum >= 1 && batchNum <= 5) {
        batches.push(batchNum as 1|2|3|4|5)
      } else {
        throw new Error(`invalid batch: ${b}, must be B1-B5 or 1-5`)
      }
      i += 2
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  // final 模式始终全量检查，不接受 --batch（避免误以为能缩小 final 范围）
  if (mode === 'final' && batches.length > 0) {
    throw new Error('--batch cannot be combined with --mode final; final mode always checks all entries')
  }

  // 确定 fixture 目录
  let fixtureDir = fixtureDirectory
  if (baselineVersion) {
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

  // 加载环境消费者注册表
  let envConsumers: EnvConsumerRegistry | undefined
  try {
    const envConsumersPath = join(fixtureDir, '..', 'env-consumers.json')
    if (await pathExists(envConsumersPath)) {
      envConsumers = JSON.parse(await readFile(envConsumersPath, 'utf8')) as EnvConsumerRegistry
    }
  } catch {
    // 不存在则忽略
  }

  // 加载 manifest 中已登记的 spec id 集合，用于 aligned 条目的 spec 登记校验
  let specRegistry: Set<string> | undefined
  try {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const manifestPath = join(repoRoot, 'docs/architecture/coverage/manifest.yaml')
    if (await pathExists(manifestPath)) {
      const manifest = parse(await readFile(manifestPath, 'utf8')) as { specs?: Array<{ id?: string }> }
      specRegistry = new Set(
        (manifest.specs ?? []).map(spec => spec.id).filter((id): id is string => Boolean(id)),
      )
    }
  } catch {
    // 不存在则忽略
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
    const content = await readFile(matrixPath, 'utf8')
    const parsed = content.trim() ? parse(content) : null
    matrix = parsed as CompatibilityMatrix | CompatibilityMatrixV2
  }

  let diagnostics: Diagnostic[]
  if (matrix === null) {
    // Empty matrix, return invalid-matrix-envelope
    diagnostics = [{
      code: 'invalid-matrix-envelope',
      message: 'compatibility matrix must be a mapping',
    }]
    printReport(inventory, matrix, diagnostics, mode)
  } else if (mode === 'drift') {
    diagnostics = checkCompatibility({
      inventory,
      matrix: normalizeMatrix(matrix),
      schemaPaths,
      hookEvents: HOOK_EVENTS,
      expectedBaseline: inventory.baseline.version,
    })
    printReport(inventory, matrix, diagnostics, mode)
  } else {
    const result = await checkCompatibilityV2({
      inventory,
      matrix,
      schemaPaths,
      hookEvents: HOOK_EVENTS,
      mode,
      batches: batches.length > 0 ? batches : undefined,
      envConsumers,
      specRegistry,
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
