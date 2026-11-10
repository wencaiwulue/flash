import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  createCronScheduler,
  isRecurringTaskAged,
  type CronScheduler,
} from '../src/utils/cronScheduler.ts'
import { readCronTasks, type CronTask } from '../src/utils/cronTasks.ts'
import { sleep } from '../src/utils/sleep.ts'

const schedulers = new Set<CronScheduler>()
const dirs = new Set<string>()

afterEach(async () => {
  for (const scheduler of schedulers) scheduler.stop()
  schedulers.clear()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  dirs.clear()
})

async function fixture(tasks: Partial<CronTask>[]): Promise<string> {
  const dir = await mkdtemp(join('/tmp', 'claude-cron-lifecycle-'))
  dirs.add(dir)
  await mkdirIfNeeded(dir)
  await writeFile(
    join(dir, '.claude', 'scheduled_tasks.json'),
    JSON.stringify({
      tasks: tasks.map((task, index) => ({
        id: `task-${index}`,
        cron: '* * * * *',
        prompt: `prompt-${index}`,
        createdAt: Date.now(),
        ...task,
      })),
    }),
  )
  return dir
}

async function mkdirIfNeeded(dir: string): Promise<void> {
  const { mkdir } = await import('fs/promises')
  await mkdir(join(dir, '.claude'), { recursive: true })
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for cron')
    await sleep(50)
  }
}

describe('cron scheduler lifecycle', () => {
  test('fires one-shot once, removes it, and clears next fire time', async () => {
    const dir = await fixture([{ recurring: false }])
    const fired: CronTask[] = []
    let current = Date.now()
    const scheduler = createCronScheduler({
      dir,
      now: () => current,
      isLoading: () => false,
      onFireTask: task => fired.push(task),
      onFire: () => {},
    })
    schedulers.add(scheduler)
    scheduler.start()
    await waitFor(() => scheduler.getNextFireTime() !== null)
    current += 60_000
    await waitFor(() => fired.length === 1)
    await sleep(1_200)
    expect(fired).toHaveLength(1)
    expect(scheduler.getNextFireTime()).toBeNull()
    expect((await readCronTasks(dir)).map(task => task.id)).not.toContain('task-0')
  })

  test('reschedules recurring tasks and preserves permanent/maxAgeMs=0 behavior', async () => {
    const dir = await fixture([{ recurring: true, permanent: false }])
    const fired: CronTask[] = []
    let current = Date.now()
    const scheduler = createCronScheduler({
      dir,
      now: () => current,
      isLoading: () => false,
      onFireTask: task => fired.push(task),
      onFire: () => {},
    })
    schedulers.add(scheduler)
    scheduler.start()
    await waitFor(() => scheduler.getNextFireTime() !== null)
    current += 60_000
    await waitFor(() => fired.length >= 1)
    const tasks = await readCronTasks(dir)
    expect(tasks[0]?.lastFiredAt).toBeDefined()
    expect(scheduler.getNextFireTime()).not.toBeNull()

    const task = tasks[0]!
    expect(isRecurringTaskAged(task, Date.now() + 100_000, 1)).toBe(true)
    expect(isRecurringTaskAged(task, Date.now() + 100_000, 0)).toBe(false)
    expect(isRecurringTaskAged({ ...task, permanent: true }, Date.now() + 100_000, 1)).toBe(false)
  })

  test('takes over the scheduler lock after the owner stops', async () => {
    const dir = await fixture([{ recurring: true, permanent: true }])
    const firstFired: CronTask[] = []
    const secondFired: CronTask[] = []
    let current = Date.now()
    const first = createCronScheduler({
      dir,
      now: () => current,
      lockIdentity: 'first',
      isLoading: () => false,
      onFireTask: task => firstFired.push(task),
      onFire: () => {},
    })
    const second = createCronScheduler({
      dir,
      now: () => current,
      lockProbeIntervalMs: 50,
      lockIdentity: 'second',
      isLoading: () => false,
      onFireTask: task => secondFired.push(task),
      onFire: () => {},
    })
    schedulers.add(first)
    schedulers.add(second)
    first.start()
    second.start()
    await waitFor(
      () => first.getNextFireTime() !== null || second.getNextFireTime() !== null,
    )
    current += 60_000
    await waitFor(() => firstFired.length + secondFired.length >= 1)
    const owner = firstFired.length > 0 ? first : second
    const other = firstFired.length > 0 ? second : first
    const otherFired = firstFired.length > 0 ? secondFired : firstFired
    expect(otherFired).toHaveLength(0)
    owner.stop()
    other.stop()
    other.start()
    current += 60_000
    await waitFor(() => otherFired.length >= 1, 10_000)
    other.stop()
  }, 40_000)
})
