import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join, resolve } from 'path'
import {
  getAssistantSystemPromptAddendum,
  isAssistantForced,
  isAssistantMode,
  markAssistantForced,
} from '../src/assistant/index.ts'
import { PRSubscriptionManager } from '../src/services/prSubscriptions.ts'
import { registerDreamSkill } from '../src/skills/bundled/dream.ts'
import { getBundledSkills } from '../src/skills/bundledSkills.ts'
import { PushNotificationTool } from '../src/tools/PushNotificationTool/PushNotificationTool.ts'
import { SendUserFileTool } from '../src/tools/SendUserFileTool/SendUserFileTool.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { getCommandQueueSnapshot, resetCommandQueue } from '../src/utils/messageQueueManager.ts'

afterEach(() => {
  resetCommandQueue()
})

describe('assistant mode', () => {
  test('tracks forced activation and provides team guidance', () => {
    expect(markAssistantForced()).toBe(true)
    expect(markAssistantForced()).toBe(false)
    expect(isAssistantForced()).toBe(true)
    expect(isAssistantMode()).toBe(true)
    expect(getAssistantSystemPromptAddendum()).toContain('in-process assistant team')
  })

  test('initializes a real team in an isolated config directory', async () => {
    const configDir = await mkdtemp(join('/tmp', 'claude-assistant-team-'))
    const root = resolve(import.meta.dir, '..')
    try {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          '-e',
          "const { initializeAssistantTeam } = await import('./src/assistant/index.ts'); const team = await initializeAssistantTeam(); console.log('ASSISTANT_TEAM=' + JSON.stringify(team))",
        ],
        cwd: root,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_API_KEY: 'offline-test-placeholder',
          NODE_ENV: 'production',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, stderr).toBe(0)
      const line = stdout.split('\n').find(value => value.startsWith('ASSISTANT_TEAM='))
      const team = JSON.parse(line!.slice('ASSISTANT_TEAM='.length))
      const config = JSON.parse(await readFile(team.teamFilePath, 'utf8'))
      expect(config.leadSessionId).toBeTruthy()
      expect(config.members).toHaveLength(1)
      expect(team.teamName).toMatch(/^assistant-/)
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  }, 20_000)

  test('registers the dream consolidation prompt', async () => {
    registerDreamSkill()
    const dream = getBundledSkills().find(skill => skill.name === 'dream')
    expect(dream).toBeDefined()
    if (dream?.type !== 'prompt') return
    const prompt = await dream.getPromptForCommand('focus on tests', {} as ToolUseContext)
    expect(JSON.stringify(prompt)).toContain('Memory Consolidation')
    expect(JSON.stringify(prompt)).toContain('focus on tests')
  })
})

describe('notification and PR adapters', () => {
  test('uses the OS notification adapter and reports missing adapters', async () => {
    const sendOSNotification = mock(() => {})
    const context = { sendOSNotification } as ToolUseContext
    const result = await PushNotificationTool.call(
      { message: 'Tests passed', title: 'CI' },
      context,
    )
    expect(result.data.deliveredVia).toBe('os')
    expect(sendOSNotification).toHaveBeenCalledWith({
      message: 'CI: Tests passed',
      notificationType: 'info',
    })
    await expect(
      PushNotificationTool.call({ message: 'no adapter' }, {} as ToolUseContext),
    ).rejects.toThrow('No notification adapter')
  })

  test('requires a bridge before attempting file upload', async () => {
    await expect(
      SendUserFileTool.call({ file_path: 'package.json' }, {} as ToolUseContext),
    ).rejects.toThrow('Remote Control bridge')
  })

  test('baselines, deduplicates, and unsubscribes PR events', async () => {
    const comments: Array<{ id: number; body: string }> = []
    const fetchJson = mock(async (endpoint: string) => {
      if (endpoint.endsWith('/pulls/1') && !endpoint.includes('reviews')) {
        return { head: { sha: 'abc' } }
      }
      if (endpoint.includes('/comments')) return comments
      if (endpoint.includes('/reviews')) return []
      if (endpoint.includes('/check-runs')) return { check_runs: [] }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    })
    const manager = new PRSubscriptionManager(fetchJson as never, 60_000)
    expect(await manager.subscribe('owner/repo', 1)).toBe(true)
    expect(getCommandQueueSnapshot()).toHaveLength(0)

    comments.push({ id: 1, body: 'new review comment' })
    expect(await manager.poll('owner/repo#1')).toHaveLength(1)
    expect(getCommandQueueSnapshot()[0]?.value).toContain('new review comment')
    expect(await manager.poll('owner/repo#1')).toHaveLength(0)
    expect(manager.unsubscribe('owner/repo#1')).toBe(true)
    expect(manager.list()).toEqual([])
  })
})
