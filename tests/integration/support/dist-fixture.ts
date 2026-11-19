import { stat } from 'node:fs/promises'
import { join, resolve } from 'path'

const repoRoot = resolve(import.meta.dir, '..', '..', '..')

export interface StalenessOptions {
  root?: string
  marker?: string
  sourceGlobs?: string[]
}

const DEFAULT_SOURCE_GLOBS = ['src/**/*.{ts,tsx}', 'scripts/*.{ts,tsx}', 'package.json']

async function newestSourceMtime(root: string, sourceGlobs: string[]): Promise<number> {
  let newest = 0
  for (const pattern of sourceGlobs) {
    const glob = new Bun.Glob(pattern)
    for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
      const info = await stat(join(root, file))
      if (info.mtimeMs > newest) newest = info.mtimeMs
    }
  }
  return newest
}

export async function isDistStale(opts: StalenessOptions = {}): Promise<boolean> {
  const root = opts.root ?? repoRoot
  const marker = opts.marker ?? 'dist/main.js'
  const sourceGlobs = opts.sourceGlobs ?? DEFAULT_SOURCE_GLOBS
  let markerMtime = 0
  try {
    markerMtime = (await stat(join(root, marker))).mtimeMs
  } catch {
    return true
  }
  return (await newestSourceMtime(root, sourceGlobs)) > markerMtime
}

export async function ensureFreshDist(opts: StalenessOptions = {}): Promise<string> {
  const root = opts.root ?? repoRoot
  if (await isDistStale(opts)) {
    console.log('[dist-fixture] dist is stale or missing, running `bun run build` ...')
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', 'build'],
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await child.exited) !== 0) throw new Error('bun run build failed')
  }
  return join(root, 'dist')
}

export async function distMainPath(): Promise<string> {
  return join(await ensureFreshDist(), 'main.js')
}

export async function distSdkPath(): Promise<string> {
  return join(await ensureFreshDist(), 'sdk.mjs')
}
