import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'fs/promises'
import * as path from 'path'
import {
  createLSPServerInstance,
} from '../src/services/lsp/LSPServerInstance.js'
import type { ScopedLspServerConfig } from '../src/services/lsp/types.js'
import {
  registerPendingLSPDiagnostic,
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
  resetAllLSPDiagnosticState,
  clearDeliveredDiagnosticsForFile,
  getPendingLSPDiagnosticCount,
} from '../src/services/lsp/LSPDiagnosticRegistry.js'
import {
  formatDiagnosticsForAttachment,
} from '../src/services/lsp/passiveFeedback.js'
import { sleep } from '../src/utils/sleep.js'

const TEST_WORKSPACE = path.resolve(import.meta.dir, 'temp-lsp-test')
const instances: ReturnType<typeof createLSPServerInstance>[] = []

function config(overrides: Partial<ScopedLspServerConfig> = {}): ScopedLspServerConfig {
  return {
    command: process.execPath,
    args: [path.resolve(import.meta.dir, 'fixtures/fake-lsp-server.ts')],
    extensionToLanguage: { '.ts': 'typescript', '.js': 'javascript' },
    scope: 'dynamic',
    source: 'test',
    ...overrides,
  }
}

function create(overrides?: Partial<ScopedLspServerConfig>) {
  const instance = createLSPServerInstance('fake-lsp', config(overrides))
  instances.push(instance)
  return instance
}

async function waitForState(
  instance: ReturnType<typeof createLSPServerInstance>,
  targetState: 'running' | 'stopped' | 'error',
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now()
  while (instance.state !== targetState) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timeout waiting for state ${targetState}, current: ${instance.state}`)
    }
    await sleep(20)
  }
}

async function setupTestWorkspace() {
  await mkdir(TEST_WORKSPACE, { recursive: true })
  await writeFile(
    path.join(TEST_WORKSPACE, 'test.ts'),
    `function hello() {
  return "world";
}

const x = hello();
`,
  )
  await writeFile(path.join(TEST_WORKSPACE, '.gitignore'), 'node_modules/\ndist/\n')
  await mkdir(path.join(TEST_WORKSPACE, 'node_modules'), { recursive: true })
  await writeFile(
    path.join(TEST_WORKSPACE, 'node_modules', 'dependency.ts'),
    'export function ignored() {}',
  )
}

describe('LSP', () => {
  afterEach(async () => {
    await Promise.all(instances.map(i => i.stop().catch(() => {})))
    instances.length = 0
    resetAllLSPDiagnosticState()
    await Bun.$`rm -rf ${TEST_WORKSPACE}`.quiet().nothrow()
  })

  describe('ContentModified automatic retry', () => {
    test('retries up to 3 times on ContentModified error', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      await instance.sendRequest('x-set-content-modified', { maxFailures: 3, result: { value: 'success' } })

      const result = await instance.sendRequest('textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      })

      expect(result).not.toBeNull()
      expect((result as { contents?: { value?: string } })?.contents?.value).toBe('Hover content')
    })

    test('fails after 3 ContentModified retries', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      await instance.sendRequest('x-set-content-modified', { maxFailures: 4 })

      await expect(
        instance.sendRequest('textDocument/hover', {
          textDocument: { uri: 'file:///test.ts' },
          position: { line: 0, character: 0 },
        }),
      ).rejects.toThrow('Content modified')
    })

    test('ContentModified works with different LSP methods', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      await instance.sendRequest('x-set-content-modified', { maxFailures: 2 })
      await instance.sendRequest('x-set-definitions', { definitions: [{ uri: 'file:///test.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }] })

      const definition = await instance.sendRequest('textDocument/definition', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      })
      expect(definition).not.toBeNull()
    })
  })

  describe('Diagnostic registry', () => {
    test('registers and delivers diagnostics', () => {
      const testUri = 'file:///test.ts'
      const diagnostics = {
        uri: testUri,
        diagnostics: [
          {
            message: 'Test error',
            severity: 1,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
        ],
      }

      const formatted = formatDiagnosticsForAttachment(diagnostics)
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted })

      expect(getPendingLSPDiagnosticCount()).toBe(1)

      const delivered = checkForLSPDiagnostics()
      expect(delivered.length).toBe(1)
      expect(delivered[0].files.length).toBe(1)
    })

    test('deduplicates identical diagnostics', () => {
      const testUri = 'file:///test.ts'
      const diagnostic = {
        message: 'Test error',
        severity: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      }

      const formatted1 = formatDiagnosticsForAttachment({ uri: testUri, diagnostics: [diagnostic] })
      const formatted2 = formatDiagnosticsForAttachment({ uri: testUri, diagnostics: [diagnostic] })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted1 })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted2 })

      const delivered = checkForLSPDiagnostics()
      const fileDiagnostics = delivered[0]?.files[0]?.diagnostics
      expect(fileDiagnostics?.length).toBe(1)
    })

    test('respects MAX_DIAGNOSTICS_PER_FILE', () => {
      const testUri = 'file:///test.ts'
      const diagnostics = Array.from({ length: 15 }, (_, i) => ({
        message: `Error ${i}`,
        severity: i < 5 ? 1 : 2,
        range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
      }))

      const formatted = formatDiagnosticsForAttachment({ uri: testUri, diagnostics })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted })

      const delivered = checkForLSPDiagnostics()
      const fileDiagnostics = delivered[0]?.files[0]?.diagnostics
      expect(fileDiagnostics?.length).toBeLessThanOrEqual(10)
    })

    test('sorts diagnostics by severity', () => {
      const testUri = 'file:///test.ts'
      const diagnostics = [
        { message: 'Hint', severity: 4, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } },
        { message: 'Error', severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
        { message: 'Info', severity: 3, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } },
        { message: 'Warning', severity: 2, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      ]

      const formatted = formatDiagnosticsForAttachment({ uri: testUri, diagnostics })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted })

      const delivered = checkForLSPDiagnostics()
      const fileDiagnostics = delivered[0]?.files[0]?.diagnostics
      expect(fileDiagnostics?.[0]?.severity).toBe('Error')
      expect(fileDiagnostics?.[1]?.severity).toBe('Warning')
      expect(fileDiagnostics?.[2]?.severity).toBe('Info')
      expect(fileDiagnostics?.[3]?.severity).toBe('Hint')
    })

    test('cross-turn deduplication using deliveredDiagnostics LRU', () => {
      const testUri = 'file:///test.ts'
      const diagnostic = {
        message: 'Test error',
        severity: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      }

      const formatted1 = formatDiagnosticsForAttachment({ uri: testUri, diagnostics: [diagnostic] })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted1 })
      const delivered1 = checkForLSPDiagnostics()
      expect(delivered1.length).toBe(1)

      const formatted2 = formatDiagnosticsForAttachment({ uri: testUri, diagnostics: [diagnostic] })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted2 })
      const delivered2 = checkForLSPDiagnostics()
      expect(delivered2.length).toBe(0)
    })

    test('clears delivered diagnostics for file when edited', () => {
      const testUri = 'file:///test.ts'
      const diagnostic = {
        message: 'Test error',
        severity: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      }

      const formatted1 = formatDiagnosticsForAttachment({ uri: testUri, diagnostics: [diagnostic] })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted1 })
      checkForLSPDiagnostics()

      clearDeliveredDiagnosticsForFile(testUri)

      const differentDiagnostic = {
        message: 'New error after edit',
        severity: 1,
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
      }
      const formatted2 = formatDiagnosticsForAttachment({ uri: testUri, diagnostics: [differentDiagnostic] })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted2 })
      const delivered2 = checkForLSPDiagnostics()
      expect(delivered2.length).toBe(1)
    })

    test('clearAllLSPDiagnostics clears pending but not delivered', () => {
      const testUri = 'file:///test.ts'
      const diagnostic = {
        message: 'Test error',
        severity: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      }

      const formatted = formatDiagnosticsForAttachment({ uri: testUri, diagnostics: [diagnostic] })
      registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted })
      expect(getPendingLSPDiagnosticCount()).toBe(1)

      clearAllLSPDiagnostics()
      expect(getPendingLSPDiagnosticCount()).toBe(0)
    })
  })

  describe('LSP server instance', () => {
    test('registers and invokes notification handlers', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      let notificationReceived = false
      instance.onNotification('test/notification', () => {
        notificationReceived = true
      })

      await instance.sendNotification('textDocument/didOpen', {
        textDocument: { uri: 'file:///test.ts', languageId: 'typescript', version: 1, text: 'const x = 1;' },
      })

      expect(instance.isHealthy()).toBe(true)
    })

    test('handles initialize with correct capabilities', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')
      expect(instance.isHealthy()).toBe(true)
    })
  })
})
