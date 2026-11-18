import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCanonicalName,
  getDefaultHaikuModel,
  getDefaultMainLoopModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  isLegacyModelRemapEnabled,
  isNonCustomOpusModel,
  parseUserSpecifiedModel,
  resolveSkillModelOverride,
} from '../src/utils/model/model.ts'
import { MODEL_ALIASES, isModelAlias, isModelFamilyAlias } from '../src/utils/model/aliases.ts'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from '../src/utils/model/providers.ts'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  CANONICAL_MODEL_IDS,
} from '../src/utils/model/configs.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'

const ENV_KEYS = [
  'HOME',
  'CLAUDE_CONFIG_DIR',
  'USER_TYPE',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP',
] as const
let original: Record<string, string | undefined> = {}
let tempDir: string | undefined

beforeEach(async () => {
  original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  // Clear all env vars first
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
  tempDir = await mkdtemp(join(tmpdir(), 'claude-model-api-'))
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

async function configureSettings(settings?: unknown): Promise<void> {
  await writeFile(
    join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
    JSON.stringify(settings === undefined ? {} : settings),
  )
  resetSettingsCache()
}

describe('model resolution (model.ts)', () => {
  describe('parseUserSpecifiedModel', () => {
    test('resolves known aliases to full model IDs', () => {
      expect(parseUserSpecifiedModel('sonnet')).toBe(getDefaultSonnetModel())
      expect(parseUserSpecifiedModel('opus')).toBe(getDefaultOpusModel())
      expect(parseUserSpecifiedModel('haiku')).toBe(getDefaultHaikuModel())
      expect(parseUserSpecifiedModel('best')).toBe(getDefaultOpusModel())
    })

    test('preserves [1m] suffix on aliases', () => {
      expect(parseUserSpecifiedModel('sonnet[1m]')).toBe(getDefaultSonnetModel() + '[1m]')
      expect(parseUserSpecifiedModel('opus[1m]')).toBe(getDefaultOpusModel() + '[1m]')
    })

    test('passes through unknown model names unchanged', () => {
      expect(parseUserSpecifiedModel('my-custom-model')).toBe('my-custom-model')
      expect(parseUserSpecifiedModel('some-deployment-id')).toBe('some-deployment-id')
    })

    test('handles case insensitivity for aliases', () => {
      expect(parseUserSpecifiedModel('SONNET')).toBe(getDefaultSonnetModel())
      expect(parseUserSpecifiedModel('Opus')).toBe(getDefaultOpusModel())
    })

    test('remaps legacy Opus 4.0/4.1 models by default (first-party)', () => {
      expect(parseUserSpecifiedModel('claude-opus-4-20250514')).toBe(getDefaultOpusModel())
      expect(parseUserSpecifiedModel('claude-opus-4-1-20250805')).toBe(getDefaultOpusModel())
    })

    test('respects CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP', () => {
      process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP = '1'
      expect(isLegacyModelRemapEnabled()).toBe(false)
      expect(parseUserSpecifiedModel('claude-opus-4-20250514')).toBe('claude-opus-4-20250514')
    })
  })

  describe('resolveSkillModelOverride', () => {
    test('preserves [1m] suffix from parent on skill models that support it', () => {
      expect(resolveSkillModelOverride('opus', 'claude-opus-4-6[1m]')).toBe('opus[1m]')
      expect(resolveSkillModelOverride('sonnet', 'claude-sonnet-4-6[1m]')).toBe('sonnet[1m]')
    })

    test('does not add [1m] for models that do not support it', () => {
      expect(resolveSkillModelOverride('haiku', 'claude-opus-4-6[1m]')).toBe('haiku')
    })

    test('returns skill model unchanged if already has [1m]', () => {
      expect(resolveSkillModelOverride('opus[1m]', 'claude-opus-4-6[1m]')).toBe('opus[1m]')
    })

    test('returns skill model unchanged if parent has no [1m]', () => {
      expect(resolveSkillModelOverride('opus', 'claude-opus-4-6')).toBe('opus')
    })
  })

  describe('getCanonicalName', () => {
    test('extracts canonical family names from full model IDs', () => {
      expect(getCanonicalName('claude-opus-4-6')).toBe('claude-opus-4-6')
      expect(getCanonicalName('claude-opus-4-6[1m]')).toBe('claude-opus-4-6')
      expect(getCanonicalName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
      expect(getCanonicalName('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet')
    })

    test('handles provider-prefixed Bedrock model IDs', () => {
      expect(getCanonicalName('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6')
      expect(getCanonicalName('eu.anthropic.claude-sonnet-4-5-v1:0')).toBe('claude-sonnet-4-5')
    })
  })

  describe('isNonCustomOpusModel', () => {
    test('identifies known Opus models', () => {
      expect(isNonCustomOpusModel(getDefaultOpusModel())).toBe(true)
      expect(isNonCustomOpusModel('claude-opus-4-5-20251101')).toBe(true)
      expect(isNonCustomOpusModel('claude-opus-4-1-20250805')).toBe(true)
    })

    test('rejects non-Opus models', () => {
      expect(isNonCustomOpusModel(getDefaultSonnetModel())).toBe(false)
      expect(isNonCustomOpusModel(getDefaultHaikuModel())).toBe(false)
      expect(isNonCustomOpusModel('my-custom-opus')).toBe(false)
    })
  })
})

describe('model aliases (aliases.ts)', () => {
  test('MODEL_ALIASES contains expected values', () => {
    expect(MODEL_ALIASES).toContain('sonnet')
    expect(MODEL_ALIASES).toContain('opus')
    expect(MODEL_ALIASES).toContain('haiku')
    expect(MODEL_ALIASES).toContain('best')
    expect(MODEL_ALIASES).toContain('opusplan')
    expect(MODEL_ALIASES).toContain('sonnet[1m]')
    expect(MODEL_ALIASES).toContain('opus[1m]')
  })

  test('isModelAlias correctly identifies aliases', () => {
    expect(isModelAlias('sonnet')).toBe(true)
    expect(isModelAlias('opus')).toBe(true)
    expect(isModelAlias('haiku')).toBe(true)
    expect(isModelAlias('best')).toBe(true)
    expect(isModelAlias('opusplan')).toBe(true)
    expect(isModelAlias('sonnet[1m]')).toBe(true)
    expect(isModelAlias('opus[1m]')).toBe(true)
    expect(isModelAlias('unknown')).toBe(false)
    expect(isModelAlias('claude-sonnet-4-6')).toBe(false)
  })

  test('isModelFamilyAlias identifies family-only aliases', () => {
    expect(isModelFamilyAlias('sonnet')).toBe(true)
    expect(isModelFamilyAlias('opus')).toBe(true)
    expect(isModelFamilyAlias('haiku')).toBe(true)
    expect(isModelFamilyAlias('best')).toBe(false)
    expect(isModelFamilyAlias('opusplan')).toBe(false)
  })
})

describe('provider selection (providers.ts)', () => {
  test('defaults to first-party provider', () => {
    expect(getAPIProvider()).toBe('firstParty')
  })

  test('selects Bedrock when CLAUDE_CODE_USE_BEDROCK is set', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(getAPIProvider()).toBe('bedrock')
  })

  test('selects Vertex when CLAUDE_CODE_USE_VERTEX is set', () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    expect(getAPIProvider()).toBe('vertex')
  })

  test('selects Foundry when CLAUDE_CODE_USE_FOUNDRY is set', () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    expect(getAPIProvider()).toBe('foundry')
  })

  test('isFirstPartyAnthropicBaseUrl recognizes standard endpoints', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)

    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)

    process.env.ANTHROPIC_BASE_URL = 'https://api-staging.anthropic.com'
    process.env.USER_TYPE = 'ant'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })

  test('isFirstPartyAnthropicBaseUrl rejects custom endpoints', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-custom-endpoint.example.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  })
})

describe('model configs (configs.ts)', () => {
  test('ALL_MODEL_CONFIGS contains expected models', () => {
    expect(ALL_MODEL_CONFIGS.sonnet46).toBeDefined()
    expect(ALL_MODEL_CONFIGS.opus46).toBeDefined()
    expect(ALL_MODEL_CONFIGS.sonnet45).toBeDefined()
    expect(ALL_MODEL_CONFIGS.haiku45).toBeDefined()
    expect(ALL_MODEL_CONFIGS.sonnet37).toBeDefined()
    expect(ALL_MODEL_CONFIGS.sonnet35).toBeDefined()
  })

  test('each model config has all four provider entries', () => {
    for (const [key, config] of Object.entries(ALL_MODEL_CONFIGS)) {
      expect(config.firstParty, `${key} missing firstParty`).toBeDefined()
      expect(config.bedrock, `${key} missing bedrock`).toBeDefined()
      expect(config.vertex, `${key} missing vertex`).toBeDefined()
      expect(config.foundry, `${key} missing foundry`).toBeDefined()
    }
  })

  test('CANONICAL_MODEL_IDS contains all first-party model IDs', () => {
    const configIds = Object.values(ALL_MODEL_CONFIGS).map(c => c.firstParty)
    for (const id of configIds) {
      expect(CANONICAL_MODEL_IDS).toContain(id)
    }
  })

  test('CANONICAL_ID_TO_KEY maps canonical IDs back to config keys', () => {
    for (const [key, config] of Object.entries(ALL_MODEL_CONFIGS)) {
      expect(CANONICAL_ID_TO_KEY[config.firstParty]).toBe(key)
    }
  })
})

describe('model validation (validateModel.ts)', () => {
  // Test the non-API paths only, since those can be tested offline
  test('rejects empty model name', async () => {
    const { validateModel } = await import('../src/utils/model/validateModel.ts')
    const result = await validateModel('')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('empty')
  })

  test('rejects whitespace-only model name', async () => {
    const { validateModel } = await import('../src/utils/model/validateModel.ts')
    const result = await validateModel('   ')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('empty')
  })

  test('rejects models not in allowlist', async () => {
    const { validateModel } = await import('../src/utils/model/validateModel.ts')
    await configureSettings({ availableModels: ['sonnet'] })
    const result = await validateModel('opus')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('not in the list of available models')
  })

  test('accepts known aliases without API call', async () => {
    const { validateModel } = await import('../src/utils/model/validateModel.ts')
    const result = await validateModel('sonnet')
    expect(result.valid).toBe(true)
  })

  test('accepts ANTHROPIC_CUSTOM_MODEL_OPTION without API call', async () => {
    const { validateModel } = await import('../src/utils/model/validateModel.ts')
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'my-custom-model'
    const result = await validateModel('my-custom-model')
    expect(result.valid).toBe(true)
  })
})

describe('Bedrock utilities (bedrock.ts)', () => {
  test('isFoundationModel identifies foundation model IDs', async () => {
    const { isFoundationModel } = await import('../src/utils/model/bedrock.ts')
    expect(isFoundationModel('anthropic.claude-sonnet-4-5-v1:0')).toBe(true)
    expect(isFoundationModel('anthropic.claude-opus-4-6-v1')).toBe(true)
    expect(isFoundationModel('us.anthropic.claude-sonnet-4-5-v1:0')).toBe(false) // cross-region
    expect(isFoundationModel('claude-sonnet-4-6')).toBe(false) // first-party format
  })

  test('extractModelIdFromArn handles ARN format', async () => {
    const { extractModelIdFromArn } = await import('../src/utils/model/bedrock.ts')
    expect(
      extractModelIdFromArn('arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1'),
    ).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(
      extractModelIdFromArn('arn:aws:bedrock:us-east-1:123456789012:foundation-model/anthropic.claude-sonnet-4-5-v1:0'),
    ).toBe('anthropic.claude-sonnet-4-5-v1:0')
  })

  test('extractModelIdFromArn returns non-ARN unchanged', async () => {
    const { extractModelIdFromArn } = await import('../src/utils/model/bedrock.ts')
    expect(extractModelIdFromArn('us.anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(extractModelIdFromArn('claude-opus-4-6')).toBe('claude-opus-4-6')
  })

  test('getBedrockRegionPrefix extracts region prefix', async () => {
    const { getBedrockRegionPrefix } = await import('../src/utils/model/bedrock.ts')
    expect(getBedrockRegionPrefix('us.anthropic.claude-opus-4-6-v1')).toBe('us')
    expect(getBedrockRegionPrefix('eu.anthropic.claude-sonnet-4-5-v1:0')).toBe('eu')
    expect(getBedrockRegionPrefix('apac.anthropic.claude-haiku-4-5-v1:0')).toBe('apac')
    expect(getBedrockRegionPrefix('global.anthropic.claude-opus-4-6-v1')).toBe('global')
    expect(getBedrockRegionPrefix('anthropic.claude-sonnet-4-5-v1:0')).toBeUndefined() // foundation
    expect(getBedrockRegionPrefix('claude-opus-4-6')).toBeUndefined() // first-party
  })

  test('applyBedrockRegionPrefix adds or replaces region prefix', async () => {
    const { applyBedrockRegionPrefix } = await import('../src/utils/model/bedrock.ts')
    expect(applyBedrockRegionPrefix('anthropic.claude-sonnet-4-5-v1:0', 'eu')).toBe('eu.anthropic.claude-sonnet-4-5-v1:0')
    expect(applyBedrockRegionPrefix('us.anthropic.claude-opus-4-6-v1', 'apac')).toBe('apac.anthropic.claude-opus-4-6-v1')
    expect(applyBedrockRegionPrefix('claude-sonnet-4-6', 'eu')).toBe('claude-sonnet-4-6') // unchanged, not Bedrock format
  })

  test('findFirstMatch finds profile with substring', async () => {
    const { findFirstMatch } = await import('../src/utils/model/bedrock.ts')
    const profiles = [
      'us.anthropic.claude-opus-4-6-v1',
      'us.anthropic.claude-sonnet-4-6',
      'us.anthropic.claude-haiku-4-5-v1:0',
    ]
    expect(findFirstMatch(profiles, 'opus')).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(findFirstMatch(profiles, 'sonnet')).toBe('us.anthropic.claude-sonnet-4-6')
    expect(findFirstMatch(profiles, 'haiku')).toBe('us.anthropic.claude-haiku-4-5-v1:0')
    expect(findFirstMatch(profiles, 'nonexistent')).toBeNull()
  })
})
