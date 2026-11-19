import { describe, test, expect, afterAll } from 'bun:test'
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { isDistStale } from './dist-fixture.ts'

const base = join(tmpdir(), 'flash-it-dist-')
const dirs: string[] = []

async function makeDir(): Promise<string> {
  const dir = await mkdtempLike()
  dirs.push(dir)
  return dir
}
async function mkdtempLike(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(base)
}

describe('isDistStale', () => {
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('missing marker counts as stale', async () => {
    const root = await makeDir()
    expect(await isDistStale({ root, marker: 'dist/main.js' })).toBe(true)
  })

  test('marker newer than source counts as fresh', async () => {
    const root = await makeDir()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1')
    await writeFile(join(root, 'dist', 'main.js'), '// built')
    // 让 marker 更新：把 source mtime 拨回过去
    await utimes(join(root, 'src', 'a.ts'), 1000, 1000)
    expect(await isDistStale({ root, marker: 'dist/main.js' })).toBe(false)
  })

  test('source newer than marker counts as stale', async () => {
    const root = await makeDir()
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1')
    await writeFile(join(root, 'dist', 'main.js'), '// built')
    await utimes(join(root, 'dist', 'main.js'), 1000, 1000)
    expect(await isDistStale({ root, marker: 'dist/main.js' })).toBe(true)
  })

  test('non-source files do not trigger staleness', async () => {
    const root = await makeDir()
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'main.js'), '// built')
    await writeFile(join(root, 'notes.txt'), 'not a source file')
    await utimes(join(root, 'dist', 'main.js'), 1000, 1000)
    expect(await isDistStale({ root, marker: 'dist/main.js' })).toBe(false)
  })
})
