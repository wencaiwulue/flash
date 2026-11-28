import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  getInitialSettings,
  getSettingsWithSources,
  getSettingsForSource,
  loadManagedFileSettings,
  parseSettingsFile,
  settingsMergeCustomizer,
  updateSettingsForSource,
} from '../src/utils/settings/settings.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from '../src/utils/settings/managedPath.ts'
import {
  clearInternalWrites,
  consumeInternalWrite,
  markInternalWrite,
} from '../src/utils/settings/internalWrites.ts'
import { SettingsSchema } from '../src/utils/settings/types.ts'
import { saveGlobalConfig } from '../src/utils/config.ts'
import { migrateAutoUpdatesToSettings } from '../src/migrations/migrateAutoUpdatesToSettings.ts'
import { migrateBypassPermissionsAcceptedToSettings } from '../src/migrations/migrateBypassPermissionsAcceptedToSettings.ts'
import mergeWith from 'lodash-es/mergeWith.js'
import { setAllowedSettingSources, resetStateForTests, setOriginalCwd, setProjectRoot } from '../src/bootstrap/state.ts'

// Test setup helpers
let tempDirs: string[] = []
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'flash-test-'))
  tempDirs.push(dir)
  return dir
}

async function cleanupTempDirs() {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {}
  }
  tempDirs = []
}

describe('settings - core & cache', () => {
  let originalEnv: Record<string, string | undefined> = {}
  let originalCwd: string

  beforeEach(async () => {
    originalEnv = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    }
    originalCwd = process.cwd()
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()

    setAllowedSettingSources([
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ])
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) process.env[key] = value
      else delete process.env[key]
    }
    process.chdir(originalCwd)
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()
    await cleanupTempDirs()
  })

  test('settingsMergeCustomizer concatenates arrays without duplication', () => {
    const merged = mergeWith(
      { allowedTools: ['foo', 'bar'] },
      { allowedTools: ['bar', 'baz'] },
      settingsMergeCustomizer,
    )
    expect(merged.allowedTools).toEqual(['foo', 'bar', 'baz'])
  })

  test('settingsMergeCustomizer deep-merges objects', () => {
    const result = mergeWith(
      { mcpServers: { foo: { command: 'foo' } } },
      { mcpServers: { bar: { command: 'bar' } } },
      settingsMergeCustomizer,
    )
    expect(result).toEqual({
      mcpServers: {
        foo: { command: 'foo' },
        bar: { command: 'bar' },
      },
    })
  })

  test('multi-source priority: user < project < local', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })
    await mkdir(join(testCwd, '.claude'), { recursive: true })

    const userSettingsPath = join(testHome, '.claude', 'settings.json')
    const projectSettingsPath = join(testCwd, '.claude', 'settings.json')
    const localSettingsPath = join(testCwd, '.claude', 'settings.local.json')

    await writeFile(userSettingsPath, JSON.stringify({ theme: 'dark', model: 'opus' }))
    await writeFile(projectSettingsPath, JSON.stringify({ theme: 'light', mcpServers: { a: { command: 'a' } } }))
    await writeFile(localSettingsPath, JSON.stringify({ theme: 'system' }))

    resetSettingsCache()
    const settings = getInitialSettings()

    expect(settings.theme).toBe('system')
    expect(settings.model).toBe('opus')
    expect(settings.mcpServers).toEqual({ a: { command: 'a' } })
  })

  test('array merge across sources: concat + dedupe', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })
    await mkdir(join(testCwd, '.claude'), { recursive: true })

    const userSettingsPath = join(testHome, '.claude', 'settings.json')
    const projectSettingsPath = join(testCwd, '.claude', 'settings.json')

    await writeFile(userSettingsPath, JSON.stringify({
      permissions: { allow: ['Read(*)', 'Edit(*.ts)'] }
    }))
    await writeFile(projectSettingsPath, JSON.stringify({
      permissions: { allow: ['Edit(*.ts)', 'Bash(*)'] }
    }))

    resetSettingsCache()
    const settings = getInitialSettings()

    const resultAllow = settings.permissions?.allow
    expect(resultAllow).toContain('Read(*)')
    expect(resultAllow).toContain('Bash(*)')
  })

  test('cache works - second read hits cache', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    const userSettingsPath = join(testHome, '.claude', 'settings.json')
    await writeFile(userSettingsPath, JSON.stringify({ theme: 'dark' }))

    const first = getInitialSettings()
    expect(first.theme).toBe('dark')

    await writeFile(userSettingsPath, JSON.stringify({ theme: 'light' }))

    const second = getInitialSettings()
    expect(second.theme).toBe('dark')

    resetSettingsCache()
    const third = getInitialSettings()
    expect(third.theme).toBe('light')
  })

  test('resetSettingsCache makes external changes visible', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    const userSettingsPath = join(testHome, '.claude', 'settings.json')
    await writeFile(userSettingsPath, JSON.stringify({ theme: 'dark' }))

    const first = getInitialSettings()
    expect(first.theme).toBe('dark')

    await writeFile(userSettingsPath, JSON.stringify({ theme: 'light' }))

    resetSettingsCache()
    const settings = getInitialSettings()
    expect(settings.theme).toBe('light')
  })

  test('getSettingsWithSources returns per-source settings', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    const userSettingsPath = join(testHome, '.claude', 'settings.json')
    await writeFile(userSettingsPath, JSON.stringify({ theme: 'dark' }))

    resetSettingsCache()
    const result = getSettingsWithSources()

    expect(result.effective.theme).toBe('dark')
    const userSource = result.sources.find(s => s.source === 'userSettings')
    expect(userSource).toBeDefined()
  })

  test('getSettingsForSource returns source-specific settings', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    const userSettingsPath = join(testHome, '.claude', 'settings.json')
    await writeFile(userSettingsPath, JSON.stringify({ theme: 'dark' }))

    resetSettingsCache()
    const userSettings = getSettingsForSource('userSettings')
    expect(userSettings).toEqual({ theme: 'dark' })
  })
})

describe('settings - validation', () => {
  beforeEach(() => {
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()
  })

  afterEach(async () => {
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()
    await cleanupTempDirs()
  })

  test('parseSettingsFile returns null for invalid JSON', async () => {
    const testDir = await createTempDir()
    const badPath = join(testDir, 'bad-json.json')
    await writeFile(badPath, '{ this is invalid JSON')

    const { settings, errors } = parseSettingsFile(badPath)
    expect(settings).toBeNull()
  })

  test('parseSettingsFile parses valid settings', async () => {
    const testDir = await createTempDir()
    const validPath = join(testDir, 'valid-settings.json')
    await writeFile(validPath, JSON.stringify({ theme: 'dark' }))

    const { settings, errors } = parseSettingsFile(validPath)
    expect(settings).toEqual({ theme: 'dark' })
    expect(errors).toEqual([])
  })

  test('parseSettingsFile handles empty file as empty object', async () => {
    const testDir = await createTempDir()
    const emptyPath = join(testDir, 'empty-settings.json')
    await writeFile(emptyPath, '')

    const { settings } = parseSettingsFile(emptyPath)
    expect(settings).toEqual({})
  })

  test('filterInvalidPermissionRules filters invalid string rules', async () => {
    const testDir = await createTempDir()
    const settingsPath = join(testDir, 'settings-with-rules.json')
    await writeFile(settingsPath, JSON.stringify({
      permissions: {
        allow: [
          'Read(*.md)',
          'invalid-rule',
          'Edit(*.ts)',
        ],
      },
    }))

    const { errors } = parseSettingsFile(settingsPath)
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('settings - updateSettingsForSource', () => {
  let originalEnv: Record<string, string | undefined> = {}
  let originalCwd: string

  beforeEach(async () => {
    originalEnv = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    }
    originalCwd = process.cwd()
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()
    setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'])
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) process.env[key] = value
      else delete process.env[key]
    }
    process.chdir(originalCwd)
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()
    await cleanupTempDirs()
  })

  test('updateSettingsForSource successfully writes user settings', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    resetSettingsCache()
    clearInternalWrites()
    const result = updateSettingsForSource('userSettings', { theme: 'dark' })
    expect(result.error).toBeNull()

    const written = await readFile(join(testHome, '.claude', 'settings.json'), 'utf8')
    const parsed = JSON.parse(written)
    expect(parsed.theme).toBe('dark')
  })

  test('updateSettingsForSource marks internal write', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    resetSettingsCache()
    clearInternalWrites()
    updateSettingsForSource('userSettings', { theme: 'dark' })

    const path = join(testHome, '.claude', 'settings.json')
    expect(consumeInternalWrite(path, 5000)).toBe(true)
  })

  test('updateSettingsForSource does not overwrite invalid JSON - preserves original', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    const settingsPath = join(testHome, '.claude', 'settings.json')
    const invalidContent = '{ invalid JSON'
    await writeFile(settingsPath, invalidContent)
    resetSettingsCache()

    const result = updateSettingsForSource('userSettings', { theme: 'dark' })
    expect(result.error).not.toBeNull()

    const content = await readFile(settingsPath, 'utf8')
    expect(content).toBe(invalidContent)
  })

  test('updateSettingsForSource deletes explicit undefined keys and refreshes readers', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })
    const settingsPath = join(testHome, '.claude', 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({ theme: 'dark', model: 'opus', env: { KEEP: '1' } }),
    )
    resetSettingsCache()
    expect(getInitialSettings().theme).toBe('dark')

    const result = updateSettingsForSource('userSettings', {
      theme: undefined,
      model: 'sonnet',
    })

    expect(result.error).toBeNull()
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(persisted).toEqual({ model: 'sonnet', env: { KEEP: '1' } })
    expect(getSettingsForSource('userSettings')).toEqual(persisted)
  })
})

describe('settings - internal writes', () => {
  beforeEach(() => {
    clearInternalWrites()
  })

  afterEach(() => {
    clearInternalWrites()
  })

  test('markInternalWrite and consumeInternalWrite work within window', () => {
    const testPath = resolve('test-settings.json')
    markInternalWrite(testPath)

    expect(consumeInternalWrite(testPath, 10000)).toBe(true)
    expect(consumeInternalWrite(testPath, 10000)).toBe(false)
  })

  test('consumeInternalWrite returns false outside window', async () => {
    const testPath = resolve('test-settings.json')
    markInternalWrite(testPath)

    await new Promise(r => setTimeout(r, 20))

    expect(consumeInternalWrite(testPath, 10)).toBe(false)
  })

  test('clearInternalWrites clears all pending internal writes', () => {
    const path1 = resolve('one.json')
    const path2 = resolve('two.json')
    markInternalWrite(path1)
    markInternalWrite(path2)

    clearInternalWrites()

    expect(consumeInternalWrite(path1, 10000)).toBe(false)
    expect(consumeInternalWrite(path2, 10000)).toBe(false)
  })
})

describe('settings - managed files', () => {
  test('managed drop-ins merge alphabetically over the base file', async () => {
    const originalUserType = process.env.USER_TYPE
    const originalManagedPath = process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
    const managedRoot = await createTempDir()
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedRoot
    getManagedFilePath.cache.clear()
    getManagedSettingsDropInDir.cache.clear()

    try {
      const dropInDir = getManagedSettingsDropInDir()
      await mkdir(dropInDir, { recursive: true })
      await writeFile(
        join(managedRoot, 'managed-settings.json'),
        JSON.stringify({
          theme: 'dark',
          permissions: { allow: ['Read(*)'] },
          env: { FIRST: 'base', SECOND: 'base' },
        }),
      )
      await writeFile(
        join(dropInDir, '10-team.json'),
        JSON.stringify({
          theme: 'light',
          permissions: { allow: ['Bash(*)'] },
          env: { SECOND: 'team' },
        }),
      )
      await writeFile(
        join(dropInDir, '20-local.json'),
        JSON.stringify({ env: { FIRST: 'local' } }),
      )

      const { settings, errors } = loadManagedFileSettings()
      expect(errors).toEqual([])
      expect(settings).toEqual({
        theme: 'light',
        permissions: { allow: ['Read(*)', 'Bash(*)'] },
        env: { FIRST: 'local', SECOND: 'team' },
      })
    } finally {
      if (originalUserType === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = originalUserType
      if (originalManagedPath === undefined) {
        delete process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH
      } else {
        process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = originalManagedPath
      }
      getManagedFilePath.cache.clear()
      getManagedSettingsDropInDir.cache.clear()
      resetSettingsCache()
      await cleanupTempDirs()
    }
  })
})

describe('settings - migrations', () => {
  let originalEnv: Record<string, string | undefined> = {}
  let originalCwd: string

  beforeEach(async () => {
    originalEnv = {
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER,
    }
    originalCwd = process.cwd()
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()
    saveGlobalConfig(current => ({
      ...current,
      autoUpdates: true,
      autoUpdatesProtectedForNative: false,
      bypassPermissionsModeAccepted: false,
    }))
    setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings'])
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) process.env[key] = value
      else delete process.env[key]
    }
    process.chdir(originalCwd)
    resetSettingsCache()
    clearInternalWrites()
    resetStateForTests()
    await cleanupTempDirs()
  })

  test('migrateAutoUpdatesToSettings migrates when autoUpdates is false', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    saveGlobalConfig(c => ({ ...c, autoUpdates: false }))

    migrateAutoUpdatesToSettings()

    resetSettingsCache()
    const settings = getSettingsForSource('userSettings')
    expect(settings?.env?.DISABLE_AUTOUPDATER).toBe('1')
  })

  test('migrateAutoUpdatesToSettings skips when autoUpdates is not false', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    saveGlobalConfig(c => ({ ...c, autoUpdates: true }))

    migrateAutoUpdatesToSettings()

    resetSettingsCache()
    const settings = getSettingsForSource('userSettings')
    expect(settings?.env?.DISABLE_AUTOUPDATER).toBeUndefined()
  })

  test('migrateAutoUpdatesToSettings skips when protected for native', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    saveGlobalConfig(c => ({ ...c, autoUpdates: false, autoUpdatesProtectedForNative: true }))

    migrateAutoUpdatesToSettings()

    resetSettingsCache()
    const settings = getSettingsForSource('userSettings')
    expect(settings?.env?.DISABLE_AUTOUPDATER).toBeUndefined()
  })

  test('migrateAutoUpdatesToSettings is idempotent across repeated runs', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    saveGlobalConfig(c => ({ ...c, autoUpdates: false }))

    migrateAutoUpdatesToSettings()
    const settingsPath = join(testHome, '.claude', 'settings.json')
    const afterFirst = await readFile(settingsPath, 'utf8')
    expect(JSON.parse(afterFirst).env.DISABLE_AUTOUPDATER).toBe('1')

    migrateAutoUpdatesToSettings()

    expect(await readFile(settingsPath, 'utf8')).toBe(afterFirst)
  })

  test('migrateBypassPermissionsAcceptedToSettings migrates when true', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    saveGlobalConfig(c => ({ ...c, bypassPermissionsModeAccepted: true }))

    migrateBypassPermissionsAcceptedToSettings()

    resetSettingsCache()
    const settings = getSettingsForSource('userSettings')
    expect(settings?.skipDangerousModePermissionPrompt).toBe(true)
  })

  test('migrateBypassPermissionsAcceptedToSettings skips when false', async () => {
    const testHome = await createTempDir()
    const testCwd = await createTempDir()
    process.env.HOME = testHome
    process.env.CLAUDE_CONFIG_DIR = join(testHome, '.claude')
    process.chdir(testCwd)
    setOriginalCwd(testCwd)
    setProjectRoot(testCwd)
    await mkdir(join(testHome, '.claude'), { recursive: true })

    saveGlobalConfig(c => ({ ...c, bypassPermissionsModeAccepted: false }))

    migrateBypassPermissionsAcceptedToSettings()

    resetSettingsCache()
    const settings = getSettingsForSource('userSettings')
    expect(settings?.skipDangerousModePermissionPrompt).toBeUndefined()
  })
})

describe('settings - schema validation', () => {
  test('SettingsSchema passes through unknown fields (passthrough)', () => {
    const withUnknown = {
      theme: 'dark',
      unknownField: 'should be preserved',
      nested: { also: 'preserved' },
    }

    const result = SettingsSchema().safeParse(withUnknown)
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).unknownField).toBe('should be preserved')
      expect((result.data as any).nested).toEqual({ also: 'preserved' })
    }
  })
})
