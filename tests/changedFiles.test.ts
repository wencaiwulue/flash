import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { getChangedFiles } from '../src/utils/attachments.ts'
import { createFileStateCacheWithSizeLimit } from '../src/utils/fileStateCache.ts'
import { FileReadTool } from '../src/tools/FileReadTool/FileReadTool.ts'
import { sleep } from '../src/utils/sleep.ts'

let dir: string
let context: ToolUseContext

beforeEach(async () => {
  dir = await mkdtemp(join('/tmp', 'claude-changed-files-'))
  context = {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(),
    getAppState: getDefaultAppState,
  } as unknown as ToolUseContext
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function touch(path: string, offsetMs: number): Promise<void> {
  const date = new Date(Date.now() + offsetMs)
  await utimes(path, date, date)
  await sleep(2)
}

describe('changed-file offset/limit reads', () => {
  test('reuses partial ranges and only reports changes inside them', async () => {
    const path = join(dir, 'sample.txt')
    await writeFile(path, 'one\ntwo\nthree\nfour\nfive\n')
    const input = { file_path: path, offset: 1, limit: 2 }
    await FileReadTool.call(input, context)
    expect(await getChangedFiles(context)).toEqual([])

    await writeFile(path, 'one\nTWO\nthree\nfour\nfive\n')
    await touch(path, 2_000)
    const changed = await getChangedFiles(context)
    expect(changed).toHaveLength(1)
    expect(changed[0]?.type).toBe('edited_text_file')
    expect(changed[0]?.snippet).toContain('TWO')
    expect(changed[0]?.snippet).not.toContain('five')
    expect(await getChangedFiles(context)).toEqual([])

    await writeFile(path, 'one\nTWO\nthree\nfour\nOTHER\n')
    await touch(path, 4_000)
    expect(await getChangedFiles(context)).toEqual([])
  })

  test('keeps full-read compatibility and evicts deleted files', async () => {
    const path = join(dir, 'full.txt')
    await writeFile(path, 'before\n')
    await FileReadTool.call({ file_path: path }, context)
    await writeFile(path, 'after\n')
    await touch(path, 2_000)
    const changed = await getChangedFiles(context)
    expect(changed[0]?.snippet).toContain('after')
    expect(changed[0]?.snippet).not.toContain('before')
    expect(context.readFileState.has(path)).toBe(true)

    await rm(path)
    expect(await getChangedFiles(context)).toEqual([])
    expect(context.readFileState.has(path)).toBe(false)
  })
})
