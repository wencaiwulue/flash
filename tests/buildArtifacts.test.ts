import { expect, test } from 'bun:test'
import { resolve, join } from 'path'

const root = resolve(import.meta.dir, '..')

test('packages an executable CLI, importable SDK, and matching declarations', async () => {
  const main = Bun.file(join(root, 'dist/main.js'))
  const sdkFile = Bun.file(join(root, 'dist/sdk.mjs'))
  const declarations = Bun.file(join(root, 'dist/types/entrypoints/agentSdkTypes.d.ts'))
  expect(await main.exists()).toBe(true)
  expect(await main.text()).toStartWith('#!/usr/bin/env bun')
  expect((await main.stat()).mode & 0o111).not.toBe(0)
  expect(await sdkFile.exists()).toBe(true)
  expect(await declarations.exists()).toBe(true)

  const sdk = await import(join(root, 'dist/sdk.mjs'))
  expect(typeof sdk.query).toBe('function')
  expect(typeof sdk.createSdkMcpServer).toBe('function')

  const packageJson = await Bun.file(join(root, 'package.json')).json()
  expect(packageJson.exports['.'].import).toBe('./dist/sdk.mjs')
  expect(packageJson.exports['.'].types).toBe('./dist/types/entrypoints/agentSdkTypes.d.ts')
})
