import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
const outdir = await mkdtemp(join(tmpdir(), 'claude-enabled-features-'))

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true })
})

async function runFeatureProfile(overrides: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(root, 'tests/fixtures/verify-enabled-features.ts'), outdir],
    cwd: root,
    env: {
      ...process.env,
      ...overrides,
      ANTHROPIC_API_KEY: 'offline-test-placeholder',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ENABLE_TOOL_SEARCH: 'true',
      NODE_ENV: 'production',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill(), 120_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const output = stdout.split('\n').find(line => line.startsWith('FEATURE_PROFILE='))
    expect(output).toBeDefined()
    return JSON.parse(output!.slice('FEATURE_PROFILE='.length))
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
  }
}

describe('enabled feature profile', () => {
  test(
    'includes real trigger, remote, voice, and brief implementations',
    async () => {
      const profile = await runFeatureProfile()
      expect(profile.toolCount, JSON.stringify(profile)).toBe(42)
      expect(profile.nullCount).toBe(0)
      expect(profile.toolNames).toEqual(expect.arrayContaining([
        'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'Monitor',
        'OverflowTest', 'TerminalCapture', 'Sleep', 'ToolSearch', 'DiscoverSkills',
        'ListPeers', 'Workflow', 'CtxInspect', 'Snip', 'ReviewArtifact',
        'SendUserFile', 'PushNotification', 'SubscribePR', 'WebBrowser',
      ]))
      expect(profile.sleepInitiallyEnabled).toBe(false)
      expect(profile.proactiveActive).toBe(true)
      expect(profile.sleepWhenActive).toBe(true)
      expect(profile.workerType).toBe('worker')
      expect(profile.workerBackground).toBe(true)
      expect(profile.workerHasBash).toBe(true)
      expect(profile.workerHasAgent).toBe(false)
      expect(profile.reactiveCompactEnabled).toBe(true)
      for (const key of [
        'hasHunterSkill', 'hasProactiveCommand', 'hasPeersCommand',
        'hasRemoteControlServerCommand', 'hasWorkflowsCommand', 'hasBuddyCommand',
        'hasForkCommand', 'hasForceSnipCommand', 'hasAssistantCommand',
        'hasUltraplan', 'hasVoice', 'hasBrief',
      ]) {
        expect(profile[key]).toBe(true)
      }
    },
    180_000,
  )

  test('produces the same profile under different outer environments', async () => {
    const normal = await runFeatureProfile()
    const overridden = await runFeatureProfile({
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      ENABLE_TOOL_SEARCH: 'false',
    })
    expect(overridden).toEqual(normal)
  }, 240_000)
})
