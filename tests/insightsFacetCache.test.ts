import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadCachedFacets,
  saveFacets,
} from '../src/commands/insights.ts'
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.ts'

let testRoot: string
let previousConfig: string | undefined

type Facets = Parameters<typeof saveFacets>[0]

function facets(sessionId: string, summary = 'summary'): Facets {
  return {
    session_id: sessionId,
    underlying_goal: 'test atomic cache writes',
    goal_categories: { testing: 1 },
    outcome: 'fully_achieved',
    user_satisfaction_counts: { satisfied: 1 },
    claude_helpfulness: 'very_helpful',
    session_type: 'single_task',
    friction_counts: {},
    friction_detail: '',
    primary_success: 'fast_accurate_search',
    brief_summary: summary,
  }
}

beforeEach(async () => {
  previousConfig = process.env.CLAUDE_CONFIG_DIR
  testRoot = await mkdtemp(join(tmpdir(), 'flash-facet-cache-'))
  process.env.CLAUDE_CONFIG_DIR = testRoot
  getClaudeConfigHomeDir.cache.clear()
})

afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  getClaudeConfigHomeDir.cache.clear()
  await rm(testRoot, { recursive: true, force: true })
})

describe('insights facet cache atomic writes', () => {
  test('writes and reloads a complete cache file with private permissions', async () => {
    const expected = facets('ordinary')
    await saveFacets(expected)

    expect(await loadCachedFacets('ordinary')).toEqual(expected)
    const path = join(testRoot, 'usage-data', 'facets', 'ordinary.json')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(testRoot, 'usage-data', 'facets'))).toEqual(['ordinary.json'])
  })

  test('concurrent writes leave one complete parseable cache and no temporary files', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      saveFacets(facets('shared', `writer-${index}`)),
    ))

    const path = join(testRoot, 'usage-data', 'facets', 'shared.json')
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    expect(parsed.session_id).toBe('shared')
    expect(parsed.brief_summary).toMatch(/^writer-([0-9]|[1-3][0-9])$/)
    expect(await readdir(join(testRoot, 'usage-data', 'facets'))).toEqual(['shared.json'])
  })

  test('serialization failure preserves the previous valid cache and cleans temporary files', async () => {
    await saveFacets(facets('preserved', 'known-good'))
    const invalid = facets('preserved', 'must-not-replace-old-cache') as Facets & { self?: unknown }
    invalid.self = invalid

    await expect(saveFacets(invalid)).rejects.toThrow()

    expect((await loadCachedFacets('preserved'))?.brief_summary).toBe('known-good')
    expect(await readdir(join(testRoot, 'usage-data', 'facets'))).toEqual(['preserved.json'])
  })

  test('corrupt existing cache is rejected and removed for later re-extraction', async () => {
    const directory = join(testRoot, 'usage-data', 'facets')
    const { mkdir, writeFile } = await import('fs/promises')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'corrupt.json')
    await writeFile(path, '{"partial":')

    expect(await loadCachedFacets('corrupt')).toBeNull()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
