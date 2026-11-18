import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, BunSpawn } from 'bun';
import {
  clearKeychainCache,
  getKeychainCacheVersionPath,
  isKeychainCacheVersionCurrent,
  keychainCacheState,
  primeKeychainCacheFromPrefetch,
  touchKeychainCacheVersion,
} from '../src/utils/secureStorage/macOsKeychainHelpers';
import { getUsername, set } from 'lodash-es';

const helperScriptContent = `
import {
  clearKeychainCache,
  isKeychainCacheVersionCurrent,
  keychainCacheState,
  primeKeychainCacheFromPrefetch,
  touchKeychainCacheVersion,
  getKeychainCacheVersionPath
} from '{{PROJECT_ROOT}}/src/utils/secureStorage/macOsKeychainHelpers';
import { macOsKeychainStorage } from '{{PROJECT_ROOT}}/src/utils/secureStorage/macOsKeychainStorage';

const action = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

async function run() {
  try {
    if (action === 'writeMarker') {
      touchKeychainCacheVersion();
      const fs = await import('fs/promises');
      const content = await fs.readFile(getKeychainCacheVersionPath(), 'utf8');
      console.log('MARKER_WRITTEN:', JSON.parse(content).version);
    } else if (action === 'readMarker') {
      const fs = await import('fs/promises');
      try {
        const content = await fs.readFile(getKeychainCacheVersionPath(), 'utf8');
        console.log('MARKER_READ:', JSON.parse(content).version);
      } catch {
        console.log('MARKER_READ:');
      }
    } else if (action === 'writeCache') {
      // Simulate cache write
      const data = { claudeAiOauth: { accessToken: arg1 } };
      keychainCacheState.cache = { data, cachedAt: Date.now(), cacheVersion: null };
      console.log('CACHE_SET:', arg1);
    } else if (action === 'readCache') {
      console.log('CACHE_READ:', JSON.stringify(keychainCacheState.cache?.data?.claudeAiOauth?.accessToken || ''));
    } else if (action === 'checkVersion') {
      const isValid = isKeychainCacheVersionCurrent(arg1);
      console.log('VERSION_VALID:', isValid);
    } else if (action === 'clearCache') {
      clearKeychainCache();
      const fs = await import('fs/promises');
      try {
        const content = await fs.readFile(getKeychainCacheVersionPath(), 'utf8');
        console.log('CACHE_CLEARED_MARKER:', JSON.parse(content).version);
      } catch {
        console.log('CACHE_CLEARED_MARKER:');
      }
    }
  } catch (error) {
    console.error('ERROR:', String(error));
    process.exit(1);
  }
}

run();
`;

describe('macOS Keychain Cross-Process Behavior', () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;
  let helperScriptPath: string;

  beforeEach(async () => {
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'flash-cross-test-')));
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    clearKeychainCache();

    helperScriptPath = join(tempDir, 'helper.ts');
    // Replace placeholder with actual project root
    const projectRoot = await realpath(join(__dirname, '..'));
    const content = helperScriptContent.replaceAll('{{PROJECT_ROOT}}', projectRoot);
    await writeFile(helperScriptPath, content);
  });

  afterEach(async () => {
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test('cache-version marker is created with unique UUIDs', () => {
    touchKeychainCacheVersion();
    const versionPath = getKeychainCacheVersionPath();
    const fs = require('fs');
    const firstContent = fs.readFileSync(versionPath, 'utf8');
    const firstVersion = JSON.parse(firstContent).version;
    expect(typeof firstVersion).toBe('string');
    expect(firstVersion.length).toBeGreaterThan(0);

    touchKeychainCacheVersion();
    const secondContent = fs.readFileSync(versionPath, 'utf8');
    const secondVersion = JSON.parse(secondContent).version;
    expect(secondVersion).not.toBe(firstVersion);
  });

  test('isKeychainCacheVersionCurrent correctly detects changes', () => {
    touchKeychainCacheVersion();
    const versionPath = getKeychainCacheVersionPath();
    const fs = require('fs');
    const content = fs.readFileSync(versionPath, 'utf8');
    const { version } = JSON.parse(content);

    expect(isKeychainCacheVersionCurrent(version)).toBe(true);
    expect(isKeychainCacheVersionCurrent('different-version')).toBe(false);

    touchKeychainCacheVersion();
    expect(isKeychainCacheVersionCurrent(version)).toBe(false);
  });

  test('missing marker returns false', () => {
    expect(isKeychainCacheVersionCurrent('any-version')).toBe(false);
  });

  test('invalid JSON marker returns false', async () => {
    const versionPath = getKeychainCacheVersionPath();
    await writeFile(versionPath, 'invalid json', { mode: 0o600 });
    expect(isKeychainCacheVersionCurrent('any-version')).toBe(false);
  });

  test('clearKeychainCache touches version marker and updates cache', () => {
    touchKeychainCacheVersion();
    const versionPath = getKeychainCacheVersionPath();
    const fs = require('fs');
    const firstContent = fs.readFileSync(versionPath, 'utf8');
    const firstVersion = JSON.parse(firstContent).version;

    clearKeychainCache();

    const secondContent = fs.readFileSync(versionPath, 'utf8');
    const secondVersion = JSON.parse(secondContent).version;
    expect(secondVersion).not.toBe(firstVersion);

    expect(keychainCacheState.cache.cacheVersion).toBe(secondVersion);
  });

  test('cross-process: one process invalidates, another sees marker change', async () => {
    // Process 1: writes marker
    touchKeychainCacheVersion();
    const markerPath = getKeychainCacheVersionPath();
    const fs = require('fs');
    const version1 = JSON.parse(fs.readFileSync(markerPath, 'utf8')).version;

    // Check version1 is valid
    expect(isKeychainCacheVersionCurrent(version1)).toBe(true);

    // Simulate another process (process 2) running a separate bun process
    // to update the marker
    const result = await spawnBunHelper('writeMarker');
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('MARKER_WRITTEN:');
    const version2Match = result.stdout.match(/MARKER_WRITTEN:\s*([a-z0-9-]+)/);
    expect(version2Match).not.toBeNull();
    const version2 = version2Match?.[1];
    expect(version2).not.toBe(version1);

    // Now, from the current process, check that version1 is no longer valid
    expect(isKeychainCacheVersionCurrent(version1)).toBe(false);
    expect(isKeychainCacheVersionCurrent(version2)).toBe(true);
  }, 10000);

  test('cross-process: marker handles missing/corrupted marker gracefully', async () => {
    // Test missing first
    expect(isKeychainCacheVersionCurrent('test-version')).toBe(false);

    // Create a marker
    touchKeychainCacheVersion();
    const markerPath = getKeychainCacheVersionPath();
    const fs = require('fs');
    const content = fs.readFileSync(markerPath, 'utf8');
    const { version } = JSON.parse(content);
    expect(isKeychainCacheVersionCurrent(version)).toBe(true);

    // Corrupt it
    await writeFile(markerPath, 'not-json', { mode: 0o600 });
    expect(isKeychainCacheVersionCurrent(version)).toBe(false);

    // Delete it
    await unlink(markerPath);
    expect(isKeychainCacheVersionCurrent(version)).toBe(false);
  });

  test('prefetch with no existing marker initializes correctly', async () => {
    // Ensure no marker exists first
    try {
      await unlink(getKeychainCacheVersionPath());
    } catch {}

    // Prime cache with mock prefetch output
    const testPrefetchData = JSON.stringify({
      claudeAiOauth: {
        accessToken: "prefetched-token-1234567890",
        refreshToken: "refresh-abc-123",
        expiresAt: Date.now() + 3600000,
        scopes: ["claude:all"],
        subscriptionType: "pro",
        rateLimitTier: "tier1",
      },
      trustedDeviceToken: "device-token-xyz"
    });
    primeKeychainCacheFromPrefetch(testPrefetchData);

    // Verify cache is primed but cacheVersion is null since no marker existed
    expect(keychainCacheState.cache.data?.claudeAiOauth?.accessToken).toBe("prefetched-token-1234567890");
    expect(keychainCacheState.cache.cacheVersion).toBeNull();
    expect(keychainCacheState.cache.cachedAt).toBeGreaterThan(0);

    // Now touch a marker and verify isKeychainCacheVersionCurrent returns false for null
    touchKeychainCacheVersion();
    expect(isKeychainCacheVersionCurrent(null)).toBe(false);
  });

  test('cross-process: clearKeychainCache updates marker, another sees it', async () => {
    // First process writes marker and stores cache with version
    touchKeychainCacheVersion();
    clearKeychainCache(); // This should also touch the marker
    const markerPath = getKeychainCacheVersionPath();
    const fs = require('fs');
    const versionAfterClear = JSON.parse(fs.readFileSync(markerPath, 'utf8')).version;

    // Store cache entry
    keychainCacheState.cache = {
      data: { claudeAiOauth: { accessToken: "token123" } },
      cachedAt: Date.now(),
      cacheVersion: versionAfterClear
    };

    // Simulate another process calling clearKeychainCache
    const result = await spawnBunHelper('clearCache');
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('CACHE_CLEARED_MARKER:');
    const newVersionMatch = result.stdout.match(/CACHE_CLEARED_MARKER:\s*([a-z0-9-]+)?/);
    expect(newVersionMatch).not.toBeNull();
    const newVersion = newVersionMatch?.[1];

    // Our cached version should now be invalid
    expect(isKeychainCacheVersionCurrent(versionAfterClear)).toBe(false);

    // But the new version should be valid
    expect(isKeychainCacheVersionCurrent(newVersion)).toBe(true);
  });

  test('atomic write: multiple rapid updates result in valid marker', async () => {
    // Simulate multiple rapid updates from different processes
    const promises: Promise<string>[] = [];

    for (let i = 0; i < 5; i++) {
      promises.push(
        (async () => {
          const result = await spawnBunHelper('writeMarker');
          if (result.success && result.stdout) {
            const match = result.stdout.match(/MARKER_WRITTEN:\s*([a-z0-9-]+)/);
            return match?.[1] || "";
          }
          return "";
        })()
      );
    }

    const versions = await Promise.all(promises);

    // Ensure at least one success
    const validVersions = versions.filter((v) => v);
    expect(validVersions.length).toBeGreaterThanOrEqual(1);

    // Last write won, check the final marker is valid
    const markerPath = getKeychainCacheVersionPath();
    const finalContent = require('fs').readFileSync(markerPath, 'utf8');
    const finalVersion = JSON.parse(finalContent).version;
    expect(typeof finalVersion).toBe('string');
    expect(validVersions.includes(finalVersion)).toBe(true);
  });

  // Helper to spawn bun process
  async function spawnBunHelper(action: string, arg1?: string, arg2?: string) {
    const args: string[] = [helperScriptPath, action];
    if (arg1 !== undefined) args.push(arg1);
    if (arg2 !== undefined) args.push(arg2);

    const child = spawn({
      cmd: ['bun', ...args],
      cwd: process.cwd(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: tempDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;

    return {
      success: exitCode === 0,
      stdout,
      stderr,
      exitCode,
    };
  }
});
