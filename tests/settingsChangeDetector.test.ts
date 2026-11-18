import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setAllowedSettingSources,
  setOriginalCwd,
  setProjectRoot,
} from '../src/bootstrap/state.ts'
import {
  dispose,
  initialize,
  resetForTesting,
  subscribe,
} from '../src/utils/settings/changeDetector.ts'
import {
  clearInternalWrites,
  markInternalWrite,
} from '../src/utils/settings/internalWrites.ts'
import { getSettingsFilePathForSource } from '../src/utils/settings/settings.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'
import type { SettingSource } from '../src/utils/settings/constants.ts'

let tempDir: string
let projectDir: string
let settingsPath: string
let originalConfigDir: string | undefined
let originalCwd: string
let events: SettingSource[]
let unsubscribe: (() => void) | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalCwd = process.cwd()
  tempDir = await mkdtemp(join(tmpdir(), 'flash-settings-watcher-'))
  projectDir = join(tempDir, 'project')
  await mkdir(join(tempDir, 'config'), { recursive: true })
  await mkdir(projectDir, { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.chdir(projectDir)
  resetStateForTests()
  setOriginalCwd(projectDir)
  setProjectRoot(projectDir)
  setAllowedSettingSources(['userSettings'])
  resetSettingsCache()
  clearInternalWrites()
  await resetForTesting({
    stabilityThreshold: 20,
    pollInterval: 10,
    deletionGrace: 150,
    mdmPollInterval: 60_000,
  })
  settingsPath = getSettingsFilePathForSource('userSettings')!
  await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }))
  events = []
  unsubscribe = subscribe(source => events.push(source))
  await initialize()
  await new Promise(resolve => setTimeout(resolve, 60))
})

afterEach(async () => {
  unsubscribe?.()
  await dispose()
  await resetForTesting()
  resetSettingsCache()
  clearInternalWrites()
  resetStateForTests()
  process.chdir(originalCwd)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(tempDir, { recursive: true, force: true })
})

async function waitForEvents(count: number): Promise<void> {
  const deadline = Date.now() + 3000
  while (events.length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(events.length).toBeGreaterThanOrEqual(count)
}

describe('settings change detector real watcher', () => {
  test('suppresses an internal write and notifies for the next external write', async () => {
    markInternalWrite(settingsPath)
    await writeFile(settingsPath, JSON.stringify({ theme: 'light' }))
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(events).toEqual([])

    await writeFile(settingsPath, JSON.stringify({ theme: 'system' }))
    await waitForEvents(1)
    expect(events).toEqual(['userSettings'])
  })

  test('coalesces delete-recreate into one change and emits a later real deletion', async () => {
    await rm(settingsPath)
    await new Promise(resolve => setTimeout(resolve, 60))
    await writeFile(settingsPath, JSON.stringify({ theme: 'light' }))

    await waitForEvents(1)
    await new Promise(resolve => setTimeout(resolve, 220))
    expect(events).toEqual(['userSettings'])

    await rm(settingsPath)
    await waitForEvents(2)
    expect(events).toEqual(['userSettings', 'userSettings'])
  })
})
