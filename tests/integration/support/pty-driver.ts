import { join } from 'path'
import { tmpdir } from 'os'
import { stat } from 'fs/promises'

export interface PtyOptions {
  cmd: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface PtySession {
  write(data: string): void
  waitFor(pattern: RegExp | string, timeoutMs?: number): Promise<string>
  output(): string
  rawOutput(): string
  exited(): Promise<number>
  kill(signal?: NodeJS.Signals): Promise<number>
}

let cachedPtyrunPath: string | null = null

async function ensurePtyrun(): Promise<string> {
  if (cachedPtyrunPath) {
    try {
      await stat(cachedPtyrunPath)
      return cachedPtyrunPath
    } catch {
      // Cached path missing, recompile
      cachedPtyrunPath = null
    }
  }

  const ptyrunCPath = join(import.meta.dir, 'ptyrun.c')
  const targetPath = join(tmpdir(), 'flash-it-ptyrun')

  let needsCompile = false
  try {
    const cStat = await stat(ptyrunCPath)
    try {
      const binStat = await stat(targetPath)
      if (binStat.mtime < cStat.mtime) {
        needsCompile = true
      }
    } catch {
      needsCompile = true
    }
  } catch {
    throw new Error(`ptyrun.c not found at ${ptyrunCPath}`)
  }

  if (needsCompile) {
    const compileProc = Bun.spawn({
      cmd: ['cc', '-o', targetPath, ptyrunCPath],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(compileProc.stdout).text(),
      new Response(compileProc.stderr).text(),
      compileProc.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(`Failed to compile ptyrun.c: ${stderr || stdout}`)
    }
  }

  cachedPtyrunPath = targetPath
  return targetPath
}

export async function spawnPty(opts: PtyOptions): Promise<PtySession> {
  const ptyrunPath = await ensurePtyrun()

  const ptyrunArgs: string[] = []
  if (opts.cols !== undefined || opts.rows !== undefined) {
    if (opts.cols !== undefined) {
      ptyrunArgs.push('--cols', String(opts.cols))
    }
    if (opts.rows !== undefined) {
      ptyrunArgs.push('--rows', String(opts.rows))
    }
  }

  const proc = Bun.spawn({
    cmd: [ptyrunPath, ...ptyrunArgs, ...opts.cmd],
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let buffer = ''
  const decoder = new TextDecoder()

  void (async () => {
    const reader = proc.stdout.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
    } catch {
      // Reader may be interrupted when process exits, normal path
    }
  })()
  void (async () => {
    const reader = proc.stderr.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
      }
    } catch {
      // Same as above
    }
  })()

  const exited = proc.exited.then(() => proc.exitCode ?? -1)

  async function waitFor(pattern: RegExp | string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const matched = typeof pattern === 'string' ? buffer.includes(pattern) : pattern.test(buffer)
      if (matched) return buffer
      if (Date.now() > deadline) {
        const tail = buffer.length > 4000 ? buffer.slice(-4000) : buffer
        throw new Error(
          `waitFor timeout (${timeoutMs}ms) for ${pattern}\n--- output tail ---\n${tail}`,
        )
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  return {
    write(data: string): void {
      proc.stdin.write(data)
    },
    waitFor,
    output: () => buffer,
    rawOutput: () => buffer,
    exited: () => exited,
    async kill(signal?: NodeJS.Signals): Promise<number> {
      try { proc.kill(signal) } catch { /* Already exited */ }
      await exited.catch(() => {})
      return proc.exitCode ?? -1
    },
  }
}
