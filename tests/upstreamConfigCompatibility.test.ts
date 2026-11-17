import { describe, expect, test } from 'bun:test'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  checkCompatibility,
  collectSchemaPaths,
  createInitialMatrix,
  runCli,
  type CompatibilityInventory,
  type CompatibilityMatrixEntry,
} from '../scripts/checkUpstreamConfigCompatibility.ts'

const syntheticSchema = {
  $defs: {
    sandbox: {
      anyOf: [
        { type: 'object', properties: { enabled: { type: 'boolean' } } },
        { type: 'null' },
      ],
    },
  },
  type: 'object',
  properties: {
    model: { type: 'string' },
    sandbox: { $ref: '#/$defs/sandbox' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
  },
}

const inventory: CompatibilityInventory = {
  baseline: { version: '2.1.311' },
  entries: [
    { id: 'setting:model', kind: 'setting', path: 'model', lifecycle: 'active' },
    { id: 'setting:sandbox.enabled', kind: 'setting', path: 'sandbox.enabled', lifecycle: 'active' },
    { id: 'setting:missingKey', kind: 'setting', path: 'missingKey', lifecycle: 'active' },
    { id: 'hook:Stop', kind: 'hook', path: 'Stop', lifecycle: 'active' },
    { id: 'hook:PostToolBatch', kind: 'hook', path: 'PostToolBatch', lifecycle: 'active' },
    { id: 'env:API_TIMEOUT_MS', kind: 'env', path: 'API_TIMEOUT_MS', lifecycle: 'active' },
  ],
}

const lifecycleInventory: CompatibilityInventory = {
  baseline: { version: '2.1.311' },
  entries: [
    {
      id: 'setting:futureKey', kind: 'setting', path: 'futureKey', lifecycle: 'active',
      introduced: '2.1.319', afterBaseline: true,
      excerpt: 'Requires Claude Code v2.1.319 or later.',
    },
    {
      id: 'setting:futureExisting', kind: 'setting', path: 'model', lifecycle: 'active',
      introduced: '2.1.319', afterBaseline: true,
      excerpt: 'Requires Claude Code v2.1.319 or later.',
    },
    {
      id: 'setting:oldKey', kind: 'setting', path: 'oldKey', lifecycle: 'deprecated',
      replacement: 'newKey',
      source: { url: 'https://example.test/settings', sha256: 'a'.repeat(64), anchor: '#oldkey' },
    },
    {
      id: 'setting:goneKey', kind: 'setting', path: 'goneKey', lifecycle: 'removed',
      source: { url: 'https://example.test/settings', sha256: 'a'.repeat(64), anchor: '#gonekey' },
    },
    {
      id: 'setting:legacySandbox', kind: 'setting', path: 'sandbox.enabled', lifecycle: 'deprecated',
      replacement: 'sandbox.enabled',
      source: { url: 'https://example.test/settings', sha256: 'a'.repeat(64), anchor: '#legacysandbox' },
    },
  ],
}

function syntheticMatrix() {
  return createInitialMatrix(inventory, collectSchemaPaths(syntheticSchema), ['Stop'])
}

function checkSynthetic(matrix: ReturnType<typeof syntheticMatrix>) {
  return checkCompatibility({
    inventory,
    matrix,
    schemaPaths: collectSchemaPaths(syntheticSchema),
    hookEvents: ['Stop'],
  })
}

function codes(matrix: ReturnType<typeof syntheticMatrix>) {
  return checkSynthetic(matrix).map(diagnostic => diagnostic.code)
}

function markAligned(entry: CompatibilityMatrixEntry) {
  entry.status = 'aligned'
  entry.implementation = ['src/utils/settings/types.ts']
  entry.tests = ['tests/upstreamConfigCompatibility.test.ts']
  for (const dimension of Object.values(entry.dimensions)) {
    dimension.status = 'aligned'
    dimension.evidence = 'tests/upstreamConfigCompatibility.test.ts'
  }
}

describe('schema path collection', () => {
  test('resolves local refs and unions without treating dynamic record keys as paths', () => {
    const schema = {
      ...syntheticSchema,
      properties: {
        ...syntheticSchema.properties,
        combined: {
          allOf: [{ properties: { fromAllOf: { type: 'string' } } }],
          oneOf: [{ properties: { fromOneOf: { type: 'string' } } }],
        },
      },
    }
    expect([...collectSchemaPaths(schema)].sort()).toEqual([
      'combined', 'combined.fromAllOf', 'combined.fromOneOf',
      'env', 'model', 'sandbox', 'sandbox.enabled',
    ])
  })

  test('decodes JSON pointer escapes and rejects external refs', () => {
    const schema = {
      $defs: { 'a/b~c': { properties: { leaf: { type: 'string' } } } },
      properties: { root: { $ref: '#/$defs/a~1b~0c' } },
    }
    expect([...collectSchemaPaths(schema)].sort()).toEqual(['root', 'root.leaf'])
    expect(() => collectSchemaPaths({
      properties: { root: { $ref: 'https://example.test/schema.json' } },
    })).toThrow('external schema reference')
    expect(() => collectSchemaPaths({
      properties: { root: { $ref: 'other.json#/$defs/root' } },
    })).toThrow('external schema reference')
  })

  test('stops circular refs but allows the same definition in sibling branches', () => {
    const schema = {
      $defs: {
        shared: { properties: { leaf: { type: 'string' } } },
        node: {
          properties: {
            value: { type: 'string' },
            next: { $ref: '#/$defs/node' },
          },
        },
      },
      properties: {
        left: { $ref: '#/$defs/shared' },
        right: { $ref: '#/$defs/shared' },
        tree: { $ref: '#/$defs/node' },
      },
    }
    expect([...collectSchemaPaths(schema)].sort()).toEqual([
      'left', 'left.leaf', 'right', 'right.leaf',
      'tree', 'tree.next', 'tree.value',
    ])
  })
})

describe('matrix initialization', () => {
  test('initializes every entry once with six missing dimensions and exact exclusions', () => {
    const matrix = syntheticMatrix()
    expect(matrix.entries.map(entry => entry.id)).toEqual(inventory.entries.map(entry => entry.id))
    expect(new Set(matrix.entries.map(entry => entry.id)).size).toBe(inventory.entries.length)
    for (const entry of matrix.entries) {
      expect(Object.keys(entry.dimensions).sort()).toEqual([
        'default', 'path', 'precedence', 'runtime', 'source', 'type',
      ])
      expect(entry.implementation).toEqual([])
      expect(entry.tests).toEqual([])
      expect(entry.evidence).toEqual([])
      expect(entry.exclusion).toBeNull()
    }
    expect(matrix.entries.find(entry => entry.id === 'setting:model')).toMatchObject({
      status: 'partial',
      dimensions: { path: { status: 'aligned', evidence: 'generated schema diff' } },
    })
    expect(matrix.entries.find(entry => entry.id === 'hook:Stop')).toMatchObject({
      status: 'partial', dimensions: { path: { status: 'aligned', evidence: 'HOOK_EVENTS' } },
    })
    expect(matrix.entries.find(entry => entry.id === 'setting:missingKey')?.status).toBe('missing')
    expect(matrix.entries.find(entry => entry.id === 'hook:PostToolBatch')?.status).toBe('missing')
    expect(matrix.entries.find(entry => entry.id === 'env:API_TIMEOUT_MS')?.status).toBe('missing')
    expect(matrix.schemaExclusions.map(entry => entry.path)).toEqual(['env', 'sandbox'])
    expect(matrix.schemaExclusions.every(entry =>
      !entry.path.includes('*') &&
      entry.reason === 'flash-only or legacy schema path; review ownership in B2-B5' &&
      entry.evidence === 'src/utils/settings/types.ts'
    )).toBe(true)
  })

  test('refuses to synthesize evidence when an after-baseline Requires statement is incomplete', () => {
    const incompleteInventory: CompatibilityInventory = {
      ...lifecycleInventory,
      entries: lifecycleInventory.entries.map(entry =>
        entry.id === 'setting:futureKey'
          ? { ...entry, excerpt: 'Future setting | Requires C' }
          : entry
      ),
    }
    expect(() => createInitialMatrix(
      incompleteInventory,
      collectSchemaPaths(syntheticSchema),
      ['Stop'],
    )).toThrow('complete Requires statement')
  })

  test('records after-baseline, deprecated and removed lifecycle states honestly', () => {
    const matrix = createInitialMatrix(
      lifecycleInventory,
      collectSchemaPaths(syntheticSchema),
      ['Stop'],
    )
    const future = matrix.entries.find(entry => entry.id === 'setting:futureKey')!
    expect(future.status).toBe('blocked')
    expect(future.dimensions.runtime).toEqual({
      status: 'blocked', evidence: 'Requires Claude Code v2.1.319 or later.',
    })
    expect(future.notes).toContain('2.1.319')
    const futureExisting = matrix.entries.find(entry => entry.id === 'setting:futureExisting')!
    expect(futureExisting.status).toBe('blocked')
    expect(futureExisting.dimensions.path.status).toBe('aligned')
    expect(futureExisting.dimensions.runtime.status).toBe('blocked')
    expect(matrix.entries.find(entry => entry.id === 'setting:oldKey')).toMatchObject({
      status: 'excluded',
      exclusion: {
        lifecycle: 'deprecated', replacement: 'newKey', sourceAnchor: '#oldkey',
      },
    })
    expect(matrix.entries.find(entry => entry.id === 'setting:goneKey')).toMatchObject({
      status: 'excluded', exclusion: { lifecycle: 'removed', sourceAnchor: '#gonekey' },
    })
    expect(matrix.entries.find(entry => entry.id === 'setting:legacySandbox')).toMatchObject({
      status: 'partial', dimensions: { path: { status: 'aligned' } }, exclusion: null,
    })
  })
})

describe('compatibility diagnostics', () => {
  test('recorded missing work is non-fatal and checking never adds exclusions', () => {
    const matrix = syntheticMatrix()
    const before = structuredClone(matrix)
    expect(checkSynthetic(matrix)).toEqual([])
    expect(matrix).toEqual(before)
  })

  test('rejects an incompatible or missing matrix envelope', () => {
    const wrongSchemaVersion = syntheticMatrix()
    Reflect.set(wrongSchemaVersion, 'schemaVersion', 2)
    const schemaDiagnostics = checkSynthetic(wrongSchemaVersion)
    expect(schemaDiagnostics.map(diagnostic => diagnostic.code)).toContain(
      'invalid-matrix-envelope',
    )
    expect(schemaDiagnostics.find(diagnostic =>
      diagnostic.code === 'invalid-matrix-envelope'
    )?.message).toContain('schemaVersion')

    const wrongBaseline = syntheticMatrix()
    wrongBaseline.baseline = '2.1.310'
    const baselineDiagnostics = checkSynthetic(wrongBaseline)
    expect(baselineDiagnostics.map(diagnostic => diagnostic.code)).toContain(
      'invalid-matrix-envelope',
    )
    expect(baselineDiagnostics.find(diagnostic =>
      diagnostic.code === 'invalid-matrix-envelope'
    )?.message).toContain('2.1.311')

    const missingEnvelope = syntheticMatrix()
    Reflect.deleteProperty(missingEnvelope, 'schemaVersion')
    Reflect.deleteProperty(missingEnvelope, 'baseline')
    expect(checkSynthetic(missingEnvelope).map(diagnostic => diagnostic.code)).toContain(
      'invalid-matrix-envelope',
    )
  })

  test('rejects a false path claim and false total aligned evidence', () => {
    const matrix = syntheticMatrix()
    const missing = matrix.entries.find(entry => entry.id === 'setting:missingKey')!
    missing.status = 'aligned'
    missing.dimensions.path = { status: 'aligned', evidence: 'false-claim' }
    const diagnosticCodes = codes(matrix)
    expect(diagnosticCodes).toContain('missing-in-flash')
    expect(diagnosticCodes).toContain('invalid-aligned-evidence')
  })

  test('allows a truthful path dimension when total work remains partial', () => {
    const matrix = syntheticMatrix()
    expect(codes(matrix)).not.toContain('missing-in-flash')
    const missing = matrix.entries.find(entry => entry.id === 'setting:missingKey')!
    missing.dimensions.path = { status: 'aligned', evidence: 'false-claim' }
    expect(codes(matrix)).toContain('missing-in-flash')
  })

  test('rejects duplicate, missing and stale matrix IDs', () => {
    const duplicate = syntheticMatrix()
    duplicate.entries.push(structuredClone(duplicate.entries[0]!))
    expect(codes(duplicate)).toContain('duplicate-matrix-entry')

    const matrix = syntheticMatrix()
    matrix.entries = matrix.entries.filter(entry => entry.id !== 'setting:model')
    matrix.entries.push({ ...structuredClone(matrix.entries[0]!), id: 'setting:stale' })
    const diagnosticCodes = codes(matrix)
    expect(diagnosticCodes).toContain('missing-matrix-entry')
    expect(diagnosticCodes).toContain('stale-matrix-entry')
  })

  test('rejects undocumented schema keys, wildcard exclusions and hook drift', () => {
    const matrix = syntheticMatrix()
    matrix.schemaExclusions = [{ path: '*', reason: 'broad', evidence: 'test' }]
    const diagnosticCodes = codes(matrix)
    expect(diagnosticCodes).toContain('undocumented-schema-key')
    expect(diagnosticCodes).toContain('invalid-schema-exclusion')

    const hookDrift = checkCompatibility({
      inventory,
      matrix: syntheticMatrix(),
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: ['Stop', 'LocalOnlyEvent'],
    })
    expect(hookDrift.map(diagnostic => diagnostic.code)).toContain('undocumented-hook-event')
  })

  test('requires string arrays and dimension evidence strings even when not aligned', () => {
    expect(codes(syntheticMatrix())).toEqual([])

    const missingImplementation = syntheticMatrix()
    Reflect.deleteProperty(missingImplementation.entries[0]!, 'implementation')
    expect(codes(missingImplementation)).toContain('invalid-matrix-structure')

    const missingDimensionEvidence = syntheticMatrix()
    Reflect.deleteProperty(missingDimensionEvidence.entries[0]!.dimensions.type, 'evidence')
    expect(codes(missingDimensionEvidence)).toContain('invalid-matrix-structure')

    for (const field of ['implementation', 'tests', 'evidence'] as const) {
      const wrongArrayElement = syntheticMatrix()
      Reflect.set(wrongArrayElement.entries[0]!, field, ['valid-path', 42])
      expect(codes(wrongArrayElement)).toContain('invalid-matrix-structure')
    }

    const missingNotes = syntheticMatrix()
    Reflect.deleteProperty(missingNotes.entries[0]!, 'notes')
    expect(codes(missingNotes)).toContain('invalid-matrix-structure')
  })

  test('rejects invalid total and dimension statuses', () => {
    const matrix = syntheticMatrix()
    Reflect.set(matrix.entries[0]!, 'status', 'complete')
    Reflect.set(matrix.entries[1]!.dimensions.path, 'status', 'complete')
    expect(codes(matrix).filter(code => code === 'invalid-matrix-status')).toHaveLength(2)
  })

  test('enforces implementation, tests and all six evidence dimensions for aligned', () => {
    const valid = syntheticMatrix()
    markAligned(valid.entries.find(entry => entry.id === 'setting:model')!)
    expect(codes(valid)).not.toContain('invalid-aligned-evidence')

    const invalidate = (entry: CompatibilityMatrixEntry, caseName: string) => {
      if (caseName === 'implementation') entry.implementation = []
      if (caseName === 'tests') entry.tests = []
      if (caseName === 'dimension status') entry.dimensions.runtime.status = 'partial'
      if (caseName === 'dimension evidence') entry.dimensions.default.evidence = ''
    }
    for (const caseName of ['implementation', 'tests', 'dimension status', 'dimension evidence']) {
      const matrix = syntheticMatrix()
      const entry = matrix.entries.find(candidate => candidate.id === 'setting:model')!
      markAligned(entry)
      invalidate(entry, caseName)
      expect(codes(matrix)).toContain('invalid-aligned-evidence')
    }
  })

  test('requires notes and evidence for different and reason/evidence for excluded', () => {
    const different = syntheticMatrix()
    const missing = different.entries.find(entry => entry.id === 'setting:missingKey')!
    missing.status = 'different'
    missing.notes = 'Intentional flash difference'
    missing.evidence = ['docs/superpowers/specs/example.md']
    expect(codes(different)).not.toContain('invalid-different-evidence')
    missing.notes = ''
    expect(codes(different)).toContain('invalid-different-evidence')
    missing.notes = 'Intentional flash difference'
    missing.evidence = []
    expect(codes(different)).toContain('invalid-different-evidence')

    const excluded = createInitialMatrix(
      lifecycleInventory,
      collectSchemaPaths(syntheticSchema),
      ['Stop'],
    )
    const oldKey = excluded.entries.find(entry => entry.id === 'setting:oldKey')!
    expect(oldKey.exclusion).not.toBeNull()
    oldKey.exclusion!.reason = ''
    expect(checkCompatibility({
      inventory: lifecycleInventory,
      matrix: excluded,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: ['Stop'],
    }).map(diagnostic => diagnostic.code)).toContain('invalid-exclusion-evidence')
  })

  test('rejects after-baseline runtime or total claims other than blocked', () => {
    const matrix = createInitialMatrix(
      lifecycleInventory,
      collectSchemaPaths(syntheticSchema),
      ['Stop'],
    )
    const future = matrix.entries.find(entry => entry.id === 'setting:futureExisting')!
    future.dimensions.runtime.status = 'aligned'
    expect(checkCompatibility({
      inventory: lifecycleInventory, matrix,
      schemaPaths: collectSchemaPaths(syntheticSchema), hookEvents: ['Stop'],
    }).map(diagnostic => diagnostic.code)).toContain('invalid-after-baseline')
    future.dimensions.runtime.status = 'blocked'
    future.status = 'partial'
    expect(checkCompatibility({
      inventory: lifecycleInventory, matrix,
      schemaPaths: collectSchemaPaths(syntheticSchema), hookEvents: ['Stop'],
    }).map(diagnostic => diagnostic.code)).toContain('invalid-after-baseline')
  })
})

describe('compatibility CLI and real baseline', () => {
  test('uses a writable initializer but keeps default and failure paths read-only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flash-compatibility-'))
    try {
      const fixture = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
      await copyFile(new URL('inventory.json', fixture), join(directory, 'inventory.json'))
      expect(await runCli(['--initialize-matrix'], directory)).toEqual([])
      const matrixPath = join(directory, 'compatibility.yaml')
      const initialized = await readFile(matrixPath, 'utf8')
      expect(await runCli([], directory)).toEqual([])
      expect(await readFile(matrixPath, 'utf8')).toBe(initialized)
      await expect(runCli(['--initialize-matrix'], directory)).rejects.toThrow('refusing to overwrite')
      await expect(runCli(['--unknown'], directory)).rejects.toThrow('unknown argument')
      expect(await readFile(matrixPath, 'utf8')).toBe(initialized)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('real 2.1.311 baseline has no unrecorded drift', async () => {
    const root = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
    const realInventory = JSON.parse(await readFile(new URL('inventory.json', root), 'utf8'))
    const matrix = parse(await readFile(new URL('compatibility.yaml', root), 'utf8'))
    const { generateSettingsJSONSchema } = await import('../src/utils/settings/schemaOutput.ts')
    const { HOOK_EVENTS } = await import('../src/entrypoints/sdk/coreTypes.ts')
    const diagnostics = checkCompatibility({
      inventory: realInventory,
      matrix,
      schemaPaths: collectSchemaPaths(JSON.parse(generateSettingsJSONSchema())),
      hookEvents: HOOK_EVENTS,
    })
    expect(diagnostics).toEqual([])
    expect(realInventory.entries.filter((entry: { kind: string }) => entry.kind === 'hook')).toHaveLength(33)
    const expectedRequires: Record<string, string> = {
      'setting:permissions.blockWritesOutsideWorkingDirectories': 'Requires Claude Code v2.1.314 or later.',
      'setting:permissions.denyInsteadOfPrompting': 'Requires Claude Code v2.1.319 or later.',
      'env:CLAUDE_CODE_AUTOMOUNT_ROOTS': 'Requires Claude Code v2.1.323 or later',
      'env:CLAUDE_CODE_CONFIG_LOCK_WAIT_MS': 'Requires Claude Code v2.1.318 or later',
      'env:CLAUDE_CODE_DISABLE_FEATURE_FLAGS': 'Requires Claude Code v2.1.319 or later.',
      'env:CLAUDE_CODE_DISABLE_ULTRATHINK': 'Requires Claude Code v2.1.316 or later',
      'env:CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL': 'Requires Claude Code v2.1.319 or later',
      'env:CLAUDE_CODE_RESUME_HINT_COMMAND': 'Requires Claude Code v2.1.323 or later',
    }
    const laterEntries = realInventory.entries.filter((entry: { afterBaseline?: boolean }) => entry.afterBaseline)
    expect(laterEntries).toHaveLength(8)
    for (const inventoryEntry of laterEntries) {
      const entry = matrix.entries.find((candidate: { id: string }) => candidate.id === inventoryEntry.id)
      expect(entry.dimensions.runtime).toEqual({
        status: 'blocked',
        evidence: expectedRequires[inventoryEntry.id],
      })
    }
    for (const id of [
      'UserPromptExpansion', 'PostToolBatch', 'MessageDisplay',
      'DirectoryAdded', 'PreModelSwitch', 'PostModelSwitch',
    ]) {
      const entry = matrix.entries.find((candidate: { id: string }) => candidate.id === `hook:${id}`)
      expect(entry.dimensions.runtime.status).not.toBe('aligned')
    }
  })
})
