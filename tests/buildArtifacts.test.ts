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

  const smoke = Bun.spawnSync({
    cmd: [
      process.execPath,
      '-e',
      "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')",
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(smoke.stderr.toString()).toBe('')
  expect(smoke.exitCode).toBe(0)

  const packageJson = await Bun.file(join(root, 'package.json')).json()
  expect(packageJson.exports['.'].import).toBe('./dist/sdk.mjs')
  expect(packageJson.exports['.'].types).toBe('./dist/types/entrypoints/agentSdkTypes.d.ts')
})
