import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
const outdir = await mkdtemp(join(tmpdir(), 'claude-enabled-features-'))

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true })
})

describe('enabled feature profile', () => {
  test(
    'includes real trigger, remote, voice, and brief implementations',
    async () => {
      // Bun's test runner intercepts in-process build imports differently from
      // the standalone runtime. Verify the actual bundle in a clean Bun process.
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          join(root, 'tests/fixtures/verify-enabled-features.ts'),
          outdir,
        ],
        cwd: root,
        env: {
          ...process.env,
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
        const output = stdout
          .split('\n')
          .find(line => line.startsWith('FEATURE_PROFILE='))
        expect(output).toBeDefined()
        const profile = JSON.parse(output!.slice('FEATURE_PROFILE='.length))

        expect(profile.toolCount, JSON.stringify(profile)).toBe(36)
        expect(profile.nullCount).toBe(0)
        expect(profile.toolNames).toEqual(
          expect.arrayContaining([
            'CronCreate',
            'CronDelete',
            'CronList',
            'RemoteTrigger',
            'Monitor',
            'OverflowTest',
            'TerminalCapture',
            'Sleep',
            'ToolSearch',
            'DiscoverSkills',
            'ListPeers',
            'Workflow',
            'CtxInspect',
          ]),
        )
        expect(profile.sleepInitiallyEnabled).toBe(false)
        expect(profile.proactiveActive).toBe(true)
        expect(profile.sleepWhenActive).toBe(true)
        expect(profile.workerType).toBe('worker')
        expect(profile.workerBackground).toBe(true)
        expect(profile.workerHasBash).toBe(true)
        expect(profile.workerHasAgent).toBe(false)
        expect(profile.reactiveCompactEnabled).toBe(true)
        expect(profile.hasProactiveCommand).toBe(true)
        expect(profile.hasPeersCommand).toBe(true)
        expect(profile.hasRemoteControlServerCommand).toBe(true)
        expect(profile.hasWorkflowsCommand).toBe(true)
        expect(profile.hasUltraplan).toBe(true)
        expect(profile.hasVoice).toBe(true)
        expect(profile.hasBrief).toBe(true)
      } finally {
        clearTimeout(timeout)
        if (child.exitCode === null) child.kill()
      }
    },
    180_000,
  )
})
