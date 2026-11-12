import { afterEach, expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
const temporary = new Set<string>()
afterEach(async () => {
  for (const path of temporary) await rm(path, { recursive: true, force: true })
  temporary.clear()
})

async function prepareGenerator(): Promise<string> {
  const dir = await mkdtemp(join('/tmp', 'sdk-type-generation-'))
  temporary.add(dir)
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await mkdir(join(dir, 'src/entrypoints/sdk'), { recursive: true })
  await copyFile(
    join(root, 'scripts/generate-sdk-types.ts'),
    join(dir, 'scripts/generate-sdk-types.ts'),
  )
  await copyFile(
    join(root, 'src/entrypoints/sdk/controlSchemas.ts'),
    join(dir, 'src/entrypoints/sdk/controlSchemas.ts'),
  )
  await copyFile(
    join(root, 'src/entrypoints/sdk/coreSchemas.ts'),
    join(dir, 'src/entrypoints/sdk/coreSchemas.ts'),
  )
  return dir
}

test('generates real SDK declarations and rejects an empty core schema', async () => {
  const dir = await prepareGenerator()
  const generated = Bun.spawnSync({
    cmd: [process.execPath, 'scripts/generate-sdk-types.ts'],
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(generated.exitCode).toBe(0)
  const core = await readFile(join(dir, 'src/entrypoints/sdk/coreTypes.generated.ts'), 'utf8')
  const control = await readFile(join(dir, 'src/entrypoints/sdk/controlTypes.ts'), 'utf8')
  expect(core).toContain('export type ModelUsage = z.infer<')
  expect(control).toContain("export * from './coreTypes.js'")

  await writeFile(join(dir, 'src/entrypoints/sdk/coreSchemas.ts'), '// no exported schemas\n')
  const rejected = Bun.spawnSync({
    cmd: [process.execPath, 'scripts/generate-sdk-types.ts'],
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(rejected.exitCode).not.toBe(0)
  expect(rejected.stderr.toString()).toContain('No exported schemas found')
})
