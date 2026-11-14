import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aggregateChecksums,
  assertNativeTarget,
  formatChecksumManifest,
  getArchiveName,
  getBinaryName,
  getHostTarget,
  getReleaseTarget,
  RELEASE_DOCUMENTS,
  RELEASE_TARGETS,
  sha256File,
  validateReleaseTag,
  type ReleaseTarget,
} from '../scripts/build-binary.ts'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const englishSelector = '**English** | [简体中文](README.zh-CN.md)'
const chineseSelector = '[English](README.md) | **简体中文**'
const sectionHeadings = [
  ['Overview', '概述'],
  ['Quick Start', '快速开始'],
  ['Standalone Binaries', '独立二进制'],
  ['Agent SDK', 'Agent SDK'],
  ['Development', '开发'],
  ['Repository Layout', '仓库结构'],
  ['Documentation', '文档'],
] as const

async function readReleaseDocument(
  document: (typeof RELEASE_DOCUMENTS)[number],
): Promise<string> {
  return readFile(join(repositoryRoot, document), 'utf8')
}

function linesOutsideCodeFences(markdown: string): string[] {
  const lines: string[] = []
  let inCodeFence = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence
    } else if (!inCodeFence) {
      lines.push(line)
    }
  }
  return lines
}

function headingLevels(markdown: string): number[] {
  return linesOutsideCodeFences(markdown)
    .map(line => /^(#{1,6})\s/.exec(line)?.[1].length)
    .filter((level): level is number => level !== undefined)
}

function sectionTitles(markdown: string): string[] {
  return linesOutsideCodeFences(markdown)
    .map(line => /^##\s+(.+)$/.exec(line)?.[1])
    .filter((title): title is string => title !== undefined)
}

function codeFenceLanguages(markdown: string): string[] {
  return [...markdown.matchAll(/^```([^\s`]+)\s*$/gm)].map(match => match[1])
}

function tableShapes(markdown: string): number[][] {
  const shapes: number[][] = []
  let rows: string[] = []
  const finishTable = () => {
    if (rows.length > 0) {
      shapes.push(rows.map(row => row.split('|').length - 2))
      rows = []
    }
  }

  for (const line of [...linesOutsideCodeFences(markdown), '']) {
    if (/^\|.*\|\s*$/.test(line)) {
      rows.push(line)
    } else {
      finishTable()
    }
  }
  return shapes
}

function linkDestinations(markdown: string): string[] {
  const prose = linesOutsideCodeFences(markdown).join('\n')
  return [
    ...prose.matchAll(
      /(?<!!)\[[^\]]*\]\(\s*<?([^<>\s)]+)>?(?:\s+[^)]*)?\)/g,
    ),
  ].map(match => match[1])
}

describe('release documentation', () => {
  test('exports the exact archive document list', () => {
    expect(RELEASE_DOCUMENTS).toEqual(['README.md', 'README.zh-CN.md'])
  })

  test('places bidirectional language selectors directly below the title', async () => {
    const english = await readReleaseDocument('README.md')
    const chinese = await readReleaseDocument('README.zh-CN.md')
    expect(english.split('\n').slice(0, 3)).toEqual([
      '# Claude Code',
      '',
      englishSelector,
    ])
    expect(chinese.split('\n').slice(0, 3)).toEqual([
      '# Claude Code',
      '',
      chineseSelector,
    ])
  })

  test('resolves every relative Markdown file link', async () => {
    for (const document of RELEASE_DOCUMENTS) {
      const documentPath = join(repositoryRoot, document)
      const markdown = await readReleaseDocument(document)
      const missing: string[] = []
      for (const destination of linkDestinations(markdown)) {
        if (/^https?:\/\//.test(destination) || destination.startsWith('#')) {
          continue
        }
        const fileDestination = destination.split('#')[0]
        if (!fileDestination) {
          continue
        }
        const linkedPath = resolve(
          dirname(documentPath),
          decodeURI(fileDestination),
        )
        try {
          await stat(linkedPath)
        } catch {
          missing.push(destination)
        }
      }
      expect({ document, missing }).toEqual({ document, missing: [] })
    }
  })

  test('keeps document structure and non-language links aligned', async () => {
    const english = await readReleaseDocument('README.md')
    const chinese = await readReleaseDocument('README.zh-CN.md')
    expect(headingLevels(english)).toEqual(headingLevels(chinese))
    expect(sectionTitles(english)).toEqual(
      sectionHeadings.map(([englishTitle]) => englishTitle),
    )
    expect(sectionTitles(chinese)).toEqual(
      sectionHeadings.map(([, chineseTitle]) => chineseTitle),
    )
    expect(codeFenceLanguages(english)).toEqual(codeFenceLanguages(chinese))
    expect(tableShapes(english)).toEqual(tableShapes(chinese))

    const withoutLanguageLinks = (markdown: string) =>
      linkDestinations(markdown).filter(
        destination =>
          destination !== 'README.md' && destination !== 'README.zh-CN.md',
      )
    const englishLinks = withoutLanguageLinks(english)
    const chineseLinks = withoutLanguageLinks(chinese)
    expect(englishLinks).toEqual(chineseLinks)
    for (const destination of [...englishLinks, ...chineseLinks]) {
      expect(destination).toMatch(/^https?:\/\//)
    }
  })

  test('keeps CJK text out of the English body except its selector', async () => {
    const english = await readReleaseDocument('README.md')
    const body = english
      .split('\n')
      .filter((_, index) => index !== 2)
      .join('\n')
    expect(body).not.toMatch(
      /[　-〿㐀-䶿一-鿿豈-﫿]/,
    )
  })
})

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
