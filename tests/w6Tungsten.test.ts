import { describe, expect, test } from 'bun:test'
import { join } from 'path'

describe('Tungsten isolated unit suite', () => {
  test('runs mocked tmux and Ink checks without polluting other test modules', async () => {
    const child = Bun.spawn([
      process.execPath,
      'test',
      join(process.cwd(), 'tests/w6TungstenFixture.tsx'),
    ], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`Tungsten fixture failed:\n${stdout}\n${stderr}`)
    expect(stdout + stderr).toContain('5 pass')
    expect(stderr).not.toContain('(fail)')
    expect(exitCode).toBe(0)
  }, 30_000)
})
