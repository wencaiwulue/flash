import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  NpmRunner,
  NpmRunnerResult,
} from '../src/utils/plugins/marketplaceManager.ts'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalPluginCacheDir = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR

let tempRoot: string
let testRoot: string
let testIndex = 0
let manager: typeof import('../src/utils/plugins/marketplaceManager.ts')

type FakePackage = {
  version: string
  manifest: unknown
  commandFailure?: boolean
}

const packages = new Map<string, FakePackage>()
const calls: Array<{
  args: string[]
  cwd: string
  ignoreScripts?: string
}> = []

const fakeNpmRunner: NpmRunner = async (args, { cwd, env }) => {
  const packageName = args[1]!
  const prefix = args[args.indexOf('--prefix') + 1]!
  const pkg = packages.get(packageName)
  if (!pkg) throw new Error(`Unexpected npm request for ${packageName}`)

  calls.push({ args: [...args], cwd, ignoreScripts: env.npm_config_ignore_scripts })
  const packagePath = join(prefix, 'node_modules', ...packageName.split('/'))
  await mkdir(join(packagePath, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(packagePath, 'package.json'),
    JSON.stringify({ name: packageName, version: pkg.version }),
  )
  await writeFile(
    join(packagePath, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(pkg.manifest),
  )

  if (pkg.commandFailure) {
    return { stdout: '', stderr: 'simulated registry failure', code: 1 }
  }
  return { stdout: '', stderr: '', code: 0 } satisfies NpmRunnerResult
}

function manifest(name: string, version: string) {
  return {
    name,
    owner: { name: 'Test Owner' },
    metadata: { version },
    plugins: [
      {
        name: 'example-plugin',
        source: './plugins/example-plugin',
        strict: false,
      },
    ],
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join('/tmp', 'claude-npm-marketplace-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(tempRoot, 'plugins')
  manager = await import('../src/utils/plugins/marketplaceManager.ts')
})

beforeEach(async () => {
  testRoot = join(tempRoot, `test-${testIndex++}`)
  process.env.CLAUDE_CONFIG_DIR = join(testRoot, 'config')
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = join(testRoot, 'plugins')
  packages.clear()
  calls.length = 0
  manager.setNpmRunnerForTests(fakeNpmRunner)
  manager.clearMarketplacesCache()
})

afterEach(() => {
  manager.setNpmRunnerForTests()
  manager.clearMarketplacesCache()
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

describe('npm marketplace sources', () => {
  test('downloads an ordinary package without reading stale cache or running scripts', async () => {
    const packageName = 'ordinary-marketplace-package'
    packages.set(packageName, {
      version: '1.2.3',
      manifest: manifest('ordinary-marketplace', '1.2.3'),
    })

    const stalePath = join(
      manager.getMarketplacesCacheDir(),
      'ordinary-marketplace',
    )
    await mkdir(join(stalePath, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(stalePath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest('ordinary-marketplace', '0.0.1-stale')),
    )

    const added = await manager.addMarketplaceSource({
      source: 'npm',
      package: packageName,
    })
    expect(added).toMatchObject({
      name: 'ordinary-marketplace',
      alreadyMaterialized: false,
    })

    const cached = await manager.getMarketplaceCacheOnly('ordinary-marketplace')
    expect(cached?.metadata?.version).toBe('1.2.3')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toBe('install')
    expect(calls[0]!.args[1]).toBe(packageName)
    expect(calls[0]!.args).toContain('--ignore-scripts')
    expect(calls[0]!.ignoreScripts).toBe('true')
    expect(calls[0]!.args.join(' ')).not.toContain('token')
    expect(await pathExists(calls[0]!.cwd)).toBe(false)

    const packageJson = JSON.parse(
      await readFile(join(stalePath, 'package.json'), 'utf8'),
    )
    expect(packageJson.version).toBe('1.2.3')
    expect(
      (await readdir(manager.getMarketplacesCacheDir())).filter(name =>
        name.startsWith('temp_npm_'),
      ),
    ).toEqual([])
  })

  test('unpacks a scoped package from its nested node_modules path', async () => {
    const packageName = '@acme/claude-marketplace'
    packages.set(packageName, {
      version: '2.0.0',
      manifest: manifest('scoped-marketplace', '2.0.0'),
    })

    await manager.addMarketplaceSource({ source: 'npm', package: packageName })

    expect(calls[0]!.args[1]).toBe(packageName)
    expect(
      (await manager.getMarketplaceCacheOnly('scoped-marketplace'))?.metadata
        ?.version,
    ).toBe('2.0.0')
    expect(
      await pathExists(
        join(
          manager.getMarketplacesCacheDir(),
          'scoped-marketplace',
          '.claude-plugin',
          'marketplace.json',
        ),
      ),
    ).toBe(true)
  })

  test('rejects an invalid manifest and removes all staging data', async () => {
    packages.set('invalid-marketplace-package', {
      version: '1.0.0',
      manifest: { name: 'missing-required-fields' },
    })

    await expect(
      manager.addMarketplaceSource({
        source: 'npm',
        package: 'invalid-marketplace-package',
      }),
    ).rejects.toThrow('Failed to parse marketplace file')
    expect(await readdir(manager.getMarketplacesCacheDir())).toEqual([])
  })

  test('reuses valid cache and reads offline without invoking npm', async () => {
    packages.set('cached-marketplace-package', {
      version: '1.0.0',
      manifest: manifest('cached-marketplace', '1.0.0'),
    })
    await manager.addMarketplaceSource({
      source: 'npm',
      package: 'cached-marketplace-package',
    })

    manager.clearMarketplacesCache()
    expect((await manager.getMarketplace('cached-marketplace')).metadata?.version).toBe(
      '1.0.0',
    )
    expect(calls).toHaveLength(1)

    manager.setNpmRunnerForTests(async () => {
      throw new Error('registry must not be accessed while offline')
    })
    manager.clearMarketplacesCache()
    expect((await manager.getMarketplace('cached-marketplace')).metadata?.version).toBe(
      '1.0.0',
    )
    expect(
      (await manager.getMarketplaceCacheOnly('cached-marketplace'))?.metadata
        ?.version,
    ).toBe('1.0.0')
  })

  test('forced refresh resolves the latest package and replaces old content', async () => {
    const packageName = 'refresh-marketplace-package'
    packages.set(packageName, {
      version: '1.0.0',
      manifest: manifest('refresh-marketplace', '1.0.0'),
    })
    await manager.addMarketplaceSource({ source: 'npm', package: packageName })

    packages.set(packageName, {
      version: '2.0.0',
      manifest: manifest('refresh-marketplace', '2.0.0'),
    })
    await manager.refreshMarketplace('refresh-marketplace')

    expect(calls).toHaveLength(2)
    expect(
      (await manager.getMarketplaceCacheOnly('refresh-marketplace'))?.metadata
        ?.version,
    ).toBe('2.0.0')
    const config = await manager.loadKnownMarketplacesConfig()
    const packageJson = JSON.parse(
      await readFile(
        join(config['refresh-marketplace']!.installLocation, 'package.json'),
        'utf8',
      ),
    )
    expect(packageJson.version).toBe('2.0.0')
    expect(
      (await readdir(manager.getMarketplacesCacheDir())).filter(name =>
        name.startsWith('temp_npm_'),
      ),
    ).toEqual([])
  })

  test('failed refresh cleans staging and preserves the previous valid cache', async () => {
    const packageName = 'failed-refresh-package'
    packages.set(packageName, {
      version: '1.0.0',
      manifest: manifest('stable-marketplace', '1.0.0'),
    })
    await manager.addMarketplaceSource({ source: 'npm', package: packageName })

    packages.set(packageName, {
      version: '2.0.0',
      manifest: { name: 'stable-marketplace' },
    })
    await expect(
      manager.refreshMarketplace('stable-marketplace'),
    ).rejects.toThrow('Failed to refresh marketplace')
    expect(calls).toHaveLength(2)
    expect(await readdir(manager.getMarketplacesCacheDir())).toEqual([
      'stable-marketplace',
    ])

    manager.clearMarketplacesCache()
    expect((await manager.getMarketplace('stable-marketplace')).metadata?.version).toBe(
      '1.0.0',
    )
  })

  test('cleans a partial package when npm itself fails', async () => {
    packages.set('failed-download-package', {
      version: '1.0.0',
      manifest: manifest('failed-download-marketplace', '1.0.0'),
      commandFailure: true,
    })

    await expect(
      manager.addMarketplaceSource({
        source: 'npm',
        package: 'failed-download-package',
      }),
    ).rejects.toThrow('simulated registry failure')
    expect(await readdir(manager.getMarketplacesCacheDir())).toEqual([])
  })
})
