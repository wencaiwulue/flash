import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BunPlugin } from 'bun'

// playwright-core reads its own package.json / browsers.json at runtime via
// dynamic require(join(packageRoot, ...)). Bun's compiler bakes __dirname to
// the build machine's absolute path, so a compiled binary would always crash
// with `ResolveMessage: Cannot find module '<build-host>/.../package.json'`.
// This plugin inlines those two reads as build-time literals. It must be
// attached to every Bun.build call (dist and compile) — see build.ts.
const TARGET_FILES = /playwright-core[\\/]lib[\\/](coreBundle|package|serverRegistry)\.js$/
const IDENT = '[A-Za-z_$][\\w$]*(?:\\.default)?'
const PKG_RE = new RegExp(`require\\((${IDENT})\\.join\\(packageRoot, "package\\.json"\\)\\)`, 'g')
const BRW_RE = new RegExp(`require\\((${IDENT})\\.join\\(packageRoot, "browsers\\.json"\\)\\)`, 'g')

export type InlineResult = { contents: string; inlined: string[] }

export async function inlinePlaywrightDataReads(
  source: string,
  packageJsonText: string,
  browsersJsonText: string,
): Promise<InlineResult> {
  const inlined: string[] = []
  let contents = source.replace(PKG_RE, () => {
    inlined.push('package.json')
    return JSON.stringify(JSON.parse(packageJsonText))
  })
  contents = contents.replace(BRW_RE, () => {
    inlined.push('browsers.json')
    return browsersJsonText.trim()
  })
  return { contents, inlined }
}

export function createPlaywrightInlinePlugin(): BunPlugin {
  return {
    name: 'inline-playwright-data-reads',
    setup(build) {
      build.onLoad({ filter: TARGET_FILES }, async args => {
        const source = await readFile(args.path, 'utf8')
        const coreRoot = resolve(args.path, '..', '..')
        const packageJsonText = await readFile(resolve(coreRoot, 'package.json'), 'utf8')
        const browsersJsonPath = resolve(coreRoot, 'browsers.json')
        let browsersJsonText: string
        try {
          browsersJsonText = await readFile(browsersJsonPath, 'utf8')
        } catch {
          // Per spec §4.1: warn and inline an empty registry rather than
          // failing the build — the launch path does not read browsers.json.
          console.warn(
            `[playwrightInlinePlugin] ${browsersJsonPath} not found; inlining empty registry`,
          )
          browsersJsonText = '{}'
        }
        const { contents, inlined } = await inlinePlaywrightDataReads(
          source,
          packageJsonText,
          browsersJsonText,
        )
        if (inlined.length > 0) {
          console.log(`[playwrightInlinePlugin] ${args.path}: inlined ${inlined.join(', ')}`)
        }
        return { contents, loader: 'js' }
      })
    },
  }
}
