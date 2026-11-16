import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inlinePlaywrightDataReads } from '../scripts/playwrightInlinePlugin.ts'

const coreBundlePath = resolve(import.meta.dir, '../node_modules/playwright-core/lib/coreBundle.js')
const PKG_PATTERN = /require\([A-Za-z_$][\w$]*(?:\.default)?\.join\(packageRoot, "package\.json"\)\)/
const BRW_PATTERN = /require\([A-Za-z_$][\w$]*(?:\.default)?\.join\(packageRoot, "browsers\.json"\)\)/

describe('playwrightInlinePlugin', () => {
  test('tripwire: current playwright-core still contains the two require patterns', async () => {
    const source = await readFile(coreBundlePath, 'utf8')
    expect(source).toMatch(PKG_PATTERN)
    expect(source).toMatch(BRW_PATTERN)
  })

  test('inlines both data reads; result evaluates to the inlined objects', async () => {
    const pkg = JSON.stringify({ name: 'playwright-core', version: 'test' })
    const browsers = JSON.stringify({ browsers: [{ name: 'chromium' }] })
    const synthetic =
      'const a = require(path.join(packageRoot, "package.json"));\n' +
      'const b = require(path8.default.join(packageRoot, "browsers.json"));'
    const { contents, inlined } = await inlinePlaywrightDataReads(synthetic, pkg, browsers)
    expect(inlined).toEqual(['package.json', 'browsers.json'])
    const [a, b] = new Function(`${contents}\nreturn [a, b]`)() as [
      { name: string },
      { browsers: { name: string }[] },
    ]
    expect(a.name).toBe('playwright-core')
    expect(b.browsers[0]?.name).toBe('chromium')
  })

  test('passthrough: text without the patterns is returned unchanged', async () => {
    const source = 'export const x = require("other")'
    const { contents, inlined } = await inlinePlaywrightDataReads(source, '{}', '{}')
    expect(contents).toBe(source)
    expect(inlined).toEqual([])
  })
})
