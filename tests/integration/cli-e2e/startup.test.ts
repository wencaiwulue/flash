
import { describe, test, expect } from 'bun:test'
import { distMainPath } from '../support/dist-fixture.ts'
import { createSandbox } from '../support/sandbox.ts'
import { spawnPty } from '../support/pty-driver.ts'
import { stripAnsi } from '../support/ansi.ts'

describe('CLI startup and exit', () => {
  test('--version prints semver and exits 0', async () => {
    const main = await distMainPath()
    const proc = Bun.spawn([process.execPath, main, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(stripAnsi(out)).toMatch(/\d+\.\d+\.\d+/)
  })

  test('--help exits 0 and prints usage', async () => {
    const main = await distMainPath()
    const proc = Bun.spawn([process.execPath, main, '--help'], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(stripAnsi(out)).toContain('Usage')
  })

  test('interactive startup renders banner and double Ctrl+C exits', { timeout: 60_000 }, async () => {
    const sandbox = await createSandbox()
    try {
      const session = await spawnPty({
        cmd: [process.execPath, await distMainPath()],
        cwd: sandbox.project,
        // Don't set ANTHROPIC_API_KEY to avoid dialog. CI mode changes startup
        // behavior, so this interactive PTY test explicitly runs without it.
        env: { ...sandbox.env, CI: '' },
      })
      try {
        // Wait for the banner which has "flash"
        await session.waitFor(/flash/, 30_000)
        // Send double Ctrl+C: first clears input line, second exits
        session.write('\x03')
        await new Promise(r => setTimeout(r, 300))
        session.write('\x03')
        const code = await session.exited()
        // Accept 0 or 130
        expect([0, 130]).toContain(code)
      } finally {
        await session.kill().catch(() => {})
      }
    } finally {
      await sandbox.cleanup()
    }
  })
})
