import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { query } from '../src/entrypoints/agentSdkTypes.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalApiKey = process.env.ANTHROPIC_API_KEY
let tempDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join('/tmp', 'claude-sdk-controls-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.ANTHROPIC_API_KEY = 'offline-test-placeholder'
})

beforeEach(async () => {
  const { resetStateForTests } = await import('../src/bootstrap/state.ts')
  resetStateForTests()
})

afterAll(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = originalApiKey
  }
  await rm(tempDir, { recursive: true, force: true })
})

describe('SDK control methods', () => {
  test('reads usage and settings, reloads plugins, and validates task IDs', async () => {
    const q = query({
      prompt: (async function* () {})(),
      options: { tools: [] },
    })
    try {
      const usage = await q.getContextUsage()
      expect(usage.maxTokens).toBeGreaterThan(0)

      const settings = await q.getSettings()
      expect(settings.applied.model).toBeTruthy()

      await q.applyFlagSettings({ model: 'test-model' })
      expect((await q.getSettings()).applied.model).toBe('test-model')

      const reloaded = await q.reloadPlugins()
      expect(reloaded.error_count).toBe(0)
      expect(reloaded.mcpServers).toEqual([])

      await expect(q.stopTask('missing-task')).rejects.toMatchObject({
        code: 'not_found',
      })
    } finally {
      await q.applyFlagSettings({ model: null })
      await q.return(undefined)
    }
  })

  test('deletes null flags and emits model metadata changes with the applied model', async () => {
    const notifications: Array<{ model: string }> = []
    mock.module('../src/utils/sessionState.ts', () => ({
      notifySessionMetadataChanged: (value: { model: string }) => {
        notifications.push(value)
      },
    }))
    const { applySdkFlagSettings } = await import('../src/utils/sdkControl.ts')
    const { getMainLoopModel } = await import('../src/utils/model/model.ts')
    const {
      getFlagSettingsInline,
      setFlagSettingsInline,
      setMainLoopModelOverride,
    } = await import('../src/bootstrap/state.ts')

    const originalModel = getMainLoopModel()
    const originalFlags = getFlagSettingsInline()
    try {
      setMainLoopModelOverride('model-a')
      setFlagSettingsInline({ removeMe: true, keepMe: 'yes' })
      applySdkFlagSettings({ removeMe: null, model: 'model-b' })
      expect(getFlagSettingsInline()?.removeMe).toBeUndefined()
      expect(getFlagSettingsInline()?.keepMe).toBe('yes')
      expect(getMainLoopModel()).toBe('model-b')

      applySdkFlagSettings({ model: null })
      expect(getMainLoopModel()).toBe(originalModel)
      expect(notifications).toEqual([
        { model: 'model-b' },
        { model: originalModel },
      ])
    } finally {
      setMainLoopModelOverride(originalModel)
      setFlagSettingsInline(originalFlags ?? {})
    }
  })
})
