import { expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'

const DIST_MAIN = join(import.meta.dir, '..', 'dist', 'main.js')
const distTest = existsSync(DIST_MAIN) ? test : test.skip

async function runDist(args: string[], configDir: string) {
  const env = { ...process.env, HOME: configDir, CLAUDE_CONFIG_DIR: configDir }
  delete env.NODE_ENV
  const child = Bun.spawn([process.execPath, DIST_MAIN, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

distTest('dist ps fast paths exit without a DevTools WebSocket error', async () => {
  const configDir = await mkdtemp('/tmp/background-dist-test-')
  try {
    const plain = await runDist(['ps'], configDir)
    expect(plain).toEqual({ exitCode: 0, stdout: '', stderr: '' })

    const json = await runDist(['ps', '--json'], configDir)
    expect(json.exitCode).toBe(0)
    expect(json.stderr).toBe('')
    expect(JSON.parse(json.stdout)).toEqual({
      version: 'background-sessions-v1',
      sessions: [],
    })

    const help = await runDist(['ps', '--help'], configDir)
    expect(help).toEqual({
      exitCode: 0,
      stdout: 'Usage: claude ps [--json]\n',
      stderr: '',
    })
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
}, 30_000)
