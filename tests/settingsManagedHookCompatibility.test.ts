import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir = ''
let loadManagedFileSettings: typeof import('../src/utils/settings/settings.ts').loadManagedFileSettings
let getManagedFileSettingsPresence: typeof import('../src/utils/settings/settings.ts').getManagedFileSettingsPresence
let resetSettingsCache: typeof import('../src/utils/settings/settingsCache.ts').resetSettingsCache

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flash-managed-hooks-'))
  mock.module('../src/utils/settings/managedPath.ts', () => ({
    getManagedFilePath: () => dir,
    getManagedSettingsDropInDir: () => join(dir, 'managed-settings.d'),
  }))
  ;({ loadManagedFileSettings, getManagedFileSettingsPresence } = await import('../src/utils/settings/settings.ts'))
  ;({ resetSettingsCache } = await import('../src/utils/settings/settingsCache.ts'))
  resetSettingsCache()
})

afterEach(async () => {
  resetSettingsCache()
  mock.restore()
  await rm(dir, { recursive: true, force: true })
})

describe('managed hook validation remains unchanged', () => {
  test('managed base rejects an unknown event', async () => {
    await writeFile(join(dir, 'managed-settings.json'), JSON.stringify({
      model: 'sonnet', hooks: { FutureUpstreamEvent: [] },
    }))
    const result = loadManagedFileSettings()
    expect(result.settings).toBeNull()
    expect(result.errors.some(error => error.severity === 'error')).toBe(true)
  })

  test('managed drop-in rejects an unknown event without discarding a valid base', async () => {
    await writeFile(join(dir, 'managed-settings.json'), JSON.stringify({ model: 'sonnet' }))
    await mkdir(join(dir, 'managed-settings.d'))
    await writeFile(join(dir, 'managed-settings.d', '10-hooks.json'), JSON.stringify({
      hooks: { FutureUpstreamEvent: [] },
    }))
    const result = loadManagedFileSettings()
    expect(result.settings).toEqual({ model: 'sonnet' })
    expect(result.errors.some(error => error.severity === 'error')).toBe(true)
  })

  test('managed presence does not use hook recovery', async () => {
    await writeFile(join(dir, 'managed-settings.json'), JSON.stringify({
      hooks: { FutureUpstreamEvent: [] },
    }))
    expect(getManagedFileSettingsPresence().hasBase).toBe(false)
  })
})
