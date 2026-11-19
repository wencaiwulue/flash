import { describe, test, expect } from 'bun:test'
import { skipLine, createFormLauncher } from './launcher.ts'

describe('skipLine', () => {
  test('formats skip reason line', () => {
    expect(skipLine('blocked-by-batch:B1', 'hook:UserPromptExpansion')).toBe('SKIP [blocked-by-batch:B1] hook:UserPromptExpansion')
    expect(skipLine('form:source', 'managed:vs-user')).toBe('SKIP [form:source] managed:vs-user')
  })
})

describe('createFormLauncher', () => {
  test('source form exposes managed env pointing at sandbox', async () => {
    const { createSandbox } = await import('../../support/sandbox.ts')
    const sandbox = await createSandbox()
    try {
      const launcher = createFormLauncher('source')
      const env = launcher.managedEnv(sandbox)
      expect(env).not.toBeNull()
      expect(env!.USER_TYPE).toBe('ant')
      expect(env!.CLAUDE_CODE_MANAGED_SETTINGS_PATH).toBe(sandbox.managedDir)
      expect(launcher.form).toBe('source')
    } finally {
      await sandbox.cleanup()
    }
  })

  test('dist form has no managed env', async () => {
    const { createSandbox } = await import('../../support/sandbox.ts')
    const sandbox = await createSandbox()
    try {
      const launcher = createFormLauncher('dist')
      expect(launcher.managedEnv(sandbox)).toBeNull()
    } finally {
      await sandbox.cleanup()
    }
  })
})
