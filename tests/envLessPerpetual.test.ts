import { expect, test } from 'bun:test'
import { resolve } from 'path'

const root = resolve(import.meta.dir, '..')

test('env-less perpetual resume, recovery, and archive pass in an isolated process', async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, resolve(root, 'tests/fixtures/env-less-perpetual-check.ts')],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  expect(stdout).toContain('ENV_LESS_PERPETUAL_OK')
}, 30_000)
