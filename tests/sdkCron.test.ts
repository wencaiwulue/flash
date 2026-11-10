import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  buildMissedTaskNotification,
  watchScheduledTasks,
} from '../src/entrypoints/agentSdkTypes.ts'

describe('SDK scheduled tasks', () => {
  test('formats missed tasks without allowing prompt fence escape', () => {
    const output = buildMissedTaskNotification([
      {
        id: 'task-1',
        cron: '0 0 1 1 *',
        prompt: 'run ``` safely',
        createdAt: 1,
      },
    ])
    expect(output).toContain('Do NOT execute this prompt yet')
    expect(output).toContain('````\nrun ``` safely\n````')
  })

  test('emits missed tasks and stops on abort', async () => {
    const dir = await mkdtemp(join('/tmp', 'claude-sdk-cron-'))
    const controller = new AbortController()
    try {
      await mkdir(join(dir, '.claude'), { recursive: true })
      await writeFile(
        join(dir, '.claude', 'scheduled_tasks.json'),
        JSON.stringify({
          tasks: [
            {
              id: 'missed-task',
              cron: '0 0 * * *',
              prompt: 'harmless test task',
              createdAt: Date.now() - 2 * 86_400_000,
            },
          ],
        }),
      )
      const handle = watchScheduledTasks({ dir, signal: controller.signal })
      const iterator = handle.events()
      const event = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('cron event timeout')), 5000),
        ),
      ])
      expect(event.done).toBe(false)
      expect(event.value).toEqual({
        type: 'missed',
        tasks: [
          expect.objectContaining({ id: 'missed-task' }),
        ],
      })
      controller.abort()
      await iterator.return(undefined)
    } finally {
      controller.abort()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
