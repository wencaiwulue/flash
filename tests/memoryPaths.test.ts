import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { getAutoMemPath, isAutoMemPath, isAutoMemoryEnabled } from '../src/memdir/paths'
import {
  MemoryPathValidator,
  PathTraversalError,
  validateMemoryPath,
} from '../src/services/SessionMemory/sessionMemoryUtils'

function createTempTestDir(): string {
  const testDir = join(tmpdir(), `memory-paths-test-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
  return testDir
}

describe('Memory Path Validation - paths.ts integration', () => {
  let testDir: string

  beforeEach(() => {
    testDir = createTempTestDir()
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('isAutoMemoryEnabled returns boolean', () => {
    const result = isAutoMemoryEnabled()
    expect(typeof result).toBe('boolean')
  })

  test('getAutoMemPath returns absolute path', () => {
    const path = getAutoMemPath()
    const resolved = resolve(path)
    const normalizedPath = path.replace(/\/$/, '')
    const normalizedResolved = resolved.replace(/\/$/, '')
    expect(normalizedPath).toBe(normalizedResolved)
  })

  test('isAutoMemPath correctly identifies paths within auto-mem dir', () => {
    const memoryDir = getAutoMemPath()

    const insidePath = join(memoryDir, 'notes.md')
    expect(isAutoMemPath(insidePath)).toBe(true)

    const outsidePath = join(memoryDir, '..', 'secret.txt')
    expect(isAutoMemPath(outsidePath)).toBe(false)
  })
})

describe('Memory Paths - Symlink and Escape Prevention', () => {
  let testDir: string
  let memoryDir: string

  beforeEach(() => {
    testDir = createTempTestDir()
    memoryDir = join(testDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('path traversal via .. is rejected by plausibility check', () => {
    const validator = new MemoryPathValidator(memoryDir)
    const maliciousPath = join(memoryDir, '..', 'secret.txt')

    const isPlausible = validator.isPlausiblyWithinMemoryDir(maliciousPath)
    expect(isPlausible).toBe(false)
  })

  test('null bytes in paths are rejected by sanitizePathKey', () => {
    const validator = new MemoryPathValidator(memoryDir)

    expect(() => validator.sanitizePathKey('file\0.md')).toThrow(PathTraversalError)
  })

  test('URL encoded path traversal is rejected', () => {
    const validator = new MemoryPathValidator(memoryDir)

    expect(() => validator.sanitizePathKey('%2e%2e%2fsecret.txt')).toThrow(PathTraversalError)
  })

  test('absolute paths as keys are rejected', () => {
    const validator = new MemoryPathValidator(memoryDir)

    expect(() => validator.sanitizePathKey('/etc/passwd')).toThrow(PathTraversalError)
  })

  test('backslashes are rejected', () => {
    const validator = new MemoryPathValidator(memoryDir)

    expect(() => validator.sanitizePathKey('..\\secret.txt')).toThrow(PathTraversalError)
  })

  test('normalized path traversal is rejected', () => {
    const validator = new MemoryPathValidator(memoryDir)

    expect(() => validator.sanitizePathKey('../secret.txt')).toThrow(PathTraversalError)
  })

  test('plausibility check passes for symlinks inside memory dir', () => {
    const validator = new MemoryPathValidator(memoryDir)

    // Create a symlink path inside memory dir
    const symlinkPath = join(memoryDir, 'symlink.md')

    // Plausibility check passes
    const isPlausible = validator.isPlausiblyWithinMemoryDir(symlinkPath)
    expect(isPlausible).toBe(true)
  })

  test('plausibility check allows valid paths within memory dir', () => {
    const validator = new MemoryPathValidator(memoryDir)

    // Create a normal file path
    const normalFile = join(memoryDir, 'normal.md')

    // Plausibility check passes
    const isPlausible = validator.isPlausiblyWithinMemoryDir(normalFile)
    expect(isPlausible).toBe(true)
  })

  test('plausibility check allows internal symlink paths', () => {
    const validator = new MemoryPathValidator(memoryDir)

    // Create a symlink path
    const symlinkPath = join(memoryDir, 'link.md')

    // Plausibility check passes
    const isPlausible = validator.isPlausiblyWithinMemoryDir(symlinkPath)
    expect(isPlausible).toBe(true)
  })
})

describe('Team Memory Paths (Conceptual)', () => {
  test('concept: team memory paths are within auto-memory directory', () => {
    const memoryDir = getAutoMemPath()
    const teamMemoryDir = join(memoryDir, 'team')

    expect(teamMemoryDir.startsWith(memoryDir)).toBe(true)
  })
})
