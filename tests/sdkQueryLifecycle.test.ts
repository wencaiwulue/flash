import { expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'

// Import actual modules with ?actual suffix first
const cleanupRegistryActual = await import('../src/utils/cleanupRegistry.ts?actual')
const sessionStorageActual = await import('../src/utils/sessionStorage.ts?actual')

test('query.return runs cleanup and session flush exactly once', async () => {
  const calls: string[] = []

  // Set up mocks
  mock.module('../src/utils/cleanupRegistry.ts', () => ({
    ...cleanupRegistryActual,
    runCleanupFunctions: async () => {
      calls.push('cleanup')
    },
  }))
  mock.module('../src/utils/sessionStorage.ts', () => ({
    ...sessionStorageActual,
    flushSessionStorage: async () => {
      calls.push('flush')
    },
  }))

  // Now import the module under test
  const { createSdkQuery } = await import('../src/utils/sdkQuery.ts')
  const home = await mkdtemp(join('/tmp', 'sdk-query-lifecycle-'))
  try {
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
    process.env.ANTHROPIC_API_KEY = 'offline-test-placeholder'
    const query = createSdkQuery({
      prompt: (async function* () {})(),
      options: { tools: [] },
    })
    // Initialize the query by calling one of its methods
    await query.getSettings()
    await query.return(undefined)
    await query.return(undefined)
    expect(calls).toEqual(['cleanup', 'flush'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
