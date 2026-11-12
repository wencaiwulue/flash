import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  isInBundledMode,
  spawnScriptArgs,
} from '../src/utils/bundledMode.js'

describe('isInBundledMode', () => {
  test('detects asset-free compiled entrypoints', () => {
    expect(isInBundledMode('/$bunfs/root/cli')).toBeTrue()
    expect(isInBundledMode('B:\\~BUN\\root\\cli')).toBeTrue()
    expect(isInBundledMode('/app/cli.js')).toBeFalse()
  })
})

describe('spawnScriptArgs', () => {
  test('returns the CLI entrypoint in source mode', () => {
    expect(spawnScriptArgs('/app/cli.js', false)).toEqual(['/app/cli.js'])
    expect(spawnScriptArgs('relative/cli.js', false)).toEqual([
      resolve('relative/cli.js'),
    ])
  })

  test('omits the CLI entrypoint in compiled mode', () => {
    expect(spawnScriptArgs('', true)).toEqual([])
  })

  test('throws a clear error when the source entrypoint is missing', () => {
    expect(() => spawnScriptArgs('', false)).toThrow(
      'Cannot locate the CLI entrypoint: process.argv[1] is missing outside bundled mode',
    )
  })
})
