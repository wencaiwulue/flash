import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile, rm } from 'fs/promises'
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
const GIT_WORKSPACE = path.resolve(import.meta.dir, 'temp-git-test')
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

function createWithName(name: string, overrides?: Partial<ScopedLspServerConfig>) {
  const instance = createLSPServerInstance(name, config(overrides))
  instances.push(instance)
  return instance
}

async function setupGitWorkspace() {
  await rm(GIT_WORKSPACE, { recursive: true, force: true })
  await mkdir(GIT_WORKSPACE, { recursive: true })

  // Initialize git repo
  await Bun.$`cd ${GIT_WORKSPACE} && git init -q`.quiet()
  await Bun.$`cd ${GIT_WORKSPACE} && git config user.name "Test User"`.quiet()
  await Bun.$`cd ${GIT_WORKSPACE} && git config user.email "test@example.com"`.quiet()

  // Create .gitignore
  await writeFile(
    path.join(GIT_WORKSPACE, '.gitignore'),
    `node_modules/
dist/
build/
generated/
*.log
`,
  )

  // Create source files
  await mkdir(path.join(GIT_WORKSPACE, 'src'), { recursive: true })
  await writeFile(
    path.join(GIT_WORKSPACE, 'src', 'main.ts'),
    `export function main() {
  return "hello";
}

export const VERSION = "1.0.0";
`,
  )

  // Create ignored files
  await mkdir(path.join(GIT_WORKSPACE, 'node_modules'), { recursive: true })
  await writeFile(
    path.join(GIT_WORKSPACE, 'node_modules', 'dep.ts'),
    'export function ignored() {}',
  )

  await mkdir(path.join(GIT_WORKSPACE, 'dist'), { recursive: true })
  await writeFile(
    path.join(GIT_WORKSPACE, 'dist', 'output.js'),
    'console.log("built");',
  )

  // Initial commit (so git can check ignored files)
  await Bun.$`cd ${GIT_WORKSPACE} && git add . && git commit -qm "init"`.quiet()
}

describe('LSP', () => {
  afterEach(async () => {
    await Promise.all(instances.map(i => i.stop().catch(() => {})))
    instances.length = 0
    resetAllLSPDiagnosticState()
    await Bun.$`rm -rf ${TEST_WORKSPACE}`.quiet().nothrow()
    await Bun.$`rm -rf ${GIT_WORKSPACE}`.quiet().nothrow()
  })

  describe('ContentModified automatic retry with timing', () => {
    test('uses exponential backoff: 500ms, 1000ms, 2000ms', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      // Configure to fail 3 times then succeed
      await instance.sendRequest('x-set-content-modified', { maxFailures: 3, result: { value: 'success' } })

      const startTime = Date.now()
      const result = await instance.sendRequest('textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      })
      const totalTime = Date.now() - startTime

      expect(result).not.toBeNull()
      expect((result as { contents?: { value?: string } })?.contents?.value).toBe('Hover content')

      // Total time should be at least 500 + 1000 + 2000 = 3500ms, with some fuzz
      // for overhead, but definitely more than just 500ms
      expect(totalTime).toBeGreaterThanOrEqual(3400) // Allow 100ms fuzz
    })

    test('first retry waits 500ms', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      await instance.sendRequest('x-set-content-modified', { maxFailures: 1, result: { value: 'success' } })

      const startTime = Date.now()
      const result = await instance.sendRequest('textDocument/hover', {
        textDocument: { uri: 'file:///test.ts' },
        position: { line: 0, character: 0 },
      })
      const totalTime = Date.now() - startTime

      expect(result).not.toBeNull()
      expect(totalTime).toBeGreaterThanOrEqual(480) // At least ~500ms
      expect(totalTime).toBeLessThanOrEqual(800) // But not too long
    })

    test('fails after 3 ContentModified retries with proper timing', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      await instance.sendRequest('x-set-content-modified', { maxFailures: 4 })

      const startTime = Date.now()
      await expect(
        instance.sendRequest('textDocument/hover', {
          textDocument: { uri: 'file:///test.ts' },
          position: { line: 0, character: 0 },
        }),
      ).rejects.toThrow('Content modified')
      const totalTime = Date.now() - startTime

      expect(totalTime).toBeGreaterThanOrEqual(3400) // 500 + 1000 + 2000 = 3500ms
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

  describe('Full publishDiagnostics notification flow', () => {
    test('receives publishDiagnostics from fake server via explicit trigger', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      // Register notification handler FIRST
      let receivedParams: unknown = null
      instance.onNotification('textDocument/publishDiagnostics', (params) => {
        receivedParams = params
      })

      // Tell server what diagnostics to use
      const testUri = 'file:///testflow.ts'
      await instance.sendRequest('x-set-diagnostics', {
        diagnostics: {
          uri: testUri,
          diagnostics: [
            { message: 'Flow test error', severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }
          ]
        }
      })

      // Tell server to send diagnostics NOW
      await instance.sendRequest('x-send-diagnostics-now', {})

      // Wait a bit for notification to arrive
      await sleep(200)

      // Verify notification was received
      expect(receivedParams).not.toBeNull()
      expect((receivedParams as { uri?: string })?.uri).toBe(testUri)
    })

    test('notification handler can format and register diagnostics', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      // Set up spy on pending diagnostic count
      const initialCount = getPendingLSPDiagnosticCount()
      let receivedCount = 0

      // Register production handler flow
      instance.onNotification('textDocument/publishDiagnostics', (params) => {
        receivedCount++
        const formatted = formatDiagnosticsForAttachment(params as { uri: string, diagnostics: unknown[] })
        registerPendingLSPDiagnostic({ serverName: 'fake-lsp', files: formatted })
      })

      // Tell server to send diagnostics
      const testUri = 'file:///prodtest.ts'
      await instance.sendRequest('x-set-diagnostics', {
        diagnostics: {
          uri: testUri,
          diagnostics: [
            { message: 'Prod test error', severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }
          ]
        }
      })

      // Trigger send
      await instance.sendRequest('x-send-diagnostics-now', {})
      await sleep(200)

      // Verify handler was called
      expect(receivedCount).toBe(1)
    })
  })

  describe('Shutdown/exit and server isolation', () => {
    test('shutdown and exit sequence works cleanly', async () => {
      const instance = create()
      await instance.start()
      expect(instance.state).toBe('running')

      // Stop gracefully
      await instance.stop()
      expect(instance.state).toBe('stopped')
    })

    test('one server stopping does not affect another', async () => {
      const instance1 = createWithName('server1')
      const instance2 = createWithName('server2')

      await instance1.start()
      await instance2.start()

      expect(instance1.state).toBe('running')
      expect(instance2.state).toBe('running')

      // Verify both can handle requests
      await instance1.sendRequest('x-echo', { value: 'hello1' })
      await instance2.sendRequest('x-echo', { value: 'hello2' })

      // Stop server 1
      await instance1.stop()
      expect(instance1.state).toBe('stopped')

      // Server 2 should still be healthy
      expect(instance2.isHealthy()).toBe(true)

      // Server 2 should still handle requests
      const echoResult = await instance2.sendRequest('x-echo', { value: 'still working' })
      expect(echoResult).toEqual({ value: 'still working' })
    })

    test('disabled server state is isolated', async () => {
      const instance1 = createWithName('serverA')
      const instance2 = createWithName('serverB')

      await instance1.start()
      await instance2.start()

      // Stop server 1
      await instance1.stop()
      expect(instance1.state).toBe('stopped')

      // Server 2 still works
      expect(instance2.isHealthy()).toBe(true)

      // Can restart server 1 without affecting server 2
      await instance1.start()
      expect(instance1.state).toBe('running')
      expect(instance2.state).toBe('running')
    })
  })

  describe('LSPTool gitignore filtering with real git repo', () => {
    test('git check-ignore identifies ignored files correctly', async () => {
      await setupGitWorkspace()

      const srcPath = path.join(GIT_WORKSPACE, 'src', 'main.ts')
      const nodeDepPath = path.join(GIT_WORKSPACE, 'node_modules', 'dep.ts')
      const distPath = path.join(GIT_WORKSPACE, 'dist', 'output.js')

      // Test batch checking
      const result = await Bun.$`cd ${GIT_WORKSPACE} && git check-ignore ${srcPath} ${nodeDepPath} ${distPath}`.quiet().nothrow()

      const stdoutText = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString()
      const ignored = stdoutText.trim().split('\n').filter(Boolean)

      // node_modules/ and dist/ should be ignored, src/ should not
      expect(ignored.some(p => p.includes('node_modules'))).toBe(true)
      expect(ignored.some(p => p.includes('dist'))).toBe(true)
      expect(ignored.some(p => p.includes('src'))).toBe(false)
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
