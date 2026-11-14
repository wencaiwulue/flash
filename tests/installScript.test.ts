import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  formatChecksumManifest,
  getArchiveName,
  getReleaseTarget,
  sha256File,
  type ReleaseTarget,
} from '../scripts/build-binary.ts'

const root = resolve(import.meta.dir, '..')
const installer = join(root, 'scripts', 'install.sh')
const version = '1.2.3'
const tag = `v${version}`
const targets = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-arm64',
  'bun-linux-x64',
] as const

let server: Server
let baseUrl: string
let directory: string
let home: string
let installDirectory: string
let temporaryDirectory: string
let assets: Map<string, Buffer>
let requests: string[]

async function createArchive(
  target: ReleaseTarget,
  memberName = 'flash',
): Promise<{ name: string; bytes: Buffer; checksum: string }> {
  const name = getArchiveName(target, version)
  const stage = await mkdtemp(join(directory, 'archive-'))
  const member = join(stage, memberName)
  await writeFile(member, `#!/bin/sh\nprintf '%s\\n' '${target}'\n`)
  await chmod(member, 0o755)
  const members = [memberName]
  if (memberName === 'flash') {
    for (const document of ['README.md', 'README.zh-CN.md']) {
      await writeFile(join(stage, document), document)
      members.push(document)
    }
  }
  const archive = join(directory, name)
  const result = Bun.spawnSync({
    cmd: ['tar', '-czf', archive, '-C', stage, ...members],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return {
    name,
    bytes: await readFile(archive),
    checksum: await sha256File(archive),
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'flash-installer-test-'))
  home = join(directory, 'home')
  installDirectory = join(home, '.local', 'bin')
  temporaryDirectory = join(directory, 'tmp')
  await mkdir(temporaryDirectory, { recursive: true })
  assets = new Map()
  requests = []

  const checksums: { name: string; checksum: string }[] = []
  for (const target of targets) {
    const archive = await createArchive(target)
    assets.set(`/download/${tag}/${archive.name}`, archive.bytes)
    checksums.push({ name: archive.name, checksum: archive.checksum })
  }
  assets.set(
    `/download/${tag}/SHA256SUMS`,
    Buffer.from(formatChecksumManifest(checksums)),
  )

  server = createServer((request, response) => {
    const path = request.url ?? '/'
    requests.push(path)
    if (path === '/latest') {
      response.statusCode = 302
      response.setHeader('location', `${baseUrl}/tag/${tag}`)
      response.end()
      return
    }
    if (path === `/tag/${tag}`) {
      response.end('release')
      return
    }
    const asset = assets.get(path)
    if (!asset) {
      response.statusCode = 404
      response.end()
      return
    }
    response.end(asset)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})

type InstallerResult = {
  exitCode: number
  stdout: string
  stderr: string
}

async function runInstaller(
  environment: Record<string, string | undefined> = {},
): Promise<InstallerResult> {
  const child = Bun.spawn({
    cmd: ['/bin/sh', installer],
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temporaryDirectory,
      INSTALL_DIR: installDirectory,
      VERSION: tag,
      CLAUDE_CODE_DOWNLOAD_BASE_URL: baseUrl,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      ...environment,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

function expectSuccess(result: InstallerResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`Installer exited ${result.exitCode}: ${result.stderr}`)
  }
}

function expectFailure(result: InstallerResult): void {
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr).toContain('Error:')
}

async function fakeUname(system: string, machine: string): Promise<string> {
  const bin = join(directory, 'uname-bin')
  await mkdir(bin, { recursive: true })
  const path = join(bin, 'uname')
  await writeFile(
    path,
    `#!/bin/sh\ncase "$1" in\n  -s) printf '%s\\n' '${system}' ;;\n  -m) printf '%s\\n' '${machine}' ;;\n  *) exit 1 ;;\nesac\n`,
  )
  await chmod(path, 0o755)
  return `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`
}

async function expectNoInstallation(): Promise<void> {
  await expect(stat(join(installDirectory, 'flash'))).rejects.toThrow()
  expect(await readdir(temporaryDirectory)).toEqual([])
}

describe('shell installer', () => {
  test('has valid POSIX shell syntax', () => {
    const result = Bun.spawnSync({
      cmd: ['/bin/sh', '-n', installer],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
  })

  test('installs verified archives for all supported Unix targets', async () => {
    const cases = [
      ['Darwin', 'arm64', 'bun-darwin-arm64'],
      ['Darwin', 'x86_64', 'bun-darwin-x64'],
      ['Linux', 'aarch64', 'bun-linux-arm64'],
      ['Linux', 'amd64', 'bun-linux-x64'],
    ] as const

    for (const [system, machine, target] of cases) {
      requests = []
      const path = await fakeUname(system, machine)
      const result = await runInstaller({ PATH: path })
      expectSuccess(result)
      const binary = join(installDirectory, 'flash')
      expect(result.stdout.toString()).toContain(`Installed flash ${tag}`)
      expect(result.stdout.toString()).toContain('export PATH=')
      expect((await stat(binary)).mode & 0o777).toBe(0o755)
      expect(requests).toContain(`/download/${tag}/${getArchiveName(target, version)}`)
      expect(await readdir(temporaryDirectory)).toEqual([])
      expect((await readdir(installDirectory)).sort()).toEqual(['flash'])

      const installed = Bun.spawnSync({
        cmd: [binary],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(installed.stdout.toString().trim()).toBe(target)
    }
  })

  test('resolves latest and uses HOME without redundant PATH guidance', async () => {
    const path = await fakeUname('Darwin', 'arm64')
    const result = await runInstaller({
      VERSION: '',
      INSTALL_DIR: '',
      PATH: `${installDirectory}:${path}`,
    })
    expectSuccess(result)
    expect(requests[0]).toBe('/latest')
    expect(requests).toContain(
      `/download/${tag}/${getArchiveName('bun-darwin-arm64', version)}`,
    )
    expect(result.stdout).not.toContain('export PATH=')
    const binary = join(installDirectory, 'flash')
    expect((await stat(binary)).mode & 0o777).toBe(0o755)
    expect(await readdir(temporaryDirectory)).toEqual([])
  })

  for (const scenario of ['wrong', 'missing', 'duplicate', 'malformed'] as const) {
    test(`rejects a ${scenario} checksum without replacing an installation`, async () => {
      const archiveName = getArchiveName('bun-darwin-arm64', version)
      const manifestPath = `/download/${tag}/SHA256SUMS`
      const lines = assets
        .get(manifestPath)!
        .toString()
        .trim()
        .split('\n')
      const selected = lines.find(line => line.endsWith(`  ${archiveName}`))!
      const updated = lines.filter(line => !line.endsWith(`  ${archiveName}`))
      if (scenario === 'wrong') {
        updated.push(`${'0'.repeat(64)}  ${archiveName}`)
      } else if (scenario === 'duplicate') {
        updated.push(selected, selected)
      } else if (scenario === 'malformed') {
        updated.push(`${'z'.repeat(64)}  ${archiveName}`)
      } else {
        updated.push(selected.replace(archiveName, 'other-archive.tar.gz'))
      }
      assets.set(manifestPath, Buffer.from(`${updated.join('\n')}\n`))

      await mkdir(installDirectory, { recursive: true })
      const destination = join(installDirectory, 'flash')
      await writeFile(destination, 'existing installation')
      const result = await runInstaller({ PATH: await fakeUname('Darwin', 'arm64') })
      expectFailure(result)
      expect(await readFile(destination, 'utf8')).toBe('existing installation')
      expect((await readdir(installDirectory)).sort()).toEqual(['flash'])
      expect(await readdir(temporaryDirectory)).toEqual([])
    })
  }

  test('rejects unsupported platforms before downloading', async () => {
    for (const [system, machine] of [
      ['FreeBSD', 'amd64'],
      ['Linux', 'riscv64'],
    ]) {
      requests = []
      const result = await runInstaller({ PATH: await fakeUname(system, machine) })
      expectFailure(result)
      expect(requests).toEqual([])
      await expectNoInstallation()
    }
  })

  test('rejects invalid versions and download failures without installing', async () => {
    for (const invalidVersion of [
      '1.2.3',
      'v1.2',
      'v01.2.3',
      'v1.2.3-beta.1',
      'v1.2.3\n',
    ]) {
      requests = []
      const invalid = await runInstaller({ VERSION: invalidVersion })
      expectFailure(invalid)
      expect(requests).toEqual([])
      await expectNoInstallation()
    }

    requests = []
    const missing = await runInstaller({ VERSION: 'v9.9.9' })
    expectFailure(missing)
    await expectNoInstallation()
  })

  test('rejects an archive without the expected binary', async () => {
    const target = getReleaseTarget('bun-darwin-arm64')
    const archive = await createArchive(target, 'not-flash')
    assets.set(`/download/${tag}/${archive.name}`, archive.bytes)
    assets.set(
      `/download/${tag}/SHA256SUMS`,
      Buffer.from(
        formatChecksumManifest([
          { name: archive.name, checksum: archive.checksum },
        ]),
      ),
    )

    const result = await runInstaller({ PATH: await fakeUname('Darwin', 'arm64') })
    expectFailure(result)
    await expectNoInstallation()
  })

  test('rejects a corrupt archive after verifying its checksum', async () => {
    const name = getArchiveName('bun-darwin-arm64', version)
    const archive = join(directory, 'corrupt.tar.gz')
    await writeFile(archive, 'not a tar archive')
    assets.set(`/download/${tag}/${name}`, await readFile(archive))
    assets.set(
      `/download/${tag}/SHA256SUMS`,
      Buffer.from(
        formatChecksumManifest([
          { name, checksum: await sha256File(archive) },
        ]),
      ),
    )

    const result = await runInstaller({
      PATH: await fakeUname('Darwin', 'arm64'),
    })
    expectFailure(result)
    await expectNoInstallation()
  })

  test('rejects a symlink in place of the archived binary', async () => {
    const name = getArchiveName('bun-darwin-arm64', version)
    const stage = await mkdtemp(join(directory, 'symlink-archive-'))
    await writeFile(join(stage, 'referent'), 'not an installed binary')
    await symlink('referent', join(stage, 'flash'))
    const archive = join(directory, 'symlink.tar.gz')
    const tar = Bun.spawnSync({
      cmd: ['tar', '-czf', archive, '-C', stage, 'flash'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
    assets.set(`/download/${tag}/${name}`, await readFile(archive))
    assets.set(
      `/download/${tag}/SHA256SUMS`,
      Buffer.from(
        formatChecksumManifest([
          { name, checksum: await sha256File(archive) },
        ]),
      ),
    )

    const result = await runInstaller({
      PATH: await fakeUname('Darwin', 'arm64'),
    })
    expectFailure(result)
    await expectNoInstallation()
  })

  test('reports cleanup failure after a completed installation', async () => {
    const path = await fakeUname('Darwin', 'arm64')
    const rmShim = join(directory, 'uname-bin', 'rm')
    await writeFile(rmShim, '#!/bin/sh\nexit 1\n')
    await chmod(rmShim, 0o755)

    const result = await runInstaller({ PATH: path })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Warning: unable to remove temporary directory')
    expect((await stat(join(installDirectory, 'flash'))).mode & 0o777).toBe(
      0o755,
    )
  })

  test('requires a checksum tool before downloading', async () => {
    const bin = join(directory, 'no-checksum-bin')
    await mkdir(bin)
    for (const command of [
      'curl',
      'uname',
      'tar',
      'mktemp',
      'grep',
      'awk',
      'cp',
      'chmod',
      'mv',
      'mkdir',
      'rm',
    ]) {
      const lookup = Bun.spawnSync({
        cmd: ['/bin/sh', '-c', `command -v ${command}`],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const path = lookup.stdout.toString().trim()
      if (!path) throw new Error(`Missing test prerequisite: ${command}`)
      await symlink(path, join(bin, command))
    }

    const result = await runInstaller({ PATH: bin })
    expectFailure(result)
    expect(result.stderr.toString()).toContain('sha256sum or shasum')
    expect(requests).toEqual([])
    await expectNoInstallation()
  })

  test('replaces a destination symlink without changing its referent', async () => {
    await mkdir(installDirectory, { recursive: true })
    const referent = join(directory, 'referent')
    const destination = join(installDirectory, 'flash')
    await writeFile(referent, 'do not modify')
    await symlink(referent, destination)

    const result = await runInstaller({ PATH: await fakeUname('Darwin', 'arm64') })
    expectSuccess(result)
    expect((await lstat(destination)).isSymbolicLink()).toBe(false)
    expect(await readFile(referent, 'utf8')).toBe('do not modify')
    expect(await readdir(temporaryDirectory)).toEqual([])
  })
})
