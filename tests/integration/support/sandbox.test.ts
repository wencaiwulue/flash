import { describe, test, expect, afterAll } from 'bun:test'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'path'
import { createSandbox, type Sandbox } from './sandbox.ts'

const sandboxes: Sandbox[] = []
afterAll(async () => {
  for (const sandbox of sandboxes) await sandbox.cleanup()
})

describe('createSandbox', () => {
  test('creates home and project with onboarding preseeded', async () => {
    const sandbox = await createSandbox()
    sandboxes.push(sandbox)
    const globalConfig = JSON.parse(await readFile(join(sandbox.home, '.claude.json'), 'utf8'))
    expect(globalConfig.hasCompletedOnboarding).toBe(true)
    expect(globalConfig.theme).toBe('dark')
    expect(globalConfig.projects[sandbox.project].hasTrustDialogAccepted).toBe(true)
    const claudeDirStat = await stat(join(sandbox.project, '.claude'))
    expect(claudeDirStat.isDirectory()).toBe(true)
  })

  test('writes optional settings files', async () => {
    const sandbox = await createSandbox({
      userSettings: { model: 'sonnet' },
      projectSettings: { permissions: { allow: ['Bash'] } },
      localSettings: { verbose: true },
    })
    sandboxes.push(sandbox)
    expect(JSON.parse(await readFile(join(sandbox.home, '.claude', 'settings.json'), 'utf8')).model).toBe('sonnet')
    expect(JSON.parse(await readFile(join(sandbox.project, '.claude', 'settings.json'), 'utf8')).permissions.allow).toEqual(['Bash'])
    expect(JSON.parse(await readFile(join(sandbox.project, '.claude', 'settings.local.json'), 'utf8')).verbose).toBe(true)
  })

  test('env isolates ANTHROPIC and CLAUDE vars and points HOME at sandbox', async () => {
    const sandbox = await createSandbox()
    sandboxes.push(sandbox)
    expect(sandbox.env.HOME).toBe(sandbox.home)
    expect(sandbox.env.USERPROFILE).toBe(sandbox.home)
    // 沙箱自身注入的 CLAUDE_ 前缀变量（离线开关）是唯一允许的例外
    const allowedClaudeKeys = new Set(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])
    for (const key of Object.keys(sandbox.env)) {
      expect(key.startsWith('ANTHROPIC_')).toBe(false)
      if (key.startsWith('CLAUDE_')) {
        expect(allowedClaudeKeys.has(key)).toBe(true)
      }
    }
    expect(sandbox.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  })

  test('cleanup removes sandbox directory', async () => {
    const sandbox = await createSandbox()
    await sandbox.cleanup()
    try {
      await stat(sandbox.home)
      expect(true).toBe(false) // Should not reach here
    } catch (err: any) {
      expect(err.code).toBe('ENOENT')
    }
  })
})
