import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { resolve } from 'path'

export type BackendPermissionMode = 'default' | 'bypassPermissions'

export type BackendCreateOptions = {
  sessionId: string
  cwd: string
  resumeTranscriptId?: string
  permissionMode?: BackendPermissionMode
}

export type ProcessBackendOptions = {
  /** Executable used to launch the CLI. Defaults to the current Bun/Node binary. */
  executable?: string
  /** Arguments placed before the CLI's print-mode arguments (for example main.js). */
  executableArgs?: string[]
  /** Explicit environment additions. Connect/runner variables are always removed. */
  env?: Record<string, string | undefined>
  stopTimeoutMs?: number
}

const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

function cleanEnv(
  additions: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of INHERITED_ENV) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (value !== undefined) env[key] = value
  }
  for (const key of Object.keys(env)) {
    if (
      key === 'CLAUDE_CODE_SESSION_KIND' ||
      key === 'CLAUDE_CODE_REMOTE' ||
      key === 'CLAUDE_CODE_ENTRYPOINT' ||
      key === 'CLAUDE_CODE_MESSAGING_SOCKET' ||
      key.startsWith('CLAUDE_CODE_SSH') ||
      key.startsWith('CLAUDE_DIRECT_CONNECT') ||
      key.startsWith('CLAUDE_CODE_DIRECT_CONNECT') ||
      key.includes('RUNNER')
    ) {
      delete env[key]
    }
  }
  return env
}

function safeStderrTail(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/(token|auth_token)=[^\s&]+/gi, '$1=[redacted]')
    .split('\n')
    .slice(-20)
    .join('\n')
    .slice(-8192)
}

/** A single long-lived stream-json CLI process. */
export class BackendSession extends EventEmitter {
  private stderr = ''
  private stopping: Promise<void> | null = null

  constructor(
    readonly sessionId: string,
    readonly process: ChildProcess,
    private readonly stopTimeoutMs: number,
  ) {
    super()
    let stdoutBuffer = ''
    process.stdout?.setEncoding('utf8')
    process.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      // Keep a malformed/oversized subprocess line from growing without bound.
      if (stdoutBuffer.length > 4 * 1024 * 1024 && !stdoutBuffer.includes('\n')) {
        this.emit('stderr', 'Subprocess output line exceeded 4 MiB')
        stdoutBuffer = ''
        return
      }
      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline)
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line.trim()) this.emit('stdout', line)
        newline = stdoutBuffer.indexOf('\n')
      }
    })
    process.stderr?.setEncoding('utf8')
    process.stderr?.on('data', (chunk: string) => {
      this.stderr = safeStderrTail(this.stderr + chunk)
      this.emit('stderr', chunk)
    })
    process.on('error', error => this.emit('error', error))
    process.on('exit', (code, signal) => {
      if (stdoutBuffer.trim()) this.emit('stdout', stdoutBuffer)
      this.emit('exit', { code, signal, stderr: this.stderrTail() })
    })
  }

  get pid(): number | undefined {
    return this.process.pid
  }

  stderrTail(): string {
    return this.stderr
  }

  write(message: string): void {
    if (!this.process.stdin?.writable) {
      throw new Error('Session process stdin is closed')
    }
    this.process.stdin.write(message.endsWith('\n') ? message : `${message}\n`)
  }

  interrupt(): void {
    // The stream-json control request is handled by SessionManager. This method
    // exists for backend parity and deliberately does not use SIGINT, which
    // would kill the long-lived process instead of interrupting one turn.
    this.emit('interrupt')
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = new Promise(resolveStop => {
      if (this.process.exitCode !== null || this.process.signalCode !== null) {
        resolveStop()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveStop()
      }
      const timer = setTimeout(() => {
        if (this.process.exitCode === null && this.process.signalCode === null) {
          // ChildProcess.kill targets the spawned handle, not a registry PID.
          this.process.kill('SIGKILL')
        }
        finish()
      }, this.stopTimeoutMs)
      timer.unref()
      this.process.once('exit', finish)
      this.process.kill('SIGTERM')
    })
    return this.stopping
  }
}

/**
 * Default backend. It never adds a permission bypass flag; callers must opt in
 * explicitly through DangerousBackend as well as the server configuration.
 */
export class ProcessBackend extends EventEmitter {
  protected readonly sessions = new Map<string, BackendSession>()
  private readonly options: ProcessBackendOptions

  constructor(options: ProcessBackendOptions = {}) {
    super()
    this.options = options
  }

  protected allowsDangerousMode(): boolean {
    return false
  }

  async create(options: BackendCreateOptions): Promise<BackendSession> {
    if (this.sessions.has(options.sessionId)) {
      throw new Error('Session process already exists')
    }
    const dangerous = options.permissionMode === 'bypassPermissions'
    if (dangerous && !this.allowsDangerousMode()) {
      throw new Error('Dangerous permission mode is disabled')
    }
    const args = [
      ...this.options.executableArgs ??
        (process.argv[1] ? [resolve(process.argv[1])] : []),
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ]
    if (options.resumeTranscriptId) {
      args.push('--resume', options.resumeTranscriptId)
    } else {
      args.push('--session-id', options.sessionId)
    }
    if (dangerous) args.push('--dangerously-skip-permissions')
    else args.push('--permission-mode', 'default')

    const child = spawn(this.options.executable ?? process.execPath, args, {
      cwd: options.cwd,
      env: cleanEnv(this.options.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn)
      child.once('error', rejectSpawn)
    })
    const session = new BackendSession(
      options.sessionId,
      child,
      this.options.stopTimeoutMs ?? 5_000,
    )
    this.sessions.set(options.sessionId, session)
    session.once('exit', event => {
      this.sessions.delete(options.sessionId)
      this.emit('exit', options.sessionId, event)
    })
    return session
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => session.stop()))
    this.sessions.clear()
  }
}
