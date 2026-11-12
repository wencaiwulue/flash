import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from '../src/utils/context.ts'
import {
  getDefaultEffortForModel,
  modelSupportsMaxEffort,
} from '../src/utils/effort.ts'
import {
  getAntModelOverrideConfig,
  getAntModels,
  resolveAntModel,
} from '../src/utils/model/antModelOverrides.ts'
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
  renderModelName,
} from '../src/utils/model/model.ts'
import { getModelOptions } from '../src/utils/model/modelOptions.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'

const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'USER_TYPE'] as const
let original: Record<string, string | undefined> = {}
let tempDir: string | undefined

beforeEach(async () => {
  original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  tempDir = await mkdtemp(join(tmpdir(), 'claude-model-catalog-'))
  process.env.HOME = tempDir
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  process.env.USER_TYPE = 'external'
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
  resetSettingsCache()
})

afterEach(async () => {
  resetSettingsCache()
  for (const key of ENV_KEYS) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

async function configureCatalog(catalog?: unknown): Promise<void> {
  await writeFile(
    join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
    JSON.stringify(catalog === undefined ? {} : { modelCatalog: catalog }),
  )
  resetSettingsCache()
}

const catalog = {
  defaultModel: 'custom',
  defaultModelEffortLevel: 'low',
  models: [
    {
      alias: 'custom',
      label: 'Public Custom Model',
      description: 'Administrator configured model',
      model: 'private-codename-v9',
      contextWindow: 123456,
      defaultMaxTokens: 1111,
      upperMaxTokensLimit: 2222,
    },
    {
      alias: 'numeric',
      label: 'Numeric Effort Model',
      model: 'provider-deployment-v2',
      defaultEffortValue: 4096,
    },
  ],
} as const

describe('public model catalog overrides', () => {
  test('returns empty results only when no catalog is configured', async () => {
    await configureCatalog()
    expect(getAntModelOverrideConfig()).toBeUndefined()
    expect(getAntModels()).toEqual([])
    expect(resolveAntModel('custom')).toBeUndefined()
  })

  test('resolves aliases case-insensitively and applies the configured default', async () => {
    await configureCatalog(catalog)
    expect(getAntModelOverrideConfig()?.defaultModel).toBe('custom')
    expect(getAntModels()).toHaveLength(2)
    expect(resolveAntModel('CUSTOM')?.model).toBe('private-codename-v9')
    expect(getDefaultMainLoopModelSetting()).toBe('custom')
    expect(parseUserSpecifiedModel('custom')).toBe('private-codename-v9')
    expect(parseUserSpecifiedModel('custom[1m]')).toBe(
      'private-codename-v9[1m]',
    )
  })

  test('applies effort, context, and output-token overrides externally', async () => {
    await configureCatalog(catalog)
    expect(getDefaultEffortForModel('custom')).toBe('low')
    expect(getDefaultEffortForModel('private-codename-v9')).toBe('low')
    expect(getDefaultEffortForModel('numeric')).toBe(4096)
    expect(getContextWindowForModel('custom')).toBe(123456)
    expect(getModelMaxOutputTokens('custom')).toEqual({
      default: 1111,
      upperLimit: 2222,
    })
    expect(modelSupportsMaxEffort('custom')).toBe(true)
  })

  test('uses public labels instead of leaking the configured private codename', async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'offline-test-placeholder'
    try {
      await configureCatalog(catalog)
      expect(renderModelName('custom')).toBe('Public Custom Model')
      expect(renderModelName('custom[1m]')).toBe(
        'Public Custom Model (1M context)',
      )
      const options = getModelOptions()
      const custom = options.find(option => option.value === 'custom')
      expect(custom).toMatchObject({
        label: 'Public Custom Model',
        description: 'Administrator configured model',
      })
      expect(JSON.stringify(custom)).not.toContain('private-codename-v9')
    } finally {
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  })
})
