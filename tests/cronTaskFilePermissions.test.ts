import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readCronTasks,
  writeCronTasks,
  type CronTask,
} from '../src/utils/cronTasks.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'flash-cron-permissions-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function task(prompt: string): CronTask {
  return { id: 'task-1', cron: '* * * * *', prompt, createdAt: 1 }
}

describe('scheduled task file permissions and atomic writes', () => {
  test('creates scheduled_tasks.json with 0600 and no temporary residue', async () => {
    await writeCronTasks([task('safe prompt')], root)

    const path = join(root, '.claude', 'scheduled_tasks.json')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(root, '.claude'))).toEqual(['scheduled_tasks.json'])
    expect(await readCronTasks(root)).toEqual([task('safe prompt')])
  })

  test('concurrent writes leave one complete valid task file', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      writeCronTasks([task(`writer-${index}`)], root),
    ))

    const tasks = await readCronTasks(root)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].prompt).toMatch(/^writer-([0-9]|[1-3][0-9])$/)
    const path = join(root, '.claude', 'scheduled_tasks.json')
    expect(JSON.parse(await readFile(path, 'utf8')).tasks).toHaveLength(1)
    expect(await readdir(join(root, '.claude'))).toEqual(['scheduled_tasks.json'])
  })

  test('serialization failure preserves the previous valid tasks and cleans temporary files', async () => {
    await writeCronTasks([task('known-good')], root)
    const invalid = task('must-not-replace-old-cache') as CronTask & { self?: unknown }
    invalid.self = invalid

    await expect(writeCronTasks([invalid], root)).rejects.toThrow()

    expect(await readCronTasks(root)).toEqual([task('known-good')])
    expect(await readdir(join(root, '.claude'))).toEqual(['scheduled_tasks.json'])
  })
})
