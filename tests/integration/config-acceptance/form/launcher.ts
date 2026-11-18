import { join } from 'path'
import { distMainPath } from '../../support/dist-fixture.ts'
import { spawnPty, type PtySession } from '../../support/pty-driver.ts'
import { MOCK_API_KEY } from '../../support/mock-anthropic.ts'
import { stripAnsi } from '../../support/ansi.ts'
import type { Sandbox } from '../../support/sandbox.ts'

export type Form = 'dist' | 'source'

export interface PrintResult { out: string; err: string; code: number }

export interface Launcher {
  form: Form
  runPrint(args: string[], sandbox: Sandbox, mockUrl: string): Promise<PrintResult>
  spawnRepl(opts: { sandbox: Sandbox; mockUrl: string; cols?: number; rows?: number }): Promise<PtySession>
  managedEnv(sandbox: Sandbox): Record<string, string> | null
}

export function skipLine(kind: string, id: string): string {
  return `SKIP [${kind}] ${id}`
}

const repoRoot = join(import.meta.dir, '..', '..', '..', '..')

async function sourceCliPath(): Promise<string> {
  return join(repoRoot, 'src', 'entrypoints', 'cli.tsx')
}

function baseChildEnv(sandbox: Sandbox, mockUrl: string, form: Form): Record<string, string> {
  const env: Record<string, string> = {
    ...sandbox.env,
    ANTHROPIC_API_KEY: MOCK_API_KEY,
    ANTHROPIC_BASE_URL: mockUrl,
  }
  if (form === 'source') {
    env.USER_TYPE = 'ant'
    env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = sandbox.managedDir
  }
  return env
}

export function createFormLauncher(form: Form): Launcher {
  return {
    form,
    async runPrint(args, sandbox, mockUrl) {
      const entry = form === 'dist' ? await distMainPath() : await sourceCliPath()
      const proc = Bun.spawn([process.execPath, entry, ...args], {
        cwd: sandbox.project,
        env: baseChildEnv(sandbox, mockUrl, form),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = await new Response(proc.stdout).text()
      const err = await new Response(proc.stderr).text()
      const code = await proc.exited
      return { out: stripAnsi(out), err: stripAnsi(err), code }
    },
    async spawnRepl(opts) {
      const entry = form === 'dist' ? await distMainPath() : await sourceCliPath()
      return spawnPty({
        cmd: [process.execPath, entry],
        cwd: opts.sandbox.project,
        cols: opts.cols,
        rows: opts.rows,
        env: baseChildEnv(opts.sandbox, opts.mockUrl, form),
      })
    },
    managedEnv(sandbox) {
      if (form !== 'source') return null
      return { USER_TYPE: 'ant', CLAUDE_CODE_MANAGED_SETTINGS_PATH: sandbox.managedDir }
    },
  }
}
