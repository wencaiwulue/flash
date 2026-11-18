import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  getInitialSettings,
  getSettingsWithSources,
  loadManagedFileSettings,
  parseSettingsFile,
  settingsMergeCustomizer,
} from '../src/utils/settings/settings.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'
import {
  clearInternalWrites,
  consumeInternalWrite,
  markInternalWrite,
} from '../src/utils/settings/internalWrites.ts'
import { SettingsSchema } from '../src/utils/settings/types.ts'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.ts'

import mergeWith from 'lodash-es/mergeWith.js'

describe('settings - core & cache', () => {
  let originalHome: string | undefined
  let originalCwd: string | undefined
  let testHome: string
  let testCwd: string

  beforeEach(async () => {
    originalHome = process.env.HOME
    originalCwd = process.cwd()
    resetSettingsCache()
    clearInternalWrites()

    testHome = await mkdtemp(join(tmpdir(), 'flash-settings-home-'))
    testCwd = await mkdtemp(join(tmpdir(), 'flash-settings-cwd-'))
    process.env.HOME = testHome
    process.chdir(testCwd)
  })

  afterEach(async () => {
    if (originalHome) process.env.HOME = originalHome
    if (originalCwd) process.chdir(originalCwd)
    resetSettingsCache()
    clearInternalWrites()
    await rm(testHome, { recursive: true, force: true })
    await rm(testCwd, { recursive: true, force: true })
  })

  test('settingsMergeCustomizer concatenates arrays without duplication', () => {
    // Directly test mergeWith+customizer
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
})

describe('settings - validation', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'flash-settings-validation-'))
    resetSettingsCache()
    clearInternalWrites()
  })

  afterEach(async () => {
    resetSettingsCache()
    clearInternalWrites()
    await rm(testDir, { recursive: true, force: true })
  })

  test('parseSettingsFile returns errors for invalid JSON', async () => {
    const badFile = join(testDir, 'bad-json.json')
    await writeFile(badFile, '{ this is invalid JSON')

    const { settings, errors } = parseSettingsFile(badFile)
    expect(settings).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toBe('Invalid or malformed JSON')
  })

  test('parseSettingsFile parses valid settings', async () => {
    const validSettingsFile = join(testDir, 'valid-settings.json')
    await writeFile(validSettingsFile, JSON.stringify({ theme: 'dark' }))

    const { settings, errors } = parseSettingsFile(validSettingsFile)
    expect(settings).toEqual({ theme: 'dark' })
    expect(errors).toEqual([])
  })

  test('filterInvalidPermissionRules filters invalid string rules', async () => {
    const testPath = join(testDir, 'settings-with-bad-rules.json')
    await writeFile(testPath, JSON.stringify({
      permissions: {
        allow: [
          'Read(*.md)',
          'invalid-rule',
          'Edit(*.ts)',
        ],
      },
    }))

    const { errors } = parseSettingsFile(testPath)
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain('Invalid permission rule "invalid-rule"')
  })
})

describe('settings - internal writes', () => {
  test('markInternalWrite and consumeInternalWrite work within window', () => {
    const testPath = resolve('test-settings.json')
    markInternalWrite(testPath)

    expect(consumeInternalWrite(testPath, 1000)).toBe(true)
    expect(consumeInternalWrite(testPath, 1000)).toBe(false) // already consumed
  })

  test('consumeInternalWrite returns false outside window', async () => {
    const testPath = resolve('test-settings.json')
    markInternalWrite(testPath)

    await new Promise(r => setTimeout(r, 50))

    expect(consumeInternalWrite(testPath, 10)).toBe(false) // window expired
  })

  test('clearInternalWrites clears all pending internal writes', () => {
    const path1 = resolve('one.json')
    const path2 = resolve('two.json')
    markInternalWrite(path1)
    markInternalWrite(path2)

    clearInternalWrites()

    expect(consumeInternalWrite(path1, 1000)).toBe(false)
    expect(consumeInternalWrite(path2, 1000)).toBe(false)
  })
})
