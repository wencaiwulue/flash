import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  addMarketplaceSource,
  clearMarketplacesCache,
} from '../src/utils/plugins/marketplaceManager'
import {
  clearPluginCache,
  copyPluginToVersionedCache,
  createPluginFromPath,
  getVersionedCachePath,
  loadAllPluginsCacheOnly,
} from '../src/utils/plugins/pluginLoader'
import { getPluginsDirectory } from '../src/utils/plugins/pluginDirectories'
import {
  addInstalledPlugin,
  loadInstalledPluginsV2,
  clearInstalledPluginsCache,
  resetInMemoryState,
} from '../src/utils/plugins/installedPluginsManager'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR

let tempRoot: string
let testIndex = 0

async function createTestPluginDir(
  baseDir: string,
  pluginName: string,
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const pluginDir = join(baseDir, pluginName)
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
  await mkdir(join(pluginDir, 'commands'), { recursive: true })
  await mkdir(join(pluginDir, 'agents'), { recursive: true })

  // Write plugin.json
  await writeFile(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: pluginName,
      version: '1.0.0',
      description: `Test plugin: ${pluginName}`,
      ...manifest,
    }),
  )

  // Write a test command
  await writeFile(
    join(pluginDir, 'commands', 'greet.md'),
    `---
name: greet
description: Greets the user
---

Hello there! This is from plugin: ${pluginName}
`,
  )

  // Write a test agent
  await writeFile(
    join(pluginDir, 'agents', 'helper.md'),
    `---
name: helper
description: A helpful assistant
---

You are a helpful assistant from plugin: ${pluginName}
`,
  )

  return pluginDir
}

async function createTestMarketplaceDir(
  baseDir: string,
  marketplaceName: string,
  plugins: Array<{ name: string; source: string | object }>,
): Promise<string> {
  const marketplaceDir = join(baseDir, marketplaceName)
  await mkdir(join(marketplaceDir, '.claude-plugin'), { recursive: true })

  // Write marketplace.json
  await writeFile(
    join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: marketplaceName,
      owner: { name: 'test' },
      plugins: plugins.map(p => ({
        name: p.name,
        source: p.source,
        strict: false,
      })),
    }),
  )

  return marketplaceDir
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join('/tmp', 'flash-plugins-test-'))
})

beforeEach(async () => {
  const testRoot = join(tempRoot, `test-${testIndex++}`)
  process.env.CLAUDE_CONFIG_DIR = join(testRoot, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(testRoot, 'plugins')
  clearMarketplacesCache()
  clearInstalledPluginsCache()
  resetInMemoryState()
  clearPluginCache()
  // Settings are empty by default in fresh temp directories
})

afterAll(async () => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalPluginCacheDir === undefined) {
    delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  } else {
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = originalPluginCacheDir
  }
  await rm(tempRoot, { recursive: true, force: true })
})

describe('plugins integration', () => {
  test('createPluginFromPath loads a valid plugin from local directory', async () => {
    const testRoot = join(tempRoot, `test-${testIndex++}`)
    await mkdir(testRoot, { recursive: true })

    // Create simple plugin with just name (no commands/agents in manifest)
    // Auto-detection will find the directories
    const pluginDir = await createTestPluginDir(testRoot, 'test-plugin')

    const { plugin, errors } = await createPluginFromPath(
      pluginDir,
      'local:test-plugin',
      true,
      'test-plugin',
    )

    expect(errors).toHaveLength(0)
    expect(plugin.name).toBe('test-plugin')
    expect(plugin.enabled).toBe(true)
    expect(plugin.commandsPath).toBe(join(pluginDir, 'commands'))
  })

  test('createPluginFromPath rejects invalid manifest with missing name', async () => {
    const testRoot = join(tempRoot, `test-${testIndex++}`)
    await mkdir(testRoot, { recursive: true })

    // Create plugin with invalid manifest (no name)
    const pluginDir = join(testRoot, 'bad-plugin')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        // Missing name!
        version: '1.0.0',
        description: 'Test',
      }),
    )

    // createPluginFromPath uses loadPluginManifest which validates schema
    // Name is required
    await expect(
      createPluginFromPath(
        pluginDir,
        'local:bad-plugin',
        true,
        'bad-plugin',
      ),
    ).rejects.toThrow('invalid manifest file')
  })

  test('copyPluginToVersionedCache copies plugin to versioned directory', async () => {
    const testRoot = join(tempRoot, `test-${testIndex++}`)
    await mkdir(testRoot, { recursive: true })

    const pluginDir = await createTestPluginDir(testRoot, 'versioned-test', {
      version: '2.5.0',
    })

    const cachedPath = await copyPluginToVersionedCache(
      pluginDir,
      'versioned-test@test-marketplace',
      '2.5.0',
    )

    // Verify the plugin was copied to the right location
    expect(cachedPath).toBe(
      getVersionedCachePath('versioned-test@test-marketplace', '2.5.0'),
    )

    // Verify the copy has the plugin manifest
    const manifestContent = await readFile(
      join(cachedPath, '.claude-plugin', 'plugin.json'),
      'utf8',
    )
    const manifest = JSON.parse(manifestContent)
    expect(manifest.name).toBe('versioned-test')
    expect(manifest.version).toBe('2.5.0')
  })

  test('copyPluginToVersionedCache with seed cache (no-op since we test primary)', async () => {
    const testRoot = join(tempRoot, `test-${testIndex++}`)
    await mkdir(testRoot, { recursive: true })

    const pluginDir = await createTestPluginDir(testRoot, 'seed-test', {
      version: '1.0.0',
    })

    const cachedPath = await copyPluginToVersionedCache(
      pluginDir,
      'seed-test@test-marketplace',
      '1.0.0',
    )

    expect(cachedPath).toBeTruthy()
  })

  test('loadAllPluginsCacheOnly with no plugins returns empty result', async () => {
    const result = await loadAllPluginsCacheOnly()

    expect(result.enabled).toEqual([])
    expect(result.disabled).toEqual([])
    expect(result.errors).toEqual([])
  })

  test('loadSessionOnlyPlugin scenario works via direct createPluginFromPath', async () => {
    const testRoot = join(tempRoot, `test-${testIndex++}`)
    await mkdir(testRoot, { recursive: true })

    // Create a session-only plugin directory
    const pluginDir = await createTestPluginDir(testRoot, 'session-plugin')

    // For session-only plugins, we'd use the CLI --plugin-dir flag, but
    // for testing, let's verify the component loading directly
    const { plugin } = await createPluginFromPath(
      pluginDir,
      'session:session-plugin',
      true,
      'session-plugin',
    )

    expect(plugin.name).toBe('session-plugin')
    expect(plugin.commandsPath).toBe(join(pluginDir, 'commands'))
  })

  test('plugin manifest validation rejects invalid manifest at load time', async () => {
    const testRoot = join(tempRoot, `test-${testIndex++}`)
    await mkdir(testRoot, { recursive: true })

    // Create plugin with invalid manifest (empty)
    const pluginDir = join(testRoot, 'bad-plugin')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({}),
    )

    // Loading should fail validation
    await expect(
      createPluginFromPath(pluginDir, 'local:bad-plugin', true, 'bad-plugin'),
    ).rejects.toThrow('invalid manifest file')
  })
})

describe('plugin dependency resolution integration', () => {
  test('plugins with dependencies can be loaded, but fail validation if dependencies not present', async () => {
    // Dependency verification happens in verifyAndDemote, which we can test
    // by creating LoadedPlugin objects directly

    const { verifyAndDemote } = await import(
      '../src/utils/plugins/dependencyResolver'
    )

    // Create plugin A that depends on plugin B
    const pluginA = {
      name: 'plugin-a',
      source: 'plugin-a@test',
      manifest: {
        name: 'plugin-a',
        dependencies: ['plugin-b@test'],
      },
      enabled: true,
      path: '',
      repository: '',
    }

    // Create plugin B that's disabled
    const pluginB = {
      name: 'plugin-b',
      source: 'plugin-b@test',
      manifest: { name: 'plugin-b' },
      enabled: false,
      path: '',
      repository: '',
    }

    const result = verifyAndDemote([pluginA, pluginB])

    // Plugin A should be demoted because B is disabled
    expect(result.demoted.has('plugin-a@test')).toBe(true)
    expect(result.errors).toHaveLength(1)
  })

  test('plugins with dependencies on enabled plugins are not demoted', async () => {
    const { verifyAndDemote } = await import(
      '../src/utils/plugins/dependencyResolver'
    )

    const pluginA = {
      name: 'plugin-a',
      source: 'plugin-a@test',
      manifest: {
        name: 'plugin-a',
        dependencies: ['plugin-b@test'],
      },
      enabled: true,
      path: '',
      repository: '',
    }

    const pluginB = {
      name: 'plugin-b',
      source: 'plugin-b@test',
      manifest: { name: 'plugin-b' },
      enabled: true,
      path: '',
      repository: '',
    }

    const result = verifyAndDemote([pluginA, pluginB])

    // Neither should be demoted
    expect(result.demoted.size).toBe(0)
    expect(result.errors).toHaveLength(0)
  })
})

describe('installed plugins integration', () => {
  test('addInstalledPlugin adds plugin to installed registry', async () => {
    const cachePath = getPluginsDirectory()
    const pluginPath = join(
      cachePath,
      'cache',
      'test-marketplace',
      'test-plugin',
      '1.0.0',
    )

    addInstalledPlugin(
      'test-plugin@test-marketplace',
      {
        name: 'test-plugin',
      },
      'user',
    )

    const installed = loadInstalledPluginsV2().plugins['test-plugin@test-marketplace']
    expect(installed).toHaveLength(1)
    expect(installed[0].scope).toBe('user')
  })
})
