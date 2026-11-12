import { describe, expect, test } from 'bun:test'
import envCommand from '../src/commands/env/index.ts'
import {
  formatEnv,
  formatEnvSelection,
  getEffectiveEnv,
  shouldRedactEnv,
} from '../src/commands/env/env.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

describe('/env', () => {
  test('registers a real non-interactive local command with lazy usage handling', async () => {
    expect(envCommand.name).toBe('env')
    expect(envCommand.supportsNonInteractive).toBe(true)
    expect(envCommand.isHidden).not.toBe(true)
    const { call } = await envCommand.load()
    const result = await call('PATH', {} as LocalJSXCommandContext)
    expect(result.type).toBe('text')
    if (result.type === 'text') expect(result.value).toContain('Usage: /env')
  })

  test('calculates source priority without applying settings or mutating process env', () => {
    const processEnv = {
      CLAUDE_CODE_MODE: 'process',
      ANTHROPIC_MODEL: 'process-model',
      PATH: '/secret/path',
      HOME: '/secret/home',
      claude_code_lowercase: 'ignored',
    } as NodeJS.ProcessEnv
    const before = { ...processEnv }
    const entries = getEffectiveEnv(processEnv, [
      { source: 'userSettings', env: { CLAUDE_CODE_MODE: 'user', CLAUDE_CODE_USER: 'yes' } },
      { source: 'projectSettings', env: { CLAUDE_CODE_MODE: 'project' } },
      { source: 'localSettings', env: { CLAUDE_CODE_MODE: 'local' } },
      { source: 'flagSettings', env: { CLAUDE_CODE_MODE: 'flag' } },
      { source: 'policySettings', env: { CLAUDE_CODE_MODE: 'managed', UNRELATED: 'hidden' } },
    ])
    expect(entries.find(entry => entry.name === 'CLAUDE_CODE_MODE')).toMatchObject({
      value: 'managed', source: 'policySettings',
    })
    expect(entries.find(entry => entry.name === 'ANTHROPIC_MODEL')?.source).toBe('process')
    expect(entries.some(entry => entry.name === 'PATH' || entry.name === 'HOME' || entry.name === 'UNRELATED')).toBe(false)
    expect(processEnv).toEqual(before)
  })

  test('redacts secrets, token-like values, URL userinfo/query, and never offers reveal', () => {
    const entries = getEffectiveEnv({
      ANTHROPIC_API_KEY: 'sk-ant-super-secret-value',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
      CLAUDE_CODE_ENDPOINT: 'https://user:pass@example.com/path',
      ANTHROPIC_BASE_URL: 'https://example.com/path?token=secret',
      CLAUDE_CODE_NORMAL: 'https://example.com/safe',
      CLAUDE_CODE_NOTE: 'Bearer secret-token-value',
    } as NodeJS.ProcessEnv, [])
    const output = formatEnv(entries)
    expect(entries.filter(entry => entry.redacted)).toHaveLength(5)
    expect(output).toContain('https://example.com/safe')
    expect(output).not.toContain('super-secret')
    expect(output).not.toContain('oauth-secret')
    expect(output).not.toContain('user:pass')
    expect(output).not.toContain('token=secret')
    expect(output).not.toContain('Bearer secret')
    expect(formatEnvSelection('ANTHROPIC_API_KEY --reveal', entries)).toContain('Usage:')
    expect(shouldRedactEnv('claude_api_key', 'anything')).toBe(true)
  })

  test('selects one exact uppercase NAME and rejects extra variables', () => {
    const entries = getEffectiveEnv({ CLAUDE_CODE_ONE: '1', CLAUDE_CODE_TWO: '2' } as NodeJS.ProcessEnv, [])
    expect(formatEnvSelection('CLAUDE_CODE_ONE', entries)).toContain('CLAUDE_CODE_ONE')
    expect(formatEnvSelection('CLAUDE_CODE_ONE', entries)).not.toContain('CLAUDE_CODE_TWO')
    expect(formatEnvSelection('claude_code_one', entries)).toContain('Usage:')
    expect(formatEnvSelection('PATH', entries)).toContain('Usage:')
    expect(formatEnvSelection('CLAUDE_CODE_MISSING', entries)).toContain('not set')
  })
})
