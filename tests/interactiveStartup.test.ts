import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const distMain = join(import.meta.dir, '..', 'dist', 'main.js')
const CRASH_MARKERS = ['ResolveMessage', 'MODULE_NOT_FOUND', 'Cannot find module']

describe.skipIf(
  process.platform === 'win32' || !existsSync(distMain),
  'needs a unix pty and a prior bun run build',
)('interactive startup smoke', () => {
  test('dist build renders the version banner without crashing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'flash-pty-home-'))

    return new Promise<void>((resolve, reject) => {
      const proc = spawn('script', ['-q', '/dev/null', process.execPath, distMain], {
        cwd: join(import.meta.dir, '..'),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let output = ''
      const timer = setTimeout(() => {
        proc.kill()
      }, 20_000)

      const decoder = new TextDecoder()

      const onData = (data: Buffer) => {
        output += decoder.decode(data, { stream: true })
        if (/flash[^v]*v\d+\.\d+\.\d+/.test(output)) {
          proc.kill()
        }
      }

      proc.stdout.on('data', onData)
      proc.stderr.on('data', onData)

      proc.on('close', () => {
        clearTimeout(timer)
        try {
          expect(output).toMatch(/flash[^v]*v\d+\.\d+\.\d+/)
          for (const marker of CRASH_MARKERS) {
            expect(output).not.toContain(marker)
          }
          resolve()
        } catch (e) {
          reject(e)
        }
      })

      proc.on('error', reject)
    })
  }, 30_000)
})
