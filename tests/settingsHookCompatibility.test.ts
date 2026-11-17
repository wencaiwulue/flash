import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeParseJSON } from '../src/utils/json.ts'
import { parseSettingsFile } from '../src/utils/settings/settings.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'

let dir = ''
let counter = 0

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'flash-hook-settings-'))
  resetSettingsCache()
  safeParseJSON.cache.clear()
})

afterEach(async () => {
  resetSettingsCache()
  safeParseJSON.cache.clear()
  await rm(dir, { recursive: true, force: true })
})

async function read(
  value: unknown,
  options?: { allowHookEntryRecovery?: boolean },
) {
  const path = join(dir, `settings-${counter++}.json`)
  await writeFile(path, JSON.stringify(value))
  return parseSettingsFile(path, options)
}

const validHook = [
  { matcher: 'Bash', hooks: [{ type: 'command', command: 'printf ok' }] },
]

describe('ordinary settings hook recovery', () => {
  test.each([
    { name: 'unknown event', hooks: { FutureUpstreamEvent: [], PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'event object', hooks: { SessionStart: {}, PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'event number', hooks: { PostToolUse: 42, PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'event string', hooks: { Stop: 'invalid', PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'event null', hooks: { Notification: null, PreToolUse: validHook }, expectedPreToolUse: validHook },
    { name: 'hooks string', hooks: 'invalid', expectedPreToolUse: undefined },
    { name: 'hooks null', hooks: null, expectedPreToolUse: undefined },
    { name: 'hooks array', hooks: [], expectedPreToolUse: undefined },
  ])('$name preserves valid siblings and warns', async ({ hooks, expectedPreToolUse }) => {
    const result = await read({ hooks, model: 'sonnet' })
    expect(result.settings?.model).toBe('sonnet')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatchObject({ severity: 'warning' })
    expect(result.errors[0]?.path).toMatch(/^hooks/)
    expect(result.settings?.hooks?.PreToolUse ?? undefined).toEqual(expectedPreToolUse)
  })

  test('keeps an emptied hooks object and does not expose command text in warnings', async () => {
    const result = await read({
      hooks: { FutureUpstreamEvent: [{ command: 'do-not-log-this' }] },
      model: 'sonnet',
    })
    expect(result.settings).toEqual({ hooks: {}, model: 'sonnet' })
    expect(JSON.stringify(result.errors)).not.toContain('do-not-log-this')
  })

  test('known event array contents still use ordinary schema errors', async () => {
    const result = await read({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 42 }] } })
    expect(result.settings).toBeNull()
    expect(result.errors.some(error => error.severity === 'error')).toBe(true)
  })

  test('ordinary field errors still reject the whole source', async () => {
    const result = await read({ model: 42, hooks: { FutureUpstreamEvent: [] } })
    expect(result.settings).toBeNull()
    expect(result.errors.some(error => error.path === 'model' && error.severity === 'error')).toBe(true)
  })

  test('managed opt-out preserves current whole-source rejection', async () => {
    const result = await read(
      { model: 'sonnet', hooks: { FutureUpstreamEvent: [] } },
      { allowHookEntryRecovery: false },
    )
    expect(result.settings).toBeNull()
    expect(result.errors.some(error => error.severity === 'error')).toBe(true)
  })

  test('cache returns the same warning and cloned settings until reset', async () => {
    const path = join(dir, 'cached.json')
    await writeFile(path, JSON.stringify({ hooks: { FutureUpstreamEvent: [] }, model: 'sonnet' }))
    const first = parseSettingsFile(path)
    expect(first.errors).toHaveLength(1)
    const second = parseSettingsFile(path)
    expect(second).toEqual(first)
    expect(second.settings).not.toBe(first.settings)

    first.settings!.model = 'mutated-by-caller'
    expect(parseSettingsFile(path).settings?.model).toBe('sonnet')
    resetSettingsCache()
    expect(parseSettingsFile(path)).toEqual(second)
  })

  test('cache rejects after a recovered read of the same path', async () => {
    const path = join(dir, 'recovered-first.json')
    await writeFile(path, JSON.stringify({ hooks: { FutureUpstreamEvent: [] }, model: 'sonnet' }))

    const recovered = parseSettingsFile(path)
    expect(recovered.errors).toHaveLength(1)
    const rejected = parseSettingsFile(path, { allowHookEntryRecovery: false })
    expect(recovered.settings?.model).toBe('sonnet')
    expect(rejected.settings).toBeNull()
    expect(rejected.errors.some(error => error.severity === 'error')).toBe(true)
    expect(parseSettingsFile(path)).toEqual(recovered)
  })

  test('cache recovers after a rejected read of the same path', async () => {
    const path = join(dir, 'rejected-first.json')
    await writeFile(path, JSON.stringify({ hooks: { FutureReverseEvent: [] }, model: 'sonnet' }))

    const rejected = parseSettingsFile(path, { allowHookEntryRecovery: false })
    expect(rejected.settings).toBeNull()
    expect(rejected.errors.some(error => error.severity === 'error')).toBe(true)
    const recovered = parseSettingsFile(path)
    expect(recovered.settings?.model).toBe('sonnet')
    expect(recovered.errors).toHaveLength(1)
    expect(parseSettingsFile(path, { allowHookEntryRecovery: false })).toEqual(rejected)
  })
})
