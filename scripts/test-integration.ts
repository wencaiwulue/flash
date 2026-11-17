import { resolve } from 'path'
import { EXTERNAL_FEATURES } from './externalFeatureProfile.ts'
import { ensureFreshDist } from '../tests/integration/support/dist-fixture.ts'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const testFilePattern = /^tests\/integration\/.*\.test\.tsx?$/
const supportedOptions = ['--suite=', '--live', '--no-build']

const requestedFiles = args.filter(arg => testFilePattern.test(arg))
const unknownOptions = args.filter(
  arg => arg.startsWith('--') && !supportedOptions.some(prefix => arg.startsWith(prefix)),
)
if (unknownOptions.length > 0) {
  console.error(
    `Unknown options: ${unknownOptions.join(', ')} (supported: --suite=<cli|config|sdk>, --live, --no-build)`,
  )
  process.exit(2)
}

const suite = args.find(arg => arg.startsWith('--suite='))?.split('=')[1]
const live = args.includes('--live')
const noBuild = args.includes('--no-build')

async function discoverIntegrationFiles(): Promise<string[]> {
  const files = new Set<string>()
  for (const extension of ['ts', 'tsx']) {
    const glob = new Bun.Glob(`tests/integration/**/*.test.${extension}`)
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

const testFiles = requestedFiles.length > 0
  ? requestedFiles
  : (await discoverIntegrationFiles()).filter(
      file => !suite || file.startsWith(`tests/integration/${suite}/`),
    )

if (testFiles.length === 0) {
  throw new Error(
    suite
      ? `No integration test files found for suite "${suite}" (expected tests/integration/${suite}/*.test.ts)`
      : 'No integration test files found',
  )
}

if (live) {
  console.log('--live: no live-layer test files registered yet; hermetic files run normally')
}

if (!noBuild) {
  await ensureFreshDist()
}

const featureArgs = EXTERNAL_FEATURES.flatMap(feature => [`--feature=${feature}`])
const failures: string[] = []
for (const file of testFiles) {
  const child = Bun.spawn({
    cmd: [process.execPath, ...featureArgs, 'test', file],
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  const exitCode = await child.exited
  if (exitCode !== 0) failures.push(file)
}

if (failures.length > 0) {
  console.error(`\nFailed test files (${failures.length}):\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`\nIntegration tests passed (${testFiles.length} files)`)
