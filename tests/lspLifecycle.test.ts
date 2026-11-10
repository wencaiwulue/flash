import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'path'
import {
  createLSPServerInstance,
  type LSPServerInstance,
} from '../src/services/lsp/LSPServerInstance.ts'
import type { ScopedLspServerConfig } from '../src/services/lsp/types.ts'
import { sleep } from '../src/utils/sleep.ts'

const instances = new Set<LSPServerInstance>()

afterEach(async () => {
  await Promise.all([...instances].map(instance => instance.stop().catch(() => {})))
  instances.clear()
})

function config(overrides: Partial<ScopedLspServerConfig> = {}): ScopedLspServerConfig {
  return {
    command: process.execPath,
    args: [resolve(import.meta.dir, 'fixtures/fake-lsp-server.ts')],
    extensionToLanguage: { '.ts': 'typescript' },
    scope: 'dynamic',
    source: 'test',
    ...overrides,
  }
}

function create(overrides?: Partial<ScopedLspServerConfig>): LSPServerInstance {
  const instance = createLSPServerInstance('fake-lsp', config(overrides))
  instances.add(instance)
  return instance
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('LSP lifecycle timeout')
    await sleep(20)
  }
}

describe('LSP process lifecycle', () => {
  test('starts, initializes, answers requests, and stops without restart', async () => {
    const instance = create({ restartOnCrash: true })
    await instance.start()
    expect(instance.state).toBe('running')
    expect(instance.isHealthy()).toBe(true)
    expect(await instance.sendRequest('x-echo', { value: 42 })).toEqual({ value: 42 })
    await instance.stop()
    expect(instance.state).toBe('stopped')
    expect(instance.restartCount).toBe(0)
  })

  test('restarts after an unexpected crash', async () => {
    const instance = create({ restartOnCrash: true, maxRestarts: 1 })
    await instance.start()
    await expect(instance.sendRequest('x-crash', {})).rejects.toThrow()
    await waitFor(() => instance.state === 'running' && instance.restartCount === 1)
    expect(await instance.sendRequest('x-echo', { restarted: true })).toEqual({
      restarted: true,
    })
  })

  test('enforces maxRestarts after repeated crashes', async () => {
    const instance = create({ restartOnCrash: true, maxRestarts: 0 })
    await instance.start()
    await expect(instance.sendRequest('x-crash', {})).rejects.toThrow()
    await waitFor(() => instance.lastError?.message.includes('Max restart attempts') === true)
    expect(instance.state).toBe('error')
  })

  test('force-kills when graceful shutdown exceeds the timeout', async () => {
    const instance = create({ shutdownTimeout: 25 })
    await instance.start()
    const started = Date.now()
    process.env.FAKE_LSP_SHUTDOWN_DELAY = '1000'
    await instance.stop()
    expect(Date.now() - started).toBeLessThan(500)
    expect(instance.state).toBe('stopped')
    delete process.env.FAKE_LSP_SHUTDOWN_DELAY
  })
})
