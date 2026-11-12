import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import breakCache from '../src/commands/break-cache/index.ts'
import { runBreakCache } from '../src/commands/break-cache/break-cache.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

afterEach(() => spyOn(globalThis, 'fetch').mockRestore())

describe('/break-cache', () => {
  test('registers a real non-interactive command and lazy call interface', async () => {
    expect(breakCache.name).toBe('break-cache')
    expect(breakCache.supportsNonInteractive).toBe(true)
    expect(breakCache.isHidden).not.toBe(true)
    const { call } = await breakCache.load()
    const result = await call('unexpected', {} as LocalJSXCommandContext)
    expect(result.type).toBe('text')
    if (result.type === 'text') expect(result.value).toBe('Usage: /break-cache')
  })

  test('awaits the sole cache aggregator, preserves transcript/tasks and reports failures', async () => {
    const clear = mock(async () => ({
      completed: ['context', 'commands and skills', 'repository detection'],
      failed: [{ name: 'WebFetch', error: 'diagnostic failure' }],
    }))
    const transcript = [{ type: 'user', content: 'unchanged' }]
    const tasks = { running: { id: 'task-1' } }
    const before = JSON.stringify({ transcript, tasks })
    const output = await runBreakCache('', clear)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(output).toContain('Completed cache groups')
    expect(output).toContain('WebFetch (diagnostic failure)')
    expect(output).toContain('Server-side prompt caches are not affected')
    expect(output).not.toContain('server-side cache cleared')
    expect(JSON.stringify({ transcript, tasks })).toBe(before)
    await runBreakCache('', clear)
    expect(clear).toHaveBeenCalledTimes(2)
  })

  test('does not delete session/stats files or perform network requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-break-cache-'))
    const fetchSpy = spyOn(globalThis, 'fetch')
    try {
      const session = join(dir, 'session.jsonl')
      const stats = join(dir, 'stats-cache.json')
      await writeFile(session, 'transcript')
      await writeFile(stats, 'stats')
      await runBreakCache('', async () => ({ completed: ['context'], failed: [] }))
      expect(await readFile(session, 'utf8')).toBe('transcript')
      expect(await readFile(stats, 'utf8')).toBe('stats')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
