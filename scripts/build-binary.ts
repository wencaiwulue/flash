import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import packageJson from '../package.json'
import { createBuildOptions } from './build.ts'
import { generateSdkTypes } from './generate-sdk-types.ts'

export const RELEASE_DOCUMENTS = ['README.md', 'README.zh-CN.md'] as const

export const RELEASE_TARGETS = {
  'bun-darwin-arm64': { platform: 'darwin', arch: 'arm64' },
  'bun-darwin-x64': { platform: 'darwin', arch: 'x64' },
  'bun-linux-arm64': { platform: 'linux', arch: 'arm64' },
  'bun-linux-x64': { platform: 'linux', arch: 'x64' },
  'bun-windows-arm64': { platform: 'win32', arch: 'arm64' },
  'bun-windows-x64': { platform: 'win32', arch: 'x64' },
} as const

export type ReleaseTarget = keyof typeof RELEASE_TARGETS

type ChecksumEntry = {
  name: string
  checksum: string
}

export function getReleaseTarget(target: string): ReleaseTarget {
  if (!Object.hasOwn(RELEASE_TARGETS, target)) {
    throw new Error(
      `Unsupported release target: ${target}. Expected one of ${Object.keys(RELEASE_TARGETS).join(', ')}`,
    )
  }
  return target as ReleaseTarget
}

export function getHostTarget(
  platform = process.platform,
  arch = process.arch,
): ReleaseTarget {
  const compilePlatform = platform === 'win32' ? 'windows' : platform
  return getReleaseTarget(`bun-${compilePlatform}-${arch}`)
}

export function assertNativeTarget(
  target: ReleaseTarget,
  platform = process.platform,
  arch = process.arch,
): void {
  const host = getHostTarget(platform, arch)
  if (target !== host) {
    throw new Error(
      `Refusing to build unverified target ${target} on native host ${host}`,
    )
  }
}

export function getBinaryName(target: ReleaseTarget): string {
  return RELEASE_TARGETS[target].platform === 'win32'
    ? 'flash.exe'
    : 'flash'
}

export function getArchiveName(
  target: ReleaseTarget,
  version = packageJson.version,
): string {
  const { platform, arch } = RELEASE_TARGETS[target]
  const extension = platform === 'win32' ? 'zip' : 'tar.gz'
  return `flash-v${version}-${platform}-${arch}.${extension}`
}

export function getArchiveCreationCommand(
  target: ReleaseTarget,
  archivePath: string,
  binaryName: string,
): string[] {
  const isWindows = RELEASE_TARGETS[target].platform === 'win32'
  const archiveFlags = isWindows ? '-a -cf' : '-czf'
  return [
    'tar',
    ...(isWindows ? ['--force-local'] : []),
    ...archiveFlags.split(' '),
    archivePath,
    binaryName,
    ...RELEASE_DOCUMENTS,
  ]
}

export function getArchiveExtractionCommand(
  target: ReleaseTarget,
  archivePath: string,
): string[] {
  const localOption =
    RELEASE_TARGETS[target].platform === 'win32' ? ['--force-local'] : []
  return ['tar', ...localOption, '-xf', archivePath]
}

export function validateReleaseTag(
  tag: string,
  expectedVersion = packageJson.version,
): string {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag)
  if (!match) {
    throw new Error(`Release tag must match vX.Y.Z; received ${tag}`)
  }
  const version = tag.slice(1)
  if (version !== expectedVersion) {
    throw new Error(
      `Release tag ${tag} does not match package.json version ${expectedVersion}`,
    )
  }
  return version
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export function formatChecksumManifest(
  entries: readonly ChecksumEntry[],
): string {
  return `${entries
    .filter(entry => entry.name !== 'SHA256SUMS')
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(entry => `${entry.checksum}  ${entry.name}`)
    .join('\n')}\n`
}

async function writeArchiveChecksum(archivePath: string): Promise<string> {
  const checksum = await sha256File(archivePath)
  const checksumPath = `${archivePath}.sha256`
  await writeFile(
    checksumPath,
    formatChecksumManifest([{ name: basename(archivePath), checksum }]),
  )
  return checksumPath
}

export async function aggregateChecksums(
  directory: string,
  version = packageJson.version,
): Promise<string> {
  const expectedNames = Object.keys(RELEASE_TARGETS)
    .map(target => getArchiveName(target as ReleaseTarget, version))
    .toSorted()
  const actualNames = (await readdir(directory))
    .filter(name => name.endsWith('.tar.gz') || name.endsWith('.zip'))
    .toSorted()

  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `Release archives do not match the expected six targets. Expected ${expectedNames.join(', ')}; received ${actualNames.join(', ')}`,
    )
  }

  const entries: ChecksumEntry[] = []
  for (const name of expectedNames) {
    const archivePath = join(directory, name)
    const checksum = await sha256File(archivePath)
    const sidecar = (await readFile(`${archivePath}.sha256`, 'utf8')).trim()
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(sidecar)
    if (!match || match[2] !== name) {
      throw new Error(`Invalid checksum sidecar for ${name}`)
    }
    if (match[1] !== checksum) {
      throw new Error(`Checksum mismatch for ${name}`)
    }
    entries.push({ name, checksum })
  }

  const manifestPath = join(directory, 'SHA256SUMS')
  await writeFile(manifestPath, formatChecksumManifest(entries))
  return manifestPath
}

function spawn(
  cmd: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return Bun.spawnSync({
    cmd,
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  })
}

function assertCommandSucceeded(
  result: ReturnType<typeof spawn>,
  description: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${description} failed (${result.exitCode ?? result.signalCode}): ${result.stderr.toString().trim()}`,
    )
  }
}

function smokeTestBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): void {
  const version = spawn([binaryPath, '--version'], { env })
  assertCommandSucceeded(version, `${binaryPath} --version`)
  const expectedVersion = `${packageJson.version} (Claude Code)`
  if (version.stdout.toString().trim() !== expectedVersion) {
    throw new Error(
      `Unexpected binary version: ${version.stdout.toString().trim()}; expected ${expectedVersion}`,
    )
  }

  const help = spawn([binaryPath, '--help'], { env })
  assertCommandSucceeded(help, `${binaryPath} --help`)
}

let standaloneSmokeSequence = 0

async function smokeTestStandaloneBinary(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const modules = resolve('node_modules')
  const hiddenModules = resolve(
    `.node_modules.release-smoke-${process.pid}-${standaloneSmokeSequence++}`,
  )
  await rename(modules, hiddenModules)
  try {
    smokeTestBinary(binaryPath, env)
  } finally {
    await rename(hiddenModules, modules)
  }
}

async function buildBinary(
  target: ReleaseTarget,
  outputDirectory: string,
): Promise<void> {
  const spec = RELEASE_TARGETS[target]
  const outputDir = resolve(outputDirectory)
  const workDir = join(outputDir, '.work', target)
  const stageDir = join(workDir, 'package')
  const extractDir = join(workDir, 'extracted')
  const binaryName = getBinaryName(target)
  const binaryPath = join(workDir, binaryName)
  const archivePath = join(
    outputDir,
    getArchiveName(target, packageJson.version),
  )

  await rm(workDir, { recursive: true, force: true })
  await mkdir(stageDir, { recursive: true })
  await mkdir(extractDir, { recursive: true })
  generateSdkTypes()

  const result = await Bun.build({
    ...createBuildOptions(),
    entrypoints: ['src/entrypoints/cli.tsx'],
    compile: { target, outfile: binaryPath },
  })
  if (!result.success) {
    throw new Error(result.logs.join('\n'))
  }
  if (spec.platform !== 'win32') {
    await chmod(binaryPath, 0o755)
  }

  const isolatedHome = await mkdtemp(join(tmpdir(), 'flash-binary-home-'))
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    CLAUDE_CONFIG_DIR: join(isolatedHome, 'config'),
  }
  try {
    await smokeTestStandaloneBinary(binaryPath, env)
    await copyFile(binaryPath, join(stageDir, binaryName))
    for (const document of RELEASE_DOCUMENTS) {
      await copyFile(document, join(stageDir, document))
    }

    await rm(archivePath, { force: true })
    await rm(`${archivePath}.sha256`, { force: true })
    const archive = spawn(
      getArchiveCreationCommand(target, archivePath, binaryName),
      { cwd: stageDir },
    )
    assertCommandSucceeded(archive, `Create ${basename(archivePath)}`)

    const extract = spawn(getArchiveExtractionCommand(target, archivePath), {
      cwd: extractDir,
    })
    assertCommandSucceeded(extract, `Extract ${basename(archivePath)}`)
    const archivedFiles = (await readdir(extractDir)).toSorted()
    const expectedFiles = [binaryName, ...RELEASE_DOCUMENTS].toSorted()
    if (
      archivedFiles.length !== expectedFiles.length ||
      archivedFiles.some((name, index) => name !== expectedFiles[index])
    ) {
      throw new Error(`Unexpected archive contents: ${archivedFiles.join(', ')}`)
    }
    for (const document of RELEASE_DOCUMENTS) {
      const [source, extracted] = await Promise.all([
        readFile(document),
        readFile(join(extractDir, document)),
      ])
      if (!source.equals(extracted)) {
        throw new Error(`Extracted release document differs: ${document}`)
      }
    }
    const extractedBinary = join(extractDir, binaryName)
    if (
      spec.platform !== 'win32' &&
      ((await stat(extractedBinary)).mode & 0o111) === 0
    ) {
      throw new Error('Extracted Unix binary is not executable')
    }
    await smokeTestStandaloneBinary(extractedBinary, env)

    const checksumPath = await writeArchiveChecksum(archivePath)
    console.log(archivePath)
    console.log(checksumPath)
  } finally {
    await rm(isolatedHome, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      'release-tag': { type: 'string' },
      'validate-only': { type: 'boolean' },
      'checksum-dir': { type: 'string' },
      'output-dir': { type: 'string', default: 'build/release' },
    },
    allowPositionals: false,
  })

  if (values['release-tag']) {
    validateReleaseTag(values['release-tag'])
  }
  if (values['checksum-dir']) {
    console.log(await aggregateChecksums(values['checksum-dir']))
    return
  }
  if (values['validate-only']) {
    console.log(`Validated release version ${packageJson.version}`)
    return
  }

  const target = getReleaseTarget(values.target ?? getHostTarget())
  assertNativeTarget(target)
  await buildBinary(target, values['output-dir'])
}

if (import.meta.main) {
  await main()
}
