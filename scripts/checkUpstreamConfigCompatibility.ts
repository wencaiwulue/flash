import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import {
  completeRequiresStatement,
  UPSTREAM_BASELINE_VERSION,
} from './upstreamConfigInventory.ts'

export const COMPATIBILITY_STATUSES = [
  'aligned',
  'partial',
  'missing',
  'different',
  'blocked',
  'excluded',
] as const

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

function printReport(inventory: CompatibilityInventory, matrix: CompatibilityMatrix, diagnostics: Diagnostic[]) {
  const matrixEntries = Array.isArray(matrix.entries)
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
  console.log(`diagnostics: ${diagnostics.length}`)
  for (const diagnostic of diagnostics) {
    console.error(`[${diagnostic.code}] ${diagnostic.id ?? diagnostic.path ?? ''}: ${diagnostic.message}`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function runCli(
  arguments_: readonly string[],
  fixtureDirectory = DEFAULT_FIXTURE_DIRECTORY,
): Promise<Diagnostic[]> {
  if (arguments_.length > 1 || (
    arguments_.length === 1 && arguments_[0] !== '--initialize-matrix'
  )) {
    throw new Error(`unknown argument: ${arguments_.join(' ')}`)
  }
  const initialize = arguments_[0] === '--initialize-matrix'
  const inventoryPath = join(fixtureDirectory, 'inventory.json')
  const matrixPath = join(fixtureDirectory, 'compatibility.yaml')
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as CompatibilityInventory
  const [{ generateSettingsJSONSchema }, { HOOK_EVENTS }] = await Promise.all([
    import('../src/utils/settings/schemaOutput.ts'),
    import('../src/entrypoints/sdk/coreTypes.ts'),
  ])
  const schemaPaths = collectSchemaPaths(JSON.parse(generateSettingsJSONSchema()))

  let matrix: CompatibilityMatrix
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
    matrix = parse(await readFile(matrixPath, 'utf8')) as CompatibilityMatrix
  }

  const diagnostics = checkCompatibility({ inventory, matrix, schemaPaths, hookEvents: HOOK_EVENTS })
  printReport(inventory, matrix, diagnostics)
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
