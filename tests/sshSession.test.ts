import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { deploySSHArtifact, loadSSHArtifact } from '../src/ssh/artifact.ts'
import {
  buildMainSSHArgv,
  buildRemoteCLICommand,
  parseProbeOutput,
  posixQuote,
  validateExtraCliArgs,
  validateSSHHost,
  type SSHProbe,
} from '../src/ssh/argv.ts'
import { createSSHSession } from '../src/ssh/createSSHSession.ts'
import { SSHSessionError } from '../src/ssh/errors.ts'
import {
  SSHSessionManager,
  type SSHManagedConnection,
  type SSHSessionCallbacks,
} from '../src/ssh/SSHSessionManager.ts'

let root: string
let fixturePath: string
const children = new Set<ChildProcess>()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-ssh-session-'))
  fixturePath = join(root, 'manager-fixture.ts')
  await writeFile(
    fixturePath,
    `const sessionId = process.env.FIXTURE_SESSION_ID!
const log = process.env.FIXTURE_LOG
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\\n')
const init = JSON.stringify({type:'system',subtype:'init',session_id:sessionId}) + '\\n'
if (process.env.DELAY_INIT) await Bun.sleep(Number(process.env.DELAY_INIT))
if (process.env.CHUNK_INIT) {
  process.stdout.write(init.slice(0, 17))
  await Bun.sleep(10)
  process.stdout.write(init.slice(17))
} else if (!process.env.NO_INIT) process.stdout.write(init)
if (process.env.STDERR_SECRET) process.stderr.write('authorization: Bearer super-secret-token-value\\n')
if (process.env.HOST_KEY_FAILURE) {
  process.stderr.write('Host key verification failed.\\n')
  setTimeout(() => process.exit(255), 20)
}
if (process.env.INVALID_JSON) process.stdout.write('{not-json\\n')
if (process.env.PERMISSION) {
  const request = {tool_name:'Bash',input:{command:'pwd'},tool_use_id:'tool-1',description:'test'}
  write({type:'control_request',request_id:'req-1',request:{subtype:'can_use_tool',...request}})
  write({type:'control_request',request_id:'req-1',request:{subtype:'can_use_tool',...request}})
  write({type:'control_request',request_id:'req-2',request:{subtype:'can_use_tool',...request,tool_use_id:'tool-2'}})
  write({type:'control_request',request_id:'req-1',request:{subtype:'can_use_tool',...request,input:{command:'different'}}})
  write({type:'control_request',request_id:'unknown-1',request:{subtype:'unknown_future_control'}})
}
if (process.env.DROP_AFTER_INIT) setTimeout(() => process.exit(1), 20)
if (process.env.EXIT_ZERO) setTimeout(() => process.exit(0), 20)
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk.toString()
  while (buffer.includes('\\n')) {
    const index = buffer.indexOf('\\n')
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (log) appendFileSync(log, JSON.stringify(message) + '\\n')
    if (message.type === 'user') {
      const content = message.message.content
      if (content === 'drop') process.exit(1)
      write({type:'result',subtype:'success',session_id:sessionId,result:'ok'})
    }
    if (message.type === 'control_request' && message.request.subtype === 'end_session') {
      if (!process.env.IGNORE_END) process.exit(0)
    }
  }
})
`,
  )
  // The fixture uses appendFileSync without an import to keep spawned code small.
  const current = await readFile(fixturePath, 'utf8')
  await writeFile(fixturePath, `import {appendFileSync} from 'fs'\n${current}`)
})

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await rm(root, { recursive: true, force: true })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

function spawnFixture(env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, [fixturePath], {
    shell: false,
    env: {
      ...process.env,
      FIXTURE_SESSION_ID: '11111111-1111-4111-8111-111111111111',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  child.on('close', () => children.delete(child))
  return child
}

function harness() {
  const messages: unknown[] = []
  const permissions: Array<{ request: unknown; id: string }> = []
  const errors: SSHSessionError[] = []
  const reconnecting: number[] = []
  const connected: Array<() => void> = []
  let disconnectedCount = 0
  const disconnected = deferred()
  const callbacks: SSHSessionCallbacks = {
    onMessage: message => messages.push(message),
    onPermissionRequest: (request, id) => permissions.push({ request, id }),
    onConnected: () => connected.shift()?.(),
    onReconnecting: attempt => reconnecting.push(attempt),
    onDisconnected: () => {
      disconnectedCount++
      disconnected.resolve()
    },
    onError: error => errors.push(error as SSHSessionError),
  }
  const nextConnected = () => {
    const next = deferred()
    connected.push(() => next.resolve())
    return next.promise
  }
  return {
    messages,
    permissions,
    errors,
    reconnecting,
    callbacks,
    disconnected,
    disconnectedCount: () => disconnectedCount,
    nextConnected,
  }
}

function connection(child: ChildProcess): SSHManagedConnection & { stops: () => number } {
  let stops = 0
  return {
    proc: child,
    proxy: { stop: () => stops++ },
    stops: () => stops,
  }
}

async function makeArtifact(version = '1.2.3') {
  const artifactRoot = join(root, `artifacts-${crypto.randomUUID()}`)
  const directory = join(artifactRoot, version, 'linux-x64')
  await mkdir(directory, { recursive: true })
  const bun = Buffer.from(`approved linux bun ${version}`)
  const main = Buffer.from(`approved external bundle ${version}\n`)
  await writeFile(join(directory, 'bun'), bun, { mode: 0o755 })
  await writeFile(join(directory, 'main.js'), main, { mode: 0o644 })
  await chmod(join(directory, 'bun'), 0o755)
  await chmod(join(directory, 'main.js'), 0o644)
  const manifest = {
    protocol: 'ssh-v1',
    version,
    target: 'linux-x64',
    files: {
      bun: { sha256: createHash('sha256').update(bun).digest('hex'), mode: '0755' },
      'main.js': { sha256: createHash('sha256').update(main).digest('hex'), mode: '0644' },
    },
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
  const artifact = await loadSSHArtifact({ artifactRoot, version, target: 'linux-x64' })
  return { artifactRoot, artifact }
}

const probe: SSHProbe = {
  home: '/remote/home',
  kernel: 'Linux',
  machine: 'x86_64',
  libc: 'glibc',
  cwd: '/remote/work',
  sha256: 'sha256sum',
  uid: 1000,
  target: 'linux-x64',
}

async function makeFakeOpenSSH() {
  const directory = join(root, `fake-openssh-${crypto.randomUUID()}`)
  await mkdir(directory, { recursive: true })
  const argvLog = join(directory, 'argv.jsonl')
  const ssh = `#!/usr/bin/env bun
import {appendFileSync} from 'fs'
const args = process.argv.slice(2)
appendFileSync(process.env.SSH_ARGV_LOG!, JSON.stringify({command:'ssh',args}) + '\\n')
const remote = args.at(-1) ?? ''
if (remote.includes('json_string()')) {
  console.log('motd is not part of the marker')
  console.log('CLAUDE_SSH_V1:' + JSON.stringify({home:'/remote/home',kernel:'Linux',machine:'x86_64',libc:'glibc',cwd:'/remote/work',sha256:'sha256sum',uid:1000}))
  process.exit(0)
}
if (remote.includes('|| exit 42')) process.exit(42)
if (remote.includes('mktemp -d')) {
  const match = remote.match(new RegExp('(/remote/home/[A-Za-z0-9_./+-]*[.]tmp[.]XXXXXX)'))
  if (!match) process.exit(9)
  console.log('CLAUDE_SSH_TEMP_V1:' + match[1].replace('XXXXXX','abc123'))
  process.exit(0)
}
if (remote.includes('CLAUDE_SSH_ARTIFACT_V1:')) {
  if (process.env.SSH_FAIL_PUBLISH) process.exit(7)
  console.log('CLAUDE_SSH_ARTIFACT_V1:' + process.env.SSH_TEST_DIGEST!)
  process.exit(0)
}
if (remote.includes('--input-format')) {
  process.stdin.on('data', chunk => {
    if (chunk.toString().includes('end_session')) process.exit(0)
  })
} else process.exit(0)
`
  const scp = `#!/usr/bin/env bun
import {appendFileSync} from 'fs'
appendFileSync(process.env.SSH_ARGV_LOG!, JSON.stringify({command:'scp',args:process.argv.slice(2)}) + '\\n')
`
  const sshPath = join(directory, 'ssh')
  const scpPath = join(directory, 'scp')
  await writeFile(sshPath, ssh, { mode: 0o755 })
  await writeFile(scpPath, scp, { mode: 0o755 })
  await chmod(sshPath, 0o755)
  await chmod(scpPath, 0o755)
  const environment = {
    ...process.env,
    PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    SSH_ARGV_LOG: argvLog,
  }
  return { argvLog, environment }
}

async function readArgvLog(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as { command: string; args: string[] })
}

describe('SSH argv, probe, and artifact validation', () => {
  test('quotes POSIX input and rejects host/CLI injection', () => {
    expect(posixQuote("a'b$(touch nope)")).toBe("'a'\\''b$(touch nope)'")
    for (const host of ['-oProxyCommand=x', 'host;id', 'host$(id)', 'host/path', 'host name', 'host\nid']) {
      expect(() => validateSSHHost(host)).toThrow(SSHSessionError)
    }
    expect(() => validateExtraCliArgs(['--resume', 'not-a-uuid'])).toThrow(SSHSessionError)
    expect(() => validateExtraCliArgs(['--model', 'sonnet;id'])).toThrow(SSHSessionError)
    expect(() => validateExtraCliArgs(['--settings', '/tmp/x'])).toThrow(SSHSessionError)
    const argv = buildMainSSHArgv({
      host: 'user@example.test',
      remoteSocket: '/tmp/remote.sock',
      localSocket: '/tmp/local.sock',
      remoteCommand: 'sh -c true',
    })
    expect(argv).not.toContain('-n')
    expect(argv).toContain('BatchMode=yes')
    expect(argv.join(' ')).not.toContain('StrictHostKeyChecking=no')
    expect(argv.join(' ')).not.toContain('UserKnownHostsFile=/dev/null')
  })

  test('requires one valid probe marker and supports only Linux glibc targets', () => {
    expect(() => parseProbeOutput('not json')).toThrow(SSHSessionError)
    expect(() =>
      parseProbeOutput(`CLAUDE_SSH_V1:${JSON.stringify({ ...probe, machine: 'mips64' })}`),
    ).toThrow(SSHSessionError)
    expect(() =>
      parseProbeOutput(`CLAUDE_SSH_V1:${JSON.stringify({ ...probe, libc: 'musl' })}`),
    ).toThrow(SSHSessionError)
    expect(() =>
      parseProbeOutput(`CLAUDE_SSH_V1:${JSON.stringify({ ...probe, libc: 'musl' })}`),
    ).toThrow(/Linux targets using glibc/)
    expect(() =>
      parseProbeOutput(`CLAUDE_SSH_V1:${JSON.stringify(probe)}\nCLAUDE_SSH_V1:{}`),
    ).toThrow(SSHSessionError)
    expect(
      parseProbeOutput(`CLAUDE_SSH_V1:${JSON.stringify({ ...probe, machine: 'arm64' })}`).target,
    ).toBe('linux-arm64')
  })

  test('validates local artifact digest, mode, target, and version', async () => {
    const { artifactRoot, artifact } = await makeArtifact()
    expect(artifact.digest).toMatch(/^[0-9a-f]{64}$/)
    await writeFile(join(artifact.directory, 'main.js'), 'tampered')
    await expect(
      loadSSHArtifact({ artifactRoot, version: '1.2.3', target: 'linux-x64' }),
    ).rejects.toMatchObject({ code: 'SSH_ARTIFACT_MISMATCH' })
    await expect(
      loadSSHArtifact({ artifactRoot, version: '9.9.9', target: 'linux-x64' }),
    ).rejects.toMatchObject({ code: 'SSH_ARTIFACT_MISSING' })
    await writeFile(
      join(artifact.directory, 'manifest.json'),
      JSON.stringify({ ...artifact.manifest, unexpected: 'not allowed' }),
    )
    await expect(
      loadSSHArtifact({ artifactRoot, version: '1.2.3', target: 'linux-x64' }),
    ).rejects.toMatchObject({ code: 'SSH_ARTIFACT_MISMATCH' })
  })

  test('fake OpenSSH deploys exact argv and starts without leaking credentials', async () => {
    const { artifactRoot, artifact } = await makeArtifact()
    const fake = await makeFakeOpenSSH()
    const session = await createSSHSession(
      {
        host: 'user@example.test',
        cwd: "/remote/work/$(touch 'not executed')",
        localVersion: '1.2.3',
        permissionMode: 'default',
        dangerouslySkipPermissions: false,
        extraCliArgs: ['--model', 'sonnet'],
        artifactRoot,
        environment: {
          ...fake.environment,
          SSH_TEST_DIGEST: artifact.digest,
          ANTHROPIC_API_KEY: 'real-secret-must-not-be-remote',
        },
        socketDirectory: '/tmp',
        authProxy: {
          resolveAuth: async () => ({
            kind: 'apiKey',
            headers: { 'x-api-key': 'real-secret-must-not-be-remote' },
          }),
        },
      },
      {},
    )
    const h = harness()
    const manager = session.createManager(h.callbacks)
    manager.connect()
    manager.disconnect()
    await h.disconnected.promise
    await waitFor(() => existsSync(fake.argvLog), 'fake argv log')
    const calls = await readArgvLog(fake.argvLog)
    const main = calls.find(call => call.command === 'ssh' && call.args.at(-1)?.includes('--input-format'))
    expect(main).toBeDefined()
    expect(main!.args).not.toContain('-n')
    expect(main!.args).toContain('ExitOnForwardFailure=yes')
    expect(main!.args).toContain('StreamLocalBindUnlink=yes')
    expect(main!.args).toContain('BatchMode=yes')
    expect(main!.args).not.toContain('--dangerously-skip-permissions')
    const remote = main!.args.at(-1)!
    expect(remote).toContain('ANTHROPIC_API_KEY=ssh-api-key-placeholder')
    expect(remote).not.toContain('real-secret-must-not-be-remote')
    expect(remote).toContain("'--session-id'")
    expect(remote).not.toContain('not executed')
    expect(calls.some(call => call.command === 'scp')).toBe(true)
    const scp = calls.find(call => call.command === 'scp')!
    expect(scp.args.slice(0, 3)).toEqual(['-p', '-q', '--'])
    expect(scp.args.at(-1)).toBe('user@example.test:/remote/home/.cache/claude-code/ssh/.tmp.abc123/')
    const allArgs = calls.flatMap(call => call.args).join('\n')
    expect(allArgs).not.toContain('StrictHostKeyChecking=no')
    expect(allArgs).not.toContain('UserKnownHostsFile=/dev/null')
    const forward = main!.args[main!.args.indexOf('-R') + 1]!
    const localSocket = forward.split(':').at(-1)!
    await waitFor(() => !existsSync(localSocket), 'forward socket cleanup')
  })

  test('failed publication attempts exact temporary-directory cleanup and concurrent calls reuse a digest path', async () => {
    const { artifact } = await makeArtifact()
    const fake = await makeFakeOpenSSH()
    const options = {
      host: 'example.test',
      probe,
      artifact,
      commandOptions: {
        env: { ...fake.environment, SSH_TEST_DIGEST: artifact.digest, SSH_FAIL_PUBLISH: '1' },
      },
    }
    await expect(deploySSHArtifact(options)).rejects.toMatchObject({ code: 'SSH_DEPLOY_FAILED' })
    const calls = await readArgvLog(fake.argvLog)
    expect(calls.at(-1)!.args.at(-1)).toContain("rm -rf --")
    const cleanEnv = { ...fake.environment, SSH_TEST_DIGEST: artifact.digest }
    delete cleanEnv.SSH_FAIL_PUBLISH
    const [first, second] = await Promise.all([
      deploySSHArtifact({ ...options, commandOptions: { env: cleanEnv } }),
      deploySSHArtifact({ ...options, commandOptions: { env: cleanEnv } }),
    ])
    expect(first).toBe(second)
    expect(first).toContain(artifact.digest)
  })

  test('reconnect command replaces initial session arguments with explicit resume', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const command = buildRemoteCLICommand({
      cwd: '/remote/work',
      bunPath: '/cache/bun',
      mainPath: '/cache/main.js',
      remoteSocket: '/tmp/remote.sock',
      authPlaceholder: 'CLAUDE_CODE_OAUTH_TOKEN',
      cli: {
        permissionMode: 'plan',
        dangerouslySkipPermissions: true,
        extraCliArgs: ['--continue', '--model', 'sonnet'],
      },
      initialSessionId: id,
      reconnectSessionId: id,
    })
    expect(command).toContain(`'--resume' '${id}'`)
    expect(command).not.toContain("'--continue'")
    expect(command).not.toContain("'--session-id'")
    expect(command).toContain("'--model' 'sonnet'")
    expect(command).toContain("'--dangerously-skip-permissions'")
    expect(command).not.toContain('oauth-placeholder-token-real')
  })
})

describe('SSHSessionManager with real local fixture processes', () => {
  test('waits for chunked init, handles NDJSON and permissions, conflict and unknown controls', async () => {
    const log = join(root, `messages-${crypto.randomUUID()}.jsonl`)
    const child = spawnFixture({ CHUNK_INIT: '1', PERMISSION: '1', INVALID_JSON: '1', FIXTURE_LOG: log })
    const h = harness()
    const connected = h.nextConnected()
    const manager = new SSHSessionManager({ connection: connection(child) }, h.callbacks)
    expect(manager.sendInterrupt()).toBe(false)
    manager.connect()
    await connected
    expect(manager.isConnected()).toBe(true)
    await waitFor(() => h.permissions.length === 2, 'permission requests')
    expect(h.permissions[0]!.id).toBe('g1:req-1')
    expect(h.permissions[0]!.id).not.toBe(h.permissions[1]!.id)
    expect(h.errors.some(error => error.code === 'CONTROL_ID_CONFLICT')).toBe(true)
    expect(h.errors.length).toBeGreaterThanOrEqual(3)
    expect(
      manager.respondToPermissionRequest('g1:req-1', {
        behavior: 'allow',
        updatedInput: { command: 'pwd' },
      }),
    ).toBe(true)
    expect(
      manager.respondToPermissionRequest('g1:req-2', {
        behavior: 'deny',
        message: 'no',
      }),
    ).toBe(true)
    expect(await manager.sendMessage('hello')).toBe(true)
    await waitFor(() => h.messages.some(message => (message as { type: string }).type === 'result'), 'user result')
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(records.some(record => record.response?.response?.behavior === 'allow')).toBe(true)
    expect(records.some(record => record.response?.response?.behavior === 'deny')).toBe(true)
    expect(records.some(record => record.response?.subtype === 'error' && record.response?.request_id === 'unknown-1')).toBe(true)
    expect(records.filter(record => record.type === 'user')).toHaveLength(1)
    manager.disconnect()
    await h.disconnected.promise
    expect(manager.disconnect()).toBe(false)
    expect(h.disconnectedCount()).toBe(1)
  })

  test('does not replay prompts or accept old-generation permission responses after reconnect', async () => {
    const firstLog = join(root, `first-${crypto.randomUUID()}.jsonl`)
    const secondLog = join(root, `second-${crypto.randomUUID()}.jsonl`)
    const first = connection(spawnFixture({ PERMISSION: '1', FIXTURE_LOG: firstLog }))
    const h = harness()
    const firstConnected = h.nextConnected()
    const secondConnected = h.nextConnected()
    let resumedId = ''
    const manager = new SSHSessionManager(
      {
        connection: first,
        reconnectDelayMs: () => 0,
        reconnect: async activeId => {
          resumedId = activeId
          return connection(spawnFixture({ FIXTURE_LOG: secondLog }))
        },
      },
      h.callbacks,
    )
    manager.connect()
    await Promise.race([
      firstConnected,
      Bun.sleep(1_000).then(() => {
        throw new Error(`first init missing ${JSON.stringify({ messages: h.messages, errors: h.errors, state: (manager as unknown as { state: string }).state, exit: first.proc.exitCode })}`)
      }),
    ])
    await waitFor(() => h.permissions.length === 2, 'old permissions')
    const staleRequest = h.permissions[0]!.id
    expect(await manager.sendMessage('drop')).toBe(true)
    await waitFor(
      () => first.proc.exitCode !== null || first.proc.signalCode !== null,
      'first process exit',
    )
    await waitFor(() => resumedId !== '', 'reconnect factory')
    await Promise.race([
      secondConnected,
      Bun.sleep(1_000).then(() => {
        throw new Error(
          `second init missing: ${JSON.stringify({ errors: h.errors.map(e => e.code), messages: h.messages, reconnecting: h.reconnecting, state: (manager as unknown as { state: string }).state })}`,
        )
      }),
    ])
    expect(resumedId).toBe('11111111-1111-4111-8111-111111111111')
    expect(h.reconnecting).toEqual([1])
    expect(h.errors.some(error => error.code === 'SSH_DELIVERY_UNKNOWN')).toBe(true)
    expect(manager.respondToPermissionRequest(staleRequest, { behavior: 'deny', message: 'late' })).toBe(false)
    expect(manager.sendInterrupt()).toBe(true)
    await waitFor(() => existsSync(secondLog), 'interrupt log')
    const secondRecords = (await readFile(secondLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(secondRecords.filter(record => record.type === 'user')).toHaveLength(0)
    expect(secondRecords.some(record => record.request?.subtype === 'interrupt')).toBe(true)
    expect(secondRecords.some(record => record.type === 'control_response')).toBe(false)
    const firstRecords = (await readFile(firstLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(firstRecords.filter(record => record.type === 'user')).toHaveLength(1)
    manager.disconnect()
    await h.disconnected.promise
  })

  test('does not retry host-key failures and limits pre-init recovery to two attempts', async () => {
    const hostKey = harness()
    let hostKeyRetries = 0
    const hostKeyManager = new SSHSessionManager(
      {
        connection: connection(spawnFixture({ HOST_KEY_FAILURE: '1', NO_INIT: '1' })),
        reconnectDelayMs: () => 0,
        reconnect: async () => {
          hostKeyRetries++
          throw new Error('must not reconnect')
        },
      },
      hostKey.callbacks,
    )
    hostKeyManager.connect()
    await hostKey.disconnected.promise
    expect(hostKeyRetries).toBe(0)
    expect(hostKey.errors.some(error => error.code === 'SSH_HOST_KEY_FAILED')).toBe(true)

    const preInit = harness()
    let preInitRetries = 0
    const preInitManager = new SSHSessionManager(
      {
        connection: connection(spawnFixture({ NO_INIT: '1', DROP_AFTER_INIT: '1' })),
        reconnectDelayMs: () => 0,
        reconnect: async () => {
          preInitRetries++
          throw new Error('offline')
        },
      },
      preInit.callbacks,
    )
    preInitManager.connect()
    await preInit.disconnected.promise
    expect(preInitRetries).toBe(2)
    expect(preInit.reconnecting).toEqual([1, 2])
  })

  test('bounded reconnect exhaustion, redacted stderr, and normal cleanup are idempotent', async () => {
    const child = spawnFixture({ DROP_AFTER_INIT: '1', STDERR_SECRET: '1' })
    const h = harness()
    h.nextConnected().catch(() => undefined)
    let factoryCalls = 0
    const manager = new SSHSessionManager(
      {
        connection: connection(child),
        reconnectDelayMs: () => 0,
        reconnect: async () => {
          factoryCalls++
          throw new Error('temporary offline')
        },
      },
      h.callbacks,
    )
    manager.connect()
    await h.disconnected.promise
    expect(factoryCalls).toBe(3)
    expect(h.reconnecting).toEqual([1, 2, 3])
    expect(h.errors.some(error => error.code === 'SSH_RECONNECT_EXHAUSTED')).toBe(true)
    expect(manager.getStderrTail()).toContain('[REDACTED]')
    expect(manager.getStderrTail()).not.toContain('super-secret-token-value')
    expect(manager.disconnect()).toBe(false)
    expect(h.disconnectedCount()).toBe(1)

    const normalChild = spawnFixture({ EXIT_ZERO: '1' })
    const normal = harness()
    const normalManager = new SSHSessionManager({ connection: connection(normalChild) }, normal.callbacks)
    normalManager.connect()
    await normal.disconnected.promise
    expect(normal.reconnecting).toEqual([])
  })
})
