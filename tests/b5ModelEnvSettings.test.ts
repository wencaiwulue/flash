import { describe, it, expect, afterEach } from 'bun:test'
import { SettingsSchema } from '../src/utils/settings/types.ts'
import { isFastModeEnabled } from '../src/utils/fastMode.ts'
import { getModelOptions } from '../src/utils/model/modelOptions.ts'

const ENVS = [
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
]
afterEach(() => {
  for (const k of ENVS) delete process.env[k]
})

// B5 (#26): independent feature env/settings — align entries that already have a
// runtime reader. Model-picker envs (ANTHROPIC_DEFAULT_*_MODEL[_NAME|_DESCRIPTION],
// ANTHROPIC_CUSTOM_MODEL_OPTION*), ANTHROPIC_MODEL, CLAUDE_CODE_SUBAGENT_MODEL,
// fast-mode envs, feedback envs, feedbackSurveyRate.
describe('B5 feedbackSurveyRate', () => {
  it('accepts a number, rejects a string', () => {
    expect(SettingsSchema().safeParse({ feedbackSurveyRate: 0.5 }).success).toBe(true)
    expect(SettingsSchema().safeParse({ feedbackSurveyRate: 'x' }).success).toBe(false)
  })
})

describe('B5 fast-mode env', () => {
  it('isFastModeEnabled respects CLAUDE_CODE_DISABLE_FAST_MODE', () => {
    delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    expect(isFastModeEnabled()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_FAST_MODE = '1'
    expect(isFastModeEnabled()).toBe(false)
  })
})

describe('B5 model-picker custom model env', () => {
  it('getModelOptions adds ANTHROPIC_CUSTOM_MODEL_OPTION with NAME/DESCRIPTION', () => {
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'my-gateway-model'
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = 'Gateway Model'
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = 'My gateway'
    const custom = getModelOptions().find(o => o.value === 'my-gateway-model')
    expect(custom?.label).toBe('Gateway Model')
    expect(custom?.description).toBe('My gateway')
  })

  it('getModelOptions falls back to default description when NAME/DESCRIPTION unset', () => {
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'my-gateway-model'
    const custom = getModelOptions().find(o => o.value === 'my-gateway-model')
    expect(custom?.label).toBe('my-gateway-model')
    expect(custom?.description).toBe('Custom model (my-gateway-model)')
  })
})
