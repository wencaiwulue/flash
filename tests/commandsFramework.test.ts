import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let subscriber = false
let thirdParty = false
const authModule = await import('../src/utils/auth.ts')
mock.module('../src/utils/auth.ts', () => ({
  ...authModule,
  isClaudeAISubscriber: () => subscriber,
  isUsing3PServices: () => thirdParty,
}))

const {
  filterCommandsForRemoteMode,
  findCommand,
  formatDescriptionWithSource,
  getCommand,
  hasCommand,
  isBridgeSafeCommand,
  meetsAvailabilityRequirement,
} = await import('../src/commands.ts')
const { default: help } = await import('../src/commands/help/index.ts')
const { default: compact } = await import('../src/commands/compact/index.ts')
const { default: model } = await import('../src/commands/model/index.ts')
const { processTextPrompt } = await import(
  '../src/utils/processUserInput/processTextPrompt.ts'
)
const { getPromptId, resetStateForTests } = await import(
  '../src/bootstrap/state.ts'
)
const { looksLikeCommand } = await import(
  '../src/utils/processUserInput/processSlashCommand.tsx'
)
const { createUserMessage } = await import('../src/utils/messages.ts')

let originalBaseUrl: string | undefined

beforeEach(() => {
  subscriber = false
  thirdParty = false
  originalBaseUrl = process.env.ANTHROPIC_BASE_URL
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  resetStateForTests()
})

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
})

describe('command availability and remote safety', () => {
  test('evaluates claude.ai and console availability against live provider state', () => {
    expect(meetsAvailabilityRequirement(help)).toBe(true)
    const claudeAiOnly = { ...help, availability: ['claude-ai' as const] }
    expect(meetsAvailabilityRequirement(claudeAiOnly)).toBe(false)
    subscriber = true
    expect(meetsAvailabilityRequirement(claudeAiOnly)).toBe(true)

    const consoleOnly = { ...help, availability: ['console' as const] }
    subscriber = false
    expect(meetsAvailabilityRequirement(consoleOnly)).toBe(true)
    subscriber = true
    expect(meetsAvailabilityRequirement(consoleOnly)).toBe(false)
    subscriber = false
    thirdParty = true
    expect(meetsAvailabilityRequirement(consoleOnly)).toBe(false)
    thirdParty = false
    process.env.ANTHROPIC_BASE_URL = 'https://example.invalid'
    expect(meetsAvailabilityRequirement(consoleOnly)).toBe(false)
  })

  test('filters the actual registry for remote mode and bridge-safe execution', () => {
    expect(filterCommandsForRemoteMode([help, compact, model])).toEqual([help])
    expect(isBridgeSafeCommand(compact)).toBe(true)
    expect(isBridgeSafeCommand(help)).toBe(false)
    expect(isBridgeSafeCommand(model)).toBe(false)
    expect(
      isBridgeSafeCommand({
        ...help,
        type: 'prompt',
      }),
    ).toBe(true)
  })
})

describe('command lookup and description', () => {
  test('finds names and aliases and reports available commands on failure', () => {
    const alias = {
      ...help,
      name: 'offline-command',
      aliases: ['offline-alias'],
    }
    expect(findCommand('offline-alias', [alias])).toBe(alias)
    expect(hasCommand('offline-command', [alias])).toBe(true)
    expect(hasCommand('missing', [alias])).toBe(false)
    expect(() => getCommand('missing', [alias])).toThrow(
      'Available commands: offline-command (aliases: offline-alias)',
    )
  })

  test('formats workflow and plugin prompt sources without changing local descriptions', () => {
    expect(formatDescriptionWithSource(help)).toBe(help.description)
    expect(
      formatDescriptionWithSource({
        ...help,
        type: 'prompt',
        kind: 'workflow',
        description: 'Run offline workflow',
      }),
    ).toBe('Run offline workflow (workflow)')
    expect(
      formatDescriptionWithSource({
        ...help,
        type: 'prompt',
        source: 'plugin',
        description: 'Plugin command',
        pluginInfo: {
          pluginManifest: { name: 'offline-plugin' },
        },
      } as never),
    ).toBe('(offline-plugin) Plugin command')
  })
})

describe('prompt command parsing and message construction', () => {
  test('recognizes command names while rejecting paths and slash-prefixed input', () => {
    expect(looksLikeCommand('model')).toBe(true)
    expect(looksLikeCommand('plugin:skill-name')).toBe(true)
    expect(looksLikeCommand('/model')).toBe(false)
    expect(looksLikeCommand('path/to/file')).toBe(false)
  })

  test('builds text prompts with prompt id and preserves attachment order', () => {
    const attachment = createUserMessage({
      content: 'attachment context',
      isMeta: true,
    })
    const result = processTextPrompt(
      '  offline prompt  ',
      [],
      [],
      [attachment],
      'prompt-uuid',
    )

    expect(result.shouldQuery).toBe(true)
    expect(result.messages[0]?.message.content).toBe('  offline prompt  ')
    expect(result.messages[1]).toBe(attachment)
    expect(getPromptId()).toBeTruthy()
  })

  test('combines text, images and paste IDs without dropping attachments', () => {
    const attachment = createUserMessage({ content: 'attachment', isMeta: true })
    const image = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AA==' },
    }
    const result = processTextPrompt(
      [{ type: 'text', text: 'offline image prompt' }],
      [image],
      [7, 8],
      [attachment],
    )

    expect(result.messages[0]?.message.content).toEqual([
      { type: 'text', text: 'offline image prompt' },
      image,
    ])
    expect(result.messages[0]?.imagePasteIds).toEqual([7, 8])
    expect(result.messages[1]).toBe(attachment)
  })
})
