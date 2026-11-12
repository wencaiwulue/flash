import { spawn } from 'child_process'
import { SSHSessionError, type SSHErrorCode } from './errors.js'

export const STDERR_LIMIT = 32 * 1024

export function redactSSHDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:x-api-key|api[_-]?key|oauth[_-]?token|auth[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-ant|sk-or|sk_live|sk-test)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, 'Bearer [REDACTED]')
}

export class StderrTail {
  private value = ''

  append(chunk: Buffer | string): void {
    this.value = redactSSHDiagnostic(this.value + chunk.toString()).slice(-STDERR_LIMIT)
  }

  get(): string {
    return this.value
  }
}

export type RunCommandOptions = {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  stdoutLimit?: number
}

export type CommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr = new StderrTail()
    let stdoutLength = 0
    let settled = false
    const stdoutLimit = options.stdoutLimit ?? 8 * 1024 * 1024
    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          child.kill('SIGTERM')
          settled = true
          reject(
            new SSHSessionError(
              'SSH_CONNECTION_LOST',
              `${command} timed out after ${options.timeoutMs}ms`,
            ),
          )
        }, options.timeoutMs)
      : undefined
    timer?.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length
      if (stdoutLength > stdoutLimit) {
        child.kill('SIGTERM')
        if (!settled) {
          settled = true
          reject(new SSHSessionError('SSH_PROBE_FAILED', `${command} output exceeded its limit`))
        }
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))
    child.on('error', cause => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(cause)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: stderr.get(),
      })
    })
  })
}

export function classifyOpenSSHFailure(
  result: CommandResult,
  fallback: SSHErrorCode,
): SSHSessionError {
  const diagnostic = result.stderr.slice(-STDERR_LIMIT)
  const lower = diagnostic.toLowerCase()
  let code = fallback
  if (
    lower.includes('host key verification failed') ||
    lower.includes('remote host identification has changed') ||
    lower.includes('no matching host key type')
  ) {
    code = 'SSH_HOST_KEY_FAILED'
  } else if (
    lower.includes('permission denied') ||
    lower.includes('authentication failed') ||
    lower.includes('too many authentication failures') ||
    lower.includes('host key verification failed')
  ) {
    code = 'SSH_AUTH_FAILED'
  } else if (fallback === 'SSH_PROBE_FAILED') {
    code = 'SSH_PROBE_FAILED'
  }
  const hint =
    code === 'SSH_AUTH_FAILED'
      ? 'Configure non-interactive authentication first with ssh <host> (agent/key/Kerberos). '
      : ''
  return new SSHSessionError(
    code,
    `${hint}OpenSSH exited with ${result.code ?? result.signal ?? 'an error'}${diagnostic ? `: ${diagnostic.trim()}` : ''}`,
  )
}
