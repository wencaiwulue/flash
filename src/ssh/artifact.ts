import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { lstat, readFile } from 'fs/promises'
import { join } from 'path'
import {
  buildProbeArgv,
  posixQuote,
  scpDestination,
  validateVersion,
  type SSHProbe,
  type SSHTarget,
} from './argv.js'
import { SSHSessionError } from './errors.js'
import { classifyOpenSSHFailure, runCommand, type RunCommandOptions } from './openSSH.js'

export type SSHArtifactFile = { sha256: string; mode: '0755' | '0644' }
export type SSHArtifactManifest = {
  protocol: 'ssh-v1'
  version: string
  target: SSHTarget
  files: { bun: SSHArtifactFile; 'main.js': SSHArtifactFile }
}

export type SSHArtifact = {
  root: string
  directory: string
  manifest: SSHArtifactManifest
  manifestBytes: Buffer
  digest: string
}

const HEX_RE = /^[0-9a-f]{64}$/
const SAFE_REMOTE_PATH_RE = /^\/[A-Za-z0-9_./+-]+$/

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', chunk => hash.update(chunk))
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function parseManifest(
  raw: unknown,
  version: string,
  target: SSHTarget,
): SSHArtifactManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SSHSessionError('SSH_ARTIFACT_MISMATCH', 'Artifact manifest must be an object')
  }
  const value = raw as Record<string, unknown>
  const files = value.files as Record<string, unknown> | undefined
  const bun = files?.bun as Record<string, unknown> | undefined
  const main = files?.['main.js'] as Record<string, unknown> | undefined
  const exactKeys = (record: Record<string, unknown> | undefined, keys: string[]) =>
    !!record && Object.keys(record).sort().join(',') === [...keys].sort().join(',')
  if (
    value.protocol !== 'ssh-v1' ||
    value.version !== version ||
    value.target !== target ||
    !exactKeys(value, ['protocol', 'version', 'target', 'files']) ||
    !exactKeys(files, ['bun', 'main.js']) ||
    !exactKeys(bun, ['sha256', 'mode']) ||
    !exactKeys(main, ['sha256', 'mode']) ||
    !files ||
    !bun ||
    !main ||
    bun.mode !== '0755' ||
    main.mode !== '0644' ||
    typeof bun.sha256 !== 'string' ||
    !HEX_RE.test(bun.sha256) ||
    typeof main.sha256 !== 'string' ||
    !HEX_RE.test(main.sha256)
  ) {
    throw new SSHSessionError(
      'SSH_ARTIFACT_MISMATCH',
      `Artifact manifest does not match ssh-v1 ${version} ${target}`,
    )
  }
  return value as SSHArtifactManifest
}

export async function loadSSHArtifact(options: {
  artifactRoot: string
  version: string
  target: SSHTarget
}): Promise<SSHArtifact> {
  const version = validateVersion(options.version)
  const directory = join(options.artifactRoot, version, options.target)
  let manifestBytes: Buffer
  try {
    const manifestInfo = await lstat(join(directory, 'manifest.json'))
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
      throw new SSHSessionError(
        'SSH_ARTIFACT_MISMATCH',
        'Artifact manifest is not a regular file',
      )
    }
    manifestBytes = await readFile(join(directory, 'manifest.json'))
  } catch (cause) {
    if (cause instanceof SSHSessionError) throw cause
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SSHSessionError(
        'SSH_ARTIFACT_MISSING',
        `No approved ssh-v1 artifact for ${version}/${options.target} under ${options.artifactRoot}`,
        { cause },
      )
    }
    throw new SSHSessionError('SSH_ARTIFACT_MISMATCH', 'Unable to read artifact manifest', {
      cause,
    })
  }
  if (manifestBytes.length > 1024 * 1024) {
    throw new SSHSessionError('SSH_ARTIFACT_MISMATCH', 'Artifact manifest is too large')
  }
  let raw: unknown
  try {
    raw = JSON.parse(manifestBytes.toString('utf8'))
  } catch (cause) {
    throw new SSHSessionError('SSH_ARTIFACT_MISMATCH', 'Artifact manifest is invalid JSON', {
      cause,
    })
  }
  const manifest = parseManifest(raw, version, options.target)
  for (const name of ['bun', 'main.js'] as const) {
    const path = join(directory, name)
    let info
    try {
      info = await lstat(path)
    } catch (cause) {
      throw new SSHSessionError('SSH_ARTIFACT_MISSING', `Artifact file is missing: ${name}`, {
        cause,
      })
    }
    const expected = manifest.files[name]
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SSHSessionError('SSH_ARTIFACT_MISMATCH', `Artifact file is not regular: ${name}`)
    }
    if ((info.mode & 0o777).toString(8).padStart(4, '0') !== expected.mode) {
      throw new SSHSessionError(
        'SSH_ARTIFACT_MISMATCH',
        `Artifact mode mismatch for ${name}; expected ${expected.mode}`,
      )
    }
    if ((await sha256File(path)) !== expected.sha256) {
      throw new SSHSessionError('SSH_ARTIFACT_MISMATCH', `Artifact digest mismatch for ${name}`)
    }
  }
  return {
    root: options.artifactRoot,
    directory,
    manifest,
    manifestBytes,
    digest: createHash('sha256').update(manifestBytes).digest('hex'),
  }
}

export function remoteArtifactDirectory(
  probe: SSHProbe,
  artifact: SSHArtifact,
): string {
  const directory = `${probe.home}/.cache/claude-code/ssh/${artifact.manifest.version}-${artifact.digest}`
  if (!SAFE_REMOTE_PATH_RE.test(directory)) {
    throw new SSHSessionError('SSH_ARTIFACT_MISMATCH', 'Remote artifact path is not safe')
  }
  return directory
}

function hashCommand(probe: SSHProbe, path: string): string {
  return `${probe.sha256} ${posixQuote(path)}`
}

function verificationChecks(
  probe: SSHProbe,
  artifact: SSHArtifact,
  directory: string,
): string {
  const expected: Array<[string, string, string]> = [
    ['bun', artifact.manifest.files.bun.sha256, '755'],
    ['main.js', artifact.manifest.files['main.js'].sha256, '644'],
    ['manifest.json', artifact.digest, '600'],
  ]
  return expected
    .map(([name, digest, mode]) => {
      const path = `${directory}/${name}`
      return `[ -f ${posixQuote(path)} ] || exit 43\n[ "$(stat -c '%a' -- ${posixQuote(path)})" = ${posixQuote(mode)} ] || exit 43\nactual=$(${hashCommand(probe, path)}) || exit 43\nactual=\${actual%% *}\n[ "$actual" = ${posixQuote(digest)} ] || exit 43`
    })
    .join('\n')
}

function remoteCommand(script: string): string {
  return `sh -c ${posixQuote(script)}`
}

async function runRemote(
  host: string,
  command: string,
  options: RunCommandOptions,
) {
  return runCommand('ssh', [...buildProbeArgv(host), command], options)
}

export async function verifyRemoteArtifact(options: {
  host: string
  probe: SSHProbe
  artifact: SSHArtifact
  directory: string
  commandOptions?: RunCommandOptions
}): Promise<'valid' | 'missing'> {
  const script = `set -eu\n[ -d ${posixQuote(options.directory)} ] || exit 42\n${verificationChecks(options.probe, options.artifact, options.directory)}`
  const result = await runRemote(options.host, remoteCommand(script), {
    timeoutMs: 30_000,
    ...options.commandOptions,
  })
  if (result.code === 0) return 'valid'
  if (result.code === 42) return 'missing'
  if (result.code === 43) {
    throw new SSHSessionError(
      'SSH_ARTIFACT_MISMATCH',
      'Existing remote artifact cache failed digest verification; refusing to overwrite it',
    )
  }
  throw classifyOpenSSHFailure(result, 'SSH_DEPLOY_FAILED')
}

async function cleanupRemoteTemp(
  host: string,
  temporaryDirectory: string,
  commandOptions?: RunCommandOptions,
): Promise<void> {
  if (!SAFE_REMOTE_PATH_RE.test(temporaryDirectory)) return
  await runRemote(
    host,
    remoteCommand(`rm -rf -- ${posixQuote(temporaryDirectory)}`),
    { timeoutMs: 15_000, ...commandOptions },
  ).catch(() => undefined)
}

export async function deploySSHArtifact(options: {
  host: string
  probe: SSHProbe
  artifact: SSHArtifact
  commandOptions?: RunCommandOptions
}): Promise<string> {
  const directory = remoteArtifactDirectory(options.probe, options.artifact)
  if (
    (await verifyRemoteArtifact({
      host: options.host,
      probe: options.probe,
      artifact: options.artifact,
      directory,
      commandOptions: options.commandOptions,
    })) === 'valid'
  ) {
    return directory
  }

  const parent = directory.slice(0, directory.lastIndexOf('/'))
  const marker = 'CLAUDE_SSH_TEMP_V1:'
  const makeTemp = `set -eu\numask 077\nmkdir -p -- ${posixQuote(parent)}\nchmod 700 ${posixQuote(parent)}\ntmp=$(mktemp -d ${posixQuote(`${parent}/.tmp.XXXXXX`)})\nchmod 700 "$tmp"\nprintf '${marker}%s\\n' "$tmp"`
  const made = await runRemote(options.host, remoteCommand(makeTemp), {
    timeoutMs: 30_000,
    ...options.commandOptions,
  })
  if (made.code !== 0) throw classifyOpenSSHFailure(made, 'SSH_DEPLOY_FAILED')
  const temporaryDirectory = made.stdout
    .split(/\r?\n/)
    .find(line => line.startsWith(marker))
    ?.slice(marker.length)
  if (
    !temporaryDirectory ||
    made.stdout.split(marker).length !== 2 ||
    !new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.tmp\\.[A-Za-z0-9]{6}$`).test(
      temporaryDirectory,
    )
  ) {
    throw new SSHSessionError(
      'SSH_DEPLOY_FAILED',
      `Remote mktemp returned an unsafe path: ${JSON.stringify(temporaryDirectory)}`,
    )
  }

  try {
    const copied = await runCommand(
      'scp',
      [
        '-p',
        '-q',
        '--',
        join(options.artifact.directory, 'bun'),
        join(options.artifact.directory, 'main.js'),
        join(options.artifact.directory, 'manifest.json'),
        scpDestination(options.host, temporaryDirectory),
      ],
      { timeoutMs: 120_000, ...options.commandOptions },
    )
    if (copied.code !== 0) throw classifyOpenSSHFailure(copied, 'SSH_DEPLOY_FAILED')

    const tmp = posixQuote(temporaryDirectory)
    const dest = posixQuote(directory)
    const publish = `set -eu\ntmp=${tmp}\ndest=${dest}\ncleanup() { rm -rf -- "$tmp"; }\ntrap cleanup EXIT HUP INT TERM\nchmod 0755 "$tmp/bun"\nchmod 0644 "$tmp/main.js"\nchmod 0600 "$tmp/manifest.json"\n${verificationChecks(options.probe, options.artifact, temporaryDirectory)}\nif [ -e "$dest" ]; then\n${verificationChecks(options.probe, options.artifact, directory)}\nelif mv -- "$tmp" "$dest"; then\ntrap - EXIT HUP INT TERM\n${verificationChecks(options.probe, options.artifact, directory)}\nelse\n${verificationChecks(options.probe, options.artifact, directory)}\nfi\nprintf 'CLAUDE_SSH_ARTIFACT_V1:%s\\n' ${posixQuote(options.artifact.digest)}`
    const published = await runRemote(options.host, remoteCommand(publish), {
      timeoutMs: 60_000,
      ...options.commandOptions,
    })
    const publishRecords = published.stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('CLAUDE_SSH_ARTIFACT_V1:'))
    if (
      published.code !== 0 ||
      published.stdout.split('CLAUDE_SSH_ARTIFACT_V1:').length !== 2 ||
      publishRecords.length !== 1 ||
      publishRecords[0] !== `CLAUDE_SSH_ARTIFACT_V1:${options.artifact.digest}`
    ) {
      throw classifyOpenSSHFailure(published, 'SSH_DEPLOY_FAILED')
    }
    return directory
  } catch (error) {
    await cleanupRemoteTemp(options.host, temporaryDirectory, options.commandOptions)
    throw error
  }
}
