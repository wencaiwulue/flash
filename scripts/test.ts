import { resolve } from 'path'
import { EXTERNAL_FEATURES } from './externalFeatureProfile.ts'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const testFilePattern = /^tests\/.*\.test\.tsx?$/
const requestedFiles = args.filter(arg => testFilePattern.test(arg))
const options = args.filter(arg => !testFilePattern.test(arg))

async function discoverTestFiles(): Promise<string[]> {
  const files = new Set<string>()
  for (const extension of ['ts', 'tsx']) {
    const glob = new Bun.Glob(`tests/**/*.test.${extension}`)
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

const testFiles = requestedFiles.length > 0
  ? requestedFiles
  : await discoverTestFiles()
if (testFiles.length === 0) {
  throw new Error('No test files found')
}

const featureArgs = EXTERNAL_FEATURES.flatMap(feature => [
  `--feature=${feature}`,
])
const failures: string[] = []
for (const file of testFiles) {
  const child = Bun.spawn({
    cmd: [process.execPath, ...featureArgs, 'test', ...options, file],
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
