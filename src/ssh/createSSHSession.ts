import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { realpath } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { isInBundledMode } from '../utils/bundledMode.js'
import { deploySSHArtifact, loadSSHArtifact } from './artifact.js'
import {
  buildMainSSHArgv,
  buildProbeArgv,
  buildProbeCommand,
  buildRemoteCLICommand,
  newSSHSessionId,
  parseProbeOutput,
  validateExtraCliArgs,
  validatePermissionMode,
  validateRemoteCwd,
  validateSessionId,
  validateSocketPath,
  validateSSHHost,
  type SSHCliConfig,
  type SSHProbe,
} from './argv.js'
import { SSHSessionError } from './errors.js'
import { classifyOpenSSHFailure, runCommand, StderrTail } from './openSSH.js'
import {
  createSSHAuthProxy,
  SSH_AUTH_ENV,
  SSH_PLACEHOLDERS,
  validateSSHAuthentication,
  type SSHAuthKind,
  type SSHAuthProxy,
  type SSHAuthProxyOptions,
} from './sshAuthProxy.js'
import {
  SSHSessionManager,
  type SSHManagedConnection,
  type SSHSessionCallbacks,
} from './SSHSessionManager.js'

export { SSHSessionError } from './errors.js'

export type SSHSession = {
  remoteCwd: string
  proc: ChildProcess
  proxy: { stop: () => void }
  getStderrTail: () => string
  createManager: (callbacks: SSHSessionCallbacks) => SSHSessionManager
}

export type CreateSSHSessionOptions = {
  host: string
  cwd?: string
  localVersion: string
  permissionMode?: string
  dangerouslySkipPermissions: boolean
  extraCliArgs: string[]
  artifactRoot?: string
  environment?: NodeJS.ProcessEnv
  socketDirectory?: string
  authProxy?: Pick<SSHAuthProxyOptions, 'resolveAuth' | 'upstream'>
}

export type CreateLocalSSHSessionOptions = {
  cwd?: string
  permissionMode?: string
  dangerouslySkipPermissions: boolean
  environment?: NodeJS.ProcessEnv
  socketDirectory?: string
  executablePath?: string
  cliPath?: string
  authProxy?: Pick<SSHAuthProxyOptions, 'resolveAuth' | 'upstream'>
}

const INGRESS_ENV = [
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

function assertLocalPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new SSHSessionError(
      'SSH_UNSUPPORTED_TARGET',
      'SSH sessions require a macOS or Linux local host',
    )
  }
}

function localSocketPath(directory: string | undefined, random: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return validateSocketPath(join(directory ?? tmpdir(), `claude-ssh-${uid}-${random}.sock`))
}

function spawnConnection(options: {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  proxy: SSHAuthProxy
}): SSHManagedConnection {
  const stderr = new StderrTail()
  const proc = spawn(options.command, options.args, {
    shell: false,
    env: options.env,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  proc.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk))
  return { proc, proxy: options.proxy, getStderrTail: () => stderr.get() }
}

async function startProxy(
  socketPath: string,
  options?: Pick<SSHAuthProxyOptions, 'resolveAuth' | 'upstream'>,
): Promise<SSHAuthProxy> {
  const proxy = createSSHAuthProxy({ socketPath, ...options })
  try {
    await proxy.ready
    return proxy
  } catch (cause) {
    proxy.stop()
    throw new SSHSessionError('AUTH_PROXY_FAILED', 'Unable to start local SSH auth proxy', {
      cause,
    })
  }
}

function managerForSession(
  session: SSHSession,
  initial: SSHManagedConnection,
  reconnect?: (activeSessionId: string) => Promise<SSHManagedConnection>,
): (callbacks: SSHSessionCallbacks) => SSHSessionManager {
  let current = initial
  return callbacks =>
    new SSHSessionManager(
      {
        connection: current,
        reconnect: reconnect
          ? async activeSessionId => {
              const next = await reconnect(activeSessionId)
              current = next
              session.proc = next.proc
              session.proxy = next.proxy
              return next
            }
          : undefined,
      },
      callbacks,
    )
}

export async function createSSHSession(
  options: CreateSSHSessionOptions,
  callbacks: { onProgress?: (message: string) => void },
): Promise<SSHSession> {
  assertLocalPlatform()
  const host = validateSSHHost(options.host)
  validateRemoteCwd(options.cwd)
  const parsedArgs = validateExtraCliArgs(options.extraCliArgs)
  validatePermissionMode(options.permissionMode)
  const env = options.environment ?? process.env
  const initialSessionId = parsedArgs.resumeSessionId ?? newSSHSessionId()
  const authKind = await validateSSHAuthentication(options.authProxy?.resolveAuth)

  callbacks.onProgress?.('Probing remote host')
  const probeResult = await runCommand(
    'ssh',
    [...buildProbeArgv(host), buildProbeCommand(options.cwd)],
    { env, timeoutMs: 30_000 },
  )
  if (probeResult.code !== 0) {
    throw classifyOpenSSHFailure(probeResult, 'SSH_PROBE_FAILED')
  }
  const probe = parseProbeOutput(probeResult.stdout)

  callbacks.onProgress?.(`Validating ${probe.target} artifact`)
  const artifact = await loadSSHArtifact({
    artifactRoot:
      options.artifactRoot ?? join(homedir(), '.claude', 'ssh', 'artifacts'),
    version: options.localVersion,
    target: probe.target,
  })
  callbacks.onProgress?.('Deploying verified artifact')
  const artifactDirectory = await deploySSHArtifact({
    host,
    probe,
    artifact,
    commandOptions: { env },
  })
  const cli: SSHCliConfig = {
    permissionMode: options.permissionMode,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    extraCliArgs: options.extraCliArgs,
  }

  const launch = async (reconnectSessionId?: string): Promise<SSHManagedConnection> => {
    const random = randomBytes(12).toString('hex')
    const localSocket = localSocketPath(options.socketDirectory, random)
    const remoteSocket = validateSocketPath(`/tmp/claude-ssh-${probe.uid}-${random}.sock`)
    const proxy = await startProxy(localSocket, options.authProxy)
    const remoteCommand = buildRemoteCLICommand({
      cwd: probe.cwd,
      bunPath: `${artifactDirectory}/bun`,
      mainPath: `${artifactDirectory}/main.js`,
      remoteSocket,
      authPlaceholder: SSH_AUTH_ENV[authKind],
      cli,
      initialSessionId,
      reconnectSessionId,
    })
    return spawnConnection({
      command: 'ssh',
      args: buildMainSSHArgv({ host, remoteSocket, localSocket, remoteCommand }),
      env,
      proxy,
    })
  }

  callbacks.onProgress?.('Starting remote session')
  const initial = await launch()
  let sessionConnection = initial
  const session = {
    remoteCwd: probe.cwd,
    proc: initial.proc,
    proxy: initial.proxy,
    getStderrTail: () => sessionConnection.getStderrTail?.() ?? '',
    createManager: (_callbacks: SSHSessionCallbacks): SSHSessionManager => {
      throw new SSHSessionError('SSH_INVALID_ARGUMENT', 'SSH manager is not initialized')
    },
  } satisfies SSHSession
  session.createManager = managerForSession(session, initial, async activeSessionId => {
    if (!activeSessionId) {
      const next = await launch()
      sessionConnection = next
      return next
    }
    validateSessionId(activeSessionId)
    const next = await launch(activeSessionId)
    sessionConnection = next
    return next
  })
  return session
}

function localEnvironment(
  source: NodeJS.ProcessEnv,
  socketPath: string,
  kind: SSHAuthKind,
): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const name of INGRESS_ENV) delete env[name]
  env.ANTHROPIC_UNIX_SOCKET = socketPath
  // HTTP is scoped to the private UDS only; sshAuthProxy upgrades upstream to TLS.
  env.ANTHROPIC_BASE_URL = 'http://api.anthropic.com'
  env[SSH_AUTH_ENV[kind]] = SSH_PLACEHOLDERS[kind]
  return env
}

export async function createLocalSSHSession(
  options: CreateLocalSSHSessionOptions,
): Promise<SSHSession> {
  assertLocalPlatform()
  validatePermissionMode(options.permissionMode)
  const cwd = await realpath(options.cwd ?? process.cwd())
  const env = options.environment ?? process.env
  const authKind = await validateSSHAuthentication(options.authProxy?.resolveAuth)
  const random = randomBytes(12).toString('hex')
  const socketPath = localSocketPath(options.socketDirectory, random)
  const proxy = await startProxy(socketPath, options.authProxy)
  const sessionId = newSSHSessionId()
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--session-id',
    sessionId,
  ]
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
  if (options.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions')

  const bundled = options.executablePath ? false : isInBundledMode()
  const executable = options.executablePath ?? process.execPath
  const cliPath = options.cliPath ?? process.argv[1]
  if (!bundled && !cliPath) {
    proxy.stop()
    throw new SSHSessionError('SSH_INVALID_ARGUMENT', 'Cannot locate the current CLI entrypoint')
  }
  const initial = spawnConnection({
    command: executable,
    args: [...(bundled ? [] : [cliPath!]), ...args],
    env: localEnvironment(env, socketPath, authKind),
    cwd,
    proxy,
  })
  const session = {
    remoteCwd: cwd,
    proc: initial.proc,
    proxy: initial.proxy,
    getStderrTail: () => initial.getStderrTail?.() ?? '',
    createManager: (_callbacks: SSHSessionCallbacks): SSHSessionManager => {
      throw new SSHSessionError('SSH_INVALID_ARGUMENT', 'SSH manager is not initialized')
    },
  } satisfies SSHSession
  session.createManager = managerForSession(session, initial)
  return session
}
