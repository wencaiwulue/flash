import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aggregateChecksums,
  assertNativeTarget,
  formatChecksumManifest,
  getArchiveName,
  getBinaryName,
  getHostTarget,
  getReleaseTarget,
  RELEASE_TARGETS,
  sha256File,
  validateReleaseTag,
  type ReleaseTarget,
} from '../scripts/build-binary.ts'

describe('release version validation', () => {
  test('accepts a matching strict semantic-version tag', () => {
    expect(validateReleaseTag('v1.2.3', '1.2.3')).toBe('1.2.3')
  })

  test('rejects malformed or mismatched tags', () => {
    for (const tag of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-beta.1']) {
      expect(() => validateReleaseTag(tag, '1.2.3')).toThrow()
    }
    expect(() => validateReleaseTag('v1.2.4', '1.2.3')).toThrow(
      'does not match package.json version',
    )
  })
})

describe('release target metadata', () => {
  test('creates unique names for all six native targets', () => {
    const targets = Object.keys(RELEASE_TARGETS) as ReleaseTarget[]
    const archives = targets.map(target => getArchiveName(target, '1.2.3'))
    expect(new Set(archives).size).toBe(6)
    expect(getArchiveName('bun-darwin-arm64', '1.2.3')).toBe(
      'claude-code-v1.2.3-darwin-arm64.tar.gz',
    )
    expect(getArchiveName('bun-windows-arm64', '1.2.3')).toBe(
      'claude-code-v1.2.3-win32-arm64.zip',
    )
    expect(getBinaryName('bun-windows-x64')).toBe('claude-code.exe')
    expect(getBinaryName('bun-linux-x64')).toBe('claude-code')
  })

  test('rejects unsupported and non-native targets', () => {
    expect(() => getReleaseTarget('bun-linux-x64-musl')).toThrow(
      'Unsupported release target',
    )
    expect(getHostTarget('linux', 'x64')).toBe('bun-linux-x64')
    expect(() =>
      assertNativeTarget('bun-linux-arm64', 'linux', 'x64'),
    ).toThrow('Refusing to build unverified target')
    expect(() =>
      assertNativeTarget('bun-windows-arm64', 'win32', 'arm64'),
    ).not.toThrow()
  })
})

describe('release checksums', () => {
  test('sorts entries and excludes the aggregate manifest itself', () => {
    const checksumA = 'a'.repeat(64)
    const checksumB = 'b'.repeat(64)
    expect(
      formatChecksumManifest([
        { name: 'z.zip', checksum: checksumB },
        { name: 'SHA256SUMS', checksum: checksumA },
        { name: 'a.tar.gz', checksum: checksumA },
      ]),
    ).toBe(`${checksumA}  a.tar.gz\n${checksumB}  z.zip\n`)
  })

  test('detects content changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-checksum-'))
    try {
      const path = join(directory, 'artifact.tar.gz')
      await writeFile(path, 'original')
      const original = await sha256File(path)
      await writeFile(path, 'changed')
      expect(await sha256File(path)).not.toBe(original)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('aggregates exactly the six expected archives and rejects tampering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-manifest-'))
    try {
      const targets = Object.keys(RELEASE_TARGETS) as ReleaseTarget[]
      for (const target of targets) {
        const name = getArchiveName(target, '1.2.3')
        const path = join(directory, name)
        await writeFile(path, name)
        await writeFile(
          `${path}.sha256`,
          formatChecksumManifest([{ name, checksum: await sha256File(path) }]),
        )
      }
      await writeFile(join(directory, 'unexpected.txt'), 'ignored')

      const manifestPath = await aggregateChecksums(directory, '1.2.3')
      const manifest = await readFile(manifestPath, 'utf8')
      expect(manifest.trim().split('\n')).toHaveLength(6)
      expect(manifest).not.toContain('SHA256SUMS  ')

      const firstName = getArchiveName('bun-darwin-arm64', '1.2.3')
      await writeFile(join(directory, firstName), 'tampered')
      await expect(aggregateChecksums(directory, '1.2.3')).rejects.toThrow(
        `Checksum mismatch for ${firstName}`,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
