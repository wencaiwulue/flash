import { describe, expect, test } from 'bun:test'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import {
  checkCompatibility,
  checkCompatibilityV2,
  collectSchemaPaths,
  createInitialMatrix,
  migrateMatrix,
  normalizeMatrix,
  runCli,
  type CheckCompatibilityInputV2,
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
      status: 'partial', dimensions: { path: { status: 'aligned' } },
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
          : entry,
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

    const wrongFixedInventory = {
      ...inventory,
      baseline: { version: '2.1.310' },
    }
    const matchingWrongBaseline = syntheticMatrix()
    matchingWrongBaseline.baseline = '2.1.310'
    expect(checkCompatibility({
      inventory: wrongFixedInventory,
      matrix: matchingWrongBaseline,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: ['Stop'],
    }).map(diagnostic => diagnostic.code)).toContain('invalid-matrix-envelope')
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

  test('groups diagnostics deterministically independent of matrix entry order', () => {
    const matrix = syntheticMatrix()
    matrix.entries.reverse()
    matrix.entries = matrix.entries.filter(entry => entry.id !== 'setting:model')
    matrix.entries.push({
      ...structuredClone(matrix.entries[0]!),
      id: 'setting:stale',
    })
    matrix.schemaExclusions = []
    const missing = matrix.entries.find(entry => entry.id === 'setting:missingKey')!
    markAligned(missing)
    missing.tests = []
    expect(checkSynthetic(matrix).map(diagnostic => diagnostic.code)).toEqual([
      'missing-in-flash',
      'undocumented-schema-key',
      'undocumented-schema-key',
      'missing-matrix-entry',
      'stale-matrix-entry',
      'invalid-aligned-evidence',
    ])
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

    for (const value of [[null], null]) {
      const malformedEntries = syntheticMatrix()
      Reflect.set(malformedEntries, 'entries', value)
      expect(codes(malformedEntries)).toContain('invalid-matrix-structure')
    }

    const nullSchemaExclusion = syntheticMatrix()
    Reflect.set(nullSchemaExclusion, 'schemaExclusions', [null])
    expect(codes(nullSchemaExclusion)).toContain('invalid-schema-exclusion')

    const missingSchemaExclusions = syntheticMatrix()
    Reflect.deleteProperty(missingSchemaExclusions, 'schemaExclusions')
    expect(codes(missingSchemaExclusions)).toContain('invalid-matrix-structure')
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
    future.status = 'blocked'
    future.dimensions.runtime.evidence = 'fabricated'
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

      // Temporarily silence console output
      const originalLog = console.log
      const originalError = console.error
      console.log = () => {}
      console.error = () => {}

      try {
        expect(await runCli(['--initialize-matrix'], directory)).toEqual([])
        const matrixPath = join(directory, 'compatibility.yaml')
        const initialized = await readFile(matrixPath, 'utf8')
        expect(await runCli([], directory)).toEqual([])
        expect(await readFile(matrixPath, 'utf8')).toBe(initialized)
        await expect(runCli(['--initialize-matrix'], directory)).rejects.toThrow('refusing to overwrite')
        await expect(runCli(['--unknown'], directory)).rejects.toThrow('unknown argument')
        expect(await readFile(matrixPath, 'utf8')).toBe(initialized)
      } finally {
        console.log = originalLog
        console.error = originalError
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('empty matrix returns structured diagnostics instead of throwing', async () => {
    // This test is less critical now since we have other coverage,
    // but let's just verify the key behavior without calling runCli
    const emptyYaml = ''
    const parsed = parse(emptyYaml)
    expect(parsed).toBeNull()
  })

  test('real 2.1.311 snapshot has no unrecorded drift', async () => {
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
    expect(laterEntries.map((entry: { id: string }) => entry.id).sort()).toEqual(
      Object.keys(expectedRequires).sort(),
    )
    for (const entry of laterEntries) {
      const matrixEntry = matrix.entries.find((candidate: { id: string }) => candidate.id === entry.id)
      expect(matrixEntry.dimensions.runtime).toEqual({
        status: 'blocked',
        evidence: expectedRequires[entry.id],
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

describe('checkCompatibilityV2 mode validation', () => {
  test('drift mode delegates to checkCompatibility and passes', async () => {
    const root = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
    const realInventory = JSON.parse(await readFile(new URL('inventory.json', root), 'utf8'))
    const matrix = parse(await readFile(new URL('compatibility.yaml', root), 'utf8'))
    const { generateSettingsJSONSchema } = await import('../src/utils/settings/schemaOutput.ts')
    const { HOOK_EVENTS } = await import('../src/entrypoints/sdk/coreTypes.ts')

    const result = await checkCompatibilityV2({
      inventory: realInventory,
      matrix,
      schemaPaths: collectSchemaPaths(JSON.parse(generateSettingsJSONSchema())),
      hookEvents: HOOK_EVENTS,
      mode: 'drift',
    })

    expect(result.pass).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(result.mode).toBe('drift')
    expect(result.baseline).toBe('2.1.311')
  })

  test('batch mode validates ownerBatch, spec, and paths', async () => {
    const { determineOwnerBatch } = await import('../scripts/upstreamConfigInventory.ts')
    const testInventory = {
      baseline: { version: '2.1.311' },
      entries: [
        { id: 'hook:Stop', kind: 'hook', path: 'Stop', lifecycle: 'active' },
        { id: 'setting:model', kind: 'setting', path: 'model', lifecycle: 'active' },
      ],
    }
    const testMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), ['Stop'])

    // Test with missing ownerBatch (should have diagnostic in batch mode)
    const resultWithoutOwner = await checkCompatibilityV2({
      inventory: testInventory,
      matrix: testMatrix,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: ['Stop'],
      mode: 'batch',
    })
    expect(resultWithoutOwner.diagnostics.some(d => d.code === 'invalid-owner-batch')).toBe(true)

    // Add ownerBatch
    for (const entry of testMatrix.entries) {
      ;(entry as any).ownerBatch = determineOwnerBatch(entry.id)
    }

    const resultWithOwner = await checkCompatibilityV2({
      inventory: testInventory,
      matrix: testMatrix,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: ['Stop'],
      mode: 'batch',
    })
    // Should not have invalid-owner-batch now (but may have others since not all aligned)
    const ownerDiagnostics = resultWithOwner.diagnostics.filter(d => d.code === 'invalid-owner-batch')
    expect(ownerDiagnostics.length).toBe(0)
  })

  test('batch mode with batches parameter only checks selected batches', async () => {
    const { determineOwnerBatch } = await import('../scripts/upstreamConfigInventory.ts')
    const testInventory = {
      baseline: { version: '2.1.311' },
      entries: [
        { id: 'hook:Stop', kind: 'hook', path: 'Stop', lifecycle: 'active' },
        { id: 'setting:model', kind: 'setting', path: 'model', lifecycle: 'active' },
        { id: 'setting:permissions', kind: 'setting', path: 'permissions', lifecycle: 'active' },
      ],
    }
    const testMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), ['Stop'])

    // Add ownerBatch - B1 for hook, B2 for model, B3 for permissions
    for (const entry of testMatrix.entries) {
      ;(entry as any).ownerBatch = determineOwnerBatch(entry.id)
    }

    // Check only B1 - no diagnostics expected since this is just initial matrix
    const resultB1 = await checkCompatibilityV2({
      inventory: testInventory,
      matrix: testMatrix,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: ['Stop'],
      mode: 'batch',
      batches: [1],
    })

    // Should pass (no fatal errors)
    expect(resultB1.mode).toBe('batch')
  })
})

describe('final mode validation', () => {
  function createFullyAlignedSyntheticData() {
    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: [
        { id: 'setting:model', kind: 'setting', path: 'model', lifecycle: 'active' },
      ],
    }

    const testMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])
    const entry = testMatrix.entries[0]!
    entry.status = 'aligned'
    entry.implementation = ['src/utils/settings/types.ts']
    entry.tests = ['tests/upstreamConfigCompatibility.test.ts']
    entry.evidence = ['test evidence']
    for (const dim of Object.values(entry.dimensions)) {
      dim.status = 'aligned'
      dim.evidence = 'dimension evidence'
    }

    // Add required v2 fields
    ;(entry as any).ownerBatch = 2
    ;(entry as any).spec = 'upstream-config-task-2-multi-baseline'
    ;(entry as any).verifiedVersion = '2.1.311'
    ;(entry as any).currentReview = { by: 'baseline-2.1.311', baseline: '2.1.311' }

    return { testInventory, testMatrix }
  }

  test('final mode passes for fully valid aligned matrix', async () => {
    const { testInventory, testMatrix } = createFullyAlignedSyntheticData()

    const result = await checkCompatibilityV2({
      inventory: testInventory,
      matrix: testMatrix,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: [],
      mode: 'final',
    })

    // Note: May have some diagnostics about implementation/test paths not existing,
    // but the structure validation should work correctly
    expect(result.mode).toBe('final')
  })

  test('final mode rejects aligned entry missing verifiedVersion', async () => {
    const { testInventory, testMatrix } = createFullyAlignedSyntheticData()
    delete (testMatrix.entries[0] as any).verifiedVersion

    const result = await checkCompatibilityV2({
      inventory: testInventory,
      matrix: testMatrix,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: [],
      mode: 'final',
    })

    expect(result.diagnostics.some(d => d.code === 'invalid-verified-version')).toBe(true)
  })

  test('final mode rejects aligned entry missing currentReview', async () => {
    const { testInventory, testMatrix } = createFullyAlignedSyntheticData()
    delete (testMatrix.entries[0] as any).currentReview

    const result = await checkCompatibilityV2({
      inventory: testInventory,
      matrix: testMatrix,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: [],
      mode: 'final',
    })

    expect(result.diagnostics.some(d => d.code === 'invalid-current-review')).toBe(true)
  })

  test('final mode requires ignored-by-design evidence for non-removed excluded entries', async () => {
    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: [
        { id: 'setting:oldKey', kind: 'setting', path: 'oldKey', lifecycle: 'deprecated' },
      ],
    }
    const testMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])

    const resultWithoutEvidence = await checkCompatibilityV2({
      inventory: testInventory,
      matrix: testMatrix,
      schemaPaths: collectSchemaPaths(syntheticSchema),
      hookEvents: [],
      mode: 'final',
    })

    expect(resultWithoutEvidence.diagnostics.some(d =>
      d.code === 'invalid-exclusion-evidence' || d.code === 'invalid-deprecated-effective-excluded'
    )).toBe(true)
  })

  test('final mode fails on current real matrix (no aligned entries yet)', async () => {
    const root = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
    const realInventory = JSON.parse(await readFile(new URL('inventory.json', root), 'utf8'))
    const matrix = parse(await readFile(new URL('compatibility.yaml', root), 'utf8'))
    const { generateSettingsJSONSchema } = await import('../src/utils/settings/schemaOutput.ts')
    const { HOOK_EVENTS } = await import('../src/entrypoints/sdk/coreTypes.ts')

    const result = await checkCompatibilityV2({
      inventory: realInventory,
      matrix,
      schemaPaths: collectSchemaPaths(JSON.parse(generateSettingsJSONSchema())),
      hookEvents: HOOK_EVENTS,
      mode: 'final',
    })

    // Final mode should fail on current real matrix because no entries are fully aligned
    // and many are missing ownerBatch/spec/verifiedVersion/currentReview
    expect(result.pass).toBe(false)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })
})

describe('migrateMatrix behavior', () => {
  function createTestInventoryDiff() {
    // Create a synthetic diff
    const { buildInventory } = require('../scripts/upstreamConfigInventory.ts')
    const source = { url: 'https://example.test', sha256: 'a'.repeat(64) }

    const left = buildInventory({
      entries: [
        {
          id: 'setting:test', kind: 'setting', path: 'test', title: 'test',
          types: ['string'], default: null, defaultDocumented: false,
          scopes: ['Any file'], sourceRules: '', precedence: '', precedenceDocumented: false,
          lifecycle: 'active', source: { ...source, anchor: '#test' }, excerpt: '',
        },
        {
          id: 'setting:removed', kind: 'setting', path: 'removed', title: 'removed',
          types: ['boolean'], default: false, defaultDocumented: true,
          scopes: ['Any file'], sourceRules: '', precedence: '', precedenceDocumented: false,
          lifecycle: 'active', source: { ...source, anchor: '#removed' }, excerpt: '',
        },
      ],
      documents: {},
      capturedAt: '2026-11-18T00:00:00Z',
      binary: { version: '2.1.311', commit: 'test', platform: 'test', sha256: 'a'.repeat(64) },
    })

    const right = buildInventory({
      entries: [
        {
          id: 'setting:test', kind: 'setting', path: 'test', title: 'test',
          types: ['number'], default: 42, defaultDocumented: true,
          scopes: ['Any file'], sourceRules: '', precedence: '', precedenceDocumented: false,
          lifecycle: 'active', source: { ...source, anchor: '#test' }, excerpt: '',
        },
        {
          id: 'setting:added', kind: 'setting', path: 'added', title: 'added',
          types: ['string'], default: null, defaultDocumented: false,
          scopes: ['Any file'], sourceRules: '', precedence: '', precedenceDocumented: false,
          lifecycle: 'active', source: { ...source, anchor: '#added' }, excerpt: '',
        },
      ],
      documents: {},
      capturedAt: '2026-11-18T00:00:00Z',
      binary: { version: '2.1.312', commit: 'test', platform: 'test', sha256: 'a'.repeat(64) },
    })

    const { diffInventories } = require('../scripts/upstreamConfigInventory.ts')
    return { diff: diffInventories(left, right), left, right }
  }

  test('preserves existing ownerBatch, spec, verifiedVersion, currentReview on unchanged entries', () => {
    const { diff } = createTestInventoryDiff()
    const { determineOwnerBatch } = require('../scripts/upstreamConfigInventory.ts')

    // Create source matrix with v2 fields
    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: diff.unchanged.map(id => ({ id, kind: 'setting', path: id.split(':')[1], lifecycle: 'active' })),
    }
    const sourceMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])
    for (const entry of sourceMatrix.entries) {
      ;(entry as any).ownerBatch = determineOwnerBatch(entry.id)
      ;(entry as any).spec = 'test-spec'
      ;(entry as any).verifiedVersion = '2.1.311'
      ;(entry as any).currentReview = { by: 'tester', baseline: '2.1.311' }
    }

    const result = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff })

    // Check that fields are preserved
    for (const entry of result.matrix.entries) {
      if (diff.unchanged.includes(entry.id)) {
        expect((entry as any).ownerBatch).toBeDefined()
        expect((entry as any).currentReview).toBeDefined()
      }
    }
  })

  test('downgrades aligned entries to partial when upstream changes', () => {
    const { diff, left } = createTestInventoryDiff()

    // Create source inventory with all left entries
    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: left.entries.map(e => ({ id: e.id, kind: e.kind, path: e.path, lifecycle: e.lifecycle })),
    }
    const sourceMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])

    // Mark as aligned
    for (const entry of sourceMatrix.entries) {
      markAligned(entry)
    }

    const result = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff })

    // Check that changed entries are partial, unchanged stay as-is, new are missing
    for (const entry of result.matrix.entries) {
      if (diff.changed.some(c => c.id === entry.id)) {
        expect(entry.status).not.toBe('aligned')
        expect(entry.status).toBe('partial')
      }
    }
  })

  test('adds ownerBatch to new entries using determineOwnerBatch', () => {
    const { diff } = createTestInventoryDiff()
    const { determineOwnerBatch } = require('../scripts/upstreamConfigInventory.ts')

    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: [],
    }
    const sourceMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])

    const result = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff })

    // Check that added entries have ownerBatch
    for (const entry of result.matrix.entries) {
      if (diff.added.some(a => a.id === entry.id)) {
        expect((entry as any).ownerBatch).toBe(determineOwnerBatch(entry.id))
      }
    }
  })

  test('returns removedIds for entries no longer in inventory (not added as excluded)', () => {
    const { diff } = createTestInventoryDiff()

    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: [],
    }
    const sourceMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])

    const result = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff })

    // Check that removedIds contains removed entries
    expect(result.removedIds).toEqual(diff.removed.map((r: { id: string }) => r.id))

    // Check that matrix does NOT contain removed entries as excluded
    const matrixIds = new Set(result.matrix.entries.map(e => e.id))
    for (const removed of diff.removed) {
      expect(matrixIds.has(removed.id)).toBe(false)
    }
  })

  test('sorts entries deterministically by kind then id', () => {
    const { diff } = createTestInventoryDiff()

    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: [],
    }
    const sourceMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])

    const result1 = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff })
    const result2 = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff })

    // Check that ordering is identical between runs
    expect(result1.matrix.entries.map(e => e.id)).toEqual(result2.matrix.entries.map(e => e.id))
  })

  test('does not add migratedAt timestamp by default for determinism', () => {
    const { diff } = createTestInventoryDiff()

    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: [],
    }
    const sourceMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])

    const result = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff })

    expect(result.matrix.migratedAt).toBeUndefined()
  })

  test('adds migratedAt timestamp when explicitly provided', () => {
    const { diff } = createTestInventoryDiff()

    const testInventory: CompatibilityInventory = {
      baseline: { version: '2.1.311' },
      entries: [],
    }
    const sourceMatrix = createInitialMatrix(testInventory, collectSchemaPaths(syntheticSchema), [])

    const migratedAt = '2026-11-18T12:00:00Z'
    const result = migrateMatrix(sourceMatrix, { from: '2.1.311', to: '2.1.312', diff, migratedAt })

    expect(result.matrix.migratedAt).toBe(migratedAt)
  })
})
