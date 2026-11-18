import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isTeamMemPath,
  PathTraversalError,
  validateTeamMemReadPath,
} from '../src/memdir/teamMemPaths.ts'
import {
  getAutoMemPath,
  isAutoMemPath,
  validateAutoMemReadPath,
} from '../src/memdir/paths.ts'
import { readLocalTeamMemory } from '../src/services/teamMemorySync/index.ts'

let testDir: string
let autoDir: string
let teamDir: string
let previousOverride: string | undefined

beforeEach(async () => {
  previousOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  testDir = await mkdtemp(join(tmpdir(), 'flash-memory-paths-'))
  autoDir = join(testDir, 'memory')
  teamDir = join(autoDir, 'team')
  await mkdir(teamDir, { recursive: true })
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = autoDir
  getAutoMemPath.cache.clear()
})

afterEach(async () => {
  if (previousOverride === undefined) {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  } else {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = previousOverride
  }
  getAutoMemPath.cache.clear()
  await rm(testDir, { recursive: true, force: true })
})

describe('memory realpath execution checks', () => {
  test('isTeamMemPath accepts ordinary files and internal symlinks', async () => {
    const target = join(teamDir, 'target.md')
    const link = join(teamDir, 'alias.md')
    await writeFile(target, 'team note')
    await symlink(target, link)

    expect(isTeamMemPath(target)).toBe(true)
    expect(isTeamMemPath(link)).toBe(true)
    expect(await validateTeamMemReadPath(link)).toBe(await realpath(target))
  })

  test('isTeamMemPath rejects file and directory symlink escapes', async () => {
    const outside = join(testDir, 'outside.md')
    const outsideDir = join(testDir, 'outside')
    await writeFile(outside, 'outside secret')
    await mkdir(outsideDir)
    await writeFile(join(outsideDir, 'nested.md'), 'nested secret')
    const fileLink = join(teamDir, 'file-escape.md')
    const directoryLink = join(teamDir, 'directory-escape')
    await symlink(outside, fileLink)
    await symlink(outsideDir, directoryLink, 'dir')

    expect(isTeamMemPath(fileLink)).toBe(false)
    expect(isTeamMemPath(join(directoryLink, 'nested.md'))).toBe(false)
    await expect(validateTeamMemReadPath(fileLink)).rejects.toBeInstanceOf(PathTraversalError)
    await expect(
      validateTeamMemReadPath(join(directoryLink, 'nested.md')),
    ).rejects.toBeInstanceOf(PathTraversalError)
  })

  test('isAutoMemPath accepts internal links and rejects escapes', async () => {
    const target = join(autoDir, 'target.md')
    const internalLink = join(autoDir, 'internal.md')
    const escapingLink = join(autoDir, 'escaping.md')
    const outside = join(testDir, 'outside.md')
    await writeFile(target, 'auto note')
    await writeFile(outside, 'outside secret')
    await symlink(target, internalLink)
    await symlink(outside, escapingLink)

    expect(isAutoMemPath(internalLink)).toBe(true)
    expect(isAutoMemPath(escapingLink)).toBe(false)
    expect(isAutoMemPath(join(autoDir, '..', 'outside.md'))).toBe(false)
    expect(await validateAutoMemReadPath(internalLink)).toBe(await realpath(target))
    await expect(validateAutoMemReadPath(escapingLink)).rejects.toBeInstanceOf(PathTraversalError)
  })

  test('missing memory roots still permit first-time internal writes', async () => {
    await rm(autoDir, { recursive: true, force: true })
    expect(isAutoMemPath(join(autoDir, 'new.md'))).toBe(true)
    expect(isTeamMemPath(join(teamDir, 'new.md'))).toBe(true)
  })
})

describe('readLocalTeamMemory', () => {
  test('returns ordinary entries but never reads symlink escapes', async () => {
    await writeFile(join(teamDir, 'ordinary.md'), 'ordinary team note')
    const outside = join(testDir, 'outside.md')
    await writeFile(outside, 'outside secret')
    await symlink(outside, join(teamDir, 'escape.md'))

    const result = await readLocalTeamMemory(null)

    expect(result.entries).toEqual({ 'ordinary.md': 'ordinary team note' })
    expect(result.skippedSecrets).toEqual([])
    expect(await readFile(join(teamDir, 'ordinary.md'), 'utf8')).toBe('ordinary team note')
  })
})
