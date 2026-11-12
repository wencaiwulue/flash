import { randomUUID } from 'crypto'
import { PERMISSION_MODES } from '../types/permissions.js'
import { SSHSessionError } from './errors.js'

export type SSHTarget = 'linux-x64' | 'linux-arm64'

export type SSHProbe = {
  home: string
  kernel: 'Linux'
  machine: string
  libc: 'glibc'
  cwd: string
  sha256: 'sha256sum' | 'shasum -a 256'
  uid: number
  target: SSHTarget
}

export type SSHCliConfig = {
  permissionMode?: string
  dangerouslySkipPermissions: boolean
  extraCliArgs: string[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:+\-[\]]{0,127}$/
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const SAFE_REMOTE_ABSOLUTE_PATH_RE = /^\/[A-Za-z0-9_./+-]+$/

function invalid(message: string): never {
  throw new SSHSessionError('SSH_INVALID_ARGUMENT', message)
}

export function validateSSHHost(host: string): string {
  if (
    !host ||
    host.length > 320 ||
    host.startsWith('-') ||
    !/^[A-Za-z0-9_][A-Za-z0-9._@%+:[\]-]*$/.test(host) ||
    /[\s/\\;`$()<>&|]/.test(host)
  ) {
    invalid(`Invalid SSH host: ${JSON.stringify(host)}`)
  }
  return host
}

export function validateRemoteCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (!cwd || cwd.length > 4096 || /[\0\r\n]/.test(cwd)) {
    invalid('Remote working directory must be non-empty and contain no NUL/newline')
  }
  return cwd
}

export function validateVersion(version: string): string {
  if (!VERSION_RE.test(version)) invalid('Invalid local artifact version')
  return version
}

export function posixQuote(value: string): string {
  if (/\0/.test(value)) invalid('NUL is not valid in a remote command')
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function validateExtraCliArgs(extraCliArgs: string[]): {
  continueSession: boolean
  resumeSessionId?: string
  model?: string
} {
  let continueSession = false
  let resumeSessionId: string | undefined
  let model: string | undefined
  let seenModel = false

  for (let i = 0; i < extraCliArgs.length; i++) {
    const arg = extraCliArgs[i]
    if (arg === '--continue' || arg === '-c') {
      if (continueSession) invalid('Duplicate --continue')
      continueSession = true
      continue
    }
    if (arg === '--resume') {
      const value = extraCliArgs[++i]
      if (resumeSessionId || !value || !UUID_RE.test(value)) {
        invalid('--resume requires exactly one valid session UUID')
      }
      resumeSessionId = value
      continue
    }
    if (arg === '--model') {
      const value = extraCliArgs[++i]
      if (seenModel || !value || !MODEL_RE.test(value)) invalid('Invalid --model value')
      seenModel = true
      model = value
      continue
    }
    invalid(`Argument is not allowed for SSH: ${arg ?? ''}`)
  }
  if (continueSession && resumeSessionId) {
    invalid('--continue and --resume cannot be used together')
  }
  return { continueSession, resumeSessionId, model }
}

export function validatePermissionMode(mode: string | undefined): string | undefined {
  if (mode === undefined) return undefined
  if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
    invalid(`Invalid permission mode: ${mode}`)
  }
  return mode
}

export function validateSessionId(sessionId: string): string {
  if (!UUID_RE.test(sessionId)) invalid('Invalid SSH session UUID')
  return sessionId
}

export function newSSHSessionId(): string {
  return randomUUID()
}

export function buildProbeCommand(cwd?: string): string {
  const requestedCwd = validateRemoteCwd(cwd)
  const cd = requestedCwd
    ? `cd -- ${posixQuote(requestedCwd)}`
    : 'cd -- "$HOME"'
  // JSON string escaping is deliberately small and fixed; the local parser
  // additionally requires absolute, newline-free home/cwd values.
  const script = `set -eu
${cd}
cwd=$(pwd -P)
home=$(CDPATH= cd -- "$HOME" && pwd -P)
kernel=$(uname -s)
machine=$(uname -m)
uid=$(id -u)
if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then libc=glibc; else libc=unknown; fi
if command -v sha256sum >/dev/null 2>&1; then sha256=sha256sum; elif command -v shasum >/dev/null 2>&1; then sha256='shasum -a 256'; else sha256=unknown; fi
json_string() { printf '"'; printf %s "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; printf '"'; }
printf 'CLAUDE_SSH_V1:{'
printf '"home":'; json_string "$home"
printf ',"kernel":'; json_string "$kernel"
printf ',"machine":'; json_string "$machine"
printf ',"libc":'; json_string "$libc"
printf ',"cwd":'; json_string "$cwd"
printf ',"sha256":'; json_string "$sha256"
printf ',"uid":%s}\n' "$uid"`
  return `sh -c ${posixQuote(script)}`
}

export function buildProbeArgv(host: string): string[] {
  return [
    '-T',
    '-n',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '--',
    validateSSHHost(host),
  ]
}

export function parseProbeOutput(stdout: string): SSHProbe {
  const marker = 'CLAUDE_SSH_V1:'
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
  if (lines.length !== 1 || stdout.split(marker).length !== 2) {
    throw new SSHSessionError(
      'SSH_PROBE_FAILED',
      'Remote probe did not return exactly one valid ssh-v1 record',
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(lines[0]!.slice(marker.length))
  } catch (cause) {
    throw new SSHSessionError('SSH_PROBE_FAILED', 'Remote probe returned invalid JSON', {
      cause,
    })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SSHSessionError('SSH_PROBE_FAILED', 'Remote probe returned an invalid schema')
  }
  const value = raw as Record<string, unknown>
  if (
    (value.kernel !== undefined && value.kernel !== 'Linux') ||
    (value.libc !== undefined && value.libc !== 'glibc')
  ) {
    throw new SSHSessionError(
      'SSH_UNSUPPORTED_TARGET',
      'SSH v1 supports only remote Linux targets using glibc',
    )
  }
  if (
    typeof value.home !== 'string' ||
    !SAFE_REMOTE_ABSOLUTE_PATH_RE.test(value.home) ||
    typeof value.cwd !== 'string' ||
    !SAFE_REMOTE_ABSOLUTE_PATH_RE.test(value.cwd) ||
    value.kernel !== 'Linux' ||
    typeof value.machine !== 'string' ||
    value.libc !== 'glibc' ||
    (value.sha256 !== 'sha256sum' && value.sha256 !== 'shasum -a 256') ||
    typeof value.uid !== 'number' ||
    !Number.isSafeInteger(value.uid) ||
    value.uid < 0
  ) {
    throw new SSHSessionError('SSH_PROBE_FAILED', 'Remote probe returned an invalid schema')
  }
  let target: SSHTarget
  switch (value.machine) {
    case 'x86_64':
    case 'amd64':
      target = 'linux-x64'
      break
    case 'aarch64':
    case 'arm64':
      target = 'linux-arm64'
      break
    default:
      throw new SSHSessionError(
        'SSH_UNSUPPORTED_TARGET',
        `Unsupported remote machine: ${value.machine}`,
      )
  }
  return {
    home: value.home,
    kernel: 'Linux',
    machine: value.machine,
    libc: 'glibc',
    cwd: value.cwd,
    sha256: value.sha256,
    uid: value.uid,
    target,
  }
}

export function buildMainSSHArgv(options: {
  host: string
  remoteSocket: string
  localSocket: string
  remoteCommand: string
}): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StreamLocalBindUnlink=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-R',
    `${options.remoteSocket}:${options.localSocket}`,
    '--',
    validateSSHHost(options.host),
    options.remoteCommand,
  ]
}

export function buildRemoteCLICommand(options: {
  cwd: string
  bunPath: string
  mainPath: string
  remoteSocket: string
  authPlaceholder: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'CLAUDE_CODE_OAUTH_TOKEN'
  cli: SSHCliConfig
  initialSessionId: string
  reconnectSessionId?: string
}): string {
  const parsed = validateExtraCliArgs(options.cli.extraCliArgs)
  const mode = validatePermissionMode(options.cli.permissionMode)
  const sessionId = validateSessionId(
    options.reconnectSessionId ?? parsed.resumeSessionId ?? options.initialSessionId,
  )
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ]
  if (options.reconnectSessionId || parsed.resumeSessionId) {
    args.push('--resume', sessionId)
  } else {
    args.push('--session-id', sessionId)
    if (parsed.continueSession) args.push('--continue')
  }
  if (parsed.model) args.push('--model', parsed.model)
  if (mode) args.push('--permission-mode', mode)
  if (options.cli.dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions')
  }
  const placeholders: Record<typeof options.authPlaceholder, string> = {
    ANTHROPIC_API_KEY: 'ssh-api-key-placeholder',
    ANTHROPIC_AUTH_TOKEN: 'ssh-bearer-placeholder',
    CLAUDE_CODE_OAUTH_TOKEN: 'ssh-oauth-placeholder',
  }
  const unset = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
    'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'SESSION_INGRESS_URL',
    'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
    'CLAUDE_BRIDGE_SESSION_INGRESS_URL',
    'CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ]
  const envArgs = [
    ...unset.flatMap(name => ['-u', name]),
    `ANTHROPIC_UNIX_SOCKET=${options.remoteSocket}`,
    // The SDK runs on the other side of a local UDS. Bun attempts TLS for an
    // https URL even with `unix`, so use HTTP only on that private transport;
    // the local proxy still pins and upgrades the upstream connection to TLS.
    'ANTHROPIC_BASE_URL=http://api.anthropic.com',
    `${options.authPlaceholder}=${placeholders[options.authPlaceholder]}`,
    posixQuote(options.bunPath),
    posixQuote(options.mainPath),
    ...args.map(posixQuote),
  ]
  return `cd -- ${posixQuote(options.cwd)} && exec env ${envArgs.join(' ')}`
}

export function validateSocketPath(path: string): string {
  if (
    !path.startsWith('/') ||
    Buffer.byteLength(path) >= 100 ||
    !/^[A-Za-z0-9_./-]+$/.test(path)
  ) {
    invalid('SSH forwarding socket path is too long or contains unsafe characters')
  }
  return path
}

export function scpDestination(host: string, directory: string): string {
  validateSSHHost(host)
  if (!SAFE_REMOTE_ABSOLUTE_PATH_RE.test(directory)) invalid('Invalid remote upload path')
  const at = host.lastIndexOf('@')
  const user = at === -1 ? '' : host.slice(0, at + 1)
  const hostname = at === -1 ? host : host.slice(at + 1)
  const scpHost = hostname.includes(':') ? `[${hostname}]` : hostname
  return `${user}${scpHost}:${directory}/`
}
