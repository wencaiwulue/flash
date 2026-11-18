import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setOriginalCwd,
} from '../src/bootstrap/state.ts'
import { computeEditsFromContents } from '../src/hooks/useDiffInIDE.ts'
import {
  cleanupStaleIdeLockfiles,
  detectIDEs,
  getSortedIdeLockfiles,
} from '../src/utils/ide.ts'
import {
  checkWSLDistroMatch,
  WindowsToWSLConverter,
} from '../src/utils/idePathConversion.ts'

let tempDir: string
let originalConfigDir: string | undefined
let originalCwd: string
let originalSkipValid: string | undefined
let originalSsePort: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalCwd = process.cwd()
  originalSkipValid = process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK
  originalSsePort = process.env.CLAUDE_CODE_SSE_PORT
  tempDir = await mkdtemp(join(tmpdir(), 'flash-ide-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
  delete process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK
  delete process.env.CLAUDE_CODE_SSE_PORT
  resetStateForTests()
  setOriginalCwd(tempDir)
  await mkdir(join(tempDir, 'config', 'ide'), { recursive: true })
})

afterEach(async () => {
  resetStateForTests()
  process.chdir(originalCwd)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalSkipValid === undefined) delete process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK
  else process.env.CLAUDE_CODE_IDE_SKIP_VALID_CHECK = originalSkipValid
  if (originalSsePort === undefined) delete process.env.CLAUDE_CODE_SSE_PORT
  else process.env.CLAUDE_CODE_SSE_PORT = originalSsePort
  await rm(tempDir, { recursive: true, force: true })
})

function lockfileDir(): string {
  return join(tempDir, 'config', 'ide')
}

async function writeJsonLockfile(
  port: number,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const path = join(lockfileDir(), `${port}.lock`)
  await writeFile(
    path,
    JSON.stringify({
      workspaceFolders: [tempDir],
      pid: process.pid,
      ideName: 'VSCode',
      transport: 'ws',
      ...overrides,
    }),
    { mode: 0o600 },
  )
  return path
}

describe('IDE lockfile discovery and cleanup', () => {
  test('sorts by mtime, detects valid workspaces and removes only stale records', async () => {
    const current = await writeJsonLockfile(41001)
    const other = await writeJsonLockfile(41002, {
      workspaceFolders: ['/not/the/current/workspace'],
    })
    await utimes(current, new Date('2025-01-01'), new Date('2025-01-01'))
    await utimes(other, new Date('2026-01-01'), new Date('2026-01-01'))
    expect(await getSortedIdeLockfiles()).toEqual([other, current])

    expect(await detectIDEs(false)).toEqual([
      expect.objectContaining({
        name: 'VSCode',
        workspaceFolders: [tempDir],
        port: 41001,
        isValid: true,
        url: `ws://127.0.0.1:41001`,
      }),
    ])
    expect(await detectIDEs(true)).toHaveLength(2)

    const stale = await writeJsonLockfile(41003, { pid: 999999 })
    const corrupt = join(lockfileDir(), '41004.lock')
    await writeFile(corrupt, '{not valid json')
    await cleanupStaleIdeLockfiles()

    expect(await Bun.file(stale).exists()).toBe(false)
    expect(await Bun.file(corrupt).exists()).toBe(false)
    expect(await Bun.file(current).exists()).toBe(true)
    expect(await Bun.file(other).exists()).toBe(true)
  })
})

describe('WSL path conversion boundaries', () => {
  test('uses manual fallback and preserves mismatched distro paths', () => {
    const converter = new WindowsToWSLConverter('Ubuntu')
    expect(converter.toLocalPath('C:\\Users\\offline\\project')).toBe(
      '/mnt/c/Users/offline/project',
    )
    const otherDistro = '\\\\wsl$\\Debian\\home\\offline\\project'
    expect(converter.toLocalPath(otherDistro)).toBe(otherDistro)
    expect(checkWSLDistroMatch(otherDistro, 'Ubuntu')).toBe(false)
    expect(checkWSLDistroMatch(otherDistro, 'Debian')).toBe(true)
    expect(checkWSLDistroMatch('C:\\Users\\offline', 'Ubuntu')).toBe(true)
  })
})

describe('IDE diff recomputation', () => {
  test('returns no edits for identical content and recomputes exact replacements', () => {
    expect(computeEditsFromContents('/tmp/a.txt', 'same\n', 'same\n', 'single')).toEqual(
      [],
    )
    expect(
      computeEditsFromContents('/tmp/a.txt', 'before\n', 'after\n', 'single'),
    ).toEqual([
      {
        old_string: 'before',
        new_string: 'after',
        replace_all: false,
      },
    ])
  })

  test('supports multiple independent hunks', () => {
    const edits = computeEditsFromContents(
      '/tmp/a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nine\nten\n',
      'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nine\nTEN\n',
      'multiple',
    )
    expect(edits).toHaveLength(2)
    expect(edits[0]?.new_string).toContain('ONE')
    expect(edits[1]?.new_string).toContain('seven\neight\nine\nTEN')
  })
})
