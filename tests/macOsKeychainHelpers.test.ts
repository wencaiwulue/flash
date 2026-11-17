import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearKeychainCache,
  getKeychainCacheVersionPath,
  isKeychainCacheVersionCurrent,
  keychainCacheState,
  touchKeychainCacheVersion,
} from '../src/utils/secureStorage/macOsKeychainHelpers.ts'

describe('macOS Keychain helpers', () => {
  let tempDir: string
  let originalClaudeConfigDir: string | undefined

  beforeEach(async () => {
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'flash-test-')))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    clearKeychainCache()
  })

  afterEach(async () => {
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  test('cache-version marker is created and updated with unique UUIDs', () => {
    // First touch creates the file
    touchKeychainCacheVersion()
    const versionPath = getKeychainCacheVersionPath()
    const fs = require('fs')
    const firstContent = fs.readFileSync(versionPath, 'utf8')
    const firstVersion = JSON.parse(firstContent).version
    expect(typeof firstVersion).toBe('string')
    expect(firstVersion.length).toBeGreaterThan(0)

    // Second touch creates a new unique version
    touchKeychainCacheVersion()
    const secondContent = fs.readFileSync(versionPath, 'utf8')
    const secondVersion = JSON.parse(secondContent).version
    expect(secondVersion).not.toBe(firstVersion)
  })

  test('isKeychainCacheVersionCurrent correctly detects changes', () => {
    touchKeychainCacheVersion()
    const versionPath = getKeychainCacheVersionPath()
    const fs = require('fs')
    const content = fs.readFileSync(versionPath, 'utf8')
    const { version } = JSON.parse(content)

    // Same version is current
    expect(isKeychainCacheVersionCurrent(version)).toBe(true)

    // Different version is not current
    expect(isKeychainCacheVersionCurrent('different-version')).toBe(false)

    // Touch creates a new version, old one is no longer current
    touchKeychainCacheVersion()
    expect(isKeychainCacheVersionCurrent(version)).toBe(false)
  })

  test('marker file missing returns false for isKeychainCacheVersionCurrent', () => {
    expect(isKeychainCacheVersionCurrent('any-version')).toBe(false)
  })

  test('marker file with invalid JSON returns false for isKeychainCacheVersionCurrent', async () => {
    const versionPath = getKeychainCacheVersionPath()
    await writeFile(versionPath, 'invalid json', { mode: 0o600 })
    expect(isKeychainCacheVersionCurrent('any-version')).toBe(false)
  })

  test('clearKeychainCache touches version marker and updates cache', () => {
    // Create initial marker
    touchKeychainCacheVersion()
    const versionPath = getKeychainCacheVersionPath()
    const fs = require('fs')
    const firstContent = fs.readFileSync(versionPath, 'utf8')
    const firstVersion = JSON.parse(firstContent).version

    // Clear cache
    clearKeychainCache()

    // Verify marker was updated
    const secondContent = fs.readFileSync(versionPath, 'utf8')
    const secondVersion = JSON.parse(secondContent).version
    expect(secondVersion).not.toBe(firstVersion)

    // Verify cache state has the new version
    expect(keychainCacheState.cache.cacheVersion).toBe(secondVersion)
  })
})
