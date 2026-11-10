import { describe, expect, test } from 'bun:test'
import { createLSPServerInstance } from '../src/services/lsp/LSPServerInstance.ts'

describe('LSP lifecycle options', () => {
  test('accepts crash restart and shutdown timeout configuration', async () => {
    const instance = createLSPServerInstance('test-server', {
      command: 'test-language-server',
      extensionToLanguage: { '.ts': 'typescript' },
      restartOnCrash: true,
      shutdownTimeout: 10,
      maxRestarts: 1,
      scope: 'dynamic',
      source: 'test',
    })

    expect(instance.state).toBe('stopped')
    expect(instance.config.restartOnCrash).toBe(true)
    expect(instance.config.shutdownTimeout).toBe(10)
    await instance.stop()
  })
})
